"""First-owner claim, setup-code enforcement and setup presentation.

Exactly one claim may succeed; required codes guard the initial write.
Isolate account, instance and setup-token files in each test.
See docs/security.md#claim-and-setup-code.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts import claim
from app.domains.system import routes
from app.domains.accounts.auth import is_public_route
from app.domains.accounts.identity import (
    ROLE_MEMBER,
    ROLE_OWNER,
    AlreadyInitializedError,
    TokenStore,
)
from app.main import app

CLAIM_PATH = "/api/claim"
STATUS_PATH = "/api/status"
USERS_PATH = "/api/users"
GATED_PATH = "/api/get-basedir"
SHARED = "s3cret-shared-token"


@pytest.fixture
def fresh(tmp_path, monkeypatch):
    """A server nobody owns yet: empty table, its own setup token, open mode."""
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(app.state.config, "setup_token_file", tmp_path / "setup-token")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    monkeypatch.setattr(app.state.config, "require_setup_token", False)
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    claim._cached.clear()
    claim.throttle.reset()
    yield tmp_path
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    claim._cached.clear()
    claim.throttle.reset()


@pytest.fixture
def strict(fresh, monkeypatch):
    """The same server, hardened: the claim must present the setup token."""
    monkeypatch.setattr(app.state.config, "require_setup_token", True)
    return fresh


def store() -> TokenStore:
    return app.state.container.get_token_store()


def local_client() -> TestClient:
    return TestClient(app)


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def setup_token(config_dir) -> str:
    return (config_dir / "setup-token").read_text(encoding="utf-8").strip()


class TestAFreshServerCanBeClaimed:
    def test_claiming_returns_a_working_owner_token(self, fresh):
        """The entire reason the endpoint exists: a client with no credential
        turns a brand-new server into one it can use."""
        response = remote_client().post(CLAIM_PATH, json={"label": "Robin (iPhone)"})
        assert response.status_code == 201

        body = response.json()
        token = body["token"]
        assert token
        assert body["user"]["label"] == "Robin (iPhone)"
        assert body["user"]["role"] == ROLE_OWNER

        # Not merely a string: it authenticates, and it is an *owner*, so the
        # holder can go on to mint the rest of the household.
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200
        assert remote_client().get(USERS_PATH, headers=bearer(token)).status_code == 200
        assert remote_client().post(
            USERS_PATH, json={"label": "Ana", "role": "member"}, headers=bearer(token)
        ).status_code == 201

    def test_the_claim_needs_no_credential_at_all(self, fresh, monkeypatch):
        """Public by necessity — it hands out the credential everything else
        requires. Asserted even with a shared secret configured, because that is
        the deployment where a gated claim would be unreachable forever."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        client = remote_client()
        # The gate really is enforcing, otherwise this proves nothing.
        assert client.get(GATED_PATH).status_code == 401
        assert client.post(CLAIM_PATH, json={"label": "Robin"}).status_code == 201

    def test_the_route_is_declared_public(self, fresh):
        assert is_public_route("POST", CLAIM_PATH)

    def test_the_body_matches_the_mint_endpoint_field_for_field(self, fresh):
        """Same shape as ``POST /api/users`` so a client decodes it with the code
        it already has — and so the "shown once, never again" rule carries over
        unchanged."""
        claimed = remote_client().post(CLAIM_PATH, json={"label": "Robin"}).json()
        owner_token = claimed["token"]
        minted = remote_client().post(
            USERS_PATH, json={"label": "Ana"}, headers=bearer(owner_token)
        ).json()
        assert set(claimed) == set(minted) == {"user", "token"}
        assert set(claimed["user"]) == set(minted["user"])

    def test_the_new_owner_is_the_only_row(self, fresh):
        remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert [(u.label, u.role) for u in store().list_users()] == [("Robin", ROLE_OWNER)]

    def test_a_blank_label_is_refused(self, fresh):
        assert remote_client().post(CLAIM_PATH, json={"label": "   "}).status_code == 422
        assert store().list_users() == []

    def test_the_token_is_not_recoverable_afterwards(self, fresh):
        """The store keeps a digest. Nothing can re-show the plaintext, and the
        listing must not leak it."""
        token = remote_client().post(CLAIM_PATH, json={"label": "Robin"}).json()["token"]
        listed = remote_client().get(USERS_PATH, headers=bearer(token)).json()
        assert token not in str(listed)


