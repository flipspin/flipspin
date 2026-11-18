import base64
import logging
import os
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app.infra.errors import unexpected_errors_as_500
from app.infra.identity import current_principal
from app.infra.identity import Principal
from app.dependencies import (
    conditional, get_cover_cache, get_library_scope, get_music_service, get_ownership_index, get_track_relocator, get_tag_edits,
    get_playlist_service,
)
from app.exceptions import FileSystemError, MusicNotFoundError, ValidationError
from app.domains.music.listing_cache import ListingCache
from app.domains.music.covers import CoverCache, CoverSize, cover_version, source_version
from app.domains.music.schemas import (
    AlbumNamesResponse,
    AlbumWithMetadata,
    OwnershipResponse,
    TrackMutationResponse,
    WaveformResponse,
    WavesurferPeaksResponse,
)
from app.domains.music.services import MusicService
from app.domains.user_library.scope import LibraryScope
from app.domains.user_library.schemas import PlaylistRemovalUpdate
from app.utils.library_paths import album_key, file_key, rel_path_for, resolve_album, resolve_track
from app.utils.path_safety import safe_open_path

router = APIRouter(prefix="/api", tags=["music"])
logger = logging.getLogger(__name__)

# Starlette's FileResponse sets ETag and Last-Modified but never Cache-Control
# and never answers a conditional request, so a client revalidating a cover it
# already held got the whole JPEG again. Covers are public and change about
# never; audio is served with Range and a shorter private lifetime.
COVER_CACHE_CONTROL = "public, max-age=86400"
VERSIONED_COVER_CACHE_CONTROL = "public, max-age=31536000, immutable"
AUDIO_CACHE_CONTROL = "private, max-age=3600"
MAX_RANGE_HEADER_BYTES = 256

AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
}


def _etag_matches(if_none_match: str | None, etag: str | None) -> bool:
    if not if_none_match or not etag:
        return False
    if if_none_match.strip() == "*":
        return True
    candidates = {v.strip()[2:] if v.strip().startswith("W/") else v.strip() for v in if_none_match.split(",")}
    return etag in candidates


class _LeasedFileResponse(FileResponse):
    """Release a cache file even if the client disconnects during streaming."""
    on_complete: Callable[[], None] | None = None

    async def __call__(self, scope, receive, send):
        try:
            # Browsers and the desktop proxy seek with one range. Ignore
            # multiple, duplicate or oversized headers before Starlette parses
            # them; HTTP permits a full-file 200 fallback for Range requests.
            ranges = [value for name, value in scope['headers'] if name.lower() == b'range']
            if len(ranges) > 1 or any(len(value) > MAX_RANGE_HEADER_BYTES or b',' in value for value in ranges):
                scope = {**scope, 'headers': [(name, value) for name, value in scope['headers']
                                             if name.lower() != b'range']}
            await super().__call__(scope, receive, send)
        finally:
            if self.on_complete:
                self.on_complete()


def _file_response(
    request: Request, path: Path, media_type: str, filename: str, cache_control: str,
    *, etag: str | None = None, on_complete: Callable[[], None] | None = None,
):
    """A FileResponse with a cache lifetime, or a 304 when the client's ETag still matches."""
    try:
        return _build_file_response(request, path, media_type, filename, cache_control, etag, on_complete)
    except BaseException:
        if on_complete:
            on_complete()
        raise


def _build_file_response(request, path, media_type, filename, cache_control, etag, on_complete):
    headers = {"Cache-Control": cache_control}
    if etag:
        headers["ETag"] = etag
    response = _LeasedFileResponse(
        path=str(path),
        media_type=media_type,
        filename=filename,
        stat_result=os.stat(path),
        headers=headers,
    )
    response.on_complete = on_complete
    etag = response.headers.get("etag")
    if _etag_matches(request.headers.get("if-none-match"), etag):
        headers = {"Cache-Control": cache_control}
        if etag:
            headers["ETag"] = etag
        last_modified = response.headers.get("last-modified")
        if last_modified:
            headers["Last-Modified"] = last_modified
        if on_complete:
            on_complete()
        return Response(status_code=304, headers=headers)
    return response


