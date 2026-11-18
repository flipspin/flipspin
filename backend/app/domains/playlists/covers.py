"""Album selection shared by desktop playlist tiles and OpenSubsonic."""
from pathlib import Path

from app.utils.library_paths import keys_for


def _cover_albums(tracks, limit: int = 4, base: Path | None = None) -> list[str]:
    """The album directories a playlist's mosaic tile is drawn from.

    First ``limit`` *distinct* albums in track order: four songs off one record
    would otherwise tile the same cover four times. The directory name is what
    the media route keys on (``Path(album.path).name``), not the tag.
    """
    seen: list[str] = []
    for t in tracks:
        keys = keys_for(base, Path(t.path)) if t.path and base is not None else None
        name = keys[0] if keys else (Path(t.path).parent.name if t.path else "")
        if name and name not in seen:
            seen.append(name)
            if len(seen) >= limit:
                break
    return seen
