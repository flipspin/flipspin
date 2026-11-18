"""Build catalog recommendations from artists in the personal library.

Exclude owned albums at build and serve time; require exact normalized artists.
See docs/DEVELOPER_GUIDE.md#dashboard-caching.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from app.domains.dashboard.models import DashboardItem
from app.domains.dashboard.repositories import _first_url
from app.domains.metadata.normalization import (
    fold_accents,
    move_leading_article,
    normalize_key,
    strip_noise,
)

ROW_ID = "more-from-your-artists"
# The renderer maps the id to its own Spanish label; this is the fallback.
ROW_TITLE = "More from your artists"
ROW_KIND = "album"

#: Artists actually resolved and asked for albums, per refresh.
MAX_ARTISTS = 6
#: Of those, picked by size in the library...
TOP_ARTISTS = 4
#: ...and by how recently something of theirs arrived.
RECENT_ARTISTS = 2
#: Hard ceiling on Deezer requests per refresh, searches included.
MAX_REQUESTS = 14
#: Cards per artist, so one prolific artist cannot fill the row alone.
ALBUMS_PER_ARTIST = 4
#: Cards in the row, matching the chart rows.
ROW_LIMIT = 20
SEARCH_LIMIT = 5
DISCOGRAPHY_LIMIT = 50

#: Deezer ``record_type`` values worth recommending. Singles are one song —
#: usually one the library already has from the album — and "compile" is a
#: label compilation, not the artist's own record.
RECOMMENDED_RECORD_TYPES = ("album", "ep")

#: Placeholder credits that are not an artist anyone collects.
_IGNORED_ARTIST_KEYS = frozenset({
    "", "unknown", "unknownartist", "artistadesconocido", "desconocido",
    "various", "variousartists", "va", "variosartistas", "varios",
})

# Separators that split a collaboration credit. The full credit is always
# tried first, so "Earth, Wind & Fire" still resolves as itself.
_COLLAB_SPLIT = re.compile(
    r"\s*(?:,|;|/|&|\+|\s(?:x|y|and|feat\.?|ft\.?|featuring|with)\s)\s*",
    re.IGNORECASE,
)

# Album packaging that does not make it a different record. Bracketed only, so
# a title that *is* "Special" survives.
_ALBUM_PACKAGING = re.compile(
    r"[\(\[][^\)\]]*\b(?:edition|version|explicit|clean|deluxe|expanded|"
    r"remaster(?:ed)?|bonus|special|collector'?s?|anniversary|reissue)\b[^\)\]]*[\)\]]",
    re.IGNORECASE,
)


class _BudgetSpent(Exception):
    """The per-refresh request ceiling was reached."""


def artist_key(name: str | None) -> str:
    """Identity key for an artist credit. ``feat.`` tails and articles fold away."""
    return normalize_key(name or "", "")


def catalog_name_key(name: str | None) -> str:
    """Strict key for comparing a *catalog* artist name with the one searched.

    Unlike :func:`artist_key` this strips nothing but case, accents, articles
    and punctuation: a search result named "X feat. Y Tribute Band" must not
    collapse to "X" and pass as an exact match.
    """
    folded = fold_accents(move_leading_article(name or "")).lower()
    return re.sub(r"[^a-z0-9]", "", folded)


def primary_credit(name: str | None) -> str:
    """The first name in a collaboration credit: ``"A & B"`` -> ``"A"``."""
    text = strip_noise(name or "")
    parts = [part.strip() for part in _COLLAB_SPLIT.split(text) if part and part.strip()]
    return parts[0] if parts else text.strip()


def album_title_key(title: str | None) -> str:
    """Identity key for an album title, packaging noise removed."""
    cleaned = _ALBUM_PACKAGING.sub(" ", strip_noise(title or ""))
    return normalize_key("", cleaned)


@dataclass
class LibraryArtist:
    """One artist as the library knows them."""

    key: str
    name: str
    album_count: int = 0
    track_count: int = 0
    latest_added: float = 0.0


@dataclass
class LibraryView:
    """What the row needs from the library: who is in it, and what they own."""

    artists: list[LibraryArtist] = field(default_factory=list)
    #: (artist key, album title key) pairs, for every spelling of the artist.
    owned_albums: set[tuple[str, str]] = field(default_factory=set)

    def owns(self, artist_keys: set[str], title: str | None) -> bool:
        title_key = album_title_key(title)
        if not title_key:
            return False
        return any((key, title_key) in self.owned_albums for key in artist_keys if key)


def read_library(albums: list[Any]) -> LibraryView:
    """Fold scanned albums into artists and owned-album keys.

    ``albums`` is ``MusicRepository.scan_albums()`` output: each album has
    ``name``, ``artist`` and ``tracks`` (``title``, ``artist``, ``date_added``).
    """
    by_key: dict[str, LibraryArtist] = {}
    owned: set[tuple[str, str]] = set()

    for album in albums:
        album_artist = (getattr(album, "artist", None) or "").strip()
        tracks = list(getattr(album, "tracks", None) or [])
        title_key = album_title_key(getattr(album, "name", None))

        # Every credit on the album owns its title, so "A feat. B" on one song
        # still protects A's album from being recommended back to them.
        credits = {album_artist, *((getattr(t, "artist", None) or "").strip() for t in tracks)}
        if title_key:
            for credit in credits:
                for key in (artist_key(credit), artist_key(primary_credit(credit))):
                    if key and key not in _IGNORED_ARTIST_KEYS:
                        owned.add((key, title_key))

        key = artist_key(album_artist)
        if key in _IGNORED_ARTIST_KEYS:
            continue
        entry = by_key.get(key)
        if entry is None:
            entry = by_key[key] = LibraryArtist(key=key, name=album_artist)
        elif album_artist < entry.name:
            # Several spellings of one artist: keep a deterministic one.
            entry.name = album_artist
        entry.album_count += 1
        entry.track_count += len(tracks)
        for track in tracks:
            added = getattr(track, "date_added", None)
            if isinstance(added, (int, float)) and added > entry.latest_added:
                entry.latest_added = float(added)

    return LibraryView(artists=list(by_key.values()), owned_albums=owned)


def pick_artists(artists: list[LibraryArtist]) -> list[LibraryArtist]:
    """Every artist, in the order they should be tried.

    The first :data:`TOP_ARTISTS` by size, then the :data:`RECENT_ARTISTS`
    newest arrivals not already chosen, then everyone else by size — the tail
    is only reached when earlier artists fail to match in the catalog.
    Ties break on the key, so the order is a pure function of the library.
    """
    by_size = sorted(artists, key=lambda a: (-a.album_count, -a.track_count, a.key))
    by_recency = sorted(artists, key=lambda a: (-a.latest_added, a.key))

    ordered: list[LibraryArtist] = []
    seen: set[str] = set()

    def take(candidates: list[LibraryArtist], count: int | None) -> None:
        taken = 0
        for artist in candidates:
            if count is not None and taken >= count:
                return
            if artist.key in seen:
                continue
            seen.add(artist.key)
            ordered.append(artist)
            taken += 1

    take(by_size, TOP_ARTISTS)
    take(by_recency, RECENT_ARTISTS)
    take(by_size, None)
    return ordered


class YourArtistsSource:
    """Builds the "More from your artists" row from the library and Deezer."""

    def __init__(self, deezer, music_repository, logger: logging.Logger, max_requests: int = MAX_REQUESTS):
        """
        Args:
            deezer: the process's one ``DeezerRepository`` (shared rate limiter
                and quota backoff — never construct a second).
            music_repository: the shared ``MusicRepository``. Its
                ``scan_albums()`` reads ``config.base_music_dir`` at call time
                and is memoized against the library's shape.
            logger: logger instance.
            max_requests: per-refresh Deezer request ceiling.
        """
        self.deezer = deezer
        self.music = music_repository
        self.logger = logger
        self.max_requests = max(0, int(max_requests))

    # ------------------------------------------------------------------ public

    def library(self) -> LibraryView:
        return read_library(self.music.scan_albums())

    def fetch_items(self) -> list[DashboardItem]:
        """The row's cards. ``[]`` is an honest answer (nothing to recommend).

        Raises the provider's exception only when the catalog failed before a
        single artist could be resolved — then the row is an error (or the
        previous copy, stale), not an empty shelf that hides an outage.
        """
        library = self.library()
        if not library.artists:
            return []

        requests_made = 0
        first_error: Exception | None = None
        resolved: list[tuple[LibraryArtist, dict[str, Any], list[DashboardItem]]] = []

        def call(fn, *args, **kwargs):
            nonlocal requests_made
            if requests_made >= self.max_requests:
                raise _BudgetSpent()
            requests_made += 1
            return fn(*args, **kwargs)

        for artist in pick_artists(library.artists):
            if len(resolved) >= MAX_ARTISTS:
                break
            try:
                match = self._resolve(artist, call)
                if match is None:
                    continue
                rows = call(self.deezer.fetch_artist_albums, match["id"], limit=DISCOGRAPHY_LIMIT)
            except _BudgetSpent:
                break
            except Exception as e:  # ExternalAPIError, quota, network
                # A throttled or failing provider is not asked again in this
                # refresh: every further call would only deepen the quota hole.
                first_error = e
                self.logger.warning("«Más de tus artistas»: catalog lookup stopped at %r: %s", artist.name, e)
                break
            items = self._recommend(artist, match, rows, library)
            resolved.append((artist, match, items))

        if not resolved and first_error is not None:
            raise first_error

        self.logger.info(
            "«Más de tus artistas»: %d artists resolved in %d Deezer requests",
            len(resolved), requests_made,
        )
        return self._interleave([items for _artist, _match, items in resolved])

    def drop_owned(self, items: list[DashboardItem]) -> list[DashboardItem]:
        """Exclude albums already in the current library from a cached row."""
        if not items:
            return items
        library = self.library()
        return [
            item for item in items
            if not library.owns(self._keys_for(item.subtitle), item.title)
        ]

    # ----------------------------------------------------------------- private

    def _resolve(self, artist: LibraryArtist, call) -> dict[str, Any] | None:
        """The catalog artist whose normalized name equals this one, else None."""
        # The credit without its "feat." tail is what the catalog calls them.
        queries = [strip_noise(artist.name) or artist.name]
        primary = primary_credit(artist.name)
        if catalog_name_key(primary) and catalog_name_key(primary) != catalog_name_key(queries[0]):
            queries.append(primary)
        for query in queries:
            wanted = catalog_name_key(query)
            if not wanted:
                continue
            rows = call(self.deezer.search_entities, "artist", query, limit=SEARCH_LIMIT)
            for row in rows or []:
                if not isinstance(row, dict) or row.get("id") is None:
                    continue
                name = row.get("name")
                if isinstance(name, str) and catalog_name_key(name) == wanted:
                    return row
        self.logger.debug("«Más de tus artistas»: no exact catalog match for %r", artist.name)
        return None

    @staticmethod
    def _keys_for(*names: str | None) -> set[str]:
        keys: set[str] = set()
        for name in names:
            if name:
                keys.add(artist_key(name))
                keys.add(artist_key(primary_credit(name)))
        keys.discard("")
        return keys

    def _recommend(
        self,
        artist: LibraryArtist,
        match: dict[str, Any],
        rows: list[Any],
        library: LibraryView,
    ) -> list[DashboardItem]:
        """This artist's catalog albums the library lacks, newest first."""
        catalog_name = str(match.get("name") or artist.name).strip()
        keys = self._keys_for(artist.name, catalog_name)

        albums = [
            row for row in rows or []
            if isinstance(row, dict)
            and row.get("id") is not None
            and isinstance(row.get("title"), str) and row["title"].strip()
            and str(row.get("record_type") or "album").lower() in RECOMMENDED_RECORD_TYPES
        ]
        # Newest first; the id breaks ties so equal dates keep one order.
        albums.sort(key=lambda r: (str(r.get("release_date") or ""), str(r.get("id"))), reverse=True)

        items: list[DashboardItem] = []
        seen_titles: set[str] = set()
        for row in albums:
            title = row["title"].strip()
            title_key = album_title_key(title)
            if not title_key or title_key in seen_titles:
                continue  # the clean twin of an explicit album, a reissue...
            seen_titles.add(title_key)
            if library.owns(keys, title):
                continue
            items.append(DashboardItem(
                id=str(row["id"]),
                title=title,
                # The reason the card is here: it is by an artist you have.
                subtitle=catalog_name,
                image_url=_first_url(row, "cover_big", "cover_xl", "cover_medium", "cover", "cover_small"),
                provider_url=_first_url(row, "link"),
            ))
            if len(items) >= ALBUMS_PER_ARTIST:
                break
        return items

    @staticmethod
    def _interleave(per_artist: list[list[DashboardItem]]) -> list[DashboardItem]:
        """Round-robin across artists, so the first screen shows several of them."""
        out: list[DashboardItem] = []
        seen_ids: set[str] = set()
        depth = max((len(items) for items in per_artist), default=0)
        for i in range(depth):
            for items in per_artist:
                if i < len(items) and items[i].id not in seen_ids:
                    seen_ids.add(items[i].id)
                    out.append(items[i])
                    if len(out) >= ROW_LIMIT:
                        return out
        return out


__all__ = [
    "ROW_ID",
    "ROW_KIND",
    "ROW_TITLE",
    "LibraryArtist",
    "LibraryView",
    "YourArtistsSource",
    "album_title_key",
    "artist_key",
    "pick_artists",
    "primary_credit",
    "read_library",
]
