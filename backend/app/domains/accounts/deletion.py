"""File eligibility shared by account deletion preview and execution.

Only acquired, exclusive files under the current music root qualify.
Resolve candidates safely and skip files that cannot be resolved.
See docs/security.md#account-routes.
"""
from pathlib import Path
import logging

from app.domains.accounts.identity import TokenStore
from app.domains.user_library.store import UserTrackStore
from app.utils.library_paths import resolve_rel_path

logger = logging.getLogger(__name__)


def removable_files(
    user_id: str, accounts: TokenStore, tracks: UserTrackStore, base: Path,
) -> list[tuple[Path, int]]:
    """Only acquired, exclusive, existing files under the current music root."""
    real_ids = {u.user_id for u in accounts.list_users()}
    files = []
    seen: set[Path] = set()
    for row in tracks.exclusive_acquired(user_id, real_ids):
        try:
            path = resolve_rel_path(base, row.rel_path)
            if path not in seen and path.is_file():
                files.append((path, path.stat().st_size))
                seen.add(path)
        except Exception:
            logger.warning("Cannot resolve deletion candidate %r", row.rel_path, exc_info=True)
    return files
