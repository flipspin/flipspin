"""Map Deezer responses to browse models and cache assembled pages.

The cache is a bounded map by entity, rather than a single dashboard snapshot,
so revisiting pages saves quota without unbounded startup reads.
"""
import copy
import json
import os
import threading
from datetime import datetime, UTC
from pathlib import Path
from typing import Any
from collections.abc import Callable

from app.config import KROBI_HOME
from app.infra.files import write_json_atomic
from app.domains.browse.models import (
    AlbumPage,
    ArtistPage,
    BrowseAlbum,
    BrowseArtist,
    BrowseGenre,
    BrowsePlaylist,
    BrowseTrack,
    GenrePage,
    PlaylistPage,
    ProviderRef,
    SearchResults,
)
from app.utils.images import FULL_IMAGE_SIDE as FULL_IMAGE_SIDE, full_size_image_url as full_size_image_url
from app.exceptions import ExternalAPIError

DEEZER_PROVIDER_ID = "deezer"
DEEZER_PROVIDER_NAME = "Deezer"

DEFAULT_CACHE_FILENAME = "browse-cache.json"

# How many entity pages to keep. ~200 albums of ~15 tracks is a file in the low
# single-digit MB, which is cheap to read at startup and sufficient for a shared library
# library. The bound matters more than the exact number.
DEFAULT_MAX_ENTRIES = 200

DEFAULT_TOP_TRACKS = 10
DEFAULT_RELATED = 12
DEFAULT_ARTIST_ALBUMS = 50
DEFAULT_SEARCH_LIMIT = 20


def default_cache_path() -> Path:
    """Where the browse cache lives.

    Same reasoning as the dashboard's: not under ``config.temp_dir``, which
    is swept. A cache that is deleted between runs is not a cache, it is a
    slower first request.
    """
    override = os.getenv("KROBI_BROWSE_CACHE_FILE")
    if override and override.strip():
        return Path(override.strip()).expanduser()
    return KROBI_HOME / DEFAULT_CACHE_FILENAME


# `_first_url` and `_artist_name` are deliberate near-copies of the two helpers
# in domains/dashboard/repositories.py. They are six-line pure functions over
# Deezer's response shape, and having `browse` import from `dashboard` would
# couple two sibling domains together for them — a worse trade than the
# duplication. If a third domain needs them, they move to app/utils/.
def _first_url(raw: dict[str, Any], *keys: str) -> str | None:
    """First non-empty string among ``keys``. Walks an image-size ladder."""
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _nested(raw: dict[str, Any], key: str) -> dict[str, Any]:
    value = raw.get(key)
    return value if isinstance(value, dict) else {}


