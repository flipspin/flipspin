"""Additive owner-only MusicBrainz proposal and reviewed-apply API."""
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.dependencies import get_match_service
from app.domains.music.tag_routes import Value, failure
from app.domains.metadata import tagwriter
from app.infra.identity import Principal, require_owner

router = APIRouter(prefix='/api/library', tags=['match'], dependencies=[Depends(require_owner)])


class MatchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    relPaths: list[str] | None = Field(None, min_length=1, max_length=200)
    albumKey: str | None = Field(None, min_length=1, max_length=1000)
    query: str | None = Field(None, min_length=1, max_length=1000)
    link: str | None = Field(None, max_length=200)

    @model_validator(mode='after')
    def scope(self):
        if (self.relPaths is None) == (self.albumKey is None) or self.query and self.link:
            raise ValueError('Choose one scope and one search method')
        return self


class MatchStarted(BaseModel):
    jobId: str
    progressId: str


class MatchDiff(BaseModel):
    now: Value
    new: Value


class MatchFile(BaseModel):
    relPath: str
    rev: str
    fields: dict[str, MatchDiff]
    same: int


class MatchCandidate(BaseModel):
    id: str
    title: str
    subtitle: str
    band: Literal['strong', 'review', 'weak']
    reasons: list[str]
    files: list[MatchFile]


class MatchFailure(BaseModel):
    relPath: str
    reason: str


class MatchView(BaseModel):
    jobId: str
    state: str
    candidates: list[MatchCandidate]
    groups: dict[str, list[int]]
    errors: list[MatchFailure]


class MatchSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    relPath: str
    candidate: int = Field(ge=0)
    fields: list[str] = Field(max_length=50)


class MatchPlanRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    rows: list[MatchSelection] = Field(min_length=1, max_length=200)


class MatchPlanRow(BaseModel):
    relPath: str
    diff: dict[str, list[Value]]
    state: Literal['ok', 'no-change', 'changed-since']


class MatchPlan(BaseModel):
    planId: str
    planHash: str
    rows: list[MatchPlanRow]


class MatchApplyRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    planHash: str


class MatchApplyResult(BaseModel):
    editId: str
    progressId: str
    state: str
    applied: int
    skipped: int
    failed: int


@router.post('/match', status_code=202, response_model=MatchStarted)
def start(body: MatchRequest, background: BackgroundTasks, owner: Principal = Depends(require_owner), service=Depends(get_match_service)):
    try:
        job_id, created = service.start(body.model_dump(), owner.user_id)
        if created:
            background.add_task(service.run, job_id)
        return {'jobId': job_id, 'progressId': job_id}
    except tagwriter.TagError as error:
        failure(error)


@router.get('/match/{jobId}', response_model=MatchView)
def view(jobId: str, service=Depends(get_match_service)):
    try:
        return service.view(jobId)
    except tagwriter.TagError as error:
        failure(error)


@router.delete('/match/{jobId}', response_model=MatchView)
def cancel(jobId: str, service=Depends(get_match_service)):
    try:
        return service.cancel(jobId)
    except tagwriter.TagError as error:
        failure(error)


@router.post('/match/{jobId}/plan', response_model=MatchPlan)
def plan(jobId: str, body: MatchPlanRequest, owner: Principal = Depends(require_owner), service=Depends(get_match_service)):
    try:
        return service.plan(jobId, [r.model_dump() for r in body.rows], owner.user_id)
    except tagwriter.TagError as error:
        failure(error)


@router.post('/edits/{planId}/apply', status_code=202, response_model=MatchApplyResult)
def apply(planId: str, body: MatchApplyRequest, response: Response, background: BackgroundTasks, service=Depends(get_match_service)):
    try:
        result, created = service.apply(planId, body.planHash)
        if created:
            background.add_task(service.edits.run_batch, planId)
        else:
            response.status_code = 200
        return result
    except tagwriter.TagError as error:
        failure(error)
