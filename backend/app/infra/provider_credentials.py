"""Compatibility entry points; all persistence belongs to infra.secrets."""
from pathlib import Path

from app.infra.secrets import SecretStore


def load_genius_key(directory: Path, fallback: str | None) -> str | None:
    store = SecretStore(directory, directory.parent / "instance.json")
    return store.get("KROBI_GENIUS_API_KEY") or fallback


def save_genius_key(directory: Path, key: str) -> None:
    store = SecretStore(directory, directory.parent / "instance.json")
    if key:
        store.put("KROBI_GENIUS_API_KEY", key)
    else:
        store.delete("KROBI_GENIUS_API_KEY")
