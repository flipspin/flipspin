"""A6 / contract check 8. Clock, cgroups and engine are all controlled fakes."""
import json
import logging
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest

from app.config import settings_from_env
from app.domains.helpers import helper_ranking as ranking
from app.domains.helpers.mac_worker import AGENT_ONLINE_S, WorkerRecord
from app.domains.helpers.nest_helper import NEST_ID, NestHelper
from app.infra.progress import ProgressTracker
from app.domains.lyrics.jobs import AgentQueue
from app.domains.stems.repositories import StemsRepository
from app.domains.stems.services import StemsService

REAL = {"id": "real", "name": "Other CPU", "version": "0.10.0", "os": "linux", "accel": "cpu",
        "memoryBytes": 16 << 30, "jobs": ["align", "transcribe", "stems"]}
LOG = logging.getLogger(__name__)


@pytest.fixture
def nest(config, tmp_path, monkeypatch):
    config.lyrics_file = tmp_path / "lyrics.json"
    config.stems_dir = tmp_path / "stems"
    config.instance_file = tmp_path / "instance.json"
    config.instance_file.write_text('{"version": 1, "instanceId": "synthetic-nest", "name": "Mi nido"}')
    clock = [1000.0]
    q = AgentQueue(path=tmp_path / "lyrics-queue.json", progress_tracker=ProgressTracker(), logger=LOG,
                   on_result=Mock(), on_failure=Mock(), now=lambda: clock[0])
    engine = SimpleNamespace(installed=True, check=Mock(return_value={"version": "0.10.0", "ready": True,
        "jobs": ["align", "transcribe", "stems"]}), binary=Path("/fake/krobi-helper"),
        python=Path(sys.executable), _engine_env=lambda: {})
    lyrics = SimpleNamespace(agent_queue=q, engine=engine, engine_mode="agent",
        repository=SimpleNamespace(audio_path=lambda rel: config.base_music_dir / rel), _vocals_for=lambda rel: None)
    stems = StemsService(repository=StemsRepository(config, LOG), config=config, logger=LOG, worker=q.worker, ledger=q.ledger)
    stems.queue.now = lambda: clock[0]
    stems.queue.duration = lambda album, file: None
    scope = Mock()
    helper = NestHelper(config, lambda: lyrics, lambda: stems, probe=Mock(return_value=scope),
                        read_temperature=lambda: None)
    monkeypatch.setattr("app.domains.helpers.nest_helper.machine_facts", lambda: {"memoryBytes": 16 << 30})
    return SimpleNamespace(helper=helper, config=config, q=q, worker=q.worker, clock=clock,
                           engine=engine, stems=stems, scope=scope, lyrics=lyrics)


def enqueue(nest, kind, number=1):
    for i in range(number):
        audio = nest.config.base_music_dir / "Album" / f"song{i}.mp3"
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b"test audio")
        if kind == "stems":
            nest.stems.queue.request("Album", f"song{i}.mp3")
        else:
            nest.q.enqueue([{"relPath": f"Album/song{i}.mp3", "text": "words" if kind == "align" else None}])


def finish(nest, claimed):
    kind, lease, job, _ = claimed
    if kind == "lyrics":
        assert nest.q.result(lease, job["id"], ok=True, lrc="[00:01] test")["accepted"]
    else:
        nest.stems.queue.complete(lease)


