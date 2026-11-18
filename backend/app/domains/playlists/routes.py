import asyncio
import logging
import re
from collections.abc import Callable
from functools import wraps
from datetime import datetime
from dataclasses import replace
from pathlib import Path

from app.infra.request_paths import routing_path
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
# Starlette's UploadFile, not FastAPI's subclass: request.form() yields the
# former, so an isinstance check against the subclass would never match.
from starlette.datastructures import UploadFile

from app.infra.etags import ConditionalContext, validator
from app.infra.urls import UserURL
from app.infra.idempotency import idempotent
from app.infra.errors import unexpected_errors_as_500
from app.config import ConfigManager
from app.infra.identity import current_principal
from app.infra.identity import Principal
from app.infra.progress import ProgressTracker
from app.infra.uploads import bounded_form
from app.dependencies import (
    conditional,
    get_config,
    get_container,
    get_download_service,
    get_playlist_service,
    get_progress_tracker,
    get_user_track_store,
)
from app.exceptions import DownloadError, PlaylistError, ValidationError
from app.domains.downloads.models import PLAIN_EFFECT_TYPE, PLAIN_VOLUME_BOOST_DB
from app.domains.downloads.services import DownloadService
from app.domains.downloads.utils import strip_accents
from app.domains.music.covers import cover_version

from app.domains.playlists.covers import _cover_albums
from app.domains.playlists.export_import import ExportImportService
from app.domains.playlists.ownership import PlaylistAccessError, require_access
from app.domains.playlists.models import Playlist
from app.domains.playlists.schemas import (
    CreatePlaylistResponse,
    DeletePlaylistResponse,
    ExportImportStartedResponse,
    ExportParseResponse,
    ExportResolutionResponse,
    ExportResolveCancelResponse,
    ExportResolveStartedResponse,
    PlaylistDetail,
    PlaylistSummary,
    RefreshFromSourceResponse,
    RefreshPlaylistResponse,
    RenamePlaylistResponse,
    UpdatePlaylistTracksResponse,
)
from app.domains.playlists.services import WRITE_LOCK, PlaylistService, playlist_detail_tracks
from app.domains.playlists.spotify_export import ExportedTrack, parse_spotify_export
from app.domains.user_library.scope import LibraryScope, get_library_scope
from app.domains.user_library.store import UserTrackStore
from app.domains.user_library.acquisition_links import link_acquired, link_results, rel_path_for
from app.utils.library_paths import resolve_album

router = APIRouter(prefix="/api", tags=["playlists"])


def _track_key(title: str, artist: str) -> tuple[str, str]:
    """Normalize title (strip '01 - ' prefix) and artist for comparison."""
    t = (title or "").strip()
    m = re.match(r"^\d{1,3}\s*[.\-]\s*(.+)$", t)
    t = m.group(1).strip() if m else t
    return (strip_accents(t.lower()), strip_accents((artist or "").lower()))
logger = logging.getLogger(__name__)


# See docs/DEVELOPER_GUIDE.md#playlist-authorization for ownership policy.
# Every named-playlist route must call playlist_service.authorize before I/O:
#
#   PlaylistError       -> 404  "no playlist by that name"
#   PlaylistAccessError -> 403  "it exists and it is not yours"
#
# 403 is deliberately distinguishable from 404. Names are one household-wide
# namespace, so a member can already learn that a name is taken from the 409 on
# create; hiding it here would cost the client the ability to tell a typo from
# somebody else's list while hiding nothing.
def _forbidden(exc: PlaylistAccessError) -> HTTPException:
    return HTTPException(status_code=403, detail=str(exc))


def _authorized(
    playlist_service: PlaylistService, name: str, principal: Principal
) -> Playlist:
    """Load a playlist and confirm this caller may touch it, or raise.

    One gate, called by every handler that addresses a playlist by name. It
    loads rather than peeking because the caller was going to need the object
    anyway, and loading is what makes "no such playlist" a `PlaylistError` (404)
    before ownership is even consulted.
    """
    return require_access(principal, playlist_service.get_playlist(name))


def playlist_for_read(name: str, playlist_service: PlaylistService = Depends(get_playlist_service),
                      principal: Principal = Depends(current_principal)):
    # Resource authorization precedes validators, including If-None-Match: *.
    try:
        return _authorized(playlist_service, name, principal)
    except PlaylistAccessError as error:
        raise _forbidden(error) from error
    except PlaylistError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


