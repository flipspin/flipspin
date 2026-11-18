"""Account administration, current identity and device routes over HTTP.

Keep revocation immediate, account scope intact and credentials private.
Use isolated account files and preserve legacy synthetic principals.
See docs/security.md#account-routes.
"""
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.auth import is_public_route
from app.domains.accounts.identity import (
    LEGACY_OWNER,
    LOCAL_OWNER,
    ROLE_MEMBER,
    ROLE_OWNER,
    TokenStore,
    hash_token,
)
from app.main import app

GATED_PATH = "/api/get-basedir"
ME_PATH = "/api/me"
DEVICES_PATH = "/api/me/devices"
SHARED = "s3cret-shared-token"


@pytest.fixture
def store(tmp_path, monkeypatch):
    """A throwaway token table, wired into the live app."""
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    # Force the container to rebuild against the new path (and drop it after, so
    # the next test file does not inherit a deleted tmpdir).
    app.state.container._services.pop("token_store", None)
    yield app.state.container.get_token_store()
    app.state.container._services.pop("token_store", None)


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def local_client() -> TestClient:
    return TestClient(app)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestPerUserTokensAuthenticate:
    def test_a_member_token_works_from_the_network_with_no_shared_secret(self, store):
        """The reason the card exists: a phone, without KROBI_API_TOKEN."""
        _, token = store.mint("Ana (iPhone)", ROLE_MEMBER)
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200

    def test_an_unknown_token_is_still_refused(self, store):
        store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(GATED_PATH, headers=bearer("nope")).status_code == 401

    def test_all_three_transports_carry_a_per_user_token(self, store):
        from app.domains.accounts import auth

        _, token = store.mint("Ana", ROLE_MEMBER)
        client = remote_client()
        assert client.get(GATED_PATH, headers=bearer(token)).status_code == 200
        assert client.get(GATED_PATH, headers={auth.TOKEN_HEADER: token}).status_code == 200
        assert client.get(
            f"{GATED_PATH}?{auth.TOKEN_QUERY_PARAM}={token}"
        ).status_code == 200

    def test_two_tokens_resolve_to_two_distinct_principals(self, store):
        """Both tokens work, and they are not the same person.

        The identity *channel* (``request.state.principal``) is exercised over
        HTTP by the owner-only tests below — a member token reaching
        ``require_owner`` and being refused is that channel working.
        """
        ana, ana_token = store.mint("Ana", ROLE_MEMBER)
        beto, beto_token = store.mint("Beto", ROLE_MEMBER)

        for token in (ana_token, beto_token):
            assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200

        first, second = store.resolve(ana_token), store.resolve(beto_token)
        assert (first.user_id, first.label) == (ana.user_id, "Ana")
        assert (second.user_id, second.label) == (beto.user_id, "Beto")
        assert first.user_id != second.user_id

    def test_a_revoked_token_is_rejected_on_the_next_request(self, store):
        store.mint("Robin", ROLE_OWNER)
        phone, token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200

        store.revoke(phone.user_id)

        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 401

    def test_a_per_user_token_works_alongside_a_configured_shared_secret(
        self, store, monkeypatch
    ):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        _, token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200
        assert remote_client().get(GATED_PATH, headers=bearer(SHARED)).status_code == 200


