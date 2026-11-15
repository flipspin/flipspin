"""Translate provider shapes while delegating request policy to repositories.

Repositories own Deezer quota envelopes, MusicBrainz pacing and User-Agent,
and source authentication. Adapters convert identities, units, availability,
and sync/async interfaces without duplicating those policies.
"""
from __future__ import annotations


import asyncio
import logging
import re
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from app.infra.http_fetch import safe_get
from app.config import ConfigManager
from app.domains.metadata.matching import Candidate, WantedTrack
from app.providers.registry import Capability, ProviderDescriptor, ProviderKind, ProviderRegistry

_LOGGER = logging.getLogger(__name__)


# ------------------------------------------------------------------ descriptors
#
# ``id`` values are persisted in ~/Krobi/providers.json. Renaming one resets that
# provider's position and toggle for every existing user, so they are frozen.

DEEZER = ProviderDescriptor(
    id="deezer",
    kind=ProviderKind.METADATA,
    name="Deezer",
    description="Fast unauthenticated search, returns ISRCs",
    # Deezer backs catalog browsing as well as resolution. Note what is absent:
    # ARTIST_BIO, because Deezer has no biography endpoint — so an artist page
    # served by Deezer renders no bio section rather than an empty one. That is
    # capability-gating doing its job, not a gap to paper over.
    capabilities=(
        Capability.ISRC,
        Capability.SEARCH_ARTISTS,
        Capability.SEARCH_ALBUMS,
        Capability.SEARCH_TRACKS,
        Capability.SEARCH_PLAYLISTS,
        Capability.ARTIST_DETAILS,
        Capability.ARTIST_TOP,
        Capability.ARTIST_ALBUMS,
        Capability.ARTIST_RELATED,
        Capability.ARTIST_PLAYLISTS,
        Capability.ALBUM_DETAILS,
        Capability.PLAYLIST_DETAILS,
        Capability.GENRE_DETAILS,
    ),
)

DEEZER_DASHBOARD = ProviderDescriptor(
    id="deezer-dashboard",
    kind=ProviderKind.DASHBOARD,
    name="Deezer",
    description="Listas, artistas y álbumes destacados, y novedades",
)

MUSICBRAINZ = ProviderDescriptor(
    id="musicbrainz",
    kind=ProviderKind.METADATA,
    name="MusicBrainz",
    description=(
        "Authoritative recording identity (MBID). Rate limited to one request "
        "per second, so it is asked only when a faster provider was not sure."
    ),
    capabilities=("mbid", "fielded-search"),
)

SPOTIFY = ProviderDescriptor(
    id="spotify",
    kind=ProviderKind.METADATA,
    name="Spotify",
    description="Track search using your Spotify app credentials",
    # Off until asked for: it needs credentials, an authenticated round trip and
    # a token refresh to repeat metadata already supplied by Deezer.
    # Registered anyway so the panel can offer it, and so a household that has
    # Spotify configured can promote it above Deezer if they prefer its catalog.
    enabled_by_default=False,
    requires_credentials=True,
    capabilities=("isrc",),
)

LRCLIB = ProviderDescriptor(
    id="lrclib",
    kind=ProviderKind.LYRICS,
    name="LRCLIB",
    description="Synchronized lyrics from lrclib.net — free, open, no account",
    capabilities=("lyrics", "lyrics:synced"),
)

LYRICSOVH = ProviderDescriptor(
    id="lyricsovh", kind=ProviderKind.LYRICS, name="Lyrics.ovh",
    description="Plain lyrics without timing — sync them to your song, no account required",
    capabilities=("lyrics",),
)

GENIUS = ProviderDescriptor(
    id="genius",
    kind=ProviderKind.LYRICS,
    name="Genius",
    description="Letras sin tiempos: extrae (scraping) páginas de genius.com. Requiere clave y activación explícita.",
    enabled_by_default=False,
    requires_explicit_opt_in=True,
    requires_credentials=True,
    capabilities=("lyrics",),
)

# ------------------------------------------------------------------- metadata