def _text(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _ref(raw: dict[str, Any]) -> ProviderRef | None:
    """A ProviderRef from any Deezer entity dict, or None if it has no id."""
    entity_id = raw.get("id")
    if entity_id is None:
        return None
    text = str(entity_id).strip()
    if not text:
        return None
    return ProviderRef(provider=DEEZER_PROVIDER_ID, id=text, url=_first_url(raw, "link"))


# Prefer 500px covers for high-density cards without full-size payload cost.
# Embedded artwork uses full_size_image_url instead of this display ladder.
# See docs/DEVELOPER_GUIDE.md#provider-request-budgets.
_COVER_KEYS = ("cover_big", "cover_xl", "cover_medium", "cover", "cover_small")
_PICTURE_KEYS = ("picture_big", "picture_xl", "picture_medium", "picture", "picture_small")



class DeezerBrowseProvider:
    """Adapts :class:`DeezerRepository` to catalog navigation.

    Holds no state beyond its collaborators. Every method raises
    :class:`ExternalAPIError` on a provider failure rather than returning a
    sentinel — deciding whether a failed section blanks a page or degrades it
    is the service's policy, not the mapper's.
    """

    provider_id = DEEZER_PROVIDER_ID
    provider_name = DEEZER_PROVIDER_NAME

    def __init__(self, deezer, logger):
        # The *shared* DeezerRepository, injected. Constructing one here would
        # give the process a second rate limiter against a single per-IP quota,
        # and a quota breach arrives as HTTP 200 with {"error":{"code":4}} — so
        # the symptom would be silent, intermittently empty pages.
        self.deezer = deezer
        self.logger = logger

    # --------------------------------------------------------------- mapping

    @classmethod
    def artist_from(cls, raw: Any) -> BrowseArtist | None:
        if not isinstance(raw, dict):
            return None
        ref = _ref(raw)
        name = _text(raw, "name")
        if ref is None or not name:
            return None
        return BrowseArtist(
            ref=ref,
            name=name,
            image_url=_first_url(raw, *_PICTURE_KEYS),
            fan_count=_int(raw.get("nb_fan")),
            album_count=_int(raw.get("nb_album")),
        )

    @classmethod
    def album_from(cls, raw: Any) -> BrowseAlbum | None:
        if not isinstance(raw, dict):
            return None
        ref = _ref(raw)
        title = _text(raw, "title")
        if ref is None or not title:
            return None
        artist_raw = _nested(raw, "artist")
        genres = [
            name
            for name in (
                _text(g, "name") for g in _nested(raw, "genres").get("data", []) if isinstance(g, dict)
            )
            if name
        ]
        return BrowseAlbum(
            ref=ref,
            title=title,
            artist_name=_text(artist_raw, "name"),
            artist_ref=_ref(artist_raw) if artist_raw else None,
            cover_url=_first_url(raw, *_COVER_KEYS),
            release_date=_text(raw, "release_date"),
            record_type=_text(raw, "record_type"),
            track_count=_int(raw.get("nb_tracks")),
            label=_text(raw, "label"),
            genres=genres,
        )

    @classmethod
    def track_from(cls, raw: Any, album: BrowseAlbum | None = None) -> BrowseTrack | None:
        """Map one track row.

        ``album`` is the page's album, passed in when mapping an album
        tracklist: rows from ``/album/{id}/tracks`` carry no ``album`` object of
        their own, and a track that does not know its album cannot be filed into
        the right folder or have a cover embedded.
        """
        if not isinstance(raw, dict):
            return None
        ref = _ref(raw)
        title = _text(raw, "title")
        if ref is None or not title:
            return None

        artist_raw = _nested(raw, "artist")
        album_raw = _nested(raw, "album")

        album_title = _text(album_raw, "title") or (album.title if album else None)
        album_ref = _ref(album_raw) if album_raw else (album.ref if album else None)
        cover = _first_url(album_raw, *_COVER_KEYS) if album_raw else None
        if not cover and album is not None:
            cover = album.cover_url

        duration = raw.get("duration")
        return BrowseTrack(
            ref=ref,
            title=title,
            artist_name=_text(artist_raw, "name") or (album.artist_name if album else None),
            artist_ref=_ref(artist_raw) if artist_raw else None,
            album_title=album_title,
            album_ref=album_ref,
            cover_url=cover,
            # Deezer's `duration` is already SECONDS. Converting it here would
            # silently disarm DURATION_VETO_S downstream.
            duration_s=float(duration) if isinstance(duration, (int, float)) else None,
            track_position=_int(raw.get("track_position")),
            disc_number=_int(raw.get("disk_number")),
            isrc=(_text(raw, "isrc") or "").upper() or None,
            preview_url=_first_url(raw, "preview"),
            explicit=bool(raw.get("explicit_lyrics")),
        )

    @classmethod
    def playlist_from(cls, raw: Any) -> BrowsePlaylist | None:
        if not isinstance(raw, dict):
            return None
        ref = _ref(raw)
        title = _text(raw, "title")
        if ref is None or not title:
            return None
        creator = _nested(raw, "creator") or _nested(raw, "user")
        return BrowsePlaylist(
            ref=ref,
            title=title,
            owner=_text(creator, "name"),
            picture_url=_first_url(raw, *_PICTURE_KEYS),
            track_count=_int(raw.get("nb_tracks")),
            description=_text(raw, "description"),
        )

    @classmethod
    def genre_from(cls, raw: Any) -> BrowseGenre | None:
        if not isinstance(raw, dict):
            return None
        ref = _ref(raw)
        name = _text(raw, "name")
        # Id 0 is Deezer's "All": the whole chart, not a genre.
        if ref is None or not name or ref.id == "0":
            return None
        return BrowseGenre(ref=ref, name=name, image_url=_first_url(raw, *_PICTURE_KEYS))

    @staticmethod
    def _mapped(rows: Any, factory) -> list[Any]:
        if not isinstance(rows, list):
            return []
        out = []
        for row in rows:
            built = factory(row)
            if built is not None:
                out.append(built)
        return out

    # ----------------------------------------------------------------- fetch

    def fetch_album_page(self, album_id: str) -> AlbumPage:
        """Album header plus its real tracklist. Two requests, by necessity.

        The header response inlines a ``tracks.data`` array that is *not* used:
        it omits ISRC, track position and disc number. See
        ``DeezerRepository.fetch_album_tracks`` for the measurement.
        """
        header = self.deezer.fetch_album(album_id)
        album = self.album_from(header)
        if album is None:
            raise ExternalAPIError(
                f"Deezer returned no usable album for id {album_id}",
                api_name=DEEZER_PROVIDER_ID,
                details={"album_id": album_id},
            )
        rows = self.deezer.fetch_album_tracks(album_id)
        tracks = [t for t in (self.track_from(r, album=album) for r in rows) if t is not None]
        tracks.sort(key=lambda t: (t.disc_number or 1, t.track_position or 0))
        return AlbumPage(album=album, tracks=tracks)

    def fetch_playlist_page(self, playlist_id: str) -> PlaylistPage:
        """Playlist header and tracks. One request — Deezer inlines them here.

        Unlike an album's inline array, a playlist's tracks *do* carry ISRC, so
        there is nothing to escalate to.
        """
        payload = self.deezer.fetch_playlist(playlist_id)
        playlist = self.playlist_from(payload)
        if playlist is None:
            raise ExternalAPIError(
                f"Deezer returned no usable playlist for id {playlist_id}",
                api_name=DEEZER_PROVIDER_ID,
                details={"playlist_id": playlist_id},
            )
        rows = _nested(payload, "tracks").get("data")
        return PlaylistPage(playlist=playlist, tracks=self._mapped(rows, self.track_from))

    def fetch_genre_page(self, genre_id: str) -> GenrePage:
        """A genre's name and picture plus its chart. Two requests."""
        genre = self.genre_from(self.deezer.fetch_genre(genre_id))
        if genre is None:
            raise ExternalAPIError(
                f"Deezer returned no usable genre for id {genre_id}",
                api_name=DEEZER_PROVIDER_ID,
                details={"genre_id": genre_id},
            )
        chart = self.deezer.fetch_chart(limit=20, genre_id=genre_id)
        return GenrePage(
            genre=genre,
            tracks=self._mapped(_nested(chart, "tracks").get("data"), self.track_from),
            albums=self._mapped(_nested(chart, "albums").get("data"), self.album_from),
            artists=self._mapped(_nested(chart, "artists").get("data"), self.artist_from),
            playlists=self._mapped(_nested(chart, "playlists").get("data"), self.playlist_from),
        )

    def fetch_artist_page(self, artist_id: str, sections: tuple[str, ...]) -> ArtistPage:
        """Artist header plus whichever ``sections`` were asked for.

        One request for the header, one per section. A section that fails is
        recorded in ``partial`` and leaves the others intact — an artist page
        missing its related-artists row is far better than an error page, and
        the UI can say which part is missing rather than implying the artist has
        no albums.
        """
        artist = self.artist_from(self.deezer.fetch_artist(artist_id))
        if artist is None:
            raise ExternalAPIError(
                f"Deezer returned no usable artist for id {artist_id}",
                api_name=DEEZER_PROVIDER_ID,
                details={"artist_id": artist_id},
            )

        loaders: dict[str, Callable[[], Any]] = {
            "top": lambda: self._mapped(
                self.deezer.fetch_artist_top(artist_id, limit=DEFAULT_TOP_TRACKS), self.track_from
            ),
            "albums": lambda: self._mapped(
                self.deezer.fetch_artist_albums(artist_id, limit=DEFAULT_ARTIST_ALBUMS), self.album_from
            ),
            "related": lambda: self._mapped(
                self.deezer.fetch_artist_related(artist_id, limit=DEFAULT_RELATED), self.artist_from
            ),
            "playlists": lambda: self._mapped(
                self.deezer.fetch_artist_playlists(artist_id, limit=DEFAULT_RELATED), self.playlist_from
            ),
        }

        gathered: dict[str, list[Any]] = {}
        partial: list[str] = []
        for name in sections:
            loader = loaders.get(name)
            if loader is None:
                continue
            try:
                gathered[name] = loader()
            except ExternalAPIError as e:
                self.logger.warning("Artist %s section %r failed: %s", artist_id, name, e.message)
                partial.append(name)

        return ArtistPage(
            artist=artist,
            top_tracks=gathered.get("top", []),
            albums=gathered.get("albums", []),
            related=gathered.get("related", []),
            playlists=gathered.get("playlists", []),
            partial=partial,
        )

    def search_autocomplete(
        self, query: str, categories: tuple[str, ...], limit: int = DEFAULT_SEARCH_LIMIT
    ) -> SearchResults:
        """One combined call. Fall back if the undocumented endpoint changes."""
        factories = {"artists": self.artist_from, "albums": self.album_from,
                     "tracks": self.track_from, "playlists": self.playlist_from}
        try:
            payload = self.deezer.search_autocomplete(query, limit=limit)
            if not isinstance(payload, dict):
                raise ValueError("Invalid autocomplete envelope")
            # Accept combined list envelopes and typed flat rows. Validate every
            # requested section so a shape change cannot silently look empty.
            if isinstance(payload.get("data"), list):
                raw = {name: [] for name in categories}
                kinds = {"artist": "artists", "album": "albums", "track": "tracks", "playlist": "playlists"}
                for row in payload["data"]:
                    if not isinstance(row, dict) or row.get("type") not in kinds:
                        raise ValueError("Unknown autocomplete row")
                    name = kinds[row["type"]]
                    if name in raw:
                        raw[name].append(row)
            else:
                raw = {}
                for name in categories:
                    section = payload.get(name)
                    rows = section.get("data") if isinstance(section, dict) else section
                    if not isinstance(rows, list):
                        raise ValueError(f"Missing autocomplete section: {name}")
                    raw[name] = rows
            gathered = {name: self._mapped(rows[:limit], factories[name]) for name, rows in raw.items()}
            return SearchResults(query=query, requested=list(categories), **gathered)
        except (ExternalAPIError, ValueError) as exc:
            self.logger.info("Autocomplete unavailable; using full search: %s", exc)
            return self.search_catalog(query, categories, limit=limit)

    def search_catalog(
        self, query: str, categories: tuple[str, ...], limit: int = DEFAULT_SEARCH_LIMIT
    ) -> SearchResults:
        """Search once per requested category without per-result enrichment.

        ISRC enrichment belongs to acquisition; browsing must keep its request budget
        bounded. The protocol method name lets adapters delegate directly.
        """
        factories = {
            "artists": ("artist", self.artist_from),
            "albums": ("album", self.album_from),
            "tracks": ("track", self.track_from),
            "playlists": ("playlist", self.playlist_from),
        }
        gathered: dict[str, list[Any]] = {}
        failed: list[str] = []
        for name in categories:
            spec = factories.get(name)
            if spec is None:
                continue
            entity, factory = spec
            try:
                gathered[name] = self._mapped(
                    self.deezer.search_entities(entity, query, limit=limit), factory
                )
            except ExternalAPIError as e:
                self.logger.warning("Search %r category %r failed: %s", query, name, e.message)
                failed.append(name)

        return SearchResults(
            query=query,
            artists=gathered.get("artists", []),
            albums=gathered.get("albums", []),
            tracks=gathered.get("tracks", []),
            playlists=gathered.get("playlists", []),
            requested=list(categories),
            failed=failed,
        )


class BrowseCacheRepository:
    """Bounded, keyed, on-disk cache of assembled browse pages.

    Never raises: a corrupt or unreadable cache degrades to a cache miss, which
    costs a request. Raising would mean one bad file makes browsing impossible
    until a human deletes it.
    """

    def __init__(self, config, logger, cache_path: Path | None = None, max_entries: int = DEFAULT_MAX_ENTRIES):
        self.config = config
        self.logger = logger
        self.cache_path = cache_path or default_cache_path()
        self.max_entries = max(1, int(max_entries))
        self._lock = threading.Lock()
        # The parsed file, kept between calls: at 200 entries the file is
        # ~600 KB, and parsing it on every lookup (and twice per save) cost
        # more than the page it was caching. Re-read only when the file's
        # mtime moves, which is how another process's write is noticed.
        self._entries: dict[str, Any] | None = None
        self._entries_mtime_ns: int | None = None

    @staticmethod
    def key(kind: str, provider: str, entity_id: str) -> str:
        return f"{kind}:{provider}:{entity_id}"

    def _read(self) -> dict[str, Any]:
        """The entries dict, parsed at most once per on-disk version. Caller holds the lock."""
        try:
            mtime_ns = self.cache_path.stat().st_mtime_ns
        except FileNotFoundError:
            self._entries, self._entries_mtime_ns = {}, None
            return self._entries
        except OSError as e:
            self.logger.warning("Unreadable browse cache at %s (%s); ignoring it", self.cache_path, e)
            return {}
        if self._entries is not None and self._entries_mtime_ns == mtime_ns:
            return self._entries
        try:
            with self.cache_path.open("r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except FileNotFoundError:
            self._entries, self._entries_mtime_ns = {}, None
            return self._entries
        except (OSError, json.JSONDecodeError) as e:
            self.logger.warning("Unreadable browse cache at %s (%s); ignoring it", self.cache_path, e)
            return {}
        entries = payload.get("entries") if isinstance(payload, dict) else None
        self._entries = entries if isinstance(entries, dict) else {}
        self._entries_mtime_ns = mtime_ns
        return self._entries

    def load(self, key: str, max_age_s: float) -> dict[str, Any] | None:
        """The cached payload for ``key``, or None if absent or stale."""
        with self._lock:
            entry = self._read().get(key)
        if not isinstance(entry, dict):
            return None
        stored_at = entry.get("storedAt")
        try:
            when = datetime.fromisoformat(str(stored_at).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        age = (datetime.now(UTC) - when).total_seconds()
        # A future-dated entry means a clock moved; do not trust it forever.
        if age < 0 or age > max_age_s:
            return None
        payload = entry.get("payload")
        # A copy: the dict is the in-memory cache itself, and a caller that
        # decorates the page it got must not decorate the cache.
        return copy.deepcopy(payload) if isinstance(payload, dict) else None

    def save(self, key: str, payload: dict[str, Any]) -> bool:
        """Store ``payload`` under ``key``, evicting the oldest over the bound."""
        with self._lock:
            entries = self._read()
            entries[key] = {
                "storedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "payload": payload,
            }
            if len(entries) > self.max_entries:
                ordered = sorted(entries.items(), key=lambda kv: str(kv[1].get("storedAt") or ""))
                for stale_key, _ in ordered[: len(entries) - self.max_entries]:
                    entries.pop(stale_key, None)
            try:
                # Atomic: a half-written cache read by the next process start
                # would look like corruption rather than a missing entry.
                write_json_atomic(self.cache_path, {"entries": entries}, indent=None)
                self._entries = entries
                try:
                    self._entries_mtime_ns = self.cache_path.stat().st_mtime_ns
                except OSError:
                    self._entries_mtime_ns = None
                return True
            except OSError as e:
                self.logger.warning("Could not persist browse cache to %s: %s", self.cache_path, e)
                return False


__all__ = [
    "DEEZER_PROVIDER_ID",
    "DEEZER_PROVIDER_NAME",
    "FULL_IMAGE_SIDE",
    "BrowseCacheRepository",
    "DeezerBrowseProvider",
    "default_cache_path",
    "full_size_image_url",
]
