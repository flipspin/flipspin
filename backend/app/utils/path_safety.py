"""Path resolution under a base dir. Stops traversal (..) and paths outside base."""
from pathlib import Path

from app.exceptions import ValidationError


def resolve_under(base: Path, *segments: str) -> Path:
    """Path under base; segments must not contain .. or separators."""
    base_resolved = base.resolve()
    if not base_resolved.is_dir():
        raise ValidationError(f"Base path is not a directory: {base}")

    for segment in segments:
        if not segment or "\x00" in segment:
            raise ValidationError("Path segment cannot be empty or contain NUL")
        if segment in {".", ".."} or "/" in segment or "\\" in segment:
            raise ValidationError("Path segment cannot be '.' or '..' or contain path separators")
        if Path(segment).is_absolute():
            raise ValidationError("Path segment cannot be absolute")

    joined = base_resolved
    for segment in segments:
        joined = joined / segment

    resolved = joined.resolve()
    try:
        resolved.relative_to(base_resolved)
    except ValueError:
        raise ValidationError(f"Resolved path is outside base directory: {resolved}")

    return resolved


def safe_music_subpath(base_music_dir: Path, subpath: str | None) -> Path:
    """Optional folder name under base_music_dir; None/empty returns base."""
    base_resolved = base_music_dir.resolve()
    if not subpath or not subpath.strip():
        return base_resolved
    return resolve_under(base_resolved, subpath.strip())


def safe_open_path(allowed_base: Path, candidate_path: Path) -> Path:
    """Path must exist and be under allowed_base."""
    base_resolved = allowed_base.resolve()
    resolved = candidate_path.resolve()
    try:
        resolved.relative_to(base_resolved)
    except ValueError:
        raise ValidationError(f"Path is not under allowed directory: {candidate_path}")
    if not resolved.exists():
        raise ValidationError("File or directory does not exist")
    return resolved