class DeezerMetadataProvider:
    """:class:`MetadataProvider` over ``DeezerRepository``.

    Deezer takes free text and nothing else, so there is no structured variant
    to offer — the whole adapter is a pass-through that exists to give the
    repository a registry-shaped name.
    """

    def __init__(self, repository, logger: logging.Logger | None = None):
        self.repository = repository
        self._logger = logger or logging.getLogger(__name__)
        self._browse = None

    def search_candidates(self, query: str, limit: int = 5) -> list[Candidate]:
        return self.repository.search_candidates(query, limit)

    # ---------------------------------------------------------------- browse
    #
    # Catalog navigation, gated by the capabilities the descriptor declares
    # above. The mapper is built lazily and imported inside the property for
    # the same reason build_default_registry imports the dashboard provider
    # lazily: `app.providers` is imported during startup, and reaching into a
    # domain package at module scope makes the import order load-bearing.

    @property
    def browse(self):
        if self._browse is None:
            from app.domains.browse.repositories import DeezerBrowseProvider

            # Wraps the same repository instance, so browse shares the one
            # rate limiter rather than opening a second path to the quota.
            self._browse = DeezerBrowseProvider(deezer=self.repository, logger=self._logger)
        return self._browse

    def fetch_album_page(self, album_id: str):
        return self.browse.fetch_album_page(album_id)

    def fetch_playlist_page(self, playlist_id: str):
        return self.browse.fetch_playlist_page(playlist_id)

    def fetch_artist_page(self, artist_id: str, sections):
        return self.browse.fetch_artist_page(artist_id, sections)

    def fetch_genre_page(self, genre_id: str):
        return self.browse.fetch_genre_page(genre_id)

    def search_autocomplete(self, query: str, categories, limit: int = 20):
        return self.browse.search_autocomplete(query, categories, limit=limit)

    def search_catalog(self, query: str, categories, limit: int = 20):
        return self.browse.search_catalog(query, categories, limit=limit)


class MusicBrainzMetadataProvider:
    """:class:`MetadataProvider` over ``MusicBrainzRepository``.

    Implements the optional ``search_wanted`` extension, and that is the point
    of the class: MusicBrainz's fielded query
    (``recording:"Get Lucky" AND artist:"Daft Punk"``) scores far more sharply
    than the same words in the general index, and an export gives the matcher no
    duration to corroborate with, so that sharpness is what keeps escalated
    tracks out of the review pile. Flattening every provider to
    ``search_candidates(query)`` would have quietly thrown it away.
    """

    def __init__(self, repository):
        self.repository = repository

    def search_candidates(self, query: str, limit: int = 5) -> list[Candidate]:
        return self.repository.search_candidates(query, limit)

    def search_wanted(self, wanted: WantedTrack, limit: int = 5) -> list[Candidate]:
        return self.repository.search_recordings(wanted.title, wanted.artist, limit)


class SpotifyMetadataProvider:
    """Map Spotify download dictionaries to scoreable metadata candidates.

    Convert duration_ms to seconds so the recording veto works. Preserve ISRC:
    without a recording identifier the matcher cannot accept a STRONG result.
    """

    def __init__(self, repository, config: ConfigManager):
        self.repository = repository
        self.config = config

    def unavailable_reason(self) -> str | None:
        # Read off the live config rather than a cached flag: credentials are
        # entered at runtime in Settings and written to ~/Krobi/.env, so a value
        # captured at construction would keep reporting "not configured" until
        # the backend restarted.
        if not self.config.spotify_client_id or not self.config.spotify_client_secret:
            return (
                "Add your Spotify client ID and secret in Settings to use Spotify "
                "as a metadata source."
            )
        return None

    def search_candidates(self, query: str, limit: int = 5) -> list[Candidate]:
        if not query or not query.strip():
            return []
        candidates: list[Candidate] = []
        for raw in self.repository.search_tracks(query.strip(), limit) or []:
            candidate = self._to_candidate(raw)
            if candidate is not None:
                candidates.append(candidate)
        return candidates

    @staticmethod
    def _to_candidate(raw: Any) -> Candidate | None:
        if not isinstance(raw, dict) or not raw.get("id"):
            return None
        duration_ms = raw.get("duration_ms")
        duration_s = (
            float(duration_ms) / 1000.0
            if isinstance(duration_ms, (int, float)) and duration_ms > 0
            else None
        )
        isrc = raw.get("isrc")
        return Candidate(
            title=(raw.get("name") or "").strip() or "Unknown",
            provider=SPOTIFY.id,
            provider_id=str(raw.get("id")),
            artist=(raw.get("artist") or None),
            album=(raw.get("album") or None),
            duration_s=duration_s,
            isrc=isrc.strip().upper() if isinstance(isrc, str) and isrc.strip() else None,
        )


