"""Account-file persistence, credentials, devices and supported migrations.

Keep tokens hashed, device identities stable and malformed files closed.
Use isolated account files and checked-in legacy fixtures.
See docs/security.md#account-storage.
"""
import json
import os
import shutil
import stat
from dataclasses import replace
from pathlib import Path

from app.infra.migrations import StoreRefusal

import pytest

from app.domains.accounts.identity import (
    LastDeviceError,
    LastOwnerError,
    ROLE_MEMBER,
    ROLE_OWNER,
    IdentityError,
    InvalidCredentialsError,
    InvalidUsernameError,
    TokenStore,
    UnknownDeviceError,
    UnknownUserError,
    UsernameRequiredError,
    UsernameTakenError,
    WeakPasswordError,
    hash_token,
)

#: A ``users.json`` in the old shape, exactly as the live server holds one.
#: Its digests are the sha256 of the two plaintexts below — written down here
#: because they are not secrets, they are the whole point: the migration has to
#: keep credentials that already exist working.
V1_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "users_v1.json"
V1_OWNER_TOKEN = "owner-token-from-the-live-server"
V1_MEMBER_TOKEN = "member-token-from-the-live-server"
V1_OWNER_ID = "5f3c1a2b9d40"
V1_MEMBER_ID = "a71e0c4488b6"

#: A ``users.json`` in the shape the live server holds one now: accounts with
#: devices, and no username or password anywhere, because those did not exist
#: when it was written. Its digests are the sha256 of the three plaintexts below,
#: written down for the same reason the v1 ones are — the migration exists to
#: keep credentials that already exist working.
V2_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "users_v2.json"
V2_OWNER_PHONE_TOKEN = "owner-phone-token-from-the-live-server"
V2_OWNER_MAC_TOKEN = "owner-mac-token-from-the-live-server"
V2_MEMBER_TOKEN = "member-token-from-the-live-server"
V2_OWNER_ID = "5f3c1a2b9d40"
V2_MEMBER_ID = "a71e0c4488b6"


@pytest.fixture
def store(tmp_path: Path) -> TokenStore:
    return TokenStore(tmp_path / "users.json")


class TestMintAndResolve:
    def test_two_tokens_resolve_to_two_distinct_principals(self, store):
        """The whole point of the card: the backend can tell the family apart."""
        ana, ana_token = store.mint("Ana", ROLE_MEMBER)
        beto, beto_token = store.mint("Beto", ROLE_MEMBER)

        assert ana_token != beto_token
        assert ana.user_id != beto.user_id

        first = store.resolve(ana_token)
        second = store.resolve(beto_token)
        assert first.label == "Ana"
        assert second.label == "Beto"
        assert first.user_id != second.user_id

    def test_an_unknown_token_resolves_to_nobody(self, store):
        store.mint("Ana")
        assert store.resolve("not-a-real-token") is None
        assert store.resolve("") is None
        assert store.resolve(None) is None

    def test_a_revoked_token_stops_working(self, store):
        store.mint("Owner", ROLE_OWNER)
        phone, token = store.mint("Phone", ROLE_MEMBER)
        assert store.resolve(token) is not None

        store.revoke(phone.user_id)

        assert store.resolve(token) is None
        assert [u.label for u in store.list_users()] == ["Owner"]

    def test_the_plaintext_token_is_never_stored(self, store):
        _, token = store.mint("Ana")
        on_disk = store.path.read_text(encoding="utf-8")
        assert token not in on_disk
        assert hash_token(token) in on_disk

    def test_role_defaults_to_member_and_unknown_roles_do_not_widen(self, store):
        member, _ = store.mint("Ana")
        assert member.role == ROLE_MEMBER
        weird, _ = store.mint("Beto", "superuser")
        assert weird.role == ROLE_MEMBER

    def test_a_blank_label_is_refused(self, store):
        with pytest.raises(IdentityError):
            store.mint("   ")


class TestRevoke:
    def test_unknown_user_raises(self, store):
        with pytest.raises(UnknownUserError):
            store.revoke("nope")

    def test_the_last_owner_cannot_be_revoked(self, store):
        owner, _ = store.mint("Robin", ROLE_OWNER)
        store.mint("Phone", ROLE_MEMBER)
        with pytest.raises(LastOwnerError):
            store.revoke(owner.user_id)

    def test_an_owner_can_go_once_another_owner_exists(self, store):
        first, _ = store.mint("Robin", ROLE_OWNER)
        store.mint("Backup", ROLE_OWNER)
        store.revoke(first.user_id)
        assert [u.label for u in store.list_users()] == ["Backup"]


