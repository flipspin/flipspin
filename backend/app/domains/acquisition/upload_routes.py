"""Resumable upload transport; bodies never enter the music root."""
import asyncio
from email.utils import formatdate

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from app.dependencies import get_container

from .models import AcquisitionError
from .routes import call, person
from .uploads import Batch, BatchView, Check, CheckView, Decision, UploadSpace

router = APIRouter(prefix='/api/uploads', tags=['uploads'])


def uploads(container=Depends(get_container)):
    return container.get_uploads()


@router.get('/space', response_model=UploadSpace)
def upload_space(principal=Depends(person), service=Depends(uploads)):
    return service.pipeline.space()


@router.post('/check', response_model=CheckView)
async def check_uploads(data: Check, principal=Depends(person), service=Depends(uploads)):
    return await asyncio.to_thread(call, service.check, data, principal)


@router.post('/batches', response_model=BatchView)
async def create_batch(data: Batch, principal=Depends(person), service=Depends(uploads)):
    return await asyncio.to_thread(call, service.create, data, principal)


@router.get('/batches/{id}', response_model=BatchView)
def get_batch(id: str, principal=Depends(person), service=Depends(uploads)):
    result = call(service.view, id, principal)
    if result['phase'] == 'subiendo':
        service.kick(id)
    return result


@router.post('/batches/{id}/start', response_model=BatchView)
async def start_batch(id: str, data: Decision, principal=Depends(person), service=Depends(uploads)):
    return call(service.start, id, principal, data.duplicates)


@router.post('/batches/{id}/stop', response_model=BatchView)
def stop_batch(id: str, principal=Depends(person), service=Depends(uploads)):
    return call(service.stop, id, principal)


@router.post('/batches/{id}/retry', response_model=BatchView)
async def retry_batch(id: str, principal=Depends(person), service=Depends(uploads)):
    return call(service.retry, id, principal)


@router.post('/batches/{id}/files/{sha}/fail', response_model=BatchView)
def fail_upload(id: str, sha: str, principal=Depends(person), service=Depends(uploads)):
    row = call(service.head, id, sha, principal)
    if row['state'] in ('por-subir', 'subiendo'):
        service.fail(row, 'fallo-subida')
        service.reconcile(id, principal)
    return call(service.view, id, principal)


def headers(row):
    return {'Upload-Offset': str(row['offset']), 'Tus-Resumable': '1.0.0',
            'Upload-Expires': formatdate(row['updated']+86400, usegmt=True), 'Cache-Control': 'no-store'}


@router.head('/batches/{id}/files/{sha}')
def upload_offset(id: str, sha: str, principal=Depends(person), service=Depends(uploads)):
    return Response(status_code=200, headers=headers(call(service.head, id, sha, principal)))


@router.patch('/batches/{id}/files/{sha}', responses={204: {}, 409: {}, 413: {}, 460: {}, 507: {}})
async def upload_chunk(id: str, sha: str, request: Request, upload_offset: int = Header(ge=0),
                       upload_checksum: str | None = Header(None, pattern=r'^[a-f0-9]{64}$'),
                       principal=Depends(person), service=Depends(uploads)):
    # Bounded pieces also bound memory for unknown/chunked Content-Length.
    row = call(service.head, id, sha, principal)
    if upload_offset != row['offset']:
        raise HTTPException(409, detail={'reason': 'offset-mismatch'}, headers=headers(row))
    try:
        service.pipeline.check_space()
    except AcquisitionError as error:
        service.fail(row, 'sin-espacio')
        service.reconcile(id, principal)
        raise HTTPException(error.status, detail={'reason': error.reason}) from error
    chunk = bytearray()
    async for piece in request.stream():
        if len(chunk)+len(piece) > 4 * 1024 * 1024:
            raise HTTPException(413, detail={'reason': 'muy-grande'})
        chunk.extend(piece)
    try:
        result = await asyncio.to_thread(service.append, id, sha, principal, upload_offset, chunk, upload_checksum)
    except AcquisitionError as error:
        raise HTTPException(error.status, detail={'reason': error.reason}) from error
    if result['state'] == 'importando':
        service.kick(id)
    return Response(status_code=204, headers=headers(result))
