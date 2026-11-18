"""The shared area contract must validate every migrated read before its builder."""
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from fastapi.routing import iter_route_contexts

from app.dependencies import DependencyContainer
from app.domains.jobs import routes as jobs
from app.domains.music import analysis_routes, routes as music
from app.domains.music.scan_worker import ScanWorker
from app.domains.system import routes as system
from app.domains.user_library import routes as personal
from app.domains.playlists import routes as playlists
from app.domains.lyrics import routes as lyrics
from app.domains.server import routes as server
from app.domains.helpers import compute_routes
from app.domains.accounts import routes_sign_in
from app.main import HomeSnapshot, home_snapshot
from app.infra.changes import Changes
from app.infra.identity import require_api_token

CONTRACT = json.loads((Path(__file__).parents[3] / 'contracts/change-areas.json').read_text())
READS = CONTRACT['conditional_routes']
FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 2


def live_watch(repo):
    repo.scans.worker = ScanWorker(repo)
    watch = repo.scans.worker.watch
    watch.root = repo.config.base_music_dir
    watch.observer = SimpleNamespace(is_alive=lambda: True, emitters=())


@pytest.fixture
def reads(config):
    path = config.base_music_dir / 'Album/song.mp3'
    path.parent.mkdir()
    path.write_bytes(FRAME)
    container = DependencyContainer(config)
    repo = container.get_music_repository()
    repo.refresh(reason='fixture')
    app = FastAPI()
    app.state.container, app.state.config = container, config
    app.state.identity_resolver = lambda request: container.get_token_store()
    for router in (music.router, system.router, analysis_routes.router, jobs.router, personal.router,
                   playlists.router, lyrics.router, server.router, compute_routes.router):
        app.include_router(router, dependencies=[Depends(require_api_token)])
    app.include_router(routes_sign_in.router, prefix='/api', dependencies=[Depends(require_api_token)])
    app.add_api_route('/api/me/home', home_snapshot, response_model=HomeSnapshot,
                      dependencies=[Depends(require_api_token)])
    store = container.get_token_store()
    owner, owner_token = store.mint('Owner', 'owner')
    member, member_token = store.mint('Member', 'member')
    container.get_playlist_service().create_playlist('Fixture', owner_id=member.user_id)
    container.get_lyrics_service().agent_queue.status()
    container.get_stems_service().queue.snapshot()
    client = TestClient(app, headers={'Authorization': f'Bearer {owner_token}'})
    yield SimpleNamespace(client=client, container=container, app=app, repo=repo,
                          owner=owner, member=member, member_headers={'Authorization': f'Bearer {member_token}'}, path=path)
    container.get_nest_helper().stop()
    container.get_analysis_service().stop()
    container.get_jobs().close()


def builder(h, path):
    if path == '/api/listar-albums-con-metadata':
        return patch.object(h.container.get_music_service(), 'list_albums', side_effect=AssertionError('listing builder'))
    if path == '/api/library/summary':
        return patch.object(h.repo, 'scan_albums', side_effect=AssertionError('summary builder'))
    if path == '/api/analysis/summary':
        return patch.object(h.container.get_analysis_service(), 'summary', side_effect=AssertionError('analysis builder'))
    targets = {
        '/api/jobs': (jobs, 'snapshot'),
        '/api/me/library': (personal, 'library_snapshot'),
        '/api/me/home': (music, 'album_listing'),
        '/api/playlists': (playlists, 'playlist_listing'),
        '/api/playlists/{name}': (playlists, 'playlist_snapshot'),
        '/api/lyrics/states': (h.container.get_lyrics_service(), 'states'),
        '/api/server/config': (server.get_server_config(h.container), 'describe'),
        '/api/compute/summary': (h.container.get_compute(), 'summary'),
        '/api/me/sign-in-requests': (h.container.get_sign_in_codes(), 'requests'),
    }
    target, attribute = targets[path]
    return patch.object(target, attribute, side_effect=AssertionError('snapshot builder'))


def url(path):
    return path.replace('{name}', 'Fixture')


@pytest.mark.parametrize('path', ['/api/listar-albums-con-metadata?covers=false',
                                  '/api/me/home', '/api/lyrics/states'])
