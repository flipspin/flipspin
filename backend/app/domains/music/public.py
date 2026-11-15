"""Catalog public port for acquisition. The ownership oracle stays authoritative."""
from pathlib import Path

from .models import AudioMetadata as AudioMetadata

from app.utils.library_paths import rel_path_for
from app.utils.path_safety import safe_open_path


def invalidate_scan(repository):
    """Refresh the published catalog after an acquisition batch mutates it."""
    repository.invalidate_scan('mutation')


def refresh_folders(repository, paths):
    if repository is not None:
        repository.refresh_folders(paths)


def owned_paths(ownership, root, tracks):
    verdicts = ownership.lookup_many(tracks)
    result = {}
    for idx, verdict in enumerate(verdicts):
        if verdict.owned and verdict.match:
            path = safe_open_path(root, Path(verdict.match.path))
            if path.is_file() and rel_path_for(root, path):
                result[idx] = path
    return result


def remember_arrival(repository, path, *, receipt, sha=None):
    """Persist an import receipt before any follow-up writer touches its tags."""
    if repository is not None:
        repository.first_seen.published(path, receipt=receipt, sha=sha)
