"""Password sign-in and self-service credentials over HTTP.

Failed lookups remain indistinguishable and globally throttled.
Use isolated account files and reset request-spanning throttle state.
See docs/security.md#recovery.
"""
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts import passwords
from app.domains.accounts.auth import is_public_route
from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.main import app

LOGIN_PATH = "/api/login"
USERNAME_PATH = "/api/me/username"
PASSWORD_PATH = "/api/me/password"
DEVICES_PATH = "/api/me/devices"
GATED_PATH = "/api/get-basedir"
ME_PATH = "/api/me"
SHARED = "s3cret-shared-token"

PASSWORD = "correct horse battery"
OTHER_PASSWORD = "a completely different one"

#: Device-only users.json shape, shared with tests/unit/test_identity_store.py.
#: The fixture documents its synthetic credentials.
V2_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "users_v2.json"
V2_OWNER_PHONE_TOKEN = "owner-phone-token-from-the-live-server"
V2_MEMBER_TOKEN = "member-token-from-the-live-server"
V2_OWNER_ID = "5f3c1a2b9d40"


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A throwaway token table, wired into the live app, with an empty throttle."""
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    app.state.container._services.pop("token_store", None)
    passwords.login_throttle.reset()
    yield app.state.container.get_token_store()
    app.state.container._services.pop("token_store", None)
    passwords.login_throttle.reset()


@pytest.fixture
def account(store):
    """An owner who can sign in: ``robin`` / :data:`PASSWORD`, one device."""
    record, token = store.mint("Robin", ROLE_OWNER)
    store.set_username(record.user_id, "Robin")
    store.set_password(record.user_id, PASSWORD)
    return store.get_user(record.user_id), token


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def sign_in(username="robin", password=PASSWORD, **extra):
    body = {"username": username, "password": password, **extra}
    return remote_client().post(LOGIN_PATH, json=body)


class TestSigningInFromNothing:
    def test_a_username_and_a_password_become_a_working_device_token(self, account):
        """The entire reason the route exists: the phone is gone and the library
        is not."""
        response = sign_in()
        assert response.status_code == 201

        token = response.json()["token"]
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200

    def test_the_route_needs_no_credential_at_all(self, account, monkeypatch):
        """Public by necessity — asserted even with a shared secret set,
        because that is the deployment where a gated login would be unreachable
        by the person who needs it."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        client = remote_client()
        assert client.get(GATED_PATH).status_code == 401
        assert client.post(
            LOGIN_PATH, json={"username": "robin", "password": PASSWORD}
        ).status_code == 201

    def test_the_route_is_declared_public(self):
        assert is_public_route("POST", LOGIN_PATH)

    def test_the_body_matches_the_add_device_endpoint_field_for_field(self, account):
        """Pairing and password sign-in share one token response decoder."""
        _, phone_token = account
        signed_in = sign_in().json()
        added = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()

        assert set(signed_in) == set(added) == {"device", "token"}
        assert set(signed_in["device"]) == set(added["device"])

    def test_the_new_token_is_the_same_person(self, account):
        """Not a second account — the defect the device table exists to fix."""
        record, phone_token = account
        token = sign_in().json()["token"]

        me = remote_client().get(ME_PATH, headers=bearer(token)).json()
        assert me["id"] == record.user_id
        assert me["role"] == ROLE_OWNER
        assert me["id"] == remote_client().get(ME_PATH, headers=bearer(phone_token)).json()["id"]

    def test_the_username_is_matched_ignoring_case(self, account):
        assert sign_in(username="ROBIN").status_code == 201

    def test_the_new_device_is_listed_and_revocable_like_any_other(self, account):
        """What makes a forgotten sign-in on somebody else's laptop recoverable."""
        created = sign_in(deviceLabel="Hotel laptop").json()
        token = created["token"]

        listed = remote_client().get(DEVICES_PATH, headers=bearer(token)).json()["devices"]
        assert [d["label"] for d in listed] == ["Robin", "Hotel laptop"]
        assert [d["isCurrent"] for d in listed] == [False, True]

        revoked = remote_client().delete(
            f"{DEVICES_PATH}/{created['device']['id']}", headers=bearer(token)
        )
        assert revoked.status_code == 200
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 401

    def test_an_unnamed_device_still_gets_a_label(self, account):
        body = sign_in().json()
        assert body["device"]["label"]

    def test_signing_in_twice_produces_two_separate_devices(self, account):
        first = sign_in(deviceLabel="Phone").json()["token"]
        second = sign_in(deviceLabel="Laptop").json()["token"]

        assert first != second
        assert remote_client().get(GATED_PATH, headers=bearer(first)).status_code == 200
        assert remote_client().get(GATED_PATH, headers=bearer(second)).status_code == 200

    def test_a_member_can_sign_in_too(self, store):
        """No owner gate anywhere on this route: it is how a family member's new
        phone joins their own account."""
        record, _ = store.mint("Ana", ROLE_MEMBER)
        store.set_username(record.user_id, "ana")
        store.set_password(record.user_id, PASSWORD)

        response = sign_in(username="ana")
        assert response.status_code == 201
        me = remote_client().get(ME_PATH, headers=bearer(response.json()["token"])).json()
        assert (me["id"], me["role"]) == (record.user_id, ROLE_MEMBER)

    def test_the_token_is_not_recoverable_afterwards(self, account):
        token = sign_in().json()["token"]
        listed = remote_client().get(DEVICES_PATH, headers=bearer(token)).text
        assert token not in listed