def test_one_hundred_conditional_reads_do_no_library_stats_or_freshness_checks(reads, path):
    h = reads
    live_watch(h.repo)
    first = h.client.get(path)
    assert first.status_code == 200, first.text
    original_stat, original_path_stat = os.stat, Path.stat
    stats = Mock()

    def record(path):
        if not isinstance(path, int) and Path(path).is_relative_to(h.repo.config.base_music_dir):
            stats(path)

    def stat(path, *args, **kwargs):
        record(path)
        return original_stat(path, *args, **kwargs)

    def path_stat(path, *args, **kwargs):
        record(path)
        return original_path_stat(path, *args, **kwargs)

    with patch.object(h.repo.scans, 'read_fresh', side_effect=AssertionError('request freshness check')), \
         patch.object(os, 'stat', stat), patch.object(Path, 'stat', path_stat):
        for _ in range(100):
            response = h.client.get(path, headers={'If-None-Match': first.headers['etag']})
            assert response.status_code == 304
        stats.assert_not_called()


@pytest.mark.parametrize('targeted', [False, True])
def test_publication_bumps_once_and_invalidates_catalog_home_and_lyrics(reads, targeted):
    h = reads
    live_watch(h.repo)
    paths = ['/api/listar-albums-con-metadata?covers=false', '/api/me/home', '/api/lyrics/states']
    tags = {path: h.client.get(path).headers['etag'] for path in paths}
    before = h.container.changes.revision('library')
    (h.path.parent / 'new.mp3').write_bytes(FRAME)
    notices = Mock()
    unlisten = h.container.changes.listen(notices)
    try:
        if targeted:
            h.repo.refresh_folders([h.path.parent])
        else:
            h.repo.refresh(full=True)
        assert h.container.changes.revision('library') == before + 1
        assert [call.args for call in notices.call_args_list if call.args[0] == 'library'] == [('library', None)]
        with patch.object(h.repo.scans, 'read_fresh', side_effect=AssertionError('request freshness check')):
            for path in paths:
                newer = h.client.get(path, headers={'If-None-Match': tags[path]})
                assert newer.status_code == 200, newer.text
                assert newer.headers['etag'] != tags[path]
        h.repo.refresh()
        assert h.container.changes.revision('library') == before + 1
    finally:
        unlisten()


def test_unconditional_lyrics_reads_check_freshness_without_a_live_watcher(reads):
    h = reads
    h.repo.scans.worker = ScanWorker(h.repo)
    first = h.client.get('/api/lyrics/states')
    assert first.status_code == 200
    (h.path.parent / 'manual.mp3').write_bytes(FRAME)
    with patch.object(h.repo.scans, 'read_fresh', wraps=h.repo.scans.read_fresh) as fresh:
        newer = h.client.get('/api/lyrics/states')
    assert newer.status_code == 200
    assert 'Album/manual.mp3' in newer.json()['states']
    fresh.assert_called_once()


@pytest.mark.parametrize('read', READS, ids=lambda read: read['path'])
def test_contract_routes_skip_builders_on_unchanged_reads(reads, read):
    h, path = reads, read['path']
    route = next(route for route in iter_route_contexts(h.app.routes) if route.path == path and read['method'] in route.methods)
    assert list(route.endpoint.conditional_areas) == read['areas']
    assert route.endpoint.conditional_account_scope == bool(read.get('scoped_areas'))
    for area in read['areas'] + read.get('scoped_areas', []):
        assert {'method': read['method'], 'path': path}.items() <= next(
            reader for reader in CONTRACT['areas'][area]['routes'] if reader['path'] == path).items()
    first = h.client.get(url(path))
    assert first.status_code == 200, first.text
    assert first.headers.get_list('etag') == [first.headers['etag']]
    with builder(h, path) as spy:
        for value in (first.headers['etag'], '"unrelated", W/' + first.headers['etag'], '*'):
            response = h.client.get(url(path), headers={'If-None-Match': value})
            assert response.status_code == 304 and response.content == b''
            assert response.headers['etag'] == first.headers['etag']
            assert response.headers['cache-control'] == 'private, no-cache'
            assert response.headers['vary'] == 'Authorization'
        spy.assert_not_called()


WRITES = [(read['path'], area) for read in READS for area in read['areas']]


@pytest.mark.parametrize('path,area', WRITES)
def test_declared_writes_invalidate_every_reader(reads, path, area):
    h = reads
    first = h.client.get(url(path))
    concrete = f'me:{h.owner.user_id}' if area == 'me:<account>' else area
    before = h.container.changes.revision(concrete)
    if area == 'library':
        (h.path.parent / 'new.mp3').write_bytes(FRAME)
        h.repo.refresh(reason='fixture-write')
    elif area == 'analysis':
        stat = h.path.stat()
        h.container.get_analysis_repository().apply('Album/song.mp3', {
            'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns, 'engine': 'test', 'engine_version': 2,
            'key': '5A', 'key_conf': .9, 'bpm': 123, 'bpm_conf': .9,
            'energy': .06, 'brightness': .25, 'pulse': 1.6,
        }, 'energetic')
    else:
        write_area(h, area)
    assert h.container.changes.revision(concrete) != before
    newer = h.client.get(url(path), headers={'If-None-Match': first.headers['etag']})
    assert newer.status_code == 200, newer.text
    assert newer.headers['etag'] != first.headers['etag']