@pytest.mark.parametrize("kind", ["align", "transcribe", "stems"])
def test_contract_8_default_off_real_online_fallback_serial_and_return(nest, kind, caplog):
    caplog.set_level(logging.INFO)
    enqueue(nest, kind, 2)
    assert nest.config.nest_processes is False
    assert nest.helper.claim() is None
    assert nest.worker.helpers() == []
    assert nest.worker.wait_reason(kind) == "no-helper"
    nest.config.nest_processes = True
    nest.worker.seen(REAL)
    assert nest.helper.claim() is None
    for _ in range(12):
        nest.clock[0] += 60
        nest.worker.seen(REAL)
        assert nest.helper.claim() is None  # Even after SLOW_DELAY_S and 600s.
    nest.worker.bye("real", "sleep")
    nest.clock[0] += ranking.NEST_FALLBACK_AFTER_S - 0.01
    assert nest.helper.claim() is None
    nest.clock[0] += 0.01
    claimed = nest.helper.claim()
    assert claimed
    assert nest.helper.claim() is None
    assert nest.q.claim(nest.helper._agent())["jobs"] == []
    assert nest.stems.queue.claim(nest.helper._agent()) is None
    row = next(h for h in nest.worker.helpers() if h["nest"])
    assert row["name"] == "Mi nido" and row["accel"] == "cpu" and row["os"] == "linux"
    assert row["jobs"] == nest.engine.check.return_value["jobs"]
    assert json.loads(nest.worker.path.read_text())["helpers"][NEST_ID]["nest"] is True
    # A return never cancels the current nest lease, including its next beat.
    nest.worker.seen(REAL)
    assert nest.helper._heartbeat(*claimed)
    finish(nest, claimed)
    assert nest.helper.claim() is None
    assert "started claiming" in caplog.text and "stopped claiming" in caplog.text


def test_offline_timeout_counts_from_end_of_online_window_and_checks_real_busy(nest):
    enqueue(nest, "align")
    nest.config.nest_processes = True
    nest.worker.seen(REAL)
    nest.worker.working("busy", "real", "Other work", "working", ttl=5000)
    assert nest.helper.claim() is None
    nest.clock[0] += ranking.NEST_FALLBACK_AFTER_S
    assert nest.helper.claim() is None  # Only 510 seconds offline.
    nest.clock[0] += AGENT_ONLINE_S
    assert nest.helper.claim()


def test_no_other_helper_waits_a_full_delay_and_ignores_ineligible_helpers(nest):
    enqueue(nest, "stems")
    nest.config.nest_processes = True
    nest.worker.seen(REAL | {"jobs": ["align"]})
    assert nest.helper.claim() is None
    nest.clock[0] += ranking.NEST_FALLBACK_AFTER_S
    nest.worker.seen(REAL | {"jobs": ["align"]})
    assert nest.helper.claim()


def test_dropped_capability_starts_a_new_absence_window(nest):
    enqueue(nest, "stems")
    nest.config.nest_processes = True
    nest.helper.claim()
    nest.clock[0] += 600
    nest.worker.seen(REAL)
    assert nest.helper.claim() is None
    nest.clock[0] += 10
    nest.worker.seen(REAL | {"jobs": ["align"]})
    nest.clock[0] += 599
    assert nest.helper.claim() is None
    nest.clock[0] += 1
    assert nest.helper.claim()


def test_one_job_across_lyrics_and_stems_round_robins(nest):
    enqueue(nest, "align", 2)
    enqueue(nest, "stems")
    nest.config.nest_processes = True
    nest.helper.claim()
    nest.clock[0] += 600
    first = nest.helper.claim()
    assert first[0] == "lyrics"
    assert nest.helper.claim() is None
    finish(nest, first)
    second = nest.helper.claim()
    assert second[0] == "stems"
    finish(nest, second)
    assert nest.helper.claim()[0] == "lyrics"


@pytest.mark.parametrize("kind", ["align", "stems"])
def test_toggle_off_requeues_at_next_heartbeat_and_leaves_wait_reason_alone(nest, kind):
    enqueue(nest, kind)
    nest.config.nest_processes = True
    nest.helper.claim()
    nest.clock[0] += 600
    claimed = nest.helper.claim()
    nest.config.nest_processes = False
    assert nest.helper._heartbeat(*claimed) is False
    assert nest.worker.helpers() == []
    assert nest.worker.wait_reason(kind) == "no-helper"
    assert (nest.q.status()["queued"] if kind == "align" else nest.stems.queue.has_queued())
    assert nest.helper.claim() is None


@pytest.mark.parametrize("reason,message", [("no-engine", "Falta el motor del nido"),
                                           ("no-cgroup", "Este nido no puede limitar el proceso")])
