"""The engine driver: status hints, a batch pumped through the protocol, cancel.

The engine itself is replaced by a small Python script that speaks
``protocol.py`` — the driver never knows the difference, which is the point:
what is tested is the contract, not MLX.
"""
from __future__ import annotations

import logging
import stat
import sys
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.infra.progress import ProgressTracker
from app.domains.lyrics.engine import INSTALL_PROGRESS_ID, EngineBusyError, EngineJob, EngineNotReadyError, LyricsEngine

pytestmark = pytest.mark.unit
LOG = logging.getLogger("test.lyrics.engine")


def _fake_engine(tools_dir: Path, body: str) -> Path:
    """Install a fake ``krobi-helper`` under ``tools_dir/helper/venv/bin``."""
    bin_dir = tools_dir / "helper" / "venv" / "bin"
    bin_dir.mkdir(parents=True)
    managed = tools_dir / "managed" / "cpython-3.12-macos-aarch64-none" / "bin"
    managed.mkdir(parents=True)
    (managed / "python3.12").touch()
    (bin_dir / "python").symlink_to(managed / "python3.12")
    (bin_dir.parent / "pyvenv.cfg").write_text(f"home = {managed}\nimplementation = CPython\nuv = 0.10.12\n")
    script = bin_dir / "krobi-helper"
    script.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body), encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script


CHECK_READY = '''
import json, sys
if sys.argv[1] == "check":
    print(json.dumps({"version": "0.1.0", "python": "3.12", "platform": "darwin-arm64", "supported": True,
                      "packages": {"mlx_whisper": True}, "models": {"whisper": True}, "ready": True}))
    sys.exit(0)
'''

RUN_TWO = CHECK_READY + '''
import json, os, sys, time
jobs = json.load(open(sys.argv[sys.argv.index("--jobs") + 1]))
out = sys.argv[sys.argv.index("--out-dir") + 1]
for job in jobs:
    print(json.dumps({"event": "phase", "job": job["id"], "phase": "separando"}), flush=True)
    if "fail" in job["audio"]:
        print(json.dumps({"event": "failed", "job": job["id"], "error": "instrumental"}), flush=True)
        continue
    d = os.path.join(out, job["id"]); os.makedirs(d, exist_ok=True)
    lrc = os.path.join(d, "lyrics.lrc")
    open(lrc, "w").write("[00:01.00] hola\\n[00:05.00] mundo\\n")
    src = "aligned:mms-fa" if job.get("text") else "stt:whisper-large-v3-turbo"
    print(json.dumps({"event": "done", "job": job["id"], "lrc": lrc, "source": src, "kind": "synced"}), flush=True)
'''

RUN_SLOW = CHECK_READY + '''
import json, sys, time, signal
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
jobs = json.load(open(sys.argv[sys.argv.index("--jobs") + 1]))
print(json.dumps({"event": "phase", "job": jobs[0]["id"], "phase": "transcribiendo"}), flush=True)
time.sleep(30)
'''


@pytest.fixture
def harness(tmp_path, monkeypatch):
    monkeypatch.setattr("app.domains.lyrics.engine.platform.system", lambda: "Darwin")
    monkeypatch.setattr("app.domains.lyrics.engine.platform.machine", lambda: "arm64")
    config = SimpleNamespace(tools_dir=tmp_path / "tools", models_dir=tmp_path / "models", temp_dir=tmp_path / "temp")
    config.temp_dir.mkdir()
    results, failures = [], []
    engine = LyricsEngine(
        config=config,
        progress_tracker=ProgressTracker(),
        logger=LOG,
        on_result=lambda job, event: results.append((job.rel_path, event["source"], open(event["lrc"]).read())),
        on_failure=lambda job, reason: failures.append((job.rel_path, reason)),
    )
    return SimpleNamespace(engine=engine, config=config, results=results, failures=failures, tmp=tmp_path)


