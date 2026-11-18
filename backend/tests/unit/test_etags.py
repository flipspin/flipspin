"""Conditional reads bypass expensive handlers and leave cache ownership explicit."""
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer, conditional, get_library_scope
from app.domains.music import routes
from app.domains.system import routes as system
from app.domains.user_library.scope import LibraryScope
from app.infra.changes import Changes
from app.infra import etags
from app.infra.identity import LOCAL_OWNER, current_principal


def test_apps_keep_revision_providers_boot_ids_and_validators_isolated(config):
    containers, clients = [], []
    for _ in range(2):
        container = DependencyContainer(config)
        container._repositories['music_repository'] = SimpleNamespace(
            config=config, scans=SimpleNamespace(read_fresh=lambda: None, generation=0),
            tag_revision=0, scan_albums=lambda: [],
        )
        container._services['analysis_repository'] = SimpleNamespace(revision=0)
        app = FastAPI()
        app.state.container = container
        app.dependency_overrides[get_library_scope] = LibraryScope
        app.dependency_overrides[current_principal] = lambda: LOCAL_OWNER
        # Both apps use the very same decorated endpoint and context dependency.
        app.include_router(system.router)
        containers.append(container)
        clients.append(TestClient(app))

    first, second = containers
    url = '/api/library/summary'
    tags = [client.get(url).headers['etag'] for client in clients]
    assert first.changes.boot_id != second.changes.boot_id
    assert tags[0] != tags[1]
    second_boot = second.changes.boot_id

    def check_first_changed():
        response = clients[0].get(url, headers={'If-None-Match': tags[0]})
        assert response.status_code == 200
        assert response.headers['etag'] != tags[0]
        tags[0] = response.headers['etag']
        unchanged = clients[1].get(url, headers={'If-None-Match': tags[1]})
        assert unchanged.status_code == 304
        assert unchanged.headers['etag'] == tags[1]
        assert second.changes.boot_id == second_boot
        assert second.changes.revision('library') == 0
        assert second.changes.revision('analysis') == 0

    first.changes.bump('config')
    assert first.changes.counter('config') == 1
    assert second.changes.counter('config') == 0
    first.changes.bump('library')
    check_first_changed()
    # Replacing a provider's source must resolve through its owning container.
    first._services['analysis_repository'] = SimpleNamespace(revision=7)
    check_first_changed()
    first.changes.boot_id = Changes().boot_id
    check_first_changed()


def test_one_hundred_unchanged_listing_polls_build_zero_albums(config):
    container = DependencyContainer(config)
    path = config.base_music_dir / 'Album/song.mp3'
    path.parent.mkdir()
    path.write_bytes((b'\xff\xfb\x90\x00' + b'\x00' * 413) * 2)
    repo = container.get_music_repository()
    repo.refresh(reason='fixture')
    app = FastAPI()
    app.state.container = container
    app.include_router(routes.router)
    app.dependency_overrides[get_library_scope] = LibraryScope
    app.dependency_overrides[current_principal] = lambda: LOCAL_OWNER
    client = TestClient(app)
    with patch.object(routes, 'album_listing', wraps=routes.album_listing) as build:
        response = client.get('/api/listar-albums-con-metadata?covers=false')
        assert response.status_code == 200
        build.assert_called_once()
        build.reset_mock()
        with patch.object(container.get_music_service(), 'list_albums', side_effect=AssertionError('handler ran')), \
             patch.object(repo, 'build_album', side_effect=AssertionError('album build')):
            for _ in range(100):
                assert client.get('/api/listar-albums-con-metadata?covers=false',
                                  headers={'If-None-Match': response.headers['etag']}).status_code == 304
        build.assert_not_called()


def test_body_hash_middleware_is_removed():
    from app.main import app
    assert not hasattr(etags, 'conditional_snapshot')
    assert all(getattr(middleware.kwargs.get('dispatch'), '__name__', '') != 'conditional_snapshot'
               for middleware in app.user_middleware)


@pytest.mark.parametrize('async_handler', [False, True])
@pytest.mark.parametrize('wired', [False, True])
def test_decorator_preserves_responses_errors_and_vary(config, wired, async_handler):
    app = FastAPI()
    container = DependencyContainer(config)
    container.changes = Changes(wired=('config',) if wired else ())
    app.state.container = container
    calls = []

    def build(request: Request):
        calls.append(True)
        status = 503 if request.query_params.get('error') else 200
        return Response('{"value":1}', status_code=status, media_type='application/json', headers={'Vary': 'Accept'})

    async def async_build(request: Request):
        return build(request)

    app.get('/read')(conditional(('config',))(async_build if async_handler else build))
    client = TestClient(app)
    first = client.get('/read')
    assert first.headers['vary'] == 'Accept, Authorization'
    response = client.get('/read', headers={'If-None-Match': 'W/' + first.headers['etag']})
    assert response.status_code == 304
    assert len(calls) == (1 if wired else 2)
    assert client.get('/read?error=true').status_code == 503
    container.changes.boot_id = Changes().boot_id
    assert client.get('/read', headers={'If-None-Match': first.headers['etag']}).status_code == 200