class PlaylistItem(BaseModel):
    path: str
    title: str
    artist: str | None = None
    album: str | None = None
    track_number: int | None = None
    duration: float | None = None
    dateAdded: float | None = None


class PlaylistCreateRequest(BaseModel):
    name: str
    description: str | None = None


class PlaylistUpdateRequest(BaseModel):
    tracks: list[PlaylistItem]


class PlaylistRenameRequest(BaseModel):
    new_name: str


@router.post("/playlists", response_model=CreatePlaylistResponse)
@unexpected_errors_as_500
def create_playlist(
    data: PlaylistCreateRequest,
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
):
    try:
        playlist = playlist_service.create_playlist(
            name=data.name,
            description=data.description,
            owner_id=principal.user_id,
        )
        
        return {
            "success": True,
            "playlist": {
                "name": playlist.name,
                "description": playlist.description,
                "tracks": [],
                "created_at": datetime.fromtimestamp(playlist.created_at).isoformat() if playlist.created_at else None,
                "modified_at": datetime.fromtimestamp(playlist.modified_at).isoformat() if playlist.modified_at else None,
                "total_duration": playlist.total_duration
            }
        }
        
    except PlaylistError as e:
        logger.error(f"Error creating playlist: {e}")
        raise HTTPException(status_code=409, detail=str(e))
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


def _known_total(tracks) -> float | None:
    """Sum of stored durations, or None if any track lacks one."""
    if not tracks or any(not t.duration for t in tracks):
        return None
    return float(sum(t.duration for t in tracks))


def _cover_versions(
    albums: list[str], base: Path, find_cover: Callable[[Path], Path | None],
) -> list[str | None]:
    versions = []
    for album in albums:
        try:
            versions.append(cover_version(find_cover(resolve_album(base, album))))
        except (ValidationError, OSError):
            versions.append(None)
    return versions


# A bare array, not an envelope. Legacy shape both clients already parse.
@router.get("/playlists", response_model=list[PlaylistSummary])
@conditional(('playlists', 'library'), account_scope=True)
@unexpected_errors_as_500
def list_playlists(
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
    config: ConfigManager = Depends(get_config),
    scope: LibraryScope = Depends(get_library_scope),
    container=Depends(get_container),
):
    """The playlists this caller may see: their own, or all of them for an owner.

    ``owner`` is additive — the renderer and the iOS client read ``name`` /
    ``trackCount`` / ``created`` / ``modified`` and ignore the rest — and it is
    what lets a client mark "yours" without a second request.
    """
    return playlist_listing(playlist_service, principal, config, scope, container)


def playlist_listing(playlist_service, principal, config, scope, container):
    playlists = playlist_service.list_playlists(principal)
    if not scope.unrestricted:
        playlists = [replace(p, tracks=[
            t for t in p.tracks if scope.allows(rel_path_for(config.base_music_dir, t.path) or "")
        ]) for p in playlists]
    base = Path(config.base_music_dir)
    find_cover = container.get_music_repository()._find_cover_art
    playlists_data = []
    for p in playlists:
        albums = _cover_albums(p.tracks, base=base)
        playlists_data.append({
            "name": p.name,
            "description": p.description,
            "trackCount": len(p.tracks),
            "created": p.created_at,
            "modified": p.modified_at,
            "owner": p.owner_id,
            "cover": p.cover,
            "coverAlbums": albums,
            "coverVersions": _cover_versions(albums, base, find_cover),
            "totalDuration": _known_total(p.tracks),
        })
        
    # Return flat array for legacy compatibility
    return playlists_data
        


@router.get("/playlists/{name}", response_model=PlaylistDetail)
@conditional(('playlists', 'library'), account_scope=True)
@unexpected_errors_as_500
def get_playlist(
    name: str,
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
    scope: LibraryScope = Depends(get_library_scope),
    playlist: Playlist = Depends(playlist_for_read),
):
    """
    Get a specific playlist.
    
    Args:
        name: Playlist name
        
    Returns:
        Playlist with tracks (legacy format for frontend compatibility)
    """
    return playlist_snapshot(name, playlist_service, principal, scope, playlist=playlist)


