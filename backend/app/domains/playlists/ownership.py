"""Authorize playlist access and migrate playlists without an owner.

Members access their own playlists; names remain unique across all accounts.
See docs/DEVELOPER_GUIDE.md#playlist-authorization.
"""
from __future__ import annotations

import logging
from datetime import datetime, UTC
from pathlib import Path
from typing import TYPE_CHECKING
from collections.abc import Iterable

from app.infra.files import write_json_atomic
from app.infra.identity import ANONYMOUS, LOCAL_OWNER, ROLE_OWNER, Principal

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.config import ConfigManager
    from app.domains.playlists.models import Playlist
    from app.domains.playlists.repositories import PlaylistRepository
    from app.infra.identity import AccountDirectory

logger = logging.getLogger(__name__)

#: Keep the migration marker beside state files, outside playlists/.
#: pathlib's JSON glob includes dotfiles, so a hidden marker inside the
#: playlist directory would still appear as a playlist.
MIGRATION_MARKER_NAME = "playlists-owner-migration.json"

#: JSON key carrying the owner inside a playlist file.
OWNER_KEY = "owner"


class PlaylistAccessError(Exception):
    """This playlist exists and belongs to somebody else. Maps to 403.

    Deliberately not a subclass of :class:`~app.exceptions.PlaylistError`:
    every playlist route already has an ``except PlaylistError`` arm that answers
    404, and inheriting would turn every "not yours" into a "does not exist" the
    moment somebody reorders the handlers.
    """


# --------------------------------------------------------------------- rules


def may_access(principal: Principal | None, owner_id: str | None) -> bool:
    """Use the same ownership predicate for playlist reads and mutations.

    Ownerless files resolve to owner-only access, matching the migration policy
    for manually added files and files written by older builds.
    """
    if principal is None:
        return True  # no identity in play: an internal caller, not a request
    if principal.role == ROLE_OWNER:
        return True
    if principal.user_id == ANONYMOUS.user_id:
        # KROBI_ALLOW_UNAUTHENTICATED_REMOTE=true. There is no identity to
        # enforce against here — every caller on the LAN is the same nameless
        # principal — and app/domains/accounts/auth.py already logs that "anyone who can
        # reach this port owns the music library" for exactly this setting.
        # Filtering would not add privacy, it would only make the one
        # deployment that set the flag open onto an empty playlist screen.
        # Deliberately *not* granted owner status: it still cannot manage the
        # token table (require_owner), which is the line identity.py drew.
        return True
    return bool(owner_id) and owner_id == principal.user_id


def visible_playlists(
    principal: Principal | None, playlists: Iterable[Playlist]
) -> list[Playlist]:
    """The subset of ``playlists`` this caller is allowed to know about."""
    return [p for p in playlists if may_access(principal, p.owner_id)]


def require_access(principal: Principal | None, playlist: Playlist) -> Playlist:
    """Return the playlist, or raise :class:`PlaylistAccessError` (403)."""
    if not may_access(principal, playlist.owner_id):
        raise PlaylistAccessError(
            f"Playlist '{playlist.name}' belongs to another user."
        )
    return playlist


def owner_id_for(principal: Principal | None) -> str | None:
    """The owner to stamp on a playlist this caller is creating."""
    return principal.user_id if principal is not None else None


def account_playlists(repo: PlaylistRepository, user_id: str) -> list[str]:
    """Read the playlists owned by one account without running a migration."""
    names = []
    for name in repo.list_playlists():
        try:
            if repo.load_playlist(name).owner_id == user_id:
                names.append(name)
        except Exception:
            logger.exception("Could not read playlist %r while checking account ownership", name)
    return names


def settle_account_playlists(
    repo: PlaylistRepository, user_id: str, caller_id: str, *, delete: bool,
) -> None:
    """A revoked account's playlists pass to the caller or leave the nest."""
    for name in account_playlists(repo, user_id):
        try:
            if delete:
                repo.delete_playlist(name)
            else:
                repo.set_owner(name, caller_id, previous_owner=user_id)
        except Exception:
            logger.exception("Could not settle playlist %r of revoked account %s", name, user_id)


# ----------------------------------------------------------------- migration


def marker_path(config: ConfigManager) -> Path:
    """Where the one-shot marker lives, read from config live."""
    return config.data_root / MIGRATION_MARKER_NAME


def household_owner_id(store: AccountDirectory | None) -> str:
    """Assign existing playlists to the first owner, or the local-owner sentinel.

    All owner-role principals retain access, so installations without account rows
    keep their playlists accessible before and after enrollment.
    """
    if store is not None:
        try:
            for record in store.list_users():
                if record.role == ROLE_OWNER:
                    return record.user_id
        except Exception as e:  # a corrupt table must not block a migration
            logger.warning("Could not read the token table for ownership: %s", e)
    return LOCAL_OWNER.user_id


def migrate_playlist_ownership(
    config: ConfigManager,
    repo: PlaylistRepository,
    store: AccountDirectory | None = None,
    logger_: logging.Logger | None = None,
) -> dict:
    """Assign ownerless playlists once per library; return a summary without raising.

    Write the marker first: interruption leaves owner-only files and must not
    trigger later reassignment. See docs/DEVELOPER_GUIDE.md#playlist-authorization.
    """
    log = logger_ or logger
    marker = marker_path(config)
    if marker.exists():
        return {"ran": False, "reason": "already-migrated", "assigned": []}

    owner_id = household_owner_id(store)
    try:
        _write_marker(marker, owner_id)
    except OSError as e:
        # Without a marker this would run again next start, so refuse to do the
        # work at all rather than do it repeatedly.
        log.warning("Could not write the playlist-ownership marker at %s: %s", marker, e)
        return {"ran": False, "reason": "marker-unwritable", "assigned": []}

    assigned: list[str] = []
    try:
        names = repo.list_playlists()
    except Exception as e:
        log.warning("Could not list playlists for the ownership migration: %s", e)
        return {"ran": True, "owner_id": owner_id, "assigned": assigned}

    for name in names:
        try:
            if repo.set_owner(name, owner_id):
                assigned.append(name)
        except Exception as e:
            # One unreadable playlist must not abandon the rest.
            log.warning("Could not assign an owner to playlist %r: %s", name, e)

    if assigned:
        log.info(
            "Playlist ownership migration: assigned %d pre-existing playlist(s) to %s",
            len(assigned),
            owner_id,
        )
    else:
        log.info("Playlist ownership migration: nothing to assign")
    return {"ran": True, "owner_id": owner_id, "assigned": assigned}


def _write_marker(path: Path, owner_id: str) -> None:
    """Atomic write. Not a secret, so shared (0644)."""
    payload = {
        "version": 1,
        "migratedAt": datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "ownerId": owner_id,
    }
    write_json_atomic(path, payload, sort_keys=True)