def _wait(pred, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


class TestStatus:
    def test_sizes_exclude_analysis_packages_from_shared_engine(self, harness, monkeypatch):
        _fake_engine(harness.config.tools_dir, CHECK_READY)
        addons = {"analysis": {"installed": True, "ready": True, "sizeBytes": 80, "runtimeBytes": 70},
                  "lyrics": {"installed": True, "ready": True, "sizeBytes": 1200, "sharedBytes": 200}}
        monkeypatch.setattr(harness.engine, "check", lambda: {"ready": True, "addons": addons})
        monkeypatch.setattr(harness.engine, "_runtime_size", lambda: 1370)
        status = harness.engine.status()
        assert status["sizeBytes"] == 1300
        assert status["addons"]["analysis"]["sizeBytes"] == 80
        assert status["addons"]["lyrics"]["sharedBytes"] == 200

    def test_not_installed_says_so_with_a_hint(self, harness):
        status = harness.engine.status()
        assert status["installed"] is False and status["ready"] is False
        assert status["hint"] in ("not-installed", "no-uv")

    @pytest.mark.parametrize("created_by_uv", [False, True])
    def test_homebrew_framework_python_is_broken_even_if_check_would_say_ready(self, harness, created_by_uv):
        _fake_engine(harness.config.tools_dir, CHECK_READY)
        engine = harness.engine
        assert engine.check()["ready"]  # The provenance guard must also precede the cache.
        home = harness.tmp / "Python.framework" / "Versions" / "3.12" / "Resources" / "Python.app" / "Contents" / "MacOS"
        home.mkdir(parents=True)
        (home / "Python").touch()
        python = engine.venv_dir / "bin" / "python"
        python.unlink()
        python.symlink_to(home / "Python")
        (engine.venv_dir / "pyvenv.cfg").write_text(
            f"home = {home}\nimplementation = CPython\n" + ("uv = 0.10.12\n" if created_by_uv else "")
        )
        assert engine.check() == {"ready": False, "error": "unmanaged-python"}
        status = engine.status()
        assert status["installed"] and not status["ready"]
        assert status["hint"] == "broken" and status["checkError"] == "unmanaged-python"

    def test_ready_when_the_check_says_ready(self, harness):
        _fake_engine(harness.config.tools_dir, CHECK_READY)
        status = harness.engine.status()
        assert status["installed"] and status["ready"] and status["hint"] == "ready"
        assert status["version"] == "0.1.0" and status["models"] == {"whisper": True}

    def test_unsupported_platform_wins_over_everything(self, harness, monkeypatch):
        monkeypatch.setattr("app.domains.lyrics.engine.platform.machine", lambda: "x86_64")
        assert harness.engine.status()["hint"] == "unsupported-platform"
        with pytest.raises(EngineNotReadyError):
            harness.engine.install()

    def test_running_without_the_engine_is_refused(self, harness):
        with pytest.raises(EngineNotReadyError):
            harness.engine.run([EngineJob("A/b.mp3", harness.tmp / "b.mp3", "b")])


class TestRun:
    def test_a_batch_is_pumped_into_results_and_failures(self, harness):
        _fake_engine(harness.config.tools_dir, RUN_TWO)
        jobs = [
            EngineJob("A/ok.mp3", harness.tmp / "ok.mp3", "Artist – Ok", text="hola\nmundo"),
            EngineJob("A/fail.mp3", harness.tmp / "fail.mp3", "Artist – Fail"),
            EngineJob("A/stt.mp3", harness.tmp / "stt.mp3", "Artist – Stt"),
        ]
        progress_id = harness.engine.run(jobs)
        tracker = harness.engine.progress_tracker
        assert _wait(lambda: tracker.get_progress(progress_id).is_terminal)
        state = tracker.get_progress(progress_id)
        assert state.succeeded == 2 and state.failed == 1 and state.completed == 3
        assert sorted(r[0] for r in harness.results) == ["A/ok.mp3", "A/stt.mp3"]
        by_path = {r[0]: r for r in harness.results}
        assert by_path["A/ok.mp3"][1] == "aligned:mms-fa"
        assert by_path["A/stt.mp3"][1] == "stt:whisper-large-v3-turbo"
        assert by_path["A/ok.mp3"][2].startswith("[00:01.00] hola")
        assert harness.failures == [("A/fail.mp3", "instrumental")]
        assert harness.engine.current_run_id is None
        # The staging dir is gone with the run.
        assert not list(harness.config.temp_dir.glob("lyrics-engine-*"))

    def test_a_second_batch_while_one_runs_is_busy_and_cancel_kills_it(self, harness):
        _fake_engine(harness.config.tools_dir, RUN_SLOW)
        job = EngineJob("A/slow.mp3", harness.tmp / "slow.mp3", "Slow")
        progress_id = harness.engine.run([job])
        tracker = harness.engine.progress_tracker
        assert _wait(lambda: tracker.get_progress(progress_id).active.get("Slow", {}).get("phase") == "transcribiendo")
        with pytest.raises(EngineBusyError):
            harness.engine.run([job])
        assert harness.engine.cancel(progress_id) is True
        assert _wait(lambda: tracker.get_progress(progress_id).is_terminal, timeout=15)
        state = tracker.get_progress(progress_id)
        assert state.status == "cancelled" and state.failed == 1
        assert harness.failures == [("A/slow.mp3", "cancelado")]
        assert harness.engine.cancel(progress_id) is False

    def test_a_result_the_saver_rejects_counts_as_failed(self, harness):
        _fake_engine(harness.config.tools_dir, RUN_TWO)

        def boom(job, event):
            raise RuntimeError("edited by hand")

        harness.engine.on_result = boom
        progress_id = harness.engine.run([EngineJob("A/ok.mp3", harness.tmp / "ok.mp3", "Ok")])
        tracker = harness.engine.progress_tracker
        assert _wait(lambda: tracker.get_progress(progress_id).is_terminal)
        assert tracker.get_progress(progress_id).failed == 1
        assert harness.failures == [("A/ok.mp3", "edited by hand")]


class TestInstall:
    @pytest.mark.parametrize("on_path", [True, False])
    def test_windows_finds_uv_exe(self, harness, monkeypatch, on_path):
        monkeypatch.setattr("app.domains.lyrics.engine.platform.system", lambda: "Windows")
        bin_dir = harness.tmp / "bin"
        bin_dir.mkdir()
        uv = bin_dir / "uv.exe"
        uv.touch()
        uv.chmod(0o755)
        monkeypatch.setenv("PATH", str(bin_dir) if on_path else "")
        monkeypatch.setattr("app.domains.lyrics.engine.UV_CANDIDATES", () if on_path else (str(bin_dir / "uv"),))
        assert harness.engine._uv() == str(uv)

    def test_no_uv_refuses_before_starting_an_install_even_with_python3(self, harness, monkeypatch):
        engine = harness.engine
        monkeypatch.setattr(engine, "_uv", lambda: None)
        monkeypatch.setattr("app.domains.lyrics.engine.shutil.which", lambda name: "/fake/python3")
        with pytest.raises(EngineNotReadyError, match="Falta uv"):
            engine.install()
        assert engine._installing is None
        assert engine.progress_tracker.get_progress(INSTALL_PROGRESS_ID) is None
        assert not engine.tools_dir.exists()
        assert engine.status()["hint"] == "no-uv"

    def test_uv_disappearing_before_the_worker_starts_never_falls_back(self, harness, monkeypatch):
        engine = harness.engine
        monkeypatch.setattr(engine, "_uv", lambda: None)
        engine._install_worker([harness.tmp])
        assert not engine.tools_dir.exists()
        assert "Falta uv" in engine.status()["installError"]

    def test_install_runs_venv_deps_and_prefetch_in_order(self, harness, monkeypatch, tmp_path):
        source = tmp_path / "worker"
        source.mkdir()
        (source / "pyproject.toml").write_text("[project]\nname='x'\n")
        monkeypatch.setenv("KROBI_LYRICS_WORKER_SRC", str(source))
        calls = []

        def fake_sh(argv, env, timeout=600):
            calls.append(argv)
            if "venv" in argv:
                _fake_engine(harness.config.tools_dir, CHECK_READY + '''
if sys.argv[1] == "prefetch":
    for name, pct in (("whisper", 33), ("aligner", 66), ("demucs", 100)):
        print(json.dumps({"event": "prefetch", "model": name, "percent": pct}), flush=True)
    print(json.dumps({"event": "done", "job": "prefetch"}), flush=True)
''')

        monkeypatch.setattr(harness.engine, "_sh", fake_sh)
        monkeypatch.setattr(harness.engine, "_uv", lambda: "/fake/uv")
        progress_id = harness.engine.install()
        assert progress_id == INSTALL_PROGRESS_ID
        tracker = harness.engine.progress_tracker
        assert _wait(lambda: tracker.get_progress(progress_id).is_terminal, timeout=20)
        state = tracker.get_progress(progress_id)
        assert state.status == "done", harness.engine.status()["installError"]
        assert calls[0] == ["/fake/uv", "venv", "--python", "3.12", "--python-preference", "only-managed",
                            "--allow-existing", str(harness.engine.venv_dir)]
        assert calls[1] == ["/fake/uv", "pip", "install", "--python",
                            str(harness.engine.venv_dir / "bin" / "python"), "--torch-backend", "cpu", f"{source}[engine]"]
        assert harness.engine.status()["hint"] == "ready"

    def test_install_failure_is_reported_as_a_hint_not_a_traceback(self, harness, monkeypatch, tmp_path):
        source = tmp_path / "worker"
        source.mkdir()
        (source / "pyproject.toml").write_text("[project]\nname='x'\n")
        monkeypatch.setenv("KROBI_LYRICS_WORKER_SRC", str(source))

        def fail(argv, env, timeout=600):
            raise RuntimeError("uv falló: no network")

        monkeypatch.setattr(harness.engine, "_sh", fail)
        monkeypatch.setattr(harness.engine, "_uv", lambda: "/fake/uv")
        progress_id = harness.engine.install()
        tracker = harness.engine.progress_tracker
        assert _wait(lambda: tracker.get_progress(progress_id).is_terminal, timeout=10)
        status = harness.engine.status()
        assert status["hint"] == "install-failed" and "no network" in status["installError"]


def test_bundled_worker_installs_base_and_optional_wheels(tmp_path, monkeypatch, harness):
    monkeypatch.delenv("KROBI_LYRICS_WORKER_SRC", raising=False)
    monkeypatch.delenv("KROBI_LYRICS_PLUGIN_SOURCES", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "backend"))
    bundled = tmp_path / "helper-worker"
    bundled.mkdir()
    names = ["krobi_helper-0.5.0-py3-none-any.whl", "krobi_helper-0.6.0-py3-none-any.whl",
             "example_worker-0.1.0-py3-none-any.whl"]
    for name in names:
        (bundled / name).touch()
    engine = harness.engine
    assert [p.name for p in engine.worker_sources()] == [names[1], names[2]]