@pytest.mark.parametrize('read', READS, ids=lambda read: read['path'])
def test_restart_invalidates_every_validator(reads, read):
    h, path = reads, read['path']
    first = h.client.get(url(path))
    h.container.changes.boot_id = Changes().boot_id
    response = h.client.get(url(path), headers={'If-None-Match': first.headers['etag']})
    assert response.status_code == 200 and response.headers['etag'] != first.headers['etag']


def test_member_listing_is_conditional_and_tracks_membership(reads):
    h, url = reads, '/api/listar-albums-con-metadata?covers=false'
    first = h.client.get(url)
    store = h.container.get_user_track_store()
    store.add_many(h.member.user_id, ['Album/song.mp3'])
    headers = h.member_headers
    member = h.client.get(url, headers={**headers, 'If-None-Match': first.headers['etag']})
    assert member.status_code == 200 and member.json() == first.json()
    assert member.headers['etag'] != first.headers['etag']
    assert h.container.changes.wired(f'me:{h.member.user_id}')
    service = h.container.get_music_service()
    with patch.object(service, 'list_albums', wraps=service.list_albums) as spy:
        unchanged = h.client.get(url, headers={**headers, 'If-None-Match': member.headers['etag']})
        assert unchanged.status_code == 304
        spy.assert_not_called()
    store.remove_many(h.member.user_id, ['Album/song.mp3'])
    empty = h.client.get(url, headers={**headers, 'If-None-Match': member.headers['etag']})
    assert empty.status_code == 200 and empty.json() == []
    assert empty.headers['etag'] != member.headers['etag']
    h.container.changes.boot_id = Changes().boot_id
    assert h.client.get(url, headers={**headers, 'If-None-Match': empty.headers['etag']}).status_code == 200


def test_path_query_and_principal_separate_validators(reads):
    h = reads
    plain = h.client.get('/api/listar-albums-con-metadata?covers=false')
    covered = h.client.get('/api/listar-albums-con-metadata?covers=true', headers={'If-None-Match': plain.headers['etag']})
    assert covered.status_code == 200 and covered.headers['etag'] != plain.headers['etag']
    summary = h.client.get('/api/library/summary', headers={'If-None-Match': plain.headers['etag']})
    assert summary.status_code == 200 and summary.headers['etag'] != plain.headers['etag']
    owner = h.client.get('/api/jobs')
    member = h.client.get('/api/jobs', headers={**h.member_headers, 'If-None-Match': owner.headers['etag']})
    assert member.status_code == 200 and member.headers['etag'] != owner.headers['etag']
    denied = h.client.get('/api/analysis/summary', headers={**h.member_headers, 'If-None-Match': '*'})
    assert denied.status_code == 403
    assert h.client.get('/api/library/summary', headers={'Authorization': 'Bearer invalid', 'If-None-Match': '*'}).status_code == 401


def test_jobs_skip_queue_builders_and_observe_source_health(reads):
    h = reads
    first = h.client.get('/api/jobs')
    queue = h.container.get_lyrics_service().agent_queue
    stems = h.container.get_stems_service().queue
    with patch.object(queue, 'status', side_effect=AssertionError('lyrics snapshot')), \
         patch.object(stems, 'snapshot', side_effect=AssertionError('stems snapshot')):
        assert h.client.get('/api/jobs', headers={'If-None-Match': first.headers['etag']}).status_code == 304
    queue.degraded = True
    changed = h.client.get('/api/jobs', headers={'If-None-Match': first.headers['etag']})
    assert changed.status_code == 200 and changed.json()['degraded'] == ['lyrics']
    assert changed.headers['etag'] != first.headers['etag']


def test_helper_expiry_invalidates_jobs_and_analysis_without_snapshot_builds(reads):
    h = reads
    queue = h.container.get_lyrics_service().agent_queue
    clock = [1000.0]
    queue.worker.now = lambda: clock[0]
    assert queue.worker.seen({'id': 'helper-device', 'name': 'Helper', 'version': '0.10.0',
                              'sessionId': 'session', 'os': 'linux', 'accel': 'cpu', 'memoryBytes': 8 << 30,
                              'jobs': ['analysis'], 'labels': ['analysis>=2']})
    paths = ('/api/jobs', '/api/analysis/summary')
    tags = {path: h.client.get(url(path)).headers['etag'] for path in paths}
    clock[0] += 3600
    for path in paths:
        response = h.client.get(url(path), headers={'If-None-Match': tags[path]})
        assert response.status_code == 200 and response.headers['etag'] != tags[path]
    assert h.client.get('/api/analysis/summary').json()['helper']['online'] is False


