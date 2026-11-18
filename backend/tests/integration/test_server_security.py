"""Public-server regressions: exercise the vulnerable entry points without network I/O."""
from contextlib import contextmanager
import inspect
import logging
import socket
import ipaddress
from types import SimpleNamespace
from typing import get_args, get_type_hints
from unittest.mock import Mock

import pytest
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.datastructures import QueryParams

from app.domains.acquisition.models import Track
from app.domains.downloads.routes import YoutubeDownloadRequest
from app.domains.metadata.repositories import GeniusRepository
from app.domains.subsonic import auth
from app.domains.subsonic.failure_throttle import CredentialThrottle
from app.domains.subsonic.render import SubsonicError
from app.domains.system import routes as system
from app.domains.transfers.routes import UploadVlcRequest
from app.infra import identity
from fastapi.routing import iter_route_contexts

from app.main import app


@pytest.mark.parametrize('model,fields', [
    (YoutubeDownloadRequest, {'url': '--exec=echo injected'}),
    (YoutubeDownloadRequest, {'url': 'file:///etc/passwd'}),
    (YoutubeDownloadRequest, {'url': 'https://example.org/audio'}),
    (Track, {'title': 'Song', 'youtube_url': '--exec=echo injected'}),
    (Track, {'title': 'Song', 'youtube_url': 'https://example.org/watch'}),
    (Track, {'title': 'Song', 'cover_url': 'https://user:secret@example.org/art'}),
    (Track, {'title': 'Song', 'cover_url': 'file:///etc/passwd'}),
    (UploadVlcRequest, {'paths': [], 'vlc_ip': 'example.org@evil.example/path'}),
])
def test_untrusted_url_fields_reject_payloads(model, fields):
    with pytest.raises(ValidationError):
        model(**fields)


@pytest.mark.parametrize('attack', ['private', 'redirect', 'oversize', 'html'])
def test_cover_fetch_refuses_unsafe_responses(attack, monkeypatch, tmp_path):
    from app.exceptions import ExternalAPIError
    from app.infra import http_fetch

    private = str(ipaddress.ip_address(0x7F000001))
    url = f'http://{private}/art' if attack == 'private' else 'https://example.org/art'
    body = b'x' * (10 * 1024 * 1024 + 1) if attack == 'oversize' else b'image'
    monkeypatch.setattr(socket, 'getaddrinfo', lambda host, port, **kw: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, '',
         (private if host == private else '93.184.216.34', port))])
    @contextmanager
    def request_once(*args, **kwargs):
        headers = {'Content-Type': 'text/html' if attack == 'html' else 'image/jpeg'}
        status = 200
        if attack == 'redirect':
            status, headers = 302, {'Location': f'http://{private}/art'}
        yield SimpleNamespace(status=status, headers=headers, stream=lambda **kw: iter([body]))
    monkeypatch.setattr(http_fetch, '_request_once', request_once)
    destination = tmp_path / 'cover.jpg'
    repo = GeniusRepository(SimpleNamespace(), logging.getLogger('security-test'))
    with pytest.raises(ExternalAPIError):
        repo.download_cover_art(url, destination)
    assert not destination.exists()


def public_principal_dependencies(application):
    violations = []
    def has_principal(annotation):
        return annotation is identity.Principal or any(has_principal(arg) for arg in get_args(annotation))
    def walk(dependency):
        call = dependency.call
        if call in {identity.require_owner, identity.current_principal, identity.require_account, identity.require_helper}:
            return True
        if inspect.isfunction(call):
            hints = get_type_hints(call)
            if any(has_principal(hint) for hint in hints.values()):
                return True
        return any(walk(child) for child in dependency.dependencies)
    for route in iter_route_contexts(application.routes):
        if isinstance(route.original_route, APIRoute) and any(identity.is_public_route(m, route.path) for m in route.methods):
            if walk(route.dependant):
                violations.append(route.path)
    return violations


def test_no_public_route_requires_a_principal():
    assert public_principal_dependencies(app) == []


def test_public_route_walker_detects_nested_principal_dependency():
    planted = FastAPI()
    def gate(principal: identity.Principal = Depends(identity.current_principal)):
        return principal
    @planted.get('/api/health', dependencies=[Depends(gate)])
    def health():
        return {}
    assert public_principal_dependencies(planted) == ['/api/health']