# --------------------------------------------------------------------- lyrics


class GeniusLyricsProvider:
    """Extract Genius lyrics through its stable data-lyrics-container attribute.

    Content-hashed class names change between builds. An unfamiliar page returns
    None rather than treating navigation text as lyrics. Search stays in the
    repository, which owns credentials and error handling.
    """

    def __init__(
        self, repository, config: ConfigManager, logger: logging.Logger | None = None,
        *, scraping_enabled: Callable[[], bool] = lambda: False,
    ):
        self.repository = repository
        self.config = config
        self.logger = logger or _LOGGER
        self._scraping_enabled = scraping_enabled

    def unavailable_reason(self) -> str | None:
        if not self.config.genius_api_key:
            return "Add a Genius access token in Settings → Sources → Genius to fetch lyrics."
        return None

    def search_lyrics(self, query) -> list:
        """One plain-text candidate from the top search hit, or nothing.

        Genius knows no durations, so the candidate carries none and the
        service's key check (artist + title) is what stands between a wrong
        top hit and the wrong words on disk.
        """
        from app.domains.lyrics.models import LyricsCandidate

        # Check here too: callers of the compatibility method bypass registry dispatch.
        if not self.config.genius_api_key or not self._scraping_enabled():
            return []
        text_query = " ".join(part for part in (query.artist, query.title) if part).strip()
        if not text_query:
            return []
        try:
            hits = self.repository.search_songs(text_query, max_results=1)
            # Genius can omit release labels; retain meaningful remix/live titles.
            if not hits:
                base_title = re.sub(r"\s*[\(\[]album version[\)\]]\s*$", "", query.title, flags=re.I).strip()
                if base_title and base_title != query.title:
                    fallback = " ".join(part for part in (query.artist, base_title) if part).strip()
                    hits = self.repository.search_songs(fallback, max_results=1)
        except Exception as e:  # a dead lyrics provider is never fatal
            self.logger.warning("Genius search for %r failed: %s", text_query, e)
            raise
        hit = hits[0] if hits else None
        url = (hit or {}).get("url") or None
        if not url:
            return []
        lyrics = self._scrape_lyrics(url)
        if not lyrics:
            return []
        return [
            LyricsCandidate(
                provider="genius",
                title=str(hit.get("title") or query.title),
                artist=str(hit.get("artist") or query.artist),
                album=str(hit.get("album") or ""),
                plain_lyrics=lyrics,
                provider_ref=f"genius:{url}",
                url=url,
            )
        ]

    def fetch_lyrics(self, artist: str, title: str) -> str | None:
        """Kept for the old protocol shape; the service uses ``search_lyrics``."""
        from app.domains.lyrics.models import LyricsQuery

        rows = self.search_lyrics(LyricsQuery(title=title, artist=artist))
        return rows[0].plain_lyrics if rows else None

    def _scrape_lyrics(self, song_url: str) -> str | None:
        # Imported here rather than at module scope: bs4 and requests are only
        # needed on this one path, and `app.providers` is imported during
        # startup by the dependency container.
        import requests
        from bs4 import BeautifulSoup

        if not self.config.genius_api_key or not self._scraping_enabled():
            return None
        try:
            response = safe_get(song_url, headers=self.repository.headers, timeout=10)
            response.raise_for_status()
        except requests.RequestException as e:
            self.logger.warning("Genius lyrics fetch failed for %s: %s", song_url, e)
            raise

        soup = BeautifulSoup(response.text, "html.parser")
        containers = soup.select('div[data-lyrics-container="true"]')
        if not containers:
            self.logger.info("No lyrics container on %s (Genius layout changed?)", song_url)
            return None
        # <br> is the line separator inside the container; get_text() alone
        # would run every line of the song together into one paragraph.
        blocks = []
        for container in containers:
            # Genius embeds credits and the song bio inside the lyric container,
            # but explicitly marks those UI fragments as excluded from selection.
            for chrome in reversed(container.select('[data-exclude-from-selection="true"], button, script, style')):
                chrome.decompose()
            for br in container.find_all("br"):
                br.replace_with("\n")
            blocks.append(container.get_text().strip())
        lyrics = "\n\n".join(block for block in blocks if block).strip()
        return lyrics or None


