"""Genius settings never return a key; owner writes take effect immediately."""
import logging
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.config import ConfigManager
from app.dependencies import get_config
from app.domains.accounts.auth import current_principal
from app.domains.accounts.identity import Principal
from app.domains.metadata.repositories import GeniusRepository
from app.main import app


@pytest.fixture
def setup(config):
    config.genius_api_key = None
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[current_principal] = lambda: Principal("owner", "Owner", "owner")
    try:
        yield TestClient(app), config
    finally:
        app.dependency_overrides.pop(get_config, None)
        app.dependency_overrides.pop(current_principal, None)


def reloaded(config):
    return ConfigManager(
        base_music_dir=config.base_music_dir, playlist_dir=config.playlist_dir,
        temp_dir=config.temp_dir, log_dir=config.log_dir,
        credentials_dir=config.credentials_dir,
    )


def test_save_replace_remove_private_persistence_and_live_repository(setup, monkeypatch):
    client, config = setup
    monkeypatch.setattr("app.providers.secret_settings.requests.get", Mock(return_value=Mock(status_code=200)))
    repo = GeniusRepository(config, logging.getLogger("test.genius"))
    assert client.get("/api/config/genius").json() == {"configured": False, "canManage": True}
    for key in ("first-secret", "replacement-secret"):
        response = client.put("/api/config/genius", json={"apiKey": key})
        assert response.status_code == 200
        assert response.json() == {"configured": True, "canManage": True}
        assert key not in client.get("/api/config/genius").text
        assert reloaded(config).genius_api_key == key
        assert repo.api_key == key
    file = config.credentials_dir / "secrets.json"
    assert file.stat().st_mode & 0o777 == 0o600
    get = Mock(return_value=Mock(json=lambda: {"response": {"hits": []}}))
    monkeypatch.setattr("app.domains.metadata.repositories.requests.get", get)
    repo.search_songs("test")
    assert get.call_args.kwargs["headers"]["Authorization"] == "Bearer replacement-secret"
    assert client.delete("/api/config/genius").json() == {"configured": False, "canManage": True}
    assert repo.api_key is None
    assert reloaded(config).genius_api_key is None  # must not resurrect an env key


def test_member_can_read_status_but_cannot_change_key(setup):
    client, config = setup
    app.dependency_overrides[current_principal] = lambda: Principal("member", "Member", "member")
    assert client.get("/api/config/genius").json() == {"configured": False, "canManage": False}
    assert client.put("/api/config/genius", json={"apiKey": "secret"}).status_code == 403
    assert client.delete("/api/config/genius").status_code == 403
    assert not (config.credentials_dir / "genius.json").exists()


@pytest.mark.parametrize("key", ["", "  ", "secret\nOTHER=bad", "secret with spaces", "x" * 4097])
def test_invalid_keys_are_rejected_without_echoing_the_secret(setup, key):
    client, config = setup
    response = client.put("/api/config/genius", json={"apiKey": key})
    assert response.status_code == 422
    if key.strip():
        assert key not in response.text
    assert config.genius_api_key is None
    assert not (config.credentials_dir / "genius.json").exists()


def test_disk_failure_preserves_active_key_and_does_not_leak_details(setup, monkeypatch):
    client, config = setup
    config.genius_api_key = "old-secret"
    monkeypatch.setattr(config.secrets, "_commit", Mock(side_effect=OSError("secret-path")))
    response = client.put("/api/config/genius", json={"apiKey": "new-secret"})
    assert response.status_code == 500
    assert "secret-path" not in response.text
    assert "new-secret" not in response.text
    assert config.genius_api_key == "old-secret"
