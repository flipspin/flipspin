"""Subsonic credentials, authentication failures, and device revocation."""
import hashlib
import json
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from app.domains.subsonic import auth as subsonic_auth
from app.main import app
from tests.integration import test_subsonic as fixtures
from tests.integration.test_subsonic import call, failed, mint_api_key, ok

nest = fixtures.nest


def test_the_app_password_is_typeable(nest):
    password = nest["app_password"]
    assert len(password) == 19 and password.count("-") == 3


def test_plain_and_hex_passwords_sign_in(nest):
    ok(call(nest, "ping"))
    ok(call(nest, "ping", p="enc:" + nest["app_password"].encode().hex()))


def test_token_auth_with_a_salt(nest):
    salt = "c19b2d"
    token = hashlib.md5((nest["app_password"] + salt).encode()).hexdigest()
    ok(call(nest, "ping", auth=False, u="ana", t=token, s=salt))


def test_an_api_key_is_a_device_token(nest):
    response = nest["client"].get("/rest/ping", params={"apiKey": nest["owner_token"], "f": "json"})
    ok(response)
    response = nest["client"].get("/rest/ping", params={"apiKey": "nope", "f": "json"})
    failed(response, 44)
    response = nest["client"].get("/rest/ping", params={"apiKey": nest["owner_token"], "u": "ana", "f": "json"})
    failed(response, 43)


@pytest.mark.parametrize("role", ["owner", "member"])
def test_api_key_mint_list_revoke_is_scoped_to_the_calling_account(nest, role):
    store = app.state.container.get_token_store()
    _, other_token = store.mint("Luz", username="luz")
    caller_token = nest["owner_token"] if role == "owner" else other_token
    caller = store.resolve(caller_token)
    made = mint_api_key(nest, caller_token, userId="somebody-else", helper=True)
    headers = {"Authorization": f"Bearer {caller_token}"}
    key = made["token"]
    assert store.resolve(key).user_id == caller.user_id
    assert store.resolve(key).role == caller.role
    device = next(d for d in nest["client"].get("/api/me/devices", headers=headers).json()["devices"]
                  if d["id"] == made["device"]["id"])
    assert device["helper"] is False
    assert "token" not in device and "token_sha256" not in device
    ok(call(nest, "getArtists", auth=False, apiKey=key))
    ok(nest["client"].post("/rest/ping.view", data={"apiKey": key, "f": "json"}))
    # Another account cannot list or revoke this key, regardless of its id.
    outsider = other_token if role == "owner" else nest["owner_token"]
    other_headers = {"Authorization": f"Bearer {outsider}"}
    listed = nest["client"].get("/api/me/devices", headers=other_headers).json()["devices"]
    assert made["device"]["id"] not in {d["id"] for d in listed}
    assert nest["client"].delete(f"/api/me/devices/{device['id']}", headers=other_headers).status_code == 404
    assert nest["client"].delete(f"/api/me/devices/{device['id']}", headers=headers).status_code == 200
    failed(call(nest, "ping", auth=False, apiKey=key), 44)
    # Minting and revoking a key never changes the app password.
    ok(call(nest, "ping"))


def test_api_key_has_only_a_sha256_verifier_at_rest(nest):
    container = app.state.container
    credentials = container.get_credentials_repository()
    before = credentials.load_credentials("subsonic-app-passwords")
    made = mint_api_key(nest)
    key = made["token"]
    store = container.get_token_store()
    rows = json.loads(store.path.read_text())
    serialized = json.dumps(rows)
    assert hashlib.sha256(key.encode()).hexdigest() in serialized
    assert key not in serialized
    assert credentials.load_credentials("subsonic-app-passwords") == before
    assert container.get_app_password_vault().for_devices([made["device"]["id"]]) == []
    assert type(store)(store.path).resolve(key).device_id == made["device"]["id"]
    # Decrypt every record as well: ciphertext alone cannot prove one-way storage.
    secrets = app.state.config.secrets
    for name in secrets.records:
        assert key not in (secrets.get(name) or "")
    for path in store.path.parent.rglob("*"):
        if path.is_file():
            assert key.encode() not in path.read_bytes()


