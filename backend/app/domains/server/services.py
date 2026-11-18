import asyncio
import logging
import os
import shlex
import sys
import time
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.infra.paths import data_root, default_music_dir
from app.infra import env_sources
from app.domains.acquisition.sources.compat import LEGACY_SOURCES
from app.infra.ffmpeg import probe_ffmpeg
from app.infra.cors import resolve_cors_settings
from app.infra.logging import LoggerConfig
from app.infra.tasks import spawn_background
from app.domains.server.machine import machine_facts

logger = logging.getLogger(__name__)
monotonic = time.monotonic


@dataclass(frozen=True)
class Definition:
    key: str
    attr: str | None
    group: str
    kind: str
    default: Any
    editable: bool = False
    restart: bool = False
    secret: bool = False
    minimum: int | None = None
    maximum: int | None = None
    choices: tuple[str, ...] = ()
    unit: str | None = None


DEFINITIONS = [
    *[Definition(key, None, "library", "text", "", editable=True)
      for _, key in LEGACY_SOURCES.values()],
    Definition("KROBI_MAX_CONCURRENT_DOWNLOADS", "max_concurrent_downloads", "capacity", "int", 2,
               True, minimum=1, maximum=4, unit="downloads"),
    Definition("KROBI_MAX_CONCURRENT_JOBS", "max_concurrent_jobs", "capacity", "int", 2,
               True, minimum=1, maximum=8, unit="jobs"),
    # Compatibility for the renderer's three-value capacity presets; no analysis pool uses it.
    Definition("KROBI_ANALYSIS_WORKERS", "analysis_workers", "capacity", "int", 2,
               True, minimum=1, unit="workers"),
    Definition("KROBI_LOG_LEVEL", "log_level", "logging", "choice", "INFO", True,
               choices=("DEBUG", "INFO", "WARNING", "ERROR")),
    Definition("KROBI_ENABLE_WAVEFORM_CACHE", "enable_waveform_cache", "library", "bool", True, True),
    Definition("KROBI_UPDATE_CHECK", "update_check", "network", "bool", True, editable=True),
    Definition("KROBI_ADVERTISE", "advertise", "network", "bool", True, True),
    Definition("KROBI_NEST_PROCESSES", "nest_processes", "lyrics", "bool", False, True),
    Definition('KROBI_NEST_CPU_PERCENT', 'nest_cpu_percent', 'lyrics', 'int', 50,
               True, minimum=1, maximum=100, unit='percent of one core'),
    Definition('KROBI_NEST_MAX_TEMP_C', 'nest_max_temp_c', 'lyrics', 'int', 85,
               True, minimum=40, maximum=100, unit='°C'),
    Definition('KROBI_NEST_RESUME_TEMP_C', 'nest_resume_temp_c', 'lyrics', 'int', 75,
               True, minimum=30, maximum=99, unit='°C'),
    Definition("KROBI_STEMS_BACKGROUND", "stems_background", "stems", "bool", False, editable=True),
    Definition("KROBI_ANALYSIS_AUTO", "analysis_auto", "library", "bool", True, editable=True),
    Definition("KROBI_LYRICS_ENGINE", "lyrics_engine_mode", "lyrics", "choice", "auto", True, True,
               choices=("auto", "local", "agent")),
    Definition("KROBI_MUSIC_DIR", "base_music_dir", "folders", "path", str(default_music_dir())),
    *[Definition(key, attr, "folders", "path", str(data_root() / folder)) for key, attr, folder in [
        ("KROBI_PLAYLIST_DIR", "playlist_dir", "playlists"),
        ("KROBI_STEMS_DIR", "stems_dir", "stems"),
        ("KROBI_LOG_DIR", "log_dir", "logs"),
    ]],
    Definition("KROBI_BACKEND_PORT", None, "network", "int", 8000, minimum=1, maximum=65535),
    Definition("KROBI_BACKEND_HOST", None, "network", "text", "0.0.0.0"),
    Definition("KROBI_CORS_ORIGINS", None, "network", "list", resolve_cors_settings(None).allow_origins),
    Definition("KROBI_REQUIRE_SETUP_TOKEN", "require_setup_token", "security", "bool", False),
    Definition("KROBI_API_TOKEN", "api_token", "security", "text", None, secret=True),
    Definition("KROBI_ALLOW_UNAUTHENTICATED_REMOTE", "allow_unauthenticated_remote", "security", "bool", False),
    Definition("KROBI_ALLOW_REMOTE_LOCAL_ACTIONS", "allow_remote_local_actions", "security", "bool", False),
    Definition("KROBI_FFMPEG_PATH", "ffmpeg_path", "library", "path", None, True),
    Definition("KROBI_DEMO_OVERRIDES", None, "library", "text", ""),
]
BY_KEY = {d.key: d for d in DEFINITIONS}


def supervision() -> str:
    if os.getenv("KROBI_SUPERVISOR") == "desktop":
        return "desktop"
    if os.getenv("INVOCATION_ID"):
        return "systemd"
    if Path("/.dockerenv").exists():
        return "docker"
    return "none"