class TestPersistence:
    def test_the_table_round_trips_through_the_file(self, tmp_path: Path):
        path = tmp_path / "users.json"
        writer = TokenStore(path)
        _, owner_token = writer.mint("Robin", ROLE_OWNER)
        _, member_token = writer.mint("Ana", ROLE_MEMBER)

        reader = TokenStore(path)
        assert reader.resolve(owner_token).role == ROLE_OWNER
        assert reader.resolve(member_token).role == ROLE_MEMBER
        assert [u.label for u in reader.list_users()] == ["Robin", "Ana"]

    def test_a_missing_file_is_an_empty_table(self, tmp_path: Path):
        store = TokenStore(tmp_path / "nothing-here.json")
        assert store.list_users() == []
        assert store.has_users() is False

    @pytest.mark.parametrize(
        "content",
        [
            "{not json at all",
            "[]",
            '{"version": 1}',
            '{"version": 1, "users": "nope"}',
        ],
    )
    def test_a_corrupt_file_refuses_without_overwriting(self, tmp_path: Path, content):
        """A truncated account table must never reopen the claim window."""
        path = tmp_path / "users.json"
        path.write_text(content, encoding="utf-8")
        before = path.read_bytes()
        with pytest.raises(StoreRefusal) as error:
            TokenStore(path).list_users()
        assert error.value.code == 78
        assert path.read_bytes() == before

    def test_malformed_rows_refuse_without_dropping_data(self, tmp_path: Path):
        path = tmp_path / "users.json"
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "users": [
                        {"id": "a", "token_sha256": "deadbeef", "label": "Ana", "role": "member"},
                        {"id": "b"},               # no digest
                        "not a row",
                        {"token_sha256": "cafe"},  # no id
                    ],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(StoreRefusal):
            TokenStore(path).list_users()

    def test_saving_leaves_no_temp_files_behind(self, tmp_path: Path):
        store = TokenStore(tmp_path / "users.json")
        store.mint("Robin", ROLE_OWNER)
        store.mint("Ana")
        # The stable advisory-lock inode is intentional; no temporary data files.
        assert sorted(p.name for p in tmp_path.iterdir()) == ["users.json", "users.json.lock"]

    def test_the_file_is_owner_only(self, tmp_path: Path):
        """It holds credentials to the whole library on a shared home server."""
        store = TokenStore(tmp_path / "users.json")
        store.mint("Robin", ROLE_OWNER)
        mode = stat.S_IMODE(os.stat(store.path).st_mode)
        assert mode == 0o600

    def test_last_seen_is_recorded_on_first_use(self, tmp_path: Path):
        path = tmp_path / "users.json"
        store = TokenStore(path)
        record, token = store.mint("Ana")
        assert record.last_seen_at is None
        store.resolve(token)
        assert TokenStore(path).list_users()[0].last_seen_at is not None


