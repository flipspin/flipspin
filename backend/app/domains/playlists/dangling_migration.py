"""One startup repair of playlist rows left behind by older file deletions."""
import json
import logging
import time
from pathlib import Path

from app.domains.metadata.normalization import normalize_key
from app.domains.music.library_files import AUDIO_EXTENSIONS, walk_library
from app.domains.playlists.services import serialized
from app.exceptions import ValidationError
from app.infra.files import SHARED, write_json_atomic
from app.utils.path_safety import resolve_under

logger = logging.getLogger(__name__)
META_NAME = 'playlists-cleanup-meta.json'
VERSION = 1


def library_file(root: Path, path: str) -> Path | None:
    """Resolve stored absolute/relative paths with the library containment guard."""
    try:
        candidate = Path(path)
        if candidate.is_absolute():
            candidate = candidate.resolve().relative_to(root.resolve())
        return resolve_under(root, *candidate.parts)
    except (ValueError, ValidationError):
        return None


@serialized
def migrate_dangling_rows(service) -> dict | None:
    """Mark completion after all atomic writes, allowing safe interrupted retries.

    Do not infer loss from an unmounted or empty music tree. A later startup can
    retry it; no flag is written until at least one audio file is visible.
    """
    root = Path(service.config.base_music_dir)
    marker = service.config.playlist_dir.parent / META_NAME
    meta = json.loads(marker.read_text()) if marker.exists() else {}
    if meta.get('danglingRowsVersion') == VERSION:
        return None
    if not root.is_dir():
        return None

    def unreadable(error):
        raise error

    files = []
    for folder, _, names in walk_library(root, onerror=unreadable):
        for name in sorted(names):
            if name.startswith('.') or Path(name).suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            path = library_file(root, str(Path(folder) / name))
            if path is not None and path.is_file():
                files.append(path)
    if not files:
        return None

    by_title = {}
    for path in files:
        tags = service.music_repo.read_tags(path)
        title = normalize_key(None, tags.get('title') or path.stem)
        if title:
            by_title.setdefault(title, []).append((path, normalize_key(None, tags.get('artist') or '')))

    counts = {'repointed': 0, 'removed': 0, 'playlists': 0}
    for name in service.playlist_repo.list_playlists():
        playlist_path = service.playlist_repo._playlist_path(name)
        data = json.loads(playlist_path.read_text(encoding='utf-8'))
        kept = []
        changed = False
        for row in data['tracks']:
            old = library_file(root, row['path'])
            if old is not None and old.is_file():
                kept.append(row)
                continue
            old = old or Path(row['path'])
            candidates = by_title.get(normalize_key(None, row.get('title') or old.stem), [])
            if candidates:
                artist = normalize_key(None, row.get('artist') or '')
                target, _ = min(candidates, key=lambda item: (
                    item[0].parent != old.parent,
                    not artist or item[1] != artist,
                    str(item[0]),
                ))
                kept.append({**row, 'path': str(target)})
                counts['repointed'] += 1
            else:
                counts['removed'] += 1
            changed = True
        if changed:
            data['tracks'] = kept
            data['modified'] = time.time()
            write_json_atomic(playlist_path, data, mode=SHARED, indent=2, ensure_ascii=False)
            counts['playlists'] += 1
    write_json_atomic(marker, {**meta, 'danglingRowsVersion': VERSION}, mode=SHARED)
    logger.info('Playlist dangling rows: repointed=%d removed=%d playlists=%d',
                counts['repointed'], counts['removed'], counts['playlists'])
    return counts
