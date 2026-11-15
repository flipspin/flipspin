"""Check stable public identity across requests and cold caches.

A data directory retains its id; claiming removes setup-only disclosures.
Temporary account/instance files and cleared caches prevent host-state reads.
"""
import json
import os

from app.infra.migrations import StoreRefusal
from app.infra.instance import read_or_create_instance_id

import pytest
from fastapi.testclient import TestClient

from app.config import APP_VERSION
from app.domains.system import routes
from app.domains.accounts.auth import is_public_route
from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.main import app

STATUS_PATH = "/api/status"
PING_PATH = "/api/ping"
HEALTH_PATH = "/api/health"
GATED_PATH = "/api/get-basedir"
SHARED = "s3cret-shared-token"


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """A throwaway data directory: its own token table and its own id file."""
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    # The container rebuilds the store when the path changes; drop it afterwards
    # too, so the next test file does not inherit a store over a deleted tmpdir.
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    yield tmp_path
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()


def store():
    return app.state.container.get_token_store()


def local_client() -> TestClient:
    return TestClient(app)


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def status_body(client: TestClient = None) -> dict:
    response = (client or local_client()).get(STATUS_PATH)
    assert response.status_code == 200
    return response.json()


def restart() -> None:
    """Model a process restart: nothing in memory, the file left on disk."""
    routes._instance_id_cache.clear()
    app.state.container._services.pop("token_store", None)


class TestTheIdentityIsStable:
    def test_status_reports_an_instance_id(self, isolated):
        body = status_body()
        assert isinstance(body["instanceId"], str)
        assert body["instanceId"]

    def test_the_same_id_comes_back_on_a_second_call(self, isolated):
        assert status_body()["instanceId"] == status_body()["instanceId"]

    def test_the_id_survives_the_token_store_being_rebuilt(self, isolated):
        first = status_body()["instanceId"]
        # Minting a user rebuilds nothing by itself, so force the swap the
        # container performs when users_file moves.
        app.state.container._services.pop("token_store", None)
        assert status_body()["instanceId"] == first

    def test_the_id_survives_a_restart_because_it_is_read_back(self, isolated):
        """The whole feature: an id in memory is worth nothing after a crash."""
        first = status_body()["instanceId"]
        restart()
        assert status_body()["instanceId"] == first

    def test_the_id_is_persisted_to_the_instance_file(self, isolated):
        instance_id = status_body()["instanceId"]
        stored = json.loads((isolated / "instance.json").read_text(encoding="utf-8"))
        assert stored["instanceId"] == instance_id

    def test_an_existing_file_is_adopted_rather_than_replaced(self, isolated):
        """An id already on disk is *the* answer — regenerating it would mean a
        client that recorded it now sees a stranger on its own port."""
        (isolated / "instance.json").write_text(
            json.dumps({"version": 1, "instanceId": "beefcafe" * 4}), encoding="utf-8"
        )
        assert status_body()["instanceId"] == "beefcafe" * 4

    def test_two_data_directories_are_two_different_servers(self, isolated, tmp_path, monkeypatch):
        first = status_body()["instanceId"]
        other = tmp_path / "elsewhere"
        other.mkdir()
        monkeypatch.setattr(app.state.config, "instance_file", other / "instance.json")
        assert status_body()["instanceId"] != first


class TestABrokenIdFileRefuses:
    """Damaged identity must never introduce the household as a new server."""

    def test_a_corrupt_instance_file_refuses(self, isolated):
        (isolated / "instance.json").write_text("{not json at all", encoding="utf-8")
        with pytest.raises(StoreRefusal):
            routes._instance_id_cache.clear()
            read_or_create_instance_id(app.state.config.instance_file)

    def test_a_file_without_an_id_refuses(self, isolated):
        (isolated / "instance.json").write_text(json.dumps({"version": 1}), encoding="utf-8")
        with pytest.raises(StoreRefusal):
            routes._instance_id_cache.clear()
            read_or_create_instance_id(app.state.config.instance_file)

    def test_an_unwritable_location_refuses(self, isolated, monkeypatch):
        # A regular file where the parent directory should be: both the read and
        # the write fail, which is the shape of a read-only or missing mount.
        blocker = isolated / "not-a-directory"
        blocker.write_text("", encoding="utf-8")
        monkeypatch.setattr(app.state.config, "instance_file", blocker / "instance.json")
        routes._instance_id_cache.clear()
        with pytest.raises(StoreRefusal):
            routes._instance_id_cache.clear()
            read_or_create_instance_id(app.state.config.instance_file)
        assert not (blocker / "instance.json").exists()