def test_disabled_reasons_refuse_registration_and_claim(nest, reason, message):
    nest.config.nest_processes = True
    enqueue(nest, "align")
    if reason == "no-engine":
        nest.engine.installed = False
    else:
        nest.helper.probe.return_value = None
    assert nest.helper.availability() == {"disabledReason": reason, "disabledMessage": message}
    assert nest.helper.claim() is None
    assert nest.worker.helpers() == []
    if reason == "no-engine":
        nest.helper.probe.assert_not_called()


def test_jobs_are_only_what_cpu_check_reports_and_nest_is_always_last(nest):
    nest.config.nest_processes = True
    nest.engine.check.return_value["jobs"] = ["stems"]
    nest.helper.claim()
    nest.engine.check.assert_called_with(accel="cpu")
    view = nest.worker.helpers()[0]
    assert view["jobs"] == ["stems"]
    view["speed"] = {"stems": {"samples": 100, "medianSecondsPerMinute": 0.1}}
    real = REAL | {"speed": {"stems": {"samples": 100, "medianSecondsPerMinute": 1000}}}
    assert ranking.faster(real, view, "stems")
    assert not ranking.faster(view, real, "stems")


def test_stale_persistent_nest_is_invisible_on_restart(nest):
    nest.config.nest_processes = True
    nest.helper.claim()
    restarted = WorkerRecord(path=nest.worker.path, now=lambda: nest.clock[0])
    assert restarted.helpers() == [] and restarted.wait_reason() == "no-helper"


def test_setting_environment_defaults_and_opt_in(monkeypatch):
    monkeypatch.delenv("KROBI_NEST_PROCESSES", raising=False)
    monkeypatch.delenv('KROBI_NEST_LIBRARY_START_HOUR', raising=False)
    monkeypatch.delenv('KROBI_NEST_LIBRARY_END_HOUR', raising=False)
    defaults = settings_from_env()
    assert 'nest_library_start_hour' not in defaults and 'nest_library_end_hour' not in defaults
    assert settings_from_env()["nest_processes"] is False
    monkeypatch.setenv("KROBI_NEST_PROCESSES", "true")
    assert settings_from_env()["nest_processes"] is True


@pytest.mark.parametrize("kind", ["align", "stems"])
def test_silent_fake_child_is_killed_and_lease_requeued_within_heartbeat(nest, monkeypatch, kind):
    # This child only sleeps. No installed engine, models, cgroup or network.
    monkeypatch.setattr("app.domains.helpers.nest_helper.HEARTBEAT_S", 0.05)
    nest.config.nest_processes = True
    enqueue(nest, kind)
    nest.helper.claim()
    nest.clock[0] += 600
    claimed = nest.helper.claim()
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                            stdout=subprocess.PIPE, text=True, start_new_session=True)
    nest.helper._scope = nest.scope
    timer = threading.Timer(0.02, lambda: setattr(nest.config, "nest_processes", False))
    timer.start()
    start = time.monotonic()
    try:
        assert nest.helper._pump(proc, *claimed) is None
        assert proc.poll() is not None
        assert time.monotonic() - start < 1
        assert nest.worker.helpers() == []
    finally:
        timer.join()
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()


