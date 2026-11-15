import base64
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from app.infra.errors import unexpected_errors_as_500
from app.infra.urls import UserURL
from app.infra.identity import require_owner
from app.infra.secrets import SecretLockedError, SecretUnreadableError
from app.infra.identity import Principal
from app.dependencies import get_metadata_service, get_spotify_auth
from app.exceptions import MetadataError, ValidationError
from app.domains.metadata.services import MetadataService

router = APIRouter(prefix="/api", tags=["metadata"])
logger = logging.getLogger(__name__)


def _spotify_result_page(title: str, message: str, ok: bool = True) -> str:
    color = "#1DB954" if ok else "#e22134"
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>{title}</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#121212;color:#fff;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
<div style="font-size:48px;margin-bottom:12px">{'✅' if ok else '⚠️'}</div>
<h1 style="color:{color};font-size:22px;margin:0 0 10px">{title}</h1>
<p style="color:#b3b3b3;line-height:1.5">{message}</p>
<p style="color:#666;font-size:13px;margin-top:24px">You can close this tab and return to Flipspin.</p>
</div></body></html>"""


@router.get("/spotify/status")
def spotify_status(auth=Depends(get_spotify_auth)):
    """Whether Spotify creds are configured and an account is connected."""
    return {"configured": auth.is_configured(), "connected": auth.is_connected()}


@router.get("/spotify/login")
def spotify_login(auth=Depends(get_spotify_auth), principal: Principal = Depends(require_owner)):
    """Redirect the user to Spotify's consent screen (open in a browser)."""
    try:
        auth.config.secrets.check_writable("SPOTIFY_REFRESH_TOKEN")
        logger.info("Spotify authorization started by %s", principal.user_id)
        return RedirectResponse(auth.build_authorize_url())
    except (SecretLockedError, SecretUnreadableError) as error:
        raise HTTPException(409, error.details) from None
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/spotify/callback")
def spotify_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    auth=Depends(get_spotify_auth),
):
    """Public redirect; its one-shot state is issued by the owner-only login."""
    if error:
        return HTMLResponse(_spotify_result_page("Connection cancelled", "Spotify authorization was cancelled.", ok=False))
    if not code:
        return HTMLResponse(_spotify_result_page("Missing code", "No authorization code was returned.", ok=False))
    try:
        auth.exchange_code(code, state)
        return HTMLResponse(_spotify_result_page("Spotify connected", "Flipspin can now read your playlists."))
    except (SecretLockedError, SecretUnreadableError) as error:
        raise HTTPException(409, error.details) from None
    except Exception:
        logger.warning("Spotify OAuth callback failed")
        return HTMLResponse(_spotify_result_page("Connection failed", "Could not connect to Spotify. Try again.", ok=False))


@router.post("/spotify/disconnect")
def spotify_disconnect(
    auth=Depends(get_spotify_auth),
    principal: Principal = Depends(require_owner),
):
    try:
        auth.disconnect()
    except (SecretLockedError, SecretUnreadableError) as error:
        raise HTTPException(409, error.details) from None
    # Drops the household's shared Spotify link, so name who did it.
    logger.info("Spotify disconnected by %s", principal)
    return {"success": True, "connected": False}


class AlbumUrlRequest(BaseModel):
    url: UserURL


class SearchRequest(BaseModel):
    term: str = Field(alias="termino")


@router.post("/buscar-cover", name="buscar_cover")
@unexpected_errors_as_500
async def search_cover(
    data: AlbumUrlRequest,
    metadata_service: MetadataService = Depends(get_metadata_service)
):
    """
    Fetch album cover from Genius URL.
    
    Args:
        data: Request with Genius URL
        
    Returns:
        Base64 encoded cover image
    """
    try:
        cover_data = metadata_service.fetch_album_cover(data.url)
        
        cover_base64 = base64.b64encode(cover_data).decode('utf-8')
        
        return {
            "success": True,
            "cover": cover_base64
        }
        
    except MetadataError as e:
        logger.error(f"Error fetching cover: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/buscar-album-info", name="buscar_album_info")
@unexpected_errors_as_500
async def search_album_info(
    data: AlbumUrlRequest,
    metadata_service: MetadataService = Depends(get_metadata_service)
):
    """
    Search for album information on Genius.
    
    Args:
        data: Request with Genius URL or search query
        
    Returns:
        Album information with tracks (legacy format for frontend compatibility)
    """
    try:
        from app.domains.metadata.repositories import GeniusRepository
        genius_repo = GeniusRepository(
            config=metadata_service.config,
            logger=metadata_service.logger
        )
        
        album_info = genius_repo.get_album_info(data.url)
        
        cover_url = album_info.get("cover_url")
        
        # Return in legacy format for frontend compatibility
        return {
            "status": "success",
            "artista": album_info.get("artist", "Unknown"),
            "album": album_info.get("album", "Unknown"),
            "canciones": album_info.get("tracks", []),
            "cover_url": cover_url,
            "cover_local_path": None  # Not downloaded yet
        }
        
    except MetadataError as e:
        logger.error(f"Error fetching album info: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/buscar-canciones", name="buscar_canciones")
async def search_songs(
    data: SearchRequest,
    metadata_service: MetadataService = Depends(get_metadata_service)
):
    """
    Search for songs on Genius.
    
    Args:
        data: Search request with query term
        
    Returns:
        List of matching songs
    """
    try:
        results = metadata_service.search_songs(data.term)
        
        return {
            "success": True,
            "results": results,
            "count": len(results)
        }
        
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Error searching songs: {e}")
        return {
            "success": True,
            "results": [],
            "count": 0
        }



# Legacy alias for frontend compatibility
@router.post("/buscar", name="buscar")
async def search_album_legacy(
    data: AlbumUrlRequest,
    metadata_service: MetadataService = Depends(get_metadata_service)
):
    """Legacy alias for buscar-album-info."""
    return await search_album_info(data, metadata_service)
