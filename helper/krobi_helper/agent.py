"""Claim helper work and supervise isolated pipeline processes.

Heartbeat independently of output; stop children and discard results on lease loss.
See docs/jobs.md#helper-process-lifetime.
"""
from __future__ import annotations

import json
import math
import os
import platform
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import IO, Any, Callable, Dict, List, Optional

if os.name == "nt":
    import msvcrt
else:
    import fcntl

from . import __version__
from .work_limits import on_battery, paused_reason, launch_options
from . import protocol as P
from .acceleration import capabilities
from .mac_facts import computer_name, last_error, stable_id, tools_dir

HEARTBEAT_S = 20.0
# The helper protocol expires a lease ten minutes after its last heartbeat.
LEASE_STALE_S = 600.0
RESULT_BACKOFF_S = (5.0, 15.0, 45.0, 120.0)
RESULT_BACKOFF_MAX_S = 300.0
RESULT_FINAL_HTTP = {400, 404, 409, 410, 422}
IDLE_POLL_S = 8.0
BACKOFF_MAX_S = 60.0
NETWORK_WAIT_S = 60.0
#: How long a new agent waits for the previous one to let go of the lock.
TAKEOVER_WAIT_S = 20.0
#: How long a job process gets to stop on SIGTERM before it is killed.
JOB_KILL_GRACE_S = 5.0
REPLACED_EXIT_CODE = 4
_STDERR_LOCK = threading.RLock()


def log_stderr(message: str) -> None:
    """One local, offset-bearing timestamp per diagnostic line; never stdout."""
    with _STDERR_LOCK:
        for line in message.splitlines() or [""]:
            print(f"{datetime.now().astimezone().isoformat(timespec='seconds')} {line}",
                  file=sys.stderr, flush=True)


def lock_path() -> Path:
    return tools_dir() / "agent.lock"


def _try_lock(handle: IO[str]) -> bool:
    try:
        if os.name == "nt":
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError:
        return False


def acquire_single_instance(path: Optional[Path] = None, *, log=None) -> Optional[IO[str]]:
    """Hold ``agent.lock`` for the life of the process, taking it from a
    previous agent if needed. Returns the open handle (keep it referenced) or
    ``None`` when the holder would not let go."""
    log = log or log_stderr
    path = path or lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+", encoding="utf-8")
    if not _try_lock(handle):
        handle.seek(0)
        holder = handle.read().strip()
        if holder.isdigit() and int(holder) != os.getpid():
            log(f"another agent (pid {holder}) holds the lock; asking it to stop")
            try:
                os.kill(int(holder), signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + TAKEOVER_WAIT_S
        while not _try_lock(handle):
            if time.monotonic() >= deadline:
                handle.close()
                return None
            time.sleep(0.25)
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
    return handle


class ParentWatch:
    """Detects parent death through process reparenting.

    Not armed when launchd/init was the original parent."""

    def __init__(self) -> None:
        self.parent = os.getppid()

    @property
    def armed(self) -> bool:
        return self.parent > 1

    def gone(self) -> bool:
        if self.armed and os.name == "nt":
            import ctypes
            from ctypes import wintypes

            kernel = ctypes.windll.kernel32
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
            kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
            handle = kernel.OpenProcess(0x00100000, False, self.parent)  # SYNCHRONIZE
            if not handle:
                return True
            try:
                return kernel.WaitForSingleObject(handle, 0) == 0
            finally:
                kernel.CloseHandle(handle)
        return self.armed and os.getppid() != self.parent


def exit_with_parent(interval: float = 2.0) -> None:
    """For a job process: exit hard if the agent that started it disappears.
    A SIGKILLed agent cannot take its job down with it, so the job does it."""
    watch = ParentWatch()
    if not watch.armed:
        return

    def loop() -> None:
        while True:
            time.sleep(interval)
            if watch.gone():
                os._exit(1)

    threading.Thread(target=loop, name="exit-with-parent", daemon=True).start()


class StopRequested(Exception):
    pass


class Heartbeat:
    """Keeps one job's lease alive and carries its phase to the server.

    ``body(phase, percent)`` builds the heartbeat payload (lyrics and stems
    name their fields differently). A beat goes out every ``HEARTBEAT_S`` on a
    timer and on every `report`; an answer of ``{"stop": true}`` sets
    `stop_requested`, after which `report` raises `StopRequested`."""

    def __init__(self, agent: "Agent", path: str, body: Callable[[Optional[str], Optional[float]], Dict[str, Any]], *, name: str) -> None:
        self._agent = agent
        self._path = path
        self._body = body
        self._name = name
        self._phase: Optional[str] = None
        self._percent: Optional[float] = None
        self._done = threading.Event()
        #: Set when the server said stop (the person cancelled); the job process watches it.
        self.stop_requested = threading.Event()
        # Wall time includes machine sleep, unlike monotonic time on macOS.
        self._lease_until = time.time() + LEASE_STALE_S

    def check(self) -> None:
        if time.time() >= self._lease_until:
            self.stop_requested.set()
        if self.stop_requested.is_set() or self._agent._stopping.is_set():
            raise StopRequested()

    def wait(self, delay: float) -> None:
        """Wait without suppressing cancellation, shutdown or local lease expiry."""
        until = time.monotonic() + delay
        while True:
            self.check()
            remaining = until - time.monotonic()
            if remaining <= 0:
                return
            self.stop_requested.wait(min(0.5, remaining, max(0, self._lease_until - time.time())))

    def _running(self) -> bool:
        return not (self._done.is_set() or self.stop_requested.is_set())

    def beat(self) -> None:
        try:
            self.check()
            identity = self._agent.identity(state="working")
            if identity.get('pausedReason'):
                self.stop_requested.set()
            body = {**self._body(self._phase, self._percent), "keepAwake": identity["keepAwake"], "agent": identity}
            started = time.time()
            answer = self._agent._heartbeat_request(self._path, body)
            if not (answer or {}).get("stop"):
                # Count from request start so a delayed response cannot extend
                # our deadline beyond the server's lease.
                self._lease_until = max(self._lease_until, started + LEASE_STALE_S)
            # Plugin queues may predate worker presence. Keep the nest's single
            # Mac alive while a plugin uses this same process/heartbeat helper.
            if not self._path.startswith(("/api/lyrics/", "/api/stems/", "/api/helpers/")):
                presence = self._agent._request("POST", "/api/lyrics/agent/heartbeat", {"agent": identity, "keepAwake": identity["keepAwake"]}, timeout=15)
                self._agent._control(presence)
        except urllib.error.HTTPError as error:
            if error.code in RESULT_FINAL_HTTP:
                self.stop_requested.set()
            error.close()
            return
        except (StopRequested, urllib.error.URLError, OSError, ValueError):
            return  # missed beats do not renew the local lease deadline
        if (answer or {}).get("stop"):
            self._agent._control(answer)
            self.stop_requested.set()

    def _loop(self) -> None:
        while self._running() and not self._agent._stopping.is_set():
            self._done.wait(min(HEARTBEAT_S, max(0, self._lease_until - time.time())))
            if self._running():
                self.beat()

    def start(self) -> "Heartbeat":
        threading.Thread(target=self._loop, name=self._name, daemon=True).start()
        return self

    def report(self, phase: str, percent: Optional[float]) -> None:
        self.check()
        self._phase, self._percent = phase, percent
        self.beat()
        self.check()

    def stop(self) -> None:
        self._done.set()


def _http_origin(url: str):
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme.lower(), parsed.hostname,
            parsed.port if parsed.port is not None else {"http": 80, "https": 443}.get(parsed.scheme.lower()))


