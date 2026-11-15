"""Owner scan controls; commands enqueue work and reads never touch the disk."""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies import DependencyContainer, get_container, get_music_service
from app.domains.music.library_health import LibraryHealthResponse
from app.domains.music.services import MusicService
from app.infra.identity import Principal, require_owner

router = APIRouter(prefix='/api/library', tags=['music'])


class LibraryScanStatus(BaseModel):
    scanning: bool
    pending: bool
    watching: bool
    intervalSeconds: float
    lastScanAt: str | None
    durationSeconds: float | None
    error: str | None


class LibraryScanRequest(BaseModel):
    full: bool = False


@router.get('/scan', response_model=LibraryScanStatus)
def scan_status(
    principal: Principal = Depends(require_owner),
    service: MusicService = Depends(get_music_service),
):
    return service.music_repo.scans.status()


@router.post('/scan', response_model=LibraryScanStatus, status_code=202)
def request_scan(
    body: LibraryScanRequest,
    principal: Principal = Depends(require_owner),
    service: MusicService = Depends(get_music_service),
):
    repo = service.music_repo
    if repo.scans.worker is None:
        repo.start_scanner()
    repo.scans.worker.request('owner-full' if body.full else 'owner-changes', full=body.full)
    return repo.scans.status()


@router.get('/health', response_model=LibraryHealthResponse)
def library_health(
    principal: Principal = Depends(require_owner),
    container: DependencyContainer = Depends(get_container),
):
    return container.get_library_health().snapshot()
