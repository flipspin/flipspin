"""Authenticated browse routes with distinct availability and provider failures.

Missing entities return 404, disabled providers 409, and provider failures 502.
The composition root attaches authentication to this router.
"""
from __future__ import annotations

import logging
from typing import Literal


from fastapi import APIRouter, Depends, HTTPException, Query

from app.infra.identity import current_principal
from app.infra.identity import Principal
from app.infra.progress import ProgressTracker
from app.domains.user_library.store import UserTrackStore
from app.dependencies import (
    get_browse_service,
    get_container,
    get_download_service,
    get_ownership_index,
    get_progress_tracker,
    get_provider_registry,
    get_track_relocator,
    get_user_track_store,
)
from app.domains.browse.acquisition import (  # noqa: F401 — AcquireTrack: plugins import it from here
    AcquireRequest,
    AcquireTrack,
    CatalogAcquisition,
    InvalidDestination,
    NoStreamingSource,
)
from app.domains.browse.services import (
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    BrowseService,
    ProviderUnavailable,
)
from app.exceptions import ExternalAPIError, ValidationError

router = APIRouter(prefix="/api/browse", tags=["browse"])
logger = logging.getLogger(__name__)


def _handle(exc: Exception, what: str):
    """Map a domain failure onto the status codes documented above."""
    if isinstance(exc, ProviderUnavailable):
        raise HTTPException(status_code=409, detail=exc.message)
    if isinstance(exc, ValidationError):
        raise HTTPException(status_code=422, detail=getattr(exc, "message", str(exc)))
    if isinstance(exc, ValueError):
        # A malformed entity id (`_path_id` refusing anything non-numeric).
        # Invalid URL path input is a caller error.
        raise HTTPException(status_code=422, detail=str(exc))
    if isinstance(exc, ExternalAPIError):
        details = getattr(exc, "details", None) or {}
        code = (details.get("deezer_error") or {}).get("code") if isinstance(details, dict) else None
        # Deezer reports "no such id" as an error envelope inside an HTTP 200,
        # so a missing entity is indistinguishable from a failure by status
        # code alone; codes 800/(DataException) mean the row does not exist.
        if code in (800, "800"):
            raise HTTPException(status_code=404, detail=f"{what} not found")
        logger.warning("Browse %s failed: %s", what, getattr(exc, "message", exc))
        raise HTTPException(status_code=502, detail=getattr(exc, "message", str(exc)))
    raise exc


@router.get("/album/{provider}/{album_id}")
def get_album(
    provider: str,
    album_id: str,
    refresh: bool = False,
    service: BrowseService = Depends(get_browse_service),
):
    """An album header and its real tracklist, ready to acquire from."""
    try:
        return service.get_album(provider, album_id, force_refresh=refresh).to_dict()
    except Exception as e:  # noqa: BLE001 — re-raised as HTTPException by _handle
        _handle(e, "album")


@router.get("/artist/{provider}/{artist_id}")
def get_artist(
    provider: str,
    artist_id: str,
    refresh: bool = False,
    service: BrowseService = Depends(get_browse_service),
):
    """An artist page: whichever sections this provider declared it can serve."""
    try:
        return service.get_artist(provider, artist_id, force_refresh=refresh).to_dict()
    except Exception as e:  # noqa: BLE001
        _handle(e, "artist")


@router.get("/playlist/{provider}/{playlist_id}")
def get_playlist(
    provider: str,
    playlist_id: str,
    refresh: bool = False,
    service: BrowseService = Depends(get_browse_service),
):
    """A playlist and its tracks."""
    try:
        return service.get_playlist(provider, playlist_id, force_refresh=refresh).to_dict()
    except Exception as e:  # noqa: BLE001
        _handle(e, "playlist")


@router.get("/genre/{provider}/{genre_id}")
def get_genre(
    provider: str,
    genre_id: str,
    refresh: bool = False,
    service: BrowseService = Depends(get_browse_service),
):
    """A genre's own chart: top songs, albums, artists and lists."""
    try:
        return service.get_genre(provider, genre_id, force_refresh=refresh).to_dict()
    except Exception as e:  # noqa: BLE001
        _handle(e, "genre")


@router.get("/search")
def search(
    q: str = Query(..., description="Free-text catalog query"),
    mode: Literal["typing", "full"] = Query("full", description="Autocomplete while typing; full search on submit"),
    types: list[str] | None = Query(
        None, description="Categories to search: artists, albums, tracks, playlists"
    ),
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=MAX_SEARCH_LIMIT),
    provider: str | None = Query(None, description="Force a provider; default is the user's order"),
    refresh: bool = False,
    service: BrowseService = Depends(get_browse_service),
):
    """Catalog search, split by kind.

    ``provider`` is optional here and required in the path routes above: a
    search has no entity id to be ambiguous about, so the user's provider order
    picks — which is what makes reordering in Ajustes → Fuentes visible.
    """
    try:
        return service.search(
            q, categories=types, limit=limit, provider_id=provider, force_refresh=refresh, mode=mode
        ).to_dict()
    except Exception as e:  # noqa: BLE001
        _handle(e, "search")


@router.post("/acquire")
async def acquire(
    data: AcquireRequest,
    registry=Depends(get_provider_registry),
    download_service=Depends(get_download_service),
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    ownership=Depends(get_ownership_index),
    principal: Principal = Depends(current_principal),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    relocator=Depends(get_track_relocator),
    container=Depends(get_container),
):
    """Acquire catalog tracks: link what is already here, download what is not.

    This is the terminal action of browsing, and the reason the identity work
    pays off: every track arrives with a real title, artist, album, duration and
    track number, so ``select_video`` vetoes a wrong source pick against a known
    recording instead of against a string somebody typed from memory.

    **The dedupe hit is the important half.** A track the shared catalog already holds is
    not downloaded again: the caller gets a ``user_track`` row and the song is
    instantly theirs — no source request, no queue, no wait. After the first few
    months this is meant to be the common case, and it is the entire reason one
    household shares one catalog.

    A miss queues exactly as before and the requester is linked when the file
    lands (see ``_run`` below).

    ⚠ **A sentinel principal — the Electron desktop, on loopback or with
    ``KROBI_API_TOKEN`` — cannot hold library rows** (``/api/me/library`` answers
    409 for it). Acquisition does not inherit that refusal: it downloads exactly
    as it always has and simply skips the linking, silently. ``linking`` in the
    response says which of the two happened.

    Returns a ``progress_id`` immediately and runs in the background.
    ``GET /api/download-progress-stream/{id}`` is source-agnostic — keyed purely
    by the id — so no new streaming machinery is needed here.
    """
    acquisition = CatalogAcquisition(
        registry=registry,
        download_service=download_service,
        progress_tracker=progress_tracker,
        ownership=ownership,
        user_tracks=user_tracks,
        relocator=relocator,
        genre_lookup=lambda: container.get_album_genres(registry),
    )
    try:
        return await acquisition.start(data, principal)
    except NoStreamingSource:
        raise HTTPException(
            status_code=409,
            detail="No hay ninguna fuente de audio activa. Revisa Ajustes → Fuentes.",
        )
    except InvalidDestination as e:
        raise HTTPException(status_code=400, detail=str(e))
