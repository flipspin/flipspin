"""Check safe library keys, durable intent, batched plays, and private persistence.

Malformed files must not prevent startup. HTTP ownership behavior is covered
by the integration suite.
"""
import json
import os
import stat
from pathlib import Path

from app.infra.migrations import StoreRefusal

import pytest

from app.domains.user_library import store as user_library
from app.domains.user_library.store import (
    InvalidRelPathError,
    UnknownUserTrackError,
    UserTrackStore,
    normalize_batch,
    normalize_rel_path,
)

ANA = "ana-0001"
BETO = "beto-0002"
REL_PATH = "In Rainbows/01 - 15 Step.mp3"
OTHER = "In Rainbows/02 - Bodysnatchers.mp3"


@pytest.fixture
def store(tmp_path: Path) -> UserTrackStore:
    return UserTrackStore(tmp_path / "user_tracks.json")


class TestRelPathValidation:
    def test_a_plain_two_segment_path_is_accepted_unchanged(self):
        assert normalize_rel_path(REL_PATH) == REL_PATH

    def test_a_query_string_is_refused_rather_than_stripped(self):
        """Stripping would create two spellings of one identity, and would
        also write a live credential into a JSON file on disk."""
        with pytest.raises(InvalidRelPathError):
            normalize_rel_path(f"{REL_PATH}?access_token=abc")

    @pytest.mark.parametrize(
        "bad",
        [
            "",
            "  ",
            "song.mp3",                      # no album
            "a/b/c.mp3",                     # three segments
            "../secrets/id_rsa",
            "In Rainbows/../../etc/passwd",
            "/In Rainbows/01.mp3",           # leading slash -> empty segment
            "In Rainbows/",
            "In Rainbows\\01.mp3",
            " In Rainbows/01.mp3",
            "In Rainbows/01.mp3 ",
            "In Rainbows/./01.mp3",
            "In Rainbows/01.mp3#frag",
            "In Rainbows/01\x00.mp3",
            None,
            42,
        ],
    )
    def test_everything_that_could_never_match_a_file_is_refused(self, bad):
        with pytest.raises(InvalidRelPathError):
            normalize_rel_path(bad)

    def test_a_batch_drops_repeats_and_keeps_order(self):
        assert normalize_batch([OTHER, REL_PATH, OTHER]) == [OTHER, REL_PATH]


class TestReferencesNotCopies:
    def test_adding_is_idempotent_and_does_not_reset_a_row(self, store):
        added, already = store.add_many(ANA, [REL_PATH])
        assert (added, already) == ([REL_PATH], [])
        store.record_play(ANA, REL_PATH)

        added, already = store.add_many(ANA, [REL_PATH])

        assert (added, already) == ([], [REL_PATH])
        assert store.get(ANA, REL_PATH).play_count == 1

    def test_two_users_hold_independent_rows_for_one_path(self, store):
        store.add_many(ANA, [REL_PATH])
        store.add_many(BETO, [REL_PATH])
        store.update_flags(ANA, REL_PATH, liked=True)

        assert store.get(ANA, REL_PATH).liked is True
        assert store.get(BETO, REL_PATH).liked is False
        assert [r.rel_path for r in store.list_for_user(BETO)] == [REL_PATH]

    def test_removing_is_silent_about_paths_the_user_never_had(self, store):
        store.add_many(ANA, [REL_PATH])
        assert store.remove_many(ANA, [REL_PATH, OTHER]) == [REL_PATH]
        assert store.list_for_user(ANA) == []

    def test_removing_one_users_row_leaves_the_others(self, store):
        store.add_many(ANA, [REL_PATH])
        store.add_many(BETO, [REL_PATH])

        store.remove_many(ANA, [REL_PATH])

        assert store.get(ANA, REL_PATH) is None
        assert store.get(BETO, REL_PATH) is not None

    def test_ownership_is_positional(self, store):
        store.add_many(ANA, [REL_PATH])
        asked = [OTHER, REL_PATH, OTHER, REL_PATH]
        assert store.owns_many(ANA, asked) == [False, True, False, True]

    def test_patching_a_row_that_is_not_there_raises(self, store):
        with pytest.raises(UnknownUserTrackError):
            store.update_flags(ANA, REL_PATH, liked=True)

    def test_none_means_leave_it_alone(self, store):
        store.add_many(ANA, [REL_PATH])
        store.update_flags(ANA, REL_PATH, liked=True, offline=True)

        row = store.update_flags(ANA, REL_PATH, liked=False)

        assert (row.liked, row.offline) == (False, True)