@pytest.mark.parametrize("extra", [
    {"u": "ana"}, {"u": ""}, {"p": ""}, {"p": "password"},
    {"t": "token"}, {"s": "salt"}, {"t": "token", "s": "salt"}, {"jwt": "jwt"},
])
@pytest.mark.parametrize("method", ["ping", "getOpenSubsonicExtensions"])
def test_api_key_rejects_all_conflicting_mechanisms(nest, extra, method):
    failed(call(nest, method, auth=False, apiKey=nest["owner_token"], **extra), 43)


@pytest.mark.parametrize("key", ["", "nope", " padded-key "])
def test_invalid_api_keys_fail_with_44(nest, key):
    failed(call(nest, "ping", auth=False, apiKey=key), 44)


def test_subsonic_throttle_is_per_ip_across_credentials(nest):
    key = mint_api_key(nest)["token"]
    for _ in range(subsonic_auth.throttle.burst):
        failed(call(nest, "ping", auth=False, apiKey="revoked"), 44)
    limited = failed(call(nest, "ping", auth=False, apiKey="revoked"), 0)
    assert "Demasiados intentos" in limited["error"]["message"]
    # Valid credentials still work; another invalid key shares the IP window.
    ok(call(nest, "ping", auth=False, apiKey=key))
    ok(call(nest, "ping"))
    failed(call(nest, "ping", auth=False, apiKey="another-invalid-key"), 0)
    other = TestClient(app, client=("192.0.2.9", 12345))
    failed(other.get("/rest/ping", params={"apiKey": "revoked", "f": "json"}), 44)
    ok(other.get("/rest/ping", params={"apiKey": key, "f": "json"}))
    failed(call(nest, "ping", auth=False, apiKey="revoked", u="ana"), 43)
    failed(call(nest, "ping", auth=False, jwt="unsupported"), 42)


def test_subsonic_stale_token_cannot_block_valid_password_on_same_ip(nest):
    for _ in range(subsonic_auth.throttle.burst):
        failed(call(nest, "ping", auth=False, u="ana", t="bad", s="salt"), 40)
    failed(call(nest, "ping", auth=False, u="ana", t="bad", s="salt"), 0)
    salt = "different"
    digest = hashlib.md5((nest["app_password"] + salt).encode()).hexdigest()
    ok(call(nest, "ping", auth=False, u="ana", t=digest, s=salt))


@pytest.mark.parametrize("encoded", [False, True])
def test_minted_api_key_also_works_as_password_but_not_salted_token(nest, encoded):
    made = mint_api_key(nest)
    key = made["token"]
    ok(call(nest, "ping", p="enc:" + key.encode().hex() if encoded else key))
    digest = hashlib.md5((key + "salt").encode()).hexdigest()
    failed(call(nest, "ping", auth=False, u="ana", t=digest, s="salt"), 41)
    # App passwords still support token auth even on an account with API keys.
    test_token_auth_with_a_salt(nest)


@pytest.mark.parametrize("method", ["get", "post"])
def test_subsonic_token_info_json_xml_and_revocation(nest, method):
    made = mint_api_key(nest)
    key = made["token"]
    params = {"apiKey": key, "c": "Crossonic", "f": "json"}
    request = getattr(nest["client"], method)
    kwargs = {"params" if method == "get" else "data": params}
    assert ok(request("/rest/tokenInfo.view", **kwargs))["tokenInfo"] == {"username": "ana"}
    params.pop("f")
    root = ET.fromstring(request("/rest/tokenInfo", **kwargs).content)
    assert root.find("{http://subsonic.org/restapi}tokenInfo").get("username") == "ana"
    nest["client"].delete(f"/api/me/devices/{made['device']['id']}",
                          headers={"Authorization": f"Bearer {nest['owner_token']}"})
    failed(call(nest, "tokenInfo", auth=False, apiKey=key), 44)