def test_expired_successes_are_retained_by_maintenance_off_the_read_path(reads):
    h, ledger = reads, reads.container.get_jobs()
    clock = [1000.0]
    ledger.now = lambda: clock[0]
    job = ledger.start('download', 'Completed', ['song'])
    ledger.running(job, 1)
    ledger.item_transition(job, 0, 1, 'done')
    ledger.finish(job, 1)
    first = h.client.get('/api/jobs')
    assert len(first.json()['jobs']) == 1
    clock[0] += 301
    with patch.object(ledger, 'retention', side_effect=AssertionError('retention on read')):
        assert h.client.get('/api/jobs', headers={'If-None-Match': first.headers['etag']}).status_code == 304
        assert len(h.client.get('/api/jobs').json()['jobs']) == 1
    h.container.maintain_jobs()
    response = h.client.get('/api/jobs', headers={'If-None-Match': first.headers['etag']})
    assert response.status_code == 200 and response.json()['jobs'] == []


def write_area(h, area):
    c = h.container
    if area == 'jobs':
        c.get_jobs().start('download', 'New job', ['song'])
    elif area == 'playlists':
        c.get_playlist_service().update_cover('Fixture', 'artwork')
    elif area == 'me:<account>':
        c.get_user_track_store().add_many(h.owner.user_id, ['Album/song.mp3'])
    elif area == 'lyrics':
        c.get_lyrics_service().save('Album/song.mp3', kind='plain', text='Words', source='manual')
    elif area == 'config':
        server.get_server_config(c).update({'KROBI_LOG_LEVEL': 'INFO'})
    elif area == 'helpers':
        c.get_lyrics_service().agent_queue.worker.seen({'id': 'device', 'name': 'Helper', 'version': '0.10.0'})
    elif area == 'signin':
        c.get_sign_in_codes().request('Phone')
    else:
        raise AssertionError(area)


def test_contract_has_no_unwired_or_unconditional_routes(reads):
    assert all(area['wired'] for area in CONTRACT['areas'].values())
    mapped = {(row['method'], row['path']) for area in CONTRACT['areas'].values() for row in area['routes']}
    assert mapped == {(read['method'], read['path']) for read in READS}
    assert all(reads.container.changes.wired(area) for area in CONTRACT['areas'])


@pytest.mark.parametrize('path', ['/api/me/library', '/api/me/home', '/api/listar-albums-con-metadata',
                                  '/api/playlists', '/api/playlists/Fixture', '/api/lyrics/states'])
def test_personal_revisions_are_independent_for_owner_and_members(reads, path):
    h, c = reads, reads.container
    store = c.get_user_track_store()
    store.add_many(h.member.user_id, ['Album/song.mp3'])
    first = h.client.get(path, headers=h.member_headers)
    assert first.status_code == 200, first.text
    tag = first.headers['etag']
    # Another account's preferences do not invalidate this member's snapshot.
    store.add_many(h.owner.user_id, ['Album/song.mp3'])
    assert h.client.get(path, headers={**h.member_headers, 'If-None-Match': tag}).status_code == 304
    store.update_flags(h.member.user_id, 'Album/song.mp3', liked=True)
    changed = h.client.get(path, headers={**h.member_headers, 'If-None-Match': tag})
    assert changed.status_code == 200 and changed.headers['etag'] != tag


def test_owner_library_inspection_uses_the_requested_account_and_checks_access(reads):
    h, c = reads, reads.container
    path = f'/api/me/library?accountId={h.member.user_id}'
    first = h.client.get(path)
    c.get_user_track_store().add_many(h.member.user_id, ['Album/song.mp3'])
    assert h.client.get(path, headers={'If-None-Match': first.headers['etag']}).status_code == 200
    denied = f'/api/me/library?accountId={h.owner.user_id}'
    assert h.client.get(denied, headers={**h.member_headers, 'If-None-Match': '*'}).status_code == 403


def test_signin_expiry_invalidates_without_building_the_list(reads):
    h = reads
    codes = h.container.get_sign_in_codes()
    clock = [1000.0]
    codes.clock = lambda: clock[0]
    h.container.get_token_store().set_username(h.owner.user_id, 'owner')
    codes.request('Phone', 'owner')
    first = h.client.get('/api/me/sign-in-requests')
    assert len(first.json()['requests']) == 1
    clock[0] += 601
    changed = h.client.get('/api/me/sign-in-requests', headers={'If-None-Match': first.headers['etag']})
    assert changed.status_code == 200 and changed.json()['requests'] == []
    assert h.client.get('/api/me/sign-in-requests', headers={'If-None-Match': changed.headers['etag']}).status_code == 304


