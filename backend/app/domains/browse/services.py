"""Dispatch browse requests through enabled providers by capability and order.

Cache pages by provider identity to avoid repeated quota use. Availability
errors remain distinct from transport failures so clients can offer the right
recovery action.
"""
import logging
import threading
import unicodedata
from concurrent.futures import Future
from typing import Any
from collections.abc import Callable

from app.domains.browse.models import AlbumPage, ArtistPage, GenrePage, PlaylistPage, SearchResults
from app.exceptions import ValidationError
from app.providers.registry import (
    ARTIST_SECTION_CAPABILITIES,
    SEARCH_CATEGORY_CAPABILITIES,
    Capability,
    ProviderKind,
)

# A released album's tracklist is immutable in practice, so a day is a
# conservative TTL rather than an aggressive one. It bounds a heavy browsing
# session to one request per entity per day.
DEFAULT_ENTITY_TTL_S = 24 * 3600.0

# Search is different: a user who repeats a query usually means it, and results
# genuinely move as the catalog changes. Short enough to feel live, long enough
# to absorb the back-button.
DEFAULT_SEARCH_TTL_S = 15 * 60.0

DEFAULT_SEARCH_LIMIT = 20
MAX_SEARCH_LIMIT = 50

ALL_SEARCH_CATEGORIES = tuple(name for name, _ in SEARCH_CATEGORY_CAPABILITIES)


class ProviderUnavailable(Exception):
    """Carry Spanish user-facing errors because clients render them verbatim.

    The provider id remains separate so clients can identify the failed source.
    """

    def __init__(self, message: str, provider_id: str | None = None):
        super().__init__(message)
        self.message = message
        self.provider_id = provider_id