def playlist_snapshot(name, playlist_service, principal, scope, *, playlist=None):
    try:
        playlist = playlist if playlist is not None else _authorized(playlist_service, name, principal)
        
        if not scope.unrestricted:
            playlist = replace(playlist, tracks=[
                t for t in playlist.tracks
                if scope.allows(rel_path_for(playlist_service.config.base_music_dir, t.path) or "")
            ])
        tracks_data = playlist_detail_tracks(playlist, playlist_service.music_repo)

        # Return flat playlist object for legacy compatibility
        return {
            "name": playlist.name,
            "description": playlist.description,
            "tracks": tracks_data,
            "created": playlist.created_at,
            "modified": playlist.modified_at,
            "source_url": playlist.source_url,
            "cover": playlist.cover,
            "owner": playlist.owner_id
        }
        
    except PlaylistAccessError as e:
        logger.warning("Refused %s access to playlist %r", principal, name)
        raise _forbidden(e)
    except PlaylistError as e:
        logger.warning(f"Playlist not found: {name}")
        raise HTTPException(status_code=404, detail=str(e))


_edit_lock = WRITE_LOCK


def versioned(function):
    @wraps(function)
    def edit(*args, **kwargs):
        with _edit_lock:
            request = kwargs['request']
            expected = request.headers.get('if-match')
            if expected:
                current = playlist_snapshot(kwargs['name'], kwargs['playlist_service'], kwargs['principal'], kwargs['scope'])
                current = PlaylistDetail.model_validate(current).model_dump(mode='json')
                container = request.app.state.container
                areas = ('playlists', 'library')
                if not kwargs['scope'].unrestricted:
                    areas += (f"me:{kwargs['principal'].user_id}",)
                ctx = ConditionalContext(request, None, container.changes, kwargs['principal'])
                _, etag = validator(ctx, areas, kwargs['scope'].allowed_rel_paths,
                                    path=routing_path(request).removesuffix('/tracks'), query=[])
                if expected != etag and expected != '*':
                    raise HTTPException(412, {'code': 'playlist-changed', 'etag': etag, 'current': current}, headers={'ETag': etag})
            return function(*args, **kwargs)
    return edit


@router.put("/playlists/{name}/tracks", response_model=UpdatePlaylistTracksResponse)
@unexpected_errors_as_500
@idempotent
@versioned
def update_playlist_tracks(
    request: Request,
    name: str,
    tracks: list[PlaylistItem],
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
    scope: LibraryScope = Depends(get_library_scope),
):
    """
    Update tracks in a playlist.
    
    Args:
        name: Playlist name
        tracks: New list of tracks
        
    Returns:
        Updated playlist
    """
    try:
        track_paths = [Path(t.path) for t in tracks]
        
        # Remove all existing tracks and add new ones. Authorized first: this
        # endpoint replaces the whole track list, so an unguarded call is how one
        # user's write lands on another user's playlist.
        playlist = _authorized(playlist_service, name, principal)
        if not scope.unrestricted:
            for path in track_paths:
                if not scope.allows(rel_path_for(playlist_service.config.base_music_dir, path) or ""):
                    raise HTTPException(status_code=404, detail=f"Track not found: {path}")
        
        # One save, in the order sent. Rows already in the list survive even if
        # their file is missing — see PlaylistService.replace_tracks.
        playlist, _, _ = playlist_service.replace_tracks(name, track_paths)
        
        return {
            "success": True,
            "playlist": {
                "name": playlist.name,
                "track_count": len(playlist.tracks),
                "total_duration": playlist.total_duration
            }
        }
        
    except PlaylistAccessError as e:
        logger.warning("Refused %s a track update on playlist %r", principal, name)
        raise _forbidden(e)
    except PlaylistError as e:
        logger.error(f"Error updating playlist: {e}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/playlists/{name}", response_model=DeletePlaylistResponse)
