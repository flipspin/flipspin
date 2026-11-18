"""Check public server naming, owner-only rename, and cosmetic claim names.

Names persist beside instanceId without replacing it or exposing account labels.
Temporary state and a fake LAN advertiser isolate the suite.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.infra import instance
from app.domains.accounts import claim
from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.domains.system import routes
from app.main import app

STATUS_PATH = "/api/status"
NAME_PATH = "/api/server/name"
CLAIM_PATH = "/api/claim"
SHARED = "s3cret-shared-token"


class RecordingAdvertiser:
    def __init__(self):
        self.refreshes = 0

    def refresh(self):
        self.refreshes += 1

    def stop(self, timeout: float = 3.0):
        pass


@pytest.fixture
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(app.state.config, "setup_token_file", tmp_path / "setup-token")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    monkeypatch.setattr(app.state.config, "require_setup_token", False)
    advertiser = RecordingAdvertiser()
    monkeypatch.setitem(app.state.container._services, "nest_advertiser", advertiser)
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    instance._name_cache.clear()
    claim._cached.clear()
    claim.throttle.reset()
    yield tmp_path, advertiser
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    instance._name_cache.clear()
    claim._cached.clear()
    claim.throttle.reset()


def store():
    return app.state.container.get_token_store()


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def status_name() -> str:
    return remote_client().get(STATUS_PATH).json()["name"]


def expected_default() -> str:
    return "Flipspin"


class TestTheHandshakeCarriesTheName:
    def test_unnamed_server_uses_default_label(self, fresh):
        assert status_name() == expected_default()

    def test_present_once_claimed_too(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        assert status_name() == expected_default()

    def test_the_default_names_nobody(self, fresh):
        """Public body: the default must never come from an account label."""
        store().mint("Zebulon Quackenbush", ROLE_OWNER)
        assert "Zebulon" not in status_name()

    def test_a_rename_shows_up_immediately(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote_client().put(NAME_PATH, json={"name": "  Nido del salón "}, headers=bearer(token))
        assert response.status_code == 200
        assert response.json() == {"name": "Nido del salón"}
        assert status_name() == "Nido del salón"

    def test_the_existing_keys_are_untouched(self, fresh):
        body = remote_client().get(STATUS_PATH).json()
        for key in ("app", "version", "instanceId", "pid", "isInit", "authMethods", "dataDir"):
            assert key in body


class TestRenamingIsForOwners:
    def test_a_member_is_refused(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        _, token = store().mint("Ana", ROLE_MEMBER)
        response = remote_client().put(NAME_PATH, json={"name": "Mine now"}, headers=bearer(token))
        assert response.status_code == 403
        assert status_name() == expected_default()

    def test_no_credential_is_refused(self, fresh, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        store().mint("Robin", ROLE_OWNER)
        assert remote_client().put(NAME_PATH, json={"name": "Nope"}).status_code == 401

    @pytest.mark.parametrize("bad", ["", "   ", "x" * 61, "line\nbreak", "tab\there"])
    def test_an_invalid_name_is_422(self, fresh, bad):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote_client().put(NAME_PATH, json={"name": bad}, headers=bearer(token))
        assert response.status_code == 422
        assert status_name() == expected_default()

    def test_sixty_characters_is_fine(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        name = "n" * 60
        assert remote_client().put(NAME_PATH, json={"name": name}, headers=bearer(token)).status_code == 200

    def test_a_rename_refreshes_the_advertisement(self, fresh):
        _, advertiser = fresh
        _, token = store().mint("Robin", ROLE_OWNER)
        remote_client().put(NAME_PATH, json={"name": "Nido nuevo"}, headers=bearer(token))
        assert advertiser.refreshes == 1

    def test_the_rename_keeps_the_instance_id(self, fresh):
        tmp, _ = fresh
        before = remote_client().get(STATUS_PATH).json()["instanceId"]
        _, token = store().mint("Robin", ROLE_OWNER)
        remote_client().put(NAME_PATH, json={"name": "Nido nuevo"}, headers=bearer(token))
        raw = json.loads((tmp / "instance.json").read_text())
        assert raw["instanceId"] == before
        assert raw["name"] == "Nido nuevo"
        routes._instance_id_cache.clear()
        assert remote_client().get(STATUS_PATH).json()["instanceId"] == before


class TestTheClaimCanNameTheNest:
    def test_a_name_given_at_claim_is_stored(self, fresh):
        response = remote_client().post(CLAIM_PATH, json={"label": "Robin", "nestName": "Nido de Robin"})
        assert response.status_code == 201
        assert status_name() == "Nido de Robin"

    @pytest.mark.parametrize("bad", ["", "x" * 200, "a\x00b", 42, ["list"]])
    def test_an_invalid_name_never_breaks_the_claim(self, fresh, bad):
        response = remote_client().post(CLAIM_PATH, json={"label": "Robin", "nestName": bad})
        assert response.status_code == 201
        assert response.json()["token"]
        assert status_name() == expected_default()

    def test_the_claim_without_a_name_is_unchanged(self, fresh):
        response = remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert response.status_code == 201
        assert set(response.json()) == {"user", "token"}
        assert status_name() == expected_default()

    def test_a_successful_claim_starts_the_advertisement(self, fresh):
        _, advertiser = fresh
        remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert advertiser.refreshes == 1

    def test_a_refused_claim_does_not(self, fresh):
        _, advertiser = fresh
        store().mint("Robin", ROLE_OWNER)
        assert remote_client().post(CLAIM_PATH, json={"label": "Eve", "nestName": "Pwned"}).status_code == 409
        assert advertiser.refreshes == 0
        assert status_name() == expected_default()
