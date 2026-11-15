"""Drive the separate helper process without bundling heavy ML into the server.

Probes return actionable hint codes. Cancellation terminates the process group,
including model and ffmpeg children. Only the backend publishes staged lyrics,
respecting edited sidecars; failed or cancelled work leaves no publication.
"""
from __future__ import annotations

import json
import logging
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from collections.abc import Callable

from app.infra.engine_process import _parse as _parse, _signal_process_tree as _signal_process_tree

from app.config import KROBI_HOME, ConfigManager
from app.infra.progress import ProgressTracker

INSTALL_PROGRESS_ID = "lyrics-engine-install"
ENGINE_PYTHON = "3.12"
#: Phases the install job reports; the renderer maps them to words.
PHASE_VENV = "entorno"
PHASE_DEPS = "paquetes"
PHASE_MODELS = "modelos"
#: Where uv tends to live when the packaged app's PATH does not say.
UV_CANDIDATES = ("/opt/homebrew/bin/uv", "/usr/local/bin/uv", "~/.local/bin/uv", "~/.cargo/bin/uv")


class EngineBusyError(RuntimeError):
    pass


class EngineNotReadyError(RuntimeError):
    pass


@dataclass
class EngineJob:
    """One song for the engine. ``text`` known → align; else transcribe."""

    rel_path: str
    audio: Path
    item: str
    text: str | None = None
    isolate_vocals: bool = True
    language: str | None = None
    #: A fresh split's vocals stem; the engine aligns on it instead of running demucs.
    vocals: Path | None = None
    # Snapshot authorizing a timing-only replacement; never sent to the worker.
    expected_lyric: str | None = None
    selection: dict[str, Any] | None = None


@dataclass
class _Run:
    progress_id: str
    jobs: dict[str, EngineJob]
    process: subprocess.Popen
    work_dir: Path
    started_at: float = field(default_factory=time.time)
    done: int = 0
    saved: int = 0
    failed: int = 0
    cancelled: bool = False
    attempt: int = 1