@unexpected_errors_as_500
@idempotent
@versioned
def delete_playlist(
    request: Request,
    name: str,
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
    scope: LibraryScope = Depends(get_library_scope),
):
    """
    Delete a playlist.
    
    Args:
        name: Playlist name
        
    Returns:
        Success message
    """
    try:
        # Ownership before deletion: a member deleting another member's playlist
        # is the footgun this whole feature exists to close.
        _authorized(playlist_service, name, principal)
        playlist_service.delete_playlist(name)
        # Destructive and irreversible, so the log says who: with per-user tokens
        # a household shares this endpoint (app/domains/accounts/identity.py).
        logger.info("Playlist %r deleted by %s", name, principal)

        return {
            "success": True,
            "message": f"Playlist '{name}' deleted"
        }
        
    except PlaylistAccessError as e:
        logger.warning("Refused %s the deletion of playlist %r", principal, name)
        raise _forbidden(e)
    except PlaylistError as e:
        logger.warning(f"Playlist not found: {name}")
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/playlists/{name}", response_model=RenamePlaylistResponse)
@unexpected_errors_as_500
@idempotent
@versioned
def rename_playlist(
    request: Request,
    name: str,
    data: PlaylistRenameRequest,
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
    scope: LibraryScope = Depends(get_library_scope),
):
    """
    Rename a playlist.

    Args:
        name: Current playlist name
        data: New name

    Returns:
        The renamed playlist (nested {success, playlist} envelope)
    """
    try:
        _authorized(playlist_service, name, principal)
        playlist = playlist_service.rename_playlist(name, data.new_name)

        return {
            "success": True,
            "playlist": {
                "name": playlist.name,
                "description": playlist.description,
                "trackCount": len(playlist.tracks) if scope.unrestricted else sum(
                    scope.allows(rel_path_for(playlist_service.config.base_music_dir, t.path) or "")
                    for t in playlist.tracks
                ),
                "created": playlist.created_at,
                "modified": playlist.modified_at,
            }
        }

    except PlaylistAccessError as e:
        logger.warning("Refused %s the rename of playlist %r", principal, name)
        raise _forbidden(e)
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except PlaylistError as e:
        # The target name is checked against every playlist in the house, not
        # just the caller's (ownership.py, rule 2), so a member renaming onto a
        # name another user already holds gets the same 409 as any collision.
        # Same exception type covers both "not found" and a name collision;
        # map the collision to 409 and everything else to 404.
        detail = str(e)
        status = 409 if "already exists" in detail else 404
        logger.warning(f"Rename failed ({status}): {detail}")
        raise HTTPException(status_code=status, detail=detail)


@router.post("/refresh-playlist/{name}", response_model=RefreshFromSourceResponse)
async def refresh_playlist_from_source(
    name: str,
    playlist_service: PlaylistService = Depends(get_playlist_service),
    download_service: DownloadService = Depends(get_download_service),
    principal: Principal = Depends(current_principal),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
):
    """
    Refresh playlist from source_url: fetch current tracks from Spotify/URL,
    download only new tracks, append to playlist. Legacy path for frontend.
    """
    try:
        playlist = _authorized(playlist_service, name, principal)
    except PlaylistAccessError as e:
        logger.warning("Refused %s a source refresh of playlist %r", principal, name)
        raise _forbidden(e)
    except PlaylistError as e:
        raise HTTPException(status_code=404, detail=str(e))
    link_acquired(
        user_tracks, principal, download_service.config.base_music_dir,
        [t.path for t in playlist.tracks if Path(t.path).is_file()],
    )
    source_url = playlist.source_url
    if not source_url or not str(source_url).strip():
        raise HTTPException(status_code=400, detail="Playlist has no source_url to refresh")
    try:
        # Blocking HTTP (Spotify) — run off the event loop so a refresh doesn't
        # stall other concurrent requests.
        _, tracks_from_source = await asyncio.to_thread(
            download_service.get_playlist_tracks_from_url, source_url
        )
    except DownloadError as e:
        raise HTTPException(status_code=500, detail=str(e))
    # Refresh the playlist's cover from the source (Spotify) so re-syncing also
    # pulls updated artwork — even when there are no new tracks to download.
    try:
        if "open.spotify.com/playlist" in source_url or str(source_url).startswith("spotify:playlist:"):
            info = await asyncio.to_thread(download_service.fetch_spotify_playlist_info, source_url)
            cover = (info or {}).get("cover_url")
            if cover:
                playlist_service.update_cover(name, cover)
    except Exception as e:
        logger.warning(f"Could not refresh playlist cover: {e}")
    existing_keys = set()
    for t in playlist.tracks:
        k = _track_key(t.title, t.artist)
        existing_keys.add(k)
        existing_keys.add((k[0], ""))  # match by title only when artist differs or is empty
    new_tracks = [
        t for t in tracks_from_source
        if _track_key(t.get("name") or "", t.get("artist") or "") not in existing_keys
        and (_track_key(t.get("name") or "", "")[0], "") not in existing_keys
    ]
    if not new_tracks:
        return {"status": "success", "message": "No hay pistas nuevas", "added": 0}
    base = download_service.config.base_music_dir
    try:
        results = await download_service.spotify_adapter.download_playlist(
            new_tracks, base, normalize=False,
            effect_type=PLAIN_EFFECT_TYPE, volume_boost=PLAIN_VOLUME_BOOST_DB,
        )
    except Exception as e:
        logger.error(f"Error downloading new tracks: {e}")
        raise HTTPException(status_code=500, detail=f"Could not download the new tracks: {e}")
    link_results(user_tracks, principal, base, results)
    added_paths = [
        r.file_path for r in results if r.success and r.file_path and r.file_path.exists()
    ]
    if not added_paths:
        return {"status": "success", "message": "No se pudieron descargar las pistas nuevas", "added": 0}
    try:
        playlist_service.add_tracks(name, added_paths)
    except Exception as e:
        logger.error(f"Error adding tracks to playlist: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    return {
        "status": "success",
        "message": f"Agregadas {len(added_paths)} canciones nuevas",
        "added": len(added_paths),
    }