class TestLegacyTokenIsAnOwner:
    def test_the_shared_secret_still_authenticates(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().get(GATED_PATH, headers=bearer(SHARED)).status_code == 200

    def test_the_shared_secret_can_manage_users(self, store, monkeypatch):
        """Legacy installs keep full control after the upgrade, or they are stuck."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        response = remote_client().get("/api/users", headers=bearer(SHARED))
        assert response.status_code == 200
        assert LEGACY_OWNER.role == ROLE_OWNER


class TestUserManagementApi:
    def test_minting_returns_the_token_exactly_once(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        created = local_client().post("/api/users", json={"label": "Ana", "role": "member"},
                                      headers=bearer(owner_token))
        assert created.status_code == 201
        token = created.json()["token"]
        assert token

        listed = local_client().get("/api/users").json()["users"]
        assert [u["label"] for u in listed] == ["Robin", "Ana"]
        # Neither the token nor its digest is ever in the listing.
        assert token not in str(listed)
        assert "token" not in listed[0]
        assert "token_sha256" not in listed[0]
        # And it really is a working credential.
        assert remote_client().get(GATED_PATH, headers=bearer(token)).status_code == 200

    def test_revoking_through_the_api(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        created = local_client().post("/api/users", json={"label": "Ana"}, headers=bearer(owner_token)).json()
        user_id = created["user"]["id"]

        assert local_client().delete(f"/api/users/{user_id}", headers=bearer(owner_token)).status_code == 200
        assert local_client().get("/api/users").json()["users"] == [
            u for u in local_client().get("/api/users").json()["users"]
            if u["label"] == "Robin"
        ]
        assert remote_client().get(
            GATED_PATH, headers=bearer(created["token"])
        ).status_code == 401

    def test_revoking_an_unknown_user_is_a_404(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        assert local_client().delete("/api/users/nope", headers=bearer(owner_token)).status_code == 404

    def test_the_last_owner_cannot_be_revoked(self, store):
        owner, owner_token = store.mint("Robin", ROLE_OWNER)
        store.mint("Ana", ROLE_MEMBER)
        response = local_client().delete(f"/api/users/{owner.user_id}", headers=bearer(owner_token))
        assert response.status_code == 422
        assert "owner" in response.json()["detail"].lower()

    def test_an_unknown_role_is_refused_rather_than_downgraded_silently(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        assert local_client().post(
            "/api/users", json={"label": "Ana", "role": "admin"}, headers=bearer(owner_token)
        ).status_code == 422

    def test_a_blank_label_is_refused(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        assert local_client().post("/api/users", json={"label": "   "}, headers=bearer(owner_token)).status_code == 422


class TestUserManagementIsOwnerOnly:
    def test_a_member_cannot_read_the_table(self, store):
        _, token = store.mint("Ana", ROLE_MEMBER)
        response = remote_client().get("/api/users", headers=bearer(token))
        assert response.status_code == 403

    def test_a_member_cannot_mint_or_revoke(self, store):
        victim, _ = store.mint("Robin", ROLE_OWNER)
        _, token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().post(
            "/api/users", json={"label": "Sneaky", "role": "owner"}, headers=bearer(token)
        ).status_code == 403
        assert remote_client().delete(
            f"/api/users/{victim.user_id}", headers=bearer(token)
        ).status_code == 403

    def test_an_owner_token_can(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)
        assert remote_client().get("/api/users", headers=bearer(token)).status_code == 200

    def test_the_router_is_gated_like_every_other_router(self, store, monkeypatch):
        """401 before 403: no token at all must not leak the owner check."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().get("/api/users").status_code == 401

    def test_an_opted_out_remote_caller_is_not_an_owner(self, store, monkeypatch):
        """KROBI_ALLOW_UNAUTHENTICATED_REMOTE turns auth off; it must not also
        hand access management to whoever finds the port."""
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert remote_client().get(GATED_PATH).status_code == 200
        assert remote_client().get("/api/users").status_code == 403


class TestStoreIsolation:
    def test_the_store_follows_the_configured_path(self, tmp_path, monkeypatch):
        """Config-derived, so a relocated ~/Krobi (or a test) gets its own table."""
        first = tmp_path / "a" / "users.json"
        second = tmp_path / "b" / "users.json"
        monkeypatch.setattr(app.state.config, "users_file", first)
        app.state.container._services.pop("token_store", None)
        try:
            store_a = app.state.container.get_token_store()
            store_a.mint("Ana")
            monkeypatch.setattr(app.state.config, "users_file", second)
            store_b = app.state.container.get_token_store()
            assert isinstance(store_b, TokenStore)
            assert store_b.path == second
            assert store_b.list_users() == []
        finally:
            app.state.container._services.pop("token_store", None)


class TestWhoAmI:
    """``GET /api/me`` — the only way a client can learn which principal it is."""

    def test_a_per_user_token_gets_its_own_row(self, store):
        record, token = store.mint("Ana (iPhone)", ROLE_MEMBER)
        body = remote_client().get(ME_PATH, headers=bearer(token)).json()

        assert body["id"] == record.user_id
        assert body["label"] == "Ana (iPhone)"
        assert body["role"] == ROLE_MEMBER
        assert body["isOwner"] is False
        assert body["source"] == "token"
        assert body["createdAt"] == record.created_at

    def test_the_body_matches_the_listing_row_field_for_field(self, store):
        """The point of the endpoint: the client can mark its own row."""
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        listed = remote_client().get("/api/users", headers=bearer(owner_token)).json()["users"]
        me = remote_client().get(ME_PATH, headers=bearer(owner_token)).json()

        mine = [row for row in listed if row["id"] == me["id"]]
        assert len(mine) == 1
        assert (mine[0]["label"], mine[0]["role"]) == (me["label"], me["role"])
        assert mine[0]["createdAt"] == me["createdAt"]

    def test_a_member_token_is_not_refused(self, store):
        """Not owner-gated: a member asking who it is, is the whole point."""
        _, token = store.mint("Ana", ROLE_MEMBER)
        response = remote_client().get(ME_PATH, headers=bearer(token))
        assert response.status_code == 200
        assert response.json()["isOwner"] is False

    def test_an_owner_token_says_so(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)
        body = remote_client().get(ME_PATH, headers=bearer(token)).json()
        assert (body["role"], body["isOwner"]) == (ROLE_OWNER, True)

    def test_the_shared_secret_is_a_synthetic_owner_with_no_row(self, store, monkeypatch):
        """It must not look like a row the settings panel could revoke by id."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        body = remote_client().get(ME_PATH, headers=bearer(SHARED)).json()

        assert body["id"] == LEGACY_OWNER.user_id
        assert body["source"] == "shared-secret"
        assert body["isOwner"] is True
        assert body["createdAt"] is None and body["lastSeenAt"] is None

    def test_the_loopback_client_with_no_token_configured(self, store):
        """The desktop app talking to its own backend: an owner, and not a row."""
        body = local_client().get(ME_PATH).json()

        assert body["id"] == LOCAL_OWNER.user_id
        assert body["source"] == "local"
        assert body["isOwner"] is True
        assert body["createdAt"] is None

    def test_an_opted_out_remote_caller_is_anonymous_and_not_an_owner(
        self, store, monkeypatch
    ):
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        body = remote_client().get(ME_PATH).json()

        assert body["source"] == "anonymous"
        assert body["isOwner"] is False
        assert body["role"] == ROLE_MEMBER

    def test_no_token_is_a_401_like_every_other_gated_route(self, store, monkeypatch):
        """Not public: an unauthenticated identity probe would fingerprint the box."""
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().get(ME_PATH).status_code == 401
        assert not is_public_route("GET", ME_PATH)

    def test_an_unknown_token_is_refused(self, store):
        store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(ME_PATH, headers=bearer("nope")).status_code == 401

    def test_no_token_or_digest_appears_in_the_body(self, store, monkeypatch):
        """The store holds only digests, and that must stay true of every body."""
        record, token = store.mint("Ana", ROLE_MEMBER)
        digest = hash_token(token)

        raw = remote_client().get(ME_PATH, headers=bearer(token)).text
        assert token not in raw
        assert digest not in raw
        assert "token_sha256" not in raw
        assert set(remote_client().get(ME_PATH, headers=bearer(token)).json()) == {
            "id",
            "username",
            "label",
            "role",
            "isOwner",
            "onboarded",
            "source",
            "createdAt",
            "lastSeenAt",
        }

        # And the same for the shared secret, whose plaintext is the only other
        # credential the endpoint ever sees.
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert SHARED not in remote_client().get(ME_PATH, headers=bearer(SHARED)).text

    def test_a_revoked_token_cannot_still_ask(self, store):
        store.mint("Robin", ROLE_OWNER)
        phone, token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(ME_PATH, headers=bearer(token)).status_code == 200

        store.revoke(phone.user_id)

        assert remote_client().get(ME_PATH, headers=bearer(token)).status_code == 401


def devices_of(token: str) -> list:
    return remote_client().get(DEVICES_PATH, headers=bearer(token)).json()["devices"]


def current_device_id(token: str) -> str:
    """The id of the device that token *is*, as the listing marks it."""
    return next(d["id"] for d in devices_of(token) if d["isCurrent"])


class TestMyDevices:
    """``/api/me/devices`` — one account, several machines.

    The defect these routes exist to fix: with one digest per user, a token
    *was* a person, so pairing a laptop minted a second person with a second
    library. Every test below is a statement that this is no longer true.
    """

    def test_a_fresh_account_lists_exactly_the_device_it_was_minted_with(self, store):
        record, token = store.mint("Ana (iPhone)", ROLE_MEMBER)
        listed = devices_of(token)

        assert len(listed) == 1
        assert listed[0]["label"] == "Ana (iPhone)"
        assert listed[0]["isCurrent"] is True
        assert listed[0]["id"] == record.devices[0].device_id

    def test_a_member_can_add_their_own_laptop(self, store):
        """No owner in sight: the point of not gating these on ``require_owner``."""
        _, phone_token = store.mint("Ana", ROLE_MEMBER)

        created = remote_client().post(
            DEVICES_PATH, json={"label": "Ana (MacBook)"}, headers=bearer(phone_token)
        )

        assert created.status_code == 201
        laptop_token = created.json()["token"]
        assert remote_client().get(
            GATED_PATH, headers=bearer(laptop_token)
        ).status_code == 200

    def test_the_new_device_is_the_same_person(self, store):
        """The whole feature: the Mac joins the phone's account, not its own."""
        account, phone_token = store.mint("Robin", ROLE_OWNER)
        mac_token = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()["token"]

        from_phone = remote_client().get(ME_PATH, headers=bearer(phone_token)).json()
        from_mac = remote_client().get(ME_PATH, headers=bearer(mac_token)).json()

        assert from_mac["id"] == from_phone["id"] == account.user_id
        assert from_mac["role"] == ROLE_OWNER, "a device inherits its account's role"
        # And the household still contains exactly one person.
        assert len(remote_client().get("/api/users", headers=bearer(phone_token)).json()["users"]) == 1

    def test_the_listing_marks_only_the_calling_device(self, store):
        _, phone_token = store.mint("Robin", ROLE_OWNER)
        mac_token = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()["token"]

        from_phone = devices_of(phone_token)
        from_mac = devices_of(mac_token)

        assert [d["label"] for d in from_phone] == ["Robin", "MacBook"]
        assert [d["isCurrent"] for d in from_phone] == [True, False]
        assert [d["isCurrent"] for d in from_mac] == [False, True]

    def test_a_caller_sees_only_its_own_devices(self, store):
        _, robin_token = store.mint("Robin", ROLE_OWNER)
        _, ana_token = store.mint("Ana", ROLE_MEMBER)
        remote_client().post(
            DEVICES_PATH, json={"label": "Ana (laptop)"}, headers=bearer(ana_token)
        )

        assert [d["label"] for d in devices_of(robin_token)] == ["Robin"]
        assert [d["label"] for d in devices_of(ana_token)] == ["Ana", "Ana (laptop)"]

    def test_no_token_or_digest_ever_appears_in_the_listing(self, store):
        _, phone_token = store.mint("Robin", ROLE_OWNER)
        mac_token = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()["token"]

        raw = remote_client().get(DEVICES_PATH, headers=bearer(phone_token)).text
        assert phone_token not in raw
        assert mac_token not in raw
        assert hash_token(mac_token) not in raw
        assert "token" not in raw

    def test_a_blank_label_is_refused(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)
        assert remote_client().post(
            DEVICES_PATH, json={"label": "   "}, headers=bearer(token)
        ).status_code == 422
        assert remote_client().post(
            DEVICES_PATH, json={}, headers=bearer(token)
        ).status_code == 422

    def test_revoking_another_device_kills_that_token_only(self, store):
        _, phone_token = store.mint("Robin", ROLE_OWNER)
        mac_token = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()["token"]
        mac_id = current_device_id(mac_token)

        response = remote_client().delete(
            f"{DEVICES_PATH}/{mac_id}", headers=bearer(phone_token)
        )

        assert response.status_code == 200
        assert response.json()["signedOutThisDevice"] is False
        assert response.json()["device"]["label"] == "MacBook"
        assert remote_client().get(GATED_PATH, headers=bearer(mac_token)).status_code == 401
        assert remote_client().get(GATED_PATH, headers=bearer(phone_token)).status_code == 200

    def test_revoking_your_own_device_works_and_says_so(self, store):
        """Signing this machine out is supported — and the next request is a 401."""
        _, phone_token = store.mint("Robin", ROLE_OWNER)
        remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        )
        phone_id = current_device_id(phone_token)

        response = remote_client().delete(
            f"{DEVICES_PATH}/{phone_id}", headers=bearer(phone_token)
        )

        assert response.status_code == 200
        body = response.json()
        assert body["signedOutThisDevice"] is True, "the client must know to show a login"
        assert body["device"]["id"] == phone_id
        assert remote_client().get(GATED_PATH, headers=bearer(phone_token)).status_code == 401

    def test_the_last_device_cannot_be_revoked(self, store):
        """Protect the last device when no recovery credential can restore access.

        Adding another device requires an existing account credential; owner-only
        account deletion remains a separate operation."""
        store.mint("Robin", ROLE_OWNER)
        ana, ana_token = store.mint("Ana", ROLE_MEMBER)
        only_id = current_device_id(ana_token)

        response = remote_client().delete(
            f"{DEVICES_PATH}/{only_id}", headers=bearer(ana_token)
        )

        assert response.status_code == 422
        assert "only device" in response.json()["detail"].lower()
        assert remote_client().get(GATED_PATH, headers=bearer(ana_token)).status_code == 200

    def test_the_owner_route_is_how_a_person_is_removed_devices_and_all(self, store):
        """The escape hatch the 422 above points at, and it takes every device."""
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        ana, ana_token = store.mint("Ana", ROLE_MEMBER)
        laptop_token = remote_client().post(
            DEVICES_PATH, json={"label": "Ana (laptop)"}, headers=bearer(ana_token)
        ).json()["token"]

        assert remote_client().delete(
            f"/api/users/{ana.user_id}", headers=bearer(owner_token)
        ).status_code == 200

        assert remote_client().get(GATED_PATH, headers=bearer(ana_token)).status_code == 401
        assert remote_client().get(GATED_PATH, headers=bearer(laptop_token)).status_code == 401

    def test_another_accounts_device_is_a_404_and_survives(self, store):
        """Not 403: telling "not yours" from "no such id" is an enumeration oracle."""
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        _, ana_token = store.mint("Ana", ROLE_MEMBER)
        ana_device = current_device_id(ana_token)

        response = remote_client().delete(
            f"{DEVICES_PATH}/{ana_device}", headers=bearer(owner_token)
        )

        assert response.status_code == 404
        assert remote_client().get(GATED_PATH, headers=bearer(ana_token)).status_code == 200

    def test_an_unknown_device_id_is_a_404(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)
        assert remote_client().delete(
            f"{DEVICES_PATH}/nope", headers=bearer(token)
        ).status_code == 404

    def test_a_revoked_device_can_no_longer_manage_devices(self, store):
        _, phone_token = store.mint("Robin", ROLE_OWNER)
        mac_token = remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        ).json()["token"]
        mac_id = current_device_id(mac_token)
        remote_client().delete(f"{DEVICES_PATH}/{mac_id}", headers=bearer(phone_token))

        assert remote_client().get(DEVICES_PATH, headers=bearer(mac_token)).status_code == 401
        assert remote_client().post(
            DEVICES_PATH, json={"label": "Sneaky"}, headers=bearer(mac_token)
        ).status_code == 401