class TestTheWindowClosesForever:
    def test_a_second_claim_is_refused(self, fresh):
        assert remote_client().post(CLAIM_PATH, json={"label": "Robin"}).status_code == 201
        second = remote_client().post(CLAIM_PATH, json={"label": "Impostor"})
        assert second.status_code == 409
        assert "already" in second.json()["detail"].lower()

    def test_a_refused_claim_creates_nothing(self, fresh):
        remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        remote_client().post(CLAIM_PATH, json={"label": "Impostor"})
        assert [u.label for u in store().list_users()] == ["Robin"]

    def test_a_server_that_already_has_users_refuses(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        assert remote_client().post(CLAIM_PATH, json={"label": "Impostor"}).status_code == 409

    def test_even_a_household_of_only_members_is_claimed(self, fresh):
        """Guarded on the same condition ``isInit`` reports — *any* row, not
        "any owner". A library whose only row is a phone is still somebody's."""
        store().mint("Ana (iPhone)", ROLE_MEMBER)
        assert remote_client().post(CLAIM_PATH, json={"label": "Impostor"}).status_code == 409

    def test_holding_an_owner_token_does_not_reopen_it(self, fresh):
        """There is no privileged re-claim. Owners mint through /api/users."""
        token = remote_client().post(CLAIM_PATH, json={"label": "Robin"}).json()["token"]
        assert remote_client().post(
            CLAIM_PATH, json={"label": "Again"}, headers=bearer(token)
        ).status_code == 409

    def test_refusal_is_a_409_not_a_500(self, fresh):
        """Already set up is the expected answer for the whole life of the
        server after its first minute, so it must be branchable and never look
        like the server broke."""
        store().mint("Robin", ROLE_OWNER)
        response = remote_client().post(CLAIM_PATH, json={"label": "Impostor"})
        assert response.status_code == 409
        assert response.status_code < 500


class TestTheSetupTokenMode:
    def test_open_mode_needs_no_token(self, fresh):
        assert remote_client().post(CLAIM_PATH, json={"label": "Robin"}).status_code == 201

    def test_open_mode_ignores_a_token_that_was_sent_anyway(self, fresh):
        """A client that always sends one must not be punished for it."""
        response = remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": "whatever"}
        )
        assert response.status_code == 201

    def test_strict_mode_refuses_a_claim_with_no_token(self, strict):
        response = remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert response.status_code == 401
        assert store().list_users() == []

    def test_strict_mode_refuses_a_wrong_token(self, strict):
        response = remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": "not-the-one"}
        )
        assert response.status_code == 401
        assert store().list_users() == []

    def test_strict_mode_accepts_the_right_token(self, strict):
        token = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        response = remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": token}
        )
        assert response.status_code == 201
        assert response.json()["user"]["role"] == ROLE_OWNER

    def test_the_token_on_disk_is_the_one_that_works(self, strict):
        """The operator's copy comes from the file (and the log), so the file has
        to hold the value the route actually compares against."""
        claim.read_or_create_setup_token(app.state.config.setup_token_file)
        assert remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": setup_token(strict)}
        ).status_code == 201

    def test_the_token_file_is_owner_only(self, strict):
        claim.read_or_create_setup_token(app.state.config.setup_token_file)
        mode = (strict / "setup-token").stat().st_mode & 0o777
        assert mode == 0o600

    def test_the_spent_token_file_is_destroyed_by_a_successful_claim(self, strict):
        token = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        assert (strict / "setup-token").exists()
        assert remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": token}
        ).status_code == 201
        assert not (strict / "setup-token").exists()

    def test_a_failed_claim_leaves_the_token_alone(self, strict):
        token = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        remote_client().post(CLAIM_PATH, json={"label": "Robin", "setupToken": "wrong"})
        assert setup_token(strict) == token

    def test_the_token_is_stable_across_reads(self, strict):
        """It is printed at boot and presented minutes later; a value that
        changed between the two would be unusable and undiagnosable."""
        path = app.state.config.setup_token_file
        first = claim.read_or_create_setup_token(path)
        claim._cached.clear()  # model a fresh process reading the same file
        assert claim.read_or_create_setup_token(path) == first

    def test_an_unwritable_location_still_yields_a_usable_token(self, strict):
        """Degrades to a process-local value rather than failing the boot — but
        it must still be *one* value, or the log and the check disagree."""
        blocker = strict / "not-a-directory"
        blocker.write_text("", encoding="utf-8")
        path = blocker / "setup-token"
        first = claim.read_or_create_setup_token(path)
        assert first
        assert claim.read_or_create_setup_token(path) == first
        assert not path.exists()

    def test_the_response_never_echoes_the_expected_token(self, strict):
        expected = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        response = remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": "wrong"}
        )
        assert expected not in response.text


