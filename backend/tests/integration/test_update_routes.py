from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from app.infra import env_sources
from app.infra.updates import UpdateChecker
from app.dependencies import DependencyContainer
from app.main import app, _start_update_check, _stop_update_check


@pytest.fixture
def nest(config, monkeypatch):
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(app.state, "container", container)
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    checker = UpdateChecker(config, transport=Mock(side_effect=AssertionError("outbound must not run")))
    container._services["update_checker"] = checker
    store = container.get_token_store()
    _, owner = store.mint("Owner", "owner")
    _, member = store.mint("Member", "member")
    yield TestClient(app, client=("192.0.2.8", 50000)), config, checker, owner, member
    checker.stop()


def auth(token):
    return {"Authorization": f"Bearer {token}"} if token else {}


def test_update_route_no_outbound(nest):
    client, config, checker, owner, _ = nest
    for _ in range(3):
        body = client.get("/api/server/update", headers=auth(owner)).json()
        assert body["latest"] is None and not body["updateAvailable"]
    config.update_check_file.write_text('{"latest":"2.2.0","releaseTag":"v2.2.0"}')
    assert client.get("/api/server/update", headers=auth(owner)).json()["updateAvailable"]
    checker.transport.assert_not_called()


@pytest.mark.parametrize("role,status", [("owner", 200), ("member", 403), ("none", 401)])
@pytest.mark.parametrize("method,path", [("GET", "/api/server/update"), ("POST", "/api/server/update/check")])
def test_update_route_roles(nest, role, status, method, path):
    client, config, checker, owner, member = nest
    config.update_check = False
    result = client.request(method, path, headers=auth({"owner": owner, "member": member, "none": None}[role]))
    assert result.status_code == status
    checker.transport.assert_not_called()
    assert not any("update" in key.lower() for key in client.get("/api/status").json())


def test_update_toggle_queues_once_and_env_lock(nest, monkeypatch):
    client, config, checker, owner, _ = nest
    monkeypatch.setattr(checker, "refresh", Mock())
    config.update_check = False
    for _ in range(2):
        assert client.put("/api/server/config", json={"changes": {"KROBI_UPDATE_CHECK": True}}, headers=auth(owner)).status_code == 200
    checker.refresh.assert_called_once_with()
    assert "KROBI_UPDATE_CHECK=true" in (config.credentials_dir.parent / ".env").read_text()
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset(["KROBI_UPDATE_CHECK"]))
    assert client.put("/api/server/config", json={"changes": {"KROBI_UPDATE_CHECK": False}}, headers=auth(owner)).status_code == 409
    assert config.update_check


def test_update_disabled_startup_and_route(nest):
    client, config, checker, owner, _ = nest
    config.update_check = False
    _start_update_check()
    assert client.post("/api/server/update/check", headers=auth(owner)).status_code == 200
    assert not client.get("/api/server/update", headers=auth(owner)).json()["checking"]
    _stop_update_check()
    checker.transport.assert_not_called()


def test_update_manual_accepted_then_floored(nest):
    import requests
    client, config, checker, owner, _ = nest
    checker.transport.side_effect = requests.Timeout()
    first = client.post("/api/server/update/check", headers=auth(owner))
    assert first.status_code == 202 and first.json()["lastError"] == "unreachable"
    second = client.post("/api/server/update/check", headers=auth(owner))
    assert second.status_code == 200 and second.json() == first.json()
    checker.transport.assert_called_once()
