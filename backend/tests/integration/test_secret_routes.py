"""Owner API, legacy lock parity, boot degradation and no plaintext leakage."""
import logging
from unittest.mock import Mock

import pytest
import requests
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.config import REQUIRED_DIRS, STATE_PATHS, ConfigManager
from app.dependencies import get_config, get_spotify_auth
from app.infra import env_sources
from app.infra.identity import Principal, current_principal
from app.infra.secrets import SecretStore
from app.main import app

GENIUS = "KROBI_GENIUS_API_KEY"
URL = f"/api/server/secrets/{GENIUS}"


@pytest.mark.parametrize("migrate_spotify", [False, True])
def test_boot_preserves_dotenv_api_token_bytes_and_auth(tmp_path, monkeypatch, migrate_spotify):
    monkeypatch.setenv("FLIPSPIN_DATA_DIR", str(tmp_path))
    for table in (REQUIRED_DIRS, STATE_PATHS):
        for variable, name in table.values():
            monkeypatch.setenv(variable, str(tmp_path / name))
    monkeypatch.delenv("KROBI_API_TOKEN", raising=False)
    monkeypatch.delenv("SPOTIFY_CLIENT_SECRET", raising=False)
    preserved = b'# desktop shell fallback\r\nexport KROBI_API_TOKEN = "desktop-token"\r\n\r\n'
    dotenv = tmp_path / ".env"
    dotenv.write_bytes(preserved + (b'SPOTIFY_CLIENT_SECRET=migrate-me\r\n' if migrate_spotify else b''))

    env_sources.load_environment(tmp_path)
    booted = ConfigManager.from_env()
    assert dotenv.read_bytes() == preserved
    assert "KROBI_API_TOKEN" not in booted.secrets.records
    assert "KROBI_API_TOKEN" not in booted.secrets.external
    if migrate_spotify:
        assert booted.secrets.get("SPOTIFY_CLIENT_SECRET") == "migrate-me"
    monkeypatch.setattr(app.state, "config", booted)
    monkeypatch.setitem(app.dependency_overrides, get_config, lambda: booted)
    client = TestClient(app)
    assert client.get("/api/get-basedir").status_code == 401
    client.headers["Authorization"] = "Bearer desktop-token"
    assert client.get("/api/get-basedir").status_code == 200
    assert all(row["name"] != "KROBI_API_TOKEN"
               for row in client.get("/api/server/secrets").json()["secrets"])
    token_url = "/api/server/secrets/KROBI_API_TOKEN"
    assert client.put(token_url, json={"value": "replacement"}).status_code == 404
    assert client.delete(token_url).status_code == 404
    # Applying provider changes must also leave the legacy auth setting alone.
    assert client.delete("/api/server/secrets/SPOTIFY_CLIENT_SECRET").status_code == 200
    assert client.get("/api/get-basedir").status_code == 200
    assert dotenv.read_bytes() == preserved


@pytest.fixture
def nest(config, monkeypatch):
    config.genius_api_key = None
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    get = Mock(return_value=Mock(status_code=200))
    post = Mock(return_value=Mock(status_code=200))
    monkeypatch.setattr("app.providers.secret_settings.requests.get", get)
    monkeypatch.setattr("app.providers.secret_settings.requests.post", post)
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[current_principal] = lambda: Principal("owner-id", "Owner", "owner")
    yield TestClient(app), config, get, post
    app.dependency_overrides.pop(get_config, None)
    app.dependency_overrides.pop(current_principal, None)


