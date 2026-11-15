"""Composition for the single, authenticated change stream."""
from fastapi import APIRouter, Depends

from app.dependencies import DependencyContainer, get_container
from app.infra.change_bus import ChangeEvent, HelloEvent
from app.infra.event_stream import ChangeEventResponse
from app.infra.identity import Principal, current_principal

router = APIRouter(tags=['events'])


@router.get('/api/events', status_code=200, response_class=ChangeEventResponse, responses={
    200: {'model': HelloEvent | ChangeEvent,
          'content': {'text/event-stream': {'schema': {'type': 'object'}}}, 'description': (
        'SSE: hello carries bootId and visible revisions on every connection; change carries an area nudge '
        'with a monotonic id. Last-Event-ID is not replayed: resync displayed data using hello. '
        'One stream per client, shared by all its screens. Heartbeat comments every 15 seconds.'
    )},
})
async def events(container: DependencyContainer = Depends(get_container),
                 principal: Principal = Depends(current_principal)):
    accounts = (f'me:{user.user_id}' for user in container.get_token_store().list_users()) if principal.is_owner else ()
    client = container.change_bus.subscribe(principal, accounts)
    return ChangeEventResponse(container.change_bus, client)
