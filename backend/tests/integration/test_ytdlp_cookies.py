"""Check yt-dlp bot detection, cookie arguments, and live settings updates.

Redirect credentials_dir before testing persistence to keep writes out of
the user's saved environment."""
import logging
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import ConfigManager
from app.dependencies import get_config
from app.exceptions import SourceAuthRequiredError, DownloadError
from app.domains.downloads.repositories import (
    _source_cookie_args,
)


def _make_config(tmp_path: Path) -> ConfigManager:
    for sub in ("Music", "playlists", "temp", "logs", "credentials"):
        (tmp_path / sub).mkdir(parents=True, exist_ok=True)
    return ConfigManager(
        data_root=tmp_path,
        base_music_dir=tmp_path / "Music",
        playlist_dir=tmp_path / "playlists",
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials",
    )






# --- bot-wall detection ----------------------------------------------------







def test_auth_error_is_a_download_error():
    # Existing `except DownloadError` handlers must still catch it.
    assert isinstance(SourceAuthRequiredError(), DownloadError)


# --- cookie arg building ---------------------------------------------------

def test_cookie_args_empty_by_default(tmp_path):
    assert _source_cookie_args(_make_config(tmp_path)) == []


def _cookies_file(tmp_path: Path) -> Path:
    f = tmp_path / "cookies.txt"
    f.write_text("# Netscape HTTP Cookie File\n")
    return f


def test_cookie_args_prefers_browser(tmp_path):
    cfg = _make_config(tmp_path)
    cfg.source_cookies_from_browser = "firefox"
    cfg.source_cookies_file = str(_cookies_file(tmp_path))
    assert _source_cookie_args(cfg) == ["--cookies-from-browser", "firefox"]


def test_cookie_args_falls_back_to_file(tmp_path):
    # The cookies file is the only cookie source that works headless (no browser
    # profile on a server), so it must be wired up standalone.
    cfg = _make_config(tmp_path)
    f = _cookies_file(tmp_path)
    cfg.source_cookies_file = str(f)
    assert _source_cookie_args(cfg) == ["--cookies", str(f)]


def test_cookie_args_expands_tilde_in_configured_file(tmp_path, monkeypatch):
    # "~" must resolve against the *backend's* home, not be handed to yt-dlp raw.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    f = _cookies_file(tmp_path)
    cfg = _make_config(tmp_path)
    cfg.source_cookies_file = "~/cookies.txt"
    assert _source_cookie_args(cfg) == ["--cookies", str(f)]


def test_missing_cookies_file_degrades_with_a_clear_log(tmp_path, caplog):
    # A stale path must not abort every download with yt-dlp's opaque error.
    cfg = _make_config(tmp_path)
    cfg.source_cookies_file = str(tmp_path / "gone.txt")
    with caplog.at_level(logging.WARNING):
        assert _source_cookie_args(cfg) == []
    assert "cookies file" in caplog.text.lower()
    assert "gone.txt" in caplog.text


def test_unreadable_cookies_file_degrades_with_a_clear_log(tmp_path, caplog):
    cfg = _make_config(tmp_path)
    f = _cookies_file(tmp_path)
    f.chmod(0o000)
    try:
        if os.access(f, os.R_OK):
            pytest.skip("cannot make the file unreadable (running as root?)")
        cfg.source_cookies_file = str(f)
        with caplog.at_level(logging.WARNING):
            assert _source_cookie_args(cfg) == []
        assert "not readable" in caplog.text
    finally:
        f.chmod(0o644)


def test_bad_request_cookies_file_falls_through_to_config(tmp_path):
    # An explicit per-download path wins only when it is actually usable.
    cfg = _make_config(tmp_path)
    f = _cookies_file(tmp_path)
    cfg.source_cookies_file = str(f)
    assert _source_cookie_args(cfg, str(tmp_path / "missing.txt")) == ["--cookies", str(f)]


def test_browser_option_is_passed_through_untouched(tmp_path):
    # Only yt-dlp can tell whether a browser profile exists; don't second-guess it.
    cfg = _make_config(tmp_path)
    cfg.source_cookies_from_browser = "safari"
    assert _source_cookie_args(cfg) == ["--cookies-from-browser", "safari"]


# --- /api/config/ytdlp-cookies endpoint ------------------------------------

@pytest.fixture
def client(tmp_path):
    cfg = _make_config(tmp_path)
    app.dependency_overrides[get_config] = lambda: cfg
    try:
        yield TestClient(app), cfg
    finally:
        app.dependency_overrides.pop(get_config, None)


def test_get_returns_current_settings(client):
    c, _ = client
    assert c.get("/api/config/ytdlp-cookies").json() == {
        "cookies_from_browser": "",
        "cookies_file": "",
    }


def test_put_persists_and_applies_live(client, tmp_path):
    c, cfg = client
    resp = c.put("/api/config/ytdlp-cookies", json={"cookies_from_browser": "Chrome"})
    assert resp.status_code == 200
    # Applied live (lowercased) ...
    assert cfg.source_cookies_from_browser == "chrome"
    # ... and persisted to <credentials_dir>/../.env
    env_text = (tmp_path / ".env").read_text()
    assert "KROBI_YTDLP_COOKIES_FROM_BROWSER=chrome" in env_text
    # ... and reflected on GET
    assert c.get("/api/config/ytdlp-cookies").json()["cookies_from_browser"] == "chrome"


def test_put_rejects_unknown_browser(client):
    c, _ = client
    assert c.put("/api/config/ytdlp-cookies", json={"cookies_from_browser": "netscape"}).status_code == 400


def test_put_rejects_missing_cookies_file(client):
    c, _ = client
    assert c.put("/api/config/ytdlp-cookies", json={"cookies_file": "/no/such/file.txt"}).status_code == 400


def test_put_accepts_existing_cookies_file(client, tmp_path):
    c, cfg = client
    f = tmp_path / "cookies.txt"
    f.write_text("# Netscape HTTP Cookie File\n")
    resp = c.put("/api/config/ytdlp-cookies", json={"cookies_file": str(f)})
    assert resp.status_code == 200
    assert cfg.source_cookies_file == str(f)


def test_put_stores_the_expanded_cookies_path(client, tmp_path, monkeypatch):
    # The backend reads the file, so "~" resolves against the server's home and
    # is persisted expanded — a remote client's "~" would mean the wrong machine.
    c, cfg = client
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    f = tmp_path / "cookies.txt"
    f.write_text("# Netscape HTTP Cookie File\n")
    resp = c.put("/api/config/ytdlp-cookies", json={"cookies_file": "~/cookies.txt"})
    assert resp.status_code == 200
    assert cfg.source_cookies_file == str(f)
    assert resp.json()["cookies_file"] == str(f)


def test_put_missing_file_error_names_the_backend_machine(client):
    # Remote deployments: the picked path must exist on the server, not the client.
    c, _ = client
    resp = c.put("/api/config/ytdlp-cookies", json={"cookies_file": "/no/such/file.txt"})
    assert resp.status_code == 400
    assert "backend" in resp.json()["detail"].lower()