def test_owner_saves_once_after_commit_and_repeats_masks_without_world_calls(nest):
    client, config, get, _ = nest
    def probe(*args, **kwargs):
        reloaded = SecretStore(config.credentials_dir, config.instance_file, environment={})
        assert reloaded.get(GENIUS) == "api-value-private"
        assert kwargs["timeout"] == 5
        return Mock(status_code=200)
    get.side_effect = probe
    saved = client.put(URL, json={"value": "api-value-private"})
    assert saved.status_code == 200
    assert saved.json()["state"] == "guardada" and saved.json()["verifiedAt"]
    assert get.call_count == 1
    before = config.secrets.path.read_bytes()
    for value in ("api-value-private", "••••••••", "********"):
        assert client.put(URL, json={"value": value}).json() == saved.json()
    assert get.call_count == 1 and before == config.secrets.path.read_bytes()
    assert client.delete(URL).json()["state"] == "falta"
    assert config.genius_api_key is None
    assert client.delete(URL).json()["state"] == "falta"


@pytest.mark.parametrize("status,reason", [(401, "genius-auth-rejected"), (403, "genius-auth-rejected")])
def test_permanent_auth_error_is_typed_without_reflecting_provider_body(nest, status, reason):
    client, config, get, _ = nest
    get.return_value = Mock(status_code=status, text="provider-may-echo-the-secret")
    response = client.put(URL, json={"value": "rejected-private-value"})
    assert response.status_code == 200
    assert response.json()["state"] == "rechazada" and response.json()["reason"] == reason
    assert response.json()["verifiedAt"]
    get.return_value = Mock(status_code=200)
    assert client.put(URL, json={"value": "valid-replacement"}).json()["state"] == "guardada"
    assert config.genius_api_key == "valid-replacement"


@pytest.mark.parametrize("failure", [requests.Timeout("sensitive-exception"), requests.ConnectionError("sensitive-exception"), 429, 500])
def test_transient_error_keeps_state_and_stores_replacement(nest, failure):
    client, config, get, _ = nest
    get.return_value = Mock(status_code=401)
    assert client.put(URL, json={"value": "bad-old-key"}).json()["state"] == "rechazada"
    if isinstance(failure, Exception):
        get.side_effect = failure
    else:
        get.return_value = Mock(status_code=failure)
    saved = client.put(URL, json={"value": "try-this-new-key"})
    assert saved.status_code == 200 and saved.json()["state"] == "rechazada"
    assert saved.json()["verifiedAt"] is None
    assert config.genius_api_key == "try-this-new-key"
    assert config.secrets.get(GENIUS) == "try-this-new-key"
    assert "sensitive-exception" not in saved.text


@pytest.mark.parametrize("source", ["env", "file", "credentials-dir"])
def test_env_or_file_locks_both_apis_and_survives_app_attempts(nest, tmp_path, source):
    client, config, get, _ = nest
    config.secrets.put(GENIUS, "app-original")
    environment = {GENIUS: "operator-secret"}
    if source == "file":
        file = tmp_path / "injected"
        file.write_text("operator-secret")
        environment = {f"{GENIUS}_FILE": str(file)}
    elif source == "credentials-dir":
        directory = tmp_path / "operator"
        directory.mkdir()
        (directory / GENIUS).write_text("operator-secret")
        environment = {"CREDENTIALS_DIRECTORY": str(directory)}
    config._secrets = SecretStore(config.credentials_dir, config.instance_file, environment=environment)
    before = config.secrets.path.read_bytes()
    for path, body in ((URL, {"value": "attempted-replacement"}),
                       ("/api/config/genius", {"apiKey": "attempted-replacement"})):
        assert client.put(path, json=body).status_code == 409
        assert client.delete(path).status_code == 409
    row = next(row for row in client.get("/api/server/secrets").json()["secrets"] if row["name"] == GENIUS)
    assert row["locked"] and row["source"] == ("env" if source == "env" else "file")
    assert config.secrets.get(GENIUS) == "operator-secret"
    assert config.secrets.path.read_bytes() == before
    get.assert_not_called()


