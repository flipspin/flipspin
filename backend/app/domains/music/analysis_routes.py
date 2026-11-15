"""Scoped analysis reads and owner corrections."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.dependencies import conditional, get_analysis_service, get_library_scope, get_music_service
from app.exceptions import ValidationError
from app.infra.identity import Principal, require_owner, is_real_user
from app.domains.music.analysis_runs import RunConflict
from app.utils.library_paths import rel_path_for, resolve_rel_path

router = APIRouter(prefix='/api/analysis', tags=['analysis'])


class ReplayGain(BaseModel):
    trackGain: float | None = None
    albumGain: float | None = None
    trackPeak: float | None = None
    albumPeak: float | None = None
    baseGain: float = 0


class EffectiveValue(BaseModel):
    value: str | float | None
    source: Literal['fixed', 'tag', 'computed'] | None
    estimated: bool


class Values(BaseModel):
    key: str | None
    bpm: float | None


class ComputedValues(Values):
    keyEstimated: bool = False
    bpmEstimated: bool = False


class AnalysisView(BaseModel):
    keyConfidence: float | None = None
    bpmConfidence: float | None = None

    key: EffectiveValue
    bpm: EffectiveValue
    mood: str | None
    energy: float | None
    brightness: float | None
    pulse: float | None
    arousal: float | None = Field(None, ge=0, le=1)
    computed: ComputedValues
    fixed: Values
    rev: int
    state: Literal['analyzed', 'queued', 'failed', 'none']


class FixedRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    key: str | None = Field(None, pattern=r'^(?:[1-9]|1[0-2])[AB]$')
    bpm: float | None = Field(None, ge=20, le=300)
    rev: int = Field(ge=0)


class SummaryHelper(BaseModel):
    online: bool
    name: str | None
    working: bool


class EstimatedCounts(BaseModel):
    songs: int
    keys: int
    bpms: int


class EstimateRow(BaseModel):
    keyConfidence: float | None = None
    bpmConfidence: float | None = None

    relPath: str
    title: str
    artist: str
    album: str
    key: str | None
    keyEstimated: bool
    keySource: Literal['fixed', 'tag', 'computed'] | None
    bpm: float | None
    bpmEstimated: bool
    bpmSource: Literal['fixed', 'tag', 'computed'] | None
    rev: int


class EstimatesPage(BaseModel):
    rows: list[EstimateRow]
    after: str | None


class AnalysisSummary(BaseModel):
    outdated: int = 0
    estimated: EstimatedCounts
    total: int
    analyzed: int
    queued: int
    failed: int
    engineVersion: int
    helper: SummaryHelper
    waiting: int = 0
    run: 'RunProgress | None' = None


RunMode = Literal['new', 'outdated', 'all']
RunScope = Literal['library', 'selection', 'song']
WaitReason = Literal['no-helper', 'no-capable-helper', 'helpers-offline', 'helpers-busy']


class SkippedTrack(BaseModel):
    relPath: str
    reason: Literal['missing', 'ghost', 'outside', 'current', 'failed']


class RunRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    requestId: str = Field(min_length=1, max_length=128)
    mode: RunMode = 'new'
    scope: RunScope = 'library'
    relPaths: list[str] = Field(default_factory=list, max_length=500)

    @model_validator(mode='after')
    def scope_paths(self):
        if self.scope == 'library' and self.relPaths or self.scope == 'song' and len(self.relPaths) != 1 or self.scope == 'selection' and not self.relPaths:
            raise ValueError('relPaths must match scope')
        return self


class RunView(BaseModel):
    id: str
    jobId: str
    mode: RunMode
    scope: RunScope
    size: int


class RunCounts(BaseModel):
    queued: int
    joined: int
    skipped: dict[str, int]
    same: int
    changed: int
    toEstimated: int
    toConfident: int
    failed: int


class RunProgress(RunView):
    done: int
    failed: int
    waiting: WaitReason | None
    etaSeconds: float | None
    counts: RunCounts


class RunResponse(BaseModel):
    run: RunView | None
    queued: int
    joined: bool
    skipped: list[SkippedTrack]


class RunPreview(BaseModel):
    waiting: int
    outdated: int
    failed: int
    correctionsKept: int
    confirmationsKept: int
    size: int
    skipped: list[SkippedTrack]
    estimateSeconds: float | None


class RunConflictDetail(BaseModel):
    code: Literal['run-in-progress', 'no-helper', 'library-unavailable', 'migrating', 'scan-busy']
    runId: str | None = None
    waiting: WaitReason | None = None


class RunConflictResponse(BaseModel):
    detail: RunConflictDetail


def track(service, rel, scope=None):
    try:
        path = resolve_rel_path(service.config.base_music_dir, rel)
        canonical = rel_path_for(service.config.base_music_dir, path)
        if not path.is_file() or path.suffix.lower() not in service.music.AUDIO_EXTENSIONS or (
                scope is not None and not scope.allows(canonical)):
            raise HTTPException(404, 'Track not found')
    except (ValidationError, ValueError, OSError):
        raise HTTPException(404, 'Track not found')
    return canonical, path


@router.get('/summary', response_model=AnalysisSummary)
@conditional(('analysis', 'library', 'jobs', 'helpers'))
def summary(owner: Principal = Depends(require_owner), service=Depends(get_analysis_service)):
    return service.summary()


@router.get('/estimates', response_model=EstimatesPage)
def estimates(after: str | None = None, limit: int = Query(50, ge=1, le=200),
              owner: Principal = Depends(require_owner), service=Depends(get_analysis_service),
              scope=Depends(get_library_scope)):
    try:
        return service.estimates(after, limit, scope)
    except ValidationError:
        raise HTTPException(422, 'Invalid estimates cursor')


def run_owner(owner: Principal = Depends(require_owner)):
    if not is_real_user(owner):
        raise HTTPException(403, 'Analysis runs require an owner account')
    return owner


@router.post('/runs', response_model=RunResponse, responses={409: {'model': RunConflictResponse}})
def create_run(body: RunRequest, owner: Principal = Depends(run_owner), service=Depends(get_analysis_service)):
    try:
        return service.runs.start(body.requestId, body.mode, body.scope, body.relPaths, owner.user_id)
    except RunConflict as exc:
        raise HTTPException(409, exc.detail)


@router.get('/runs/preview', response_model=RunPreview, responses={409: {'model': RunConflictResponse}})
def preview_run(mode: RunMode = 'all', scope: RunScope = 'library',
                relPaths: list[str] = Query(default=[], max_length=500),
                owner: Principal = Depends(run_owner), service=Depends(get_analysis_service)):
    if scope == 'library' and relPaths or scope == 'song' and len(relPaths) != 1 or scope == 'selection' and not relPaths:
        raise HTTPException(422, 'relPaths must match scope')
    try:
        return service.runs.preview(mode, scope, relPaths)
    except RunConflict as exc:
        raise HTTPException(409, exc.detail)


@router.get('/{album}/{file}/replaygain', response_model=ReplayGain | None)
def replaygain(album: str, file: str, service=Depends(get_music_service), scope=Depends(get_library_scope)):
    try:
        path = resolve_rel_path(service.config.base_music_dir, f'{album}/{file}')
        rel = rel_path_for(service.config.base_music_dir, path)
        if not path.is_file() or path.suffix.lower() not in service.music_repo.AUDIO_EXTENSIONS or not scope.allows(rel):
            raise HTTPException(404, 'Track not found')
    except (ValidationError, ValueError, OSError):
        raise HTTPException(404, 'Track not found')
    # The catalog's projection validates all album member signatures as a group.
    for entry in service.music_repo.scan_albums():
        for song in entry.tracks:
            if song.path == path:
                return (song.analysis or {}).get('replayGain')
    return None


@router.get('/{relPath:path}', response_model=AnalysisView)
def read(relPath: str, service=Depends(get_analysis_service), scope=Depends(get_library_scope)):
    rel, path = track(service, relPath, scope)
    return service.view(rel, path)


@router.put('/{relPath:path}/fixed', response_model=AnalysisView,
            responses={409: {'model': AnalysisView, 'description': 'Revision conflict; current row'}})
def fixed(relPath: str, body: FixedRequest, owner: Principal = Depends(require_owner),
          service=Depends(get_analysis_service)):
    rel, path = track(service, relPath)
    fields = body.model_dump(exclude_unset=True, exclude={'rev'})
    ok, view = service.fix(rel, path, body.rev, fields, owner.user_id)
    return view if ok else JSONResponse(view, status_code=409)