@pytest.mark.parametrize("kind", ["align", "stems"])
def test_fake_engine_outputs_use_normal_result_paths(nest, monkeypatch, tmp_path, kind):
    nest.config.nest_processes = True
    enqueue(nest, kind)
    nest.helper.claim()
    nest.clock[0] += 600
    claimed = nest.helper.claim()
    calls = []

    def launch(python, argv, **kwargs):
        calls.append(argv)
        payload = json.loads(Path(argv[argv.index("--jobs" if kind == "align" else "--job") + 1]).read_text())
        out = Path(argv[argv.index("--out-dir") + 1])
        out.mkdir()
        if kind == "align":
            assert payload[0]["text"] == "words"
            lrc = out / "lyrics.lrc"
            lrc.write_text("[00:01] new lyric")
            event = {"event": "done", "lrc": str(lrc), "source": "aligned:mms-fa"}
        else:
            (out / "song.json").write_text('{"version":1}')
            for stem in ("vocals", "drums", "bass", "other"):
                (out / f"{stem}.ogg").write_bytes(b"fake opus")
            event = {"event": "done"}
        return subprocess.Popen([sys.executable, "-c", f"print({json.dumps(json.dumps(event))})"],
                                stdout=subprocess.PIPE, text=True, start_new_session=True)

    nest.scope.launch.side_effect = launch
    nest.helper._run(*claimed)
    assert calls[0][2:4] == ["--accel", "cpu"]
    if kind == "align":
        assert nest.q.on_result.call_args.args[1] == "[00:01] new lyric"
    else:
        assert nest.stems.repository.manifest("Album", "song0.mp3")["result"]["accel"] == "cpu"


def test_local_mode_never_registers_or_claims(nest):
    nest.config.nest_processes = True
    nest.lyrics.engine_mode = "local"
    enqueue(nest, "align")
    assert nest.helper.claim() is None
    assert nest.worker.helpers() == []


def test_toggle_during_readiness_probe_never_claims(nest):
    nest.config.nest_processes = True
    enqueue(nest, "align")

    def probe(cpu_percent):
        nest.config.nest_processes = False
        return nest.scope

    nest.helper.probe = probe
    assert nest.helper.claim() is None
    assert nest.worker.helpers() == []


def test_background_lifecycle_is_idempotent_and_releases_on_shutdown(nest, monkeypatch):
    enqueue(nest, "align")
    nest.config.nest_processes = True
    nest.helper.claim()  # Register at t=1000; no job can run yet.
    nest.clock[0] += 600
    running = threading.Event()
    released = threading.Event()

    def fake_run(*claimed):
        running.set()
        released.wait(2)

    monkeypatch.setattr(nest.helper, "_run", fake_run)
    nest.helper.refresh()
    assert running.wait(2)
    original = nest.helper._thread
    nest.helper.refresh()
    assert nest.helper._thread is original
    nest.helper._stop.set()
    released.set()
    nest.helper.stop()
    assert not original.is_alive()
    assert nest.worker.helpers() == []
    assert nest.q.status()["queued"] == 1


def test_runtime_cgroup_join_failure_disables_and_requeues(nest, monkeypatch):
    from app.infra.nest_cgroup import CgroupUnavailable

    nest.config.nest_processes = True
    enqueue(nest, "align")
    nest.helper.claim()
    nest.clock[0] += 600

    def fail(*claimed):
        nest.helper._stop.set()  # End this deterministic loop after one turn.
        nest.helper._wake.set()
        raise CgroupUnavailable

    monkeypatch.setattr(nest.helper, "_run", fail)
    nest.helper._loop()
    assert nest.worker.helpers() == []
    assert nest.q.status()["queued"] == 1
    assert nest.helper.availability()["disabledReason"] == "no-cgroup"


def test_analysis_extra_specs_and_serial_priority(nest, monkeypatch):
    from app.domains.music.analysis_jobs import AnalysisService
    from app.domains.music.analysis_repository import AnalysisRepository
    from app.domains.music.repositories import MusicRepository
    repository = AnalysisRepository(nest.config.analysis_db)
    music = MusicRepository(nest.config, LOG, repository)
    service = AnalysisService(nest.config, repository, music, nest.q.ledger, nest.worker)
    engine_available = [False]
    nest.helper._analysis = lambda: service
    nest.helper._analysis_available = lambda: engine_available[0]
    nest.config.nest_processes = True
    enqueue(nest, 'align')
    service.enqueue_files(list(music.album_files(nest.config.base_music_dir).values())[0])
    nest.helper.claim()
    assert 'analysis' not in nest.helper._agent()['jobs']
    engine_available[0] = True
    assert 'analysis' in nest.helper._agent()['jobs']
    assert nest.helper._agent()['labels'] == ['analysis>=2']
    nest.clock[0] += 600
    first = nest.helper.claim()
    assert first[0] == 'lyrics'
    assert nest.helper.claim() is None
    finish(nest, first)
    second = nest.helper.claim()
    assert second[0] == 'analysis'
    assert nest.helper.claim() is None
    assert nest.helper._heartbeat(*second)
    nest.config.nest_processes = False
    assert not nest.helper._heartbeat(*second)
    assert service.queue.rows(('analysis',))[0]['status'] == 'queued'