def test_spotify_pair_uses_one_probe_and_one_store_never_dotenv(nest):
    client, config, _, post = nest
    response = client.put("/api/config/spotify", json={"client_id": "pair-client", "client_secret": "pair-secret"})
    assert response.status_code == 200
    assert post.call_count == 1
    assert post.call_args.kwargs["auth"] == ("pair-client", "pair-secret")
    assert not (config.credentials_dir.parent / ".env").exists()
    for name in ("SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"):
        assert config.secrets.describe(name)["verifiedAt"]
    assert client.put("/api/config/spotify", json={"client_id": "••••••••", "client_secret": "••••••••"}).status_code == 200
    assert post.call_count == 1


@pytest.mark.parametrize("status,error,state", [(400, "invalid_client", "rechazada"),
                                                (400, "invalid_grant", "rechazada"),
                                                (400, "echo-private-value", "guardada"),
                                                (429, "invalid_client", "guardada")])
def test_spotify_only_typed_permanent_errors_reject(nest, status, error, state):
    client, config, _, post = nest
    config.secrets.put("SPOTIFY_CLIENT_ID", "client")
    post.return_value = Mock(status_code=status, json=lambda: {"error": error})
    response = client.put("/api/server/secrets/SPOTIFY_CLIENT_SECRET", json={"value": "spotify-private"})
    assert response.status_code == 200 and response.json()["state"] == state
    assert response.json()["reason"] == (error if state == "rechazada" else None)
    assert post.call_count == 1


def test_incomplete_spotify_pair_remains_unverified(nest):
    client, _, _, post = nest
    response = client.put("/api/server/secrets/SPOTIFY_CLIENT_ID", json={"value": "client-only"})
    assert response.json()["state"] == "guardada" and response.json()["verifiedAt"] is None
    post.assert_not_called()


@pytest.mark.parametrize("role", ["member", "guest"])
def test_all_secret_routes_are_owner_only(nest, role):
    client, _, get, _ = nest
    app.dependency_overrides[current_principal] = lambda: Principal("user", "User", role)
    assert client.get("/api/server/secrets").status_code == 403
    assert client.put(URL, json={"value": "must-not-save"}).status_code == 403
    assert client.delete(URL).status_code == 403
    get.assert_not_called()


def test_changed_key_config_still_boots_and_status_remains_available(nest, monkeypatch):
    client, config, get, _ = nest
    assert client.put(URL, json={"value": "unreadable-after-change"}).status_code == 200
    (config.credentials_dir / ".key").write_bytes(Fernet.generate_key())
    restarted = ConfigManager(data_root=config.data_root, base_music_dir=config.base_music_dir, playlist_dir=config.playlist_dir,
                              temp_dir=config.temp_dir, log_dir=config.log_dir, credentials_dir=config.credentials_dir)
    restarted.validate()
    app.dependency_overrides[get_config] = lambda: restarted
    monkeypatch.setattr(app.state, "config", restarted)
    assert restarted.genius_api_key is None
    assert client.get("/api/status").status_code == 200
    status = client.get("/api/server/secrets")
    assert status.status_code == 200
    assert all(row["state"] == "ilegible" and row["reason"] == "llave-distinta" for row in status.json()["secrets"])
    assert client.put(URL, json={"value": "cannot-replace"}).status_code == 409
    assert get.call_count == 1


