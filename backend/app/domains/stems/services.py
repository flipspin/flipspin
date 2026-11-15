"""Use the shared lease queue for local subprocesses and remote stem helpers.

Both paths publish through the same storage rules. Normalize worker manifests
using the job's track identity and server-relative URLs, never helper-supplied
identity. See docs/jobs.md for lease and publication rules.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from mutagen import File as AudioFile, MutagenError

from app.domains.helpers.protocol import StemsManifestError as StemsManifestError
from app.domains.helpers.mac_worker import WorkerRecord
from app.config import ConfigManager
from app.domains.stems.models import (
    DEFAULT_MODEL,
    MANIFEST_NAME,
    MANIFEST_VERSION,
    MODELS,
    STATUS_LEASED,
    STATUS_QUEUED,
    STEM_SUFFIX,
    STEMS,
    WIRE_READY,
    StemJob,
    StemPriority,
    iso,
)
from app.domains.stems.jobs import StemsQueue
from app.domains.stems.repositories import StemsNotFoundError, StemsRepository
from app.exceptions import ValidationError

LOCAL_AGENT = {"name": "local", "platform": "darwin-arm64", "version": ""}


def stem_urls(album: str, file: str) -> dict[str, str]:
    base = f"/api/stems/{quote(album, safe='')}/{quote(file, safe='')}"
    return {stem: f"{base}/{stem}" for stem in STEMS}


def file_signature(path: Path) -> dict[str, int]:
    """What identifies the library file a split came from: size + mtime. A
    re-download or a retag changes it, and the split is then stale."""
    st = path.stat()
    return {"size": int(st.st_size), "mtime": int(st.st_mtime)}


def signature_matches(manifest: dict[str, Any], current: dict[str, int]) -> bool:
    """A manifest without ``track.source`` (written before signatures existed) counts as matching."""
    recorded = (manifest.get("track") or {}).get("source")
    if not isinstance(recorded, dict):
        return True
    return int(recorded.get("size", -1)) == current["size"] and int(recorded.get("mtime", -1)) == current["mtime"]


def normalize_manifest(
    raw: Any, job: StemJob, *, now: float | None = None, source: dict[str, int] | None = None
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise StemsManifestError("song.json is not an object")
    if raw.get("version") != MANIFEST_VERSION:
        raise StemsManifestError(f"song.json version must be {MANIFEST_VERSION}")
    chops = raw.get("chops") or {}
    if not isinstance(chops, dict):
        raise StemsManifestError("chops must be an object")
    for name, rows in chops.items():
        if not isinstance(rows, list):
            raise StemsManifestError(f"chops.{name} must be a list")
        for row in rows:
            if not isinstance(row, dict):
                raise StemsManifestError(f"chops.{name} holds a non-object")
            start, end = row.get("start"), row.get("end")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
                raise StemsManifestError(f"chops.{name}: every chop needs end > start")
    manifest = dict(raw)
    track = dict(raw.get("track") or {})
    track["album"], track["file"] = job.album, job.file
    if source is not None:
        track["source"] = source
    manifest["track"] = track
    manifest["model"] = raw.get("model") or job.model
    manifest["stems"] = stem_urls(job.album, job.file)
    manifest["chops"] = chops
    manifest.setdefault("analysis", {})
    manifest.setdefault("createdAt", iso(now or time.time()))
    return manifest


class StemsService:
    def __init__(
        self,
        *,
        repository: StemsRepository,
        config: ConfigManager,
        logger: logging.Logger,
        engine: Any = None,
        worker: WorkerRecord | None = None,
        ledger=None,
        progress_tracker=None,
        engine_mode: Callable[[], str] = lambda: "agent",
        read_tags: Callable[[Path], dict[str, Any]] = lambda path: {},
    ):
        self.repository = repository
        self.config = config
        self.logger = logger
        self.queue = StemsQueue(
            repository, logger, worker=worker, duration=self._track_duration, ledger=ledger,
            progress_tracker=progress_tracker, background_enabled=lambda: getattr(config, "stems_background", False),
        )
        #: The lyrics engine (same ``krobi-helper`` program): its binary, its
        #: environment and whether this host is Apple Silicon.
        self.engine = engine
        self.engine_mode = engine_mode
        self.runner = LocalStemsRunner(self, logger)
        self.read_tags = read_tags

    def _track_duration(self, album: str, file: str) -> float | None:
        audio = AudioFile(self.repository.audio_path(album, file))
        return audio.info.length if audio is not None else None

    # ------------------------------------------------------------ clients

    def request(self, album: str, file: str, model: str | None = None, *,
                priority: StemPriority = "now", requested_by: str | None = None) -> dict[str, Any]:
        model = model or DEFAULT_MODEL
        if model not in MODELS:
            raise ValueError(f"model must be one of {', '.join(MODELS)}")
        audio = self.repository.audio_path(album, file)  # 404 when it is not a library track
        with self.queue.worker.lock:
            if priority == "background" and not getattr(self.config, "stems_background", False):
                return {"status": "skipped"}
            existing = self.queue.get(album, file)
            if existing is None or existing.status not in (STATUS_QUEUED, STATUS_LEASED):
                manifest = self.repository.manifest(album, file)
                if manifest is not None and signature_matches(manifest, file_signature(audio)):
                    return {"status": WIRE_READY, "jobId": None}
            # A stale split keeps playing until its replacement lands.
            job = self.queue.request(album, file, model, priority=priority, requested_by=requested_by)
            answer = {"status": job.wire_status, "jobId": job.id}
        self.kick_local()
        return answer

    def set_background(self, enabled: bool) -> None:
        # Share the enqueue/claim lock: disabling cannot race a new background row.
        with self.queue.worker.lock:
            self.config.stems_background = enabled
            if not enabled:
                self.queue.evict_background()

    def splits(self, allows: Callable[[str], bool]) -> list[dict[str, Any]]:
        rows = []
        for album, file, manifest in self.repository.manifests():
            if not allows(f"{album}/{file}"):
                continue
            tags: dict[str, Any] = {}
            stale = True
            try:
                audio = self.repository.audio_path(album, file)
                stale = not signature_matches(manifest, file_signature(audio))
                tags = self.read_tags(audio)
            except (OSError, StemsNotFoundError, ValueError, MutagenError):
                pass  # a missing source or unreadable tags must not hide a stored split
            rows.append({
                "album": album, "file": file,
                "title": tags.get("title") or Path(file.replace("∕", "/")).stem,
                "artist": tags.get("artist") or "Unknown Artist",
                "albumTitle": tags.get("album") or album,
                "createdAt": manifest.get("createdAt"), "stale": stale,
                "sizeBytes": self.repository.size_bytes(album, file),
            })
        return rows

    def delete_all(self) -> int:
        # Serialize with publication: an in-flight result still lands afterwards.
        with self.queue.worker.lock:
            return sum(self.repository.delete(album, file) for album, file, _ in self.repository.manifests())

    def status(self, album: str, file: str) -> tuple[int, dict[str, Any]]:
        """``(200, manifest)`` · ``(202, pending)`` · raises :class:`StemsNotFoundError`."""
        try:
            manifest = self.repository.manifest(album, file)
        except ValidationError as e:
            raise StemsNotFoundError(str(e)) from e
        if manifest is not None:
            manifest["stems"] = stem_urls(album, file)
            return 200, manifest
        job = self.queue.get(album, file)
        if job is None:
            raise StemsNotFoundError(f"No stems requested for {album}/{file}")
        body = job.pending_body()
        body["agent"] = self._agent_state()  # so a client stuck on `queued` can say why
        return 202, body

    def stem_file(self, album: str, file: str, stem: str) -> Path:
        try:
            path = self.repository.stem_path(album, file, stem)
        except ValidationError as e:
            raise StemsNotFoundError(str(e)) from e
        if path is None:
            raise StemsNotFoundError(f"No {stem} stem for {album}/{file}")
        return path

    def fresh_vocals(self, album: str, file: str) -> Path | None:
        """The vocals stem of a split made from the file as it is now, or ``None``.

        The lyrics aligner prefers it to running demucs again. A split of an
        older version of the file (re-downloaded, retagged) is not used."""
        try:
            audio = self.repository.audio_path(album, file)
            manifest = self.repository.manifest(album, file)
            if manifest is None or not signature_matches(manifest, file_signature(audio)):
                return None
            return self.repository.stem_path(album, file, "vocals")
        except (StemsNotFoundError, ValidationError, OSError):
            return None

    def jobs(self) -> dict[str, Any]:
        self.kick_local()  # polled: picks up rows that survived a restart
        snapshot = self.queue.snapshot()
        snapshot["agent"] = self._agent_state()
        snapshot["mode"] = self._mode()
        return snapshot

    def _agent_state(self) -> dict[str, Any]:
        agent = self.queue.agent_status()
        if agent["online"] is False and self._mode() == "local" and self._local_ready():
            agent["online"] = True  # this process is the worker
        return agent

    def delete(self, album: str, file: str) -> bool:
        with self.queue.worker.lock:
            try:
                removed_files = self.repository.delete(album, file)
            except ValidationError as e:
                raise StemsNotFoundError(str(e)) from e
            removed_job = self.queue.remove(album, file)
            return removed_files or removed_job

    # -------------------------------------------------------------- agent

    def claim(self, agent: dict[str, Any] | None) -> dict[str, Any] | None:
        with self.queue.worker.lock:
            if not getattr(self.config, "stems_background", False):
                self.queue.evict_background()
            job = self.queue.claim(agent)
        if job is None or isinstance(job, dict):
            return job
        return {
            "id": job.lease,
            "jobId": job.id,
            "album": job.album,
            "file": job.file,
            "mediaPath": f"/api/media/{quote(job.album, safe='')}/{quote(job.file, safe='')}",
            "model": job.model,
            "attempt": job.attempts,
        }

    def heartbeat(self, lease: str, phase: str | None = None, progress: float | None = None, agent: dict[str, Any] | None = None) -> dict[str, Any]:
        return self.queue.heartbeat(lease, phase, progress, agent)

    def publish(self, lease: str, manifest_raw: Any, files: dict[str, Path]) -> dict[str, Any]:
        """A finished split. Ignored (``accepted: False``) under an unknown lease;
        :class:`StemsManifestError` when the upload is not servable."""
        with self.queue.worker.lock:
            receipt = self.queue.result_response(lease)
            if receipt:
                return receipt
            return self._publish_current(lease, manifest_raw, files)

    def _publish_current(self, lease: str, manifest_raw: Any, files: dict[str, Path]) -> dict[str, Any]:
        job = self.queue.leased(lease)
        if job is None:
            return {"accepted": False, "reason": "lease-lost"}
        missing = [s for s in STEMS if s not in files]
        if missing:
            raise StemsManifestError(f"missing stems: {', '.join(missing)}")
        try:
            source = file_signature(self.repository.audio_path(job.album, job.file))
        except StemsNotFoundError:
            source = None  # the track left the library mid-split; the split is still worth keeping
        manifest = normalize_manifest(manifest_raw, job, source=source)
        if not self.queue.complete(lease, manifest, files):
            return {"accepted": False, "reason": "lease-lost"}
        self.logger.info("stems ready for %s/%s", job.album, job.file)
        return {"accepted": True, "status": WIRE_READY}

    def fail(self, lease: str, error: str, *, final: bool) -> dict[str, Any]:
        return self.queue.fail(lease, error, final=final)

    # -------------------------------------------------------------- local

    def _mode(self) -> str:
        try:
            return str(self.engine_mode())
        except Exception:  # noqa: BLE001
            return "agent"

    def _local_ready(self) -> bool:
        if self.engine is None or not getattr(self.engine, "installed", False):
            return False
        check = self.engine.check()
        return bool(check and check.get("addons", {}).get("stems", {}).get("ready"))

    def kick_local(self) -> None:
        """In local mode with the engine installed, make sure the runner is draining."""
        if self._mode() != "local" or not self._local_ready():
            return
        if self.queue.has_queued():
            self.runner.kick()


class LocalStemsRunner:
    """Drains the queue in this process when the backend itself runs on Apple Silicon.

    One song per ``krobi-helper stems`` subprocess (MLX keeps models and its
    Metal cache for the life of a process), JSON lines on stdout, cancel by
    process group — the same discipline as the agent and the lyrics engine.
    """

    def __init__(self, service: StemsService, logger: logging.Logger):
        self.service = service
        self.logger = logger
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def kick(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(target=self._loop, name="stems-local", daemon=True)
            self._thread.start()

    def _loop(self) -> None:
        while True:
            check = self.service.engine.check() or {}
            job = self.service.queue.claim({**LOCAL_AGENT, "version": check.get("version", "")})
            if job is None or isinstance(job, dict):
                return
            try:
                self._run(job)
            except Exception as e:  # noqa: BLE001 — one song must not end the runner
                self.logger.exception("local stems run failed")
                self.service.fail(job.lease or "", f"{type(e).__name__}: {e}", final=False)

    def _run(self, job: StemJob) -> None:
        engine = self.service.engine
        lease = job.lease or ""
        temp_root = Path(getattr(self.service.config, "temp_dir", tempfile.gettempdir()))
        temp_root.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="stems-", dir=str(temp_root)))
        try:
            audio = self.service.repository.audio_path(job.album, job.file)
            job_file = work / "job.json"
            job_file.write_text(
                json.dumps({"id": lease, "audio": str(audio), "album": job.album, "file": job.file, "model": job.model}),
                encoding="utf-8",
            )
            out_dir = work / "out"
            with open(work / "engine.log", "w") as log:
                proc = subprocess.Popen(
                    [str(engine.binary), "stems", "--job", str(job_file), "--out-dir", str(out_dir)],
                    stdout=subprocess.PIPE, stderr=log, stdin=subprocess.DEVNULL,
                    text=True, env=engine._engine_env(), start_new_session=True,
                )
                outcome = self._pump(proc, lease)
            if outcome is None:
                return  # stopped: the row is gone or someone else holds it
            if outcome.get("event") == "done":
                manifest = json.loads((out_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
                files = {stem: out_dir / f"{stem}{STEM_SUFFIX}" for stem in STEMS}
                self.service.publish(lease, manifest, files)
            else:
                self.service.fail(lease, str(outcome.get("error") or "failed"), final=bool(outcome.get("final", False)))
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _pump(self, proc: subprocess.Popen, lease: str) -> dict[str, Any] | None:
        assert proc.stdout is not None
        outcome: dict[str, Any] | None = None
        stopped = False
        for line in proc.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            kind = event.get("event")
            if kind == "phase":
                answer = self.service.heartbeat(lease, str(event.get("phase")), event.get("percent"))
                if answer.get("stop") and not stopped:
                    stopped = True
                    _kill_group(proc)
            elif kind in ("done", "failed"):
                outcome = event
        proc.wait()
        if stopped:
            return None
        if outcome is None:
            return {"event": "failed", "error": f"el motor terminó sin resultado (código {proc.returncode})", "final": False}
        return outcome


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
