"""Persist per-account references and preferences over the shared audio catalog.

Reject URL-shaped keys; flush membership and intent immediately, coalescing plays.
See docs/DEVELOPER_GUIDE.md#personal-library-persistence.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass, replace

from app.utils.clock import utc_now_iso
from pathlib import Path
from collections.abc import Sequence
from app.infra.changes import Changes
from app.infra.files import PRIVATE
from app.infra.migrations import read_json_store, refuse, write_json_store

logger = logging.getLogger(__name__)

#: How long an *increment-only* play may sit in memory before it is written.
#: See "Flush strategy" above. Deliberately far shorter than
#: ``identity.LAST_SEEN_FLUSH_SECONDS`` (300): ``last_seen_at`` is cosmetic and
#: self-repairing, a play count only ever goes up and never comes back.
PLAY_FLUSH_SECONDS = 30

#: Most rows one request may name. Matches the cap on ``POST /api/library/ownership``
#: so a client can reuse one batching rule for both.
MAX_BATCH = 500

#: The separator inside a ``rel_path``. Always ``/``, on Windows too: this is a
#: wire identifier that happens to look like a path, not a path.
REL_PATH_SEPARATOR = "/"


class UserLibraryError(Exception):
    """Base for per-user-library problems the API turns into 4xx."""


class InvalidRelPathError(UserLibraryError):
    """The caller sent something that is not ``<albumDir>/<fileName>``."""


class UnknownUserTrackError(UserLibraryError):
    """This user holds no row for that ``rel_path``."""



def normalize_rel_path(value: object) -> str:
    """Accept exactly two clean library-relative segments without rewriting them.

    Reject traversal, invisible segment whitespace, and URL query/fragment data
    that cannot identify a servable file. See docs/DEVELOPER_GUIDE.md#personal-library-persistence.
    """
    if not isinstance(value, str):
        raise InvalidRelPathError("relPath must be a string")
    if value != value.strip():
        raise InvalidRelPathError("relPath cannot have leading or trailing whitespace")
    if not value:
        raise InvalidRelPathError("relPath cannot be empty")
    if "?" in value or "#" in value:
        raise InvalidRelPathError(
            "relPath must not carry a query string or fragment — pass "
            "'<album>/<file>', not a media URL with ?access_token"
        )
    if "\\" in value or "\x00" in value:
        raise InvalidRelPathError("relPath cannot contain a backslash or a null byte")
    segments = value.split(REL_PATH_SEPARATOR)
    if len(segments) != 2:
        raise InvalidRelPathError(
            f"relPath must be '<album>/<file>', got {len(segments)} segment(s)"
        )
    for segment in segments:
        if not segment or segment != segment.strip():
            raise InvalidRelPathError("relPath segments cannot be empty or padded")
        if segment in (".", ".."):
            raise InvalidRelPathError("relPath segments cannot be '.' or '..'")
    return value


def normalize_batch(values: Sequence[object]) -> list[str]:
    """Validate a batch and drop repeats, keeping the caller's order.

    De-duplicating here is what makes the same ``relPath`` twice in one body
    land in exactly one of ``added``/``already``/``missing`` rather than
    contradicting itself across two of them.
    """
    seen = set()
    out: list[str] = []
    for value in values:
        rel_path = normalize_rel_path(value)
        if rel_path in seen:
            continue
        seen.add(rel_path)
        out.append(rel_path)
    return out


@dataclass(frozen=True)
class UserTrack:
    """One ``(user_id, rel_path)`` row — a reference, never a file."""

    user_id: str
    rel_path: str
    added_at: str
    liked: bool = False
    offline: bool = False
    play_count: int = 0
    last_played_at: str | None = None
    acquired: bool = False

    @property
    def key(self) -> tuple[str, str]:
        return (self.user_id, self.rel_path)

    def public(self) -> dict:
        """The row as a client sees it. camelCase, like ``UserRecord.public()``.

        ``user_id`` is deliberately absent: every one of these bodies is already
        scoped to the calling principal, and echoing an id the caller never sent
        invites a client to start sending one back.
        """
        return {
            "relPath": self.rel_path,
            "addedAt": self.added_at,
            "liked": self.liked,
            "offline": self.offline,
            "playCount": self.play_count,
            "lastPlayedAt": self.last_played_at,
        }


class UserTrackStore:
    """The ``user_track`` table. Loads lazily, saves atomically, holds its lock."""

    def __init__(self, path: Path, logger_: logging.Logger | None = None, *, changes: Changes | None = None):
        self.changes = changes or Changes()
        self._published_rows = {}
        self.path = Path(path)
        self.logger = logger_ or logger
        self._lock = threading.RLock()
        self._rows: dict[tuple[str, str], UserTrack] | None = None
        # Set when an increment-only play is sitting in memory unwritten, with
        # the monotonic stamp of the last write that actually hit the disk.
        self._pending = False
        self._last_write = 0.0

    # --------------------------------------------------------------- reading

    def _records(self) -> dict[tuple[str, str], UserTrack]:
        """The table, loaded on first use. Callers must hold the lock."""
        if self._rows is None:
            self._rows = self._load()
            self._published_rows = dict(self._rows)
        return self._rows

    def reload(self) -> None:
        """Drop the in-memory copy so the next call re-reads the file."""
        with self._lock:
            self._rows = None
            self._pending = False

    def list_for_user(self, user_id: str) -> list[UserTrack]:
        """This user's rows, in the order they were added.

        Never touches the filesystem. A row whose file has since been deleted is
        still returned — the caller asked what it holds, not what is playable,
        and hiding it would make a repaired library look like data loss.
        """
        with self._lock:
            return [row for row in self._records().values() if row.user_id == user_id]

    def get(self, user_id: str, rel_path: str) -> UserTrack | None:
        with self._lock:
            return self._records().get((user_id, rel_path))

    def references_for_path(self, rel_path: str) -> list[UserTrack]:
        """Account references that follow a restored or relocated file."""
        with self._lock:
            return [row for row in self._records().values() if row.rel_path == rel_path]

    def all_paths(self):
        with self._lock:
            return {row.rel_path for row in self._records().values()}

    def snapshot(self, rel):
        return [asdict(row) for row in self.references_for_path(rel)]

    def drop(self, rel, snapshot):
        with self._lock:
            rows = self._records()
            for key in [key for key in rows if key[1] == rel]:
                del rows[key]
            self._save(rows)

    def restore(self, rel, snapshot):
        with self._lock:
            rows = self._records()
            for data in snapshot:
                row = UserTrack(**data)
                rows.setdefault(row.key, row)
            self._save(rows)

    def owns_many(self, user_id: str, rel_paths: Sequence[str]) -> list[bool]:
        """One answer per request entry, in the same order.

        Positional like ``POST /api/library/ownership``: the caller lines the
        results up with what it sent, and a client that renders markers by index
        must never be handed a filtered list.
        """
        with self._lock:
            rows = self._records()
            return [(user_id, rel_path) in rows for rel_path in rel_paths]

    # --------------------------------------------------------------- writing

    def add_many(
        self, user_id: str, rel_paths: Sequence[str], *, acquired: bool = False
    ) -> tuple[list[str], list[str]]:
        """Give this user rows for these paths. Returns ``(added, already)``.

        The dedupe hit the design document is built around: the bytes are already
        on disk, so becoming the caller's is one row and no download. Adding
        twice preserves ``added_at``, likes and play count. Only a finished
        download (``acquired=True``) may upgrade provenance on an existing row;
        hits, manual adds and plays never do.
        """
        added: list[str] = []
        already: list[str] = []
        changed = False
        with self._lock:
            rows = self._records()
            for rel_path in rel_paths:
                key = (user_id, rel_path)
                if key in rows:
                    if acquired and not rows[key].acquired:
                        rows[key] = replace(rows[key], acquired=True)
                        changed = True
                    already.append(rel_path)
                    continue
                rows[key] = UserTrack(user_id=user_id, rel_path=rel_path, added_at=utc_now_iso(), acquired=acquired)
                added.append(rel_path)
            if added or changed:
                self._write(rows)
        return added, already

    def remove_many(self, user_id: str, rel_paths: Sequence[str]) -> list[str]:
        """Remove references only; shared audio and other accounts' rows remain intact.

        Unknown references are ignored so retries are harmless. File deletion belongs
        to the separate owner-authorized music operation.
        """
        removed: list[str] = []
        with self._lock:
            rows = self._records()
            for rel_path in rel_paths:
                if rows.pop((user_id, rel_path), None) is not None:
                    removed.append(rel_path)
            if removed:
                self._write(rows)
        return removed

    def remove_user(self, user_id: str) -> None:
        """Remove every reference held by an account, including missing files."""
        with self._lock:
            self.remove_many(user_id, [r.rel_path for r in self.list_for_user(user_id)])

    def prune_unknown_users(self, known_user_ids: set[str]) -> int:
        """Drop rows of accounts that no longer exist (deleted by a server older
        than delete-account). An empty ``known`` set is refused: an unreadable
        ``users.json`` must never empty everyone's library."""
        if not known_user_ids:
            return 0
        with self._lock:
            rows = self._records()
            stale = [k for k in rows if k[0] not in known_user_ids]
            for k in stale:
                rows.pop(k)
            if stale:
                self._write(rows)
            return len(stale)

    def exclusive_acquired(self, user_id: str, real_user_ids: set[str]) -> list[UserTrack]:
        """Acquired rows no other current account holds; orphan rows do not count."""
        with self._lock:
            rows = self._records().values()
            shared = {r.rel_path for r in rows if r.user_id != user_id and r.user_id in real_user_ids}
            return [r for r in rows if r.user_id == user_id and r.acquired and r.rel_path not in shared]

    def repoint(self, old_rel_path: str, new_rel_path: str) -> int:
        """Every user's row for ``old`` now points at ``new``. Returns how many.

        For a file that moved or was replaced by another version (see
        ``domains/music/relocation.py``): a row is a reference, so it follows
        the song rather than disappearing with its old path. A user who already
        holds ``new`` keeps one row — the earlier ``added_at``, the summed
        plays, the likes and the offline flag OR-ed.
        """
        if old_rel_path == new_rel_path:
            return 0
        moved = 0
        with self._lock:
            rows = self._records()
            for key in [k for k in rows if k[1] == old_rel_path]:
                row = rows.pop(key)
                there = rows.get((row.user_id, new_rel_path))
                if there is not None:
                    row = replace(
                        there,
                        added_at=min(there.added_at, row.added_at),
                        liked=there.liked or row.liked,
                        offline=there.offline or row.offline,
                        acquired=there.acquired or row.acquired,
                        play_count=there.play_count + row.play_count,
                        last_played_at=max(
                            (t for t in (there.last_played_at, row.last_played_at) if t),
                            default=None,
                        ),
                    )
                rows[(row.user_id, new_rel_path)] = replace(row, rel_path=new_rel_path)
                moved += 1
            if moved:
                self._write(rows)
        return moved

    def update_flags(
        self,
        user_id: str,
        rel_path: str,
        liked: bool | None = None,
        offline: bool | None = None,
    ) -> UserTrack:
        """Set ``liked``/``offline``. ``None`` means *leave it alone*.

        Refuses a row that does not exist rather than creating one: liking a
        track you do not have is meaningless, and an upsert here would quietly
        become a second way to add — one that skips the on-disk check.
        """
        with self._lock:
            rows = self._records()
            row = rows.get((user_id, rel_path))
            if row is None:
                raise UnknownUserTrackError(rel_path)
            updated = replace(
                row,
                liked=row.liked if liked is None else bool(liked),
                offline=row.offline if offline is None else bool(offline),
            )
            if updated == row:
                return row
            rows[(user_id, rel_path)] = updated
            self._write(rows)
            return updated

    def record_play(self, user_id: str, rel_path: str) -> UserTrack:
        """Count a play, creating the row if the user did not have one.

        Playing something is having it, so this is also an add — which is why a
        *created* row is written through immediately while a mere increment is
        coalesced (see "Flush strategy").
        """
        with self._lock:
            rows = self._records()
            key = (user_id, rel_path)
            row = rows.get(key)
            created = row is None
            if row is None:
                row = UserTrack(user_id=user_id, rel_path=rel_path, added_at=utc_now_iso())
            updated = replace(row, play_count=row.play_count + 1, last_played_at=utc_now_iso())
            rows[key] = updated
            if created:
                self._write(rows)
            else:
                self._write_if_due(rows)
            return updated

    def set_play_stats(self, user_id: str, rel_path: str, count: int, last: str) -> None:
        with self._lock:
            rows = self._records()
            row = rows.get((user_id, rel_path))
            if row is not None:
                rows[(user_id, rel_path)] = replace(row, play_count=max(row.play_count, count),
                    last_played_at=max(row.last_played_at or '', last))
                self._write_if_due(rows)

    def flush(self) -> None:
        """Write a coalesced play now, if one is waiting. No-op otherwise."""
        with self._lock:
            if self._pending:
                self._write(self._records())

    # --------------------------------------------------------------- private

    def _write_if_due(self, rows: dict[tuple[str, str], UserTrack]) -> None:
        """Persist unless a write happened within PLAY_FLUSH_SECONDS. Holds lock."""
        self._publish(rows)
        if (time.monotonic() - self._last_write) >= PLAY_FLUSH_SECONDS:
            self._write(rows)
        else:
            self._pending = True

    def _write(self, rows: dict[tuple[str, str], UserTrack]) -> None:
        """Save, and clear the deferred-play debt. Caller holds the lock."""
        self._publish(rows)
        try:
            self._save(rows)
        except OSError as e:
            # A read-only disk must not turn a play into a 500. The row is
            # already correct in memory and the next successful write carries it.
            self.logger.warning("Could not persist %s: %s", self.path, e)
            self._pending = True
            return
        self._pending = False
        self._last_write = time.monotonic()

    def _load(self) -> dict[tuple[str, str], UserTrack]:
        raw = read_json_store(self.path, 1, rows='rows')
        if raw is None:
            return {}
        entries = raw['rows']
        out: dict[tuple[str, str], UserTrack] = {}
        for entry in entries:
            row = _parse_row(entry)
            if row is None:
                refuse("user_tracks", raw.get("version", 0), 1, "read", "malformed user_track row")
            if row.key in out:
                refuse("user_tracks", raw.get("version", 0), 1, "read", "duplicate user_track key")
            out[row.key] = row
        return out

    def _save(self, rows: dict[tuple[str, str], UserTrack]) -> None:
        """Atomic, owner-only write. Caller holds the lock."""
        payload = {
            "version": 1,
            "rows": [
                {
                    "user_id": r.user_id,
                    "rel_path": r.rel_path,
                    "added_at": r.added_at,
                    "liked": r.liked,
                    "offline": r.offline,
                    "play_count": r.play_count,
                    "last_played_at": r.last_played_at,
                    "acquired": r.acquired,
                }
                for r in rows.values()
            ],
        }
        # No sort_keys: row order is insertion order, which is the order a user
        # added their music and the order the API returns it in.
        self._publish(rows)
        write_json_store(self.path, payload, 1, mode=PRIVATE)

    def _publish(self, rows):
        affected = {key[0] for key in rows.keys() | self._published_rows.keys()
                    if rows.get(key) != self._published_rows.get(key)}
        for user_id in affected:
            self.changes.bump(f'me:{user_id}')
        self._published_rows = dict(rows)


def _parse_row(entry: object) -> UserTrack | None:
    """One row, or ``None`` if it is unusable. Tolerant like the token store."""
    if not isinstance(entry, dict):
        return None
    user_id = entry.get("user_id")
    rel_path = entry.get("rel_path")
    if not isinstance(user_id, str) or not user_id:
        return None
    try:
        rel_path = normalize_rel_path(rel_path)
    except InvalidRelPathError:
        return None
    added_at = entry.get("added_at")
    last_played_at = entry.get("last_played_at")
    play_count = entry.get("play_count")
    return UserTrack(
        user_id=user_id,
        rel_path=rel_path,
        added_at=added_at if isinstance(added_at, str) and added_at else utc_now_iso(),
        liked=bool(entry.get("liked")),
        offline=bool(entry.get("offline")),
        acquired=entry.get("acquired") is True,
        # bool is an int in Python; a stray `true` must not read as one play.
        play_count=play_count if isinstance(play_count, int) and not isinstance(play_count, bool) and play_count >= 0 else 0,
        last_played_at=last_played_at if isinstance(last_played_at, str) and last_played_at else None,
    )
