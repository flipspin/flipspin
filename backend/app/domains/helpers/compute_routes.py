"""Owner controls and one typed Background work read model."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.dependencies import conditional, get_container
from app.infra.identity import Principal, require_helper, require_owner
from .mac_worker import MacWorker

router = APIRouter(prefix='/api/compute', tags=['compute'], dependencies=[Depends(require_owner)])
helper_router = APIRouter(prefix='/api/helpers', tags=['helpers'])
Kind = Literal['align', 'transcribe', 'stems', 'analysis']
Placement = Literal['helpers', 'helpers-then-nest', 'anywhere']
ComputeWaitReason = Literal['paused', 'off', 'hours', 'battery', 'thermal', 'memory', 'no-engine', 'no-cgroup',
                            'no-helper', 'no-capable-helper', 'helpers-offline', 'helpers-busy', 'engine-disabled', 'helpers-only']


class KindPolicy(BaseModel):
    kind: str
    placement: Placement
    paused: bool
    nestAfterS: int
    libraryPass: Literal['auto', 'ask', 'window']
    requiredMemoryBytes: int


class KindUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    placement: Placement | None = None
    paused: bool | None = None
    libraryPass: Literal['auto', 'ask', 'window'] | None = None


class WorkWindow(BaseModel):
    days: list[int] = Field(min_length=1, max_length=7)
    startMinute: int = Field(ge=0, le=1439)
    endMinute: int = Field(ge=0, le=1439)

    @model_validator(mode='after')
    def valid_days(self):
        if len(set(self.days)) != len(self.days) or any(d < 0 or d > 6 for d in self.days):
            raise ValueError('days must be distinct weekdays from 0 to 6')
        return self


class WorkerLimits(BaseModel):
    pace: Literal['fast', 'gentle', 'off'] = 'fast'
    paused: bool = False
    window: WorkWindow | None = None
    onlyCharging: bool = False
    cpuPercent: int = Field(50, ge=1, le=100)
    maxTempC: int = Field(85, ge=40, le=100)
    resumeTempC: int = Field(75, ge=30, le=99)
    use: dict[Kind, bool] = Field(default_factory=dict)
    installEverything: bool = False

    @model_validator(mode='after')
    def temperatures(self):
        if self.resumeTempC >= self.maxTempC:
            raise ValueError('resume temperature must be below stop temperature')
        return self


class Computer(MacWorker):
    limits: WorkerLimits


class RunningWork(BaseModel):
    workerId: str
    title: str
    progress: float | None


class KindSummary(BaseModel):
    kind: Kind
    policy: KindPolicy
    waiting: int
    oldestAt: float | None
    failed: int
    running: list[RunningWork]
    reason: ComputeWaitReason | None
    waitingFor: str | None
    nestMemoryBytes: int


class ComputeSummary(BaseModel):
    paused: bool
    waiting: int
    kinds: list[KindSummary]
    computers: list[Computer]


class PauseRequest(BaseModel):
    paused: bool


def computer(container, identity):
    if identity == 'nest':
        return container.get_nest_helper().view()
    worker = next((h for h in container.get_compute().worker.helpers()
                   if h['id'] == identity and h['state'] != 'revoked'), None)
    if not worker:
        raise HTTPException(404, 'Computer not found')
    return worker


@router.get('/summary', response_model=ComputeSummary)
@conditional(('jobs', 'helpers', 'config'))
def summary(container=Depends(get_container)):
    container.get_stems_service()
    container.get_analysis_service()
    return container.get_compute().summary(container.get_nest_helper().view())


@router.put('/kinds/{kind}', response_model=KindPolicy)
def update_kind(kind: Kind, body: KindUpdate, container=Depends(get_container)):
    compute = container.get_compute()
    if body.placement and body.placement != 'helpers':
        required = compute.settings.policy(kind)['requiredMemoryBytes']
        available = container.get_nest_helper().view().get('memoryBytes') or 0
        if required > available:
            raise HTTPException(409, {'code': 'memory', 'requiredBytes': required, 'availableBytes': available})
    with compute.worker.lock:
        result = compute.settings.save_policy(kind, body.model_dump(exclude_none=True))
        if kind == 'align':
            compute.settings.save_policy('transcribe', body.model_dump(exclude_none=True))
        compute.defer_blocked()
    container.get_nest_helper().refresh()
    return result


@router.put('/computers/{identity}', response_model=WorkerLimits)
def update_computer(identity: str, body: WorkerLimits, container=Depends(get_container)):
    worker = computer(container, identity)
    if body.onlyCharging and not worker.get('powerReadable'):
        raise HTTPException(409, {'code': 'power-unavailable'})
    compute = container.get_compute()
    if worker.get('nest'):
        current = compute.settings.limits(worker)
        for field in compute.settings.locked_limits():
            if body.model_dump()[field] != current[field]:
                raise HTTPException(409, {'code': 'env-locked', 'field': field})
    with compute.worker.lock:
        result = compute.settings.save_limits(worker, body.model_dump())
        compute.defer_blocked()
    container.get_nest_helper().refresh()
    return result


@router.put('/pause', response_model=PauseRequest)
def pause(body: PauseRequest, container=Depends(get_container)):
    compute = container.get_compute()
    with compute.worker.lock:
        compute.settings.pause(body.paused)
        compute.defer_blocked()
    return body


@helper_router.get('/limits', response_model=WorkerLimits)
def own_limits(helper: Principal = Depends(require_helper), container=Depends(get_container)):
    return container.get_compute().settings.limits({'id': helper.device_id})
