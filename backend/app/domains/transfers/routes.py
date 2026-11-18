"""Transfer domain routes: sending library songs to a VLC on the network.

AUTH NOTE (see app/domains/accounts/auth.py). Unlike /api/open-file, /api/set-basedir and
/api/burn-audio-cd, nothing here gets the ``require_local_client`` gate. These
endpoints look "local" but are not: they read files out of the music library and
push them to VLC's HTTP upload page, so they have to run *where the library
lives*. On a remote backend that is the server, and forcing a loopback caller
would delete the feature rather than secure it. The token is the whole control.
"""
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.infra.errors import unexpected_errors_as_500
from app.infra.urls import Host
from app.dependencies import get_transfer_service
from app.exceptions import TransferError, ValidationError
from app.utils.path_safety import safe_open_path
from app.domains.transfers.services import TransferService
from app.domains.user_library.scope import LibraryScope, get_library_scope
from app.domains.user_library.acquisition_links import rel_path_for

router = APIRouter(prefix="/api", tags=["transfers"])
logger = logging.getLogger(__name__)


def _safe_music_files(raw_paths: list[str], base_music_dir: Path) -> list[Path]:
    """Resolve client-supplied paths, requiring each to be a file under the music root.

    Incoming paths must never be trusted as-is: without this check a caller
    could ask the backend to push to VLC any file the process can read (e.g. /etc/passwd). Anything outside the
    music directory raises ValidationError.
    """
    safe: list[Path] = []
    for p in raw_paths:
        resolved = safe_open_path(base_music_dir, Path(p))
        if not resolved.is_file():
            raise ValidationError(f"Not a file: {p}")
        safe.append(resolved)
    return safe


class UploadVlcRequest(BaseModel):
    paths: list[str]
    vlc_ip: Host


@router.post("/upload-selected-vlc")
@unexpected_errors_as_500
def upload_selected_vlc(
    request: UploadVlcRequest,
    transfer_service: TransferService = Depends(get_transfer_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """
    Upload selected tracks to VLC.
    
    Args:
        request: VLC upload request with paths and IP
        
    Returns:
        Upload result
    """
    try:
        # Validate paths stay under the music root before sending to VLC
        files = _safe_music_files(request.paths, transfer_service.config.base_music_dir)
        for path in files:
            if not scope.allows(rel_path_for(transfer_service.config.base_music_dir, path) or ""):
                raise ValidationError("File or directory does not exist")

        # Send to VLC
        transfer_service.send_to_vlc(
            files=files,
            vlc_ip=request.vlc_ip,
            mode="single"
        )
        
        return {
            "success": True,
            "message": f"Sent {len(files)} files to VLC"
        }
        
    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except TransferError as e:
        logger.error(f"Transfer error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/upload-audio-vlc")
@unexpected_errors_as_500
def upload_audio_vlc(
    vlc_ip: Host,
    transfer_service: TransferService = Depends(get_transfer_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """
    Upload all audio from music directory to VLC.
    
    Args:
        vlc_ip: VLC HTTP interface IP address
        
    Returns:
        Upload result
    """
    try:
        music_dir = transfer_service.config.base_music_dir
        
        audio_extensions = {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac"}
        audio_files = []
        
        for file_path in music_dir.rglob("*"):
            if file_path.suffix.lower() in audio_extensions and (
                scope.unrestricted or scope.allows(rel_path_for(music_dir, file_path) or "")
            ):
                audio_files.append(file_path)
        
        if not audio_files:
            return {
                "success": False,
                "message": "No audio files found"
            }

        audio_files = _safe_music_files([str(path) for path in audio_files], music_dir)
        
        # Send to VLC
        transfer_service.send_to_vlc(
            files=audio_files,
            vlc_ip=vlc_ip,
            mode="playlist"
        )
        
        return {
            "success": True,
            "message": f"Sent {len(audio_files)} files to VLC"
        }

    except ValidationError as e:
        logger.warning(f"Validation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except TransferError as e:
        logger.error(f"Transfer error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
