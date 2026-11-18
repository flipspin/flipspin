"""Revocation fences queued events, response startup and blocked ASGI writes."""
import asyncio

import pytest
from starlette.background import BackgroundTask

from app.infra.change_bus import ChangeBus, ChangeEvent
from app.infra.changes import Changes
from app.infra.event_stream import ChangeEventResponse
from app.infra.identity import Principal


@pytest.mark.asyncio
@pytest.mark.parametrize('blocked_frame', ['hello', 'change'])
@pytest.mark.parametrize('other_loop', [False, True])
async def test_revocation_waits_for_blocked_writes_and_discards_queued_events(blocked_frame, other_loop):
    bus = ChangeBus(Changes())
    client = bus.subscribe(Principal('account', 'Member', device_id='device'))
    sibling = bus.subscribe(Principal('account', 'Member', device_id='other-device'))
    stranger = bus.subscribe(Principal('other-account', 'Other', device_id='stranger'))
    blocked, cancelled = asyncio.Event(), asyncio.Event()
    delivered = []

    async def send(message):
        if f'event: {blocked_frame}'.encode() in message.get('body', b''):
            blocked.set()
            try:
                await asyncio.Event().wait()
                delivered.append(message)
            finally:
                cancelled.set()
        else:
            delivered.append(message)

    async def receive():
        await asyncio.Event().wait()

    response = ChangeEventResponse(bus, client)
    task = asyncio.create_task(response({}, receive, send))
    client.queue.put_nowait((1, ChangeEvent(area='library', rev=1, ids=['in-flight'])))
    await asyncio.wait_for(blocked.wait(), 1)
    client.queue.put_nowait((2, ChangeEvent(area='library', rev=2, ids=['queued'])))
    try:
        if other_loop:
            await asyncio.wait_for(asyncio.to_thread(lambda: asyncio.run(bus.revoke_device('account', 'device'))), 1)
        else:
            await asyncio.wait_for(bus.revoke_device('account', 'device'), 1)
        assert cancelled.is_set() and client.closed.is_set() and client.queue.empty()
        assert not sibling.closed.is_set() and not stranger.closed.is_set()
        assert not any(b'in-flight' in m.get('body', b'') or b'queued' in m.get('body', b'') for m in delivered)
        await asyncio.wait_for(task, 1)
    finally:
        task.cancel()
        await bus.close()


@pytest.mark.asyncio
async def test_revocation_before_response_start_never_sends_hello():
    bus = ChangeBus(Changes())
    client = bus.subscribe(Principal('account', 'Member', device_id='device'))
    await bus.revoke_account('account')
    messages = []

    async def send(message):
        messages.append(message)

    async def receive():
        await asyncio.Event().wait()

    await ChangeEventResponse(bus, client)({}, receive, send)
    assert all(not message.get('body') for message in messages)
    assert bus.client_count == 0 and not bus.streams._streams


@pytest.mark.asyncio
async def test_response_background_tasks_still_run_once_after_revocation():
    bus = ChangeBus(Changes())
    client = bus.subscribe(Principal('account', 'Member', device_id='device'))
    response = ChangeEventResponse(bus, client)
    calls = []

    async def background():
        calls.append('bookkeeping')

    # FastAPI attaches authentication's bookkeeping after the route returns.
    response.background = BackgroundTask(background)
    await bus.revoke_account('account')

    async def send(message):
        pass

    async def receive():
        await asyncio.Event().wait()

    await response({}, receive, send)
    assert calls == ['bookkeeping']
