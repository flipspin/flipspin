"""Library scope is per account, immutable, and leaves shared scan objects alone."""
from unittest.mock import Mock

import pytest

from app.domains.accounts.identity import (
    ANONYMOUS, LEGACY_OWNER, LOCAL_OWNER, UNKNOWN, Principal,
)
from app.domains.music.models import Album, Track
from app.domains.user_library.scope import LibraryScope
from app.domains.user_library.store import UserTrackStore


@pytest.mark.parametrize("principal", [
    LOCAL_OWNER, LEGACY_OWNER, ANONYMOUS, UNKNOWN, Principal("owner", "Owner", "owner"),
])
def test_owners_and_all_sentinels_are_unrestricted(principal):
    store = Mock()
    scope = LibraryScope.for_principal(principal, store)
    assert scope.unrestricted
    assert scope.allows("anything/song.mp3")
    assert scope.allows_album("anything")
    albums = []
    assert scope.filter_albums(albums, None) is albums
    store.list_for_user.assert_not_called()


def test_scope_is_a_snapshot_of_only_the_callers_rows(tmp_path):
    store = UserTrackStore(tmp_path / "rows.json")
    store.add_many("ana", ["Artist∕Album/CD1∕one.mp3"])
    store.add_many("beto", ["Other/two.mp3"])
    scope = LibraryScope.for_principal(Principal("ana", "Ana"), store)
    assert scope.allowed_rel_paths == frozenset({"Artist∕Album/CD1∕one.mp3"})
    assert scope.allows("Artist∕Album/CD1∕one.mp3")
    assert scope.allows_album("Artist∕Album")
    assert not scope.allows_album("Artist")
    assert not scope.allows_album("Artist∕Albu")
    assert not scope.allows("Other/two.mp3")
    store.add_many("ana", ["Other/two.mp3"])
    assert not scope.allows("Other/two.mp3")
    assert LibraryScope.for_principal(Principal("ana", "Ana"), store).allows("Other/two.mp3")


def test_empty_member_has_no_library(tmp_path):
    scope = LibraryScope.for_principal(Principal("ana", "Ana"), UserTrackStore(tmp_path / "rows.json"))
    assert not scope.unrestricted
    assert not scope.allows("A/b.mp3")
    assert not scope.allows_album("A")


def test_filter_copies_albums_and_recounts_duration(tmp_path):
    path = tmp_path / "Artist" / "Album"
    own = Track("One", "Artist", "Album", path / "CD1" / "one.mp3", duration=10)
    other = Track("Two", "Artist", "Album", path / "two.mp3", duration=20)
    albums = [Album("Album", "Artist", path, [own, other], total_duration=30),
              Album("Empty", "Other", tmp_path / "Other", [other])]
    scope = LibraryScope(frozenset({"Artist∕Album/CD1∕one.mp3"}))
    filtered = scope.filter_albums(albums, tmp_path)
    assert len(filtered) == 1
    assert filtered[0].tracks == [own]
    assert filtered[0].total_duration == 10
    assert albums[0].tracks == [own, other]
    assert albums[0].total_duration == 30