# ------------------------------------------------------------------ streaming


def _run_coroutine(coro):
    """Await ``coro`` from synchronous code, inside an event loop or not.

    ``DownloadRepository.search_source`` is ``async`` because the download path
    is, but the registry's provider interfaces are synchronous — they are called
    from :class:`ResolutionService`, which runs in a worker thread. Calling
    ``asyncio.run`` while a loop is already running on this thread raises, so a
    request handler would blow up in production while every test passed. Running
    it on its own loop in a worker thread costs one thread per call and is
    correct in both worlds.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


class SourceStreamingProvider:
    """Compatibility provider card backed by a supervised SourcePort."""
    def __init__(self, source, options=lambda: {}):
        self.source, self.options = source, options
        self._urls = {}
        self._url_lock = threading.Lock()

    def unavailable_reason(self):
        return None if self.source.ready() else f'{self.source.state}: {self.source.reason}'

    def search_candidates(self, query, limit=5):
        from app.domains.acquisition.matching import split_query
        artist, title = split_query(query)
        return self.search_wanted(WantedTrack(title=title, artist=artist), limit) if query.strip() else []

    def search_wanted(self, wanted, limit=5):
        from app.domains.acquisition.matching import source_candidate
        rows = _run_coroutine(self.source.search(
            {'title': wanted.title, 'artist': wanted.artist or '', 'album': wanted.album,
             'duration': wanted.duration_s}, limit=limit, options=self.options()))
        with self._url_lock:
            self._urls.update({row.get('id') or row['url']: row['url'] for row in rows if row.get('url')})
            while len(self._urls) > 1000:
                del self._urls[next(iter(self._urls))]
        return [candidate for row in rows if (candidate := source_candidate(row, wanted, provider=self.source.id))]

    def resolve_stream(self, candidate_id):
        if not candidate_id:
            raise ValueError('resolve_stream needs a candidate id')
        # Preserve stream URLs for shipped resolution clients and saved ids.
        if candidate_id.startswith(('https://', 'http://')):
            return candidate_id
        with self._url_lock:
            return self._urls.get(candidate_id, candidate_id)


# ------------------------------------------------------------------- assembly


class LrclibLyricsProvider:
    """Return the exact LRCLIB hit first, followed by search candidates.

    Keep near misses visible so users can review duration differences."""

    def __init__(self, repository, logger: logging.Logger | None = None):
        self.repository = repository
        self.logger = logger or _LOGGER

    def unavailable_reason(self) -> str | None:
        return None  # no credentials; if lrclib.net is down the search says so

    def search_lyrics(self, query) -> list:
        rows = []
        seen = set()
        errors = []
        # Either endpoint can fail independently. Keep a successful exact match
        # even when the additional search is throttled, and still try search
        # when exact lookup is unavailable.
        try:
            exact = self.repository.get_exact(query)
            if exact is not None:
                rows.append(exact)
                seen.add(exact.provider_ref)
        except Exception as error:
            errors.append(error)
        try:
            for row in self.repository.search(query):
                if row.provider_ref in seen:
                    continue
                seen.add(row.provider_ref)
                rows.append(row)
        except Exception as error:
            errors.append(error)
        if errors and not rows:
            raise errors[0]
        return rows


def build_default_registry(
    config: ConfigManager,
    logger: logging.Logger | None = None,
    store=None,
    deezer_repo=None,
) -> ProviderRegistry:
    """Register providers in the default order used before saved preferences exist.

    Deezer leads with inexpensive identifiable matches, MusicBrainz follows with
    paced authoritative results, and Spotify requires credentials. Tests pass an
    explicit preference store to avoid writing real settings.
    """
    log = logger or _LOGGER
    if store is None:
        from app.providers.persistence import ProviderPreferenceStore

        store = ProviderPreferenceStore(config.providers_file, log)

    registry = ProviderRegistry(store=store, logger=log)

    from app.domains.metadata.deezer_repository import DeezerRepository
    from app.domains.metadata.musicbrainz_repository import MusicBrainzRepository

    # `deezer_repo` is injected by the container so this shares the ONE
    # DeezerRepository with the dashboard and anything else that talks to
    # Deezer. Constructing a second one here would give the process two
    # independent rate limiters against a single per-IP quota: each would
    # believe it was under the ceiling while their combined traffic was not.
    # That failure is close to invisible, because Deezer answers a quota
    # breach with HTTP 200 and `{"error":{"code":4}}` — nothing raises.
    # MusicBrainz below has no second construction
    # site, so it is still built here.
    registry.register(
        DEEZER,
        DeezerMetadataProvider(deezer_repo or DeezerRepository(config, log), logger=log),
    )
    registry.register(
        MUSICBRAINZ, MusicBrainzMetadataProvider(MusicBrainzRepository(config, log))
    )

    # Registered for *visibility and control*, not for dispatch: the dashboard
    # service composes and caches its own rows, and nothing calls the instance
    # through the registry. Without an entry here the providers panel would
    # show an empty "dashboard" kind while the Explorar page visibly runs on
    # Deezer — the UI would be lying. With it, disabling the row actually stops
    # the outbound requests (see DashboardService._provider_enabled).
    from app.domains.dashboard.repositories import DeezerDashboardProvider

    registry.register(
        DEEZER_DASHBOARD,
        DeezerDashboardProvider(deezer_repo or DeezerRepository(config, log), log),
    )

    from app.domains.metadata.spotify_repository import SpotifyRepository

    registry.register(
        SPOTIFY, SpotifyMetadataProvider(SpotifyRepository(config, log), config)
    )

    # LRCLIB before Genius: a household upgrading from a providers.json that
    # only knew "genius" gets lrclib appended *after* it, and the lyrics
    # service asks every enabled catalog anyway — order only breaks ties.
    from app.domains.lyrics.lrclib_repository import LrclibRepository

    registry.register(LRCLIB, LrclibLyricsProvider(LrclibRepository(config, log), log))

    from app.domains.metadata.repositories import GeniusRepository

    registry.register(GENIUS, GeniusLyricsProvider(
        GeniusRepository(config, log), config, log,
        scraping_enabled=lambda: registry.is_enabled(GENIUS.id),
    ))

    from app.domains.lyrics.plain_provider import LyricsOvhProvider

    registry.register(LYRICSOVH, LyricsOvhProvider())

    from app.domains.acquisition.sources.installed import register_sources

    register_sources(registry, config.playlist_dir.parent, config)

    return registry


def default_descriptors() -> dict[str, ProviderDescriptor]:
    """Every descriptor by id. Handy for tests and for the settings docs.

    DEEZER_DASHBOARD is included: it was omitted originally, which made this
    disagree with what ``build_default_registry`` actually registers, and a
    "every descriptor" helper that quietly misses one is worse than no helper.
    """
    return {
        d.id: d
        for d in (DEEZER, MUSICBRAINZ, DEEZER_DASHBOARD, SPOTIFY, LRCLIB, GENIUS, LYRICSOVH)
    }