class TestDevices:
    """One account, several machines — the reason this table was reshaped."""

    def test_a_new_account_starts_with_exactly_one_device(self, store):
        record, token = store.mint("Robin", ROLE_OWNER)
        assert len(record.devices) == 1
        assert record.devices[0].token_sha256 == hash_token(token)
        assert record.devices[0].label == "Robin"

    def test_a_second_device_is_the_same_person(self, store):
        """The feature in one assertion: the Mac joins the phone's account."""
        account, phone_token = store.mint("Robin", ROLE_OWNER)
        _, mac, mac_token = store.add_device(account.user_id, "Robin (MacBook)")

        from_phone = store.resolve(phone_token)
        from_mac = store.resolve(mac_token)

        assert from_phone.user_id == from_mac.user_id == account.user_id
        assert from_phone.role == from_mac.role == ROLE_OWNER
        # Same person, different credential — which is what makes one revocable
        # without the other.
        assert from_phone.device_id != from_mac.device_id
        assert from_mac.device_id == mac.device_id
        assert mac_token != phone_token
        # And still one row per person.
        assert len(store.list_users()) == 1

    def test_a_member_can_add_their_own_laptop(self, store):
        """No owner anywhere in this: role is not consulted by the store."""
        ana, _ = store.mint("Ana", ROLE_MEMBER)
        updated, _, laptop_token = store.add_device(ana.user_id, "Ana (laptop)")
        assert len(updated.devices) == 2
        assert store.resolve(laptop_token).role == ROLE_MEMBER

    def test_adding_a_device_to_an_unknown_account_raises(self, store):
        with pytest.raises(UnknownUserError):
            store.add_device("nobody", "Ghost laptop")

    def test_a_blank_device_label_is_refused(self, store):
        account, _ = store.mint("Robin", ROLE_OWNER)
        with pytest.raises(IdentityError):
            store.add_device(account.user_id, "   ")

    def test_revoking_one_device_leaves_the_other_working(self, store):
        account, phone_token = store.mint("Robin", ROLE_OWNER)
        _, mac, mac_token = store.add_device(account.user_id, "MacBook")

        store.revoke_device(account.user_id, mac.device_id)

        assert store.resolve(mac_token) is None
        assert store.resolve(phone_token).user_id == account.user_id
        assert len(store.list_users()) == 1

    def test_a_device_of_another_account_reads_as_unknown(self, store):
        """Not "forbidden": that would be an id oracle for the whole household."""
        robin, _ = store.mint("Robin", ROLE_OWNER)
        ana, _ = store.mint("Ana", ROLE_MEMBER)
        store.add_device(ana.user_id, "Ana (laptop)")
        victim = store.get_user(ana.user_id).devices[1]

        with pytest.raises(UnknownDeviceError):
            store.revoke_device(robin.user_id, victim.device_id)
        # And it really is untouched.
        assert len(store.get_user(ana.user_id).devices) == 2

    def test_revoking_an_unknown_device_raises(self, store):
        account, _ = store.mint("Robin", ROLE_OWNER)
        with pytest.raises(UnknownDeviceError):
            store.revoke_device(account.user_id, "no-such-device")

    def test_the_last_device_of_an_account_cannot_be_revoked(self, store):
        """Nothing could undo it: adding a device needs a token for that
        account, so zero devices would strand the account's library under an id
        nobody can ever present again. Deleting the person is the other route."""
        ana, token = store.mint("Ana", ROLE_MEMBER)
        only_device = ana.devices[0]

        with pytest.raises(LastDeviceError):
            store.revoke_device(ana.user_id, only_device.device_id)

        assert store.resolve(token) is not None

    def test_revoking_down_to_one_device_is_allowed_and_then_stops(self, store):
        ana, phone_token = store.mint("Ana", ROLE_MEMBER)
        _, laptop, laptop_token = store.add_device(ana.user_id, "laptop")

        store.revoke_device(ana.user_id, laptop.device_id)
        assert store.resolve(laptop_token) is None

        with pytest.raises(LastDeviceError):
            store.revoke_device(ana.user_id, ana.devices[0].device_id)
        assert store.resolve(phone_token) is not None

    def test_revoking_the_person_takes_every_device_with_it(self, store):
        """A revoke that dropped one credential would leave the other phone in."""
        store.mint("Robin", ROLE_OWNER)
        ana, phone_token = store.mint("Ana", ROLE_MEMBER)
        _, _, laptop_token = store.add_device(ana.user_id, "laptop")

        store.revoke(ana.user_id)

        assert store.resolve(phone_token) is None
        assert store.resolve(laptop_token) is None
        assert [u.label for u in store.list_users()] == ["Robin"]

    def test_last_seen_is_the_most_recent_across_the_account(self, store):
        """What ``/api/users`` reports: the person, not one of their machines."""
        account, phone_token = store.mint("Robin", ROLE_OWNER)
        _, mac, _ = store.add_device(account.user_id, "MacBook")

        store.resolve(phone_token)

        after = store.get_user(account.user_id)
        assert after.last_seen_at is not None
        assert after.device(mac.device_id).last_seen_at is None, "the Mac was not used"
        assert after.last_seen_at == after.devices[0].last_seen_at

    def test_devices_round_trip_through_the_file(self, tmp_path: Path):
        path = tmp_path / "users.json"
        writer = TokenStore(path)
        account, phone_token = writer.mint("Robin", ROLE_OWNER)
        _, mac, mac_token = writer.add_device(account.user_id, "MacBook")

        reader = TokenStore(path)
        assert reader.resolve(phone_token).user_id == account.user_id
        assert reader.resolve(mac_token).device_id == mac.device_id
        assert [d.label for d in reader.get_user(account.user_id).devices] == [
            "Robin",
            "MacBook",
        ]

    def test_no_plaintext_of_any_device_token_is_stored(self, store):
        account, phone_token = store.mint("Robin", ROLE_OWNER)
        _, _, mac_token = store.add_device(account.user_id, "MacBook")
        on_disk = store.path.read_text(encoding="utf-8")
        for token in (phone_token, mac_token):
            assert token not in on_disk
            assert hash_token(token) in on_disk


