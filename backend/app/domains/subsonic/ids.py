"""Subsonic ids: opaque to the client, derived from the library key, never stored.

``tr-`` + the song's ``relPath``, ``al-`` + the album's ``mediaKey``, ``ar-`` +
the artist's folded name, ``pl-`` + the playlist name, each base64url without
padding. Deriving them means an id survives a restart and a rescan with no
table to keep in step, and a stale one simply stops resolving.
"""
from __future__ import annotations

import base64
import unicodedata

SONG, ALBUM, ARTIST, PLAYLIST = "tr", "al", "ar", "pl"


def make(kind: str, key: str) -> str:
    encoded = base64.urlsafe_b64encode(key.encode("utf-8")).rstrip(b"=").decode("ascii")
    return f"{kind}-{encoded}"


def parse(value: str | None) -> tuple[str, str] | None:
    """``(kind, key)`` for an id this server made, else ``None``."""
    if not value or "-" not in value:
        return None
    kind, _, encoded = value.partition("-")
    if kind not in (SONG, ALBUM, ARTIST, PLAYLIST) or not encoded:
        return None
    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        return kind, base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def fold(text: str | None) -> str:
    """Case- and accent-insensitive form, for artist identity and search."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in decomposed if not unicodedata.combining(c)).casefold().strip()
