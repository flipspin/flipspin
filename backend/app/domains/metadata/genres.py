"""Look up album genres at acquisition time; browse track rows omit them.

Tags store Spanish genre names; contracts/genres.json supplies English display
names. Match the album by ISRC first, then normalized album/artist, then track
search. Leave the genre empty when identity cannot be established.
"""
from __future__ import annotations

import logging
import re
import threading
import unicodedata
from typing import Any

#: At most this many genres in one tag. Deezer gives some albums five, and a
#: chip reading "Alternative, Indie Pop, Pop, Indie Pop/Folk, Latin" is noise.
MAX_GENRES = 3


def norm(text: str | None) -> str:
    if not text:
        return ""
    t = unicodedata.normalize("NFKD", text)
    t = "".join(c for c in t if not unicodedata.combining(c)).casefold()
    t = re.sub(r"\((feat|ft|with|deluxe|remaster|bonus|explicit)[^)]*\)", " ", t)
    t = re.sub(r"\[[^\]]*\]", " ", t)
    t = re.sub(r"[^\w]+", " ", t)
    return " ".join(t.split())


def same_artist(a: str | None, b: str | None) -> bool:
    a, b = norm(a), norm(b)
    return bool(a and b) and (a == b or a in b or b in a)


def tag_value(pairs: list[tuple[str, str]]) -> str | None:
    """The TCON value: the Spanish names, de-duplicated, capped, ", "-joined."""
    out: list[str] = []
    for es, _en in pairs:
        if es and es not in out:
            out.append(es)
    return ", ".join(out[:MAX_GENRES]) or None


class AlbumGenres:
    """Genre and year per album, asked once per album per process.

    Every failure answers ``(None, None)``: a genre is an enrichment, and a
    download must never wait on, or fail because of, the catalog that names it.
    """

    def __init__(self, deezer: Any, logger: logging.Logger | None = None):
        self.deezer = deezer
        self.logger = logger or logging.getLogger(__name__)
        self._cache: dict[tuple[str, str], tuple[str | None, int | None, list[tuple[str, str]]]] = {}
        self._lock = threading.Lock()

    def album_id(self, artist: str, album: str | None, title: str | None, isrc: str | None) -> Any:
        if isrc:
            try:
                track = self.deezer.fetch_track_by_isrc(isrc)
            except ValueError:
                track = None
            if track and (track.get("album") or {}).get("id") is not None:
                return track["album"]["id"]
        # Fielded search can return no rows while plain text works. The exact
        # title/artist check below keeps the fallback from accepting another album.
        if album:
            for query in (f'artist:"{artist}" album:"{album}"', f"{artist} {album}"):
                for row in self.deezer.search_albums(query):
                    if norm(row.get("title")) == norm(album) and same_artist((row.get("artist") or {}).get("name"), artist):
                        return row.get("id")
        if title:
            for query in (f'artist:"{artist}" track:"{title}"', f"{artist} {title}"):
                for row in self.deezer.search_tracks_raw(query):
                    if norm(row.get("title")) == norm(title) and same_artist((row.get("artist") or {}).get("name"), artist):
                        return (row.get("album") or {}).get("id")
        return None

    def lookup(
        self, artist: str | None, album: str | None, title: str | None = None, isrc: str | None = None
    ) -> tuple[str | None, int | None, list[tuple[str, str]]]:
        """(tag value, release year, (es, en) pairs) — or Nones when unknown."""
        if not artist or not (album or title):
            return None, None, []
        key = (norm(artist), norm(album or title))
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        try:
            album_id = self.album_id(artist, album, title, isrc)
            if album_id is None:
                answer: tuple[str | None, int | None, list[tuple[str, str]]] = (None, None, [])
            else:
                pairs, year = self.deezer.fetch_album_tags(album_id)
                answer = (tag_value(pairs), year, pairs)
        except Exception as e:  # noqa: BLE001 — an enrichment never fails a download
            self.logger.info("Genre lookup failed for %s — %s: %s", artist, album or title, e)
            return None, None, []
        with self._lock:
            self._cache[key] = answer
        return answer


def fill_tracks(tracks: list[dict[str, Any]], isrcs: list[str | None], lookup: AlbumGenres) -> int:
    """Set ``genre``/``year`` on the engine's track dicts that lack them. Returns how many got a genre."""
    filled = 0
    for track, isrc in zip(tracks, isrcs, strict=False):
        if track.get("genre") and track.get("year"):
            continue
        genre, year, _ = lookup.lookup(track.get("artist"), track.get("album"), track.get("name"), isrc)
        if genre and not track.get("genre"):
            track["genre"] = genre
            filled += 1
        if year and not track.get("year"):
            track["year"] = year
    return filled