class TestFlushStrategy:
    """Intent is written through; a bare play increment is coalesced."""

    def test_a_play_that_creates_a_row_is_written_immediately(self, store, monkeypatch):
        monkeypatch.setattr(user_library, "PLAY_FLUSH_SECONDS", 10_000)

        store.record_play(ANA, REL_PATH)

        # Membership, not a statistic: it must survive a crash right here.
        reloaded = UserTrackStore(store.path)
        assert reloaded.get(ANA, REL_PATH).play_count == 1

    def test_a_bare_increment_is_coalesced(self, store, monkeypatch):
        monkeypatch.setattr(user_library, "PLAY_FLUSH_SECONDS", 10_000)
        store.add_many(ANA, [REL_PATH])
        store.record_play(ANA, REL_PATH)  # creates nothing; writes through once
        on_disk_before = json.loads(store.path.read_text())

        store.record_play(ANA, REL_PATH)
        store.record_play(ANA, REL_PATH)

        # In memory it is exact...
        assert store.get(ANA, REL_PATH).play_count == 3
        # ...and the disk still holds the last flush, by design.
        assert json.loads(store.path.read_text()) == on_disk_before

    def test_flush_forces_the_pending_write(self, store, monkeypatch):
        monkeypatch.setattr(user_library, "PLAY_FLUSH_SECONDS", 10_000)
        store.add_many(ANA, [REL_PATH])
        store.record_play(ANA, REL_PATH)
        store.record_play(ANA, REL_PATH)

        store.flush()

        assert UserTrackStore(store.path).get(ANA, REL_PATH).play_count == 2

    def test_any_other_write_carries_the_deferred_increments_along(
        self, store, monkeypatch
    ):
        """Why the coalescing is cheap: the table is serialized whole."""
        monkeypatch.setattr(user_library, "PLAY_FLUSH_SECONDS", 10_000)
        store.add_many(ANA, [REL_PATH])
        store.record_play(ANA, REL_PATH)
        store.record_play(ANA, REL_PATH)

        store.add_many(ANA, [OTHER])  # unrelated intent, flushed immediately

        assert UserTrackStore(store.path).get(ANA, REL_PATH).play_count == 2

    def test_an_elapsed_window_writes_through(self, store, monkeypatch):
        monkeypatch.setattr(user_library, "PLAY_FLUSH_SECONDS", 0)
        store.add_many(ANA, [REL_PATH])
        store.record_play(ANA, REL_PATH)
        store.record_play(ANA, REL_PATH)

        assert UserTrackStore(store.path).get(ANA, REL_PATH).play_count == 2


class TestPersistence:
    def test_rows_round_trip_through_the_file(self, store):
        store.add_many(ANA, [REL_PATH, OTHER])
        store.update_flags(ANA, OTHER, liked=True, offline=True)
        store.record_play(ANA, REL_PATH)
        store.flush()  # the play was an increment, so it is coalesced by design

        reloaded = UserTrackStore(store.path)
        rows = reloaded.list_for_user(ANA)

        assert [r.rel_path for r in rows] == [REL_PATH, OTHER]
        assert rows[0].play_count == 1 and rows[0].last_played_at
        assert (rows[1].liked, rows[1].offline) == (True, True)

    def test_the_file_is_not_readable_by_other_accounts(self, store):
        store.add_many(ANA, [REL_PATH])
        mode = stat.S_IMODE(os.stat(store.path).st_mode)
        assert mode == 0o600

    def test_a_missing_file_is_an_empty_table(self, tmp_path):
        assert UserTrackStore(tmp_path / "nope.json").list_for_user(ANA) == []

    @pytest.mark.parametrize(
        "content", ["", "{", "[]", '{"version": 1}', '{"version": 1, "rows": {}}']
    )
    def test_an_unusable_file_refuses_without_overwriting(self, tmp_path, content):
        path = tmp_path / "user_tracks.json"
        path.write_text(content)
        store = UserTrackStore(path)

        before = path.read_bytes()
        with pytest.raises(StoreRefusal) as error:
            store.list_for_user(ANA)
        assert error.value.code == 78
        assert path.read_bytes() == before

    def test_a_malformed_row_refuses_without_dropping_data(self, tmp_path):
        path = tmp_path / "user_tracks.json"
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "rows": [
                        {"user_id": ANA, "rel_path": REL_PATH, "added_at": "2026-01-01T00:00:00Z"},
                        {"user_id": ANA},                        # no path
                        {"rel_path": OTHER},                     # no user
                        {"user_id": ANA, "rel_path": "../evil"},  # not a rel_path
                        "not a row",
                    ],
                }
            )
        )
        with pytest.raises(StoreRefusal):
            UserTrackStore(path).list_for_user(ANA)

    def test_a_true_play_count_does_not_read_as_one_play(self, tmp_path):
        """bool is an int in Python, and a hand-edited file is the caller here."""
        path = tmp_path / "user_tracks.json"
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "rows": [
                        {
                            "user_id": ANA,
                            "rel_path": REL_PATH,
                            "added_at": "2026-01-01T00:00:00Z",
                            "play_count": True,
                        }
                    ],
                }
            )
        )
        assert UserTrackStore(path).get(ANA, REL_PATH).play_count == 0

    def test_the_public_body_is_camel_case_and_carries_no_user_id(self, store):
        store.add_many(ANA, [REL_PATH])
        body = store.get(ANA, REL_PATH).public()

        assert set(body) == {
            "relPath",
            "addedAt",
            "liked",
            "offline",
            "playCount",
            "lastPlayedAt",
        }
        assert ANA not in json.dumps(body)


def test_prune_drops_rows_of_deleted_accounts_and_persists(store: UserTrackStore, tmp_path: Path) -> None:
    store.add_many("alice", ["A/1.mp3"])
    store.add_many("gone", ["A/1.mp3", "B/2.mp3"])
    assert store.prune_unknown_users({"alice"}) == 2
    assert store.list_for_user("gone") == []
    reread = UserTrackStore(tmp_path / "user_tracks.json")
    assert [r.rel_path for r in reread.list_for_user("alice")] == ["A/1.mp3"]
    assert reread.list_for_user("gone") == []


def test_prune_refuses_an_empty_account_list(store: UserTrackStore) -> None:
    store.add_many("alice", ["A/1.mp3"])
    assert store.prune_unknown_users(set()) == 0
    assert len(store.list_for_user("alice")) == 1
