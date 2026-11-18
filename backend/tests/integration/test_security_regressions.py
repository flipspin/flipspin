"""Security boundary regressions, including the isolated audit reproductions."""
import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from starlette import formparsers

from app.dependencies import get_transfer_service
from app.domains.transfers.repositories import TransferRepository
from app.domains.transfers.services import TransferService
from app.exceptions import ValidationError
from app.main import app
from tests.integration.test_helpers import house as house


@pytest.mark.parametrize('host', [
    'evil/api/health#', 'evil/api/health?', 'user@localhost', 'evil host',
    'localhost:invalid', 'localhost:65536', '[::1', '::1', 'host:',
    '[::1]junk', '[::1]junk:8000', 'localhost..',
])
def test_malformed_host_cannot_bypass_media_auth(house, host):
    client = TestClient(app, client=('192.0.2.10', 50000))
    path = '/api/media/Album/Song.mp3'
    assert client.get(path).status_code == 401
    reply = client.get(path, headers={'Host': host})
    assert reply.status_code == 400, reply.text
    assert reply.content != b'audio'


@pytest.mark.parametrize('path,caller,status', [
    ('/api/stems/agent/result', 'remote', 401),
    ('/api/helpers/jobs/old/result', 'remote', 401),
    ('/api/playlists/spotify-export/parse', 'remote', 401),
    ('/api/stems/agent/result', 'ordinary', 403),
    ('/api/helpers/jobs/old/result', 'ordinary', 403),
])
def test_upload_rejected_before_creating_any_temp_file(house, monkeypatch, path, caller, status):
    made = []
    original = formparsers.SpooledTemporaryFile

    def capture(*args, **kwargs):
        file = original(*args, **kwargs)
        made.append(file)
        return file

    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', capture)
    client = TestClient(app, client=('192.0.2.10', 50000)) if caller == 'remote' else house.admin
    result = client.post(path, data={'id': 'not-a-lease', 'lease': 'old'},
                         files={'drums': ('drums.ogg', b'x' * (2 << 20), 'audio/ogg')})
    assert result.status_code == status, result.text
    assert made == [], 'authorization must precede even the first temporary file'


@pytest.mark.parametrize('method,path,body', [
    ('GET', '/api/users', None),
    ('POST', '/api/me/devices', {'label': 'Extra device'}),
    ('POST', '/api/me/devices', {'label': 'Extra helper', 'helper': True}),
    ('GET', '/api/me/devices', None),
    ('GET', '/api/listar-albums', None),
    ('GET', '/api/compute/summary', None),
    ('POST', '/api/sources/install', {'id': 'example'}),
    ('POST', '/api/me/label', {'label': 'Changed'}),
])
def test_helper_has_no_account_or_application_authority(house, method, path, body):
    before = len(house.store.get_user(house.owner.user_id).devices)
    reply = house.helper.request(method, path, json=body)
    assert reply.status_code == 403, reply.text
    assert len(house.store.get_user(house.owner.user_id).devices) == before


def test_helper_cannot_mint_a_device_that_survives_revocation(house):
    reply = house.helper.post('/api/me/devices', json={'label': 'Extra device'})
    assert reply.status_code == 403, reply.text
    assert house.admin.delete(f'/api/me/devices/{house.id}').status_code == 200
    assert house.helper.get('/api/me').status_code == 401
    assert len(house.store.get_user(house.owner.user_id).devices) == 1


def test_bulk_transfer_cannot_read_external_symlink(house, monkeypatch, tmp_path):
    external = tmp_path / 'outside.txt'
    external.write_bytes(b'OUTSIDE-LIBRARY')
    root = app.state.config.base_music_dir
    (root / 'Album' / 'link.mp3').symlink_to(external)
    seen = []

    def post(url, **kwargs):
        seen.append(kwargs['files']['file'][1].read())
        return Mock()

    monkeypatch.setattr('app.domains.transfers.repositories.requests.post', post)
    cfg = SimpleNamespace(base_music_dir=root)
    logger = logging.getLogger('test')
    service = TransferService(TransferRepository(cfg, logger), cfg, logger)
    app.dependency_overrides[get_transfer_service] = lambda: service
    try:
        reply = house.admin.post('/api/upload-audio-vlc', params={'vlc_ip': '127.0.0.1:9'})
        assert reply.status_code == 400, reply.text
        assert seen == []
    finally:
        app.dependency_overrides.pop(get_transfer_service, None)