def test_jobs_read_does_not_write_the_ledger(reads):
    h, ledger = reads, reads.container.get_jobs()
    h.client.get('/api/jobs')
    statements = []
    ledger.db.set_trace_callback(statements.append)
    try:
        first = h.client.get('/api/jobs')
        assert h.client.get('/api/jobs', headers={'If-None-Match': first.headers['etag']}).status_code == 304
    finally:
        ledger.db.set_trace_callback(None)
    assert not [sql for sql in statements if sql.lstrip().upper().startswith(
        ('INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'BEGIN'))]


def test_playlist_validators_preserve_resource_authorization(reads):
    h = reads
    h.container.get_playlist_service().create_playlist('Private', owner_id=h.owner.user_id)
    assert h.client.get('/api/playlists/Private', headers={**h.member_headers, 'If-None-Match': '*'}).status_code == 403
    assert h.client.get('/api/playlists/Absent', headers={'If-None-Match': '*'}).status_code == 404


def test_matching_playlist_validator_allows_an_edit_and_then_invalidates(reads):
    h = reads
    first = h.client.get('/api/playlists/Fixture')
    edited = h.client.put('/api/playlists/Fixture/tracks', json=[], headers={'If-Match': first.headers['etag']})
    assert edited.status_code == 200, edited.text
    assert h.client.get('/api/playlists/Fixture', headers={'If-None-Match': first.headers['etag']}).status_code == 200


@pytest.mark.parametrize('path,body', [
    ('/api/compute/pause', {'paused': True}),
    ('/api/compute/kinds/analysis', {'paused': True}),
    ('/api/compute/computers/device', {'paused': True}),
])
def test_compute_policy_writers_invalidate_summary(reads, path, body):
    h = reads
    h.container.get_lyrics_service().agent_queue.worker.seen({'id': 'device', 'name': 'Helper', 'version': '0.10.0'})
    first = h.client.get('/api/compute/summary')
    updated = h.client.put(path, json=body)
    assert updated.status_code == 200, updated.text
    assert h.client.get('/api/compute/summary', headers={'If-None-Match': first.headers['etag']}).status_code == 200


def test_acquisition_ticks_leave_jobs_etag_and_revision_unchanged(reads):
    from app.domains.acquisition.request_job import RequestJob
    from app.infra.media_requests import TrackDownloadRequest, TrackMetadata

    h = reads
    ledger, tracker = h.container.get_jobs(), h.container.get_progress_tracker()
    song = TrackDownloadRequest(destination=h.repo.config.base_music_dir, metadata=TrackMetadata(title='Song'))
    job = RequestJob.create(ledger, 'request', {'job_id': 'request', 'body': {'title': 'Album'}},
                            [song], h.owner.principal(), tracker)
    ledger.running(job.id, 1)
    tracker.create_progress(job.id, 1)
    first = h.client.get('/api/jobs')
    assert first.status_code == 200
    assert len(first.json()['jobs']) == 1
    assert first.json()['jobs'][0]['kind'] == 'download'
    initial_revision = h.container.changes.counter('jobs')
    job.advance(0, 'matched')
    assert h.container.changes.counter('jobs') > initial_revision
    advanced = h.client.get('/api/jobs', headers={'If-None-Match': first.headers['etag']})
    assert advanced.status_code == 200
    assert advanced.headers['etag'] != first.headers['etag']
    revision, version = h.container.changes.counter('jobs'), ledger.version
    tick = [0.0]
    tracker.now = lambda: tick[0]
    statements = []
    ledger.db.set_trace_callback(statements.append)
    for percent in range(101):
        tick[0] += 0.01
        tracker.set_track_phase(job.id, 'Song', 'downloading', percent, index=0)
    ledger.db.set_trace_callback(None)
    assert not any(sql.startswith(('UPDATE ', 'INSERT ', 'DELETE ')) for sql in statements)
    assert (h.container.changes.counter('jobs'), ledger.version) == (revision, version)
    assert tracker.get_progress(job.id).active['Song']['percent'] >= 75
    assert h.client.get('/api/jobs', headers={'If-None-Match': advanced.headers['etag']}).status_code == 304
    job.advance(0, 'fetched')
    assert h.client.get('/api/jobs', headers={'If-None-Match': advanced.headers['etag']}).status_code == 200
