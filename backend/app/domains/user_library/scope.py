"""A request's view of the shared catalog, keyed by the existing relPath identity."""
from collections import OrderedDict
from dataclasses import dataclass, replace
from threading import RLock
from pathlib import Path

from fastapi import Request

from app.infra.identity import Principal, is_real_user
from app.domains.music.models import Album
from app.domains.user_library.store import UserTrackStore
from app.utils.library_paths import album_key, file_key


@dataclass(frozen=True)
class LibraryScope:
    # None means unrestricted; an empty set means a member with no library.
    allowed_rel_paths: frozenset[str] | None = None

    @classmethod
    def for_principal(cls, principal: Principal, store: UserTrackStore) -> "LibraryScope":
        if not is_real_user(principal) or principal.is_owner:
            return cls()
        return cls(frozenset(row.rel_path for row in store.list_for_user(principal.user_id)))

    @property
    def unrestricted(self) -> bool:
        return self.allowed_rel_paths is None

    def allows(self, rel_path: str | None) -> bool:
        return self.unrestricted or rel_path in self.allowed_rel_paths

    def allows_album(self, key: str) -> bool:
        return self.unrestricted or any(path.startswith(f"{key}/") for path in self.allowed_rel_paths)

    def filter_albums(self, albums: list[Album], base: Path) -> list[Album]:
        """Copy restricted albums; never mutate the shared scan cache."""
        if self.unrestricted:
            return albums
        out = []
        for album in albums:
            key = album_key(base, album.path)
            tracks = [t for t in album.tracks if self.allows(f"{key}/{file_key(album.path, t.path)}")]
            if tracks:
                out.append(replace(
                    album, tracks=tracks, total_duration=sum(t.duration or 0 for t in tracks),
                    genres=list(dict.fromkeys(g for t in tracks for g in t.genres)),
                ))
        return out


class ScopeCache:
    """Bounded snapshots, invalidated by catalog and account area revisions."""
    def __init__(self):
        self._entries = OrderedDict()
        self._lock = RLock()

    def get(self, principal, store, changes):
        with self._lock:
            key = (principal.user_id, principal.role, is_real_user(principal))
            revision = (changes.revision('library'), changes.revision(f'me:{principal.user_id}'))
            cached = self._entries.get(key)
            if cached is None or cached[0] is not store or cached[1] != revision:
                cached = (store, revision, LibraryScope.for_principal(principal, store))
                self._entries[key] = cached
            self._entries.move_to_end(key)
            if len(self._entries) > 256:
                self._entries.popitem(last=False)
            return cached[2]


def get_library_scope(request: Request) -> LibraryScope:
    """FastAPI dependency; the implementation lives beside the other getters."""
    from app.dependencies import get_library_scope as scope_for_request

    return scope_for_request(request)
