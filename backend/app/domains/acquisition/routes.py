"""One durable acquisition door, scoped to the signed-in account."""
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse

from app.dependencies import get_container
from app.infra.identity import Principal, current_principal, is_real_user

from .models import AcquisitionError, Request, RetrySelection

router = APIRouter(prefix='/api/acquisition/requests', tags=['acquisition'])


def pipeline(container=Depends(get_container)):
    return container.get_acquisition()


def person(principal: Principal = Depends(current_principal)):
    if not is_real_user(principal):
        raise HTTPException(409, detail={'reason': 'sign-in-required'})
    return principal


def call(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except AcquisitionError as error:
        if error.reason == 'no-sources':
            return JSONResponse(status_code=409, content={'code': 'no-sources'})
        raise HTTPException(error.status, detail={'reason': error.reason})


@router.post('')
async def request_acquisition(data: Request, idempotency_key: str | None = Header(None, max_length=255),
                        principal=Depends(person), service=Depends(pipeline)):
    return call(service.submit, data, principal, key=idempotency_key)


@router.get('')
def list_requests(principal=Depends(person), service=Depends(pipeline)):
    return {'requests': service.store.list(principal.user_id)}


@router.post('/clear')
def clear_requests(principal=Depends(person), service=Depends(pipeline)):
    return {'cleared': service.store.dismiss_finished(principal.user_id)}


@router.post('/{id}/clear', response_model=dict[str, int])
def clear_request(id: str, principal=Depends(person), service=Depends(pipeline)):
    return {'cleared': call(service.store.dismiss_one, id, principal.user_id)}


@router.get('/{id}')
def get_request(id: str, principal=Depends(person), service=Depends(pipeline)):
    return call(service.view, id, principal)


@router.post('/{id}/cancel')
def cancel_request(id: str, principal=Depends(person), service=Depends(pipeline)):
    return call(service.cancel, id, principal)


@router.post('/{id}/retry')
async def retry_request(id: str, data: RetrySelection | None = None, principal=Depends(person), service=Depends(pipeline)):
    return call(service.retry, id, principal, selection=data)