def test_analysis_spec_probe_uses_only_tools_interpreter(nest, monkeypatch):
    from app.domains.helpers import nest_helper
    nest.helper._check = {"addons": {"analysis": {"ready": True}}}
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr(nest_helper.subprocess, 'run', run)
    assert nest.helper._probe_analysis()
    argv = run.call_args.args[0]
    assert argv[0] == str(nest.engine.python) and 'find_spec' in argv[2]
    assert 'import onnxruntime' not in argv[2] and 'import keyfinder' not in argv[2]
    assert 'os.nice(10)' in __import__('app.infra.nest_cgroup', fromlist=['LAUNCHER']).LAUNCHER
    assert nest.helper._probe_analysis()
    assert run.call_count == 1


def test_analysis_only_nest_runs_child_with_one_thread(nest, monkeypatch):
    nest.config.nest_processes = True
    nest.engine.check.return_value = {"version": "0.13.0", "jobs": ["analysis"],
                                      "addons": {"analysis": {"ready": True}}}
    assert nest.helper.availability()["disabledReason"] is None
    assert nest.helper._check["jobs"] == ["analysis"]
    item = {"relPath": "Album/song.mp3", "size": 123, "mtimeNs": 55}
    audio = nest.config.base_music_dir / item["relPath"]
    audio.parent.mkdir()
    audio.write_bytes(b"audio")
    service = Mock()
    nest.helper._analysis = lambda: service
    monkeypatch.setattr(nest.helper, "_heartbeat", lambda *a: True)
    monkeypatch.setattr(nest.helper, "_pump", lambda *a, **kw: {"event": "done", "items": []})
    process = nest.scope.launch.return_value
    process.poll.return_value = 0
    nest.helper._run("analysis", "lease", {"id": "batch", "input": {"items": [item]}}, {})
    launch = nest.scope.launch.call_args
    argv = launch.args[1]
    assert argv[1:4] == ["analysis", "--accel", "cpu"]
    assert "--jobs" in argv
    assert launch.kwargs["env"]["OMP_NUM_THREADS"] == "1"
    assert launch.kwargs["env"]["OPENBLAS_NUM_THREADS"] == "1"
    service.result.assert_called_once_with("batch", "lease", [], NEST_ID)


def test_memory_reason_is_structured_and_nest_is_not_registered(nest, monkeypatch):
    nest.config.nest_processes = True
    monkeypatch.setattr('app.domains.helpers.nest_helper.machine_facts', lambda: {'memoryBytes': 4 << 30})
    assert nest.helper.availability()['disabledReason'] == 'memory'
    assert nest.helper.claim() is None
    view = nest.helper.view()
    assert view['nest'] and view['disabledReason'] == 'memory'
    assert {'code': 'memory', 'kind': 'stems', 'requiredBytes': 8 << 30, 'availableBytes': 2 << 30} in view['blockedReasons']
    assert not nest.worker.helpers()


def test_nest_library_rows_have_no_schedule(nest):
    nest.config.nest_processes = True
    nest.q.enqueue([{'relPath': 'Album/library.mp3', 'lane': 'library'}])
    nest.helper.claim()
    nest.clock[0] += 600
    got = nest.helper.claim()
    assert got[2]['relPath'] == 'Album/library.mp3'
    assert nest.helper._heartbeat(*got)
    finish(nest, got)


