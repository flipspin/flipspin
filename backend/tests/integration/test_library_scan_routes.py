"""Listing snapshots and owner commands at the HTTP boundary."""
import logging
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer, get_library_scope, get_music_service
from app.domains.music import routes, scan_routes
from app.domains.music.repositories import MusicRepository
from app.domains.music.services import MusicService
from app.domains.user_library.scope import LibraryScope
from app.infra.identity import LOCAL_OWNER, Principal, current_principal

FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 2


@pytest.fixture
def library_api(tmp_path):
    root = tmp_path / 'Music'
    for folder in ('One', 'Two'):
        path = root / folder / 'song.mp3'
        path.parent.mkdir(parents=True)
        path.write_bytes(FRAME)
    config = SimpleNamespace(base_music_dir=root, analysis_db=tmp_path / 'analysis.sqlite')
    repo = MusicRepository(config, logging.getLogger('test.library.http'), background=True)
    repo.refresh(reason='fixture')
    service = MusicService(repo, None, config, repo.logger)
    app = FastAPI()
    app.state.container = DependencyContainer(config)
    repo.changes = app.state.container.changes
    app.state.container._repositories['music_repository'] = repo
    app.state.container._services['analysis_repository'] = repo.analysis
    app.include_router(routes.router)
    app.include_router(scan_routes.router)
    state = SimpleNamespace(principal=LOCAL_OWNER, scope=LibraryScope())
    app.dependency_overrides[get_music_service] = lambda: service
    app.dependency_overrides[current_principal] = lambda: state.principal
    app.dependency_overrides[get_library_scope] = lambda: state.scope
    return TestClient(app), repo, state


def test_listing_304_does_no_discovery_tag_reads_or_serialization(library_api):
    client, repo, _ = library_api
    url = '/api/listar-albums-con-metadata?covers=false'
    first = client.get(url)
    assert first.status_code == 200
    assert first.headers['vary'] == 'Authorization'
    with patch('app.domains.music.library_scan.discover', side_effect=AssertionError('disk discovery')), \
         patch.object(repo, 'read_tags', side_effect=AssertionError('tags')), \
         patch.object(routes, 'album_listing', side_effect=AssertionError('serialization')):
        for etag in (first.headers['etag'], 'W/' + first.headers['etag'], '*'):
            result = client.get(url, headers={'If-None-Match': etag})
            assert result.status_code == 304 and result.content == b''


def test_unconditional_listing_discovers_new_nested_and_root_files_without_watcher(library_api):
    client, repo, _ = library_api
    url = '/api/listar-albums-con-metadata?covers=false'
    first = client.get(url)
    paths = ['Artist/Three/new.mp3', 'loose.mp3', 'One/second.mp3']
    for count, relative in enumerate(paths, start=3):
        path = repo.config.base_music_dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(FRAME)
        # Conditional reads validate the published counter only, even offline.
        assert client.get(url, headers={'If-None-Match': first.headers['etag']}).status_code == 304
        newer = client.get(url)
        assert newer.status_code == 200
        assert sum(len(album['tracks']) for album in newer.json()) == count
        # The offline builder can publish during the unconditional read. Fetch
        # its now-current validator before testing the next unpublished change.
        first = client.get(url)


def test_scope_and_cover_options_have_separate_validators(library_api):
    client, _, state = library_api
    url = '/api/listar-albums-con-metadata?covers=false'
    owner = client.get(url)
    state.scope = LibraryScope(frozenset({'One/song.mp3'}))
    member = client.get(url, headers={'If-None-Match': owner.headers['etag']})
    assert member.status_code == 200
    assert len(member.json()) == 1
    assert member.json()[0]['mediaKey'] == 'One'
    state.scope = LibraryScope(frozenset())
    empty = client.get(url, headers={'If-None-Match': member.headers['etag']})
    assert empty.status_code == 200 and empty.json() == []
    state.scope = LibraryScope()
    assert client.get(url, headers={'If-None-Match': member.headers['etag']}).status_code == 200
    # Both cover variants remain independently cacheable, including legacy default.
    assert client.get('/api/listar-albums-con-metadata').json() == owner.json()


@pytest.mark.parametrize('full', [False, True])
def test_owner_actions_enqueue_and_status_never_scans(library_api, full):
    client, repo, _ = library_api
    with patch.object(repo, 'refresh', side_effect=AssertionError('request scan')):
        result = client.post('/api/library/scan', json={'full': full})
        assert result.status_code == 202
        assert result.json()['pending'] is True
        assert result.json()['lastScanAt'] is not None
        assert result.json()['durationSeconds'] >= 0
        assert result.json()['intervalSeconds'] == 300.0
        assert client.get('/api/library/scan').status_code == 200
    assert repo.scans.worker.full is full


def test_member_cannot_read_or_start_a_household_scan(library_api):
    client, repo, state = library_api
    state.principal = Principal('member', 'Member', 'member', 'device')
    with patch.object(repo.scans.worker, 'request', side_effect=AssertionError('member work')):
        assert client.get('/api/library/scan').status_code == 403
        assert client.post('/api/library/scan', json={'full': True}).status_code == 403


def test_failed_refresh_keeps_http_snapshot_and_etag(library_api):
    client, repo, _ = library_api
    url = '/api/listar-albums-con-metadata?covers=false'
    first = client.get(url)
    with patch('app.domains.music.library_scan.discover', side_effect=PermissionError('unavailable')):
        repo.refresh()
    assert client.get(url, headers={'If-None-Match': first.headers['etag']}).status_code == 304
    assert client.get('/api/library/scan').json()['error'] == 'unavailable'


def test_requests_stay_responsive_during_a_blocked_background_scan(library_api):
    client, repo, _ = library_api
    first = client.get('/api/listar-albums-con-metadata?covers=false')
    entered, release = threading.Event(), threading.Event()
    from app.domains.music.library_scan import discover
    def blocked(*args):
        entered.set()
        assert release.wait(10)
        return discover(*args)
    with patch('app.domains.music.library_scan.discover', side_effect=blocked), \
         patch.object(repo.scans.worker.watch, 'follow'):
        repo.start_scanner()
        try:
            assert entered.wait(10)
            response = client.get('/api/listar-albums-con-metadata?covers=false',
                                  headers={'If-None-Match': first.headers['etag']})
            assert response.status_code == 304
            assert client.get('/api/library/scan').json()['scanning'] is True
        finally:
            release.set()
            repo.stop_scanner()
