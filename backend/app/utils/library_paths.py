"""Map physical library paths to the two-segment album/file wire key.

Fold nested boundaries with U+2215, never %2F; refuse ambiguous matches.
See docs/library-scanning.md#library-keys.
"""
from __future__ import annotations

import re
from pathlib import Path

from app.exceptions import AmbiguousLibraryKeyError
from app.utils.path_safety import resolve_under

#: Stands in for ``/`` inside one key segment.
NEST = "∕"

#: The one ``/`` a ``relPath`` carries: ``<album key>/<file key>``.
REL_PATH_SEPARATOR = "/"

#: One URL segment, but impossible as a real folder on supported filesystems
#: (255-byte component limit). No NEST means a folded nested key cannot match
#: it either. Do not shorten it or rename existing folders to reserve a key.
ROOT_ALBUM_KEY = "~krobi-root~" + "~" * 244
ROOT_ALBUM_NAME = "Loose songs"

#: Reserved storage component for derived files outside the music library.
#: Callers must reject dot-prefixed request keys before mapping them.
ROOT_ALBUM_DIR = ".krobi-root"

#: A disc folder belongs to the album above it: "CD1", "CD 2", "Disc 1",
#: "Disk 01", "Disco 2". Only the bare word plus a number — "CD Singles" is an
#: album of its own.
DISC_DIR = re.compile(r"^(?:cd|dis[ck]|disco|disque)\s*[-_.]?\s*\d{1,2}$", re.IGNORECASE)


def album_storage_name(album: str) -> str:
    """A single storage component for an album key; ordinary keys stay unchanged.

    The root key deliberately exceeds the filesystem component limit. Derived
    storage uses a hidden directory that request keys cannot address directly.
    The returned name must still pass through ``resolve_under``.
    """
    return ROOT_ALBUM_DIR if album == ROOT_ALBUM_KEY else album


def is_disc_dir(name: str) -> bool:
    return bool(DISC_DIR.match(name.strip()))


def disc_number(name: str) -> int | None:
    """Disc-folder hint, used only when the file has no disc tag."""
    if not is_disc_dir(name):
        return None
    number = int(re.search(r'\d+$', name.strip()).group())
    return number or None


def encode(parts: tuple[str, ...] | list[str]) -> str:
    return NEST.join(parts)


def decode(key: str) -> list[str]:
    return key.split(NEST)


def album_dir_of(base: Path, file_path: Path) -> Path:
    """The album folder a song belongs to: its folder, or the one above a disc folder."""
    parent = file_path.parent
    if is_disc_dir(parent.name) and parent.parent != base and parent.parent != parent:
        try:
            parent.parent.relative_to(base)
            return parent.parent
        except ValueError:
            return parent
    return parent


def album_key(base: Path, album_dir: Path) -> str | None:
    """``Daft Punk∕Discovery`` for a nested album; the reserved key at the root; None outside."""
    try:
        rel = Path(album_dir).resolve().relative_to(Path(base).resolve())
    except (OSError, ValueError, TypeError):
        return None
    if not rel.parts:
        return ROOT_ALBUM_KEY
    return encode(rel.parts)


def keys_for(base: Path, file_path: Path) -> tuple[str, str] | None:
    """Return album/file keys for a song under base, or None outside it.

    Root files use the reserved album key to preserve the two-segment wire shape."""
    try:
        base_r = Path(base).resolve()
        path_r = Path(file_path).resolve()
        path_r.relative_to(base_r)
    except (OSError, ValueError, TypeError):
        return None
    album_dir = album_dir_of(base_r, path_r)
    key = album_key(base_r, album_dir)
    if key is None:
        return None
    return key, encode(path_r.relative_to(album_dir).parts)


def rel_path_for(base: Path, file_path: Path) -> str | None:
    """Return the two-segment relPath identity, or None outside the library."""
    keys = keys_for(base, file_path)
    return None if keys is None else f"{keys[0]}{REL_PATH_SEPARATOR}{keys[1]}"


