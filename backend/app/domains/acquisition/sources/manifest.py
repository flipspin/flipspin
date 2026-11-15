"""Source manifests through the shared extension loader (infra.extensions)."""
import json
from pathlib import Path

from app.infra.extensions import read_manifest as read_extension


def read_manifest(path: Path) -> tuple[dict, str, str | None]:
    """Validate a source before spawning; returns (manifest, state, reason).

    The shared loader owns the schema and the protocol check. Sources add two
    rules of their own: they run on the nest and they supply audio.
    """
    extension = read_extension(path, expected_kind="source")
    try:
        # The supervisor reads the manifest as written (entry.command, id); the
        # loader's typed record only decides whether it may be spawned.
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    if extension.state != "on":
        return data, extension.state, extension.reason
    if "nest" not in extension.runs:
        return data, "invalid", "Source must run on nest"
    if not extension.entry.command:
        return data, "invalid", "Source has no command"
    if "source:audio" not in extension.adds:
        return data, "incompatible", "Source does not supply audio"
    return data, "on", None