class OriginScopedRedirect(urllib.request.HTTPRedirectHandler):
    """Keep bearer credentials on the original scheme/host/effective port only."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and _http_origin(req.full_url) != _http_origin(newurl):
            redirected.remove_header("Authorization")
        return redirected


class Agent:
    def __init__(self, server: str, token: str, name: Optional[str] = None, *, work_dir: Optional[Path] = None, log=None):
        self.server = server.rstrip("/")
        self.token = token
        self.name = name or computer_name()
        self.id = stable_id()
        self.session_id = str(uuid.uuid4())
        self.facts = capabilities(lightweight=True)
        from .addons import status as addon_status

        addons = addon_status()
        self.facts['engines'] = addons
        self.facts["jobs"] = [job for job in self.facts["jobs"]
                              if job in {"align", "stems"} and addons["lyrics" if job == "align" else "stems"]["ready"]]
        from .acceleration import module_ok

        if addons["analysis"]["ready"] and all(module_ok(m) for m in ("onnxruntime", "krobi_keyfinder")):
            self.facts["jobs"].append("analysis")
            self.facts["labels"] = ["analysis>=2"]
        self.last_error: Optional[str] = None
        self._replaced = False
        self.work_dir = work_dir or Path(tempfile.mkdtemp(prefix="krobi-helper-agent-"))
        self.custom_headers = json.loads(os.environ.get("KROBI_CUSTOM_HEADERS", "{}"))
        logger = log or log_stderr

        def redacted_log(message):
            for value in self.custom_headers.values():
                if value:
                    message = message.replace(value, "[REDACTED]")
            logger(message)

        self.log = redacted_log
        self._log_lock = threading.RLock()
        self._network_since = time.monotonic()
        self._clock_offset = time.time() - time.monotonic()
        self._after_sleep = False
        self._connected = False
        self._waiting_logged = False
        self._failure = None
        self._failure_repeats = 0
        self._stopping = threading.Event()
        self._parent = ParentWatch()
        #: The per-song process; overridable so tests can stand in a fake.
        self.job_command: List[str] = [sys.executable, "-m", "krobi_helper.cli", "run"]
        self.stems_command: List[str] = [sys.executable, "-m", "krobi_helper.cli", "stems"]
        self._awake_active = False
        self._awake_state = "none"
        self._awake_socket: Optional[socket.socket] = None
        self._awake_legacy = None
        self._awake_lock = threading.RLock()
        self._stems_unavailable_logged = False
        self._legacy_api = False
        self.work_limits = {}
        self._stems_jobs: Dict[str, str] = {}
        from .plugins import load_plugins

        self.claim_steps = list(load_plugins().claim_steps)

    # ------------------------------------------------------------- http

    def _urlopen(self, request, timeout):
        if not self.custom_headers:
            return urllib.request.build_opener(OriginScopedRedirect()).open(request, timeout=timeout)

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)

    def _headers(self, content_type: Optional[str] = None) -> Dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}", "User-Agent": f"Flipspin/{__version__} ( https://github.com/flipspin/flipspin )"}
        if content_type:
            headers["Content-Type"] = content_type
        headers.update(self.custom_headers)
        return headers

    def _request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, timeout: float = 30.0) -> Any:
        if self._stopping.is_set() and path.endswith(("/claim", "/heartbeat")):
            return {"stop": True, "reason": "replaced"} if self._replaced else {"stop": True}
        if not path.endswith("/bye"):
            self._network_activity()
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            self.server + path, data=data, method=method, headers=self._headers("application/json")
        )
        try:
            with self._urlopen(req, timeout=timeout) as response:
                raw = response.read()
        except (urllib.error.URLError, OSError) as error:
            self.last_error = last_error(error, self.server)
            self._publish_status(connected=False)
            if not isinstance(error, urllib.error.HTTPError):
                with self._log_lock:
                    self._connected = False
                if not path.endswith("/bye"):
                    self._waiting_for_network(error)
            raise
        answer = json.loads(raw) if raw else None
        if path.endswith(("/claim", "/heartbeat")) and not (isinstance(answer, dict) and answer.get("stop")):
            with self._log_lock:
                self._flush_failures()
                if not self._connected:
                    self.log(f"connected to {self.server} as {self.name}")
                    self._connected = True
        self.last_error = None
        state = (body or {}).get("agent", {}).get("state", "idle")
        self._publish_status(state=state, connected=True)
        return answer

    def _network_activity(self) -> None:
        # macOS monotonic time pauses during sleep. Also honor the shell's
        # sleep signal, starting the grace period on the next request.
        offset = time.time() - time.monotonic()
        with self._log_lock:
            if self._after_sleep or offset - self._clock_offset > 2:
                self._flush_failures()
                self._network_since = time.monotonic()
                self._waiting_logged = False
                self._connected = False
                self._after_sleep = False
            self._clock_offset = offset

    def _flush_failures(self) -> None:
        if self._failure_repeats:
            self.log(f"{self._failure} (repeated {self._failure_repeats}×)")
        self._failure = None
        self._failure_repeats = 0

    def _waiting_for_network(self, error: Exception) -> bool:
        # HTTP rejections (including auth/server errors) are never a normal
        # local-network permission wait. Share this across claims and beats.
        network = not isinstance(error, urllib.error.HTTPError) and isinstance(error, (urllib.error.URLError, OSError))
        with self._log_lock:
            if not network or time.monotonic() - self._network_since >= NETWORK_WAIT_S:
                return False
            if not self._waiting_logged:
                self.log("waiting for network…")
                self._waiting_logged = True
            return True

    def _claim_failure(self, error: Exception, backoff: float) -> None:
        with self._log_lock:
            self._connected = False
            if self._waiting_for_network(error):
                return
            message = f"claim failed [{last_error(error, self.server)}]: {error}"
            if message == self._failure:
                self._failure_repeats += 1
                # Bound silence during a long outage; flush the remainder on
                # recovery, a different error or shutdown.
                if self._failure_repeats == 5:
                    self.log(f"{message} (repeated 5×); retrying in {backoff:.0f}s")
                    self._failure_repeats = 0
            else:
                self._flush_failures()
                self._failure = message
                self.log(f"{message}; retrying in {backoff:.0f}s")

    def _helper_request(self, path, body, legacy_path, legacy_body, *, timeout=30):
        if not self._legacy_api:
            try:
                return self._request("POST", path, body, timeout=timeout)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                self._legacy_api = True
                self.log("helper API answered 404; using legacy agent routes")
        return self._request("POST", legacy_path, legacy_body, timeout=timeout)

    def _refresh_limits(self):
        try:
            limits = self._request('GET', '/api/helpers/limits', None, timeout=10)
            if isinstance(limits, dict) and 'pace' in limits:
                self.work_limits = limits
        except (urllib.error.URLError, OSError, ValueError):
            pass  # Old servers retain the original helper behavior.

    def _claim(self):
        if not self._legacy_api:
            self._refresh_limits()
        identity = self.identity()
        caps = {key: identity[key] for key in (
            "os", "accel", "gpu", "chip", "memoryBytes", "platform", "macos", "keepAwake", "labels", "onBattery", "powerReadable", "pausedReason", "utcOffsetMinutes", "engines"
        ) if key in identity}
        answer = self._helper_request("/api/helpers/claim", {
            "workerId": self.id, "sessionId": self.session_id, "name": self.name,
            "version": __version__, "kinds": identity.get("jobs", []), "capabilities": caps,
        }, "/api/lyrics/agent/claim", {"agent": identity, "max": 1})
        if self._legacy_api or not answer or answer.get("stop"):
            return answer
        job, lease = answer["job"], str(answer["lease"])
        payload = {**job["input"], "id": job["id"]}
        if job["kind"] == "analysis":
            return {"jobs": [], "analysis": {"lease": lease, **payload}}
        if job["kind"] == "stems":
            self._stems_jobs[lease] = str(job["id"])
            return {"jobs": [], "stems": {**payload, "id": lease, "jobId": job["id"]}}
        return {"lease": lease, "jobs": [payload]}

    def _heartbeat_request(self, path, body):
        if path == "/api/lyrics/agent/heartbeat" and body.get("jobId"):
            job_id, lease = body["jobId"], body["lease"]
            progress = body.get("percent")
        elif path == "/api/stems/agent/heartbeat" and body.get("id") in self._stems_jobs:
            lease = body["id"]
            job_id, progress = self._stems_jobs[lease], body.get("progress")
        else:
            return self._request("POST", path, body, timeout=15)
        return self._helper_request(f"/api/helpers/jobs/{job_id}/heartbeat", {
            "lease": lease, "phase": body.get("phase"), "progress": progress, "agent": body.get("agent"),
            "keepAwake": body.get("keepAwake", "none"),
        }, path, body, timeout=15)

    def _download(self, media_path: str, target: Path) -> None:
        req = urllib.request.Request(
            self.server + urllib.parse.quote(media_path, safe="/%"),
            headers=self._headers(),
        )
        with self._urlopen(req, timeout=120) as response, open(target, "wb") as out:
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)

    # ------------------------------------------------------------- loop

    def _publish_status(self, *, state: str = "idle", connected: bool = False) -> None:
        """Shell IPC: no token, unique path for the parent app, atomic snapshot."""
        path = os.environ.get("KROBI_AGENT_STATUS_PATH")
        if not path:
            return
        try:
            target = Path(path)
            temporary = target.with_suffix(f".{threading.get_ident()}.tmp")
            with open(temporary, "w", encoding="utf-8", opener=lambda p, f: os.open(p, f, 0o600)) as out:
                json.dump({"id": self.id, "state": state, "connected": connected,
                           "lastError": "replaced" if self._replaced else self.last_error}, out)
            temporary.replace(target)
        except OSError:
            pass

    def sleeping(self, *_: Any) -> None:
        # Signals must never block Python's main thread on a socket.
        self._after_sleep = True
        threading.Thread(target=self.bye, args=("sleep",), daemon=True).start()

    def bye(self, reason: str = "sleep") -> None:
        """For the shell's sleep notification; bounded and best effort."""
        try:
            self._helper_request("/api/helpers/bye", {"sessionId": self.session_id, "reason": reason},
                                 "/api/lyrics/agent/bye", {"id": self.id, "sessionId": self.session_id, "reason": reason}, timeout=2)
        except (urllib.error.URLError, OSError, ValueError):
            pass

    def stop(self, *_: Any) -> None:
        if self._stopping.is_set():
            return
        self._stopping.set()
        if not self._replaced:
            # Do not block the signal handler on a socket. run() joins this
            # daemon for at most two seconds before exiting.
            self._goodbye = threading.Thread(target=self.bye, args=("quit",), daemon=True)
            self._goodbye.start()

    def _control(self, answer: Any) -> bool:
        if isinstance(answer, dict) and answer.get("stop") and answer.get("reason") == "replaced":
            if not self._replaced:
                self.log("agent replaced: another Mac works for the nest; exiting (code 4)")
            self._replaced = True
            self._publish_status()
            self.stop()
            return True
        return False

    def _watch_parent(self) -> None:
        while not self._stopping.wait(2.0):
            if self._parent.gone():
                self.log("the app that started this agent is gone; stopping")
                self.stop()

    def identity(self, state: str = "idle") -> Dict[str, Any]:
        battery = on_battery()
        limits = getattr(self, 'work_limits', {})
        reason = paused_reason(limits, battery)
        return {
            'onBattery': battery, 'powerReadable': battery is not None, 'pausedReason': reason,
            'utcOffsetMinutes': int(datetime.now().astimezone().utcoffset().total_seconds() / 60),
            **self.facts,
            'jobs': [k for k in self.facts.get('jobs', []) if limits.get('use', {}).get(k, True)],
            "id": self.id,
            "sessionId": self.session_id,
            "state": state,
            "keepAwake": self._keep_awake_status() if state == "working" else "none",
            "lastError": self.last_error,
            "name": self.name,
            "platform": f"{platform.system().lower()}-{platform.machine()}",
            "version": __version__,
        }

    def run(self, *, once: bool = False) -> int:
        old_term, old_int = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
        old_sleep = signal.getsignal(signal.SIGUSR1) if hasattr(signal, "SIGUSR1") else None
        try:
            result = self._run(once=once)
            return REPLACED_EXIT_CODE if self._replaced else result
        finally:
            goodbye = getattr(self, "_goodbye", None)
            if goodbye:
                goodbye.join(timeout=2)
            self._stopping.set()
            with self._log_lock:
                self._flush_failures()
            signal.signal(signal.SIGTERM, old_term)
            signal.signal(signal.SIGINT, old_int)
            if old_sleep is not None:
                signal.signal(signal.SIGUSR1, old_sleep)

    def _run(self, *, once: bool = False) -> int:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        if hasattr(signal, "SIGUSR1"):
            signal.signal(signal.SIGUSR1, self.sleeping)
        threading.Thread(target=self._watch_parent, name="agent-parent", daemon=True).start()
        backoff = IDLE_POLL_S
        self.log(f"agent {self.name} → {self.server}")
        while not self._stopping.is_set():
            try:
                claimed = self._claim()
                backoff = IDLE_POLL_S
            except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError) as e:
                self._claim_failure(e, backoff)
                if once:
                    return 1
                self._stopping.wait(backoff)
                backoff = min(BACKOFF_MAX_S, backoff * 2)
                continue
            if self._control(claimed):
                break
            jobs = (claimed or {}).get("jobs") or []
            if not jobs:
                if (claimed or {}).get("analysis"):
                    self._process_analysis(claimed["analysis"])
                    if once:
                        return 0
                    continue
                stems_job = (claimed or {}).get("stems")
                if stems_job is None and self._legacy_api:
                    stems_job = self._claim_stems()
                if stems_job:
                    self._process_stems(stems_job)
                    if once:
                        return 0
                    continue  # straight back to lyrics: they keep priority
                if self._stopping.is_set():
                    break
                worked = False
                for step in self.claim_steps:
                    try:
                        if step(self):
                            worked = True
                            break
                    except Exception as exc:
                        self.log(f"plugin claim failed: {exc}")
                if worked:
                    if once:
                        return 0
                    continue
                if once:
                    return 0
                self._stopping.wait(IDLE_POLL_S)
                continue
            lease = str(claimed["lease"])
            for job in jobs:
                if self._stopping.is_set():
                    break
                self._process(lease, job)
            if once:
                return 0
        self.log("agent stopping")
        return 0

    # -------------------------------------------------------------- job

    def _process(self, lease: str, job: Dict[str, Any]) -> None:
        with self._job_awake():
            job_id = str(job["id"])
            item = str(job.get("item") or job.get("relPath"))
            self.log(f"job {job_id}: {item}")
            heartbeat = Heartbeat(
                self, "/api/lyrics/agent/heartbeat",
                lambda phase, percent: {"lease": lease, "jobId": job_id, "phase": phase, "percent": percent},
                name="agent-heartbeat",
            ).start()
            # Its own directory, removed whole when the job ends: the source audio,
            # the stems vocals, job.json and everything the song process writes
            # under ``--out-dir`` (decoded wavs, the .lrc) go with it.
            work = self.work_dir / f"lyrics-{uuid.uuid4().hex[:8]}"
            work.mkdir(parents=True, exist_ok=True)
            audio = work / ("source" + (Path(str(job.get("file") or "song.mp3")).suffix or ".mp3"))
            try:
                heartbeat.report(P.PHASE_DECODING, None)
                self._download(str(job["mediaPath"]), audio)
                vocals = None
                if job.get("vocalsPath") and job.get("text"):
                    # The song was split already: its vocals stem beats running demucs again.
                    try:
                        vocals = work / "vocals.ogg"
                        self._download(str(job["vocalsPath"]), vocals)
                    except (urllib.error.URLError, OSError, ValueError) as e:
                        self.log(f"job {job_id}: no stems vocals ({e}); separating here")
                        vocals = None
                jobs_file = work / "job.json"
                jobs_file.write_text(json.dumps([{
                    "id": job_id,
                    "audio": str(audio),
                    "text": job.get("text") or None,
                    "isolateVocals": bool(job.get("isolateVocals", True)),
                    "vocals": str(vocals) if vocals else None,
                }]), encoding="utf-8")
                outcome = self._run_job_process(jobs_file, work, heartbeat.report, heartbeat.stop_requested)
                if outcome is None:
                    raise StopRequested()
                if outcome.get("event") == "done":
                    lrc = Path(str(outcome["lrc"])).read_text(encoding="utf-8")
                    self._post_result(
                        lease, job_id, ok=True, lrc=lrc, source=str(outcome.get("source") or P.SOURCE_TRANSCRIBED),
                        line_confidence=outcome.get("lineConfidence"), low_lines=outcome.get("lowLines"),
                        execution={key: outcome[key] for key in ("accel", "fallbackReason", "gpu") if key in outcome},
                    )
                else:
                    # `final` says whether it is a verdict about the song ("no lyrics
                    # in this audio") or an accident the server should retry.
                    self._post_result(lease, job_id, ok=False, error=str(outcome.get("error") or "failed"), final=bool(outcome.get("final", False)))
            except StopRequested:
                self.log(f"job {job_id}: cancelled by the server")
            except Exception as e:  # noqa: BLE001 — one song must not end the agent
                # An accident (a crash, a lost download): let the server retry it.
                self._post_result(lease, job_id, ok=False, error=f"{type(e).__name__}: {e}", final=False)
            finally:
                heartbeat.stop()
                shutil.rmtree(work, ignore_errors=True)

    def _process_analysis(self, job) -> None:
        job_id, lease = str(job["id"]), job["lease"]
        heartbeat = Heartbeat(
            self, f"/api/helpers/jobs/{job_id}/heartbeat",
            lambda phase, progress: {"lease": lease, "phase": phase, "progress": progress},
            name="analysis-heartbeat",
        ).start()
        try:
            with self._job_awake(), tempfile.TemporaryDirectory(prefix="analysis-", dir=self.work_dir) as directory:
                work = Path(directory)
                items = []
                for index, item in enumerate(job["items"]):
                    heartbeat.report("analizando", 0.0)
                    audio = work / f"audio-{index}"
                    self._download(item["mediaUrl"], audio)
                    items.append({**item, "audio": str(audio)})
                spec = work / "jobs.json"
                spec.write_text(json.dumps(items), encoding="utf-8")
                heartbeat.report("analizando", 0.0)
                outcome = self._run_process(
                    [sys.executable, "-m", "krobi_helper.cli", "analysis", "--jobs", str(spec),
                     "--out-dir", str(work / "out")], heartbeat.report, heartbeat.stop_requested)
                if outcome is None:
                    raise StopRequested()
                heartbeat.report("analizando", len(items) / 25)
                if outcome.get("event") != "done":
                    self.log(f"analysis batch {job_id} failed; leaving its lease to retry")
                    return
                body = {"lease": lease, "items": outcome["items"]}
                (work / "result.json").write_text(json.dumps(body), encoding="utf-8")
                self._retry_result(
                    lambda: self._request("POST", f"/api/helpers/jobs/{job_id}/result", body),
                    heartbeat, f"analysis batch {job_id}",
                )
        except StopRequested:
            self.log(f"analysis batch {job_id}: stopped by the server")
        except Exception as exc:
            self.log(f"analysis batch {job_id}: {exc}; leaving its lease to retry")
        finally:
            heartbeat.stop()

    @contextmanager
    def _job_awake(self):
        """A nested process scope shares its owning job's assertion until upload ends."""
        owner = not self._awake_active
        if owner:
            self._awake_active = True
            self._awake_state = "failed"  # No subprocess/assertion yet (e.g. downloading).
        try:
            yield
        finally:
            if owner:
                with self._awake_lock:
                    if self._awake_socket is not None:
                        self._awake_socket.close()
                        self._awake_socket = None
                    if self._awake_legacy is not None:
                        try:
                            self._awake_legacy.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            self._awake_legacy.kill()
                            self._awake_legacy.wait()
                        self._awake_legacy = None
                    self._awake_state = "none"
                    self._awake_active = False

    def _acquire_keep_awake(self, pid: int) -> None:
        with self._awake_lock:
            if "KROBI_KEEP_AWAKE_ADDR" not in os.environ:
                self._awake_legacy = self._caffeinate(pid)
                self._awake_state = "held" if self._awake_legacy is not None else "failed"
                return
            conn = None
            try:
                host, port = os.environ["KROBI_KEEP_AWAKE_ADDR"].rsplit(":", 1)
                conn = socket.create_connection((host, int(port)), timeout=5.0)
                conn.set_inheritable(False)
                conn.sendall((json.dumps({"pid": pid}) + "\n").encode("utf-8"))
                deadline = time.monotonic() + 5.0
                reply = bytearray()
                while not reply.endswith(b"\n") and len(reply) < 1024:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("keep-awake reply timed out")
                    conn.settimeout(remaining)
                    chunk = conn.recv(1)
                    if not chunk:
                        raise ValueError("keep-awake connection closed before reply")
                    reply.extend(chunk)
                if not reply.endswith(b"\n"):
                    raise ValueError("keep-awake reply exceeds limit")
                answer = json.loads(reply)
                if not isinstance(answer, dict) or answer.get("keepAwake") not in ("held", "failed"):
                    raise ValueError("invalid keep-awake reply")
                self._awake_state = answer["keepAwake"]
                self._awake_socket = conn
            except (OSError, ValueError, OverflowError) as error:
                if conn is not None:
                    conn.close()
                self._awake_state = "failed"
                self.log(f"could not keep the computer awake: {error}")

    def _keep_awake_status(self) -> str:
        with self._awake_lock:
            conn = self._awake_socket
            if conn is not None and self._awake_state == "held":
                try:
                    readable, _, errors = select.select([conn], [], [conn], 0)
                    # The one reply is complete: EOF, errors or extra data invalidate it.
                    if readable or errors:
                        self._awake_state = "failed"
                        conn.close()
                        self._awake_socket = None
                except (OSError, ValueError):
                    self._awake_state = "failed"
                    conn.close()
                    self._awake_socket = None
            if self._awake_legacy is not None and self._awake_legacy.poll() is not None:
                self._awake_state = "failed"
            return self._awake_state

    def _caffeinate(self, pid: int):
        if platform.system() != "Darwin":
            return None
        try:
            return subprocess.Popen(["caffeinate", "-i", "-w", str(pid)],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as error:
            self.log(f"could not keep the Mac awake: {error}")
            return None

    def _run_job_process(self, jobs_file: Path, work: Path, report, stop_flag: threading.Event) -> Optional[Dict[str, Any]]:
        """Run one song in a ``krobi-helper run`` process and return its last
        ``done``/``failed`` event — or ``None`` when it was cancelled.

        A process that ends without either event (a crash, the OOM killer) is
        reported as an accident, so the server retries it."""
        return self._run_process(
            [*self.job_command, "--jobs", str(jobs_file), "--out-dir", str(work)], report, stop_flag
        )

    def _log_child_stderr(self, proc):
        def drain():
            assert proc.stderr is not None
            with proc.stderr:
                for line in proc.stderr:
                    self.log(line.rstrip("\r\n"))

        thread = threading.Thread(target=drain, name="agent-job-log", daemon=True)
        thread.start()
        return thread

    def _run_process(self, argv: List[str], report, stop_flag: threading.Event) -> Optional[Dict[str, Any]]:
        with self._job_awake():
            argv, launch = launch_options(argv, getattr(self, 'work_limits', {}))
            proc = subprocess.Popen(
                argv,
                **launch,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                close_fds=True,
                start_new_session=True,  # its ffmpeg children go down with it
            )

            stderr_thread = self._log_child_stderr(proc)
            try:
                self._acquire_keep_awake(proc.pid)

                def stopper() -> None:
                    while proc.poll() is None:
                        if stop_flag.wait(0.5) or self._stopping.is_set():
                            _terminate_group(proc)
                            return

                threading.Thread(target=stopper, name="agent-job-stop", daemon=True).start()
                outcome: Optional[Dict[str, Any]] = None
                assert proc.stdout is not None
                for line in proc.stdout:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    kind = event.get("event")
                    if kind == "phase":
                        try:
                            report(str(event.get("phase")), event.get("percent"))
                        except StopRequested:
                            _terminate_group(proc)
                    elif kind in ("done", "failed"):
                        outcome = event
                proc.wait()
                if outcome is None and (stop_flag.is_set() or self._stopping.is_set()):
                    return None
                if outcome is None:
                    return {"event": "failed", "error": f"el proceso terminó sin resultado (código {proc.returncode})", "final": False}
                return outcome
            finally:
                _terminate_group(proc)
                proc.wait()
                stderr_thread.join()
                if proc.stdout is not None:
                    proc.stdout.close()

    def _run_process_many(self, argv: List[str], report, stop_flag: threading.Event) -> Dict[str, Dict[str, Any]]:
        """Run one batch process and return ``{job id: its last done/failed
        event}``. ``report(job_id, phase, percent)`` sees every phase line and may
        raise `StopRequested` to kill the batch. A job missing from the answer
        got no verdict (cancelled, or the process died) — the caller decides."""
        with self._job_awake():
            argv, launch = launch_options(argv, getattr(self, 'work_limits', {}))
            proc = subprocess.Popen(
                argv,
                **launch,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                close_fds=True,
                start_new_session=True,
            )

            stderr_thread = self._log_child_stderr(proc)
            try:
                self._acquire_keep_awake(proc.pid)

                def stopper() -> None:
                    while proc.poll() is None:
                        if stop_flag.wait(0.5) or self._stopping.is_set():
                            _terminate_group(proc)
                            return

                threading.Thread(target=stopper, name="agent-batch-stop", daemon=True).start()
                outcomes: Dict[str, Dict[str, Any]] = {}
                assert proc.stdout is not None
                for line in proc.stdout:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    kind = event.get("event")
                    job_id = str(event.get("job") or "")
                    if kind == "phase":
                        try:
                            report(job_id, str(event.get("phase")), event.get("percent"))
                        except StopRequested:
                            _terminate_group(proc)
                    elif kind in ("done", "failed") and job_id:
                        outcomes[job_id] = event
                proc.wait()
                return outcomes
            finally:
                _terminate_group(proc)
                proc.wait()
                stderr_thread.join()
                if proc.stdout is not None:
                    proc.stdout.close()

    def _post_result(self, lease: str, job_id: str, *, ok: bool, lrc: Optional[str] = None, source: Optional[str] = None, error: Optional[str] = None, final: bool = True,
                     line_confidence: Optional[List[float]] = None, low_lines: Optional[List[int]] = None, execution: Optional[dict] = None) -> None:
        body: Dict[str, Any] = {"lease": lease, "jobId": job_id, "ok": ok, "lrc": lrc, "source": source, "error": error, "final": final}
        body.update(execution or {})
        if line_confidence is not None:
            # Additive: a server older than the aligner ignores unknown fields.
            body["lineConfidence"] = line_confidence
            body["lowLines"] = low_lines or []
        for attempt in range(5):
            if self._stopping.is_set():
                return
            try:
                answer = self._helper_request(f"/api/helpers/jobs/{job_id}/result",
                                              {k: v for k, v in body.items() if k != "jobId"},
                                              "/api/lyrics/agent/result", body, timeout=30)
                self.log(f"job {job_id}: {'ok' if ok else 'failed: ' + str(error)} → {answer}")
                return
            except (urllib.error.URLError, OSError, ValueError) as e:
                wait = min(BACKOFF_MAX_S, 5.0 * (attempt + 1))
                self.log(f"result post failed ({e}); retrying in {wait:.0f}s")
                self._stopping.wait(wait)
        self.log(f"job {job_id}: could not deliver the result; the lease will expire and the server will requeue")

    # ------------------------------------------------------------ stems

    def _claim_stems(self) -> Optional[Dict[str, Any]]:
        """One stems job, or ``None`` (nothing queued, or a server without stems)."""
        try:
            job = self._request("POST", "/api/stems/agent/claim", {"agent": self.identity()})
        except urllib.error.HTTPError as e:
            if e.code == 404:
                if not self._stems_unavailable_logged:
                    self.log("stems claim answered 404; this server has no stems queue (lyrics only)")
                    self._stems_unavailable_logged = True
            else:
                self.log(f"stems claim failed [{self.last_error}]: HTTP {e.code}")
            return None
        except (urllib.error.URLError, OSError, ValueError) as e:
            self.log(f"stems claim failed: {e}")
            return None
        self._control(job)
        return job if isinstance(job, dict) and job.get("id") and not job.get("stop") else None

    def _process_stems(self, job: Dict[str, Any]) -> None:
        with self._job_awake():
            lease = str(job["id"])
            item = f"{job.get('album')}/{job.get('file')}"
            self.log(f"stems {lease}: {item}")
            heartbeat = Heartbeat(
                self, "/api/stems/agent/heartbeat",
                lambda phase, percent: {"id": lease, "phase": phase, "progress": percent},
                name="agent-stems-heartbeat",
            ).start()
            work = self.work_dir / f"stems-{uuid.uuid4().hex[:8]}"
            work.mkdir(parents=True, exist_ok=True)
            audio = work / ("source" + (Path(str(job.get("file") or "song.mp3")).suffix or ".mp3"))
            out_dir = work / "out"
            try:
                heartbeat.report(P.PHASE_DECODING, None)
                self._download(str(job["mediaPath"]), audio)
                job_file = work / "job.json"
                job_file.write_text(json.dumps({
                    "id": lease, "audio": str(audio), "album": job.get("album"), "file": job.get("file"),
                    "model": job.get("model") or P.DEMUCS_MODEL,
                }), encoding="utf-8")
                outcome = self._run_process(
                    [*self.stems_command, "--job", str(job_file), "--out-dir", str(out_dir)], heartbeat.report, heartbeat.stop_requested
                )
                if outcome is None:
                    raise StopRequested()
                if outcome.get("event") == "done":
                    heartbeat.report(P.PHASE_UPLOADING, None)
                    self._post_stems(lease, out_dir, heartbeat=heartbeat)
                else:
                    self._post_stems_failure(lease, str(outcome.get("error") or "failed"), bool(outcome.get("final", False)), heartbeat=heartbeat)
            except StopRequested:
                self.log(f"stems {lease}: cancelled by the server")
            except Exception as e:  # noqa: BLE001 — one song must not end the agent
                try:
                    self._post_stems_failure(lease, f"{type(e).__name__}: {e}", False, heartbeat=heartbeat)
                except StopRequested:
                    pass
            finally:
                heartbeat.stop()
                self._stems_jobs.pop(lease, None)
                shutil.rmtree(work, ignore_errors=True)

    def _post_multipart(self, path: str, fields: Dict[str, str], files: Dict[str, Path], timeout: float = 300.0) -> Any:
        boundary = f"krobi{uuid.uuid4().hex}"
        parts: List[bytes] = []
        for name, value in fields.items():
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
            )
        for name, file_path in files.items():
            ctype = "application/json" if file_path.suffix == ".json" else "audio/ogg"
            parts.append(
                (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{file_path.name}"\r\n'
                 f"Content-Type: {ctype}\r\n\r\n").encode("utf-8")
            )
            parts.append(file_path.read_bytes())
            parts.append(b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode("utf-8"))
        body = b"".join(parts)
        req = urllib.request.Request(
            self.server + path, data=body, method="POST",
            headers=self._headers(f"multipart/form-data; boundary={boundary}"),
        )
        with self._urlopen(req, timeout=timeout) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    @staticmethod
    def _retry_after(error: Exception) -> float:
        if not isinstance(error, urllib.error.HTTPError):
            return 0.0
        value = (error.headers or {}).get("Retry-After", "")
        try:
            delay = float(value)
        except ValueError:
            try:
                delay = parsedate_to_datetime(value).timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                return 0.0
        return max(0.0, delay) if math.isfinite(delay) else 0.0

    def _retry_result(self, post: Callable[[], Any], heartbeat: Heartbeat, what: str) -> None:
        """Retain the finished output and its live heartbeat until a verdict."""
        attempt = 0
        while True:
            heartbeat.check()
            try:
                answer = post()
            except (urllib.error.URLError, OSError, ValueError) as error:
                if isinstance(error, urllib.error.HTTPError) and error.code in RESULT_FINAL_HTTP:
                    self.log(f"{what}: server refused result ({error.code}); discarding")
                    error.close()
                    return
                backoff = (RESULT_BACKOFF_S[attempt] if attempt < len(RESULT_BACKOFF_S)
                           else RESULT_BACKOFF_MAX_S)
                wait = max(backoff, self._retry_after(error))
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                attempt += 1
                self.log(f"{what}: result post failed ({error}); retrying in {wait:.0f}s")
                heartbeat.wait(wait)
                continue
            self._control(answer)
            if isinstance(answer, dict) and (answer.get("stop") or answer.get("reason") == "lease-lost"):
                heartbeat.stop_requested.set()
                raise StopRequested()
            self.log(f"{what}: result → {answer}")
            return

    def _deliver(self, lease: str, fields: Dict[str, str], files: Dict[str, Path], what: str,
                 *, heartbeat: Heartbeat | None = None) -> None:
        owned = heartbeat is None
        if heartbeat is None:
            heartbeat = Heartbeat(
                self, "/api/stems/agent/heartbeat",
                lambda phase, percent: {"id": lease, "phase": phase, "progress": percent},
                name="agent-stems-upload-heartbeat",
            ).start()

        def post():
            if not self._legacy_api and lease in self._stems_jobs:
                try:
                    return self._post_multipart(f"/api/helpers/jobs/{self._stems_jobs[lease]}/result",
                                                {"lease": lease, **fields}, files)
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    error.close()
                    self._legacy_api = True
            return self._post_multipart("/api/stems/agent/result", {"id": lease, **fields}, files)

        try:
            self._retry_result(post, heartbeat, f"stems {lease}: {what}")
        finally:
            if owned:
                heartbeat.stop()

    def _post_stems(self, lease: str, out_dir: Path, *, heartbeat: Heartbeat | None = None) -> None:
        files = {"song.json": out_dir / "song.json"}
        for stem in ("drums", "bass", "vocals", "other"):
            files[stem] = out_dir / f"{stem}.ogg"
        self._deliver(lease, {}, files, "result", heartbeat=heartbeat)

    def _post_stems_failure(self, lease: str, error: str, final: bool,
                            *, heartbeat: Heartbeat | None = None) -> None:
        self._deliver(
            lease, {"ok": "false", "error": error[:400], "final": "true" if final else "false"}, {},
            "failure: " + error[:80], heartbeat=heartbeat,
        )

def _terminate_group(proc: "subprocess.Popen[str]") -> None:
    # Output callbacks, cancellation and finally may all try to stop the same child.
    with proc.__dict__.setdefault("_krobi_stop_lock", threading.Lock()):
        if proc.poll() is not None:
            return
        if os.name == "nt":
            # taskkill /T includes ffmpeg descendants; /F also handles GUI parents.
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=JOB_KILL_GRACE_S)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def main_from_args(args) -> int:
    # The token belongs in the environment: an argument is readable by every
    # local user through `ps`. `--token` stays for a person at a terminal.
    token = os.environ.get("KROBI_API_TOKEN") or args.token or ""
    if not args.server or not token:
        log_stderr("agent needs --server and KROBI_API_TOKEN (or --token)")
        return 2
    lock = acquire_single_instance()
    if lock is None:
        log_stderr("another lyrics agent would not stop; not starting a second one")
        return 3
    agent = Agent(args.server, token, args.name)
    try:
        return agent.run(once=bool(args.once))
    finally:
        lock.close()