class TestMigrationFromTheOldShape:
    """A ``users.json`` written before accounts had devices.

    Every test here starts from ``tests/fixtures/users_v1.json``, copied into a
    tmpdir — the live server's file in the shape it is actually in, holding two
    people with one token each.
    """

    @pytest.fixture
    def legacy(self, tmp_path: Path) -> TokenStore:
        path = tmp_path / "users.json"
        shutil.copy(V1_FIXTURE, path)
        return TokenStore(path)

    def test_the_tokens_on_the_phones_keep_working(self, legacy):
        """The one that matters. A miss here locks the household out."""
        owner = legacy.resolve(V1_OWNER_TOKEN)
        member = legacy.resolve(V1_MEMBER_TOKEN)

        assert (owner.user_id, owner.role) == (V1_OWNER_ID, ROLE_OWNER)
        assert (member.user_id, member.role) == (V1_MEMBER_ID, ROLE_MEMBER)
        assert owner.label == "Robin (iPhone)"

    def test_each_old_row_becomes_an_account_with_exactly_one_device(self, legacy):
        rows = legacy.list_users()
        assert [(r.user_id, len(r.devices)) for r in rows] == [
            (V1_OWNER_ID, 1),
            (V1_MEMBER_ID, 1),
        ]
        device = rows[0].devices[0]
        assert device.token_sha256 == hash_token(V1_OWNER_TOKEN)
        assert device.label == "Robin (iPhone)"
        assert rows[0].created_at == "2026-08-20T11:02:31Z"

    def test_the_migrated_device_inherits_the_account_id_and_is_stable(self, tmp_path):
        """A fresh id per load is a device that can be listed and never revoked."""
        path = tmp_path / "users.json"
        shutil.copy(V1_FIXTURE, path)

        first = [r.devices[0].device_id for r in TokenStore(path).list_users()]
        second = [r.devices[0].device_id for r in TokenStore(path).list_users()]

        assert first == second == [V1_OWNER_ID, V1_MEMBER_ID]

    def test_the_old_last_seen_lands_on_the_device_and_still_reads_at_the_account(
        self, legacy
    ):
        owner = legacy.list_users()[0]
        assert owner.devices[0].last_seen_at == "2026-08-25T09:14:02Z"
        assert owner.last_seen_at == "2026-08-25T09:14:02Z"
        assert legacy.list_users()[1].last_seen_at is None

    def test_the_file_is_written_back_in_the_new_shape(self, legacy):
        legacy.add_device(V1_OWNER_ID, "Robin (MacBook)")
        raw = json.loads(legacy.path.read_text(encoding="utf-8"))

        # 3 rather than 2: a v1 file that gets rewritten lands in whatever the
        # current shape is, in one hop. Nothing reads this number — _parse_row
        # sniffs the row — so there is no intermediate state to preserve.
        assert raw["version"] == 3
        owner_row = raw["users"][0]
        assert "token_sha256" not in owner_row, "the digest moved onto the device"
        assert [d["label"] for d in owner_row["devices"]] == [
            "Robin (iPhone)",
            "Robin (MacBook)",
        ]

    def test_the_old_tokens_survive_the_rewrite(self, legacy):
        """The migration is on read; this proves the write does not undo it."""
        _, _, mac_token = legacy.add_device(V1_OWNER_ID, "Robin (MacBook)")

        reopened = TokenStore(legacy.path)
        assert reopened.resolve(V1_OWNER_TOKEN).user_id == V1_OWNER_ID
        assert reopened.resolve(V1_MEMBER_TOKEN).user_id == V1_MEMBER_ID
        assert reopened.resolve(mac_token).user_id == V1_OWNER_ID

    def test_a_migrated_account_can_lose_its_added_device_but_not_its_first(self, legacy):
        _, mac, mac_token = legacy.add_device(V1_MEMBER_ID, "Ana (laptop)")

        legacy.revoke_device(V1_MEMBER_ID, mac.device_id)
        assert legacy.resolve(mac_token) is None
        assert legacy.resolve(V1_MEMBER_TOKEN) is not None

        with pytest.raises(LastDeviceError):
            legacy.revoke_device(V1_MEMBER_ID, V1_MEMBER_ID)

    def test_an_old_row_with_no_digest_refuses(self, tmp_path: Path):
        """Do not turn a damaged account into an unclaimed server."""
        path = tmp_path / "users.json"
        path.write_text(
            json.dumps({"version": 1, "users": [{"id": "a", "label": "Ghost"}]}),
            encoding="utf-8",
        )
        before = path.read_bytes()
        with pytest.raises(StoreRefusal) as error:
            TokenStore(path).list_users()
        assert error.value.code == 78
        assert path.read_bytes() == before


