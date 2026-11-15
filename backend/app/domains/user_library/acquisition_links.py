"""Link acquired or already-present tracks to the requesting account.

Linking failures must not fail acquisition; skip principals without account rows.
See docs/DEVELOPER_GUIDE.md#personal-library-persistence.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from collections.abc import Iterable, Sequence

from app.infra.identity import Principal, is_real_user
from app.utils.library_paths import rel_path_for as library_rel_path_for
from app.utils.path_safety import resolve_under
from app.domains.user_library.store import (
    InvalidRelPathError,
    UserTrackStore,
    normalize_rel_path,
)

logger = logging.getLogger(__name__)


def restore_acquired(store, principal, root, path, old_rel, *, acquired):
    """Finish a missing-song recovery before the acquisition becomes complete.

    The durable request's library identity names the old reference. Never infer
    it from a title: two recordings can have the same name. References held by
    other accounts follow the restored song too, just as on a file relocation.
    """
    old_rel = normalize_rel_path(old_rel)
    old_path = resolve_under(Path(root), *old_rel.split('/'))
    new_rel = rel_path_for(root, path)
    if new_rel is None:
        raise ValueError('unaddressable-track')
    rows = store.references_for_path(old_rel)
    own = store.get(principal.user_id, old_rel)
    if not rows and store.get(principal.user_id, new_rel) is not None:
        return new_rel  # Replaying a committed link after a restart.
    if not rows or (own is None and not principal.is_owner):
        raise ValueError('missing-library-reference')
    if old_rel != new_rel and old_path.exists():
        raise ValueError('track-is-not-missing')
    # Library reads dateAdded from the file mtime. Restore it before any
    # completion listener scans the new path; no client-side order freeze.
    # A dedupe hit at a different path still restores the same library song.
    # Only a file this recovery downloaded gets the old date: a dedupe hit is a
    # file the nest already had (maybe another account's), whose own date stays.
    if acquired:
        original = own or min(rows, key=lambda row: row.added_at)
        stamp = datetime.fromisoformat(original.added_at.replace('Z', '+00:00')).timestamp()
        stat = Path(path).stat()
        os.utime(path, ns=(stat.st_atime_ns, int(stamp * 1_000_000_000)))
    store.repoint(old_rel, new_rel)
    store.add_many(principal.user_id, [new_rel], acquired=acquired)
    return new_rel

#: ``reason`` values on a :class:`LinkOutcome` that did nothing.
NO_USER = "no-user"          #: sentinel principal — the desktop. Expected, silent.
NO_STORE = "no-store"        #: no ``UserTrackStore`` was available at all.
LINK_FAILED = "link-failed"  #: the store refused (read-only disk, corrupt file).


@dataclass(frozen=True)
class LinkOutcome:
    """What linking managed to do. Never an exception, always an answer."""

    #: Paths that got a new row for this caller.
    linked: list[str] = field(default_factory=list)
    #: Paths the caller already held. Re-acquiring is not a reset — the existing
    #: row keeps its ``addedAt``, likes and play count.
    already: list[str] = field(default_factory=list)
    #: Files with no expressible ``rel_path`` (see docs/DEVELOPER_GUIDE.md#personal-library-persistence).
    unlinkable: list[str] = field(default_factory=list)
    #: Why nothing was linked, when nothing was. ``None`` on a normal run.
    reason: str | None = None

    @property
    def rel_paths(self) -> list[str]:
        """Everything the caller now holds out of this batch, new or not."""
        return [*self.linked, *self.already]

    @property
    def attempted(self) -> bool:
        """False when the caller has no library to link into."""
        return self.reason not in (NO_USER, NO_STORE)


def rel_path_for(base_music_dir, file_path) -> str | None:
    """Return a servable library key, or None when the path cannot identify a track.

    Resolve both sides before containment checks so symlinked library roots work.
    """
    if not file_path:
        return None
    rel = library_rel_path_for(Path(base_music_dir), Path(file_path))
    if rel is None:
        return None
    try:
        return normalize_rel_path(rel)
    except InvalidRelPathError:
        return None


def link_acquired(
    store: UserTrackStore | None,
    principal: Principal | None,
    base_music_dir,
    file_paths: Sequence[object],
    logger_: logging.Logger | None = None,
    *,
    acquired: bool = False,
) -> LinkOutcome:
    """Link these files, recording provenance only for a finished download.

    Idempotent by construction. ``UserTrackStore.add_many`` keeps an existing
    row's person data untouched and reports it in ``already``, so a job that is
    retried, or reports its completion twice, converges on exactly one row per
    ``(user_id, rel_path)`` with its original ``addedAt``. Duplicate paths inside
    one call are collapsed the same way.

    Raises nothing. See docs/DEVELOPER_GUIDE.md#personal-library-persistence.
    """
    log = logger_ or logger
    if not is_real_user(principal):
        # Synthetic principals have no account row; skipping is expected.
        log.debug("Acquisition not linked: caller %s has no library", principal)
        return LinkOutcome(reason=NO_USER)
    if store is None:
        log.warning("Acquisition not linked: no user_track store available")
        return LinkOutcome(reason=NO_STORE)

    rel_paths: list[str] = []
    unlinkable: list[str] = []
    seen = set()
    for candidate in file_paths or ():
        rel_path = rel_path_for(base_music_dir, candidate)
        if rel_path is None:
            unlinkable.append(str(candidate))
            continue
        if rel_path in seen:
            continue
        seen.add(rel_path)
        rel_paths.append(rel_path)

    if unlinkable:
        # One line for the batch, not one per file: a playlist acquisition makes
        # every single track unlinkable and that must not become 40 log lines.
        log.info(
            "%d acquired file(s) have no library-relative identity and were not "
            "linked to %s (nested below <album>/<file>?): %s",
            len(unlinkable),
            principal,
            unlinkable[0],
        )

    if not rel_paths:
        return LinkOutcome(unlinkable=unlinkable)

    try:
        added, already = store.add_many(principal.user_id, rel_paths, acquired=acquired)
    except Exception as e:  # noqa: BLE001 — a link must never fail a download
        log.warning("Could not link %d acquired track(s) to %s: %s", len(rel_paths), principal, e)
        return LinkOutcome(unlinkable=unlinkable, reason=LINK_FAILED)

    log.info("Linked %d acquired track(s) to %s (%d already held)", len(added), principal, len(already))
    return LinkOutcome(linked=list(added), already=list(already), unlinkable=unlinkable)


def link_results(
    store: UserTrackStore | None,
    principal: Principal | None,
    base_music_dir,
    results: Iterable | None,
    logger_: logging.Logger | None = None,
) -> LinkOutcome:
    """:func:`link_acquired` over a batch of :class:`DownloadResult`\\ s.

    The download engine's completion report *is* its return value: one result per
    requested track, carrying ``success`` and the ``file_path`` the bytes landed
    at. Only successful ones are linked — a failed download has no file, and a
    row for it would be a lie the phone would try to play.
    """
    log = logger_ or logger
    try:
        successful = [r for r in (results or ()) if getattr(r, "success", False) and getattr(r, "file_path", None)]
        paths = [r.file_path for r in successful if not getattr(r, "already_present", False)]
        hits = [r.file_path for r in successful if getattr(r, "already_present", False)]
    except Exception as e:  # noqa: BLE001 — an odd result shape is not a failure
        log.warning("Could not read download results for linking: %s", e)
        return LinkOutcome(reason=LINK_FAILED)
    downloaded = link_acquired(store, principal, base_music_dir, paths, logger_=log, acquired=True)
    present = link_acquired(store, principal, base_music_dir, hits, logger_=log)
    return LinkOutcome(
        linked=downloaded.linked + present.linked,
        already=downloaded.already + present.already,
        unlinkable=downloaded.unlinkable + present.unlinkable,
        reason=downloaded.reason or present.reason,
    )


__all__ = [
    "LINK_FAILED",
    "NO_STORE",
    "NO_USER",
    "LinkOutcome",
    "link_acquired",
    "link_results",
    "rel_path_for",
]
