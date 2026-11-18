"""A nest owns its music folder across config reloads and remote sessions."""
import pytest
from fastapi.testclient import TestClient

from app.config import ConfigManager, REQUIRED_DIRS
from app.domains.system import routes
from app.infra import env_sources
from app.main import app


@pytest.fixture
def nest(config, monkeypatch, tmp_path):
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(routes, "_ALLOWED_BASEDIR_PARENT", tmp_path)
    monkeypatch.setattr(config, "data_root", tmp_path / "nest")
    monkeypatch.setenv("FLIPSPIN_DATA_DIR", str(config.data_root))
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    for attr, (key, _) in REQUIRED_DIRS.items():
        monkeypatch.setenv(key, str(getattr(config, attr)))
    monkeypatch.delenv("KROBI_MUSIC_DIR")
    return TestClient(app), config


def test_folder_survives_new_config_and_remote_visit(nest, tmp_path):
    client, config = nest
    chosen = tmp_path / "any layout" / "Music"
    response = client.post("/api/set-basedir", json={"basedir": str(chosen)})
    assert response.status_code == 200
    assert config.base_music_dir == chosen
    assert env_sources.read_values(config.data_root / ".env")["KROBI_MUSIC_DIR"] == str(chosen)
    assert ConfigManager.from_env().base_music_dir == chosen

    # A remote session may read this nest, but cannot repoint its music folder.
    remote = TestClient(app, client=("192.0.2.8", 50000))
    config.api_token = "test-token"
    headers = {"Authorization": "Bearer test-token"}
    assert remote.get("/api/get-basedir", headers=headers).json() == {"basedir": str(chosen)}
    assert remote.post("/api/set-basedir", headers=headers, json={"basedir": str(tmp_path / "remote")}).status_code == 403
    assert ConfigManager.from_env().base_music_dir == chosen


def test_environment_folder_wins_and_is_locked(nest, monkeypatch, tmp_path):
    client, config = nest
    chosen = tmp_path / "chosen"
    assert client.post("/api/set-basedir", json={"basedir": str(chosen)}).status_code == 200
    pinned = tmp_path / "operator-music"
    monkeypatch.setenv("KROBI_MUSIC_DIR", str(pinned))
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset({"KROBI_MUSIC_DIR"}))
    assert ConfigManager.from_env().base_music_dir == pinned
    for route, payload in [("set-basedir", {"basedir": str(tmp_path / "other")}), ("reset-basedir", None)]:
        response = client.post(f"/api/{route}", json=payload)
        assert response.status_code == 409
        assert response.json()["detail"] == {"code": "env-locked", "key": "KROBI_MUSIC_DIR"}
    assert config.base_music_dir == chosen


def test_home_boundary_and_write_failure_preserve_folder(nest, monkeypatch, tmp_path):
    client, config = nest
    before = config.base_music_dir
    assert client.post("/api/set-basedir", json={"basedir": str(tmp_path.parent / "outside")}).status_code == 400
    assert config.base_music_dir == before

    def fail(*args):
        raise OSError("read-only")

    monkeypatch.setattr(env_sources, "write_secret_lines", fail)
    assert client.post("/api/set-basedir", json={"basedir": str(tmp_path / "chosen")}).status_code == 500
    assert config.base_music_dir == before


def test_reset_persists_default_instead_of_old_app_value(nest, monkeypatch, tmp_path):
    client, config = nest
    chosen = tmp_path / "chosen"
    assert client.post("/api/set-basedir", json={"basedir": str(chosen)}).status_code == 200
    monkeypatch.setenv("KROBI_MUSIC_DIR", str(chosen))  # dotenv copy from a previous boot
    assert client.post("/api/reset-basedir").status_code == 200
    expected = tmp_path / "nest" / "Music"
    assert config.base_music_dir == expected
    assert ConfigManager.from_env().base_music_dir == expected


def test_data_root_outside_home_is_allowed_and_symlink_escape_is_not(nest, monkeypatch, tmp_path):
    client, config = nest
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(routes, "_ALLOWED_BASEDIR_PARENT", home)
    chosen = config.data_root / "another library"
    assert client.post("/api/set-basedir", json={"basedir": str(chosen)}).status_code == 200
    assert config.base_music_dir == chosen
    outside = tmp_path / "outside"
    outside.mkdir()
    link = config.data_root / "escape"
    link.symlink_to(outside, target_is_directory=True)
    refused = client.post("/api/set-basedir", json={"basedir": str(link / "music")})
    assert refused.status_code == 400
    assert refused.json()["details"]["allowed_parent"] == str(home)
    assert refused.json()["details"]["allowed_parents"] == [str(home.resolve()), str(config.data_root.resolve())]
    assert config.base_music_dir == chosen