def test_subsonic_first_connection_and_attributed_failure_survive_reload(nest, monkeypatch):
    from app.domains.accounts import identity
    made = mint_api_key(nest)
    store = app.state.container.get_token_store()
    headers = {"Authorization": f"Bearer {nest['owner_token']}"}

    def row():
        return next(d for d in nest["client"].get("/api/me/devices", headers=headers).json()["devices"]
                    if d["id"] == made["device"]["id"])

    assert row()["credentialType"] == "api-key"
    assert row()["firstSubsonicRequestAt"] is None
    # The supplied key lets us identify the row without counting it as use.
    failed(call(nest, "ping", auth=False, apiKey=made["token"], t="bad", s="salt"), 43)
    rejected = row()
    assert rejected["lastSubsonicFailure"] == "wrong-mechanism"
    assert rejected["lastSubsonicFailureAt"]
    assert rejected["firstSubsonicRequestAt"] is None and rejected["lastSeenAt"] is None
    store.reload()
    assert row()["lastSubsonicFailure"] == "wrong-mechanism"
    # A token-only failure cannot be attributed to a specific verifier-only key.
    failed(call(nest, "ping", auth=False, u="ana", t="bad", s="salt"), 41)
    assert row()["firstSubsonicRequestAt"] is None
    ok(nest["client"].get("/rest/ping", params={"apiKey": made["token"], "c": "Crossonic 1.2", "f": "json"}))
    connected = row()
    assert connected["firstSubsonicRequestAt"] == connected["lastSubsonicRequestAt"]
    assert connected["subsonicClientName"] == "Crossonic 1.2"
    monkeypatch.setattr(identity, "utc_now_iso", lambda: "2030-01-01T00:00:00Z")
    ok(nest["client"].get("/rest/ping", params={"apiKey": made["token"], "c": "Crossonic 2", "f": "json"}))
    assert row()["firstSubsonicRequestAt"] == connected["firstSubsonicRequestAt"]
    assert row()["lastSubsonicRequestAt"] == "2030-01-01T00:00:00Z"
    assert row()["subsonicClientName"] == "Crossonic 2"
    store.reload()
    assert row()["firstSubsonicRequestAt"] == connected["firstSubsonicRequestAt"]
    assert row()["lastSubsonicRequestAt"] == "2030-01-01T00:00:00Z"
    assert row()["subsonicClientName"] == "Crossonic 2"


def test_unsupported_authentication_mechanism_fails_with_42(nest):
    failed(call(nest, "ping", auth=False, jwt="not-supported"), 42)
    failed(call(nest, "ping", auth=False, jwt="not-supported", u="ana", p=nest["app_password"]), 43)


def test_password_and_salted_token_conflict(nest):
    failed(call(nest, "ping", t="token", s="salt"), 43)


def test_query_and_form_conflicts_are_not_hidden_by_parameter_precedence(nest):
    key = mint_api_key(nest)["token"]
    failed(nest["client"].post("/rest/ping.view", params={"apiKey": key},
                               data={"apiKey": "another", "f": "json"}), 43)
    failed(nest["client"].post("/rest/ping.view", params={"apiKey": key},
                               data={"u": "", "f": "json"}), 43)


def test_authentication_errors_also_render_as_xml(nest):
    for params, code in [({"jwt": "unsupported"}, 42), ({"apiKey": "x", "p": ""}, 43),
                         ({"apiKey": ""}, 44)]:
        root = ET.fromstring(nest["client"].get("/rest/ping.view", params=params).content)
        assert root.find("{http://subsonic.org/restapi}error").get("code") == str(code)


def test_the_account_password_is_not_accepted(nest):
    failed(call(nest, "ping", p="una-contra-larga"), 40)


def test_missing_and_wrong_credentials(nest):
    failed(call(nest, "ping", auth=False), 10)
    failed(call(nest, "ping", p="aaaa-bbbb-cccc-dddd"), 40)
    failed(call(nest, "ping", u="nadie"), 40)


def test_a_revoked_app_password_stops_working(nest):
    nest["client"].delete(f"/api/me/devices/{nest['device']['id']}",
                          headers={"Authorization": f"Bearer {nest['owner_token']}"})
    failed(call(nest, "ping"), 40)


def test_extensions_answer_without_credentials(nest):
    data = ok(call(nest, "getOpenSubsonicExtensions", auth=False))
    names = {e["name"] for e in data["openSubsonicExtensions"]}
    assert {"formPost", "apiKeyAuthentication", "songLyrics"} <= names


def test_xml_is_the_default_and_well_formed(nest):
    response = call(nest, "getArtists", fmt=None)
    assert response.headers["content-type"].startswith("application/xml")
    root = ET.fromstring(response.content)
    ns = "{http://subsonic.org/restapi}"
    assert root.tag == f"{ns}subsonic-response" and root.get("status") == "ok"
    assert root.get("openSubsonic") == "true"
    names = [a.get("name") for a in root.iter(f"{ns}artist")]
    assert names == ["Café Tacvba", "Daft Punk"]


def test_post_form_parameters_work(nest):
    response = nest["client"].post("/rest/ping.view", data={"u": "ana", "p": nest["app_password"], "f": "json"})
    ok(response)