@router.post("/playlists/{name}/refresh", response_model=RefreshPlaylistResponse)
@unexpected_errors_as_500
def refresh_playlist(
    name: str,
    playlist_service: PlaylistService = Depends(get_playlist_service),
    principal: Principal = Depends(current_principal),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
):
    """
    Refresh playlist metadata and validate tracks (from file tags).
    """
    try:
        _authorized(playlist_service, name, principal)
        playlist = playlist_service.refresh_playlist(name)
        link_acquired(
            user_tracks, principal, playlist_service.config.base_music_dir,
            [t.path for t in playlist.tracks if Path(t.path).is_file()],
        )
        return {
            "success": True,
            "playlist": {
                "name": playlist.name,
                "track_count": len(playlist.tracks),
                "total_duration": playlist.total_duration,
                "modified_at": datetime.fromtimestamp(playlist.modified_at).isoformat() if playlist.modified_at else None
            }
        }
    except PlaylistAccessError as e:
        logger.warning("Refused %s a refresh of playlist %r", principal, name)
        raise _forbidden(e)
    except PlaylistError as e:
        logger.warning(f"Playlist not found: {name}")
        raise HTTPException(status_code=404, detail=str(e))


# Resolve before import so users review recording matches before acquisition.
# Import accepts only the confirmed body, including STRONG matches.
# See docs/DEVELOPER_GUIDE.md#spotify-export-import for the boundary.

# HTTP-level bound on the upload. spotify_export.py bounds member count and
# uncompressed size *once it has the bytes*; this bounds the upload accepted
# before decompression. An authenticated archive is still untrusted input.
MAX_EXPORT_UPLOAD_BYTES = 64 * 1024 * 1024
_UPLOAD_CHUNK_BYTES = 1024 * 1024

# Largest single playlist accepted by resolve/import in one call.
MAX_TRACKS_PER_REQUEST = 5000

def get_export_import_service(request: Request) -> ExportImportService:
    return request.app.state.container.get_export_import_service()


def get_resolution_service(container=Depends(get_container)):
    """Resolve the track-resolution service, or fail with an honest 503.

    Imported lazily (inside the container) and deliberately: a module-level
    import would take the whole API down if ``ResolutionService`` were ever
    absent (a partial checkout, a packaging miss) instead of failing one
    feature. As a FastAPI dependency it is also the seam the tests override
    with a fake, which is how they run without touching the network.
    """
    try:
        return container.get_resolution_service()
    except ImportError as e:
        logger.warning("Resolution service unavailable: %s", e)
        raise HTTPException(
            status_code=503,
            detail="Track resolution is unavailable on this server.",
        )
    except Exception as e:
        logger.error("Resolution service could not be constructed: %s", e)
        raise HTTPException(
            status_code=503,
            detail="Track resolution is misconfigured on this server.",
        )