def test_explicit_plugin_sources_install_with_development_worker(tmp_path, monkeypatch, harness):
    source = tmp_path / "worker"
    source.mkdir()
    plugin = tmp_path / "optional worker"
    plugin.mkdir()
    monkeypatch.setenv("KROBI_LYRICS_WORKER_SRC", str(source))
    monkeypatch.setenv("KROBI_LYRICS_PLUGIN_SOURCES", str(plugin))
    engine = harness.engine
    assert engine.worker_sources() == [source, plugin]


@pytest.mark.parametrize(('system', 'machine', 'expected'), [
    ('Darwin', 'arm64', True), ('Darwin', 'x86_64', False),
    ('Linux', 'x86_64', True), ('Linux', 'arm64', True), ('Linux', 'aarch64', True),
    ('Windows', 'AMD64', True), ('Windows', 'x86_64', True),
    ('Linux', 'i686', False), ('Windows', 'ARM64', False), ('FreeBSD', 'x86_64', False),
])
def test_supported_platforms(harness, monkeypatch, system, machine, expected):
    monkeypatch.setattr('app.domains.lyrics.engine.platform.system', lambda: system)
    monkeypatch.setattr('app.domains.lyrics.engine.platform.machine', lambda: machine)
    assert harness.engine.supported is expected


