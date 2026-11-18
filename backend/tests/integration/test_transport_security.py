"""Audit regressions at the HTTP transport and long-lived authorization boundaries."""
import asyncio
import socket
import threading
import time

import httpx
import pytest
import requests
import uvicorn
from fastapi.testclient import TestClient
from starlette.responses import FileResponse

from app.main import app
from app.infra.identity import current_principal
from app.infra.progress import progress_principal
from tests.integration.test_change_events import Connection
from tests.integration import test_helpers, test_stems_routes
from tests.integration.test_playlist_ownership import house as house
from tests.integration.test_stems_routes import (
    _ready, _track_url,
)


media_house = test_helpers.house
library = test_stems_routes.library
stems_client = test_stems_routes.client


@pytest.fixture
def live_http(media_house, monkeypatch):
    monkeypatch.setattr(app.state.config, 'api_token', 'transport-test-secret')
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    server = uvicorn.Server(uvicorn.Config(app, http='h11', lifespan='off', log_level='error'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(.01)
        assert server.started
        with requests.Session() as session:
            session.trust_env = False
            yield session, f'http://127.0.0.1:{listener.getsockname()[1]}', media_house
    finally:
        server.should_exit = True
        thread.join(5)
        listener.close()
        assert not thread.is_alive()


def test_malformed_host_cannot_read_or_write_over_uvicorn_h11(live_http):
    session, origin, house = live_http
    media = origin + '/api/media/Album/Song.mp3'
    assert session.get(media, timeout=3).status_code == 401
    headers = {'Host': 'evil/api/health#'}
    reply = session.get(media, headers=headers, timeout=3)
    assert reply.status_code == 400 and reply.content != b'audio'
    playlists = house.container.config.playlist_dir
    before = set(playlists.glob('*.json'))
    reply = session.post(origin + '/api/playlists', headers=headers, json={'name': 'transport-probe'}, timeout=3)
    assert reply.status_code == 400
    assert set(playlists.glob('*.json')) == before


@pytest.mark.parametrize('ranges', [
    'bytes=' + ','.join(f'{i * 3}-{i * 3}' for i in range(100)),
    'bytes=' + '0' * 1024 + '-1',
], ids=['multiple', 'oversized'])
def test_media_caps_range_before_framework_parser_over_real_http(live_http, monkeypatch, ranges):
    session, origin, house = live_http
    (house.container.config.base_music_dir / 'Album/Song.mp3').write_bytes(b'x' * 1000)

    seen = []
    original = FileResponse._parse_range_header

    def record(*args, **kwargs):
        seen.append(args[0])
        return original(*args, **kwargs)

    monkeypatch.setattr(FileResponse, '_parse_range_header', staticmethod(record))
    reply = session.get(origin + '/api/media/Album/Song.mp3', timeout=3,
                        headers={'Authorization': house.admin.headers['Authorization'], 'Range': ranges})
    assert not seen, 'unbounded Range reached the framework parser'
    assert reply.status_code == 200
    assert reply.content == b'x' * 1000 and 'Content-Range' not in reply.headers


def test_stems_caps_multiple_oversized_and_duplicate_ranges(stems_client, monkeypatch):
    _ready(stems_client)
    url = _track_url() + '/drums'
    full = stems_client.get(url).content
    for value in ['bytes=0-1,4-5', 'bytes=' + '0' * 1024 + '-1']:
        reply = stems_client.get(url, headers={'Range': value})
        assert reply.status_code == 200 and reply.content == full
    reply = stems_client.get(url, headers=[('Range', 'bytes=0-1'), ('Range', 'bytes=4-5')])
    assert reply.status_code == 200 and reply.content == full
    partial = stems_client.get(url, headers={'Range': 'bytes=1-3'})
    assert partial.status_code == 206 and partial.content == full[1:4]
    assert stems_client.get(url, headers={'Range': f'bytes={len(full)}-'}).status_code == 416


@pytest.mark.asyncio
@pytest.mark.parametrize('removal', ['self', 'owner', 'account'])
@pytest.mark.parametrize('kind', ['change', 'progress'])
async def test_revocation_closes_live_streams_before_returning(house, removal, kind):
    _, owner = house.owner('Owner')
    user_id, member = house.member('Member')
    made = member.post('/api/me/devices', json={'label': 'Stream device'}).json()
    token = made['token']
    container = app.state.container
    tracker = container.get_progress_tracker()
    attribution = progress_principal.set(house.store.resolve(token))
    try:
        tracker.create_progress('revocation-test', total=3)
    finally:
        progress_principal.reset(attribution)
    stream = Connection(app, [(b'authorization', f'Bearer {token}'.encode())])
    if kind == 'progress':
        # Reuse the transport harness with the progress endpoint.
        async def application(scope, receive, send):
            scope = {**scope, 'path': '/api/download-progress-stream/revocation-test',
                     'raw_path': b'/api/download-progress-stream/revocation-test'}
            await app(scope, receive, send)
        stream.application = application
    survivor = Connection(app, [(b'authorization', member.headers['Authorization'].encode())])
    try:
        assert (await stream.start())['status'] == 200
        await stream.next_frame()
        assert (await survivor.start())['status'] == 200
        await survivor.next_frame()
        path = {'self': f'/api/me/devices/{made["device"]["id"]}',
                'owner': f'/api/users/{user_id}/devices/{made["device"]["id"]}',
                'account': f'/api/users/{user_id}'}[removal]
        caller = member if removal == 'self' else owner
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url='http://localhost') as client:
            reply = await client.delete(path, headers={'Authorization': caller.headers['Authorization']})
        assert reply.status_code == 200, reply.text
        assert house.store.resolve(token) is None
        container.changes.bump(f'me:{user_id}', ['after-revocation'])
        tracker.update_progress('revocation-test', 'after-revocation')
        # A closed response may have an empty terminating body, but no event.
        await asyncio.wait_for(asyncio.shield(stream.task), .3)
        remaining = []
        while not stream.outgoing.empty():
            remaining.append(stream.outgoing.get_nowait())
        assert not any(m.get('body') for m in remaining)
        if removal == 'account':
            await asyncio.wait_for(asyncio.shield(survivor.task), .3)
        else:
            while f'me:{user_id}' not in await survivor.next_frame():
                pass
        assert TestClient(app, headers={'Authorization': f'Bearer {token}'}).get('/api/users').status_code == 401
    finally:
        await stream.close()
        await survivor.close()


@pytest.mark.parametrize('path', ['/api/events', '/api/download-progress-stream/stale-principal'])
def test_stream_registration_rejects_a_principal_resolved_before_revocation(house, path):
    user_id, owner = house.owner('Owner')
    made = owner.post('/api/me/devices', json={'label': 'Stale device'}).json()
    captured = house.store.resolve(made['token'])
    app.state.container.get_progress_tracker().create_progress('stale-principal', total=1)
    assert owner.delete(f'/api/me/devices/{made["device"]["id"]}').status_code == 200
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[current_principal] = lambda: captured
    try:
        assert owner.get(path).status_code == 401
        assert not app.state.container.change_bus.streams._streams
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


def test_framework_upgrade_preserves_json_without_content_type(house):
    _, owner = house.owner('Owner')
    reply = owner.post('/api/me/label', content='{"label":"Updated owner"}')
    assert reply.status_code == 200, reply.text
    assert reply.json()['user']['label'] == 'Updated owner'
