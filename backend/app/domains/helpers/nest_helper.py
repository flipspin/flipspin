"""Opt-in, CPU-only last helper. Leases and results use the ordinary queues."""
from __future__ import annotations

import json
import logging
import queue
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from app.infra.instance import get_name
from app.domains.helpers import helper_ranking as ranking
from app.domains.helpers.mac_worker import SHIPPED_WORKER_VERSION, version_fields
from app.infra.nest_cgroup import CgroupUnavailable, probe_limits, probe_duty_cycle
from app.infra.nest_limits import temperature
from app.infra.engine_process import _parse, _signal_process_tree
from app.infra.machine import machine_facts
from app.domains.helpers.protocol import MANIFEST_NAME, STEMS, STEM_SUFFIX

HEARTBEAT_S = 8.0
NEST_ID = "internal:nest-cpu"
logger = logging.getLogger(__name__)
MESSAGES = {"no-engine": "Falta el motor del nido", "no-cgroup": "Este nido no puede limitar el proceso",
            'memory': 'Este nido no tiene memoria suficiente', 'thermal': 'El nido está demasiado caliente'}


class NestHelper:
    def __init__(self, config, lyrics, stems, *, probe=probe_limits, analysis=None, analysis_available=None,
                 read_temperature=temperature):
        self.config, self._lyrics, self._stems, self.probe = config, lyrics, stems, probe
        self._analysis = analysis
        self._analysis_available = analysis_available or self._probe_analysis
        self._analysis_probe_at = float('-inf')
        self._has_analysis = False
        self.session = uuid.uuid4().hex
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._wake, self._stop = threading.Event(), threading.Event()
        self._scope = None
        self._probe_at = float("-inf")
        self._check: dict = {}
        self._registered = False
        self._claiming = False
        self._reason: str | None = None
        self._scope_cpu = None
        self._running_cpu = None
        self._hot = False
        self._temperature = None
        self.read_temperature = read_temperature

    def _thermal_paused(self):
        self._temperature = self.read_temperature()
        if self._temperature is not None:
            if self._temperature >= self.config.nest_max_temp_c:
                self._hot = True
            elif self._temperature <= self.config.nest_resume_temp_c:
                self._hot = False
        return self._hot

    def _allowed(self, row):
        compute = getattr(self._lyrics().agent_queue.worker, 'compute', None)
        if compute:
            return not compute.reason(row, NEST_ID)
        return True

    def _memory(self):
        return machine_facts()['memoryBytes'] // 2

    def availability(self) -> dict:
        engine = self._lyrics().engine
        check = engine.check(accel="cpu") if engine.installed else None
        if not isinstance(check, dict) or check.get("error") or not check.get("jobs"):
            self._check = {}
            reason = "no-engine"
        else:
            self._check = check
            with self._lock:
                if self._running_cpu is None and (self._scope_cpu != self.config.nest_cpu_percent or time.monotonic() - self._probe_at >= 30):
                    self._scope, self._probe_at = self.probe(self.config.nest_cpu_percent), time.monotonic()
                    self._scope_cpu = self.config.nest_cpu_percent
                reason = None if self._scope else "no-cgroup"
            if reason is None and all(job != 'analysis' for job in check['jobs']) and self._memory() < ranking.MIN_MEMORY_BYTES:
                reason = 'memory'
        return {"disabledReason": reason, "disabledMessage": MESSAGES.get(reason)}

    def revision_inputs(self):
        availability = self.availability()
        self._thermal_paused()
        return (availability, self._check, self._temperature, self._hot,
                self._scope.mode if self._scope else None,
                get_name(self.config.instance_file), self._memory())

    def view(self):
        """A display row exists even when the nest cannot register as a worker."""
        availability = self.availability()
        worker = self._lyrics().agent_queue.worker
        row = next((h for h in worker.helpers() if h.get('nest')), None)
        blocked = []
        if reason := availability['disabledReason']:
            blocked.append({'code': reason})
        if self._check and self._memory() < ranking.MIN_MEMORY_BYTES:
            for kind in self._check.get('jobs', []):
                if kind in {'align', 'transcribe', 'stems'}:
                    blocked.append({'code': 'memory', 'kind': kind, 'requiredBytes': ranking.MIN_MEMORY_BYTES,
                                    'availableBytes': self._memory()})
        if self._thermal_paused():
            blocked.append({'code': 'thermal'})
        return {**(row or {'id': NEST_ID, 'nest': True, 'name': get_name(self.config.instance_file),
                          'os': 'linux', 'accel': 'cpu', 'version': self._check.get('version', SHIPPED_WORKER_VERSION), 'state': 'offline',
                          'lastSeenAt': 0, 'memoryBytes': machine_facts()['memoryBytes'], 'jobs': self._check.get('jobs', [])}),
                **version_fields((row or self._check).get('version') or SHIPPED_WORKER_VERSION),
                **availability, 'memoryBytes': self._memory(), 'engines': self._check.get('addons'),
                'blockedReasons': blocked, 'temperatureC': self._temperature,
                'pausedReason': 'thermal' if self._hot else None,
                'cpuLimitMode': self._scope.mode if self._scope and self._scope.mode in ('cgroup', 'duty-cycle') else None}

    def refresh(self) -> None:
        with self._lock:
            self._wake.set()
            if not self.config.nest_processes:
                return
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._loop, name="nest-helper", daemon=True)
                self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=HEARTBEAT_S + 6)

    def _enabled(self) -> bool:
        return self.config.nest_processes and self._lyrics().engine_mode == "agent" and not self._stop.is_set()

    def _state(self, claiming: bool, reason: str) -> None:
        if self._claiming != claiming or self._reason != reason:
            logger.info("nest helper %s claiming: %s", "started" if claiming else "stopped", reason)
            self._claiming, self._reason = claiming, reason

    def _retire(self, reason: str) -> None:
        if self._registered:
            self._lyrics().agent_queue.worker.remove_nest()
            self._registered = False
        self._state(False, reason)

    def _defer(self, reason):
        self._lyrics().agent_queue.queue.defer_holder(NEST_ID)
        self._retire(reason)

    def _probe_analysis(self):
        # Ask the tools interpreter about specs; never load a runtime in app.
        if time.monotonic() - self._analysis_probe_at >= 30:
            self._analysis_probe_at = time.monotonic()
            try:
                check = subprocess.run([str(self._lyrics().engine.python), '-c',
                    "from importlib.util import find_spec; import sys; "
                    "sys.exit(0 if all(find_spec(m) is not None for m in "
                    "('onnxruntime', 'krobi_keyfinder', 'krobi_helper.kinds.analysis')) else 1)"],
                    capture_output=True, timeout=5, check=False)
                self._has_analysis = check.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                self._has_analysis = False
        return self._has_analysis and bool(self._check.get("addons", {}).get("analysis", {}).get("ready"))

    def _agent(self) -> dict:
        jobs = [job for job in self._check['jobs'] if job in {'align', 'transcribe', 'stems'}]
        labels = []
        if self._analysis and self._analysis_available():
            jobs.append('analysis')
            labels.append(f'analysis>={self._analysis().engine_version}')
        return {"id": NEST_ID, "sessionId": self.session, "name": get_name(self.config.instance_file),
                "os": "linux", "accel": "cpu", "version": self._check["version"],
                "memoryBytes": self._memory(),
                "jobs": jobs, "labels": labels}

    def claim(self):
        """One scheduling turn, also used by the deterministic contract tests."""
        if not self._enabled():
            self._retire("off" if not self.config.nest_processes else "local-mode")
            return None
        if reason := self.availability()["disabledReason"]:
            self._retire(reason)
            return None
        if self._thermal_paused():
            self._state(False, 'thermal')
            return None
        lyrics, stems = self._lyrics(), self._stems()
        worker = lyrics.agent_queue.worker
        agent = self._agent()
        with worker.lock:
            if not self._enabled():  # Engine/cgroup probes may outlast a toggle.
                self._retire("off-or-local-mode")
                return None
            worker.register_nest(agent)
            lyrics.agent_queue.queue.claim_guards[NEST_ID] = self._allowed
            self._registered = True
            got = lyrics.agent_queue.claim(agent, max_jobs=1)
            if got["jobs"]:
                self._state(True, "no eligible helper for 600s")
                return "lyrics", got["lease"], got["jobs"][0], agent
            job = stems.queue.claim(agent)
            if job is not None and not isinstance(job, dict):
                self._state(True, "no eligible helper for 600s")
                return "stems", job.lease, job, agent
            # The nest's one CPU batch never overlaps lyrics or stems anywhere.
            if 'analysis' in agent['jobs'] and not any(
                    r['status'] == 'leased' for r in lyrics.agent_queue.queue.rows(('align', 'transcribe', 'stems'))):
                got = self._analysis().claim(agent)
                if got and got.get('job'):
                    self._state(True, 'no eligible helper for 600s')
                    return 'analysis', got['lease'], got['job'], agent
            real_online = any(not h.get("nest") and ranking.online(h)
                              and any(ranking.capable(h, kind, self._analysis().needs if kind == 'analysis' else ranking.default_needs(kind)) for kind in agent["jobs"])
                              for h in worker.scheduling_helpers())
            self._state(False, "eligible real helper online" if real_online else "waiting for fallback or work")
            return None

    def _loop(self) -> None:
        try:
            while not self._stop.is_set():
                self._wake.clear()
                try:
                    if claimed := self.claim():
                        self._run(*claimed)
                        continue
                except CgroupUnavailable:
                    with self._lock:
                        fallback = probe_duty_cycle(self.config.nest_cpu_percent) if getattr(self._scope, 'mode', None) == 'cgroup' else None
                        self._scope, self._probe_at = fallback, time.monotonic()
                    self._defer('duty-cycle' if fallback else "no-cgroup")
                except Exception:
                    logger.exception("nest helper turn failed")
                    self._retire("runner-error")
                self._wake.wait(HEARTBEAT_S)
        finally:
            self._retire("shutdown" if self._stop.is_set() else "off")

    def _heartbeat(self, kind, lease, job, agent, phase=None, percent=None) -> bool:
        if not self._enabled():
            self._retire("off" if not self.config.nest_processes else "shutdown-or-local-mode")
            return False
        if self._running_cpu is not None and self._running_cpu != self.config.nest_cpu_percent:
            self._defer('limits-changed')
            return False
        id = job['id'] if isinstance(job, dict) else job.id
        row = self._lyrics().agent_queue.queue.get(id)
        if row and not self._allowed(row):
            self._defer('compute-policy')
            return False
        if kind == "lyrics":
            answer = self._lyrics().agent_queue.heartbeat(lease, job["id"], phase, percent, agent)
        elif kind == 'analysis':
            answer = self._analysis().heartbeat(job['id'], lease, NEST_ID, phase, percent)
        else:
            answer = self._stems().heartbeat(lease, phase, percent, agent)
        return not answer.get("stop")

    def _run(self, kind, lease, job, agent) -> None:
        if not self._heartbeat(kind, lease, job, agent):
            return
        if self._scope_cpu != self.config.nest_cpu_percent:
            self._defer('limits-changed')
            return
        engine = self._lyrics().engine
        scope = self._scope  # A concurrent settings probe may replace the cached scope.
        scope_cpu = self._scope_cpu
        with tempfile.TemporaryDirectory(prefix="nest-helper-", dir=self.config.temp_dir) as directory:
            work = Path(directory)
            if kind == "lyrics":
                audio = self._lyrics().repository.audio_path(job["relPath"])
                vocals = self._lyrics()._vocals_for(job["relPath"]) if job.get("vocalsPath") else None
                payload = [{"id": job["id"], "audio": str(audio), "text": job["text"],
                            "isolateVocals": job["isolateVocals"], "vocals": str(vocals) if vocals else None}]
            elif kind == 'analysis':
                from app.utils.library_paths import resolve_rel_path
                payload = [{**item, 'audio': str(resolve_rel_path(self.config.base_music_dir, item['relPath']))}
                           for item in job['input']['items']]
            else:
                audio = self._stems().repository.audio_path(job.album, job.file)
                payload = {"id": lease, "audio": str(audio), "album": job.album, "file": job.file, "model": job.model}
            spec, out = work / "job.json", work / "out"
            spec.write_text(json.dumps(payload), encoding="utf-8")
            argv = [str(engine.binary), "run" if kind == "lyrics" else kind, "--accel", "cpu",
                    "--jobs" if kind in ("lyrics", "analysis") else "--job", str(spec), "--out-dir", str(out)]
            with (work / "engine.log").open("w") as log:
                env = engine._engine_env()
                if kind == "analysis":
                    env.update(OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1", VECLIB_MAXIMUM_THREADS="1")
                self._running_cpu = scope_cpu
                try:
                    proc = scope.launch(engine.python, argv, stdout=subprocess.PIPE, stderr=log,
                                       stdin=subprocess.DEVNULL, text=True, env=env,
                                       start_new_session=True)
                except BaseException:
                    self._running_cpu = None
                    raise
                try:
                    outcome = self._pump(proc, kind, lease, job, agent, scope=scope)
                finally:
                    try:
                        scope.kill()
                        if proc.poll() is None:
                            self._kill(proc, scope)
                        if proc.stdout:
                            proc.stdout.close()
                    finally:
                        self._running_cpu = None
            if outcome is None:
                return
            # Check the switch/lease once more before publishing a fast result.
            if not self._heartbeat(kind, lease, job, agent):
                return
            ok = outcome.get("event") == "done"
            if kind == "lyrics":
                self._lyrics().agent_queue.result(
                    lease, job["id"], ok=ok,
                    lrc=Path(outcome["lrc"]).read_text(encoding="utf-8") if ok else None,
                    source=outcome.get("source"), error=outcome.get("error"),
                    final=bool(outcome.get("final", False)), extra=outcome,
                )
            elif kind == 'analysis':
                items = outcome.get('items') if ok else [
                    {'relPath': item['relPath'], 'ok': False, 'error': outcome.get('error', 'engine-failed'),
                     'final': bool(outcome.get('final', False))} for item in job['input']['items']]
                if items is None:
                    items = json.loads((out / 'analysis.json').read_text(encoding='utf-8'))
                self._analysis().result(job['id'], lease, items, NEST_ID)
            elif ok:
                manifest = json.loads((out / MANIFEST_NAME).read_text(encoding="utf-8"))
                self._stems().publish(lease, manifest, {stem: out / f"{stem}{STEM_SUFFIX}" for stem in STEMS})
            else:
                self._stems().fail(lease, outcome.get("error", "failed"), final=bool(outcome.get("final", False)))

    def _pump(self, proc, kind, lease, job, agent, *, scope=None):
        # Read on a separate thread: heartbeat/cancel must work even when the
        # engine is silent during a long model phase or emits partial lines.
        events = queue.Queue()
        scope = scope or self._scope

        def read():
            try:
                for line in proc.stdout:
                    if event := _parse(line):
                        events.put(event)
            finally:
                events.put(None)

        reader = threading.Thread(target=read, name="nest-engine-output", daemon=True)
        reader.start()
        outcome = None
        deadline = time.monotonic()
        paused = False

        def thermal_control():
            nonlocal paused
            hot = self._thermal_paused()
            if hot != paused:
                scope.set_paused(proc, hot)
                paused = hot
                self._state(not hot, 'thermal' if hot else 'temperature-resumed')

        try:
            while True:
                if time.monotonic() >= deadline:
                    if not self._heartbeat(kind, lease, job, agent):
                        return None
                    thermal_control()
                    deadline = time.monotonic() + HEARTBEAT_S
                try:
                    event = events.get(timeout=max(0, deadline - time.monotonic()))
                except queue.Empty:
                    continue
                if event is None:
                    break
                if event.get("event") == "phase":
                    if not self._heartbeat(kind, lease, job, agent, event.get("phase"), event.get("percent")):
                        return None
                elif event.get("event") in {"done", "failed"}:
                    outcome = event
            # A process may close stdout before exiting. Continue heartbeats.
            while proc.poll() is None:
                if not self._heartbeat(kind, lease, job, agent):
                    return None
                thermal_control()
                try:
                    proc.wait(timeout=HEARTBEAT_S)
                except subprocess.TimeoutExpired:
                    continue
            if proc.returncode == 78:
                raise CgroupUnavailable
            return outcome or {"event": "failed", "error": "el motor terminó sin resultado", "final": False}
        finally:
            if proc.poll() is None:
                self._kill(proc, scope)
            reader.join(timeout=1)

    def _kill(self, proc, scope) -> None:
        scope.kill()
        try:
            _signal_process_tree(proc, force=True)
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)
