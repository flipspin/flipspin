"""Exercise the registered SSE route through ASGI, including real middleware/auth."""
import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.dependencies import get_container
from app.infra.change_bus import ChangeBus, revision_token
from app.infra.changes import Changes
from app.infra.event_stream import ChangeEventResponse
from app.infra.identity import Principal, get_config, require_api_token
from fastapi.routing import iter_route_contexts

from app.main import app

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/change-events.json').read_text())
MEMBER = Principal('account-a', 'Member')
OWNER = Principal('owner-account', 'Owner', 'owner')


class Connection:
    def __init__(self, application, headers=(), *, blocked=False):
        self.application = application
        self.headers = [(b'host', b'localhost'), *headers]
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        self.buffer = b''
        self.blocked = blocked
        self.send_cancelled = asyncio.Event()

    async def send(self, message):
        if self.blocked and message['type'] == 'http.response.body':
            try:
                await asyncio.Event().wait()
            finally:
                self.send_cancelled.set()
        await self.outgoing.put(message)

    async def start(self):
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'}, 'http_version': '1.1',
                 'method': 'GET', 'scheme': 'http', 'path': '/api/events', 'raw_path': b'/api/events',
                 'query_string': b'', 'root_path': '', 'headers': self.headers,
                 'client': ('192.0.2.10', 50000), 'server': ('testserver', 80)}
        self.incoming.put_nowait({'type': 'http.request', 'body': b'', 'more_body': False})
        self.task = asyncio.create_task(self.application(scope, self.incoming.get, self.send))
        start = await asyncio.wait_for(self.outgoing.get(), 2)
        assert start['type'] == 'http.response.start'
        return start

    async def next_frame(self, timeout=2):
        async def read():
            while b'\n\n' not in self.buffer:
                message = await self.outgoing.get()
                assert message['type'] == 'http.response.body'
                self.buffer += message.get('body', b'')
            frame, self.buffer = self.buffer.split(b'\n\n', 1)
            return frame.decode()
        return await asyncio.wait_for(read(), timeout)

    async def close(self):
        self.incoming.put_nowait({'type': 'http.disconnect'})
        try:
            await asyncio.wait_for(self.task, 2)
        finally:
            if not self.task.done():
                self.task.cancel()


@pytest.fixture
def stream_app(monkeypatch, config):
    changes = Changes({'library': lambda: (7, 2)})
    bus = ChangeBus(changes, debounce=.01)
    resolver = SimpleNamespace(resolve=lambda token: {'member-token': MEMBER, 'owner-token': OWNER}.get(token),
                               list_users=lambda: [SimpleNamespace(user_id='account-a'), SimpleNamespace(user_id='account-b')])
    container = SimpleNamespace(change_bus=bus, get_token_store=lambda: resolver)
    config.api_token = 'configured-secret'
    monkeypatch.setattr(app.state, 'identity_resolver', lambda request: resolver)
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[get_container] = lambda: container
    app.dependency_overrides[get_config] = lambda: config
    yield changes, bus
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


@asynccontextmanager
async def connected(headers):
    connection = Connection(app, headers)
    start = await connection.start()
    try:
        yield connection, start
    finally:
        await connection.close()


def data(frame):
    return json.loads(next(line.removeprefix('data: ') for line in frame.splitlines() if line.startswith('data: ')))


@pytest.mark.asyncio
@pytest.mark.parametrize('headers', [[], [(b'authorization', b'Bearer wrong-token')]])
async def test_events_is_closed_by_default(stream_app, headers):
    async with connected(headers) as (connection, start):
        assert start['status'] == 401
        assert stream_app[1].client_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize('header', [b'authorization', b'x-krobi-token'])
async def test_header_auth_hello_change_and_no_replay_on_reconnect(stream_app, header):
    changes, bus = stream_app
    token = b'Bearer member-token' if header == b'authorization' else b'member-token'
    headers = [(header, token), (b'last-event-id', b'999999')]
    async with connected(headers) as (connection, start):
        assert start['status'] == 200
        response_headers = dict(start['headers'])
        assert response_headers[b'content-type'].startswith(b'text/event-stream')
        assert response_headers[b'cache-control'] == b'no-cache'
        assert response_headers[b'x-accel-buffering'] == b'no'
        assert b'content-length' not in response_headers
        hello_frame = await connection.next_frame()
        assert hello_frame.startswith('event: hello\n') and 'id:' not in hello_frame
        hello = data(hello_frame)
        assert hello['bootId'] == changes.boot_id and hello['revisions']['library'] == revision_token((7, 2))
        assert 'me:account-b' not in hello['revisions']
        changes.bump('playlists', ['playlist-key'])
        event = await connection.next_frame()
        assert 'event: change\n' in event and event.startswith('id: 1\n')
        assert data(event) == {'area': 'playlists', 'rev': 1, 'ids': ['playlist-key']}
    assert bus.client_count == 0
    changes.bump('playlists')
    async with connected(headers) as (connection, _):
        hello = data(await connection.next_frame())
        assert hello['revisions']['playlists'] == 2
        changes.bump('config')
        assert (await connection.next_frame()).startswith('id: 2\n')
    assert bus.client_count == 0 and not bus.changes._listeners


