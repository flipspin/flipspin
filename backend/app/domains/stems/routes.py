"""Declare fixed stem routes before album/file routes to avoid shadowing.

Clients distinguish a ready manifest (200), job state (202), and absence (404).
Requests are scoped and idempotent; deleting a split requires an owner.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.domains.helpers.helper_ranking import WaitReason
from app.domains.helpers.legacy import stems_agent_router
from app.domains.user_library.scope import LibraryScope, get_library_scope
from app.dependencies import get_stems_service
from app.infra.identity import current_principal, require_owner
from app.infra.identity import Principal, is_real_user
from app.domains.music.routes import AUDIO_CACHE_CONTROL, _file_response
from app.domains.stems.models import STEMS, StemPriority
from app.domains.stems.repositories import StemsNotFoundError
from app.domains.stems.services import StemsService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/stems", tags=["stems"])

STEM_MEDIA_TYPE = "audio/ogg"
# ------------------------------------------------------------------ models


class StemsRequest(BaseModel):
    album: str
    file: str
    model: str | None = Field(None, description="htdemucs (the only one today)")
    priority: StemPriority = "now"


class StemsRequestResponse(BaseModel):
    status: str = Field(..., description="queued | running | ready | failed | skipped (background disabled)")
    jobId: str | None = None


class StemsAgentState(BaseModel):
    online: bool
    lastSeen: str | None = None
    name: str | None = None


class StemsPendingResponse(BaseModel):
    status: str
    phase: str | None = Field(
        None, description="queued · claimed · decoding · separating · beats · chops · encoding · uploading · failed"
    )
    progress: float | None = None
    error: str | None = None
    agent: StemsAgentState


class StemsJobRow(BaseModel):
    album: str
    file: str
    status: str
    phase: str | None = None
    progress: float | None = None
    error: str | None = None
    requestedAt: str | None = None
    updatedAt: str | None = None
    kind: str = "stems"
    needs: list[str] = Field(default_factory=list)
    offeredAt: float | None = None
    leasedBy: str | None = None
    result: dict | None = None
    waitReason: WaitReason | None = None


class StemsJobsResponse(BaseModel):
    oldestAt: float | None = None
    waitReason: WaitReason | None = None
    jobs: list[StemsJobRow]
    agent: StemsAgentState
    mode: str = Field(..., description="agent | local — who runs the engine")


class StemsDeleteResponse(BaseModel):
    success: bool
    removed: bool


class StemsSplitRow(BaseModel):
    album: str
    file: str
    title: str
    artist: str
    albumTitle: str
    createdAt: str | None
    stale: bool
    sizeBytes: int = Field(..., ge=0, description="Stored bytes of song.json and the four Ogg stems; stat only")


class StemsListResponse(BaseModel):
    splits: list[StemsSplitRow]


class StemsDeleteAllResponse(BaseModel):
    removed: int


# ------------------------------------------------------------------ fixed


@router.post("/request", response_model=StemsRequestResponse, response_model_exclude_unset=True)
def stems_request(body: StemsRequest, service: StemsService = Depends(get_stems_service),
                  scope: LibraryScope = Depends(get_library_scope),
                  principal: Principal = Depends(current_principal)):
    """Ask for a track's stems. ``ready`` = already on disk, no new job."""
    if not scope.allows(f"{body.album}/{body.file}"):
        raise HTTPException(status_code=404, detail=f"Track not found: {body.album}/{body.file}")
    try:
        return service.request(body.album, body.file, body.model, priority=body.priority,
                               requested_by=principal.user_id if is_real_user(principal) else None)
    except StemsNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("", response_model=StemsListResponse)
def stems_list(service: StemsService = Depends(get_stems_service), scope: LibraryScope = Depends(get_library_scope)):
    return {"splits": service.splits(scope.allows)}


@router.delete("", response_model=StemsDeleteAllResponse, dependencies=[Depends(require_owner)])
def stems_delete_all(service: StemsService = Depends(get_stems_service),
                     principal: Principal = Depends(current_principal)):
    removed = service.delete_all()
    logger.info("Stems delete-all removed %s splits by %s", removed, principal)
    return {"removed": removed}


@router.get("/jobs", response_model=StemsJobsResponse)
def stems_jobs(
    service: StemsService = Depends(get_stems_service), scope: LibraryScope = Depends(get_library_scope),
):
    """Every live or failed job, and whether a worker is calling in."""
    snapshot = service.jobs()
    return {**snapshot, "jobs": [j for j in snapshot["jobs"] if scope.allows(f"{j['album']}/{j['file']}")]}


# ---------------------------------------------------------------- agent
#
# Dial-out protocol for the Mac: claim → heartbeat → result. Token-gated like
# everything. Lease policy lives in infra/jobs/queue.py.


router.include_router(stems_agent_router)


# --------------------------------------------------------------- per-track


@router.get(
    "/{album}/{file}",
    responses={202: {"model": StemsPendingResponse, "description": "Queued, running or failed"}},
)
def stems_get(
    album: str, file: str, service: StemsService = Depends(get_stems_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """``200`` the manifest (song.json) when ready, ``202`` while not, ``404`` never requested."""
    if not scope.allows(f"{album}/{file}"):
        raise HTTPException(status_code=404, detail=f"No stems requested for {album}/{file}")
    try:
        code, body = service.status(album, file)
    except StemsNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if code == 202:
        return JSONResponse(status_code=202, content=body)
    return body


@router.get("/{album}/{file}/{stem}")
def stems_audio(
    album: str, file: str, stem: str, request: Request, service: StemsService = Depends(get_stems_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """One stem, Opus in Ogg, with Range — same streaming as ``/api/media``."""
    if stem not in STEMS:
        raise HTTPException(status_code=404, detail=f"stem must be one of {', '.join(STEMS)}")
    if not scope.allows(f"{album}/{file}"):
        raise HTTPException(status_code=404, detail=f"No {stem} stem for {album}/{file}")
    try:
        path = service.stem_file(album, file, stem)
    except StemsNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return _file_response(request, path, STEM_MEDIA_TYPE, f"{stem}.ogg", AUDIO_CACHE_CONTROL)


@router.delete("/{album}/{file}", response_model=StemsDeleteResponse, dependencies=[Depends(require_owner)])
def stems_delete(album: str, file: str, service: StemsService = Depends(get_stems_service),
                 principal: Principal = Depends(current_principal)):
    try:
        removed = service.delete(album, file)
    except StemsNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    logger.info("Stems %s/%s deleted by %s (removed=%s)", album, file, principal, removed)
    return {"success": True, "removed": removed}