class TestTheHandshakeAdvertisesTheMode:
    def test_an_unclaimed_server_in_open_mode_says_no_token_is_needed(self, fresh):
        body = remote_client().get(STATUS_PATH).json()
        assert body["isInit"] is False
        assert body["setupTokenRequired"] is False

    def test_an_unclaimed_server_in_strict_mode_says_a_token_is_needed(self, strict):
        body = remote_client().get(STATUS_PATH).json()
        assert body["isInit"] is False
        assert body["setupTokenRequired"] is True

    def test_the_field_goes_away_once_the_server_is_claimed(self, strict):
        """Same discipline as ``dataDir``: there is no setup screen left to
        inform, and an unauthenticated route volunteers nothing it does not owe."""
        remote_client().post(
            CLAIM_PATH,
            json={
                "label": "Robin",
                "setupToken": claim.read_or_create_setup_token(
                    app.state.config.setup_token_file
                ),
            },
        )
        body = remote_client().get(STATUS_PATH).json()
        assert body["isInit"] is True
        assert "setupTokenRequired" not in body

    def test_claiming_flips_is_init(self, fresh):
        assert remote_client().get(STATUS_PATH).json()["isInit"] is False
        remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert remote_client().get(STATUS_PATH).json()["isInit"] is True

    def test_the_handshake_never_carries_the_setup_token(self, strict):
        """``/api/status`` is unauthenticated. Publishing *whether* a secret is
        required is a mode; publishing the secret would be handing over the
        server to anyone who asks politely."""
        expected = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        assert expected not in remote_client().get(STATUS_PATH).text

    def test_invalid_claim_never_echoes_the_setup_code(self, strict):
        expected = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        response = remote_client().post(
            CLAIM_PATH, json={"label": "Test owner", "setupToken": [expected]},
        )
        assert response.status_code == 422
        assert expected not in response.text

    def test_the_existing_handshake_keys_are_untouched(self, fresh):
        """Additive only — an iOS client and a desktop client read these."""
        body = remote_client().get(STATUS_PATH).json()
        for key in ("app", "version", "instanceId", "pid", "isInit", "authMethods", "dataDir"):
            assert key in body


class TestRepeatedGuessesAreBlunted:
    def test_a_burst_of_wrong_tokens_starts_getting_429(self, strict):
        client = remote_client()
        for _ in range(claim.CLAIM_FAILURE_BURST):
            assert client.post(
                CLAIM_PATH, json={"label": "x", "setupToken": "wrong"}
            ).status_code == 401
        blocked = client.post(CLAIM_PATH, json={"label": "x", "setupToken": "wrong"})
        assert blocked.status_code == 429
        assert int(blocked.headers["Retry-After"]) >= 1

    def test_the_throttle_blocks_the_right_token_too(self, strict):
        """Deliberate: a limiter that let a correct guess through on the
        attempt after the cap would not be limiting anything."""
        token = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        client = remote_client()
        for _ in range(claim.CLAIM_FAILURE_BURST):
            client.post(CLAIM_PATH, json={"label": "x", "setupToken": "wrong"})
        assert client.post(
            CLAIM_PATH, json={"label": "Robin", "setupToken": token}
        ).status_code == 429
        assert store().list_users() == []

    def test_open_mode_is_not_throttled(self, fresh):
        """Nothing to guess there — a repeat claim is answered 409 by the store,
        which is a different and permanent refusal."""
        claim.throttle.record_failure()
        assert remote_client().post(CLAIM_PATH, json={"label": "Robin"}).status_code == 201

    def test_a_successful_claim_is_never_counted(self, strict):
        token = claim.read_or_create_setup_token(app.state.config.setup_token_file)
        remote_client().post(CLAIM_PATH, json={"label": "Robin", "setupToken": token})
        assert claim.throttle.retry_after() is None

    def test_the_window_expires(self):
        """A throttled operator gets their attempt back; it is a delay, not a lock."""
        throttle = claim.ClaimThrottle(burst=2, window_seconds=0.05)
        throttle.record_failure()
        throttle.record_failure()
        assert throttle.retry_after() is not None
        time.sleep(0.08)
        assert throttle.retry_after() is None

    def test_the_advertised_wait_is_never_zero(self):
        """A ``Retry-After: 0`` reads as "go ahead" and would undo the limit."""
        throttle = claim.ClaimThrottle(burst=1, window_seconds=0.001)
        throttle.record_failure()
        wait = throttle.retry_after()
        assert wait is None or wait >= 1