def test_spotify_owner_can_start_oauth(monkeypatch):
    from app.dependencies import get_spotify_auth
    oauth = Mock()
    oauth.build_authorize_url.return_value = 'https://accounts.spotify.com/authorize?state=test'
    before = app.state.config.api_token
    app.state.config.api_token = 'security-test-token'
    app.dependency_overrides[get_spotify_auth] = lambda: oauth
    try:
        response = TestClient(app).get('/api/spotify/login', headers={'Authorization': 'Bearer security-test-token'}, follow_redirects=False)
        assert response.status_code == 307
        assert response.headers['location'] == oauth.build_authorize_url.return_value
    finally:
        app.state.config.api_token = before
        app.dependency_overrides.pop(get_spotify_auth, None)


@pytest.mark.parametrize('mechanism', ['apiKey', 'p'])
def test_subsonic_rotating_guesses_share_ip_bucket(monkeypatch, mechanism):
    monkeypatch.setattr(auth, 'throttle', CredentialThrottle(burst=2))
    store = Mock()
    store.resolve.return_value = None
    store.find_by_username.return_value = None
    codes = []
    for guess in range(3):
        params = {mechanism: f'guess-{guess}'}
        if mechanism == 'p':
            params['u'] = f'user-{guess}'
        with pytest.raises(SubsonicError) as caught:
            auth.authenticate(QueryParams(params), store, Mock(), '192.0.2.1')
        codes.append(caught.value.code)
    assert codes[-1] == 0


def test_subsonic_username_bucket_crosses_ips():
    throttle = CredentialThrottle(burst=2)
    assert not throttle.reject(('192.0.2.1', 'listener'))
    assert not throttle.reject(('192.0.2.2', 'listener'))
    assert throttle.reject(('192.0.2.3', 'listener'))


def test_windows_open_file_keeps_shell_metacharacters_literal(tmp_path, monkeypatch):
    path = tmp_path / 'song & echo injected | more.mp3'
    path.write_bytes(b'audio')
    startfile, run = Mock(), Mock()
    monkeypatch.setattr(system.os, 'startfile', startfile, raising=False)
    monkeypatch.setattr(system.subprocess, 'run', run)
    monkeypatch.setattr(system, 'sys', SimpleNamespace(platform='win32'))
    assert system.open_file(str(path), SimpleNamespace(base_music_dir=tmp_path))['success']
    startfile.assert_called_once_with(str(path))
    run.assert_not_called()


def test_source_candidate_is_a_json_value_not_a_shell_operand(config):
    from app.domains.acquisition.provider import DownloadRepository
    from unittest.mock import AsyncMock, Mock
    port = Mock(search=AsyncMock(return_value=[]))
    repository = DownloadRepository(config, Mock(), source=port)
    import asyncio
    asyncio.run(repository.search_source('--exec=echo injected'))
    assert port.search.call_args.args[0]['title'] == '--exec=echo injected'


def test_spotify_authenticates_owner_and_rejects_member_and_missing_token():
    from app.dependencies import get_spotify_auth
    oauth = Mock()
    oauth.build_authorize_url.return_value = 'https://accounts.spotify.com/authorize?state=test'
    resolver = Mock()
    resolver.resolve.side_effect = lambda token: {
        'owner-token': identity.Principal('owner-id', 'Owner', 'owner'),
        'member-token': identity.Principal('member-id', 'Member', 'member'),
    }.get(token)
    app.dependency_overrides[get_spotify_auth] = lambda: oauth
    app.dependency_overrides[identity.get_token_resolver] = lambda: resolver
    client = TestClient(app, client=('192.0.2.1', 5000))
    try:
        assert client.get('/api/spotify/login', headers={'Authorization': 'Bearer owner-token'}, follow_redirects=False).status_code == 307
        assert client.get('/api/spotify/login', headers={'Authorization': 'Bearer member-token'}, follow_redirects=False).status_code == 403
        assert client.get('/api/spotify/login', follow_redirects=False).status_code == 401
        assert client.get('/api/spotify/callback').status_code == 200
        oauth.build_authorize_url.assert_called_once()
        owner = client.get('/api/spotify/authorize-url', headers={'Authorization': 'Bearer owner-token'})
        assert owner.status_code == 200 and owner.json() == {'url': 'https://accounts.spotify.com/authorize?state=test'}
        assert client.get('/api/spotify/authorize-url', headers={'Authorization': 'Bearer member-token'}).status_code == 403
        assert client.get('/api/spotify/authorize-url').status_code == 401
    finally:
        app.dependency_overrides.pop(get_spotify_auth, None)
        app.dependency_overrides.pop(identity.get_token_resolver, None)