class TestConcurrentWrites:
    """Every mutation reads and writes under one acquisition of the store lock.

    The backend is pinned to one process but not to one thread — every sync
    route runs on Starlette's threadpool — so two phones can add a device at the
    same instant. Read-modify-write on the account's device tuple is the classic
    lost update: both threads read one device, both append theirs, and whoever
    saves last silently destroys the other's credential *after* the API already
    handed out its plaintext. Same shape as the race
    ``claim_first_owner`` guards.
    """

    def test_devices_added_from_many_threads_all_survive(self, store):
        import threading

        account, _ = store.mint("Robin", ROLE_OWNER)
        tokens: list = []
        start = threading.Barrier(8)

        def add(n: int) -> None:
            start.wait()
            _, _, token = store.add_device(account.user_id, f"device-{n}")
            tokens.append(token)

        threads = [threading.Thread(target=add, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(tokens) == 8
        assert len(store.get_user(account.user_id).devices) == 9  # 8 + the minted one
        for token in tokens:
            assert store.resolve(token).user_id == account.user_id, "a lost update"

    def test_revokes_from_many_threads_leave_exactly_one_device(self, store):
        import threading

        account, _ = store.mint("Robin", ROLE_OWNER)
        added = [store.add_device(account.user_id, f"device-{n}")[1] for n in range(6)]
        start = threading.Barrier(len(added))
        refused: list = []

        def drop(device) -> None:
            start.wait()
            try:
                store.revoke_device(account.user_id, device.device_id)
            except LastDeviceError as e:  # never for these: the minted one remains
                refused.append(e)

        threads = [threading.Thread(target=drop, args=(d,)) for d in added]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert refused == []
        assert [d.label for d in store.get_user(account.user_id).devices] == ["Robin"]


class TestUsernames:
    """The name half of password sign-in: unique, case-insensitive, as typed."""

    def test_an_account_starts_with_no_username(self, store):
        """The state every account in an existing users.json is in. It must be
        an ordinary state, not a broken one."""
        account, _ = store.mint("Robin", ROLE_OWNER)
        assert account.username is None
        assert account.can_sign_in_with_password is False

    def test_a_username_is_stored_as_typed(self, store):
        account, _ = store.mint("Robin", ROLE_OWNER)
        assert store.set_username(account.user_id, "Robin").username == "Robin"

    def test_a_username_is_matched_ignoring_case(self, store):
        account, _ = store.mint("Robin", ROLE_OWNER)
        store.set_username(account.user_id, "Robin")
        for spelling in ("robin", "ROBIN", "RoBiN", "  robin  "):
            assert store.find_by_username(spelling).user_id == account.user_id

    def test_two_accounts_cannot_share_a_name_even_in_different_cases(self, store):
        robin, _ = store.mint("Robin", ROLE_OWNER)
        ana, _ = store.mint("Ana", ROLE_MEMBER)
        store.set_username(robin.user_id, "robin")

        with pytest.raises(UsernameTakenError):
            store.set_username(ana.user_id, "ROBIN")

    def test_an_account_may_re_case_its_own_name(self, store):
        """Not a collision with oneself: it is a display-only rename."""
        account, _ = store.mint("Robin", ROLE_OWNER)
        store.set_username(account.user_id, "robin")
        assert store.set_username(account.user_id, "Robin").username == "Robin"

    def test_a_rename_frees_the_old_name(self, store):
        robin, _ = store.mint("Robin", ROLE_OWNER)
        ana, _ = store.mint("Ana", ROLE_MEMBER)
        store.set_username(robin.user_id, "robin")
        store.set_username(robin.user_id, "robinson")

        store.set_username(ana.user_id, "robin")
        assert store.find_by_username("robin").user_id == ana.user_id

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "  ",
            "ab",  # under the floor
            "n" * 33,  # over the ceiling
            "_robin",  # must start with a letter or a digit
            "-robin",
            ".robin",
            "ni co",
            "robin@example.com",  # a username here is not an email address
            "niño",  # ASCII only, deliberately
            "robin!",
            "robin/../etc",
        ],
    )
    def test_a_name_outside_the_allowed_set_is_refused(self, store, bad):
        account, _ = store.mint("Robin", ROLE_OWNER)
        with pytest.raises(InvalidUsernameError):
            store.set_username(account.user_id, bad)

    @pytest.mark.parametrize("good", ["ana", "robin", "robin.99", "n_i-c.o", "0day", "N" * 32])
    def test_the_allowed_set_really_is_allowed(self, store, good):
        account, _ = store.mint("Robin", ROLE_OWNER)
        assert store.set_username(account.user_id, good).username == good

    def test_setting_a_username_on_a_missing_account_is_an_unknown_user(self, store):
        with pytest.raises(UnknownUserError):
            store.set_username("nobody", "robin")


class TestPasswords:
    """The secret half. The KDF itself is ``tests/unit/test_passwords.py``."""

    @pytest.fixture
    def named(self, store):
        account, token = store.mint("Robin", ROLE_OWNER)
        store.set_username(account.user_id, "robin")
        return store.get_user(account.user_id), token

    def test_a_password_cannot_be_set_before_a_username(self, store):
        """It could never sign in, and its owner would believe it could."""
        account, _ = store.mint("Robin", ROLE_OWNER)
        with pytest.raises(UsernameRequiredError):
            store.set_password(account.user_id, "correct horse battery")

    def test_the_first_password_needs_no_current_one(self, named, store):
        """The migration path: an account that never had one cannot be asked
        for it, and the device token it is holding is the stronger credential."""
        account, _ = named
        after = store.set_password(account.user_id, "correct horse battery")
        assert after.password_hash
        assert after.can_sign_in_with_password is True

    def test_changing_it_requires_the_current_one(self, named, store):
        account, _ = named
        store.set_password(account.user_id, "correct horse battery")

        with pytest.raises(InvalidCredentialsError):
            store.set_password(account.user_id, "a different one", "not the current")

    def test_changing_it_with_the_current_one_works(self, named, store):
        account, _ = named
        store.set_password(account.user_id, "correct horse battery")
        store.set_password(account.user_id, "a different one", "correct horse battery")

        _, _, token = store.authenticate("robin", "a different one", "phone")
        assert store.resolve(token).user_id == account.user_id

    def test_a_current_password_sent_to_an_account_without_one_is_ignored(self, named, store):
        """A client that always sends the field is not doing anything wrong."""
        account, _ = named
        assert store.set_password(account.user_id, "correct horse battery", "anything")

    def test_a_short_password_is_refused_and_nothing_is_stored(self, named, store):
        account, _ = named
        with pytest.raises(WeakPasswordError):
            store.set_password(account.user_id, "short")
        assert store.get_user(account.user_id).password_hash is None

    def test_the_plaintext_never_reaches_the_file(self, named, store):
        account, _ = named
        store.set_password(account.user_id, "correct horse battery")
        assert "correct horse battery" not in store.path.read_text(encoding="utf-8")

    def test_the_password_survives_a_reload(self, named, store):
        account, _ = named
        store.set_password(account.user_id, "correct horse battery")

        reopened = TokenStore(store.path)
        assert reopened.authenticate("robin", "correct horse battery", "phone")

    def test_changing_the_password_signs_nobody_out(self, named, store):
        """The decision, pinned. The password is not the session here: device
        tokens are, and each is revocable by itself. Changing a weak password
        must not be the destructive act — see the route's docstring for the
        argument and for the cost it accepts."""
        account, phone_token = named
        _, _, mac_token = store.add_device(account.user_id, "MacBook")
        store.set_password(account.user_id, "correct horse battery")

        store.set_password(account.user_id, "a different one", "correct horse battery")

        assert store.resolve(phone_token) is not None
        assert store.resolve(mac_token) is not None
        assert len(store.get_user(account.user_id).devices) == 2