class TestExactlyOneCallerWins:
    """Check and mint under one store lock so racing claims cannot both become owners."""

    def test_a_slow_mint_cannot_be_raced(self, fresh):
        """The direct test of atomicity.

        ``mint`` is made slow so the window between "the table is empty" and "a
        row exists" is wide open, and both threads are released into it at once
        by a barrier. A check-then-act implementation mints twice here; holding
        the lock across the pair makes the second thread wait and then lose.
        """
        target = store()
        real_mint = target.mint

        def slow_mint(label, role=ROLE_MEMBER, **kwargs):
            time.sleep(0.05)
            return real_mint(label, role, **kwargs)

        target.mint = slow_mint
        barrier = threading.Barrier(2)
        outcomes = []

        def attempt(label):
            barrier.wait()
            try:
                record, _ = target.claim_first_owner(label)
                outcomes.append(("claimed", record.label))
            except AlreadyInitializedError:
                outcomes.append(("refused", label))

        threads = [threading.Thread(target=attempt, args=(name,)) for name in ("A", "B")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        assert sorted(kind for kind, _ in outcomes) == ["claimed", "refused"]
        assert len(target.list_users()) == 1

    def test_many_threads_still_produce_one_owner(self, fresh):
        target = store()
        barrier = threading.Barrier(8)
        claimed = []

        def attempt(index):
            barrier.wait()
            try:
                record, token = target.claim_first_owner(f"claimant-{index}")
                claimed.append((record.user_id, token))
            except AlreadyInitializedError:
                pass

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(attempt, range(8)))

        assert len(claimed) == 1
        rows = target.list_users()
        assert len(rows) == 1
        assert rows[0].role == ROLE_OWNER
        # And the single token handed out is the one that works.
        assert target.resolve(claimed[0][1]).user_id == rows[0].user_id

    def test_two_simultaneous_requests_produce_one_owner(self, fresh):
        """The same race over HTTP, which is how it would actually arrive."""
        barrier = threading.Barrier(2)

        def attempt(label):
            client = remote_client()
            barrier.wait()
            return client.post(CLAIM_PATH, json={"label": label}).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(attempt, ("A", "B")))

        assert statuses == [201, 409]
        assert len(store().list_users()) == 1

    def test_the_store_refuses_a_second_claim_outright(self, fresh):
        target = store()
        target.claim_first_owner("Robin")
        with pytest.raises(AlreadyInitializedError):
            target.claim_first_owner("Impostor")

    def test_the_first_account_is_always_an_owner(self, fresh):
        """Not a parameter: a member could not go on to mint anybody else, so a
        claim that produced one would have achieved nothing."""
        record, _ = store().claim_first_owner("Robin")
        assert record.role == ROLE_OWNER


