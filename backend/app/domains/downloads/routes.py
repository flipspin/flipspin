import asyncio
import json
import logging
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

from app.infra.errors import unexpected_errors_as_500
from app.infra.tasks import spawn_background
from app.domains.acquisition.sources.routes import require_source
from app.infra.urls import DownloaderURL, HttpUserURL, SourceURL
from app.domains.user_library.acquisition_links import link_results
from app.domains.user_library.scope import LibraryScope, get_library_scope
from app.infra.identity import current_principal
from app.infra.identity import Principal
from app.domains.user_library.store import UserTrackStore
from app.dependencies import (
    DependencyContainer,
    get_container,
    get_download_service,
    get_playlist_service,
    get_progress_tracker,
    get_user_track_store,
)

from app.exceptions import (
    DownloadError,
    ExternalAPIError,
    SourceAuthRequiredError,
    SpotifyAuthRequiredError,
    SpotifyPlaylistAccessError,
)
from app.domains.downloads.services import DownloadService
from app.domains.downloads.models import TrackDownloadRequest
from app.domains.downloads.utils import clean_filename
from app.domains.playlists.services import PlaylistService
from app.infra.progress import ProgressTracker
from app.infra.stream_lifetime import RevocableStreamResponse, check_stream_principal
from app.utils.path_safety import safe_music_subpath


def _title_from_stem(stem: str) -> str:
    """Use file stem as title but strip leading track number (e.g. '01 - Song' -> 'Song')."""
    stem = (stem or "").strip()
    m = re.match(r"^\d{1,3}\s*[.\-]\s*(.+)$", stem)
    return m.group(1).strip() if m else stem


def _resolve_album_cover_path(track_path) -> str:
    """Resolve the album sidecar, with support for older cover/ directories."""
    path = Path(track_path) if isinstance(track_path, str) else track_path
    if not path or not path.parent:
        return ""
    sidecar = path.parent / "cover.jpg"
    if sidecar.is_file():
        return str(sidecar)
    cover_dir = path.parent / "cover"
    if not cover_dir.is_dir():
        return ""
    for name in ("cover.jpg", "cover.jpeg", "cover.png", "cover.webp"):
        candidate = cover_dir / name
        if candidate.is_file():
            return str(candidate)
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        for f in cover_dir.glob(f"*{ext}"):
            if f.is_file():
                return str(f)
    return ""


router = APIRouter(prefix="/api", tags=["downloads"])
logger = logging.getLogger(__name__)


# Request models
class Cancion(BaseModel):
    title: str
    track_number: int


# Keep the shipped OpenAPI model name; Python callers use the English alias.
AlbumTrack = Cancion


class DownloadAlbumRequest(BaseModel):
    tracks: list[AlbumTrack] = Field(alias="titulos")
    genius_url: HttpUserURL
    cover_url: HttpUserURL | None = None
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0
    album: str | None = None
    artist: str | None = Field(default=None, alias="artista")


class DownloadSongRequest(BaseModel):
    genius_url: HttpUserURL
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0


class YoutubeDownloadRequest(BaseModel):
    url: DownloaderURL
    filename: str | None = None
    legacy_filename: str | None = Field(default=None, alias="nombre_archivo")
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0


class SpotifyTrack(BaseModel):
    title: str
    artist: str | None = None
    album: str | None = None
    track_number: int | None = None
    # Spotify's own track length. Optional because the legacy callers don't send
    # it; when present it lets the source picker veto a result whose length says
    # it is a different recording.
    duration_ms: int | None = None
    # Spotify album cover variants ([{url, width, height}, ...]); the adapter
    # embeds album_images[0] as cover art. Carried so a single searched track
    # keeps its artwork through download-spotify-playlist.
    album_images: list[dict] | None = None


class SpotifySearchRequest(BaseModel):
    query: str
    # Spotify dev-mode apps cap /v1/search at 10 results (11+ → 400).
    limit: int = 10


class SpotifyPlaylistRequest(BaseModel):
    tracks: list[SpotifyTrack]
    folder: str | None = Field(default=None, alias="carpeta")
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0


class PlaylistUrlImportRequest(BaseModel):
    """Body for import-playlist-url (legacy: playlist_url)."""
    playlist_url: str
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0
    # Positions (0-based) of the tracks to download, indexing the same ordered
    # list the /fetch-spotify-playlist preview returned. None/omitted = all.
    selected_indices: list[int] | None = None