class TestFirstRunTellsYouWhereDataLands:
    def test_no_users_means_is_init_false_and_a_data_dir(self, isolated):
        body = status_body()
        assert body["isInit"] is False
        assert body["dataDir"] == str(app.state.config.playlist_dir.parent)

    def test_a_single_user_means_is_init_true(self, isolated):
        store().mint("Robin", ROLE_OWNER)
        assert status_body()["isInit"] is True

    def test_a_configured_server_does_not_volunteer_its_filesystem(self, isolated):
        """The route is unauthenticated. Once the household exists there is no
        first-run screen to feed, and the path names the server's user."""
        store().mint("Robin", ROLE_OWNER)
        assert "dataDir" not in status_body()

    def test_any_user_counts_not_only_an_owner(self, isolated):
        """``isInit`` asks whether the household exists at all. A library whose
        only row is a phone is still claimed, and still not first-run."""
        store().mint("Ana (iPhone)", ROLE_MEMBER)
        body = status_body()
        assert body["isInit"] is True
        assert "dataDir" not in body


class TestAuthMethodsDescribeTheRealConfig:
    def test_no_shared_secret_advertises_token_and_local(self, isolated):
        assert status_body()["authMethods"] == ["token", "local"]

    def test_a_shared_secret_drops_local(self, isolated, monkeypatch):
        """There is no loopback bypass once a token is set, so offering one
        would send a user hunting for a bug in their own credentials."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert status_body()["authMethods"] == ["token"]

    def test_unauthenticated_remote_advertises_anonymous(self, isolated, monkeypatch):
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert status_body()["authMethods"] == ["token", "local", "anonymous"]

    def test_a_shared_secret_overrides_the_unauthenticated_flag(self, isolated, monkeypatch):
        # The flag lives inside the no-token branch of the gate, so a configured
        # token wins. Advertising "anonymous" here would be a plain lie.
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert status_body()["authMethods"] == ["token"]

    def test_token_is_always_offered(self, isolated, monkeypatch):
        for token in (None, SHARED):
            monkeypatch.setattr(app.state.config, "api_token", token)
            assert "token" in status_body()["authMethods"]


class TestAuthMethodsSayWhetherALoginFormCanWork:
    """``password`` is keyed on the *table*, not on the code being deployed.

    A server whose accounts all predate password sign-in has to be able to say
    so: every one of them authenticates on device tokens and none of them can
    log in, so a setup screen that drew a login form there would offer a door
    that cannot open — to exactly the household most likely to be lost, since
    they are the ones upgrading rather than installing fresh.
    """

    def _with_credentials(self, label="Robin", username="robin"):
        record, _ = store().mint(label, ROLE_OWNER)
        store().set_username(record.user_id, username)
        store().set_password(record.user_id, "correct horse battery")
        return record

    def test_an_empty_server_does_not_offer_password(self, isolated):
        assert "password" not in status_body()["authMethods"]

    def test_a_household_with_no_credentials_does_not_offer_password(self, isolated):
        """The upgraded server. Its people are fine; they just cannot log in."""
        store().mint("Robin", ROLE_OWNER)
        store().mint("Ana", ROLE_MEMBER)
        assert status_body()["authMethods"] == ["token", "local"]

    def test_one_account_with_credentials_is_enough(self, isolated):
        self._with_credentials()
        assert status_body()["authMethods"] == ["token", "password", "local"]

    def test_a_username_with_no_password_is_not_enough(self, isolated):
        record, _ = store().mint("Robin", ROLE_OWNER)
        store().set_username(record.user_id, "robin")
        assert "password" not in status_body()["authMethods"]

    def test_it_survives_a_restart(self, isolated):
        """It is read from the file, not from anything held in memory."""
        self._with_credentials()
        restart()
        assert "password" in status_body()["authMethods"]

    def test_the_handshake_names_nobody_and_counts_nothing(self, isolated):
        """This route is unauthenticated. It may say a sign-in can succeed
        here; it may not say how many people live here or what they are called."""
        self._with_credentials(label="Robin", username="robin")
        self._with_credentials(label="Ana", username="ana")

        body = status_body()
        raw = local_client().get(STATUS_PATH).text
        assert body["authMethods"].count("password") == 1
        for secret in ("robin", "ana", "Robin", "Ana", "correct horse battery", "scrypt"):
            assert secret not in raw

    def test_password_does_not_displace_the_existing_entries(self, isolated, monkeypatch):
        """Additive, like every other key on this body."""
        self._with_credentials()
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert status_body()["authMethods"] == ["token", "password", "local", "anonymous"]


class TestThePayloadShape:
    def test_status_names_the_app_and_its_version(self, isolated):
        body = status_body()
        assert body["app"] == "krobi"
        assert body["version"] == APP_VERSION

    def test_status_reports_this_process(self, isolated):
        """``pid`` is what lets a desktop client tell "my child" from an orphan
        it has to adopt or refuse."""
        assert status_body()["pid"] == os.getpid()

    def test_build_identity_is_additive_and_nullable_for_dev(self, isolated, monkeypatch):
        from app.infra.build_identity import BUILD_ID

        before = status_body()
        assert "buildId" in before
        assert before["buildId"] == BUILD_ID
        monkeypatch.setattr(routes, "BUILD_ID", "a" * 64)
        after = status_body()
        assert after.pop("buildId") == "a" * 64
        before.pop("buildId")
        assert after == before


class TestBothRoutesAnswerWithoutACredential:
    def test_the_handshake_routes_are_declared_public(self):
        assert is_public_route("GET", STATUS_PATH)
        assert is_public_route("GET", PING_PATH)

    def test_a_stranger_can_ask_who_this_is(self, isolated, monkeypatch):
        """The point of the handshake: a client must be able to identify the
        server *before* it holds anything to present."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        client = remote_client()
        # The token really is being enforced — otherwise the rest proves nothing.
        assert client.get(GATED_PATH).status_code == 401
        assert client.get(STATUS_PATH).status_code == 200
        assert client.get(PING_PATH).status_code == 200
        assert client.get(HEALTH_PATH).status_code == 200

    def test_ping_answers_success(self, isolated):
        response = local_client().get(PING_PATH)
        assert response.status_code == 200
        assert response.json() == {"success": True}

    def test_ping_leaves_a_line_in_the_log(self, isolated, caplog):
        """Its only reason to exist: /api/health is silent on purpose because
        clients poll it, so the human debugging reachability gets nothing there.
        """
        with caplog.at_level("INFO", logger="app.domains.system.routes"):
            local_client().get(PING_PATH)
        assert any(record.name == "app.domains.system.routes" for record in caplog.records)

    def test_a_member_token_does_not_change_the_answer(self, isolated):
        _, token = store().mint("Ana (iPhone)", ROLE_MEMBER)
        with_token = remote_client().get(
            STATUS_PATH, headers={"Authorization": f"Bearer {token}"}
        ).json()
        without = status_body()
        assert with_token["instanceId"] == without["instanceId"]
        # Holding a credential does not unlock the first-run field either: the
        # household exists now, so it is gone for everybody.
        assert "dataDir" not in with_token


def test_status_advertises_loaded_plugin_names(monkeypatch):
    from app.main import app
    from fastapi.testclient import TestClient
    monkeypatch.setattr(app.state, "plugins", ["example"])
    assert TestClient(app).get("/api/status").json()["plugins"] == ["example"]