def test_thermal_hysteresis_blocks_new_claims(nest):
    nest.config.nest_processes = True
    temp = [84.9]
    nest.helper.read_temperature = lambda: temp[0]
    enqueue(nest, 'align')
    nest.helper.claim()
    nest.clock[0] += 600
    for value in (85, 84, 75.1):
        temp[0] = value
        assert nest.helper.claim() is None
        assert nest.helper.view()['pausedReason'] == 'thermal'
    temp[0] = 75
    assert nest.helper.claim()
    assert nest.helper.view()['pausedReason'] is None


def test_running_child_pauses_and_resumes_without_losing_lease(nest, monkeypatch):
    monkeypatch.setattr('app.domains.helpers.nest_helper.HEARTBEAT_S', .02)
    nest.config.nest_processes = True
    enqueue(nest, 'align')
    nest.helper.claim()
    nest.clock[0] += 600
    got = nest.helper.claim()
    temp = [85, 80, 75]
    nest.helper.read_temperature = lambda: temp.pop(0) if temp else 75
    proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'],
                            stdout=subprocess.PIPE, text=True, start_new_session=True)
    nest.scope.set_paused.side_effect = lambda child, hot: None if hot else child.terminate()
    try:
        nest.helper._pump(proc, *got)
        assert nest.scope.set_paused.call_args_list == [call(proc, True),
                                                        call(proc, False)]
        assert nest.q.queue.owns(got[2]['id'], got[1], NEST_ID)
        assert nest.q.queue.get(got[2]['id'])['attempts'] == 1
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill(); proc.wait()


def test_cpu_limit_change_defers_active_work_before_relaunch(nest):
    nest.config.nest_processes = True
    enqueue(nest, 'align')
    nest.helper.claim()
    nest.clock[0] += 600
    got = nest.helper.claim()
    nest.helper._running_cpu = 50
    nest.config.nest_cpu_percent = 25
    assert not nest.helper._heartbeat(*got)
    row = nest.q.queue.get(got[2]['id'])
    assert row['status'] == 'queued' and row['attempts'] == 0


def test_runtime_cgroup_join_failure_uses_verified_duty_cycle(nest, monkeypatch):
    from app.infra.nest_cgroup import CgroupUnavailable, DutyCycleScope
    nest.config.nest_processes = True
    nest.scope.mode = 'cgroup'
    enqueue(nest, 'align')
    nest.helper.claim()
    nest.clock[0] += 600
    fallback = DutyCycleScope(50)
    monkeypatch.setattr('app.domains.helpers.nest_helper.probe_duty_cycle', lambda cpu: fallback)
    def fail(*claimed):
        nest.helper._stop.set()
        raise CgroupUnavailable
    monkeypatch.setattr(nest.helper, '_run', fail)
    nest.helper._loop()
    assert nest.helper._scope is fallback
    assert nest.helper.availability()['disabledReason'] is None
    assert nest.q.status()['queued'] == 1
    assert nest.q.queue.rows(nest.q.kinds)[0]['attempts'] == 0


@pytest.mark.parametrize('first', ['nest', 'desktop'])
def test_nest_and_desktop_share_one_lease_even_when_both_can_process(nest, first):
    from app.domains.helpers.compute import Compute

    enqueue(nest, 'align')
    nest.config.nest_processes = True
    compute = Compute(nest.q.queue, nest.worker, nest.config)
    compute.settings.save_policy('align', {'placement': 'anywhere'})
    # Aged work is eligible for either computer, independent of ranking grace.
    nest.clock[0] += ranking.SLOW_DELAY_S
    if first == 'nest':
        claimed = nest.helper.claim()
        assert claimed
        desktop = nest.q.claim(REAL)
        assert desktop['jobs'] == []
        holder = NEST_ID
    else:
        desktop = nest.q.claim(REAL)
        assert len(desktop['jobs']) == 1
        assert nest.helper.claim() is None
        holder = REAL['id']
    rows = nest.q.queue.rows(('align',))
    assert len(rows) == 1 and rows[0]['status'] == 'leased'
    assert rows[0]['leased_by'] == holder and rows[0]['attempts'] == 1
