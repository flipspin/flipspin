"""The shared scope keeps legacy principals and the cached index unrestricted."""
from unittest.mock import Mock

import pytest

from app.domains.accounts.identity import LEGACY_OWNER, LOCAL_OWNER, ANONYMOUS, UNKNOWN, Principal
from app.domains.subsonic.library import Library, filtered_library
from app.domains.user_library.scope import LibraryScope
from app.domains.user_library.store import UserTrackStore


@pytest.mark.parametrize("principal", [LEGACY_OWNER, LOCAL_OWNER, ANONYMOUS, UNKNOWN,
                                       Principal("owner-row", "Owner", "owner")])
def test_owners_and_every_sentinel_keep_the_same_index(principal):
    store = Mock(spec=UserTrackStore)
    scope = LibraryScope.for_principal(principal, store)
    library = Library({}, {}, {}, {})
    assert scope.unrestricted and scope.allows("any/song.mp3") and scope.allows_album("any")
    assert filtered_library(library, scope) is library
    store.list_for_user.assert_not_called()


def test_member_scope_uses_rows_and_exact_album_keys(tmp_path):
    store = UserTrackStore(tmp_path / "tracks.json")
    store.add_many("member", ["Artist∕Album/CD1∕song.mp3"])
    store.add_many("other", ["Other/song.mp3"])
    scope = LibraryScope.for_principal(Principal("member", "Member"), store)
    assert not scope.unrestricted
    assert scope.allows("Artist∕Album/CD1∕song.mp3")
    assert scope.allows_album("Artist∕Album")
    assert not scope.allows_album("Artist")
    assert not scope.allows("Other/song.mp3")


def test_member_projection_is_cached_by_scope_and_catalog_identity(monkeypatch):
    from app.domains.subsonic import library as module
    index = module.LibraryIndex()
    repo = Mock()
    repo.scan_albums.return_value = []
    scope = LibraryScope(frozenset({'Album/song.mp3'}))
    filtered = Mock(wraps=module.filtered_library)
    monkeypatch.setattr(module, 'filtered_library', filtered)
    first = index.for_scope(repo, scope)
    for _ in range(100):
        assert index.for_scope(repo, scope) is first
    assert filtered.call_count == 1
    fresh_scope = LibraryScope(frozenset())
    assert index.for_scope(repo, fresh_scope) is not first
    assert filtered.call_count == 2
    repo.scan_albums.return_value = []
    assert index.for_scope(repo, scope) is not first
    assert filtered.call_count == 3