class TestAuthenticate:
    @pytest.fixture
    def signed_up(self, store):
        account, _ = store.mint("Robin", ROLE_OWNER)
        store.set_username(account.user_id, "Robin")
        store.set_password(account.user_id, "correct horse battery")
        return store.get_user(account.user_id)

    def test_signing_in_mints_a_working_device_token(self, signed_up, store):
        """The whole feature: a caller holding nothing ends up holding a token."""
        account, device, token = store.authenticate(
            "robin", "correct horse battery", "MacBook"
        )

        assert account.user_id == signed_up.user_id
        assert device.label == "MacBook"
        assert store.resolve(token).user_id == signed_up.user_id

    def test_the_new_device_is_the_same_person(self, signed_up, store):
        """Not a second account — the defect the device table exists to fix."""
        _, _, token = store.authenticate("robin", "correct horse battery", "MacBook")
        principal = store.resolve(token)
        assert (principal.user_id, principal.role) == (signed_up.user_id, ROLE_OWNER)
        assert len(store.get_user(signed_up.user_id).devices) == 2

    def test_the_username_is_matched_ignoring_case(self, signed_up, store):
        assert store.authenticate("ROBIN", "correct horse battery", "phone")

    @pytest.mark.parametrize(
        "username,password",
        [
            ("robin", "wrong password here"),
            ("nobody", "correct horse battery"),
            ("nobody", "wrong password here"),
            ("", "correct horse battery"),
            ("ni co!!", "correct horse battery"),
            (None, None),
        ],
    )
    def test_every_failure_is_the_same_exception_and_the_same_sentence(
        self, signed_up, store, username, password
    ):
        """One outcome, one message. Separate exception types are how the
        "no such user" / "wrong password" distinction leaks back in."""
        with pytest.raises(InvalidCredentialsError) as excinfo:
            store.authenticate(username, password, "phone")
        assert "do not match" in str(excinfo.value)

    def test_a_malformed_username_is_a_401_and_not_a_validation_error(
        self, signed_up, store
    ):
        """``InvalidUsernameError`` on the sign-in path would tell an attacker
        which shapes are worth trying before spending a single guess."""
        with pytest.raises(InvalidCredentialsError):
            store.authenticate("robin@example.com", "correct horse battery", "phone")

    def test_an_account_with_a_username_and_no_password_cannot_sign_in(self, store):
        account, _ = store.mint("Ana", ROLE_MEMBER)
        store.set_username(account.user_id, "ana")
        with pytest.raises(InvalidCredentialsError):
            store.authenticate("ana", "correct horse battery", "phone")

    def test_a_failed_sign_in_mints_nothing(self, signed_up, store):
        with pytest.raises(InvalidCredentialsError):
            store.authenticate("robin", "wrong password here", "phone")
        assert len(store.get_user(signed_up.user_id).devices) == 1

    def test_a_revoked_password_device_stops_working_like_any_other(
        self, signed_up, store
    ):
        _, device, token = store.authenticate("robin", "correct horse battery", "MacBook")
        store.revoke_device(signed_up.user_id, device.device_id)
        assert store.resolve(token) is None

    def test_signing_in_rewrites_a_hash_written_at_a_lower_cost(self, store, monkeypatch):
        """The only moment the plaintext exists is the only moment the stored
        value can be re-derived, so raising the floor costs nobody a reset."""
        from app.domains.accounts import passwords

        account, _ = store.mint("Robin", ROLE_OWNER)
        store.set_username(account.user_id, "robin")
        monkeypatch.setattr(passwords, "SCRYPT_N", 1 << 12)
        store.set_password(account.user_id, "correct horse battery")
        cheap = store.get_user(account.user_id).password_hash

        monkeypatch.undo()
        store.authenticate("robin", "correct horse battery", "phone")

        upgraded = store.get_user(account.user_id).password_hash
        assert upgraded != cheap
        assert f"n={passwords.SCRYPT_N}" in upgraded
        # And the rewrite landed on disk together with the new device.
        assert TokenStore(store.path).authenticate("robin", "correct horse battery", "x")

    def test_the_signed_in_account_advertises_password_sign_in(self, signed_up, store):
        assert store.has_password_sign_in() is True

    def test_a_household_with_no_credentials_advertises_none(self, store):
        store.mint("Robin", ROLE_OWNER)
        assert store.has_password_sign_in() is False