def test_cpu_check_is_forced_and_cache_does_not_leak_auto_capabilities(harness, monkeypatch):
    _fake_engine(harness.config.tools_dir, CHECK_READY)
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(stdout='{"jobs":["stems"],"accel":"cpu"}' if "--accel" in argv
                               else '{"jobs":["align","transcribe"],"accel":"cuda"}')

    monkeypatch.setattr("app.domains.lyrics.engine.subprocess.run", run)
    assert harness.engine.check()["accel"] == "cuda"
    assert harness.engine.check(accel="cpu")["jobs"] == ["stems"]
    assert calls[-1][-2:] == ["--accel", "cpu"]
    assert harness.engine.check(accel="cpu")["accel"] == "cpu"
    assert len(calls) == 2
    assert harness.engine.check()["accel"] == "cuda"
    assert len(calls) == 2


@pytest.mark.parametrize(('system', 'machine', 'backend'), [
    ('Darwin', 'arm64', ['--torch-backend', 'cpu']), ('Linux', 'aarch64', ['--torch-backend', 'cpu']),
    ('Linux', 'x86_64', ['--torch-backend', 'cpu']), ('Windows', 'AMD64', ['--torch-backend', 'cpu']),
])
def test_installer_selects_available_torch_wheels(harness, monkeypatch, system, machine, backend):
    engine = harness.engine
    monkeypatch.setattr('app.domains.lyrics.engine.platform.system', lambda: system)
    monkeypatch.setattr('app.domains.lyrics.engine.platform.machine', lambda: machine)
    monkeypatch.setattr(engine, '_uv', lambda: '/fake/uv')
    calls = []
    monkeypatch.setattr(engine, '_sh', lambda argv, *a, **kw: calls.append(argv))
    monkeypatch.setattr(engine, '_prefetch', lambda _: None)
    engine.progress_tracker.create_progress(INSTALL_PROGRESS_ID, 3)
    engine._install_worker([harness.tmp])
    assert calls[1] == ['/fake/uv', 'pip', 'install', '--python', str(engine.python), *backend, f"{harness.tmp}[engine]"]