def file_key(album_dir: Path, file_path: Path) -> str:
    """``CD2∕01.flac`` for a song in a disc folder, the bare name otherwise."""
    try:
        return encode(Path(file_path).relative_to(album_dir).parts)
    except ValueError:
        return Path(file_path).name


def media_path_for(base: Path, file_path: Path) -> str | None:
    keys = keys_for(base, file_path)
    return None if keys is None else f"/api/media/{keys[0]}/{keys[1]}"


def _key_candidates(base: Path, key: str, parents: tuple[str, ...]):
    """Yield all existing interpretations, always contained by ``base``.

    Only explore splits whose prefix is a real directory; do not enumerate
    every possible partition of a caller-supplied key.
    """
    literal = resolve_under(base, *parents, key)
    if literal.exists():
        yield literal
    for boundary in reversed([i for i, char in enumerate(key) if char == NEST]):
        prefix, suffix = key[:boundary], key[boundary + 1:]
        if not prefix or not suffix:
            continue
        if resolve_under(base, *parents, prefix).is_dir():
            yield from _key_candidates(base, suffix, (*parents, prefix))


def _find_key(base: Path, key: str, parents: tuple[str, ...]) -> Path | None:
    candidates = set(_key_candidates(base, key, parents))
    if len(candidates) > 1:
        raise AmbiguousLibraryKeyError(key)
    return next(iter(candidates), None)


def _resolve_key(base: Path, key: str, parents: tuple[str, ...] = ()) -> Path:
    if NEST not in key:
        return resolve_under(base, *parents, key)
    candidate = _find_key(base, key, parents)
    if candidate is not None:
        return candidate
    # Keep the previous missing-path result and validation of decoded parts.
    return resolve_under(base, *parents, *decode(key))


def resolve_album(base: Path, key: str) -> Path:
    """The album folder for a key, containment-checked (raises ``ValidationError``)."""
    if key == ROOT_ALBUM_KEY:
        return resolve_under(base)
    return _resolve_key(base, key)


def resolve_track(base: Path, album: str, file: str) -> Path:
    """The file for an ``album``/``file`` key pair, containment-checked.

    Any segment may be nested (``CD2∕01.flac``); every decoded part still goes
    through ``resolve_under``, so no key can reach outside ``base``.
    """
    if album != ROOT_ALBUM_KEY and NEST not in album and NEST not in file:
        return resolve_under(base, album, file)
    base = Path(base).resolve()
    albums = [resolve_under(base)] if album == ROOT_ALBUM_KEY else [
        path for path in _key_candidates(base, album, ()) if path.is_dir()
    ]
    candidates = set()
    for album_path in albums:
        parts = album_path.relative_to(base).parts
        candidates.update(path for path in _key_candidates(base, file, parts) if path.is_file())
        if len(candidates) > 1:
            raise AmbiguousLibraryKeyError(f"{album}/{file}")
    if candidates:
        return candidates.pop()
    # Preserve missing-path behavior, while refusing an ambiguous album.
    album_path = resolve_album(base, album)
    return _resolve_key(base, file, album_path.relative_to(base).parts)


def require_unique_path(base: Path, path: Path) -> None:
    """Guard physical-path mutations, including a proposed move destination."""
    keys = keys_for(base, path)
    if keys is None:
        return
    resolved = resolve_track(base, *keys)
    if resolved.exists() and resolved != Path(path).resolve():
        raise AmbiguousLibraryKeyError(f"{keys[0]}/{keys[1]}")


def split_rel_path(rel_path: str) -> tuple[str, str]:
    album, _, file = rel_path.partition(REL_PATH_SEPARATOR)
    return album, file


def resolve_rel_path(base: Path, rel_path: str) -> Path:
    album, file = split_rel_path(rel_path)
    return resolve_track(base, album, file)