@pytest.mark.asyncio
async def test_scope_applies_to_hello_and_live_events_through_http(stream_app):
    changes, bus = stream_app
    changes.bump('me:account-b')
    async with connected([(b'authorization', b'Bearer member-token')]) as (member, _):
        async with connected([(b'authorization', b'Bearer owner-token')]) as (owner, _):
            assert 'me:account-b' not in data(await member.next_frame())['revisions']
            assert data(await owner.next_frame())['revisions']['me:account-b'] == 1
            changes.bump('me:account-b')
            changes.bump('me:account-a')
            assert data(await member.next_frame())['area'] == 'me:account-a'
            assert {data(await owner.next_frame())['area'] for _ in range(2)} == {'me:account-a', 'me:account-b'}
    assert bus.client_count == 0


@pytest.mark.asyncio
async def test_default_heartbeat_arrives_on_idle_stream_within_fifteen_seconds(stream_app):
    async with connected([(b'authorization', b'Bearer member-token')]) as (connection, _):
        await connection.next_frame()
        started = asyncio.get_running_loop().time()
        assert (await connection.next_frame(timeout=16)) == ': heartbeat'
        assert 14.5 <= asyncio.get_running_loop().time() - started < 16


@pytest.mark.asyncio
async def test_send_timeout_cancels_blocked_transport_and_removes_subscription():
    bus = ChangeBus(Changes())
    client = bus.subscribe(MEMBER)
    response = ChangeEventResponse(bus, client, send_timeout=.02)
    connection = Connection(response, blocked=True)
    await connection.start()
    await asyncio.wait_for(connection.task, .2)
    assert connection.send_cancelled.is_set() and bus.client_count == 0
    assert client.closed.is_set()


@pytest.mark.asyncio
async def test_overflow_interrupts_a_blocked_send_promptly():
    changes = Changes()
    bus = ChangeBus(changes, queue_size=1, debounce=.001)
    client = bus.subscribe(MEMBER)
    response = ChangeEventResponse(bus, client, send_timeout=.1)
    connection = Connection(response, blocked=True)
    await connection.start()
    changes.bump('library')
    await asyncio.sleep(.01)
    changes.bump('library')
    await asyncio.wait_for(client.closed.wait(), .2)
    await asyncio.wait_for(connection.send_cancelled.wait(), .05)
    await asyncio.wait_for(connection.task, .2)
    assert bus.client_count == 0


@pytest.mark.asyncio
async def test_disconnect_while_idle_cleans_up_without_waiting_for_heartbeat(stream_app):
    _, bus = stream_app
    async with connected([(b'authorization', b'Bearer member-token')]) as (connection, _):
        await connection.next_frame()
        assert bus.client_count == 1
    assert bus.client_count == 0 and not bus.changes._listeners


def test_openapi_declares_stream_and_both_typed_event_shapes():
    route = next(r for r in iter_route_contexts(app.routes) if getattr(r, 'path', '') == CONTRACT['route'])
    assert require_api_token in [d.call for d in route.dependant.dependencies]
    response = app.openapi()['paths']['/api/events']['get']['responses']['200']
    assert set(response['content']) == {'text/event-stream'}
    refs = response['content']['text/event-stream']['schema']['anyOf']
    assert {r['$ref'].rsplit('/', 1)[-1] for r in refs} == {'HelloEvent', 'ChangeEvent'}
    limits = CONTRACT['limits']
    bus = ChangeBus(Changes())
    # Defaults are the public contract, not faster test-time intervals.
    import inspect
    parameters = inspect.signature(ChangeEventResponse).parameters
    assert parameters['heartbeat'].default == limits['heartbeat_seconds']
    assert parameters['send_timeout'].default == limits['send_timeout_seconds']
    assert bus.total_limit == 32


@pytest.mark.asyncio
async def test_bus_shutdown_ends_the_http_stream(stream_app):
    _, bus = stream_app
    async with connected([(b'authorization', b'Bearer member-token')]) as (connection, _):
        await connection.next_frame()
        await bus.close()
        await asyncio.wait_for(connection.task, .2)
    assert bus.client_count == 0