def test_status_exposes_accel_and_capabilities(harness):
    _fake_engine(harness.config.tools_dir, CHECK_READY.replace(
        '"version": "0.1.0"',
        '"version": "0.8.0", "accel": "cpu", "os": "linux", "gpu": None, "chip": "CPU", '
        '"memoryBytes": 17179869184, "jobs": ["align", "transcribe", "stems"]'))
    status = harness.engine.status()
    assert status['accel'] == 'cpu' and status['gpu'] is None
    assert status['jobs'] == ['align', 'transcribe', 'stems']


def test_windows_cancel_terminates_the_process_tree(monkeypatch):
    from app.infra import engine_process as module

    monkeypatch.setattr(module, "os", SimpleNamespace(name="nt"))
    run = Mock()
    monkeypatch.setattr(module.subprocess, "run", run)
    module._signal_process_tree(SimpleNamespace(pid=1234), force=False)
    run.assert_called_once_with(["taskkill", "/PID", "1234", "/T", "/F"], capture_output=True, check=False)


def test_legacy_venv_migrates_once_without_touching_models(harness, monkeypatch):
    engine = harness.engine
    old_binary = _fake_engine(harness.config.tools_dir, CHECK_READY)
    old_binary.rename(old_binary.with_name("krobi-lyrics"))
    legacy = harness.config.tools_dir / "lyrics"
    (harness.config.tools_dir / "helper").rename(legacy)
    (legacy / "agent.lock").write_text("12345")
    (legacy / "worker-id").write_text("same-helper")
    harness.config.models_dir.mkdir()
    model = harness.config.models_dir / "cached-model"
    model.write_bytes(b"existing model")
    before = model.stat()
    calls = []
    monkeypatch.setattr(engine, "_prefetch", lambda _: pytest.fail("migration must not prefetch"))
    monkeypatch.setattr(engine, "_sh", lambda *a, **kw: calls.append(a))

    assert engine.tools_dir == harness.config.tools_dir / "helper"
    assert engine.venv_dir.samefile(legacy / "venv")
    assert engine.binary.name == "krobi-lyrics"  # usable before the package upgrade
    assert engine.status()["ready"]
    assert (engine.tools_dir / "agent.lock").samefile(legacy / "agent.lock")
    assert (engine.tools_dir / "worker-id").read_text() == "same-helper"
    # Simulate the package installer replacing its entry point in the same venv.
    current = engine.binary.with_name("krobi-helper")
    current.write_bytes(engine.binary.read_bytes())
    current.chmod(0o755)
    assert engine.binary == current
    assert engine.status()["ready"]
    assert engine.tools_dir.samefile(legacy)
    assert model.read_bytes() == b"existing model"
    assert model.stat().st_mtime_ns == before.st_mtime_ns
    assert not calls


