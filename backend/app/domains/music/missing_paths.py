"""Read remembered keys even while the library mount is absent."""
from app.utils.library_paths import ROOT_ALBUM_KEY, decode, resolve_rel_path
from app.utils.path_safety import resolve_under


def remembered_path(base, rel):
    if base.is_dir():
        return resolve_rel_path(base, rel)
    album, file = rel.split('/')
    anchor = base.parent
    while not anchor.is_dir() and anchor != anchor.parent:
        anchor = anchor.parent
    parts = (*base.relative_to(anchor).parts, *(() if album == ROOT_ALBUM_KEY else decode(album)), *decode(file))
    return resolve_under(anchor, *parts)
