"""Account-scoped sign-in requests through the real authentication gate.

Keep approval scoped to real accounts and enforce network restrictions.
Credential redemption still requires the separate polling secret.
See docs/security.md#sign-in-codes.
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.infra import remote_access
from app.domains.accounts.identity import hash_token
from app.main import app

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "contracts/sign-in-code.json").read_text())


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def account(store, name):
    row, token = store.mint(name, "member")
    store.set_username(row.user_id, name)
    return row, token


def request(client, username="ana"):
    response = client.post("/api/sign-in-code", json={"username": username, "deviceLabel": "TV"})
    assert response.status_code == 201
    return response.json()


def listing(client, token):
    response = client.get("/api/me/sign-in-requests", headers=auth(token))
    assert response.status_code == 200
    return response.json()["requests"]


@pytest.mark.parametrize("case", CONTRACT["network"], ids=lambda c: c["via"])
def test_network_contract(accounts, monkeypatch, case):
    clients = {"local": "192.168.1.5", "vpn": "10.9.0.2", "tailscale": "100.100.1.2",
               "proxy": "203.0.113.5", "open-port": "203.0.113.5"}
    monkeypatch.setattr(remote_access, "local_topology", lambda: (["192.168.1.0/24"], "192.168.1.1"))
    client = TestClient(app, client=(clients[case["via"]], 51000))
    _, token = account(accounts, "ana")
    response = client.post("/api/sign-in-code", json={"username": "ana", "deviceLabel": "TV"},
                           headers={"x-forwarded-for": "203.0.113.5"} if case["via"] == "proxy" else {})
    assert response.status_code == (201 if case["allowed"] else 403)
    if case["allowed"]:
        row = listing(client, token)[0]
        assert row["network"] == ("local" if case["via"] == "local" else "vpn")
        stored = vars(app.state.container.get_sign_in_codes()._pending[hash_token(response.json()["secret"])])
        assert clients[case["via"]] not in str(stored)
        assert set(row) == {"id", "deviceLabel", "network", "createdAt", "expiresAt", "code"}
    else:
        assert response.json() == {"detail": "outside-network"}


def test_uses_middleware_resolved_client_not_raw_forwarded_header(accounts, monkeypatch):
    from starlette.middleware.base import BaseHTTPMiddleware

    # The production ASGI server resolves trusted forwarded headers before app middleware.
    # Exercise that same boundary without trusting raw headers inside the handler.
    class ResolvedClient(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            request.scope["client"] = ("203.0.113.5", 51000)
            return await call_next(request)

    from fastapi import FastAPI
    wrapped = FastAPI()
    wrapped.add_middleware(ResolvedClient)
    wrapped.mount("/", app)
    monkeypatch.setattr(remote_access, "local_topology", lambda: ([], None))
    response = TestClient(wrapped).post("/api/sign-in-code", json={"deviceLabel": "TV"},
                                        headers={"x-forwarded-for": "127.0.0.1"})
    assert response.status_code == 403


def test_username_scope_cap_unknown_and_no_enumeration(accounts):
    client = TestClient(app)
    ana, token = account(accounts, "Ana")
    _, other = account(accounts, "other")
    tickets = [request(client, name) for name in ["ANA", "ana", "Ana", " aNa "]]
    rows = listing(client, token)
    assert [r["code"] for r in rows] == [t["code"] for t in tickets[1:]]
    assert client.post("/api/sign-in-code/poll", json={"secret": tickets[0]["secret"]}).json() == {"credential": None}
    assert listing(client, other) == []
    unknown = request(client, "unknown")
    anonymous = request(client, None)
    assert set(unknown) == set(tickets[0]) == set(anonymous)
    assert len(listing(client, token)) == 3
    # An account created later cannot inherit an old request for an unknown username.
    _, late = account(accounts, "unknown")
    assert listing(client, late) == []
    assert client.post("/api/me/sign-in-code", json={"code": unknown["code"]}, headers=auth(other)).status_code == 404
    assert client.post("/api/sign-in-code/poll", json={"secret": unknown["secret"]}).json() == {"credential": None}


@pytest.mark.parametrize("decision", ["approve", "decline"])
def test_decision_scoped_to_account_and_one_time(accounts, decision):
    client = TestClient(app)
    ana, token = account(accounts, "ana")
    _, other = account(accounts, "other")
    ticket = request(client)
    row = listing(client, token)[0]
    path = f"/api/me/sign-in-requests/{row['id']}/{decision}"
    assert client.post(path, headers=auth(other)).status_code == 404
    # A signed-in account can decide even from an outside connection.
    outside = TestClient(app, client=("203.0.113.7", 50000))
    assert outside.post(path, headers=auth(token)).json() == {"success": True}
    assert listing(client, token) == []
    assert client.post(path, headers=auth(token)).status_code == 404
    result = client.post("/api/sign-in-code/poll", json={"secret": ticket["secret"]}).json()
    if decision == "decline":
        assert result == {"declined": True}
        assert len(accounts.get_user(ana.user_id).devices) == 1
    else:
        assert accounts.resolve(result["credential"]["token"]).user_id == ana.user_id
    assert client.post("/api/sign-in-code/poll", json={"secret": ticket["secret"]}).json() == {"credential": None}


def test_expiry_and_typed_sheet(accounts):
    client = TestClient(app)
    _, token = account(accounts, "ana")
    now = [1000.0]
    app.state.container.get_sign_in_codes().clock = lambda: now[0]
    ticket = request(client, None)
    row = client.get(f"/api/me/sign-in-code/{ticket['code'].lower()}", headers=auth(token)).json()
    assert row["code"] == ticket["code"] and row["deviceLabel"] == "TV"
    assert client.post(f"/api/me/sign-in-code/{ticket['code']}/decline", headers=auth(token)).status_code == 200
    assert client.post("/api/sign-in-code/poll", json={"secret": ticket["secret"]}).json() == {"declined": True}
    ticket = request(client)
    row = listing(client, token)[0]
    now[0] += 600
    assert listing(client, token) == []
    assert client.post(f"/api/me/sign-in-requests/{row['id']}/approve", headers=auth(token)).status_code == 404
    assert client.get(f"/api/me/sign-in-code/{ticket['code']}", headers=auth(token)).status_code == 404


@pytest.mark.parametrize("sentinel", ["local", "shared", "anonymous", "invalid", "missing"])
def test_real_account_gate_on_all_new_routes(accounts, monkeypatch, sentinel):
    client = TestClient(app, client=("127.0.0.1" if sentinel == "local" else "203.0.113.5", 51000))
    headers = {}
    if sentinel == "shared":
        monkeypatch.setattr(app.state.config, "api_token", "shared")
        headers = auth("shared")
    elif sentinel == "anonymous":
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
    elif sentinel == "invalid":
        headers = auth("invalid")
    for method, path in [("get", "/api/me/sign-in-requests"), ("post", "/api/me/sign-in-requests/id/approve"),
                         ("post", "/api/me/sign-in-requests/id/decline"), ("get", "/api/me/sign-in-code/ABC234"),
                         ("post", "/api/me/sign-in-code/ABC234/decline")]:
        response = getattr(client, method)(path, headers=headers)
        assert response.status_code == (401 if sentinel in ("invalid", "missing") else 409)