def test_helper_source_override_takes_precedence_and_old_name_still_works(harness, tmp_path, monkeypatch):
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir()
    new.mkdir()
    monkeypatch.setenv("KROBI_LYRICS_WORKER_SRC", str(old))
    monkeypatch.setenv("KROBI_HELPER_SRC", str(new))
    assert harness.engine.worker_sources() == [new]
    monkeypatch.delenv("KROBI_HELPER_SRC")
    assert harness.engine.worker_sources() == [old]


def test_legacy_plugin_wheels_remain_discoverable_without_old_engine(tmp_path, monkeypatch, harness):
    monkeypatch.delenv("KROBI_HELPER_SRC", raising=False)
    monkeypatch.delenv("KROBI_LYRICS_WORKER_SRC", raising=False)
    monkeypatch.delenv("KROBI_LYRICS_PLUGIN_SOURCES", raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "backend"))
    current, legacy = tmp_path / "helper-worker", tmp_path / "lyrics-worker"
    current.mkdir()
    legacy.mkdir()
    base = current / "krobi_helper-0.11.0-py3-none-any.whl"
    compat = current / "krobi_lyrics-0.11.0-py3-none-any.whl"
    plugin = legacy / "krobi_lineage_worker-0.1.0-py3-none-any.whl"
    for wheel in [base, compat, plugin, legacy / "krobi_lyrics-0.10.0-py3-none-any.whl"]:
        wheel.touch()
    assert harness.engine.worker_sources() == [base, compat, plugin]


def test_development_source_includes_compatibility_distribution(harness, monkeypatch):
    monkeypatch.delenv("KROBI_HELPER_SRC", raising=False)
    monkeypatch.delenv("KROBI_LYRICS_WORKER_SRC", raising=False)
    monkeypatch.delenv("KROBI_LYRICS_PLUGIN_SOURCES", raising=False)
    sources = harness.engine.worker_sources()
    assert sources[0].name == "helper"
    assert sources[1] == sources[0] / "compat"


class TestAddonInstallation:
    def test_engine_install_never_prefetches_models(self, harness, monkeypatch):
        monkeypatch.setattr(harness.engine, '_uv', lambda: '/fake/uv')
        monkeypatch.setattr(harness.engine, '_sh', lambda *args, **kw: None)
        monkeypatch.setattr(harness.engine, '_prefetch', lambda *args: pytest.fail('Runtime must not fetch models'))
        harness.engine.install()
        assert _wait(lambda: not harness.engine._installing.is_alive())
        assert harness.engine._install_error is None

    def test_addon_install_requires_ready_engine(self, harness, monkeypatch):
        monkeypatch.setattr(harness.engine, 'check', lambda **kw: None)
        with pytest.raises(EngineNotReadyError, match='Install the engine first'):
            harness.engine.install('lyrics')

    @pytest.mark.parametrize('target', ['lyrics', 'stems'])
    def test_addon_install_fetches_only_requested_models(self, harness, monkeypatch, target):
        monkeypatch.setattr(harness.engine, 'check', lambda **kw: {'engineReady': True})
        monkeypatch.setattr(harness.engine, '_uv', lambda: '/fake/uv')
        monkeypatch.setattr(harness.engine, '_sh', lambda *args, **kw: pytest.fail('Do not reinstall the engine'))
        calls = []
        monkeypatch.setattr(harness.engine, '_prefetch', lambda env: calls.append(harness.engine._install_target))
        harness.engine.install(target)
        assert _wait(lambda: not harness.engine._installing.is_alive())
        assert calls == [target]
        assert not harness.engine._addon_errors

    def test_engine_removal_requires_addons_removed(self, harness, monkeypatch):
        monkeypatch.setattr(harness.engine, 'check', lambda **kw: {'addons': {'lyrics': {'installed': True}}})
        with pytest.raises(EngineNotReadyError, match='Remove all add-ons first'):
            harness.engine.remove()


