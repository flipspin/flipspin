"""Host details stay owner-only; one unreadable fact never loses the others."""
from fastapi.testclient import TestClient

from app.infra import host_facts as facts
from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.main import app


def fail(*_args):
    raise OSError("unreadable")


def test_owner_shape_and_failed_reader(accounts, monkeypatch):
    _, token = accounts.mint("Owner", ROLE_OWNER)
    monkeypatch.setattr(facts.socket, "gethostname", fail)
    facts.static_facts.cache_clear()
    try:
        response = TestClient(app, client=("192.0.2.42", 51000)).get(
            "/api/server/host", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"hostname", "os", "kernel", "arch", "isolation", "hypervisor", "cpu", "memory",
                             "python", "bootedAt", "startedAt", "engine", "lastBackupAt", "lastBackupReason"}
        assert body["hostname"] is None
        assert set(body["cpu"]) == {"model", "cores"}
        assert body["startedAt"].endswith("Z")
        assert body["engine"] in ("local", "agent")
    finally:
        facts.static_facts.cache_clear()


def test_member_cannot_probe_host(accounts):
    accounts.mint("Owner", ROLE_OWNER)
    _, token = accounts.mint("Member", ROLE_MEMBER)
    response = TestClient(app, client=("192.0.2.42", 51000)).get(
        "/api/server/host", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 403