class TestTheFirstAccountCanBeRecoverable:
    """Keep claim credentials optional for shipped clients that send only label.

    When supplied, they make the first account recoverable if its only device is lost."""

    def test_claiming_with_credentials_yields_an_account_that_can_sign_in(self, fresh):
        response = remote_client().post(
            CLAIM_PATH,
            json={"label": "Robin", "username": "Robin", "password": "correct horse battery"},
        )
        assert response.status_code == 201

        signed_in = remote_client().post(
            "/api/login", json={"username": "robin", "password": "correct horse battery"}
        )
        assert signed_in.status_code == 201
        assert remote_client().get(
            GATED_PATH, headers=bearer(signed_in.json()["token"])
        ).status_code == 200

    def test_the_response_shape_does_not_move(self, fresh):
        """Pinned by ``test_response_contracts.py`` and decoded by two shipped
        clients. Extending the *request* is free; extending this is not."""
        body = remote_client().post(
            CLAIM_PATH,
            json={"label": "Robin", "username": "robin", "password": "correct horse battery"},
        ).json()

        assert set(body) == {"user", "token"}
        assert set(body["user"]) == {"id", "label", "role", "createdAt", "lastSeenAt"}

    def test_the_credentials_are_never_echoed_back(self, fresh):
        response = remote_client().post(
            CLAIM_PATH,
            json={"label": "Robin", "username": "robin", "password": "correct horse battery"},
        )
        assert "correct horse battery" not in response.text

    def test_a_claim_with_only_a_label_still_works(self, fresh):
        """The shipped client's body. It must keep answering 201."""
        response = remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert response.status_code == 201
        assert store().list_users()[0].username is None

    def test_half_a_pair_is_refused_and_creates_nothing(self, fresh):
        for body in (
            {"label": "Robin", "username": "robin"},
            {"label": "Robin", "password": "correct horse battery"},
        ):
            assert remote_client().post(CLAIM_PATH, json=body).status_code == 422
        assert store().list_users() == []

    def test_a_short_password_is_refused_and_creates_nothing(self, fresh):
        """Validated and hashed *before* the store's lock is taken, so a
        rejected pair cannot leave a half-claimed server behind."""
        response = remote_client().post(
            CLAIM_PATH, json={"label": "Robin", "username": "robin", "password": "hunter2"}
        )
        assert response.status_code == 422
        assert store().list_users() == []

    def test_an_unusable_username_is_refused_and_creates_nothing(self, fresh):
        response = remote_client().post(
            CLAIM_PATH,
            json={"label": "Robin", "username": "ni co", "password": "correct horse battery"},
        )
        assert response.status_code == 422
        assert store().list_users() == []

    def test_the_handshake_then_advertises_password_sign_in(self, fresh):
        """So the *next* client to meet this server draws a login form."""
        assert "password" not in remote_client().get(STATUS_PATH).json()["authMethods"]
        remote_client().post(
            CLAIM_PATH,
            json={"label": "Robin", "username": "robin", "password": "correct horse battery"},
        )
        assert "password" in remote_client().get(STATUS_PATH).json()["authMethods"]

    def test_a_claim_without_credentials_advertises_nothing_new(self, fresh):
        remote_client().post(CLAIM_PATH, json={"label": "Robin"})
        assert "password" not in remote_client().get(STATUS_PATH).json()["authMethods"]


