"""The account-scoped jobs ledger API."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.infra.jobs import JobConflict
from app.infra.jobs_runtime import dispatch, snapshot
from app.dependencies import conditional, get_container
from app.infra.identity import current_principal
from app.infra.identity import Principal

router = APIRouter(prefix='/api/jobs', tags=['jobs'])


class WaitingOn(BaseModel):
    name: str
    state: str


class JobView(BaseModel):
    id: str
    kind: Literal['download', 'import', 'match', 'lyrics-search', 'lyrics-helper', 'stems', 'scan', 'upload', 'analysis', 'library-edit', 'source-install']
    label: str
    state: Literal['queued', 'waiting', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']
    total: int
    succeeded: int
    failed: int
    skipped: int
    percent: float
    phase: str | None
    item: str | None
    waitingOn: WaitingOn | None
    startedAt: float | None
    endedAt: float | None
    attempt: int
    failedCount: int
    canCancel: bool
    canRetry: bool


class JobsView(BaseModel):
    jobs: list[JobView]
    degraded: list[str]


class ItemView(BaseModel):
    idx: int
    attempt: int
    item: str
    rel_path: str | None
    state: str
    reason: str | None
    detail: dict


class ItemsView(BaseModel):
    items: list[ItemView]


class ActionView(BaseModel):
    id: str
    attempt: int


class RetryRequest(BaseModel):
    attempt: int | None = None


class ClearView(BaseModel):
    cleared: int


def visible(container, principal, job_id):
    job = container.get_jobs().get(job_id)
    if not job or (not principal.is_owner and job['starter_user_id'] != principal.user_id):
        raise HTTPException(404, 'job-not-found')
    return job


@router.get('', response_model=JobsView)
@conditional(('jobs', 'helpers'))
def list_jobs(principal: Principal = Depends(current_principal), container=Depends(get_container)):
    return snapshot(container, principal)


@router.post('/clear', response_model=ClearView)
def clear_jobs(principal: Principal = Depends(current_principal), container=Depends(get_container)):
    return {'cleared': container.get_jobs().clear(principal.user_id, all_users=principal.is_owner)}


@router.post('/{job_id}/clear', response_model=ClearView)
def clear_job(job_id: str, principal: Principal = Depends(current_principal), container=Depends(get_container)):
    visible(container, principal, job_id)
    try:
        return {'cleared': container.get_jobs().clear_one(job_id)}
    except JobConflict as exc:
        raise HTTPException(409, str(exc))


@router.get('/{job_id}/items', response_model=ItemsView)
def job_items(job_id: str, state: str | None = None, principal: Principal = Depends(current_principal), container=Depends(get_container)):
    visible(container, principal, job_id)
    return {'items': [{**i, 'detail': {k: v for k,v in i['detail'].items() if not k.startswith('_')}} for i in container.get_jobs().items(job_id, state)]}


@router.post('/{job_id}/cancel', response_model=ActionView)
def cancel_job(job_id: str, principal: Principal = Depends(current_principal), container=Depends(get_container)):
    job = visible(container, principal, job_id)
    if job['kind'] == 'upload':
        container.get_uploads().stop(job_id, principal)
        return {'id': job_id, 'attempt': job['attempt']}
    try:
        if job['kind'] == 'analysis':
            container.get_analysis_service().cancel_job(job_id)
        else:
            container.get_jobs().cancel(job_id, job['attempt'])
    except JobConflict as exc:
        raise HTTPException(409, str(exc))
    # Commit cancellation first. Lease/result paths also check the ledger, so
    # a concurrent result cannot publish after cancellation has won.
    if job['kind'] == 'lyrics-helper':
        container.get_lyrics_service().cancel_processing(job_id)
    elif job['kind'] == 'stems':
        queue = container.get_stems_service().queue
        with queue._lock:
            queue._ensure_loaded()
            for row in list(queue._rows.values()):
                if row.job_id == job_id:
                    queue.remove(row.album, row.file)
    elif job['kind'] in ('import', 'match'):
        service = container._services.get('export_import_service')
        if service:
            service.cancel_resolution(job_id)
    container.get_progress_tracker().complete_progress(job_id, 'cancelled')
    return {'id': job_id, 'attempt': job['attempt']}


@router.post('/{job_id}/retry', response_model=ActionView)
async def retry_job(job_id: str, data: RetryRequest | None = None, principal: Principal = Depends(current_principal), container=Depends(get_container)):
    job = visible(container, principal, job_id)
    ledger = container.get_jobs()
    if job['state'] in ('queued', 'running') and job['attempt'] > 1 and (data is None or data.attempt in (None, job['attempt']-1)):
        return {'id': job_id, 'attempt': job['attempt']}
    try:
        # Resolve the original actor before consuming an attempt.
        from app.infra.jobs_runtime import starter_for
        starter_for(container, job)
        attempt, changed = ledger.retry(job_id, data.attempt if data and data.attempt is not None else job['attempt'])
    except (JobConflict, ValueError):
        raise HTTPException(409, 'not-retryable')
    if changed:
        try:
            dispatch(container, job_id)
        except Exception:
            ledger.finish(job_id, attempt, error=True)
            raise HTTPException(409, 'not-retryable')
    return {'id': job_id, 'attempt': attempt}