class ExportTrackRef(BaseModel):
    """A track the user picked out of a parsed export.

    The identity fields are optional because /resolve is fed raw export rows
    that have none. /import is fed rows the user *approved* in the review step,
    and those do — carrying them through is what stops acquisition quietly
    fetching a different recording than the one that was approved.
    """

    model_config = ConfigDict(populate_by_name=True)

    title: str = Field(..., min_length=1, max_length=500)
    artist: str | None = Field(default=None, max_length=500)
    album: str | None = Field(default=None, max_length=500)
    # From the accepted match, not from the export.
    duration_seconds: float | None = Field(
        default=None, alias="durationSeconds", ge=0, le=86400
    )
    isrc: str | None = Field(default=None, max_length=32)
    recording_mbid: str | None = Field(
        default=None, alias="recordingMbid", max_length=64
    )

    cover_url: UserURL | None = Field(default=None, alias="coverUrl", max_length=2000)
    provider: str | None = Field(default=None, max_length=100)
    provider_id: str | None = Field(default=None, alias="providerId", max_length=500)
    mbid: str | None = Field(default=None, max_length=64)


class ExportTrackListRequest(BaseModel):
    """Body shared by /resolve and /import: a playlist name and its tracks."""

    model_config = ConfigDict(populate_by_name=True)

    playlist_name: str = Field(..., alias="playlistName", min_length=1, max_length=200)
    tracks: list[ExportTrackRef] = Field(..., min_length=1, max_length=MAX_TRACKS_PER_REQUEST)


def _to_exported_tracks(data: ExportTrackListRequest) -> list[ExportedTrack]:
    return [
        ExportedTrack(title=t.title, artist=t.artist, album=t.album)
        for t in data.tracks
    ]