class TestAnAccountsDevicesForTheOwner:
    """``GET /api/users/{id}/devices`` — the owner unfolds one account."""

    def test_the_owner_sees_another_accounts_devices(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        ana, ana_token = store.mint("Ana", ROLE_MEMBER)
        remote_client().post(
            DEVICES_PATH, json={"label": "Ana (laptop)"}, headers=bearer(ana_token)
        )

        response = remote_client().get(
            f"/api/users/{ana.user_id}/devices", headers=bearer(owner_token)
        )

        assert response.status_code == 200
        rows = response.json()["devices"]
        assert [d["label"] for d in rows] == ["Ana", "Ana (laptop)"]
        assert set(rows[0]) == {
            "id", "label", "createdAt", "lastSeenAt", "isCurrent", "helper", "credentialType",
            "firstSubsonicRequestAt", "lastSubsonicRequestAt", "subsonicClientName",
            "lastSubsonicFailureAt", "lastSubsonicFailure",
        }
        # Nobody else's device can be the one this request arrived with.
        assert [d["isCurrent"] for d in rows] == [False, False]

    def test_the_owners_own_account_marks_the_calling_device(self, store):
        robin, phone_token = store.mint("Robin", ROLE_OWNER)
        remote_client().post(
            DEVICES_PATH, json={"label": "MacBook"}, headers=bearer(phone_token)
        )

        rows = remote_client().get(
            f"/api/users/{robin.user_id}/devices", headers=bearer(phone_token)
        ).json()["devices"]

        assert [d["isCurrent"] for d in rows] == [True, False]
        assert rows[0]["id"] == current_device_id(phone_token)

    def test_a_member_is_refused(self, store):
        robin, _ = store.mint("Robin", ROLE_OWNER)
        _, ana_token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(
            f"/api/users/{robin.user_id}/devices", headers=bearer(ana_token)
        ).status_code == 403

    def test_an_unknown_account_is_a_404(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        assert remote_client().get(
            "/api/users/nope/devices", headers=bearer(owner_token)
        ).status_code == 404

    def test_no_token_or_digest_ever_appears(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        ana, ana_token = store.mint("Ana", ROLE_MEMBER)
        raw = remote_client().get(
            f"/api/users/{ana.user_id}/devices", headers=bearer(owner_token)
        ).text
        assert ana_token not in raw
        assert hash_token(ana_token) not in raw
        assert "token" not in raw


class TestRenamingAnAccount:
    """``POST /api/me/label`` and ``POST /api/users/{id}/label``.

    The label is the household name, not the username and not a device: the
    first account on a server is named after the phone that claimed it, and
    these two routes are how "Robin (iPhone)" becomes "Robin" without
    touching the device of that name.
    """

    def test_an_account_renames_itself_and_its_device_keeps_its_name(self, store):
        record, token = store.mint("Robin (iPhone)", ROLE_OWNER)

        response = remote_client().post(
            "/api/me/label", json={"label": "Robin"}, headers=bearer(token)
        )

        assert response.status_code == 200
        assert response.json() == {"user": store.get_user(record.user_id).public()}
        assert response.json()["user"]["label"] == "Robin"
        assert set(response.json()["user"]) == {"id", "label", "role", "createdAt", "lastSeenAt"}
        # The device was correctly named after the phone; only the account was not.
        devices = remote_client().get(DEVICES_PATH, headers=bearer(token)).json()["devices"]
        assert [d["label"] for d in devices] == ["Robin (iPhone)"]
        # Every list shows the new name.
        assert remote_client().get(ME_PATH, headers=bearer(token)).json()["label"] == "Robin"

    def test_the_username_is_untouched_by_a_rename(self, store):
        record, token = store.mint("Robin (iPhone)", ROLE_OWNER)
        store.set_username(record.user_id, "robinpw")

        remote_client().post("/api/me/label", json={"label": "Robin"}, headers=bearer(token))

        me = remote_client().get(ME_PATH, headers=bearer(token)).json()
        assert (me["username"], me["label"]) == ("robinpw", "Robin")

    def test_a_blank_name_is_refused(self, store):
        _, token = store.mint("Robin (iPhone)", ROLE_OWNER)
        assert remote_client().post(
            "/api/me/label", json={"label": "   "}, headers=bearer(token)
        ).status_code == 422

    def test_a_sentinel_principal_has_nothing_to_rename(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", "s3cret-shared-token")
        assert remote_client().post(
            "/api/me/label", json={"label": "Robin"}, headers=bearer("s3cret-shared-token")
        ).status_code == 409

    def test_the_owner_renames_another_account(self, store):
        _, owner_token = remote_owner(store)
        sam, sam_token = store.mint("Sam (iPhone)", ROLE_MEMBER)

        response = remote_client().post(
            f"/api/users/{sam.user_id}/label",
            json={"label": "Sam"},
            headers=bearer(owner_token),
        )

        assert response.status_code == 200
        assert response.json()["user"]["label"] == "Sam"
        rows = remote_client().get("/api/users", headers=bearer(owner_token)).json()["users"]
        assert {r["label"] for r in rows} == {"Robin", "Sam"}
        # Sam's own view agrees, and their phone is still their phone.
        assert remote_client().get(ME_PATH, headers=bearer(sam_token)).json()["label"] == "Sam"
        devices = remote_client().get(DEVICES_PATH, headers=bearer(sam_token)).json()["devices"]
        assert [d["label"] for d in devices] == ["Sam (iPhone)"]

    def test_a_member_may_not_rename_anybody_else(self, store):
        robin, _ = remote_owner(store)
        _, ana_token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().post(
            f"/api/users/{robin.user_id}/label", json={"label": "Nick"}, headers=bearer(ana_token)
        ).status_code == 403

    def test_renaming_an_unknown_account_is_a_404(self, store):
        _, owner_token = remote_owner(store)
        assert remote_client().post(
            "/api/users/nope/label", json={"label": "Nadie"}, headers=bearer(owner_token)
        ).status_code == 404


def remote_owner(store):
    return store.mint("Robin", ROLE_OWNER)


class TestDevicesRefuseSentinelPrincipals:
    """``local``, ``shared-secret`` and ``anonymous`` have no account.

    409, exactly like ``/api/me/library`` — the caller is often an *owner*, so
    it is not a permission problem; there is simply no account for a device to
    join, and a device filed under ``local`` would belong to whoever next runs
    the desktop app on that machine.
    """

    def test_the_loopback_client_has_no_account(self, store):
        assert local_client().get(DEVICES_PATH).status_code == 409
        assert local_client().post(DEVICES_PATH, json={"label": "Mac"}).status_code == 409
        assert local_client().delete(f"{DEVICES_PATH}/whatever").status_code == 409

    def test_the_shared_secret_has_no_account(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().get(DEVICES_PATH, headers=bearer(SHARED)).status_code == 409
        assert remote_client().post(
            DEVICES_PATH, json={"label": "Mac"}, headers=bearer(SHARED)
        ).status_code == 409

    def test_an_opted_out_remote_caller_has_no_account(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert remote_client().get(DEVICES_PATH).status_code == 409

    def test_no_token_at_all_is_a_401_before_any_of_that(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().get(DEVICES_PATH).status_code == 401
        assert not is_public_route("GET", DEVICES_PATH)


#: The live server's ``users.json``, in the shape it is actually in: one
#: ``token_sha256`` per user, no devices. Shared with ``tests/unit/
#: test_identity_store.py``, which documents the two plaintexts.
V1_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "users_v1.json"
V1_OWNER_TOKEN = "owner-token-from-the-live-server"
V1_MEMBER_TOKEN = "member-token-from-the-live-server"


class TestTheLiveTableKeepsWorking:
    """The upgrade path, end to end, from a file nobody edited.

    The store's own migration is unit-tested; this asserts the thing the
    household actually experiences — the token already on the phone still gets
    in, is still the same person, and can now bring a laptop along.
    """

    @pytest.fixture
    def legacy(self, store):
        # The store loads lazily, so dropping the old file at its path before
        # the first request is exactly what a server restart after an upgrade
        # looks like.
        shutil.copy(V1_FIXTURE, store.path)
        return store

    def test_the_token_on_the_phone_still_authenticates(self, legacy):
        assert remote_client().get(
            GATED_PATH, headers=bearer(V1_OWNER_TOKEN)
        ).status_code == 200
        assert remote_client().get(
            GATED_PATH, headers=bearer(V1_MEMBER_TOKEN)
        ).status_code == 200

    def test_the_old_rows_are_the_same_people_they_were(self, legacy):
        body = remote_client().get(ME_PATH, headers=bearer(V1_OWNER_TOKEN)).json()
        assert (body["id"], body["label"], body["role"]) == (
            "5f3c1a2b9d40",
            "Robin (iPhone)",
            ROLE_OWNER,
        )
        assert body["source"] == "token"

        listed = remote_client().get("/api/users", headers=bearer(V1_OWNER_TOKEN)).json()
        assert [u["label"] for u in listed["users"]] == ["Robin (iPhone)", "Ana (iPhone)"]

    def test_a_migrated_account_can_add_a_laptop_and_keep_the_phone(self, legacy):
        """The feature arriving on data that predates it."""
        created = remote_client().post(
            DEVICES_PATH, json={"label": "Robin (MacBook)"}, headers=bearer(V1_OWNER_TOKEN)
        )
        assert created.status_code == 201
        mac_token = created.json()["token"]

        assert remote_client().get(ME_PATH, headers=bearer(mac_token)).json()["id"] == (
            remote_client().get(ME_PATH, headers=bearer(V1_OWNER_TOKEN)).json()["id"]
        )
        assert remote_client().get(
            GATED_PATH, headers=bearer(V1_OWNER_TOKEN)
        ).status_code == 200, "the rewrite must not spend the old credential"
        assert [d["label"] for d in devices_of(V1_OWNER_TOKEN)] == [
            "Robin (iPhone)",
            "Robin (MacBook)",
        ]

    def test_the_migrated_device_can_be_listed_and_then_revoked(self, legacy):
        """Only true because the migrated id is stable across loads."""
        remote_client().post(
            DEVICES_PATH, json={"label": "Robin (MacBook)"}, headers=bearer(V1_OWNER_TOKEN)
        )
        phone_id = current_device_id(V1_OWNER_TOKEN)

        response = remote_client().delete(
            f"{DEVICES_PATH}/{phone_id}", headers=bearer(V1_OWNER_TOKEN)
        )

        assert response.status_code == 200
        assert response.json()["signedOutThisDevice"] is True
        assert remote_client().get(
            GATED_PATH, headers=bearer(V1_OWNER_TOKEN)
        ).status_code == 401


class TestRenameMyDevice:
    @pytest.mark.parametrize("current", [True, False])
    def test_member_renames_own_device_without_changing_identity(self, store, current):
        account, token = store.mint("Ana", ROLE_MEMBER)
        _, laptop, laptop_token = store.add_device(account.user_id, "Laptop")
        device_id = account.devices[0].device_id if current else laptop.device_id
        reply = remote_client().patch(
            f"{DEVICES_PATH}/{device_id}", json={"label": "  Equipo de Ana  "}, headers=bearer(token)
        )
        assert reply.status_code == 200
        assert reply.json()["label"] == "Equipo de Ana"
        assert reply.json()["isCurrent"] is current
        assert next(d for d in devices_of(token) if d["id"] == device_id) == reply.json()
        assert store.resolve(laptop_token).user_id == account.user_id
        assert remote_client().get(ME_PATH, headers=bearer(token)).json()["label"] == "Ana"

    @pytest.mark.parametrize("label", ["", " ", "x" * 81, "Mac\n", "\tMac", "Mac\x00", "Mac\x7f", "Mac\x85", None, 42])
    def test_invalid_labels_return_422(self, store, label):
        account, token = store.mint("Ana", ROLE_MEMBER)
        response = remote_client().patch(
            f"{DEVICES_PATH}/{account.devices[0].device_id}", json={"label": label}, headers=bearer(token)
        )
        assert response.status_code == 422
        assert devices_of(token)[0]["label"] == "Ana"

    def test_missing_label_and_boundary_lengths(self, store):
        account, token = store.mint("Ana")
        path = f"{DEVICES_PATH}/{account.devices[0].device_id}"
        assert remote_client().patch(path, json={}, headers=bearer(token)).status_code == 422
        for label in ["é", "é" * 80, "  " + "é" * 80 + "  "]:
            reply = remote_client().patch(path, json={"label": label}, headers=bearer(token))
            assert reply.status_code == 200
            assert reply.json()["label"] == label.strip()

    def test_owner_cannot_rename_another_accounts_device(self, store):
        _, token = store.mint("Admin", ROLE_OWNER)
        other, _ = store.mint("Ana", ROLE_MEMBER)
        for device_id in [other.devices[0].device_id, "unknown"]:
            reply = remote_client().patch(
                f"{DEVICES_PATH}/{device_id}", json={"label": "Mac"}, headers=bearer(token)
            )
            assert reply.status_code == 404
            assert reply.json() == {"detail": f"Unknown device '{device_id}'"}
        assert store.get_user(other.user_id) == other

    def test_sentinels_have_no_device_to_rename(self, store, monkeypatch):
        path = f"{DEVICES_PATH}/anything"
        assert local_client().patch(path, json={"label": "Mac"}).status_code == 409
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert remote_client().patch(path, json={"label": "Mac"}).status_code == 409
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().patch(path, json={"label": "Mac"}, headers=bearer(SHARED)).status_code == 409
        assert remote_client().patch(path, json={"label": "Mac"}).status_code == 401
        assert not is_public_route("PATCH", path)

    def test_old_and_explicit_helpers_keep_authenticating_and_are_marked(self, store):
        account, token = store.mint("Ana", ROLE_OWNER)
        for label, extra in [("big_chip · trabajador", {"helper": True}), ("big_chip", {"helper": True})]:
            created = remote_client().post(DEVICES_PATH, json={"label": label, **extra}, headers=bearer(token))
            assert created.status_code == 201
            helper_token = created.json()["token"]
            device_id = created.json()["device"]["id"]
            for path in [DEVICES_PATH, f"/api/users/{account.user_id}/devices"]:
                rows = remote_client().get(path, headers=bearer(token)).json()["devices"]
                assert next(d for d in rows if d["id"] == device_id)["helper"] is True
                assert rows[0]["helper"] is False
            renamed = remote_client().patch(f"{DEVICES_PATH}/{device_id}", json={"label": "big_chip"}, headers=bearer(token))
            assert renamed.json()["helper"] is True
            assert store.resolve(helper_token).device_id == device_id
