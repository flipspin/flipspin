"""Owner-only duplicate review. These endpoints cannot delete or rewrite files."""
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.dependencies import get_duplicate_service
from app.domains.music.duplicate_service import DuplicateError
from app.infra.identity import require_owner

router = APIRouter(prefix='/api/library/duplicates', tags=['music'], dependencies=[Depends(require_owner)])


class DuplicateDifference(BaseModel):
    format: bool
    bitrate: int | None
    duration: float | None
    plays: int


class DuplicateFile(BaseModel):
    relPath: str
    title: str
    artist: str
    album: str
    format: str
    bitrate: int | None
    duration: float | None
    plays: int
    missing: bool
    difference: DuplicateDifference


class DuplicateGroup(BaseModel):
    groupId: str
    basis: Literal['tags', 'audio']
    keeper: str
    title: str
    artist: str
    files: list[DuplicateFile]


class DuplicateList(BaseModel):
    jobId: str | None
    state: str
    audio: Literal['not-scanned', 'unavailable', 'available']
    audioSkipped: int
    groups: list[DuplicateGroup]


class DuplicateJob(BaseModel):
    jobId: str


class DuplicateKeep(BaseModel):
    model_config = ConfigDict(extra='forbid')
    keep: str = Field(min_length=1, max_length=4096)


@router.get('', response_model=DuplicateList)
def listing(service=Depends(get_duplicate_service)):
    return service.view()


@router.post('/scan', status_code=202, response_model=DuplicateJob)
def scan(background: BackgroundTasks, service=Depends(get_duplicate_service)):
    job_id, root, created = service.start()
    if created:
        background.add_task(service.run, job_id, root)
    return {'jobId': job_id}


@router.put('/{groupId}/keeper', response_model=DuplicateList)
def keeper(groupId: str, body: DuplicateKeep, service=Depends(get_duplicate_service)):
    try:
        return service.preference(groupId, keep=body.keep)
    except DuplicateError as error:
        raise HTTPException(error.status, detail=error.reason)


@router.post('/{groupId}/dismiss', response_model=DuplicateList)
def dismiss(groupId: str, service=Depends(get_duplicate_service)):
    try:
        return service.preference(groupId, dismiss=True)
    except DuplicateError as error:
        raise HTTPException(error.status, detail=error.reason)