class TestAWrongUsernameAndAWrongPasswordAreOneAnswer:
    """The property that makes a permanently public credential-minting route
    survivable. It has to hold in the status, in the body, and on the clock."""

    def test_a_wrong_password_is_a_401(self, account):
        assert sign_in(password="not the password").status_code == 401

    def test_an_unknown_username_is_the_same_401(self, account):
        assert sign_in(username="nobody").status_code == 401

    def test_the_two_bodies_are_byte_identical(self, account):
        wrong_password = sign_in(password="not the password")
        unknown_user = sign_in(username="nobody")

        assert wrong_password.status_code == unknown_user.status_code
        assert wrong_password.json() == unknown_user.json()

    def test_the_body_names_neither_the_username_nor_whether_it_exists(self, account):
        body = sign_in(username="robin", password="not the password").text
        assert "robin" not in body.lower()
        for word in ("exist", "unknown", "no such", "not found"):
            assert word not in body.lower()

    def test_an_account_with_a_username_and_no_password_answers_the_same_401(self, store):
        """A half-configured account must not be a way to enumerate names."""
        record, _ = store.mint("Ana", ROLE_MEMBER)
        store.set_username(record.user_id, "ana")

        known = sign_in(username="ana")
        unknown = sign_in(username="nobody")
        assert known.status_code == unknown.status_code == 401
        assert known.json() == unknown.json()

    def test_a_malformed_username_answers_401_and_not_422(self, account):
        """A validation error here would tell an attacker which shapes are
        worth trying before spending a single guess."""
        for junk in ("robin@example.com", "ni co", "x", "n" * 200, ""):
            assert sign_in(username=junk).status_code == 401

    def test_an_unknown_username_costs_what_a_wrong_password_costs(self, account):
        """The timing half, which no amount of careful wording can substitute
        for. Both paths run one full scrypt derivation; the bound is loose
        because this runs on shared hardware and the failure it is aimed at is a
        miss that returns *immediately*."""
        client = remote_client()

        def elapsed(body):
            start = time.perf_counter()
            assert client.post(LOGIN_PATH, json=body).status_code == 401
            return time.perf_counter() - start

        wrong_password = {"username": "robin", "password": "not the password"}
        unknown_user = {"username": "nobodyhere", "password": "not the password"}
        elapsed(wrong_password), elapsed(unknown_user)  # warm-up, both paths

        real = min(elapsed(wrong_password) for _ in range(3))
        missing = min(elapsed(unknown_user) for _ in range(3))

        assert missing > real / 3, "a fast miss is a username oracle"

    def test_a_failed_sign_in_mints_nothing(self, account, store):
        record, _ = account
        sign_in(password="not the password")
        assert len(store.get_user(record.user_id).devices) == 1

    def test_a_failure_never_names_the_username_in_the_log(self, account, caplog):
        """It is half a credential somebody is typing, and quite often a
        password typed into the wrong field."""
        with caplog.at_level("INFO"):
            sign_in(username="probably-a-password", password="short")
        assert "probably-a-password" not in caplog.text