class TestClaimingWithCredentials:
    def test_the_first_owner_can_be_created_recoverable(self, store):
        account, _ = store.claim_first_owner("Robin", "robin", "correct horse battery")
        assert account.username == "robin"
        assert store.authenticate("robin", "correct horse battery", "MacBook")

    def test_a_claim_with_neither_is_still_a_claim(self, store):
        """Additive: a client shipped before this feature posts a label alone."""
        account, token = store.claim_first_owner("Robin")
        assert account.username is None
        assert store.resolve(token).role == ROLE_OWNER

    def test_half_a_pair_is_refused(self, store):
        for username, password in (("robin", None), (None, "correct horse battery")):
            with pytest.raises(IdentityError):
                store.claim_first_owner("Robin", username, password)
        assert store.list_users() == []

    def test_a_bad_username_creates_nothing(self, store):
        with pytest.raises(InvalidUsernameError):
            store.claim_first_owner("Robin", "ni co", "correct horse battery")
        assert store.list_users() == []

    def test_a_short_password_creates_nothing(self, store):
        with pytest.raises(WeakPasswordError):
            store.claim_first_owner("Robin", "robin", "short")
        assert store.list_users() == []


class TestMigrationFromTheDevicesShape:
    """A ``users.json`` written before accounts had usernames and passwords.

    The live server's file is in *this* shape now — accounts with devices, no
    credentials — so the property under test is that the absent fields keep
    meaning "never set" and never "locked out". Started from a checked-in file
    (``tests/fixtures/users_v2.json``) rather than from a table this suite
    built, for the same reason the v1 class is: a table this suite built is
    written by the code under test and could only ever agree with it.
    """

    @pytest.fixture
    def legacy(self, tmp_path: Path) -> TokenStore:
        path = tmp_path / "users.json"
        shutil.copy(V2_FIXTURE, path)
        return TokenStore(path)

    def test_the_tokens_on_the_devices_keep_working(self, legacy):
        """The one that matters. A miss here locks the household out."""
        for token, user_id in (
            (V2_OWNER_PHONE_TOKEN, V2_OWNER_ID),
            (V2_OWNER_MAC_TOKEN, V2_OWNER_ID),
            (V2_MEMBER_TOKEN, V2_MEMBER_ID),
        ):
            assert legacy.resolve(token).user_id == user_id

    def test_every_account_loads_with_no_credentials(self, legacy):
        for row in legacy.list_users():
            assert row.username is None
            assert row.password_hash is None
            assert row.can_sign_in_with_password is False

    def test_the_server_says_password_sign_in_is_unavailable(self, legacy):
        """What ``GET /api/status`` turns into the absence of ``password`` in
        ``authMethods``: a login form here could only ever fail."""
        assert legacy.has_password_sign_in() is False

    def test_nobody_can_sign_in_yet(self, legacy):
        with pytest.raises(InvalidCredentialsError):
            legacy.authenticate("robin", "correct horse battery", "phone")

    def test_an_old_account_can_adopt_a_username_and_a_password(self, legacy):
        """The recovery the whole feature exists for, arriving on data that
        predates it — and without the phone ever being re-paired."""
        legacy.set_username(V2_OWNER_ID, "robin")
        legacy.set_password(V2_OWNER_ID, "correct horse battery")

        _, _, token = legacy.authenticate("robin", "correct horse battery", "New phone")
        assert legacy.resolve(token).user_id == V2_OWNER_ID
        assert legacy.resolve(V2_OWNER_PHONE_TOKEN) is not None, "the old device survives"

    def test_the_devices_and_their_ids_are_untouched_by_the_upgrade(self, legacy):
        legacy.set_username(V2_OWNER_ID, "robin")
        owner = legacy.get_user(V2_OWNER_ID)
        assert [(d.device_id, d.label) for d in owner.devices] == [
            (V2_OWNER_ID, "Robin (iPhone)"),
            ("c02d7ae4f118", "Robin (MacBook)"),
        ]

    def test_the_file_is_written_back_in_the_new_shape(self, legacy):
        legacy.set_username(V2_OWNER_ID, "Robin")
        legacy.set_password(V2_OWNER_ID, "correct horse battery")
        raw = json.loads(legacy.path.read_text(encoding="utf-8"))

        assert raw["version"] == 3
        owner, member = raw["users"]
        assert owner["username"] == "Robin"
        assert owner["password_hash"].startswith("scrypt$")
        # Omit unset credentials to preserve the device-only account shape.
        assert "username" not in member
        assert "password_hash" not in member

    def test_the_old_tokens_survive_the_rewrite(self, legacy):
        legacy.set_username(V2_OWNER_ID, "robin")
        legacy.set_password(V2_OWNER_ID, "correct horse battery")

        reopened = TokenStore(legacy.path)
        assert reopened.resolve(V2_OWNER_PHONE_TOKEN).user_id == V2_OWNER_ID
        assert reopened.resolve(V2_OWNER_MAC_TOKEN).user_id == V2_OWNER_ID
        assert reopened.resolve(V2_MEMBER_TOKEN).user_id == V2_MEMBER_ID

    def test_a_hand_edited_unusable_username_drops_rather_than_dropping_the_row(
        self, tmp_path: Path
    ):
        """The account keeps its devices and its data. Refusing to load the
        row would take the library away over a cosmetic field."""
        path = tmp_path / "users.json"
        raw = json.loads(V2_FIXTURE.read_text(encoding="utf-8"))
        raw["users"][0]["username"] = "not a username"
        path.write_text(json.dumps(raw), encoding="utf-8")

        store = TokenStore(path)
        assert store.resolve(V2_OWNER_PHONE_TOKEN).user_id == V2_OWNER_ID
        assert store.get_user(V2_OWNER_ID).username is None

    def test_two_accounts_hand_edited_to_one_name_leave_the_first_signing_in(
        self, tmp_path: Path
    ):
        """First one wins, out loud, so the answer is at least stable across
        restarts. Only reachable from an edited file."""
        path = tmp_path / "users.json"
        raw = json.loads(V2_FIXTURE.read_text(encoding="utf-8"))
        for row in raw["users"]:
            row["username"] = "robin"
        path.write_text(json.dumps(raw), encoding="utf-8")

        store = TokenStore(path)
        assert store.find_by_username("robin").user_id == V2_OWNER_ID


