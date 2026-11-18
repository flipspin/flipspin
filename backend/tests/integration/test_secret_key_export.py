"""Key export requires the caller's own password and never logs key material."""
import logging

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.dependencies import get_config, get_token_store
from app.domains.accounts import passwords
from app.domains.accounts.identity import TokenStore
from app.infra.secrets import SecretStore
from app.main import app

URL = "/api/server/secrets/key/export"
PASSWORD = "fixture-export-passphrase"


@pytest.fixture
def export_nest(config, monkeypatch):
    config.api_token = None
    store = TokenStore(config.credentials_dir / "export-users.json", logging.getLogger(__name__))
    owner, token = store.mint("Cuenta de prueba", "owner")
    store.set_username(owner.user_id, "cuenta-prueba")
    store.set_password(owner.user_id, PASSWORD)
    monkeypatch.setitem(app.dependency_overrides, get_config, lambda: config)
    monkeypatch.setitem(app.dependency_overrides, get_token_store, lambda: store)
    passwords.login_throttle.reset()
    yield TestClient(app, headers={"Authorization": f"Bearer {token}"}), config, store, owner
    passwords.login_throttle.reset()


def test_secret_key_export_is_attachment_with_complete_validated_ring(export_nest, tmp_path, caplog):
    client, config, _, owner = export_nest
    config.secrets.put("KROBI_GENIUS_API_KEY", "fixture-provider-private")
    old = (config.credentials_dir / ".key").read_bytes().strip()
    keys = Fernet.generate_key() + b"\n" + old + b"\n"
    ring = tmp_path / "ring"
    ring.write_bytes(keys)
    config._secrets = SecretStore(config.credentials_dir, config.instance_file,
                                  environment={"KROBI_SECRET_KEY_FILE": str(ring)})
    # The running nest exports what it validated, even if the file is replaced.
    ring.write_bytes(Fernet.generate_key())
    with caplog.at_level(logging.DEBUG):
        response = client.post(URL, json={"password": PASSWORD})
    fingerprint = config.secrets.key_info["fingerprint"]
    assert response.status_code == 200
    assert response.content == keys
    assert response.headers["content-disposition"] == f'attachment; filename="krobi-nido-{fingerprint}.key"'
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "application/octet-stream"
    assert owner.user_id in caplog.text and "Nest key exported" in caplog.text
    for value in [*keys.decode().split(), PASSWORD, "fixture-provider-private"]:
        assert value not in caplog.text


def test_secret_key_export_wrong_password_and_caller_account(export_nest):
    client, _, store, _ = export_nest
    assert client.post(URL, json={"password": "wrong-password"}).status_code == 401
    other, token = store.mint("Otra cuenta", "owner")
    store.set_username(other.user_id, "otra-cuenta")
    store.set_password(other.user_id, "different-passphrase")
    client.headers["Authorization"] = f"Bearer {token}"
    assert client.post(URL, json={"password": PASSWORD}).status_code == 401


@pytest.mark.parametrize("role", ["member", "guest"])
def test_secret_key_export_refuses_non_owner(export_nest, role):
    client, _, store, _ = export_nest
    _, token = store.mint("Cuenta de prueba", role)
    client.headers["Authorization"] = f"Bearer {token}"
    assert client.post(URL, json={"password": PASSWORD}).status_code == 403


@pytest.mark.parametrize("sentinel", [True, False])
def test_secret_key_export_explains_missing_account_password(export_nest, sentinel):
    client, _, store, _ = export_nest
    if sentinel:
        client.headers.pop("Authorization")
    else:
        _, token = store.mint("Cuenta sin contraseña", "owner")
        client.headers["Authorization"] = f"Bearer {token}"
    response = client.post(URL, json={"password": PASSWORD})
    assert response.status_code == 409
    assert response.json()["detail"] == "account-password-required"


def test_secret_key_export_uses_sign_in_throttle(export_nest):
    client, _, _, _ = export_nest
    for _ in range(passwords.LOGIN_FAILURE_BURST):
        assert client.post(URL, json={"password": "wrong-password"}).status_code == 401
    response = client.post(URL, json={"password": PASSWORD})
    assert response.status_code == 429 and int(response.headers["Retry-After"]) > 0


def test_secret_key_export_unreadable_key_is_not_downloaded(export_nest):
    client, config, _, _ = export_nest
    config.secrets.unreadable = True
    response = client.post(URL, json={"password": PASSWORD})
    assert response.status_code == 409 and response.json()["detail"] == "llave-distinta"


@pytest.mark.parametrize("value", [{"private": "invalid-password-private"}, "invalid-password-private" * 30])
def test_secret_key_export_validation_does_not_echo_input(export_nest, value, caplog):
    client, _, _, _ = export_nest
    with caplog.at_level(logging.DEBUG):
        response = client.post(URL, json={"password": value})
    assert response.status_code == 422
    assert "invalid-password-private" not in response.text + caplog.text


def test_secret_status_counts_encrypted_values_without_returning_them(export_nest):
    client, config, _, _ = export_nest
    config.secrets.put("KROBI_GENIUS_API_KEY", "fixture-source-private")
    config.secrets.save_credentials("subsonic-app-passwords", {"app-1": "fixture-app-private", "app-2": "fixture-app-other"})
    response = client.get("/api/server/secrets")
    assert response.json()["counts"] == {"sources": 1, "appPasswords": 2}
    assert "fixture-source-private" not in response.text and "fixture-app-private" not in response.text
    config.secrets.unreadable = True
    assert client.get("/api/server/secrets").json()["counts"]["appPasswords"] is None