class SearchDownloadRequest(BaseModel):
    search_term: str
    filename: str | None = None
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0
    title: str | None = None
    artist: str | None = None
    album: str | None = None


@router.post("/download-album-song")
@unexpected_errors_as_500
async def download_album_song(
    data: DownloadAlbumRequest,
    download_service: DownloadService = Depends(get_download_service),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    logger.info("Album download requested by %s: %s", principal, data.genius_url)
    try:
        destination = download_service.config.base_music_dir
        tracks_data = [{"title": c.title, "track_number": c.track_number} for c in data.tracks]
        album_name = data.album
        artist_name = data.artist
        cover_url = str(data.cover_url) if data.cover_url else None
        
        if not album_name or not artist_name or not cover_url:
            from app.domains.metadata.genius_service import GeniusService
            genius_service = GeniusService(logger)
            album_info = genius_service.get_album_info(str(data.genius_url))
            if not album_info.error:
                album_name = album_name or album_info.album
                artist_name = artist_name or album_info.artist
                cover_url = cover_url or album_info.cover_url
                logger.info("Fetched from Genius: %s - %s", artist_name, album_name)
        results = await download_service.download_from_genius(
            genius_url=str(data.genius_url),
            tracks=tracks_data,
            destination=destination,
            cover_url=cover_url,
            normalize=data.normalize,
            effect_type=data.effect_type,
            volume_boost=data.volume_boost,
            album_name=album_name,
            artist_name=artist_name
        )
        
        # Whoever asked for these gets a row saying they are theirs. Raises
        # nothing, skips sentinel principals silently, and reports anything it
        # cannot key rather than filing it wrong — app/domains/user_library/acquisition_links.py.
        link_results(user_tracks, principal, download_service.config.base_music_dir, results, logger_=logger)

        # Count successes
        success_count = sum(1 for r in results if r.success)
        
        return {
            "success": True,
            "downloaded": success_count,
            "total": len(results),
            "results": [
                {
                    "success": r.success,
                    "file_path": str(r.file_path) if r.file_path else None,
                    "error": r.error
                }
                for r in results
            ]
        }
        
    except DownloadError as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/download-single-song")
async def download_single_song(
    data: DownloadSongRequest,
    download_service: DownloadService = Depends(get_download_service),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    """
    Download single song from Genius URL.
    
    Args:
        data: Download request with Genius URL
        
    Returns:
        Download result
    """
    logger.info("Single-song download requested by %s: %s", principal, data.genius_url)
    try:
        destination = download_service.config.base_music_dir
        
        # Download single song (search on source)
        results = await download_service.download_from_genius(
            genius_url=str(data.genius_url),
            tracks=["song"],  # Will search based on Genius info
            destination=destination,
            normalize=data.normalize,
            effect_type=data.effect_type,
            volume_boost=data.volume_boost
        )
        
        link_results(user_tracks, principal, destination, results, logger_=logger)

        if results and results[0].success:
            return {
                "success": True,
                "file_path": str(results[0].file_path)
            }
        else:
            error = results[0].error if results else "Unknown error"
            raise HTTPException(status_code=500, detail=error)
            
    except DownloadError as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


def _source_custom_filename(data: YoutubeDownloadRequest) -> str | None:
    """Resolve custom filename from filename or nombre_archivo (legacy), without .mp3."""
    raw = data.filename or data.legacy_filename
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    if s.lower().endswith(".mp3"):
        s = s[:-4].strip()
    return s if s else None


@router.post("/download-youtube-url", dependencies=[Depends(require_source)], operation_id='download_youtube_url_api_download_youtube_url_post')
@unexpected_errors_as_500
async def download_source_url(
    data: YoutubeDownloadRequest,
    download_service: DownloadService = Depends(get_download_service),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    """
    Download audio directly from source URL.
    Optional name from filename or nombre_archivo (Nombre opcional).
    """
    logger.info("Source download requested by %s: %s", principal, data.url)
    try:
        base = download_service.config.base_music_dir
        from app.domains.acquisition.sources.compat import downloads_folder
        from app.domains.acquisition.models import AcquisitionError
        try:
            source = download_service.engine.download_repo.source_for_url(data.url)
        except AcquisitionError as error:
            return JSONResponse(status_code=error.status, content={'code': error.reason})
        from app.utils.path_safety import safe_music_subpath
        destination = safe_music_subpath(base, downloads_folder(source))

        custom_name = _source_custom_filename(data)

        result = await download_service.download_from_url(
            url=data.url,
            destination=destination,
            filename=custom_name,
            normalize=data.normalize,
            effect_type=data.effect_type,
            volume_boost=data.volume_boost
        )

        # "source Downloads" is the album directory here, so a file lands two
        # segments under the root and has an identity like any other track.
        link_results(user_tracks, principal, base, [result], logger_=logger)

        if result.success and result.file_path:
            return {
                "success": True,
                "status": "success",
                "file_path": str(result.file_path),
                "files": [str(result.file_path)],
                "folder": str(destination),
            }
        raise HTTPException(status_code=500, detail=result.error or "Download failed")
    except DownloadError as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/download-search")
async def download_search(
    data: SearchDownloadRequest,
    download_service: DownloadService = Depends(get_download_service),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    """
    Download audio from search term.
    
    Searches the source for the given term and downloads the best match.
    
    Args:
        data: Search term and download options
        
    Returns:
        Download result
    """
    logger.info("Search download requested by %s: %r", principal, data.search_term)
    try:
        destination = download_service.config.base_music_dir
        
        metadata = None
        if data.title or data.artist or data.album:
            from app.domains.downloads.models import TrackMetadata
            metadata = TrackMetadata(
                title=data.title,
                artist=data.artist,
                album=data.album
            )
        
        result = await download_service.download_from_search(
            search_term=data.search_term,
            destination=destination,
            filename=data.filename,
            normalize=data.normalize,
            effect_type=data.effect_type,
            volume_boost=data.volume_boost,
            metadata=metadata
        )
        
        link_results(user_tracks, principal, destination, [result], logger_=logger)

        if result.success:
            return {
                "success": True,
                "file_path": str(result.file_path),
                "title": result.title,
                "artist": result.artist,
                "album": result.album
            }
        else:
            raise HTTPException(status_code=500, detail=result.error)
            
    except DownloadError as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/search-spotify-tracks")
@unexpected_errors_as_500
def search_spotify_tracks(
    data: SpotifySearchRequest,
    download_service: DownloadService = Depends(get_download_service)
):
    """
    Search Spotify for individual songs (client-credentials, no user login).

    Returns track results shaped for the download flow; the frontend sends a
    chosen result back to /download-spotify-playlist as a one-item list.
    """
    try:
        results = download_service.search_spotify_tracks(data.query, data.limit)
        return {"results": results}
    except DownloadError as e:
        # Setup and connectivity failures need an actionable Settings response.
        logger.warning(f"Spotify track search failed: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/download-spotify-playlist")
@unexpected_errors_as_500
async def download_spotify_playlist(
    data: SpotifyPlaylistRequest,
    dir: str | None = Query(None),
    download_service: DownloadService = Depends(get_download_service),
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    """
    Start downloading tracks from a Spotify playlist (a single picked search result
    is sent as a one-item list).

    Non-blocking: mints a progress id, registers it synchronously so the SSE stream
    can attach immediately, runs the download as a background task, and returns the
    progress id right away. Per-track phase/percent progress and the final outcome
    are delivered over GET /download-progress-stream/{progress_id}.
    """
    logger.info(
        "Spotify playlist download requested by %s (%d tracks)",
        principal,
        len(data.tracks or []),
    )
    try:
        base = download_service.config.base_music_dir
        if dir:
            destination = safe_music_subpath(base, dir)
        elif data.folder:
            destination = safe_music_subpath(base, data.folder)
        else:
            destination = base

        tracks_data = [
            {
                "name": track.title,
                "artist": track.artist,
                "album": track.album,
                "track_number": track.track_number,
                "duration_ms": track.duration_ms,
                "album_images": track.album_images,
            }
            for track in data.tracks
        ]

        # Register the progress entry synchronously so a client that connects to the
        # SSE stream the moment this returns never races a 404.
        progress_id = str(uuid.uuid4())
        progress_tracker.create_progress(progress_id, len(tracks_data),
            label=(" · ".join(x for x in (data.tracks[0].title, data.tracks[0].artist) if x) if len(data.tracks) == 1 else data.folder or data.tracks[0].album or f'{len(data.tracks)} canciones'),
            items=[{'item': t['name']} for t in tracks_data])
        from app.infra.job_requests import record_call
        record_call(progress_tracker, progress_id, 'download_spotify_playlist', tracks=tracks_data,
                    destination=destination, normalize=data.normalize, effect_type=data.effect_type, volume_boost=data.volume_boost)

        async def _run_download():
            try:
                results = await download_service.download_spotify_playlist(
                    tracks=tracks_data,
                    destination=destination,
                    normalize=data.normalize,
                    effect_type=data.effect_type,
                    volume_boost=data.volume_boost,
                    progress_id=progress_id,
                )
            except Exception as e:
                # download_multiple_tracks already swallows per-track failures and
                # marks completion; this catches earlier/unexpected errors so the
                # stream still terminates instead of hanging forever.
                logger.error(f"Background Spotify download failed: {e}")
                progress_tracker.complete_progress(progress_id, "failed")
            else:
                # In the background task, not after spawn_background: the
                # request returns a progress id immediately and the files do not
                # exist yet. Linking at the call site would file rows for tracks
                # that had not landed, some of which never will.
                link_results(user_tracks, principal, base, results, logger_=logger)

        spawn_background(_run_download())

        return {
            "success": True,
            "status": "started",
            "progress_id": progress_id,
            "total": len(tracks_data),
        }

    except DownloadError as e:
        logger.error(f"Download error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class FetchSpotifyPlaylistRequest(BaseModel):
    playlist_url: str


@router.post("/fetch-spotify-playlist")
def fetch_spotify_playlist(
    data: FetchSpotifyPlaylistRequest,
    download_service: DownloadService = Depends(get_download_service)
):
    """
    Fetch Spotify playlist info for display (name, cover, tracks). Does not download.
    """
    try:
        return download_service.fetch_spotify_playlist_info(data.playlist_url.strip())
    except (SpotifyAuthRequiredError, SpotifyPlaylistAccessError):
        # Let the middleware map these to 401/422 with the user-facing message.
        raise
    except DownloadError as e:
        logger.error(f"Fetch playlist error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


async def _save_imported_playlist_json(
    download_service: DownloadService,
    playlist_service: PlaylistService,
    playlist_url: str,
    playlist_name: str | None,
    results: list,
    principal: Principal | None = None,
) -> None:
    """Save an imported playlist without turning save failure into download failure.

    Record the importer as owner so members can see their own imports. A name
    owned by another account is refused rather than overwritten.
    """
    try:
        safe_name = clean_filename((playlist_name or "ImportedPlaylists").replace(" ", "_")) or "ImportedPlaylists"
        tracks_for_playlist = []
        for r in results:
            if r.success and r.file_path:
                tracks_for_playlist.append({
                    "title": r.title or _title_from_stem(r.file_path.stem if hasattr(r.file_path, "stem") else str(r.file_path)),
                    "artist": r.artist or "",
                    "path": str(r.file_path),
                    "albumCover": _resolve_album_cover_path(r.file_path),
                })
        if not tracks_for_playlist:
            return
        # Pull the Spotify playlist artwork so the imported playlist carries its
        # real cover. Run the blocking HTTP call off the event loop (to_thread) so
        # it doesn't stall concurrent requests. A None cover here is preserved (not
        # wiped) by save_imported_playlist on re-import.
        playlist_cover = None
        try:
            if "open.spotify.com/playlist" in playlist_url or playlist_url.startswith("spotify:playlist:"):
                info = await asyncio.to_thread(download_service.fetch_spotify_playlist_info, playlist_url)
                playlist_cover = (info or {}).get("cover_url")
        except Exception as e:
            logger.warning(f"Could not fetch playlist cover: {e}")
        playlist_service.save_imported_playlist(
            name=safe_name,
            source_url=playlist_url,
            tracks=tracks_for_playlist,
            cover=playlist_cover,
            principal=principal,
        )
    except Exception as e:
        logger.warning(f"Could not save playlist JSON: {e}")


@router.post("/import-playlist-url")
@unexpected_errors_as_500
async def import_playlist_url(
    data: PlaylistUrlImportRequest,
    dir: str | None = Query(None),
    download_service: DownloadService = Depends(get_download_service),
    playlist_service: PlaylistService = Depends(get_playlist_service),
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    """
    Start importing and downloading a playlist from a URL, in the background.

    Non-blocking, mirroring /download-spotify-playlist so the playlist mode streams
    into the "Descargas activas" panel like single-track downloads do. The track
    count isn't known until the playlist is fetched, so the progress entry is
    registered synchronously at total=0 (lets the SSE stream attach without racing a
    404) and resized once import_playlist_from_url resolves the list. Per-track
    phase/percent and the final outcome are delivered over GET
    /download-progress-stream/{progress_id}. The playlist JSON is still saved to
    Krobi/playlists after a successful import.
    """
    base = download_service.config.base_music_dir
    destination = safe_music_subpath(base, dir) if dir else base

    # Register synchronously so a client attaching to the SSE stream the moment
    # this returns never races a 404. Resized once the list is fetched.
    progress_id = str(uuid.uuid4())
    progress_tracker.create_progress(progress_id, 0, kind="import", label=data.playlist_url)
    from app.infra.job_requests import record_call
    record_call(progress_tracker, progress_id, 'import_playlist_from_url',
                after={'mode': 'url', 'source_url': data.playlist_url}, playlist_url=data.playlist_url,
                destination=destination, normalize=data.normalize, effect_type=data.effect_type,
                volume_boost=data.volume_boost, selected_indices=data.selected_indices)

    async def _run_import():
        try:
            playlist_name, results = await download_service.import_playlist_from_url(
                playlist_url=data.playlist_url,
                destination=destination,
                normalize=data.normalize,
                effect_type=data.effect_type,
                volume_boost=data.volume_boost,
                selected_indices=data.selected_indices,
                progress_id=progress_id,
            )
            # download_multiple_tracks already marked the entry terminal with a
            # "Downloaded N/M tracks" summary the stream reports; just persist the
            # playlist JSON for the tracks that landed.
            await _save_imported_playlist_json(
                download_service, playlist_service, data.playlist_url, playlist_name,
                results, principal,
            )
            # The playlist got an owner above; the tracks get their rows here.
            # An import into a subfolder (`?dir=`) lands three segments deep
            # and has no expressible identity — link_results reports those as
            # unlinkable rather than filing them under a truncated path.
            link_results(user_tracks, principal, base, results, logger_=logger)
        except (SpotifyAuthRequiredError, SpotifyPlaylistAccessError) as e:
            # The preview fetch already validated access, so this is rare; the
            # background context can't return a typed HTTP error, so surface it
            # as a terminal failure the stream delivers.
            logger.warning(f"Playlist import failed: {e}")
            progress_tracker.complete_progress(progress_id, "failed")
        except Exception as e:
            logger.error(f"Background playlist import failed: {e}")
            progress_tracker.complete_progress(progress_id, "failed")

    spawn_background(_run_import())

    return {
        "status": "success",
        "success": True,
        "progress_id": progress_id,
        "total": 0,
    }



@router.get("/downloads/active")
def list_active_downloads(
    include_finished_seconds: int = Query(
        0, ge=0, le=3600,
        description="Also return jobs that finished within this many seconds",
    ),
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    principal: Principal = Depends(current_principal),
):
    """Every download the backend currently knows about.

    The missing piece that made downloads invisible: progress entries were only
    ever reachable by an id the *starting* component happened to be holding, so
    a job vanished from the UI as soon as that component unmounted — which
    `App.jsx` does on every navigation — and a job started anywhere else (a
    browse acquisition, another window, the session before a reload) was never
    visible at all.

    ``include_finished_seconds`` lets a client show a job's outcome for a
    moment after it ends rather than having it disappear at the instant it
    matters most. Terminal entries are kept by ``ProgressTracker`` until
    ``cleanup_old_progress`` runs, so this filters by age rather than assuming
    they are gone.

    ⚠ ``ProgressTracker`` is per-process memory, so this is only complete while
    the backend runs a single worker — the same constraint the SSE stream has.
    """
    now = time.time()
    # This is polled by every desktop for as long as it runs, and the tracker
    # keeps every job it ever saw: sweep the day-old ones here, since nothing
    # else does, and decide on the cheap fields before serializing a row.
    progress_tracker.cleanup_old_progress()
    jobs = []
    from app.infra.jobs_runtime import legacy_states
    for state in legacy_states(progress_tracker):
        if not principal.is_owner and state.starter_user_id != principal.user_id:
            continue
        if state.is_terminal:
            if not include_finished_seconds:
                continue
            # `created_at` is the start, not the end — the only timestamp there
            # is. It over-includes a long job that just finished rather than
            # under-including one, which is the safer direction for a UI that
            # is trying to show you an outcome.
            if now - state.created_at > include_finished_seconds:
                continue
        jobs.append(state.to_dict())

    # Newest first: the thing you just started is the thing you want to see.
    jobs.sort(key=lambda j: j.get("created_at") or 0, reverse=True)
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/download-progress/{progress_id}")
@unexpected_errors_as_500
def get_download_progress(
    progress_id: str,
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    principal: Principal = Depends(current_principal),
):
    """
    Get download progress status.
    
    Args:
        progress_id: Progress tracker ID
        
    Returns:
        Progress status
    """
    progress = progress_tracker.get_progress(progress_id)
    if progress is None or (not principal.is_owner and progress.starter_user_id != principal.user_id):
        raise HTTPException(status_code=404, detail="Progress ID not found")
    # Preserve both completed-item keys: the tracker uses items; polling clients use done.
    return {**progress.to_dict(), "done": progress.done}



# Heartbeat cadence for the SSE stream below. While a download is mid-flight but
# quiet, flush a comment line this often so the connection stays alive and
# the server notices client disconnects (the blocking wait wakes up to re-check).
_SSE_HEARTBEAT_SECONDS = 15.0


async def progress_event_stream(
    progress_tracker: ProgressTracker,
    progress_id: str,
    heartbeat: float = _SSE_HEARTBEAT_SECONDS,
):
    """Yield Server-Sent Events for one progress id until it reaches a terminal state.

    Async change notifications wake streams without holding a worker thread.
    Emit a snapshot on changes, a heartbeat on idle timeouts, and close after
    the terminal snapshot or an end event when the entry disappears.
    """
    last_version = -1
    while True:
        version = progress_tracker.current_version()
        if version != last_version:
            last_version = version
            state = await asyncio.to_thread(progress_tracker.get_progress, progress_id)
            if state is None:
                # Entry vanished mid-stream (e.g. cleanup) — end cleanly.
                yield "event: end\ndata: {}\n\n"
                return
            payload = {**state.to_dict(), "done": state.done}
            # Capture terminality from the emitted snapshot, not the live
            # (mutable) state — otherwise a producer that completes between this emit
            # and the check would end the stream without ever sending a terminal
            # snapshot, and the client would miss completion.
            is_terminal = payload["terminal"]
            yield f"data: {json.dumps(payload)}\n\n"
            if is_terminal:
                return
        else:
            # No change since the last emit: await notification, with a timeout
            # to flush a heartbeat and re-check for disconnects.
            new_version = await progress_tracker.wait_for_change_async(last_version, timeout=heartbeat)
            if new_version == last_version:
                yield ": keep-alive\n\n"


@router.get("/download-progress-stream/{progress_id}")
async def stream_download_progress(
    progress_id: str,
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    principal: Principal = Depends(current_principal),
    container: DependencyContainer = Depends(get_container),
):
    """
    Stream download progress as Server-Sent Events.

    Backed by the same thread-safe ProgressTracker as the polling endpoint above, so
    it works for every download mode (playlist batch, single-track one-click, …)
    without per-mode wiring — the stream is keyed purely by ``progress_id``. It
    pushes a `data:` event with the current snapshot whenever the tracker changes,
    then closes once the operation reaches a terminal status. The frontend consumes
    it via EventSource instead of polling. The legacy GET snapshot endpoint above is
    kept as a fallback for clients that don't speak SSE.
    """
    # Match the polling endpoint: an unknown ID is a 404 before the stream opens
    # (an HTTP status code cannot change after streaming starts).
    progress = progress_tracker.get_progress(progress_id)
    if progress is None or (not principal.is_owner and progress.starter_user_id != principal.user_id):
        raise HTTPException(status_code=404, detail="Progress ID not found")

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  # disable proxy buffering so events flush promptly
    }
    check_stream_principal(principal, container.get_token_store())
    streams = container.change_bus.streams
    lifetime = streams.subscribe(principal)
    return RevocableStreamResponse(StreamingResponse(
        progress_event_stream(progress_tracker, progress_id),
        media_type="text/event-stream",
        headers=headers,
    ), streams, lifetime)



# Let users choose alternate searches and videos after a failed match.
# A retry keeps the original destination and metadata; automatic guesses
# could publish a different recording.

class YouTubeSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=200)
    limit: int = Field(10, ge=1, le=20)


class YouTubeSearchResult(BaseModel):
    id: str | None = None
    url: str
    title: str | None = None
    duration: float | None = None
    uploader: str | None = None


class YouTubeSearchResponse(BaseModel):
    query: str
    results: list[YouTubeSearchResult]


@router.post("/downloads/youtube-search", response_model=YouTubeSearchResponse, dependencies=[Depends(require_source)], operation_id='youtube_search_api_downloads_youtube_search_post')
async def source_search(
    data: YouTubeSearchRequest,
    download_service: DownloadService = Depends(get_download_service),
):
    """Raw source results for one phrasing — no matcher, no veto: the person chooses."""
    query = data.query.strip()
    try:
        raw = await download_service.engine.download_repo.search_source(query, max_results=data.limit)
    except SourceAuthRequiredError as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        )
    except ExternalAPIError as e:
        logger.warning("Retry search failed for %r: %s", query, e)
        raise HTTPException(status_code=502, detail="Source search failed. Try again.")
    results = [
        YouTubeSearchResult(
            id=r.get("id"), url=r["url"], title=r.get("title"),
            duration=r.get("duration"), uploader=r.get("artist"),
        )
        for r in raw
        if r.get("url")
    ]
    return YouTubeSearchResponse(query=query, results=results)


class RetryDownloadRequest(BaseModel):
    progress_id: str = Field(..., min_length=1, max_length=64)
    index: int = Field(..., ge=0)
    youtube_url: SourceURL = Field(..., min_length=1, max_length=500)


class RetryDownloadResponse(BaseModel):
    success: bool
    status: str
    progress_id: str
    total: int
    label: str


@router.post("/downloads/retry", response_model=RetryDownloadResponse)
async def retry_download(
    data: RetryDownloadRequest,
    download_service: DownloadService = Depends(get_download_service),
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
    scope: LibraryScope = Depends(get_library_scope),
):
    """Download a failed song from the video the person picked, as a new job."""
    engine = download_service.engine
    state = progress_tracker.get_progress(data.progress_id)
    record = progress_tracker.ledger.get(data.progress_id) if progress_tracker.ledger else None
    permitted = scope.unrestricted or (state is not None and state.starter_user_id == principal.user_id) or (record is not None and record['starter_user_id'] == principal.user_id)
    request = engine.retry_request(data.progress_id, data.index, data.youtube_url) if permitted else None
    if request is None:
        raise HTTPException(
            status_code=404,
            detail="The server no longer has this download (it restarted). Request the song again.",
        )

    label = request.metadata.title or data.youtube_url
    logger.info("Retry of %s#%d requested by %s from %s", data.progress_id, data.index, principal, data.youtube_url)
    retry_id = str(uuid.uuid4())
    from app.infra.job_requests import request_item
    retry_items = [request_item(request)] if isinstance(request, TrackDownloadRequest) else None
    progress_tracker.create_progress(retry_id, 1, items=retry_items, label=" · ".join(x for x in (request.metadata.title, request.metadata.artist) if isinstance(x, str) and x) or label)
    progress_tracker.mark_failure_retried(data.progress_id, data.index, retry_id)
    base = download_service.config.base_music_dir

    async def _run():
        try:
            results = await engine.download_multiple_tracks([request], progress_id=retry_id)
        except Exception as e:
            logger.error(f"Retry download failed: {e}")
            progress_tracker.complete_progress(retry_id, "failed")
        else:
            # Same rule as the acquisition it replaces: link the song to whoever
            # asked, once it exists. A sentinel principal is skipped silently.
            link_results(user_tracks, principal, base, results, logger_=logger)

    spawn_background(_run())
    return RetryDownloadResponse(success=True, status="started", progress_id=retry_id, total=1, label=label)



# Legacy alias for frontend compatibility
@router.post("/download")
async def download(
    data: DownloadAlbumRequest,
    download_service: DownloadService = Depends(get_download_service),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(current_principal),
):
    """Legacy alias for download-album-song."""
    return await download_album_song(data, download_service, user_tracks, principal)
