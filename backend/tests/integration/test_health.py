"""Tests for the /api/health readiness probe.

The desktop client polls this in a loop before opening its window, which is the
only way to know a *remote* backend is actually up (an open TCP port isn't).
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import APP_VERSION, ConfigManager
from app.dependencies import get_config
from app.main import app


def _make_config(tmp_path: Path) -> ConfigManager:
    for sub in ("Music", "playlists", "temp", "logs", "credentials"):
        (tmp_path / sub).mkdir(parents=True, exist_ok=True)
    return ConfigManager(
        base_music_dir=tmp_path / "Music",
        playlist_dir=tmp_path / "playlists",
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials",
    )


@pytest.fixture
def client(tmp_path):
    cfg = _make_config(tmp_path)
    app.dependency_overrides[get_config] = lambda: cfg
    try:
        yield TestClient(app), cfg
    finally:
        app.dependency_overrides.pop(get_config, None)


def test_health_is_ok_and_unauthenticated(client):
    c, _ = client
    resp = c.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_health_reports_version_and_hostname(client):
    c, _ = client
    body = client[0].get("/api/health").json()
    assert body["version"] == APP_VERSION
    assert body["hostname"]


def test_health_reports_resolved_music_dir(client, tmp_path):
    c, cfg = client
    body = c.get("/api/health").json()
    assert body["base_music_dir"] == str(cfg.base_music_dir)
    assert body["base_music_dir_exists"] is True


def test_health_flags_a_missing_music_dir(client, tmp_path):
    # A remote deployment pointed at a non-existent mount must be diagnosable.
    c, cfg = client
    cfg.base_music_dir = tmp_path / "nope"
    body = c.get("/api/health").json()
    assert body["base_music_dir_exists"] is False
    assert body["status"] == "ok"  # still live — this is diagnostic, not fatal


def test_health_reports_ffmpeg(client):
    c, cfg = client
    body = c.get("/api/health").json()
    assert body["ffmpeg_path"] == cfg.ffmpeg_path
    assert isinstance(body["ffmpeg_available"], bool)


def test_health_reports_missing_ffmpeg(client):
    c, cfg = client
    cfg.ffmpeg_path = "/nonexistent/ffmpeg-binary"
    assert c.get("/api/health").json()["ffmpeg_available"] is False


def test_health_tracks_runtime_basedir_changes(client, tmp_path):
    # base_music_dir is runtime-mutable via POST /api/set-basedir; health must
    # read it live rather than a value cached at startup.
    c, cfg = client
    new_dir = tmp_path / "OtherMusic"
    new_dir.mkdir()
    cfg.base_music_dir = new_dir
    assert c.get("/api/health").json()["base_music_dir"] == str(new_dir)