def restart_command() -> str:
    if getattr(sys, "frozen", False):
        return shlex.join([sys.executable, *sys.argv[1:]])
    return shlex.join([sys.executable, "-m", "app", "--host", os.getenv("KROBI_BACKEND_HOST", "0.0.0.0"),
                       "--port", os.getenv("KROBI_BACKEND_PORT", "8000"), "--data-dir", str(data_root())])


class ServerConfigService:
    def __init__(self, container):
        self.container = container
        self.config = container.config
        self.path = self.config.data_root / ".env"
        self.running = {d.key: self.value(d) for d in DEFINITIONS if d.restart}
        self.restarting = False
        self.exiting = False
        self._restart_task: asyncio.Task | None = None
        self._restart_when: str | None = None

    def value(self, d: Definition):
        if d.attr:
            value = getattr(self.config, d.attr)
            return str(value) if isinstance(value, Path) else value
        raw = os.getenv(d.key)
        if d.editable and not d.attr and d.key not in env_sources.ENV_KEYS:
            raw = env_sources.read_values(self.path).get(d.key, raw)
        if raw is None:
            return d.default
        if d.kind == "int":
            return int(raw)
        if d.kind == "list":
            return resolve_cors_settings(raw).allow_origins
        return raw

    def activity(self) -> dict:
        states = self.container.get_progress_tracker().list_all_progress()
        # Progress includes imports before their first track starts, and queued jobs.
        jobs = sum(not state.is_terminal and state.status != "queued" for state in states)
        downloads = sum(len(state.active) for state in states if not state.is_terminal)
        cutoff = datetime.now(UTC).timestamp() - 300
        seen = 0
        for user in self.container.get_token_store().list_users():
            for device in user.devices:
                if not device.last_seen_at:
                    continue
                try:
                    if datetime.fromisoformat(device.last_seen_at.replace("Z", "+00:00")).timestamp() > cutoff:
                        seen += 1
                except ValueError:
                    pass
        return {
            "downloads": max(downloads, self.config.download_limiter.active),
            "jobs": max(jobs, self.config.job_limiter.active),
            "devicesSeen5min": seen,
        }

    def revision_inputs(self):
        # Settings and activity are small source projections, without describe's
        # machine probes, grouping, provenance rows or response serialization.
        with env_sources.SETTINGS_LOCK:
            stamp = self.path.stat().st_mtime_ns if self.path.exists() else None
            values = tuple(self.value(d) for d in DEFINITIONS)
            availability = self.container.get_nest_helper().availability()
            return stamp, values, self.activity()['devicesSeen5min'], availability

    def describe(self) -> dict:
        with env_sources.SETTINGS_LOCK:
            machine = machine_facts()
            saved = env_sources.read_values(self.path)
            groups = {key: [] for key in ("capacity", "network", "security", "library", "logging", "lyrics", "stems", "folders")}
            pending = []
            for d in DEFINITIONS:
                value = self.value(d)
                if d.key == "KROBI_DEMO_OVERRIDES" and not value:
                    continue
                source = env_sources.source(d.key, self.path)
                row = dict(key=d.key, value=None if d.secret else value, default=d.default,
                           source=source, editable=d.editable and source != "env", needsRestart=d.restart,
                           secret=d.secret, kind=d.kind)
                if d.key == "KROBI_NEST_PROCESSES":
                    row.update(self.container.get_nest_helper().availability())
                if d.key == "KROBI_FFMPEG_PATH":
                    row.update(version=self.config.ffmpeg_version, binarySource=self.config.ffmpeg_source)
                if d.secret:
                    row["configured"] = bool(value)
                if d.kind == "int":
                    maximum = d.maximum or machine["cores"]
                    suggested = {"KROBI_MAX_CONCURRENT_DOWNLOADS": max(2, machine["cores"]),
                                 "KROBI_MAX_CONCURRENT_JOBS": max(1, machine["cores"] // 2),
                                 "KROBI_ANALYSIS_WORKERS": max(1, min(machine["cores"] - 1,
                                                                   machine["memoryBytes"] // 700_000_000))}
                    row.update(min=d.minimum, max=maximum,
                               suggestedMax=suggested.get(d.key, maximum))
                    if d.unit:
                        row["unit"] = d.unit
                if d.choices:
                    row["choices"] = list(d.choices)
                if d.restart and source != "env" and d.key in saved and saved[d.key] != self.running[d.key]:
                    pending.append(d.key)
                    row["pendingValue"] = saved[d.key]
                groups[d.group].append(row)
                # Shipped readers still receive these inert rows in their original
                # positions. They are absent from the writable settings registry.
                if d.key == 'KROBI_ANALYSIS_AUTO':
                    for key in ('KROBI_ANALYSIS_AUTO_LIBRARY', 'KROBI_ANALYSIS_AUTO_UPGRADE'):
                        groups[d.group].append(dict(key=key, value=False, default=False, source='default',
                            editable=False, needsRestart=False, secret=False, kind='bool'))
                if d.key == 'KROBI_NEST_RESUME_TEMP_C':
                    for key in ('KROBI_NEST_LIBRARY_START_HOUR', 'KROBI_NEST_LIBRARY_END_HOUR'):
                        groups[d.group].append(dict(key=key, value=0, default=0, source='default',
                            editable=False, needsRestart=False, secret=False, kind='int',
                            min=0, max=23, suggestedMax=23, unit='local hour'))
            how = supervision()
            return {"machine": machine, "restart": {"pending": pending, "supported": how != "none", "how": how,
                                                    **({"command": restart_command()} if how == "none" else {})},
                    "activity": self.activity(), "groups": [{"id": k, "settings": v} for k, v in groups.items()]}

    def update(self, changes: dict) -> dict:
        with env_sources.SETTINGS_LOCK:
            changes = dict(changes)
            cores = machine_facts()["cores"]
            ffmpeg_version = None
            for key, value in changes.items():
                d = BY_KEY.get(key)
                if d is None:
                    raise HTTPException(422, {"code": "unknown-key", "key": key})
                env_sources.require_unlocked(key)
                if not d.editable:
                    raise HTTPException(409, {"code": "read-only", "key": key})
                expected = {"int": int, "bool": bool, "choice": str, "path": str, "text": str}[d.kind]
                if type(value) is not expected:
                    raise HTTPException(422, {"code": "bad-type", "key": key})
                if key == "KROBI_FFMPEG_PATH":
                    try:
                        ffmpeg_version = probe_ffmpeg(value)
                        changes[key] = str(Path(value).absolute())
                    except ValueError:
                        raise HTTPException(422, {"code": "invalid-ffmpeg", "key": key})
                if d.kind == "int" and not d.minimum <= value <= (d.maximum or cores):
                    raise HTTPException(422, {"code": "out-of-range", "key": key,
                                              "min": d.minimum, "max": d.maximum or cores})
                if d.choices and value not in d.choices:
                    raise HTTPException(422, {"code": "not-a-choice", "key": key, "choices": list(d.choices)})
            if changes.get('KROBI_NEST_RESUME_TEMP_C', self.config.nest_resume_temp_c) >= changes.get('KROBI_NEST_MAX_TEMP_C', self.config.nest_max_temp_c):
                raise HTTPException(422, {'code': 'out-of-range', 'key': 'KROBI_NEST_RESUME_TEMP_C'})
            was_checking = self.config.update_check
            analysis_keys = {'KROBI_ANALYSIS_AUTO'}
            analysis = self.container.get_analysis_service() if analysis_keys.intersection(changes) else None
            with analysis.worker.lock if analysis else nullcontext():
                env_sources.persist(self.path, {key: str(value).lower() if isinstance(value, bool) else str(value)
                                                for key, value in changes.items()})
                for key, value in changes.items():
                    d = BY_KEY[key]
                    if key == 'KROBI_ANALYSIS_AUTO':
                        analysis.set_auto(value)
                    elif key == "KROBI_STEMS_BACKGROUND":
                        self.container.get_stems_service().set_background(value)
                    elif not d.restart and d.attr:
                        setattr(self.config, d.attr, value)
            if ffmpeg_version is not None:
                self.config.ffmpeg_path = str(Path(changes["KROBI_FFMPEG_PATH"]).absolute())
                self.config.ffmpeg_version = ffmpeg_version
                self.config.ffmpeg_source = "env"
            self.config.download_limiter.wake()
            self.config.job_limiter.wake()
            if "KROBI_LOG_LEVEL" in changes:
                LoggerConfig.set_level(self.config.log_level)
            if "KROBI_UPDATE_CHECK" in changes and was_checking != self.config.update_check:
                self.container.get_update_checker().refresh()
            if "KROBI_ADVERTISE" in changes:
                self.container.get_nest_advertiser().refresh()
            if any(key.startswith('KROBI_NEST_') for key in changes):
                self.container.get_nest_helper().refresh()
            self.container.changes.bump('config')
            return self.describe()

    def restart(self, when: str) -> dict:
        if supervision() == "none":
            return {"restarting": False, "when": when, "command": restart_command()}
        if not self.restarting or (when == "now" and self._restart_when == "idle" and not self.exiting):
            if self._restart_task is not None:
                self._restart_task.cancel()
            self.restarting = True
            self.container.changes.bump('config')
            self._restart_when = when
            self._restart_task = spawn_background(self._restart(when))
        return {"restarting": True, "when": when}

    async def _restart(self, when: str) -> None:
        deadline = monotonic() + 1800
        if when == "idle":
            while True:
                activity = self.activity()
                if not activity["downloads"] and not activity["jobs"]:
                    break
                if monotonic() >= deadline:
                    logger.warning("Idle restart waited 30 minutes; restarting with work still running")
                    break
                await asyncio.sleep(5)
        self.exiting = True
        # Give requests a last-second 503/Retry-After and let the 202 flush.
        await asyncio.sleep(1)
        os._exit(75)