class OwnershipQuery(BaseModel):
    title: str
    artist: str | None = None
    durationSeconds: float | None = None


class OwnershipRequest(BaseModel):
    tracks: list[OwnershipQuery]


class DeleteTrackRequest(BaseModel):
    path: str


class MoveTrackRequest(BaseModel):
    """Move a song into an album's folder (``domains/music/relocation.py``).

    ``path`` is the server's absolute path, as an ownership verdict's ``match``
    carries it. The target is ``albumDir`` (an existing library album's key)
    or, without it, the folder a download of ``albumTitle`` would land in.
    ``albumTitle``/``trackNumber`` are also written to the tags (MP3 only).
    """

    path: str
    albumDir: str | None = None
    albumTitle: str | None = None
    trackNumber: int | None = None


class UpdateTagsRequest(BaseModel):
    path: str
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    genre: str | None = None
    year: int | None = None
    track_number: int | None = None
    bpm: int | None = None


@router.get("/listar-albums", response_model=AlbumNamesResponse, name="listar_albums")
@unexpected_errors_as_500
def list_album_names(
    music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    try:
        albums = scope.filter_albums(music_service.list_albums(), music_service.config.base_music_dir)
        return {"albums": [a.name for a in albums]}
        
    except FileSystemError as e:
        logger.error(f"Error listing albums: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/listar-albums-con-metadata", response_model=list[AlbumWithMetadata], name="listar_albums_con_metadata")
@conditional(('library', 'analysis'), account_scope=True)
@unexpected_errors_as_500
def list_albums_with_metadata(
    request: Request,
    covers: bool = Query(
        True,
        description="Inline each cover as a base64 data URI. Set false to get URLs only.",
    ),
    music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """The library with per-track metadata.

    ⚠ **`covers=true` is expensive and the default only for compatibility.**
    Inlining every cover as a base64 data URI makes this response ~30 MB on a
    178-album library — measured 32,097,488 bytes — of which ~30 MB is the
    covers. On a LAN that is a 1-second request and nobody notices. Over a phone
    tunnel it is tens of seconds of the *home upstream*, and that long window is
    what let an ordinary tab switch cancel the load on iOS (`NSURLErrorCancelled`),
    which read as "the library is broken" while every smaller request worked.

    `covers=false` returns `"cover": null` and nothing else changes, so a client
    that fetches `/api/media/{dir}/cover.jpg` per album — which is what both the
    iOS client and any lazy-loading UI already do — pays a few KB instead. The
    flag is opt-in rather than the default because the Electron renderer still
    reads the inlined field, and flipping the default would blank every cover in
    the desktop app.
    """
    repo = music_service.music_repo
    source = music_service.list_albums()
    base = music_service.config.base_music_dir
    key = (str(base), scope.allowed_rel_paths, covers)

    cache = repo.listing_cache
    if not isinstance(cache, ListingCache):
        cache = ListingCache()
    revisions = tuple(repo.changes.revision(area) for area in ('library', 'analysis'))
    return cache.response(revisions, key, lambda: album_listing(music_service, scope, covers, source))


def album_listing(music_service, scope, covers=False, source=None):
    base = music_service.config.base_music_dir
    albums = scope.filter_albums(source if source is not None else music_service.list_albums(), base)
    if scope.unrestricted:
        from app.domains.music.ghosts import owner_ghosts
        albums = owner_ghosts(music_service.music_repo, albums, scope)
    out = []
    for album in albums:
        # The media key: the folder for a flat library, "Artist∕Album" for
        # a nested one (app/utils/library_paths.py).
        key = album_key(base, album.path) or Path(album.path).name
        cover_base64 = None
        if covers and album.cover_art and Path(album.cover_art).exists():
            try:
                with open(album.cover_art, "rb") as img:
                    raw = base64.b64encode(img.read()).decode()
                ext = Path(album.cover_art).suffix.lower()
                mime = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/jpeg")
                cover_base64 = f"data:{mime};base64,{raw}"
            except Exception as e:
                logger.warning("Could not encode cover for %s: %s", album.name, e)
        out.append({
            "album": album.name,
            "artist": album.artist,
            **album.tag_dict(),
            "path": str(album.path),
            "mediaKey": key,
            "year": album.year,
            "genre": album.genre,
            "cover": cover_base64,
            "coverVersion": cover_version(album.cover_art),
            "duration": album.total_duration,
            "tracks": [
                {
                    "title": t.title,
                    "artist": t.artist,
                    **t.tag_dict(),
                    "duration": t.duration,
                    "path": str(t.path),
                    "url_path": f"/api/media/{key}/{file_key(album.path, t.path)}",
                    "relPath": f"{key}/{file_key(album.path, t.path)}",
                    "track_number": t.track_number,
                    "genre": t.genre,
                    "dateAdded": t.date_added,
                    "bpm": t.bpm,
                    "key": t.key,
                    "mood": t.mood,
                    "arousal": (t.analysis or {}).get('arousal'),
                    "analysis": t.analysis,
                    **({'missingFromNest': True, 'missingSince': t.missing_since} if t.missing else {}),
                    **{field: (t.analysis or {}).get(field, 'none' if field == 'analysisState' else None if field.endswith(('Source', 'Confidence')) else False)
                       for field in ('bpmEstimated', 'keyEstimated', 'analysisState', 'bpmFixed', 'keyFixed', 'keySource', 'bpmSource', 'keyConfidence', 'bpmConfidence')},
                }
                for t in album.tracks
            ],
        })
    return out


@router.get("/media/{album}/cover.jpg")
@unexpected_errors_as_500
def serve_cover(
    album: str, request: Request, music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
    size: CoverSize | None = Query(None),
    v: str | None = Query(None, description="Cover revision from the album listing; a match enables immutable caching."),
    cover_cache: CoverCache = Depends(get_cover_cache),
):
    try:
        album_decoded = unquote(album)
        album_path = resolve_album(music_service.config.base_music_dir, album_decoded)
        if not scope.allows_album(album_decoded) or not album_path.exists() or not album_path.is_dir():
            raise HTTPException(status_code=404, detail=f"Album not found: {album_decoded}")
        cover_path = music_service.music_repo._find_cover_art(album_path)
        if not cover_path or not cover_path.exists():
            raise HTTPException(status_code=404, detail=f"Cover not found for: {album_decoded}")
        stat = cover_path.stat()
        cache_control = VERSIONED_COVER_CACHE_CONTROL if v == source_version(stat) else COVER_CACHE_CONTROL
        if size is not None:
            with ExitStack() as lease:
                thumbnail = lease.enter_context(cover_cache.thumbnail(cover_path, size, stat))
                if thumbnail is not None:
                    path, etag = thumbnail
                    return _file_response(
                        request, path, "image/jpeg", "cover.jpg", cache_control,
                        etag=etag, on_complete=lease.pop_all().close,
                    )
        ext = cover_path.suffix.lower()
        mime_type = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(ext, "image/jpeg")
        
        return _file_response(request, cover_path, mime_type, cover_path.name, cache_control)

    except ValidationError:
        raise HTTPException(status_code=404, detail="Album not found")


@router.get("/media/{album}/{filename}")
@unexpected_errors_as_500
def serve_audio(
    album: str, filename: str, request: Request, music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """Stream one audio file, with Range.

    ⚠ Path validation only — no tag parsing. This used to go through
    ``get_track``, which opens the file with mutagen and can schedule a librosa
    analysis, and a playing song arrives as one Range request every couple of
    seconds (68 requests measured for one three-minute song), so that work
    ran dozens of times per song before a single byte was streamed.
    """
    try:
        track_path = resolve_track(music_service.config.base_music_dir, album, filename)
        if not scope.allows(f"{album}/{filename}") or not track_path.is_file():
            raise MusicNotFoundError(f"Track not found: {album}/{filename}")
        media_type = AUDIO_MIME_TYPES.get(track_path.suffix.lower(), "audio/mpeg")
        return _file_response(request, track_path, media_type, track_path.name, AUDIO_CACHE_CONTROL)

    except (MusicNotFoundError, ValidationError) as e:
        # A key that escapes the library is not a song here, same as a missing one.
        logger.warning(f"Track not found: {album}/{filename}")
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/waveform/{album}/{filename}", response_model=WaveformResponse)
@unexpected_errors_as_500
def get_waveform(
    album: str,
    filename: str,
    samples: int = Query(1000, ge=100, le=10000),
    music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    try:
        if not scope.allows(f"{album}/{filename}"):
            raise MusicNotFoundError(f"Track not found: {album}/{filename}")
        track = music_service.get_track(album, filename)
        waveform = music_service.generate_waveform(track.path, samples)
        return {
            "waveform": waveform,
            "samples": len(waveform),
            "track": filename
        }
        
    except MusicNotFoundError as e:
        logger.warning(f"Track not found: {album}/{filename}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/wavesurfer-peaks/{album}/{filename}", response_model=WavesurferPeaksResponse)
@unexpected_errors_as_500
def get_wavesurfer_peaks(
    album: str,
    filename: str,
    samples: int = Query(1000, ge=100, le=10000),
    music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    try:
        if not scope.allows(f"{album}/{filename}"):
            raise MusicNotFoundError(f"Track not found: {album}/{filename}")
        track = music_service.get_track(album, filename)
        waveform = music_service.generate_waveform(track.path, samples)
        return {
            "version": 2,
            "channels": 1,
            "sample_rate": 44100,
            "samples_per_pixel": 1,
            "bits": 8,
            "length": len(waveform),
            "data": [waveform],
        }
        
    except MusicNotFoundError as e:
        logger.warning(f"Track not found: {album}/{filename}")
        raise HTTPException(status_code=404, detail=str(e))
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


class DeleteTrackResponse(TrackMutationResponse):
    playlistsUpdated: list[PlaylistRemovalUpdate] = []


@router.post("/delete-track", response_model=DeleteTrackResponse)
@unexpected_errors_as_500
def delete_track(
    data: DeleteTrackRequest,
    music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
    principal: Principal = Depends(current_principal),
    playlists=Depends(get_playlist_service),
):
    """Delete a track file from disk. The path must resolve under the music root."""
    if not principal.is_owner:
        raise HTTPException(status_code=403, detail="Only owners can delete shared files")
    try:
        candidate = Path(data.path).expanduser().resolve()
        file_path = safe_open_path(music_service.config.base_music_dir, candidate)
        rel_path = rel_path_for(music_service.config.base_music_dir, file_path)
        if not scope.allows(rel_path):
            raise ValidationError("File or directory does not exist")
        if not file_path.is_file():
            raise ValidationError("Path is not a file")
        music_service.delete_track(file_path)
        music_service.music_repo.invalidate_scan()
        updated = playlists.remove_library_tracks([file_path])
        # Irreversible: the file leaves the disk. With per-user tokens the log is
        # the only thing that can say which account requested it.
        logger.info("Track %s deleted by %s", file_path, principal)
        return {"success": True, "path": str(file_path), "playlistsUpdated": updated}
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except MusicNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FileSystemError as e:
        logger.error(f"Error deleting track: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/library/move-track", response_model=TrackMutationResponse)
@unexpected_errors_as_500
def move_track(
    data: MoveTrackRequest,
    relocator=Depends(get_track_relocator),
    scope: LibraryScope = Depends(get_library_scope),
    principal: Principal = Depends(current_principal),
):
    """Move a song the library already has into this album: no download.

    The «Mover aquí» resolve verb — the same recording filed under its single
    while the album page lists it. Every user's row, every playlist, its lyric
    and its stems follow the file. 409 when the album already holds a
    different file of that name.
    """
    from app.domains.music.relocation import RelocationConflict

    if not scope.unrestricted:
        raise HTTPException(status_code=403, detail="Only owners can move shared tracks")

    try:
        source = relocator.library_file(data.path)
        target = relocator.target_album_dir(data.albumDir, data.albumTitle)
        moved = relocator.move(
            source, target, album_title=data.albumTitle, track_number=data.trackNumber
        )
        logger.info("Track %s moved to %s by %s", source, moved, principal)
        return {"success": True, "path": str(moved)}
    except RelocationConflict as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except MusicNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/update-tags", response_model=TrackMutationResponse)
@unexpected_errors_as_500
def update_tags(
    data: UpdateTagsRequest,
    request: Request,
    response: Response,
    music_service: MusicService = Depends(get_music_service),
    scope: LibraryScope = Depends(get_library_scope),
    principal: Principal = Depends(current_principal),
    edits=Depends(get_tag_edits),
):
    """Edit a track's ID3 tags. MP3 only (the tag writer is MP3-based)."""
    if not scope.unrestricted:
        raise HTTPException(status_code=403, detail="Only owners can edit shared tracks")
    from app.domains.music.tag_routes import receipt

    def action():
        try:
            from app.domains.metadata.tagwriter import TagError
            candidate = Path(data.path).expanduser().resolve()
            file_path = safe_open_path(music_service.config.base_music_dir, candidate)
            if not file_path.is_file():
                raise ValidationError("Path is not a file")
            fields = {key: getattr(data, attr) for key, attr in {
                'title': 'title', 'artist': 'artist', 'album': 'album', 'genre': 'genre',
                'year': 'year', 'trackNumber': 'track_number', 'bpm': 'bpm',
            }.items() if attr in data.model_fields_set}
            edits.edit(file_path, fields, principal=principal.user_id)
            response.headers['Deprecation'] = 'true'
            return {"success": True, "path": str(file_path)}
        except TagError as error:
            raise HTTPException(error.status, {'reason': error.reason})
        except OSError:
            raise HTTPException(500, {'reason': 'write-failed'})
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except MusicNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))

    result = receipt(request, principal, edits, data.model_dump(), action)
    if isinstance(result, Response):
        result.headers['Deprecation'] = 'true'
    return result


@router.post(
    "/library/ownership",
    response_model=OwnershipResponse,
    # Keeps "degraded" absent on the happy path — see OwnershipResponse.
    response_model_exclude_unset=True,
)
def check_ownership(
    request: OwnershipRequest,
    index=Depends(get_ownership_index),
    scope: LibraryScope = Depends(get_library_scope),
):
    """Which of these catalog tracks does the library already contain?

    Batch rather than per-track on purpose: an album page asks about its whole
    tracklist at once, and the index is built once for the batch. A per-track
    endpoint would invite N round trips for one page.

    Never fails the page. A library that cannot be read is reported as owning
    nothing, because a browse page that renders without ownership markers is
    far better than one that does not render.
    """
    if not request.tracks:
        return {"results": []}
    if len(request.tracks) > 500:
        raise ValidationError("Too many tracks in one ownership query (max 500)")
    try:
        verdicts = index.lookup_many(
            [
                {"title": t.title, "artist": t.artist, "duration_s": t.durationSeconds}
                for t in request.tracks
            ],
            **({} if scope.unrestricted else {"allowed_rel_paths": scope.allowed_rel_paths}),
        )
        return {"results": [v.to_dict() for v in verdicts]}
    except Exception as e:  # noqa: BLE001
        logger.warning("Ownership check failed: %s", e)
        return {
            "results": [{"owned": False, "match": None, "nearMatch": None, "reason": None}]
            * len(request.tracks),
            "degraded": True,
        }