class TestGuessingIsCapped:
    def test_a_burst_of_wrong_passwords_starts_getting_429(self, account):
        for _ in range(passwords.LOGIN_FAILURE_BURST):
            assert sign_in(password="not the password").status_code == 401

        blocked = sign_in(password="not the password")
        assert blocked.status_code == 429
        assert int(blocked.headers["Retry-After"]) >= 1

    def test_the_cap_blocks_the_right_password_too(self, account):
        """A limiter that let a correct guess through on the attempt after the
        cap would not be limiting anything."""
        for _ in range(passwords.LOGIN_FAILURE_BURST):
            sign_in(password="not the password")
        assert sign_in().status_code == 429

    def test_a_successful_sign_in_is_never_counted(self, account):
        for _ in range(passwords.LOGIN_FAILURE_BURST * 2):
            assert sign_in().status_code == 201
        assert passwords.login_throttle.retry_after() is None

    def test_the_bucket_is_not_keyed_on_the_username(self, account):
        """The reason this is global. A per-account bucket answers "that name
        exists" all by itself, and lets one stranger lock one named person out.
        Guesses against a name that does not exist count the same."""
        for _ in range(passwords.LOGIN_FAILURE_BURST):
            assert sign_in(username="nobody").status_code == 401
        assert sign_in().status_code == 429

    def test_the_throttle_does_not_reach_device_tokens(self, account):
        """The cost of a global bucket, bounded: a held-down login window delays
        adding a device and locks nobody out of their library."""
        _, phone_token = account
        for _ in range(passwords.LOGIN_FAILURE_BURST + 1):
            sign_in(password="not the password")

        assert remote_client().get(GATED_PATH, headers=bearer(phone_token)).status_code == 200
        assert remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).status_code == 201