class LyricsEngine:
    def __init__(
        self,
        *,
        config: ConfigManager,
        progress_tracker: ProgressTracker,
        logger: logging.Logger,
        on_result: Callable[[EngineJob, dict[str, Any]], None],
        on_failure: Callable[[EngineJob, str], None],
    ):
        self.config = config
        self.progress_tracker = progress_tracker
        self.logger = logger
        self.on_result = on_result
        self.on_failure = on_failure
        self._lock = threading.Lock()
        self._installing: threading.Thread | None = None
        self._install_error: str | None = None
        self._install_target = "engine"
        self._remove_gpu = False
        self._addon_errors: dict[str, str] = {}
        self._size_cache: int | None = None
        self._run: _Run | None = None
        self._check_cache: dict[str | None, tuple[float, dict[str, Any] | None]] = {}

    # --------------------------------------------------------------- paths

    @property
    def tools_dir(self) -> Path:
        root = Path(getattr(self.config, "tools_dir", KROBI_HOME / "tools"))
        helper, legacy = root / "helper", root / "lyrics"
        if legacy.is_dir() and not helper.exists():
            # Do not relocate a venv: its scripts and Windows launchers contain
            # absolute paths. The alias also preserves a live agent.lock inode.
            try:
                if os.name == "nt":
                    subprocess.run(["cmd", "/c", "mklink", "/J", str(helper), str(legacy.resolve())],
                                   check=True, capture_output=True)
                else:
                    helper.symlink_to("lyrics", target_is_directory=True)
            except FileExistsError:
                pass  # The desktop may have migrated it concurrently.
        return helper

    @property
    def models_dir(self) -> Path:
        return Path(getattr(self.config, "models_dir", KROBI_HOME / "models"))

    @property
    def venv_dir(self) -> Path:
        return self.tools_dir / "venv"

    @property
    def binary(self) -> Path:
        directory = self.venv_dir / ("Scripts" if os.name == "nt" else "bin")
        binary = directory / ("krobi-helper.exe" if os.name == "nt" else "krobi-helper")
        legacy = directory / ("krobi-lyrics.exe" if os.name == "nt" else "krobi-lyrics")
        return binary if binary.exists() or not legacy.exists() else legacy

    @property
    def python(self) -> Path:
        return self.venv_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    def worker_sources(self) -> list[Path]:
        """Base worker and explicitly supplied or bundled plugin packages."""
        extras = [Path(p).expanduser() for p in os.getenv("KROBI_LYRICS_PLUGIN_SOURCES", "").split(os.pathsep) if p]
        for name in ("KROBI_HELPER_SRC", "KROBI_LYRICS_WORKER_SRC"):
            env = os.getenv(name)
            if env and Path(env).exists():
                source = Path(env)
                compat = [source / "compat"] if (source / "compat/pyproject.toml").is_file() else []
                return [source, *compat, *extras]
        if getattr(sys, "frozen", False):
            bundled = Path(sys.executable).resolve().parent / "helper-worker"
            base = sorted(bundled.glob("krobi_helper-*.whl"))
            plugins = sorted(p for p in bundled.glob("*.whl") if not p.name.startswith("krobi_helper-"))
            legacy_plugins = sorted(p for p in (bundled.parent / "lyrics-worker").glob("*.whl")
                                    if not p.name.startswith(("krobi_lyrics-", "krobi_helper-"))
                                    and p.name not in {plugin.name for plugin in plugins})
            return [*base[-1:], *plugins, *legacy_plugins, *extras] if base else []
        repo = Path(__file__).resolve().parents[4] / "helper"
        return [repo, repo / "compat", *extras] if (repo / "pyproject.toml").exists() else []

    def worker_source(self) -> Path | None:
        """Primary source, retained for status consumers."""
        return next(iter(self.worker_sources()), None)

    def _uv(self) -> str | None:
        windows = platform.system() == "Windows"
        found = shutil.which("uv.exe" if windows else "uv")
        if found:
            return found
        for candidate in UV_CANDIDATES:
            path = Path(f"{candidate}.exe" if windows else candidate).expanduser()
            if path.exists():
                return str(path)
        return None

    def _engine_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["HF_HOME"] = str(self.models_dir / "hf")
        env["TORCH_HOME"] = str(self.models_dir / "torch")
        env["PYTHONUNBUFFERED"] = "1"
        if getattr(self.config, "ffmpeg_path", None):
            env["KROBI_FFMPEG_PATH"] = str(self.config.ffmpeg_path)
        # Hugging Face's progress bars and telemetry have no place in a job log.
        env.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        env.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        path = env.get("PATH", "")
        for extra in ("/opt/homebrew/bin", "/usr/local/bin"):
            if extra not in path.split(os.pathsep):
                path = f"{extra}{os.pathsep}{path}"
        env["PATH"] = path
        return env

    # -------------------------------------------------------------- status

    @property
    def supported(self) -> bool:
        system, machine = platform.system(), platform.machine().lower()
        return ((system == "Darwin" and machine == "arm64")
                or (system == "Linux" and machine in {"x86_64", "arm64", "aarch64"})
                or (system == "Windows" and machine in {"x86_64", "amd64"}))

    @property
    def installed(self) -> bool:
        return self.binary.exists()

    def check(self, *, max_age_s: float = 30.0, accel: str | None = None) -> dict[str, Any] | None:
        """``krobi-helper check``, cached briefly; ``None`` if it cannot run."""
        if not self.installed:
            return None
        if not self._managed_python():
            return {"ready": False, "error": "unmanaged-python"}
        cached_at, cached = self._check_cache.get(accel, (0.0, None))
        if cached and time.time() - cached_at < max_age_s:
            return cached
        try:
            proc = subprocess.run(
                [str(self.binary), "check", "--json", *(["--accel", accel] if accel else [])],
                capture_output=True, text=True, timeout=45, env=self._engine_env(),
            )
            data = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else None
        except (OSError, subprocess.TimeoutExpired, ValueError, IndexError) as e:
            self.logger.warning("krobi-helper check failed: %s", e)
            data = None
        self._check_cache[accel] = (time.time(), data)
        return data

    def _managed_python(self) -> bool:
        """uv-created venv, backed by a managed CPython distribution.

        The directory may live under UV_PYTHON_INSTALL_DIR, so do not pin it
        to ~/.local/share/uv. A uv marker alone also admits system Python.
        """
        try:
            config = dict(
                line.split(" = ", 1) for line in (self.venv_dir / "pyvenv.cfg").read_text().splitlines()
                if " = " in line
            )
            python = self.python.resolve(strict=True)
            if os.name == "nt":
                home = Path(config.get("home", "")).resolve()
                base = Path(config.get("base-executable", "")).resolve()
                return bool(config.get("uv") and config.get("implementation") == "CPython"
                            and home.name.startswith("cpython-") and base == home / "python.exe"
                            and base.is_file())
            return bool(
                config.get("uv") and config.get("implementation") == "CPython"
                and python.parent == Path(config.get("home", "")).resolve()
                and python.parent.name == "bin" and python.parent.parent.name.startswith("cpython-")
            )
        except (OSError, RuntimeError):
            return False

    def invalidate_check(self) -> None:
        self._check_cache.clear()
        self._size_cache = None

    def status(self) -> dict[str, Any]:
        installing = self._installing is not None and self._installing.is_alive()
        install_state = self.progress_tracker.get_progress(INSTALL_PROGRESS_ID)
        check = None if installing and self._install_target == "engine" else self.check()
        ready = bool(check and check.get("ready"))
        addons = {name: {**(check or {}).get("addons", {}).get(name, {"installed": False, "ready": False, "sizeBytes": None}),
                         "error": self._addon_errors.get(name),
                         "installing": installing and self._install_target == name}
                  for name in ("lyrics", "stems", "analysis", "gpu")}
        with self._lock:
            run = self._run
        running = None
        if run is not None:
            running = {
                "progressId": run.progress_id,
                "total": len(run.jobs),
                "done": run.done,
                "saved": run.saved,
                "failed": run.failed,
            }
        if not self.supported:
            hint = "unsupported-platform"
        elif installing:
            hint = "installing"
        elif self._install_error:
            hint = "install-failed"
        elif not self.installed:
            hint = "not-installed" if self._uv() else "no-uv"
        elif check is None or check.get("error"):
            hint = "broken"
        elif not ready:
            hint = "models-missing"
        else:
            hint = "ready"
        return {
            **{key: value for key, value in (check or {}).items()
               if key in {"os", "accel", "gpu", "chip", "memoryBytes", "jobs"}},
            "supported": self.supported,
            "installed": self.installed,
            "ready": ready,
            "engineReady": bool((check or {}).get("engineReady", ready)),
            "sizeBytes": max(0, self._runtime_size() - (addons["analysis"].get("runtimeBytes") or 0) - (addons["gpu"].get("runtimeBytes") or 0))
            if self.installed and not (installing and self._install_target == "engine") else None,
            "addons": addons,
            "hint": hint,
            "installError": self._install_error,
            "checkError": (check or {}).get("error"),
            "installing": (
                {
                    "target": self._install_target,
                    "progressId": INSTALL_PROGRESS_ID,
                    "phase": next(iter(install_state.active.values()), {}).get("phase") if install_state else None,
                    "percent": next(iter(install_state.active.values()), {}).get("percent") if install_state else None,
                }
                if installing
                else None
            ),
            "running": running,
            "version": (check or {}).get("version"),
            "python": (check or {}).get("python"),
            "models": (check or {}).get("models"),
            "uv": bool(self._uv()),
            "toolsDir": str(self.tools_dir),
            "modelsDir": str(self.models_dir),
            "workerSource": str(self.worker_source()) if self.worker_source() else None,
        }

    # ------------------------------------------------------------- install

    def _runtime_size(self) -> int:
        if self._size_cache is None:
            self._size_cache = sum(p.stat().st_size for p in self.venv_dir.rglob("*") if p.is_file() and not p.is_symlink())
        return self._size_cache

    def remove(self, target: str = "engine") -> None:
        if target not in {"engine", "lyrics", "stems", "analysis", "gpu"}:
            raise ValueError("Unknown add-on")
        if target == "gpu":
            self.install("gpu", remove=True)
            return
        with self._lock:
            if (self._installing and self._installing.is_alive()) or self._run:
                raise EngineNotReadyError("The engine is busy.")
            check = self.check(max_age_s=0)
            if not check or check.get("error"):
                raise EngineNotReadyError("Could not check the engine.")
            if target == "engine":
                if any(check.get("addons", {}).get(name, {}).get("installed") for name in ("lyrics", "stems", "analysis")):
                    raise EngineNotReadyError("Remove all add-ons first.")
                shutil.rmtree(self.venv_dir, ignore_errors=True)
                self._install_error = None
            else:
                self._sh([str(self.binary), "remove", "--addon", target], self._engine_env())
                self._addon_errors.pop(target, None)
            self.invalidate_check()

    def install(self, target: str = "engine", *, remove: bool = False) -> str:
        """Install the runtime or one add-on's models. One shared process lane."""
        if target not in {"engine", "lyrics", "stems", "analysis", "gpu"}:
            raise ValueError("Unknown add-on")
        if remove and (target != "gpu" or not self.installed):
            raise EngineNotReadyError("The engine is not installed.")
        with self._lock:
            # A running install answers first, whatever this machine lacks for the new one.
            if self._installing is not None and self._installing.is_alive() and (
                    self._install_target != target or self._remove_gpu != remove):
                raise EngineNotReadyError("Another installation is running.")
        if target not in {"engine", "analysis"} and not remove:
            check = self.check() or {}
            if not check.get("engineReady", check.get("ready")):
                raise EngineNotReadyError("Install the engine first.")
        if not self.supported:
            raise EngineNotReadyError("This platform cannot run the lyrics engine.")
        sources = self.worker_sources() if target in {"engine", "analysis"} else []
        if target in {"engine", "analysis"}:
            if not self._uv():
                raise EngineNotReadyError("Falta uv en este equipo (https://docs.astral.sh/uv/).")
            if not sources:
                raise EngineNotReadyError("The engine's package is not bundled with this build.")
        with self._lock:
            if self._installing is not None and self._installing.is_alive():
                if self._install_target != target or self._remove_gpu != remove:
                    raise EngineNotReadyError("Another installation is running.")
                return INSTALL_PROGRESS_ID
            if self._run and target == "gpu":
                raise EngineNotReadyError("The engine is busy.")
            self._install_target = target
            self._remove_gpu = remove
            self._addon_errors.pop(target, None)
            self.progress_tracker.delete_progress(INSTALL_PROGRESS_ID)
            self.progress_tracker.create_progress(INSTALL_PROGRESS_ID, 2 if target == "engine" else 1, kind="lyrics-helper", label="Instalar motor")
            self._install_error = None
            self._installing = threading.Thread(
                target=self._install_worker, args=(sources,), name="lyrics-engine-install", daemon=True
            )
            self._installing.start()
        return INSTALL_PROGRESS_ID

    def _install_worker(self, sources: list[Path]) -> None:
        if self._install_target not in {"engine", "analysis"}:
            self._install_addon()
            return
        pid = INSTALL_PROGRESS_ID
        item = "motor"
        try:
            uv = self._uv()
            if not uv:
                raise EngineNotReadyError("Falta uv en este equipo (https://docs.astral.sh/uv/).")
            self.tools_dir.mkdir(parents=True, exist_ok=True)
            self.models_dir.mkdir(parents=True, exist_ok=True)
            env = self._engine_env()

            self.progress_tracker.set_track_phase(pid, item, PHASE_VENV)
            # A Python.app bundle gets a separate macOS Local Network identity.
            self._sh(
                [uv, "venv", "--python", ENGINE_PYTHON, "--python-preference", "only-managed",
                 "--allow-existing", str(self.venv_dir)],
                env,
            )
            pip_install = [uv, "pip", "install", "--python", str(self.python)]
            self.progress_tracker.update_progress(pid, "entorno")

            self.progress_tracker.set_track_phase(pid, item, PHASE_DEPS)
            # Explicit CPU base, retaining an already installed CUDA layer.
            check = self.check() or {}
            gpu = check.get("addons", {}).get("gpu", {})
            torch_backend = ["--torch-backend", "cu130" if gpu.get("installed")
                             and not gpu.get("included") and platform.system() != "Darwin" else "cpu"]
            requirements = self._package_requirements(sources, self._install_target)
            self._sh([*pip_install, *torch_backend, *requirements], env, timeout=1800)
            self.invalidate_check()
            self.progress_tracker.update_progress(pid, "paquetes")
            if self._install_target == "analysis":
                self._prefetch(env)

            self.invalidate_check()
            self.progress_tracker.complete_progress(pid, "done", succeeded=2, failed=0)
        except Exception as e:  # noqa: BLE001 — the message is the whole point
            self._install_error = str(e)
            self.logger.exception("lyrics engine install failed")
            self.progress_tracker.complete_progress(pid, "failed", succeeded=0, failed=1)

    def _package_requirements(self, sources: list[Path], target: str) -> list[str]:
        check = self.check() or {}
        selected = check.get("addons", {})
        engine = (target == "engine" or check.get("engineReady", check.get("ready")) or check.get("packages", {}).get("torch")
                  or any(selected.get(name, {}).get("installed") for name in ("lyrics", "stems")))
        analysis = target == "analysis" or selected.get("analysis", {}).get("installed")
        extras = [name for name, enabled in (("engine", engine), ("analysis", analysis)) if enabled]
        base = sources[0]
        requirements = [f"{base}[{','.join(extras)}]" if extras else str(base)]
        if base.is_file():
            requirements += ["--find-links", str(base.parent)]
        elif analysis and (base / "keyfinder/pyproject.toml").is_file():
            requirements.append(str(base / "keyfinder"))
        if engine:
            requirements += [str(p) for p in sources[1:] if not p.name.startswith("krobi_keyfinder-")]
        return requirements

    def _sh(self, argv: list[str], env: dict[str, str], timeout: int = 600) -> None:
        self.logger.info("lyrics engine: %s", " ".join(argv))
        proc = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=timeout)
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            log_dir = self.tools_dir.parent.parent / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            with (log_dir / "helper-install.log").open("a") as log:
                log.write(detail + "\n")
            self.logger.error("Engine command failed: %s", detail)
            raise RuntimeError(f"{Path(argv[0]).name}: {detail}")

    def _change_gpu(self, *, remove: bool = False) -> None:
        uv = self._uv()
        if not uv:
            raise EngineNotReadyError("No uv available")
        self._sh([str(self.binary), "gpu", "--uv", uv, *(["--remove"] if remove else [])],
                 self._engine_env(), timeout=1800)

    def _install_addon(self) -> None:
        target = self._install_target
        try:
            if target == "gpu":
                self._change_gpu(remove=self._remove_gpu)
            else:
                self._prefetch(self._engine_env())
            self.progress_tracker.complete_progress(INSTALL_PROGRESS_ID, "done", succeeded=1, failed=0)
        except Exception as exc:
            self._addon_errors[target] = str(exc)
            self.logger.exception("%s add-on install failed", target)
            self.progress_tracker.complete_progress(INSTALL_PROGRESS_ID, "failed", succeeded=0, failed=1)
        finally:
            self.invalidate_check()

    def _prefetch(self, env: dict[str, str]) -> None:
        # Send library progress and raw errors to the helper log without pipe deadlocks.
        log_dir = self.tools_dir.parent.parent / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / "helper-install.log").open("a") as log:
            self._prefetch_logged(env, log)

    def _prefetch_logged(self, env, log) -> None:
        proc = subprocess.Popen(
            [str(self.binary), "prefetch", "--addon", self._install_target, "--json"],
            stdout=subprocess.PIPE, stderr=log, text=True, env=env, start_new_session=True,
        )
        assert proc.stdout is not None
        last_error = None
        for line in proc.stdout:
            event = _parse(line)
            if not event:
                continue
            if event.get("event") == "prefetch":
                self.progress_tracker.set_track_phase(
                    INSTALL_PROGRESS_ID, "motor", PHASE_MODELS, event.get("percent")
                )
            elif event.get("event") == "failed":
                last_error = str(event.get("error"))
        proc.wait(timeout=60)
        if proc.returncode != 0 or last_error:
            raise RuntimeError(last_error or "La descarga de modelos falló.")

    # ----------------------------------------------------------------- run

    def run(self, jobs: list[EngineJob], *, progress_id=None) -> str:
        """Start a batch. One at a time; the engine holds the whole GPU."""
        if not jobs:
            raise ValueError("No songs to process")
        if not self.installed:
            raise EngineNotReadyError("The lyrics engine is not installed.")
        check = self.check() or {}
        if any(job.text for job in jobs) and "addons" in check and not check["addons"].get("lyrics", {}).get("ready"):
            raise EngineNotReadyError("Install the Lyrics add-on first.")
        with self._lock:
            if self._run is not None:
                raise EngineBusyError("The lyrics engine is already processing a batch.")
            progress_id = progress_id or f"lyrics-engine-{uuid.uuid4()}"
            work_dir = Path(tempfile.mkdtemp(prefix="lyrics-engine-", dir=str(self.config.temp_dir)))
            jobs_file = work_dir / "jobs.json"
            payload = [
                {
                    "id": f"j{index}",
                    "audio": str(job.audio),
                    "text": job.text,
                    "isolateVocals": job.isolate_vocals,
                    "language": job.language,
                    "vocals": str(job.vocals) if job.vocals else None,
                }
                for index, job in enumerate(jobs)
            ]
            jobs_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            self.progress_tracker.create_progress(progress_id, len(jobs), kind='lyrics-helper',
                label=jobs[0].item if len(jobs) == 1 else f'{len(jobs)} canciones',
                items=[{'item': j.item, 'rel_path': j.rel_path,
                        'detail': {'_retry': {'producer': 'lyrics-helper', 'job': {
                            'relPath': j.rel_path, 'item': j.item, 'text': j.text,
                            'expectedLyric': j.expected_lyric, 'selection': j.selection, 'isolateVocals': j.isolate_vocals,
                            'stemsVocals': j.vocals is not None}}}} for j in jobs])
            self.progress_tracker.set_status(progress_id, 'in_progress')
            for job in jobs:
                self.progress_tracker.set_track_phase(progress_id, job.item, "en cola")
            process = subprocess.Popen(
                [str(self.binary), "run", "--jobs", str(jobs_file), "--out-dir", str(work_dir / "out")],
                stdout=subprocess.PIPE, stderr=open(work_dir / "engine.log", "w"),
                text=True, env=self._engine_env(), start_new_session=True,
            )
            run = _Run(progress_id, {f"j{i}": j for i, j in enumerate(jobs)}, process, work_dir)
            run.attempt = self.progress_tracker.attempt_for(progress_id)
            self._run = run
        threading.Thread(target=self._pump, args=(run,), name="lyrics-engine-run", daemon=True).start()
        return progress_id

    def _pump(self, run: _Run) -> None:
        proc = run.process
        assert proc.stdout is not None
        try:
            for line in proc.stdout:
                event = _parse(line)
                if not event:
                    continue
                ledger = self.progress_tracker.ledger
                record = ledger.get(run.progress_id) if ledger else None
                if ledger and (not record or record['attempt'] != run.attempt or record['state'] not in ('queued','running')):
                    continue
                job = run.jobs.get(str(event.get("job")))
                kind = event.get("event")
                if kind == "phase" and job:
                    self.progress_tracker.set_track_phase(
                        run.progress_id, job.item, str(event.get("phase")), event.get("percent")
                    )
                elif kind == "done" and job:
                    try:
                        self.on_result(job, event)
                        run.saved += 1
                    except Exception as e:  # noqa: BLE001
                        run.failed += 1
                        self.logger.warning("could not save engine result for %s: %s", job.rel_path, e)
                        self.progress_tracker.add_failure(run.progress_id, {'item': job.item, 'reason': str(e), 'kind': 'error'})
                        self.on_failure(job, str(e))
                    run.done += 1
                    self.progress_tracker.update_progress(run.progress_id, job.item)
                elif kind == "failed" and job:
                    run.failed += 1
                    run.done += 1
                    self.progress_tracker.add_failure(run.progress_id, {'item': job.item, 'reason': str(event.get('error') or 'failed'), 'kind': 'error'})
                    self.on_failure(job, str(event.get("error") or "failed"))
                    self.progress_tracker.update_progress(run.progress_id, job.item)
            proc.wait(timeout=30)
        except Exception as e:  # noqa: BLE001
            self.logger.warning("lyrics engine pump ended: %s", e)
        finally:
            # Anything the engine never reported on counts as failed.
            for job in run.jobs.values():
                ledger = self.progress_tracker.ledger
                record = ledger.get(run.progress_id) if ledger else None
                if ledger and (not record or record['attempt'] != run.attempt or record['state'] not in ('queued','running')):
                    continue
                state = self.progress_tracker.get_progress(run.progress_id)
                if state and job.item not in state.done:
                    run.failed += 1
                    run.done += 1
                    self.progress_tracker.add_failure(run.progress_id, {'item': job.item, 'reason': 'cancelado' if run.cancelled else 'el motor terminó sin responder', 'kind': 'error'})
                    self.on_failure(job, "cancelado" if run.cancelled else "el motor terminó sin responder")
                    self.progress_tracker.update_progress(run.progress_id, job.item)
            # Idle first, then announce: a client that sees the progress go
            # terminal and immediately starts the next batch must not be told
            # the engine is still busy with this one.
            shutil.rmtree(run.work_dir, ignore_errors=True)
            with self._lock:
                if self._run is run:
                    self._run = None
            record = self.progress_tracker.ledger.get(run.progress_id) if self.progress_tracker.ledger else None
            if not self.progress_tracker.ledger or (record and record['attempt'] == run.attempt):
                self.progress_tracker.complete_progress(
                    run.progress_id,
                    "cancelled" if run.cancelled else "done",
                    succeeded=run.saved,
                    failed=run.failed,
                )

    def cancel(self, progress_id: str) -> bool:
        with self._lock:
            run = self._run
            if run is None or run.progress_id != progress_id:
                return False
            run.cancelled = True
            proc = run.process
        try:
            _signal_process_tree(proc, force=False)
        except (ProcessLookupError, PermissionError):
            return True

        def _kill_later() -> None:
            time.sleep(5)
            if proc.poll() is None:
                try:
                    _signal_process_tree(proc, force=True)
                except (ProcessLookupError, PermissionError):
                    pass

        threading.Thread(target=_kill_later, daemon=True).start()
        return True

    @property
    def current_run_id(self) -> str | None:
        with self._lock:
            return self._run.progress_id if self._run else None
