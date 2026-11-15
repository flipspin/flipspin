"""Identity regressions across real accounts and device credentials.

Unknown tokens never gain local authority or widen account access.
Preserve credential-vault cleanup and real-owner administration gates.
See docs/security.md#request-authentication.
"""
import json
import logging
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.main import app


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_unresolved_loopback_token_never_inherits_owner(accounts, monkeypatch):
    accounts.mint("Owner", "owner")
    revoked, token = accounts.mint("Revoked", "member")
    accounts.revoke(revoked.user_id)
    client = TestClient(app, client=("127.0.0.1", 50000))
    for allow_remote in (False, True):
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", allow_remote)
        assert client.get("/api/me").json()["source"] == "local"
        for invalid in (token, "unknown-token"):
            for headers, query in [(auth(invalid), ""), ({"X-Krobi-Token": invalid}, ""),
                                   ({}, f"?access_token={invalid}")]:
                assert client.get(f"/api/me{query}", headers=headers).status_code == 401


@pytest.mark.parametrize("target", ["ana", "unknown", None])
@pytest.mark.parametrize("action", ["approve", "inspect", "decline"])
def test_typed_sign_in_codes_are_scoped_to_target(accounts, target, action):
    client = TestClient(app)
    ana, ana_token = accounts.mint("Ana", "member")
    accounts.set_username(ana.user_id, "ana")
    _, other_token = accounts.mint("Other", "member")
    ticket = client.post("/api/sign-in-code", json={"username": target, "deviceLabel": "TV"}).json()

    def act(code, token):
        if action == "approve":
            return client.post("/api/me/sign-in-code", json={"code": code}, headers=auth(token))
        path = f"/api/me/sign-in-code/{code}"
        if action == "inspect":
            return client.get(path, headers=auth(token))
        return client.post(path + "/decline", headers=auth(token))

    missing = act("ZZZZZZ", other_token)
    wrong = act(ticket["code"], other_token)
    if target is None:
        assert wrong.status_code == 200
    else:
        assert (wrong.status_code, wrong.json()) == (missing.status_code, missing.json())
        right = act(ticket["code"], ana_token)
        assert right.status_code == (200 if target == "ana" else missing.status_code)


@pytest.mark.parametrize("removal", ["own", "owner", "person", "startup"])
def test_app_password_copies_are_removed_with_devices(accounts, monkeypatch, config, removal):
    from app.domains.subsonic.app_passwords import AppPasswordVault
    from app.infra.security import CredentialsRepository

    container = app.state.container
    credentials = CredentialsRepository(config, logging.getLogger(__name__))
    vault = AppPasswordVault(credentials)
    monkeypatch.setattr(container, "get_app_password_vault", lambda: vault)
    _, owner_token = accounts.mint("Owner", "owner")
    member, token = accounts.mint("Member", "member")
    client = TestClient(app)
    reply = client.post("/api/me/devices/app-password", json={"label": "Player"}, headers=auth(token))
    assert reply.status_code == 201
    device_id = reply.json()["device"]["id"]
    password = reply.json()["token"]
    retained = client.post("/api/me/devices/app-password", json={"label": "Other player"}, headers=auth(token)).json()
    retained_id = retained["device"]["id"]
    vault.remember("other-stale-device", "stale-copy")
    assert vault.for_devices([device_id]) == [password]
    assert password.encode() not in (config.credentials_dir / "secrets.json").read_bytes()
    if removal == "startup":
        accounts.revoke_device(member.user_id, device_id)
        # Invoke the registered cleanup handler without starting engines or networking.
        for handler in app.router.on_startup:
            if "app_password" in handler.__name__:
                handler()
    else:
        path, caller = {
            "own": (f"/api/me/devices/{device_id}", token),
            "owner": (f"/api/users/{member.user_id}/devices/{device_id}", owner_token),
            "person": (f"/api/users/{member.user_id}", owner_token),
        }[removal]
        assert client.delete(path, headers=auth(caller)).status_code == 200
    assert vault.for_devices([device_id]) == []
    # A fresh vault proves the encrypted repository was updated, not just its cache.
    reloaded = AppPasswordVault(CredentialsRepository(config, logging.getLogger(__name__)))
    assert reloaded.for_devices([device_id]) == []
    assert reloaded.for_devices([retained_id]) == ([] if removal == "person" else [retained["token"]])
    if removal == "startup":
        assert vault.for_devices(["other-stale-device"]) == []