class TestChoosingAUsernameAndAPassword:
    def test_an_account_with_neither_can_adopt_both(self, store):
        """The migration, from the client's side: authorized by the device
        token in hand, because an account that never had a password cannot be
        asked for one."""
        record, token = store.mint("Robin", ROLE_OWNER)

        named = remote_client().post(
            USERNAME_PATH, json={"username": "Robin"}, headers=bearer(token)
        )
        assert named.status_code == 200
        assert named.json() == {"username": "Robin"}

        set_password = remote_client().post(
            PASSWORD_PATH, json={"newPassword": PASSWORD}, headers=bearer(token)
        )
        assert set_password.status_code == 200
        assert sign_in().status_code == 201

    def test_a_password_before_a_username_is_refused(self, store):
        """It could never sign in, and its owner would believe it could."""
        _, token = store.mint("Robin", ROLE_OWNER)
        response = remote_client().post(
            PASSWORD_PATH, json={"newPassword": PASSWORD}, headers=bearer(token)
        )
        assert response.status_code == 409
        assert "username" in response.json()["detail"].lower()

    def test_a_taken_username_is_a_409(self, account, store):
        other, other_token = store.mint("Ana", ROLE_MEMBER)
        response = remote_client().post(
            USERNAME_PATH, json={"username": "ROBIN"}, headers=bearer(other_token)
        )
        assert response.status_code == 409

    def test_an_unusable_username_is_a_422_that_says_what_is_allowed(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)
        response = remote_client().post(
            USERNAME_PATH, json={"username": "ni co"}, headers=bearer(token)
        )
        assert response.status_code == 422
        assert "letters" in response.json()["detail"]

    def test_a_short_password_is_a_422_that_says_the_floor(self, account, store):
        record, token = account
        response = remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": PASSWORD, "newPassword": "hunter22"},
            headers=bearer(token),
        )
        assert response.status_code == 422
        assert str(passwords.MIN_PASSWORD_LENGTH) in response.json()["detail"]
        # On its way into an HTTP body and possibly a log.
        assert "hunter22" not in response.json()["detail"]

    def test_changing_it_requires_the_current_one(self, account):
        _, token = account
        response = remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": "not the password", "newPassword": OTHER_PASSWORD},
            headers=bearer(token),
        )
        assert response.status_code == 401
        assert sign_in().status_code == 201, "the old password still works"

    def test_changing_it_retires_the_old_password(self, account):
        _, token = account
        assert remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": PASSWORD, "newPassword": OTHER_PASSWORD},
            headers=bearer(token),
        ).status_code == 200

        assert sign_in(password=PASSWORD).status_code == 401
        assert sign_in(password=OTHER_PASSWORD).status_code == 201

    def test_these_routes_need_a_credential(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        client = remote_client()
        assert client.post(USERNAME_PATH, json={"username": "robin"}).status_code == 401
        assert client.post(PASSWORD_PATH, json={"newPassword": PASSWORD}).status_code == 401
        assert not is_public_route("POST", USERNAME_PATH)
        assert not is_public_route("POST", PASSWORD_PATH)

    def test_a_sentinel_principal_has_no_account_to_give_credentials_to(
        self, store, monkeypatch
    ):
        """The shared secret is a synthetic owner with no row — 409, exactly as
        on the device routes, because it is not a permission problem."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().post(
            USERNAME_PATH, json={"username": "robin"}, headers=bearer(SHARED)
        ).status_code == 409

    def test_no_body_on_these_routes_can_name_another_account(self, account, store):
        """The account comes off the credential and never off the body — the
        same rule as ``POST /api/me/devices``, and for the same reason."""
        record, _ = account
        other, other_token = store.mint("Ana", ROLE_MEMBER)

        remote_client().post(
            USERNAME_PATH,
            json={"username": "ana", "userId": record.user_id},
            headers=bearer(other_token),
        )

        assert store.get_user(other.user_id).username == "ana"
        assert store.get_user(record.user_id).username == "Robin"


class TestAPasswordChangeSignsNobodyOut:
    """Password changes preserve device tokens because each device is revoked separately.

    The response must make remaining access visible, including tokens minted with
    a leaked password. See docs/security.md for the revocation policy.
    """

    def test_the_other_devices_keep_working(self, account, store):
        record, phone_token = account
        mac_token = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()["token"]

        remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": PASSWORD, "newPassword": OTHER_PASSWORD},
            headers=bearer(phone_token),
        )

        assert remote_client().get(GATED_PATH, headers=bearer(mac_token)).status_code == 200
        assert remote_client().get(GATED_PATH, headers=bearer(phone_token)).status_code == 200

    def test_the_calling_device_keeps_working_too(self, account):
        _, token = account
        remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": PASSWORD, "newPassword": OTHER_PASSWORD},
            headers=bearer(token),
        )
        assert remote_client().get(ME_PATH, headers=bearer(token)).status_code == 200

    def test_the_response_says_so_and_counts_what_is_still_signed_in(self, account):
        """So a client can tell the user the truth and send them to the device
        list, rather than let them assume they just evicted somebody."""
        _, token = account
        remote_client().post(DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(token))

        body = remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": PASSWORD, "newPassword": OTHER_PASSWORD},
            headers=bearer(token),
        ).json()

        assert body == {"success": True, "otherDevicesSignedOut": False, "deviceCount": 2}

    def test_a_token_minted_by_the_leaked_password_survives_the_change(self, account):
        """The honest cost, asserted rather than hoped for: this is exactly
        the case the response field exists to warn about."""
        _, phone_token = account
        stolen = sign_in().json()["token"]

        remote_client().post(
            PASSWORD_PATH,
            json={"currentPassword": PASSWORD, "newPassword": OTHER_PASSWORD},
            headers=bearer(phone_token),
        )

        assert remote_client().get(GATED_PATH, headers=bearer(stolen)).status_code == 200
        # Explicit device revocation removes the remaining access.
        devices = remote_client().get(DEVICES_PATH, headers=bearer(phone_token)).json()
        intruder = next(d for d in devices["devices"] if not d["isCurrent"])
        remote_client().delete(
            f"{DEVICES_PATH}/{intruder['id']}", headers=bearer(phone_token)
        )
        assert remote_client().get(GATED_PATH, headers=bearer(stolen)).status_code == 401


class TestTheLiveTableCanAdoptCredentials:
    """Upgrade device-only accounts without losing access or requiring credentials.

    Password recovery becomes available when the account chooses a password."""

    @pytest.fixture
    def legacy(self, store):
        # Dropping the old file at the store's path before the first request is
        # exactly what a server restart after an upgrade looks like.
        shutil.copy(V2_FIXTURE, store.path)
        return store

    def test_the_tokens_on_the_devices_still_authenticate(self, legacy):
        for token in (V2_OWNER_PHONE_TOKEN, V2_MEMBER_TOKEN):
            assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200

    def test_nobody_can_sign_in_before_anybody_chooses_a_password(self, legacy):
        assert sign_in().status_code == 401
        assert remote_client().get("/api/status").json()["authMethods"] == ["token", "local"]

    def test_an_old_account_becomes_recoverable_without_re_pairing_anything(self, legacy):
        headers = bearer(V2_OWNER_PHONE_TOKEN)
        assert remote_client().post(
            USERNAME_PATH, json={"username": "robin"}, headers=headers
        ).status_code == 200
        assert remote_client().post(
            PASSWORD_PATH, json={"newPassword": PASSWORD}, headers=headers
        ).status_code == 200

        signed_in = sign_in()
        assert signed_in.status_code == 201
        assert remote_client().get(
            ME_PATH, headers=bearer(signed_in.json()["token"])
        ).json()["id"] == V2_OWNER_ID
        # The device that made all this happen is untouched.
        assert remote_client().get(GATED_PATH, headers=headers).status_code == 200

    def test_the_handshake_starts_advertising_password_once_somebody_has_one(self, legacy):
        headers = bearer(V2_MEMBER_TOKEN)
        remote_client().post(USERNAME_PATH, json={"username": "ana"}, headers=headers)
        remote_client().post(PASSWORD_PATH, json={"newPassword": PASSWORD}, headers=headers)

        assert "password" in remote_client().get("/api/status").json()["authMethods"]