class TestOperatorRecoveryConcurrency:
    def test_two_cached_stores_keep_each_others_changes(self, tmp_path):
        path = tmp_path / "users.json"
        server = TokenStore(path)
        account, token = server.mint("Ana", ROLE_MEMBER)
        server.set_username(account.user_id, "ana")
        server.set_password(account.user_id, "original-password")
        operator = TokenStore(path)
        operator.get_user(account.user_id)  # cache the pre-device state
        server.add_device(account.user_id, "Laptop")
        operator.reset_password(account.user_id, "replacement-password")
        server.complete_onboarding(account.user_id)
        from app.domains.accounts.passwords import verify_password
        current = TokenStore(path).get_user(account.user_id)
        assert verify_password("replacement-password", current.password_hash)
        assert current.onboarded and len(current.devices) == 2
        assert server.resolve(token).user_id == account.user_id

    def test_separate_process_writes_are_serialized(self, tmp_path):
        import os
        import subprocess
        import sys
        path = tmp_path / "users.json"
        server = TokenStore(path)
        account, _ = server.mint("Ana", ROLE_MEMBER)
        server.set_username(account.user_id, "ana")
        server.set_password(account.user_id, "original-password")
        script = """
import sys
from pathlib import Path
from app.domains.accounts.identity import TokenStore
store = TokenStore(Path(sys.argv[1]))
for index in range(10):
    store.add_device(sys.argv[2], f'Process {sys.argv[3]} device {index}')
"""
        processes = [subprocess.Popen([sys.executable, "-c", script, str(path), account.user_id, str(i)],
                                     env={**os.environ, "PYTHONPATH": str(Path.cwd())}) for i in range(2)]
        for process in processes:
            assert process.wait(timeout=30) == 0
        assert len(server.get_user(account.user_id).devices) == 21


class TestRenameDevice:
    def test_persists_only_the_display_name_and_keeps_every_token_working(self, store):
        account, phone = store.mint("Ana", ROLE_OWNER)
        _, helper, worker_token = store.add_device(account.user_id, "Mac · trabajador", helper=True)
        before = store.get_user(account.user_id)
        renamed = store.rename_device(account.user_id, helper.device_id, "  Mac de Ana  ")
        assert renamed.label == "Mac de Ana"
        assert renamed == replace(helper, label="Mac de Ana")
        reloaded = TokenStore(store.path)
        after = reloaded.get_user(account.user_id)
        assert after.label == before.label
        assert after.devices[0] == before.devices[0]
        assert after.devices[1] == renamed
        assert renamed.helper is True
        assert reloaded.resolve(phone).user_id == account.user_id
        assert reloaded.resolve(worker_token).device_id == helper.device_id

    @pytest.mark.parametrize("label", ["", "   ", "a" * 81, "Mac\n", "\tMac", "Mac\x00", "Mac\x7f", "Mac\x85"])
    def test_rejects_invalid_names_without_writing(self, store, label):
        account, _ = store.mint("Ana")
        before = store.path.read_bytes()
        with pytest.raises(IdentityError):
            store.rename_device(account.user_id, account.devices[0].device_id, label)
        assert store.path.read_bytes() == before

    def test_unknown_account_or_foreign_device_cannot_be_renamed(self, store):
        ana, _ = store.mint("Ana")
        beto, _ = store.mint("Beto")
        with pytest.raises(UnknownUserError):
            store.rename_device("missing", ana.devices[0].device_id, "Mac")
        for device_id in ["missing", beto.devices[0].device_id]:
            with pytest.raises(UnknownDeviceError):
                store.rename_device(ana.user_id, device_id, "Mac")