class TestSetupLogBlock:
    @pytest.mark.parametrize("locale_env,has_scene", [
        ({"LC_ALL": "C.UTF-8", "LC_CTYPE": "C", "LANG": "C"}, True),
        ({"LC_ALL": "", "LC_CTYPE": "en_US.utf8", "LANG": "C"}, True),
        ({"LC_ALL": "", "LC_CTYPE": "", "LANG": "en_US.UTF-8"}, True),
        ({"LC_ALL": "C", "LC_CTYPE": "", "LANG": "en_US.UTF-8"}, False),
        ({"LC_ALL": "", "LC_CTYPE": "C", "LANG": "en_US.UTF-8"}, False),
        ({"LC_ALL": "", "LC_CTYPE": "", "LANG": ""}, False),
    ])
    def test_log_scene_is_plain_and_respects_locale(self, strict, monkeypatch, caplog, locale_env, has_scene):
        import app.main as main
        from app.infra import discovery
        from app.infra.setup_scene import SETUP_SCENE

        for key, value in locale_env.items():
            monkeypatch.setenv(key, value)
        monkeypatch.setenv("COLORTERM", "truecolor")
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.0.2.25"])
        assert main._announce_first_run_claim(app.state.config) is True
        message = caplog.records[-1].getMessage()
        assert (SETUP_SCENE in message) is has_scene
        assert "\x1b" not in message
        assert f"\n  Flipspin is running · {main.APP_VERSION}\n\n" in message
        assert message.index("Flipspin is running") < message.index("krobi://") < message.index("Paste it in Flipspin")
        assert caplog.records[-1].console_only is True

    def test_strict_boot_banner_has_lan_address_and_private_code(self, strict, monkeypatch, caplog):
        import app.main as main
        from app.infra import discovery

        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["127.0.0.1", "192.0.2.25"])
        monkeypatch.setenv("KROBI_BACKEND_PORT", "8123")
        assert main._announce_first_run_claim(app.state.config) is True
        code = setup_token(strict)
        assert "====================================================" in caplog.text
        assert f"Flipspin is running · {main.APP_VERSION}" in caplog.text
        assert f"  krobi://192.0.2.25:8123/setup#{code}\n  Paste it in Flipspin → Setup link\n  Address: http://192.0.2.25:8123\n  Setup code: {code}" in caplog.text
        assert "Paste it in Flipspin → Setup link" in caplog.text
        assert "127.0.0.1" not in caplog.text
        assert code not in remote_client().get(STATUS_PATH).text
        assert (strict / "setup-token").stat().st_mode & 0o777 == 0o600

    def test_missing_lan_address_never_substitutes_loopback(self, strict, monkeypatch, caplog):
        import app.main as main
        from app.infra import discovery

        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["127.0.0.1"])
        main._announce_first_run_claim(app.state.config)
        assert "LAN address unavailable" in caplog.text
        assert "Setup link unavailable" in caplog.text
        assert "krobi://" not in caplog.text
        assert "Setup code: " + setup_token(strict) in caplog.text
        assert "127.0.0.1" not in caplog.text

    @pytest.mark.parametrize("strict_mode", [False, True])
    @pytest.mark.parametrize("use_json", [False, True])
    def test_setup_code_stays_on_console_and_out_of_files_and_log_responses(
        self, fresh, monkeypatch, capsys, strict_mode, use_json,
    ):
        import logging

        import app.main as main
        from app.infra import discovery
        from app.infra.logging import LoggerConfig

        monkeypatch.setattr(app.state.config, "require_setup_token", strict_mode)
        monkeypatch.setattr(app.state.config, "log_dir", fresh / "logs")
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.0.2.25"])
        root = logging.getLogger()
        saved_handlers, saved_level = root.handlers[:], root.level
        saved_detail = LoggerConfig._detail_handlers
        try:
            LoggerConfig.setup_logging(app.state.config.log_dir, use_json=use_json)
            main._announce_first_run_claim(app.state.config)
            code = setup_token(fresh)
            assert code in capsys.readouterr().err
            for path in app.state.config.log_dir.iterdir():
                assert code not in path.read_text()
                assert "krobi://" not in path.read_text()
            for file in ("app", "errors"):
                response = local_client().get("/api/logs", params={"file": file})
                assert response.status_code == 200
                assert code not in response.text
        finally:
            for handler in root.handlers[:]:
                handler.close()
            root.handlers = saved_handlers
            root.setLevel(saved_level)
            LoggerConfig._detail_handlers = saved_detail

    @pytest.mark.asyncio
    async def test_reminders_wait_ten_minutes_and_stop_after_claim(self, strict, monkeypatch, caplog):
        import app.main as main
        from app.infra import discovery

        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.0.2.25"])
        waits = []

        async def advance(seconds):
            assert seconds == 600
            waits.append(seconds)
            assert caplog.text.count("Flipspin is running ·") == len(waits)
            if len(waits) == 2:
                code = setup_token(strict)
                response = remote_client().post(CLAIM_PATH, json={"label": "Test owner", "setupToken": code})
                assert response.status_code == 201
                assert code not in remote_client().get(STATUS_PATH).text

        monkeypatch.setattr(main.asyncio, "sleep", advance)
        await main._start_first_run_claim()
        task = app.state.setup_reminder
        assert caplog.text.count("Flipspin is running ·") == 1
        await task
        assert waits == [600, 600]
        assert caplog.text.count("Flipspin is running ·") == 2
        assert not (strict / "setup-token").exists()
        assert main._announce_first_run_claim(app.state.config) is False
        assert not (strict / "setup-token").exists()
        assert caplog.text.count("Flipspin is running ·") == 2
        await main._stop_first_run_claim()

    @pytest.mark.asyncio
    async def test_shutdown_cancels_the_reminder(self, strict):
        import app.main as main

        await main._start_first_run_claim()
        task = app.state.setup_reminder
        await main._stop_first_run_claim()
        assert task.cancelled()
        assert app.state.setup_reminder is None

    @pytest.mark.asyncio
    async def test_open_mode_keeps_warning_without_periodic_banner(self, fresh, caplog):
        import app.main as main

        await main._start_first_run_claim()
        assert app.state.setup_reminder is None
        assert "ANYONE who can reach this port" in caplog.text
        assert "waiting to be set up" not in caplog.text

    @pytest.mark.asyncio
    async def test_claimed_boot_has_no_setup_banner_or_secret_file(self, strict, caplog):
        import app.main as main

        store().claim_first_owner("Test owner")
        await main._start_first_run_claim()
        assert app.state.setup_reminder is None
        assert "waiting to be set up" not in caplog.text
        assert not (strict / "setup-token").exists()