def test_helper_is_only_set_by_explicit_field(accounts):
    owner, token = accounts.mint("Owner", "owner")
    _, direct, _ = accounts.add_device(owner.user_id, "Label · trabajador")
    assert direct.helper is False
    client = TestClient(app)
    for role in ("owner", "member"):
        user, caller = (owner, token) if role == "owner" else accounts.mint("Member", "member")
        reply = client.post("/api/me/devices", json={"label": "Label · trabajador"}, headers=auth(caller))
        assert reply.status_code == 201
        assert accounts.get_user(user.user_id).device(reply.json()["device"]["id"]).helper is False
    _, helper, _ = accounts.add_device(owner.user_id, "Explicit", helper=True)
    # A preexisting label without a helper flag must not acquire one on load.
    stored = json.loads(accounts.path.read_text())
    for row in stored["users"]:
        for device in row["devices"]:
            if device["id"] == direct.device_id:
                device.pop("helper", None)
    accounts.path.write_text(json.dumps(stored))
    # Stored flags survive reload and renaming, regardless of the label.
    from app.domains.accounts.identity import TokenStore
    reloaded = TokenStore(accounts.path)
    assert reloaded.get_user(owner.user_id).device(direct.device_id).helper is False
    assert reloaded.get_user(owner.user_id).device(helper.device_id).helper is True
    assert client.patch(f"/api/me/devices/{helper.device_id}", json={"label": "Renamed"},
                        headers=auth(token)).json()["helper"] is True


@pytest.mark.parametrize("caller", ["local", "shared", "member", "owner"])
@pytest.mark.parametrize("action", ["create", "delete", "rename", "password"])
def test_account_administration_requires_real_owner(accounts, monkeypatch, caller, action):
    _, owner_token = accounts.mint("Owner", "owner")
    target, member_token = accounts.mint("Member", "member")
    accounts.set_username(target.user_id, "member")
    tokens = {"local": None, "shared": "shared-token", "member": member_token, "owner": owner_token}
    if caller == "shared":
        monkeypatch.setattr(app.state.config, "api_token", "shared-token")
    headers = auth(tokens[caller]) if tokens[caller] else {}
    client = TestClient(app, client=("127.0.0.1", 50000))
    if action == "delete":
        reply = client.delete(f"/api/users/{target.user_id}", headers=headers)
    else:
        path, body = {
            "create": ("/api/users", {"label": "New member", "role": "member"}),
            "rename": (f"/api/users/{target.user_id}/label", {"label": "Renamed"}),
            "password": (f"/api/users/{target.user_id}/password", {"newPassword": "new-password-163"}),
        }[action]
        reply = client.post(path, json=body, headers=headers)
    assert reply.status_code == ({"local": 409, "shared": 409, "member": 403}.get(caller, 201 if action == "create" else 200))


@pytest.mark.parametrize("kind", ["download", "lyrics-helper", "stems"])
@pytest.mark.parametrize("state", ["queued", "running"])
def test_jobs_without_starter_are_interrupted_never_owner(tmp_path, kind, state):
    from app.infra.identity import LOCAL_OWNER
    from app.infra.jobs import Jobs
    from app.infra.jobs_runtime import starter_for

    container = Mock()
    with pytest.raises(ValueError, match="starter-unavailable"):
        starter_for(container, {"starter_user_id": None})
    container.get_token_store.assert_not_called()
    assert starter_for(container, {"starter_user_id": LOCAL_OWNER.user_id}) is LOCAL_OWNER
    ledger = Jobs(tmp_path / "jobs.sqlite")
    try:
        payload = [{"item": "Song", "detail": {"_retry": {"producer": "download"}}}]
        orphan = ledger.start(kind, "Unknown starter", payload)
        owned = ledger.start(kind, "Known starter", payload, "member")
        if state == "running":
            ledger.running(orphan, 1)
        assert [job["id"] for job in ledger.boot()] == [owned]
        assert ledger.get(orphan)["state"] == "interrupted"
        assert ledger.get(orphan)["ended_at"] is not None
        assert ledger.items(orphan)[0]["state"] == "interrupted"
    finally:
        ledger.close()
