"""Project remembered songs into the owner's album pages without serving audio."""
from dataclasses import replace
from pathlib import Path

from app.domains.music.analysis_precedence import listing_analysis, precedence
from app.domains.music.models import Album, Track
from app.domains.music.missing_paths import remembered_path
from app.exceptions import ValidationError
from app.utils.library_paths import album_dir_of, disc_number, rel_path_for


def owner_ghosts(repository, albums, scope):
    if not scope.unrestricted:
        return albums
    key = (str(repository.config.base_music_dir), repository.changes.revision('library'),
           repository.changes.revision('analysis'), scope.unrestricted, scope.allowed_rel_paths)
    with repository._lock:
        cached = repository._owner_ghosts
        if cached is not None and cached[0] == key:
            return cached[1]
        result = _owner_ghosts(repository, albums)
        repository._owner_ghosts = (key, result)
        return result


def _owner_ghosts(repository, albums):
    base = repository.config.base_music_dir
    with repository.analysis.connection() as db:
        rows = {r['rel_path']: dict(r) for r in db.execute('SELECT * FROM track_analysis')}
        removed = {r[0].removeprefix('missing_removed:') for r in db.execute("SELECT key FROM meta WHERE key LIKE 'missing_removed:%'")}
    remembered = {rel: (Path(path), tags) for path, (_, tags) in list(repository._tag_cache.items())
                  if (rel := rel_path_for(base, Path(path)))}
    known = rows.keys() | remembered.keys()
    groups = {album.path.resolve(): replace(album, tracks=[t for t in album.tracks
              if ((rel := rel_path_for(base, t.path)) not in removed or t.path.is_file()) and (rel not in known or t.path.is_file())]) for album in albums}
    present = {t.path.resolve() for album in groups.values() for t in album.tracks}
    for rel in rows.keys() | remembered.keys():
        if rel in removed:
            continue
        try:
            resolved = remembered_path(base, rel)
            if resolved in present or resolved.is_file():
                continue
            path = base / resolved.relative_to(base.resolve())
            folder = album_dir_of(base, path)
            tags = remembered.get(rel, (None, {}))[1]
            row = rows.get(rel)
            analysis = listing_analysis(precedence(row, tags), row)
            analysis['analysisState'] = 'analyzed' if row and row.get('analyzed_at') else 'none'
            track = Track(title=tags.get('title') or path.stem, artist=tags.get('artist') or 'Unknown Artist',
                album=tags.get('album') or path.parent.name, path=path,
                track_number=tags.get('track_number'), duration=tags.get('duration'),
                disc_number=tags.get('disc_number') or (disc_number(path.parent.name) if path.parent != folder else None),
                date_added=repository.first_seen.get(path, fallback=tags.get('mtime')), genre=tags.get('genre'),
                artists=tags.get('artists') or [], genres=tags.get('genres') or [],
                file_size=tags.get('size') or (row or {}).get('size') or 0,
                bpm=analysis['bpm'], key=analysis['key_name'], mood=analysis['mood'], analysis=analysis,
                missing_since=(row or {}).get('missing_since'), missing=True)
            key = folder.resolve()
            if key not in groups:
                groups[key] = Album(name=track.album, artist=track.artist, path=folder, tracks=[])
            groups[key].tracks.append(track)
        except (ValueError, OSError, ValidationError):
            continue
    for album in groups.values():
        album.tracks.sort(key=lambda t: (t.disc_number or 1, t.track_number or 9999, t.title))
    return list(groups.values())
