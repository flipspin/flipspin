"""Owner settings, provenance, atomic persistence and restart contracts."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.infra import env_sources
from app.dependencies import DependencyContainer
from app.domains.server import services
from app.domains.server.routes import get_server_config
from app.main import app

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "contracts/server-config.json").read_text())
MACHINE = dict(cores=4, memoryBytes=8_000_000_000, arch="test", container=None, cpuLimit=None,
               memoryLimitBytes=None, suggestedPreset="normal",
               capacityPresets=services.machine_facts()["capacityPresets"],
               presets={"light": [1, 1, 1], "normal": [3, 2, 2], "powerful": [6, 3, 3]})


@pytest.fixture
def nest(config, monkeypatch):
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(app.state, "container", container)
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    monkeypatch.setattr(services, "machine_facts", lambda: MACHINE)
    monkeypatch.setattr(services, "supervision", lambda: "none")
    store = container.get_token_store()
    _, owner = store.mint("Owner", "owner")
    _, member = store.mint("Member", "member")
    # Real revision sources, with only the process/engine boundary substituted.
    settings = {key: getattr(config, key) for key in ('nest_processes', 'lyrics_engine_mode', 'stems_background')}
    container.get_lyrics_service().engine = Mock()
    for key, value in settings.items():
        setattr(config, key, value)
    client = TestClient(app, client=("192.0.2.8", 50000))
    yield client, config, container, owner, member


def headers(token):
    return {"Authorization": f"Bearer {token}"} if token else {}


def test_nest_processes_is_live_persistent_owner_only_and_env_locked(nest, monkeypatch):
    client, config, container, owner, member = nest
    helper = container.get_nest_helper()
    monkeypatch.setattr(helper, "refresh", Mock())  # No background engine work.
    key = "KROBI_NEST_PROCESSES"
    before = rows(client.get("/api/server/config", headers=headers(owner)).json())[key]
    assert before["value"] is before["default"] is False
    assert before["disabledReason"] == "no-engine"
    assert before["disabledMessage"] == "Falta el motor del nido"
    assert client.put("/api/server/config", json={"changes": {key: True}}, headers=headers(member)).status_code == 403
    result = client.put("/api/server/config", json={"changes": {key: True}}, headers=headers(owner))
    assert result.status_code == 200 and config.nest_processes is True
    assert rows(result.json())[key]["source"] == "app"
    assert not rows(result.json())[key]["needsRestart"]
    assert env_sources.read_values(config.credentials_dir.parent / ".env")[key] == "true"
    helper.refresh.assert_called_once()
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset([key]))
    pinned = rows(client.get("/api/server/config", headers=headers(owner)).json())[key]
    assert pinned["source"] == "env" and pinned["editable"] is False
    assert client.put("/api/server/config", json={"changes": {key: False}}, headers=headers(owner)).status_code == 409
    assert config.nest_processes is True


def test_nest_processes_reports_no_cgroup_through_api(nest):
    client, _, container, owner, _ = nest
    engine = container.get_lyrics_service().engine
    engine.installed = True
    engine.check.return_value = {"version": "0.10.0", "jobs": ["align"], "ready": True}
    container.get_nest_helper().probe = Mock(return_value=None)
    setting = rows(client.get("/api/server/config", headers=headers(owner)).json())["KROBI_NEST_PROCESSES"]
    assert setting["disabledReason"] == "no-cgroup"
    assert setting["disabledMessage"] == "Este nido no puede limitar el proceso"


def test_owner_can_install_on_linux_x86_without_running_installer(nest, monkeypatch, tmp_path):
    import logging
    from app.infra.progress import ProgressTracker
    from app.domains.lyrics.engine import INSTALL_PROGRESS_ID, LyricsEngine

    client, config, container, owner, member = nest
    engine = LyricsEngine(config=config, progress_tracker=ProgressTracker(), logger=logging.getLogger(__name__),
                          on_result=Mock(), on_failure=Mock())
    container.get_lyrics_service().engine = engine
    monkeypatch.setattr("app.domains.lyrics.engine.platform.system", lambda: "Linux")
    monkeypatch.setattr("app.domains.lyrics.engine.platform.machine", lambda: "x86_64")
    monkeypatch.setattr(engine, "_uv", lambda: "/fake/uv")
    monkeypatch.setattr(engine, "worker_sources", lambda: [tmp_path])
    start = Mock()
    # Replace only the engine's installer Thread; TestClient still uses threads.
    monkeypatch.setattr(engine, "_install_worker", lambda sources: start(sources))
    assert engine.supported
    response = client.post("/api/lyrics/engine/install", headers=headers(owner))
    assert response.status_code == 200 and response.json() == {"progressId": INSTALL_PROGRESS_ID}
    engine._installing.join(timeout=2)
    start.assert_called_once_with([tmp_path])
    assert client.post("/api/lyrics/engine/install", headers=headers(member)).status_code == 403


def rows(body):
    return {s["key"]: s for g in body["groups"] for s in g["settings"]}


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/server/config", None),
    ("PUT", "/api/server/config", {"changes": {"KROBI_LOG_LEVEL": "INFO"}}),
    ("POST", "/api/server/restart", {"when": "idle"}),
    ("PUT", "/api/config/ytdlp-cookies", {"cookies_from_browser": "firefox"}),
    ("PUT", "/api/config/analysis-tags", {"write_analysis_tags": True}),
    ("PUT", "/api/config/spotify", {"client_id": "client", "client_secret": "secret"}),
    ("PUT", "/api/lyrics/config", {"autoFetch": False}),
])
@pytest.mark.parametrize("role,expected", [("owner", 200), ("member", 403), ("none", 401)])
def test_owner_member_no_token(nest, method, path, body, role, expected):
    client, config, container, owner, member = nest
    token = {"owner": owner, "member": member, "none": None}[role]
    response = client.request(method, path, json=body, headers=headers(token))
    if path.endswith("restart") and expected == 200:
        expected = 202
    assert response.status_code == expected, response.text


@pytest.mark.parametrize("case", CONTRACT["validation"], ids=lambda c: c["code"])
def test_every_409_422_and_atomic_batch(nest, monkeypatch, case):
    client, config, container, owner, _ = nest
    if case["code"] == "env-locked":
        monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset([case["key"]]))
    changes = {"KROBI_LOG_LEVEL": "INFO", case["key"]: case["value"]}
    response = client.put("/api/server/config", json={"changes": changes}, headers=headers(owner))
    assert response.status_code == case["status"]
    assert response.json()["detail"]["code"] == case["code"]
    assert response.json()["detail"]["key"] == case["key"]
    assert config.log_level == "DEBUG"
    assert not (config.credentials_dir.parent / ".env").exists()


def test_default_app_env_precedence_and_empty_pin(nest, monkeypatch):
    client, config, container, owner, _ = nest
    path = config.credentials_dir.parent / ".env"
    key = "KROBI_MAX_CONCURRENT_DOWNLOADS"
    assert rows(client.get("/api/server/config", headers=headers(owner)).json())[key]["source"] == "default"
    result = client.put("/api/server/config", json={"changes": {key: 4}}, headers=headers(owner))
    assert result.status_code == 200
    assert rows(result.json())[key]["source"] == "app"
    assert rows(result.json())[key]["value"] == config.max_concurrent_downloads == 4
    assert path.stat().st_mode & 0o777 == 0o600
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset([key, "KROBI_API_TOKEN"]))
    config.api_token = None
    r = rows(client.get("/api/server/config", headers=headers(owner)).json())
    assert r[key]["source"] == "env" and r[key]["editable"] is False
    assert r["KROBI_API_TOKEN"]["source"] == "env"
    assert r["KROBI_API_TOKEN"]["configured"] is False
    before = path.read_bytes()
    assert client.put("/api/server/config", json={"changes": {key: 2}}, headers=headers(owner)).status_code == 409
    assert path.read_bytes() == before


def test_write_failed_applies_nothing(nest, monkeypatch):
    client, config, container, owner, _ = nest
    path = config.credentials_dir.parent / ".env"
    path.write_text("# existing\nSPOTIFY_CLIENT_SECRET=kept\n")
    before = path.read_bytes()
    def fail(*args, **kwargs):
        raise OSError("full disk")
    monkeypatch.setattr(env_sources, "write_secret_lines", fail)
    response = client.put("/api/server/config", json={"changes": {"KROBI_LOG_LEVEL": "ERROR",
                          "KROBI_MAX_CONCURRENT_DOWNLOADS": 4}}, headers=headers(owner))
    assert response.status_code == 500 and response.json()["detail"] == {"code": "write-failed"}
    assert config.log_level == "DEBUG" and config.max_concurrent_downloads == 2
    assert path.read_bytes() == before


@pytest.mark.parametrize("path,body,key", [
    ("/api/config/ytdlp-cookies", {"cookies_from_browser": "chrome"}, "KROBI_YTDLP_COOKIES_FROM_BROWSER"),
    ("/api/config/ytdlp-cookies", {"cookies_file": "missing"}, "KROBI_YTDLP_COOKIES_FILE"),
    ("/api/config/analysis-tags", {"write_analysis_tags": True}, "KROBI_WRITE_ANALYSIS_TAGS"),
    ("/api/config/spotify", {"client_id": "x", "client_secret": "y"}, "SPOTIFY_CLIENT_ID"),
    ("/api/config/spotify", {"client_id": "x", "client_secret": "y"}, "SPOTIFY_CLIENT_SECRET"),
    ("/api/lyrics/config", {"autoFetch": True}, "KROBI_LYRICS_AUTO_FETCH"),
])
def test_old_switches_reject_env_pins(nest, monkeypatch, path, body, key):
    client, config, _, owner, _ = nest
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset([key]))
    response = client.put(path, json=body, headers=headers(owner))
    assert response.status_code == 409
    assert response.json()["detail"] == {"code": "env-locked", "key": key}
    assert not (config.credentials_dir.parent / ".env").exists()


def test_restart_pending_running_value_undo_and_boot(nest):
    client, config, container, owner, _ = nest
    get_server_config(container)  # capture boot
    response = client.put("/api/server/config", json={"changes": {"KROBI_LYRICS_ENGINE": "agent"}}, headers=headers(owner))
    assert response.status_code == 200
    body = response.json()
    assert body["restart"]["pending"] == ["KROBI_LYRICS_ENGINE"]
    row = rows(body)["KROBI_LYRICS_ENGINE"]
    assert row["value"] == "auto" and row["pendingValue"] == "agent"
    response = client.put("/api/server/config", json={"changes": {"KROBI_LYRICS_ENGINE": "auto"}}, headers=headers(owner))
    assert response.json()["restart"]["pending"] == []
    config.lyrics_engine_mode = "agent"
    (config.credentials_dir.parent / ".env").write_text("KROBI_LYRICS_ENGINE=agent\n")
    assert services.ServerConfigService(container).describe()["restart"]["pending"] == []


def test_unsupervised_restart_returns_command_without_scheduling(nest, monkeypatch):
    client, _, container, owner, _ = nest
    schedule = Mock()
    monkeypatch.setattr(services, "spawn_background", schedule)
    response = client.post("/api/server/restart", json={"when": "idle"}, headers=headers(owner))
    assert response.status_code == 202 and response.json()["restarting"] is False
    assert "-m app" in response.json()["command"]
    assert client.get("/api/status").json()["restarting"] is False
    schedule.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("when", ["now", "idle"])
async def test_supervised_restart_schedules_exit_75_and_waits(nest, monkeypatch, when):
    client, _, container, owner, _ = nest
    monkeypatch.setattr(services, "supervision", lambda: "systemd")
    service = get_server_config(container)
    tracker = container.get_progress_tracker()
    tracker.create_progress("running", 1)
    tracker.set_track_phase("running", "song", "downloading")
    delays, coroutines = [], []
    async def sleep(delay):
        delays.append(delay)
        if delay == 5:
            assert service.restarting and not service.exiting
            tracker.complete_progress("running")
    monkeypatch.setattr(services.asyncio, "sleep", sleep)
    monkeypatch.setattr(services, "spawn_background", lambda coro: coroutines.append(coro))
    exit_mock = Mock()
    monkeypatch.setattr(services.os, "_exit", exit_mock)
    response = client.post("/api/server/restart", json={"when": when}, headers=headers(owner))
    assert response.status_code == 202 and response.json() == {"restarting": True, "when": when}
    assert client.get("/api/status").json()["restarting"] is True
    assert len(coroutines) == 1
    await coroutines.pop()
    assert delays == ([5, 1] if when == "idle" else [1])
    exit_mock.assert_called_once_with(75)
    rejected = client.get("/api/status")
    assert rejected.status_code == 503 and rejected.headers["Retry-After"] == "5"


@pytest.mark.asyncio
async def test_idle_restart_times_out_and_logs(nest, monkeypatch, caplog):
    _, _, container, _, _ = nest
    service = get_server_config(container)
    container.get_progress_tracker().create_progress("running", 1)
    clock = iter([0, 1801])
    monkeypatch.setattr(services, "monotonic", lambda: next(clock))
    # Don't patch asyncio's own monotonic clock: this module shares time with the loop.
    async def sleep(_):
        pass
    monkeypatch.setattr(services.asyncio, "sleep", sleep)
    exit_mock = Mock()
    monkeypatch.setattr(services.os, "_exit", exit_mock)
    await service._restart("idle")
    exit_mock.assert_called_once_with(75)
    assert "30 minutes" in caplog.text


def test_live_side_effects_and_suggested_max_is_only_advice(nest, monkeypatch):
    client, config, container, owner, _ = nest
    advertiser = Mock()
    monkeypatch.setattr(container, "get_nest_advertiser", lambda: advertiser)
    from app.domains.music.repositories import MusicRepository
    repo = MusicRepository(config, Mock())
    container._repositories["music_repository"] = repo
    response = client.put("/api/server/config", json={"changes": {
        "KROBI_MAX_CONCURRENT_DOWNLOADS": 4, "KROBI_MAX_CONCURRENT_JOBS": 8,
        "KROBI_ANALYSIS_WORKERS": 3, "KROBI_ADVERTISE": False,
        "KROBI_ENABLE_WAVEFORM_CACHE": False, "KROBI_LOG_LEVEL": "WARNING",
    }}, headers=headers(owner))
    assert response.status_code == 200, response.text
    assert config.max_concurrent_jobs == 8 and config.max_concurrent_downloads == 4
    assert config.analysis_workers == 3
    assert not hasattr(repo.analysis, "_analysis_executor")
    assert not config.enable_waveform_cache
    advertiser.refresh.assert_called_once()


def test_recorded_server_config_wire_contract(nest, monkeypatch):
    """Record a GET with deterministic machine, paths and provenance."""
    import os
    client, config, _, owner, _ = nest
    config.max_concurrent_downloads = 3
    config.log_level = "INFO"
    config.ffmpeg_path = "/usr/bin/ffmpeg"
    config.ffmpeg_version = "7.1"
    config.ffmpeg_source = "system"
    config.base_music_dir = Path("/data/Music")
    config.playlist_dir = Path("/data/playlists")
    config.stems_dir = Path("/data/stems")
    config.log_dir = Path("/data/logs")
    for key in ("KROBI_BACKEND_HOST", "KROBI_BACKEND_PORT", "KROBI_CORS_ORIGINS",
                "KROBI_DEMO_OVERRIDES", "KROBI_YTDLP_PLAYER_CLIENT"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(services, "supervision", lambda: "systemd")
    body = client.get("/api/server/config", headers=headers(owner)).json()
    for row in rows(body).values():
        if row["key"] in {"KROBI_MUSIC_DIR", "KROBI_PLAYLIST_DIR", "KROBI_STEMS_DIR", "KROBI_LOG_DIR"}:
            row["default"] = row["value"]
    path = Path(__file__).resolve().parents[3] / "contracts/wire/server-config.json"
    if os.getenv("UPDATE_WIRE_SNAPSHOTS") == "1":
        path.write_text(json.dumps(body, indent=2) + "\n")
    assert body == json.loads(path.read_text())


def test_boot_snapshot_happens_before_dotenv_and_env_wins(nest, monkeypatch, tmp_path):
    import os
    import app.main as main
    from app.config import ConfigManager

    monkeypatch.setenv("KROBI_LOG_LEVEL", "ERROR")
    monkeypatch.delenv("KROBI_LYRICS_ENGINE", raising=False)
    monkeypatch.setattr(main, "KROBI_HOME", tmp_path)
    monkeypatch.setenv("KROBI_CREDENTIALS_DIR", str(tmp_path / "credentials"))
    path = tmp_path / ".env"
    path.write_text("KROBI_LOG_LEVEL=DEBUG\nKROBI_LYRICS_ENGINE=agent\n")
    env_sources.capture_environment()
    main._load_env()
    env_sources.record_app_keys(path)
    # Register the assignment for monkeypatch cleanup: _load_env mutates os.environ itself.
    monkeypatch.setenv("KROBI_LYRICS_ENGINE", os.environ.pop("KROBI_LYRICS_ENGINE"))
    assert env_sources.source("KROBI_LOG_LEVEL", path) == "env"
    assert env_sources.source("KROBI_LYRICS_ENGINE", path) == "app"
    cfg = ConfigManager.from_env()
    assert cfg.log_level == "ERROR" and cfg.lyrics_engine_mode == "agent"


def test_live_log_level_reaches_handlers_without_filling_error_log(nest):
    import logging
    from app.infra.logging import LoggerConfig
    client, config, _, owner, _ = nest
    LoggerConfig.set_level("ERROR")
    response = client.put("/api/server/config", json={"changes": {"KROBI_LOG_LEVEL": "DEBUG"}}, headers=headers(owner))
    assert response.status_code == 200
    logging.getLogger("app.test-server-config").debug("live-detail-marker")
    assert "live-detail-marker" in (config.log_dir / "krobi.log").read_text()
    assert "live-detail-marker" not in (config.log_dir / "krobi_errors.log").read_text()


@pytest.mark.parametrize("path", ["/api/config/ytdlp-cookies", "/api/config/analysis-tags", "/api/config/spotify", "/api/lyrics/config"])
@pytest.mark.parametrize("role,expected", [("owner", 200), ("member", 200), ("none", 401)])
def test_old_reads_keep_existing_access(nest, path, role, expected):
    client, _, _, owner, member = nest
    token = {"owner": owner, "member": member, "none": None}[role]
    assert client.get(path, headers=headers(token)).status_code == expected


@pytest.mark.parametrize("changes,code", [
    ({"KROBI_MAX_CONCURRENT_DOWNLOADS": 0}, "out-of-range"),
    ({"KROBI_MAX_CONCURRENT_JOBS": 9}, "out-of-range"),
    ({"KROBI_MAX_CONCURRENT_JOBS": 0}, "out-of-range"),
    ({"KROBI_ANALYSIS_WORKERS": 5}, "out-of-range"),
    ({"KROBI_ANALYSIS_WORKERS": 0}, "out-of-range"),
    ({"KROBI_LOG_LEVEL": "CRITICAL"}, "not-a-choice"),
    ({"KROBI_ADVERTISE": 1}, "bad-type"),
    ({"KROBI_ENABLE_WAVEFORM_CACHE": "false"}, "bad-type"),
    ({"KROBI_LOG_LEVEL": None}, "bad-type"),
    ({"KROBI_MAX_CONCURRENT_DOWNLOADS": 3.0}, "bad-type"),
])
def test_strict_capacity_bounds_and_json_types(nest, changes, code):
    client, config, _, owner, _ = nest
    response = client.put("/api/server/config", json={"changes": changes}, headers=headers(owner))
    assert response.status_code == 422 and response.json()["detail"]["code"] == code
    assert not (config.credentials_dir.parent / ".env").exists()


def test_now_can_expedite_an_idle_restart_and_duplicate_idle_is_idempotent(nest, monkeypatch):
    _, _, container, _, _ = nest
    monkeypatch.setattr(services, "supervision", lambda: "desktop")
    tasks, coroutines = [], []
    def schedule(coro):
        coroutines.append(coro)
        task = Mock()
        tasks.append(task)
        return task
    monkeypatch.setattr(services, "spawn_background", schedule)
    service = get_server_config(container)
    try:
        service.restart("idle")
        service.restart("idle")
        assert len(tasks) == 1
        service.restart("now")
        assert len(tasks) == 2
        tasks[0].cancel.assert_called_once()
        assert service._restart_when == "now"
    finally:
        for coro in coroutines:
            coro.close()


def test_owner_sets_ffmpeg_live_and_persists_metadata(nest, monkeypatch):
    from app.infra.ffmpeg import bundled_ffmpeg_path, resolve_ffmpeg_info
    client, config, _, owner, _ = nest
    binary = bundled_ffmpeg_path()
    response = client.put('/api/server/config', json={'changes': {'KROBI_FFMPEG_PATH': binary}},
                          headers=headers(owner))
    assert response.status_code == 200, response.text
    row = rows(response.json())['KROBI_FFMPEG_PATH']
    assert row['value'] == config.ffmpeg_path == binary
    assert row['version'] == config.ffmpeg_version
    assert row['binarySource'] == config.ffmpeg_source == 'env'
    assert row['source'] == 'app' and row['editable'] and not row['needsRestart']
    assert 'KROBI_FFMPEG_PATH' not in response.json()['restart']['pending']
    saved = env_sources.read_values(config.credentials_dir.parent / '.env')
    assert saved['KROBI_FFMPEG_PATH'] == binary
    monkeypatch.setenv('KROBI_FFMPEG_PATH', saved['KROBI_FFMPEG_PATH'])
    assert resolve_ffmpeg_info().path == binary
    assert rows(client.get('/api/server/config', headers=headers(owner)).json())['KROBI_FFMPEG_PATH'] == row


@pytest.mark.parametrize('bad', ['missing', 'not-executable', 'wrong-program', 'empty', 'type'])
def test_bad_ffmpeg_is_422_and_batch_changes_nothing(nest, tmp_path, bad):
    import sys
    client, config, _, owner, _ = nest
    binary = tmp_path / 'not-ffmpeg'
    if bad == 'not-executable':
        binary.write_text('not executable')
    value = {'wrong-program': sys.executable, 'empty': '', 'type': 42}.get(bad, str(binary))
    before = (config.ffmpeg_path, config.ffmpeg_version, config.ffmpeg_source)
    response = client.put('/api/server/config', json={'changes': {'KROBI_LOG_LEVEL': 'ERROR',
                          'KROBI_FFMPEG_PATH': value}}, headers=headers(owner))
    assert response.status_code == 422
    assert response.json()['detail'] == {'code': 'bad-type' if bad == 'type' else 'invalid-ffmpeg',
                                         'key': 'KROBI_FFMPEG_PATH'}
    assert (config.ffmpeg_path, config.ffmpeg_version, config.ffmpeg_source) == before
    assert config.log_level == 'DEBUG'
    assert not (config.credentials_dir.parent / '.env').exists()


@pytest.mark.parametrize('role,expected', [('member', 403), ('none', 401), ('env', 409)])
def test_ffmpeg_owner_access_and_process_env_lock(nest, monkeypatch, role, expected):
    client, config, _, owner, member = nest
    token = {'member': member, 'none': None, 'env': owner}[role]
    if role == 'env':
        monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset(['KROBI_FFMPEG_PATH']))
        row = rows(client.get('/api/server/config', headers=headers(owner)).json())['KROBI_FFMPEG_PATH']
        assert row['source'] == 'env' and not row['editable']
    response = client.put('/api/server/config', json={'changes': {'KROBI_FFMPEG_PATH': config.ffmpeg_path}},
                          headers=headers(token))
    assert response.status_code == expected
    assert not (config.credentials_dir.parent / '.env').exists()


@pytest.mark.parametrize('key,attr,default,value', [
    ('KROBI_NEST_CPU_PERCENT', 'nest_cpu_percent', 50, 25),
    ('KROBI_NEST_MAX_TEMP_C', 'nest_max_temp_c', 85, 90),
    ('KROBI_NEST_RESUME_TEMP_C', 'nest_resume_temp_c', 75, 70),
])
def test_nest_limits_live_persistent_owner_only_and_env_locked(nest, monkeypatch, key, attr, default, value):
    from app.config import settings_from_env
    client, config, container, owner, member = nest
    helper = container.get_nest_helper()
    monkeypatch.setattr(helper, 'refresh', Mock())
    before = rows(client.get('/api/server/config', headers=headers(owner)).json())[key]
    assert before['value'] == before['default'] == default
    assert client.put('/api/server/config', json={'changes': {key: value}}, headers=headers(member)).status_code == 403
    reply = client.put('/api/server/config', json={'changes': {key: value}}, headers=headers(owner))
    assert reply.status_code == 200, reply.text
    assert getattr(config, attr) == value
    assert env_sources.read_values(config.credentials_dir.parent / '.env')[key] == str(value)
    assert rows(reply.json())[key]['source'] == 'app'
    helper.refresh.assert_called_once()
    monkeypatch.setenv(key, str(value))
    assert settings_from_env()[attr] == value
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset([key]))
    assert client.put('/api/server/config', json={'changes': {key: default}}, headers=headers(owner)).status_code == 409
    pinned = rows(client.get('/api/server/config', headers=headers(owner)).json())[key]
    assert pinned['source'] == 'env' and not pinned['editable']


@pytest.mark.parametrize('changes', [
    {'KROBI_NEST_CPU_PERCENT': 0}, {'KROBI_NEST_CPU_PERCENT': 101},
    {'KROBI_NEST_CPU_PERCENT': True}, {'KROBI_NEST_LIBRARY_START_HOUR': 24},
    {'KROBI_NEST_LIBRARY_END_HOUR': -1}, {'KROBI_NEST_MAX_TEMP_C': 75},
    {'KROBI_NEST_RESUME_TEMP_C': 85},
])
def test_invalid_nest_limits_are_atomic(nest, changes):
    client, config, _, owner, _ = nest
    response = client.put('/api/server/config', json={'changes': {'KROBI_LOG_LEVEL': 'INFO', **changes}}, headers=headers(owner))
    assert response.status_code == 422
    assert config.log_level == 'DEBUG'
    assert not (config.credentials_dir.parent / '.env').exists()


def test_source_location_is_editable_text_and_prefills_without_installing(nest, monkeypatch):
    client, config, container, owner, member = nest
    from app.domains.acquisition.sources.compat import LEGACY_SOURCES
    id, (_, key) = next(iter(LEGACY_SOURCES.items()))
    monkeypatch.delenv(key, raising=False)
    before = rows(client.get('/api/server/config', headers=headers(owner)).json())[key]
    assert before['kind'] == 'text' and before['value'] == before['default'] == '' and before['editable']
    location = 'https://example.test/source.git'
    assert client.put('/api/server/config', json={'changes': {key: location}}, headers=headers(member)).status_code == 403
    response = client.put('/api/server/config', json={'changes': {key: location}}, headers=headers(owner))
    assert response.status_code == 200, response.text
    assert rows(response.json())[key]['value'] == location
    todo = client.get('/api/sources/missing', headers=headers(owner)).json()['sources']
    assert next(row for row in todo if row['id'] == id)['location'] == location
    assert not (config.playlist_dir.parent / 'sources').exists()