def test_analysis_install_alone_uses_only_analysis_extra(harness, monkeypatch):
    engine = harness.engine
    monkeypatch.setattr(engine, "check", lambda **kw: {})
    monkeypatch.setattr(engine, "_uv", lambda: "/fake/uv")
    calls, prefetch = [], []
    monkeypatch.setattr(engine, "_sh", lambda argv, *a, **kw: calls.append(argv))
    monkeypatch.setattr(engine, "_prefetch", lambda env: prefetch.append(engine._install_target))
    engine.install("analysis")
    assert _wait(lambda: not engine._installing.is_alive())
    assert engine._install_error is None
    packages = calls[1]
    assert any("[analysis]" in argument for argument in packages)
    assert "[engine" not in " ".join(packages)
    assert prefetch == ["analysis"]


def test_install_union_preserves_existing_engine_and_analysis(harness, monkeypatch):
    engine = harness.engine
    monkeypatch.setattr(engine, "check", lambda **kw: {"engineReady": True, "addons": {"analysis": {"installed": True}}})
    requirements = engine._package_requirements([harness.tmp, harness.tmp / "plugin.whl"], "analysis")
    assert requirements[0] == f"{harness.tmp}[engine,analysis]"
    assert str(harness.tmp / "plugin.whl") in requirements


def test_installer_preserves_adopted_gpu_selection(harness, monkeypatch):
    monkeypatch.setattr('app.domains.lyrics.engine.platform.system', lambda: 'Linux')
    engine = harness.engine
    monkeypatch.setattr(engine, '_uv', lambda: '/fake/uv')
    monkeypatch.setattr(engine, 'check', lambda **kw: {'engineReady': True, 'addons': {'gpu': {'installed': True}}})
    calls = []
    monkeypatch.setattr(engine, '_sh', lambda argv, *a, **kw: calls.append(argv))
    engine.progress_tracker.create_progress(INSTALL_PROGRESS_ID, 3)
    engine._install_worker([harness.tmp])
    command = next(c for c in calls if 'pip' in c)
    assert command[command.index('--torch-backend') + 1] == 'cu130'


@pytest.mark.parametrize('remove', [False, True])
def test_gpu_target_uses_shared_swap_command(harness, monkeypatch, remove):
    engine = harness.engine
    monkeypatch.setattr(engine, '_uv', lambda: '/fake/uv')
    calls = []
    monkeypatch.setattr(engine, '_sh', lambda argv, *a, **kw: calls.append(argv))
    engine._change_gpu(remove=remove)
    assert calls == [[str(engine.binary), 'gpu', '--uv', '/fake/uv', *(['--remove'] if remove else [])]]


def test_gpu_removal_returns_immediately_and_holds_install_lane(harness, monkeypatch):
    import threading
    _fake_engine(harness.config.tools_dir, CHECK_READY)
    engine = harness.engine
    entered, release = threading.Event(), threading.Event()
    calls = []
    def swap(*, remove=False):
        calls.append(remove)
        entered.set()
        assert release.wait(5)
    monkeypatch.setattr(engine, '_change_gpu', swap)
    try:
        engine.remove('gpu')
        assert entered.wait(2)
        assert engine.status()['installing']['target'] == 'gpu'
        with pytest.raises(EngineNotReadyError, match='Another installation'):
            engine.install('analysis')
    finally:
        release.set()
        if engine._installing:
            engine._installing.join(5)
    assert calls == [True]
    assert engine.status()['installing'] is None


def test_included_mlx_does_not_prevent_removing_empty_engine(harness, monkeypatch):
    _fake_engine(harness.config.tools_dir, CHECK_READY)
    monkeypatch.setattr(harness.engine, 'check', lambda **kw: {'engineReady': True, 'addons': {
        'gpu': {'installed': True, 'included': True}, 'lyrics': {'installed': False}, 'stems': {'installed': False}}})
    harness.engine.remove('engine')
    assert not harness.engine.venv_dir.exists()