@pytest.mark.parametrize('candidate', ['symlink', 'directory'])
def test_shared_transfer_boundary_requires_contained_regular_file(tmp_path, monkeypatch, candidate):
    root = tmp_path / 'Music'
    root.mkdir()
    external = tmp_path / 'outside.txt'
    external.write_bytes(b'OUTSIDE-LIBRARY')
    path = root / 'entry.mp3'
    if candidate == 'symlink':
        path.symlink_to(external)
    else:
        path.mkdir()
    post = Mock()
    monkeypatch.setattr('app.domains.transfers.repositories.requests.post', post)
    repository = TransferRepository(SimpleNamespace(base_music_dir=root), logging.getLogger('test'))
    with pytest.raises(ValidationError):
        repository.send_to_vlc_http('127.0.0.1:9', path)
    post.assert_not_called()


@pytest.mark.parametrize('host', ['attacker.example:8000', 'localhost.attacker.example', '127.0.0.2'])
@pytest.mark.parametrize('fetch_site', [None, 'same-origin'])
def test_loopback_foreign_host_does_not_receive_owner(accounts, host, fetch_site):
    accounts.mint('Owner', 'owner')
    client = TestClient(app, client=('127.0.0.1', 50000))
    headers = {'Host': host}
    if fetch_site:
        headers['Sec-Fetch-Site'] = fetch_site
    reply = client.get('/api/users', headers=headers)
    assert reply.status_code == 401, reply.text


@pytest.mark.parametrize('host', ['localhost', 'localhost:8000', '127.0.0.1:8000', '[::1]:8000'])
@pytest.mark.parametrize('origin', [None, 'http://localhost:5173', 'tauri://localhost'])
def test_loopback_hosts_support_desktop_and_dev(accounts, host, origin):
    headers = {'Host': host}
    if origin:
        headers['Origin'] = origin
    reply = TestClient(app).get('/api/users', headers=headers)
    assert reply.status_code == 200, reply.text


def test_helper_cannot_use_subsonic_as_an_alternate_application_gate(house):
    token = house.helper.headers['authorization'].removeprefix('Bearer ')
    reply = house.helper.get('/rest/ping', params={'apiKey': token, 'f': 'json'})
    assert reply.status_code == 403, reply.text


def test_enrolled_helper_can_read_job_input_without_personal_library_links(house):
    reply = house.helper.get('/api/media/Album/Song.mp3')
    assert reply.status_code == 200, reply.text
    assert reply.content == b'audio'
    identity = house.helper.get('/api/me')
    assert identity.status_code == 200
    assert identity.json()['isOwner'] is False


def test_persisted_helper_credential_keeps_protocol_access_without_reenrolment(house):
    token = house.helper.headers['authorization'].removeprefix('Bearer ')
    reloaded = type(house.store)(app.state.config.users_file)
    principal = reloaded.resolve(token)
    assert principal.credential_kind == 'helper'
    assert not principal.is_owner
    house.container._services['token_store'] = reloaded
    assert house.helper.post('/api/helpers/claim', json={'kinds': ['stems'], 'version': '0.10.0'}).status_code == 204
    assert house.helper.get('/api/users').status_code == 403
    assert house.helper.get('/api/helpers/limits').status_code == 200
    assert house.helper.get('/api/lyrics/jobs').status_code == 200


@pytest.mark.parametrize('method', ['GET', 'OPTIONS'])
def test_host_validation_precedes_public_routes_and_cors_preflight(method):
    reply = TestClient(app).request(method, '/api/health', headers={
        'Host': 'evil/api/health#', 'Origin': 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
    })
    assert reply.status_code == 400


@pytest.mark.parametrize('host', ['[::1]junk', '[::1]junk:8000', 'localhost..'])
def test_loopback_authority_requires_the_entire_host_header_to_be_valid(accounts, host):
    reply = TestClient(app).get('/api/users', headers={'Host': host})
    assert reply.status_code == 400, reply.text


@pytest.mark.parametrize(('path', 'allowed'), [
    ('/api/lineage/agent/heartbeat', True),
    ('/api/lineage/agent/result', True),
    ('/api/lineage/edges', False),
    ('/api/lineage/agent/../users', False),
])
def test_helper_reaches_extension_agent_queues_only(path, allowed):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.infra.identity import Principal, authorize_credential
    helper = Principal(user_id='u', label='h', role='owner', device_id='d', credential_kind='helper')
    request = SimpleNamespace(method='POST', scope={'path': path, 'route': SimpleNamespace(path=path)})
    if allowed:
        authorize_credential(request, helper)
    else:
        with pytest.raises(HTTPException) as refused:
            authorize_credential(request, helper)
        assert refused.value.status_code == 403