def test_grep_entire_run_logs_and_api_bodies_for_all_submitted_values(nest, caplog, monkeypatch):
    client, config, get, post = nest
    values = ["grep-genius-private-71", "grep-spotify-client-72", "grep-spotify-secret-73",
              "grep-refresh-private-74", "grep-api-token-private-75", "grep-invalid-secret-76"]  # gitleaks:allow
    names = (GENIUS, "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "SPOTIFY_REFRESH_TOKEN", "KROBI_API_TOKEN")
    config.api_token = values[4]
    monkeypatch.setattr(app.state, "config", config)
    client.headers["Authorization"] = f"Bearer {values[4]}"
    get.return_value = Mock(status_code=401, text=values[0])
    responses = []
    with caplog.at_level(logging.DEBUG):
        for name, value in zip(names, values, strict=False):
            responses.append(client.put(f"/api/server/secrets/{name}", json={"value": value}))
        responses.append(client.get("/api/server/secrets"))
        responses.append(client.put(URL, json={"value": {"bad": values[-1]}}))
        responses.append(client.put(URL, json={"value": values[-1] + "\nBAD=echo"}))
        responses.append(client.put("/api/config/genius", json={"apiKey": {"bad": values[-1]}}))
        responses.append(client.put("/api/config/spotify", json={"client_secret": {"bad": values[-1]}}))
        for name in names:
            responses.append(client.delete(f"/api/server/secrets/{name}"))
    emitted = '\n'.join([caplog.text, *[r.text for r in responses],
                         *[p.read_text() for p in config.log_dir.glob("*.log")]])
    for value in values:
        assert value not in emitted
    assert "owner-id" in emitted and "saved" in emitted and "removed" in emitted
    for response in responses:
        if response.request.url.path.endswith("/KROBI_API_TOKEN"):
            assert response.status_code == 404
        else:
            assert response.status_code in (200, 422)
    assert '"value"' not in responses[5].text


def test_unknown_or_internal_secret_cannot_be_modified(nest):
    client, _, get, _ = nest
    for name in ("unknown", "subsonic-app-passwords", "KROBI_API_TOKEN"):
        assert client.put(f"/api/server/secrets/{name}", json={"value": "never-accept"}).status_code == 404
        assert client.delete(f"/api/server/secrets/{name}").status_code == 404
    get.assert_not_called()


def test_refresh_verification_keeps_rotated_token_from_the_single_probe(nest):
    client, config, _, post = nest
    config.secrets.put("SPOTIFY_CLIENT_ID", "client")
    config.secrets.put("SPOTIFY_CLIENT_SECRET", "client-secret")
    post.return_value = Mock(status_code=200, json=lambda: {"access_token": "transient", "refresh_token": "rotated-private"})
    response = client.put("/api/server/secrets/SPOTIFY_REFRESH_TOKEN", json={"value": "initial-refresh"})
    assert response.status_code == 200 and response.json()["verifiedAt"]
    assert post.call_count == 1
    assert config.secrets.get("SPOTIFY_REFRESH_TOKEN") == "rotated-private"
    assert config.spotify_refresh_token == "rotated-private"
    assert "rotated-private" not in response.text


@pytest.mark.parametrize("action", ["login", "disconnect", "callback"])
def test_oauth_compatibility_routes_cannot_bypass_external_refresh_lock(nest, action):
    from app.domains.metadata.spotify_auth import SpotifyAuth
    client, config, _, post = nest
    config._secrets = SecretStore(config.credentials_dir, config.instance_file,
                                  environment={"SPOTIFY_REFRESH_TOKEN": "operator-refresh"})
    auth = SpotifyAuth(config, logging.getLogger("test.oauth"))
    auth._pending_state = "state"
    app.dependency_overrides[get_spotify_auth] = lambda: auth
    try:
        response = client.post("/api/spotify/disconnect") if action == "disconnect" else client.get(
            f"/api/spotify/{action}", params={"code": "code", "state": "state"}, follow_redirects=False)
        assert response.status_code == 409
        assert config.secrets.get("SPOTIFY_REFRESH_TOKEN") == "operator-refresh"
        post.assert_not_called()
    finally:
        app.dependency_overrides.pop(get_spotify_auth, None)


def test_oauth_exception_is_never_logged_or_reflected(nest, caplog):
    client, _, _, _ = nest
    auth = Mock()
    auth.exchange_code.side_effect = requests.RequestException("oauth-secret-must-stay-private")
    app.dependency_overrides[get_spotify_auth] = lambda: auth
    try:
        with caplog.at_level(logging.DEBUG):
            response = client.get("/api/spotify/callback", params={"code": "code", "state": "state"})
        assert "oauth-secret-must-stay-private" not in caplog.text + response.text
    finally:
        app.dependency_overrides.pop(get_spotify_auth, None)