class BrowseService:
    def __init__(
        self,
        registry,
        cache_repo,
        config,
        logger: logging.Logger,
        entity_ttl_s: float = DEFAULT_ENTITY_TTL_S,
        search_ttl_s: float = DEFAULT_SEARCH_TTL_S,
    ):
        self.registry = registry
        self.cache = cache_repo
        self.config = config
        self.logger = logger
        self.entity_ttl_s = entity_ttl_s
        self.search_ttl_s = search_ttl_s
        # Guards the read-then-write around a cache miss so N concurrent opens
        # of the same album issue one fetch, not N. Same reasoning as the
        # dashboard's refresh lock.
        self._lock = threading.Lock()
        self._search_lock = threading.Lock()
        self._search_flights: dict[str, Future[SearchResults]] = {}

    # ------------------------------------------------------------- discovery

    def capabilities_of(self, provider_id: str) -> tuple[str, ...]:
        entry = self.registry.get(provider_id)
        if entry is None:
            return ()
        descriptor, _instance = entry
        return tuple(descriptor.capabilities)

    def _resolve(self, capability: str, provider_id: str | None = None):
        """Resolve an enabled provider that declares the required capability.

        Keep unavailable-provider errors distinct from failed provider requests.
        """
        if provider_id is not None:
            entry = self.registry.get(provider_id)
            if entry is None:
                raise ProviderUnavailable(f"La fuente «{provider_id}» no existe.", provider_id)
            descriptor, instance = entry
            # Capability first. "Genius cannot serve album details" is true
            # whether or not Genius has an API key, and reporting the missing
            # key instead sends the user off to fix something irrelevant.
            if capability not in descriptor.capabilities:
                raise ProviderUnavailable(
                    f"«{descriptor.name}» no puede mostrar esto ({capability}).", provider_id
                )
            if not self.registry.is_enabled(provider_id):
                raise ProviderUnavailable(
                    f"«{descriptor.name}» está desactivada.",
                    provider_id,
                )
            available, reason = self.registry.availability(provider_id)
            if not available:
                raise ProviderUnavailable(reason or f"«{descriptor.name}» no está disponible.", provider_id)
            return descriptor, instance

        for candidate_id in self.registry.order(ProviderKind.METADATA):
            entry = self.registry.get(candidate_id)
            if entry is None:
                continue
            descriptor, instance = entry
            if capability in descriptor.capabilities:
                return descriptor, instance
        raise ProviderUnavailable(f"Ninguna fuente activa puede mostrar esto ({capability}).")

    # ------------------------------------------------------------------ pages

    def get_album(self, provider_id: str, album_id: str, force_refresh: bool = False) -> AlbumPage:
        return self._entity_page(
            kind="album",
            capability=Capability.ALBUM_DETAILS,
            provider_id=provider_id,
            entity_id=album_id,
            fetch=lambda instance: instance.fetch_album_page(album_id),
            rebuild=AlbumPage.from_dict,
            force_refresh=force_refresh,
        )

    def get_playlist(self, provider_id: str, playlist_id: str, force_refresh: bool = False) -> PlaylistPage:
        return self._entity_page(
            kind="playlist",
            capability=Capability.PLAYLIST_DETAILS,
            provider_id=provider_id,
            entity_id=playlist_id,
            fetch=lambda instance: instance.fetch_playlist_page(playlist_id),
            rebuild=PlaylistPage.from_dict,
            force_refresh=force_refresh,
        )

    def get_genre(self, provider_id: str, genre_id: str, force_refresh: bool = False) -> GenrePage:
        return self._entity_page(
            kind="genre",
            capability=Capability.GENRE_DETAILS,
            provider_id=provider_id,
            entity_id=genre_id,
            fetch=lambda instance: instance.fetch_genre_page(genre_id),
            rebuild=GenrePage.from_dict,
            force_refresh=force_refresh,
        )

    def get_artist(self, provider_id: str, artist_id: str, force_refresh: bool = False) -> ArtistPage:
        descriptor, _instance = self._resolve(Capability.ARTIST_DETAILS, provider_id)
        # Only the sections this provider declared. A provider with no
        # `artist:related` is never asked for related artists, so the page
        # simply has no such section rather than an empty or failed one.
        sections = tuple(
            name for name, capability in ARTIST_SECTION_CAPABILITIES if capability in descriptor.capabilities
        )
        return self._entity_page(
            kind="artist",
            capability=Capability.ARTIST_DETAILS,
            provider_id=provider_id,
            entity_id=artist_id,
            fetch=lambda instance: instance.fetch_artist_page(artist_id, sections),
            rebuild=ArtistPage.from_dict,
            force_refresh=force_refresh,
            # A page assembled with a section missing is still cacheable, but
            # not at the full TTL — the missing part should heal on its own
            # rather than persisting for a day.
            partial_check=lambda page: bool(getattr(page, "partial", None)),
        )

    def _entity_page(
        self,
        kind: str,
        capability: str,
        provider_id: str,
        entity_id: str,
        fetch: Callable[[Any], Any],
        rebuild: Callable[[Any], Any],
        force_refresh: bool = False,
        partial_check: Callable[[Any], bool] | None = None,
    ):
        _descriptor, instance = self._resolve(capability, provider_id)
        key = self.cache.key(kind, provider_id, entity_id)

        if not force_refresh:
            cached = self.cache.load(key, self.entity_ttl_s)
            if cached is not None:
                page = rebuild(cached)
                if page is not None:
                    return page
                self.logger.info("Discarding unusable cached %s %s", kind, key)

        with self._lock:
            # Re-read inside the lock: during the wait, the request being
            # queued behind may have filled this exact entry.
            if not force_refresh:
                cached = self.cache.load(key, self.entity_ttl_s)
                if cached is not None:
                    page = rebuild(cached)
                    if page is not None:
                        return page
            page = fetch(instance)
            degraded = bool(partial_check(page)) if partial_check else False
            if not degraded:
                self.cache.save(key, page.to_dict())
            else:
                self.logger.info("Not caching partial %s %s at full TTL", kind, key)
            return page

    # ----------------------------------------------------------------- search

    def search(
        self,
        query: str,
        categories: list[str] | None = None,
        limit: int = DEFAULT_SEARCH_LIMIT,
        provider_id: str | None = None,
        force_refresh: bool = False,
        mode: str = "full",
    ) -> SearchResults:
        text = (query or "").strip()
        if not text:
            raise ValidationError("La búsqueda no puede estar vacía.", details={"field": "q"})

        if mode not in ("typing", "full"):
            raise ValidationError("Modo de búsqueda desconocido.", details={"field": "mode"})

        wanted = tuple(categories) if categories else ALL_SEARCH_CATEGORIES
        unknown = [c for c in wanted if c not in ALL_SEARCH_CATEGORIES]
        if unknown:
            raise ValidationError(
                f"Categorías desconocidas: {', '.join(sorted(unknown))}. "
                f"Se esperaba alguna de: {', '.join(ALL_SEARCH_CATEGORIES)}.",
                details={"field": "types", "unknown": sorted(unknown)},
            )

        capability_by_category = dict(SEARCH_CATEGORY_CAPABILITIES)
        # Resolve on the first requested category, then keep only the
        # categories that same provider declares — mixing providers inside one
        # result set would hand the UI refs from two catalogs under one query.
        descriptor, instance = self._resolve(capability_by_category[wanted[0]], provider_id)
        servable = tuple(c for c in wanted if capability_by_category[c] in descriptor.capabilities)
        if not servable:
            raise ProviderUnavailable(
                f"«{descriptor.name}» no puede buscar {', '.join(wanted)}.", descriptor.id
            )

        capped = max(1, min(int(limit), MAX_SEARCH_LIMIT))
        folded = " ".join("".join(
            c for c in unicodedata.normalize("NFD", text) if not unicodedata.category(c).startswith("M")
        ).lower().split())
        key = self.cache.key("search", descriptor.id, f"{mode}:{capped}:{','.join(sorted(servable))}:{folded}")

        if not force_refresh:
            cached = self.cache.load(key, self.search_ttl_s)
            if cached is not None:
                rebuilt = self._search_from_cache(cached)
                if rebuilt is not None:
                    return rebuilt

        # Only identical requests share a flight; unrelated queries never queue
        # behind a slow upstream request. Failures are shared too, then evicted.
        with self._search_lock:
            flight = self._search_flights.get(key)
            leader = flight is None
            if leader:
                flight = Future()
                self._search_flights[key] = flight
        if not leader:
            return flight.result()
        try:
            # A flight may have completed between the cache read and registration.
            cached = None if force_refresh else self.cache.load(key, self.search_ttl_s)
            results = self._search_from_cache(cached) if cached is not None else None
            if results is None:
                if mode == "typing" and descriptor.id == "deezer":
                    results = instance.search_autocomplete(text, servable, limit=capped)
                else:
                    results = instance.search_catalog(text, servable, limit=capped)
                if not results.failed:
                    self.cache.save(key, results.to_dict())
            flight.set_result(results)
            return results
        except BaseException as exc:
            flight.set_exception(exc)
            raise
        finally:
            with self._search_lock:
                del self._search_flights[key]

    @staticmethod
    def _search_from_cache(raw: dict[str, Any]) -> SearchResults | None:
        from app.domains.browse.models import (
            BrowseAlbum,
            BrowseArtist,
            BrowsePlaylist,
            BrowseTrack,
        )

        if not isinstance(raw, dict):
            return None

        def rebuild(key: str, factory):
            rows = raw.get(key)
            if not isinstance(rows, list):
                return []
            return [item for item in (factory(r) for r in rows) if item is not None]

        query = raw.get("query")
        if not isinstance(query, str):
            return None
        return SearchResults(
            query=query,
            artists=rebuild("artists", BrowseArtist.from_dict),
            albums=rebuild("albums", BrowseAlbum.from_dict),
            tracks=rebuild("tracks", BrowseTrack.from_dict),
            playlists=rebuild("playlists", BrowsePlaylist.from_dict),
            requested=[c for c in raw.get("requested", []) if isinstance(c, str)],
            failed=[c for c in raw.get("failed", []) if isinstance(c, str)],
        )


__all__ = [
    "ALL_SEARCH_CATEGORIES",
    "DEFAULT_ENTITY_TTL_S",
    "DEFAULT_SEARCH_TTL_S",
    "BrowseService",
    "ProviderUnavailable",
]
