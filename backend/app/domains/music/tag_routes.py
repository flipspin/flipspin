"""Scoped tag reads, owner edits and journal history. Existing phone routes stay intact."""

from app.infra.request_paths import routing_path
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.dependencies import get_tag_edits, get_library_scope, get_missing_files
from app.domains.metadata import tagwriter
from app.domains.music.analysis_routes import track
from app.infra.etags import strong_etag
from app.infra.idempotency import Receipts
from app.infra.identity import Principal, require_owner

router = APIRouter(prefix='/api/library', tags=['tags'])
Value = str | int | float | bool | list[str] | None


class TagPatch(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    set: dict[str, Value]
    rev: str | None = None
    id3Version: int = Field(4, ge=3, le=4)

    @field_validator('set')
    @classmethod
    def validate_fields(cls, value):
        if (tagwriter.GAIN_TAG_FIELDS | {'analysisMarker', 'camelot'}) & value.keys():
            raise ValueError('Reserved field')
        try:
            return tagwriter.normalize(value)
        except tagwriter.TagError as error:
            raise ValueError(error.reason) from error


class TagItem(BaseModel):
    model_config = ConfigDict(extra='forbid')
    relPath: str
    rev: str


class TagBatch(TagPatch):
    items: list[TagItem] = Field(min_length=1, max_length=500)


class TagView(BaseModel):
    fields: dict[str, Value]
    format: str
    writable: bool
    reason: str | None = None
    rev: str


class TagConflictDetail(BaseModel):
    reason: str
    current: TagView | None = None


class TagConflict(BaseModel):
    detail: TagConflictDetail


class EditResult(BaseModel):
    editId: str | None
    rev: str
    changed: bool


class BatchResult(BaseModel):
    editId: str
    progressId: str


class UndoResult(BaseModel):
    editId: str


class TagFileIdentity(BaseModel):
    model_config = ConfigDict(extra='allow')
    size: int
    mtimeNs: int
    tagSha: str


class TagEditRow(BaseModel):
    model_config = ConfigDict(extra='allow')
    edit_id: str
    idx: int
    rel_before: str
    rel_after: str
    identity_before: str | TagFileIdentity | None
    identity_after: str | TagFileIdentity | None
    fields_before: dict[str, Value] | None
    fields_after: dict[str, Value] | None
    recycle_path: str | None
    state: str
    reason: str | None
    newer_edit_id: str | None


class TagEditDetail(BaseModel):
    model_config = ConfigDict(extra='allow')
    id: str
    kind: str
    undoes: str | None
    principal: str
    state: str
    plan_hash: str | None
    created_at: float
    applied_at: float | None
    job_id: str | None
    expires_at: float
    rows: list[TagEditRow]


def failure(error):
    detail = {'reason': error.reason}
    if error.current is not None:
        detail['current'] = error.current
    raise HTTPException(error.status, detail)


def receipt(request, principal, service, body, action, status=200):
    key = request.headers.get('idempotency-key')
    if not key:
        return action()
    if len(key) > 200:
        raise HTTPException(422, 'Idempotency-Key too long')
    receipts = Receipts(service.config.jobs_file)
    route = f'{request.method} {routing_path(request)}'
    payload = {'body': body, 'ifMatch': request.headers.get('if-match')}
    prior = receipts.begin(key, principal.user_id, route, payload)
    if prior:
        return JSONResponse(prior[1], status_code=prior[0])
    try:
        result = action()
        receipts.finish(key, principal.user_id, route, status, result)
        return result
    except HTTPException as error:
        receipts.finish(key, principal.user_id, route, error.status_code, {'detail': error.detail})
        raise
    except Exception:
        receipts.abandon(key, principal.user_id, route)
        raise


@router.post('/tags/batch', status_code=202, response_model=BatchResult)
def batch(body: TagBatch, request: Request, background: BackgroundTasks,
          principal: Principal = Depends(require_owner), service=Depends(get_tag_edits)):
    def action():
        try:
            items = []
            for item in body.items:
                rel, _ = track(service, item.relPath)
                items.append({'relPath': rel, 'rev': item.rev})
            if len({i['relPath'] for i in items}) != len(items):
                raise HTTPException(422, 'Duplicate paths')
            edit_id, job_id = service.batch(items, body.set, principal.user_id, body.id3Version)
            background.add_task(service.run_batch, edit_id)
            return {'editId': edit_id, 'progressId': job_id}
        except tagwriter.TagError as error:
            failure(error)
        except OSError:
            failure(tagwriter.TagError('write-failed', 500))
    return receipt(request, principal, service, body.model_dump(), action, 202)


@router.get('/tags/{relPath:path}', response_model=TagView, response_model_exclude_none=True)
def read(relPath: str, response: Response, service=Depends(get_tag_edits), scope=Depends(get_library_scope)):
    _, path = track(service, relPath, scope)
    try:
        body = tagwriter.read(path)
        response.headers['ETag'] = body['rev']
        return body
    except tagwriter.TagError as error:
        failure(error)


@router.put('/tags/{relPath:path}', response_model=EditResult,
            responses={409: {'model': TagConflict, 'description': 'File changed; current tags when available'}})
def edit(relPath: str, body: TagPatch, request: Request, principal: Principal = Depends(require_owner),
         service=Depends(get_tag_edits)):
    def action():
        _, path = track(service, relPath)
        expected = request.headers.get('if-match') or body.rev
        if not expected:
            raise HTTPException(422, 'rev or If-Match required')
        try:
            return service.edit(path, body.set, expected=expected, principal=principal.user_id, id3_version=body.id3Version)
        except tagwriter.TagError as error:
            failure(error)
        except OSError:
            failure(tagwriter.TagError('write-failed', 500))
    return receipt(request, principal, service, body.model_dump(), action)


@router.get('/edits')
def history(request: Request, response: Response, after: str | None = None, limit: int = Query(50, ge=1, le=200),
            principal: Principal = Depends(require_owner), service=Depends(get_tag_edits)):
    with service.repository.connection() as db:
        cursor = db.execute('SELECT rowid FROM library_edit WHERE id=?', (after,)).fetchone() if after else None
        if after and cursor is None:
            raise HTTPException(422, 'Invalid cursor')
        entries = db.execute('SELECT * FROM library_edit WHERE rowid < ? ORDER BY rowid DESC LIMIT ?',
                             (cursor[0] if cursor else 2**63 - 1, limit + 1)).fetchall()
    rows = []
    for entry in entries[:limit]:
        edit = service.get(entry['id'])
        expired = edit['expires_at'] <= service.now()
        rows.append({'id': edit['id'], 'kind': edit['kind'], 'principal': edit['principal'], 'createdAt': edit['created_at'],
                     'state': edit['state'], 'counts': {state: sum(r['state'] == state for r in edit['rows']) for state in ('applied', 'skipped', 'failed')},
                     'undoable': not expired and edit['kind'] != 'move' and edit['state'] in ('applied', 'partial') and any(r['state'] == 'applied' for r in edit['rows']), **({'reason': 'expired'} if expired else {})})
    body = {'entries': rows, 'after': rows[-1]['id'] if len(entries) > limit else None}
    etag = strong_etag(body)
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag})
    response.headers['ETag'] = etag
    return body


@router.get('/edits/{editId}', response_model=TagEditDetail)
def detail(editId: str, principal: Principal = Depends(require_owner), service=Depends(get_tag_edits)):
    try:
        entry = service.get(editId)
        # Private native tag backups stay in SQLite, including artwork/vendor blobs.
        return {**entry, 'rows': [{k: v for k, v in r.items() if k != 'refs_snapshot'} for r in entry['rows']]}
    except tagwriter.TagError as error:
        failure(error)


@router.post('/edits/{editId}/undo', status_code=202, response_model=UndoResult)
def undo(editId: str, request: Request, background: BackgroundTasks, principal: Principal = Depends(require_owner),
         service=Depends(get_tag_edits), missing=Depends(get_missing_files)):
    def action():
        try:
            undo_id, created = service.start_undo(editId, principal.user_id)
            if created:
                background.add_task(service.run_undo, undo_id)
            return {'editId': undo_id}
        except tagwriter.TagError as error:
            failure(error)
        except OSError:
            failure(tagwriter.TagError('write-failed', 500))
    return receipt(request, principal, service, {'editId': editId}, action, 202)