async def _read_bounded(upload: UploadFile) -> bytes:
    """Read an upload into memory, aborting the moment it exceeds the limit."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_EXPORT_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Upload is too large (limit {MAX_EXPORT_UPLOAD_BYTES // 1024 // 1024} MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/playlists/spotify-export/parse", response_model=ExportParseResponse)
async def parse_spotify_export_upload(request: Request):
    """Parse an uploaded Spotify data export. Reads nothing, writes nothing.

    Multipart upload under the field name ``file`` (a ``.zip`` or a single
    ``.json`` out of one). Pure function of the bytes: no network call, no
    filesystem write, nothing queued. It answers "what is in this archive?" so
    the user can pick a playlist before anything slower starts.

    Returns ``ExportParseResult.to_dict()``:
    ``{playlistCount, trackCount, warnings, sourceFiles, unreadMembers,
    unrecognizedCount, playlists: [...]}``.

    ``unreadMembers`` is the diagnostic half: every archive member that produced
    no playlists, categorised ``ignored`` / ``known`` / ``unrecognized`` /
    ``unreadable``. Only ``unrecognized`` means "the layout is not what we
    expected", and the frontend surfaces exactly those.
    """
    async with bounded_form(request, MAX_EXPORT_UPLOAD_BYTES, max_files=1, max_fields=2) as form:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(
                status_code=400,
                detail="Expected a multipart upload with a 'file' field",
            )
        data = await _read_bounded(upload)

    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        # Unzipping and decoding megabytes of JSON is blocking work; keep it off
        # the event loop so a big export doesn't stall every other request.
        result = await asyncio.to_thread(parse_spotify_export, data)
    except ValidationError as e:
        # Not an export, or an export with nothing importable in it.
        logger.info("Rejected Spotify export upload: %s", e)
        raise HTTPException(status_code=400, detail=str(e))

    return result.to_dict()


@router.post("/playlists/spotify-export/resolve", response_model=ExportResolveStartedResponse)
async def resolve_spotify_export_tracks(
    data: ExportTrackListRequest,
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    resolution_service=Depends(get_resolution_service),
    export_import: ExportImportService = Depends(get_export_import_service),
):
    """Start resolving exported tracks to real recordings. Downloads nothing.

    Non-blocking, following the download endpoints exactly: mint a progress id,
    register it synchronously so a client attaching to
    ``GET /api/download-progress-stream/{progress_id}`` can never race a 404,
    run the work in the background, return the id immediately.

    Resolution is per-track and rate-limited by the providers (MusicBrainz
    allows 1 req/s), so a large playlist runs for a long time. It reports
    progress per item and is cancellable between items via
    ``POST /api/playlists/spotify-export/resolve/{progress_id}/cancel``.

    Results are read back from
    ``GET /api/playlists/spotify-export/resolve/{progress_id}``, grouped by
    confidence. Nothing here downloads: importing is a separate, explicit call
    carrying the list the user confirmed.
    """
    tracks = _to_exported_tracks(data)
    job = export_import.start_resolution(
        data.playlist_name, tracks, resolution_service, progress_tracker
    )
    progress_id = job.progress_id

    return {
        "success": True,
        "status": "started",
        "progress_id": progress_id,
        "playlistName": data.playlist_name,
        "total": len(tracks),
    }


@router.get(
    "/playlists/spotify-export/resolve/{progress_id}",
    response_model=ExportResolutionResponse,
)
def get_spotify_export_resolution(
    progress_id: str,
    export_import: ExportImportService = Depends(get_export_import_service),
    principal: Principal = Depends(current_principal),
    container=Depends(get_container),
):
    """Read a resolution's results, grouped by confidence.

    Readable while the job is still running, so a long resolution can be
    reviewed as it fills in rather than only at the end. ``status`` is one of
    ``in_progress``, ``done``, ``cancelled``, ``failed``.
    """
    _require_resolution_access(container, principal, progress_id)
    snapshot = export_import.resolution_snapshot(progress_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Resolution not found")
    return snapshot


def _require_resolution_access(container, principal: Principal, progress_id: str) -> None:
    job = container.get_jobs().get(progress_id)
    if not job or (not principal.is_owner and job['starter_user_id'] != principal.user_id):
        raise HTTPException(status_code=404, detail="Resolution not found")


@router.post(
    "/playlists/spotify-export/resolve/{progress_id}/cancel",
    response_model=ExportResolveCancelResponse,
)
def cancel_spotify_export_resolution(
    progress_id: str,
    export_import: ExportImportService = Depends(get_export_import_service),
    principal: Principal = Depends(current_principal),
    container=Depends(get_container),
):
    """Ask a running resolution to stop.

    Cooperative: the worker checks the flag between lookups, so an in-flight
    provider request finishes first and the job stops within roughly one lookup.
    A thread cannot be interrupted mid-call, and killing one mid-request would
    leak the connection. Whatever resolved before the stop is kept and stays
    readable. A no-op on a job that already finished.
    """
    _require_resolution_access(container, principal, progress_id)
    answer = export_import.cancel_resolution(progress_id)
    if answer is None:
        raise HTTPException(status_code=404, detail="Resolution not found")
    return answer


@router.post("/playlists/spotify-export/import", response_model=ExportImportStartedResponse)
async def import_spotify_export_tracks(
    data: ExportTrackListRequest,
    download_service: DownloadService = Depends(get_download_service),
    playlist_service: PlaylistService = Depends(get_playlist_service),
    progress_tracker: ProgressTracker = Depends(get_progress_tracker),
    principal: Principal = Depends(current_principal),
    export_import: ExportImportService = Depends(get_export_import_service),
    user_tracks: UserTrackStore = Depends(get_user_track_store),
):
    """Download the tracks the user confirmed, and save them as a playlist.

    The only endpoint in this trio that acquires anything, and it acquires
    exactly the list in the body -- never the resolve step's own output. Queues
    through the same download service as every other download mode, so it
    streams over ``GET /api/download-progress-stream/{progress_id}`` with the
    same shape the frontend already renders.
    """
    # Like browse/acquire without a folder: the adapter adds the album under
    # this parent. A playlist is a list of landed paths, not a music folder.
    destination = download_service.config.base_music_dir

    progress_id, total = export_import.start_import(
        data.playlist_name,
        data.tracks,
        destination,
        download_service,
        playlist_service,
        progress_tracker,
        principal,
        user_tracks,
    )

    return {
        "success": True,
        "status": "started",
        "progress_id": progress_id,
        "playlistName": data.playlist_name,
        "total": total,
        "destination": str(destination),
    }
