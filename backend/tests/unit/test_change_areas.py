"""Every writer invalidates its owning area, keeping accounts independent."""
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.domains.lyrics.models import PendingTrack
from app.domains.server.routes import router as server_router
from app.dependencies import DependencyContainer, get_container
from app.infra.identity import LOCAL_OWNER, current_principal
from app.infra.jobs.maintenance import JobMaintenance

from app.infra.changes import Changes


FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 2

def test_counters_are_independent_and_thread_safe():
    changes = Changes()
    assert changes.revision('lyrics') == 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: changes.bump('lyrics', ids=['Album/song.mp3']), range(100)))
    assert changes.revision('lyrics') == 100
    assert changes.revision('me:account') == 0
    changes.bump('me:account')
    assert changes.revision('me:account') == 1
    assert not changes.wired('lyrics')


def test_providers_are_authoritative_and_wiring_is_explicit():
    value = [7]
    changes = Changes({'library': lambda: value[0]})
    assert not changes.wired('library')
    changes.bump('library')
    assert changes.revision('library') == 7
    value[0] = 8
    assert changes.revision('library') == 8
    assert Changes().boot_id != changes.boot_id


def test_composition_wires_every_area(config):
    changes = DependencyContainer(config).changes
    for area in ('library', 'analysis', 'jobs', 'lyrics', 'playlists', 'config', 'helpers', 'signin', 'me:account'):
        assert changes.wired(area)


@pytest.fixture
def writers(config):
    for name in ('one.mp3', 'two.mp3'):
        path = config.base_music_dir / 'Album' / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(FRAME)
    container = DependencyContainer(config)
    container.get_music_repository().refresh(reason='fixture')
    container.get_lyrics_service().agent_queue.status()
    container.get_stems_service().queue.snapshot()
    container.get_playlist_service()
    container.get_analysis_service()
    container.get_user_track_store().add_many('account', ['Album/one.mp3'])
    container.get_playlist_service().create_playlist('Fixture')
    container.get_music_repository().refresh(reason='fixture-ready')
    try:
        yield container
    finally:
        container.get_analysis_service().stop()
        container.get_jobs().close()


def revisions(container):
    return {area: container.changes.revision(area) for area in (
        'library', 'analysis', 'jobs', 'lyrics', 'playlists', 'config', 'helpers', 'signin',
        'me:account', 'me:other')}


def assert_moves(container, expected, write):
    before = revisions(container)
    write()
    after = revisions(container)
    assert {area for area in before if before[area] != after[area]} == set(expected)


@pytest.mark.parametrize('operation', ['link', 'unlink', 'delete', 'liked', 'offline', 'play', 'stats',
                                       'repoint', 'drop', 'restore', 'acquisition'])
def test_personal_writers_only_advance_the_affected_account(writers, operation):
    c, rel = writers, 'Album/one.mp3'
    store = c.get_user_track_store()
    store.add_many('other', ['Album/two.mp3'])
    actions = {
        'link': lambda: store.add_many('account', ['Album/two.mp3']),
        'unlink': lambda: store.remove_many('account', [rel]),
        'delete': lambda: store.remove_user('account'),
        'liked': lambda: store.update_flags('account', rel, liked=True),
        'offline': lambda: store.update_flags('account', rel, offline=True),
        'play': lambda: store.record_play('account', rel),
        'stats': lambda: store.set_play_stats('account', rel, 3, '2026-01-01T00:00:00Z'),
        'repoint': lambda: store.repoint(rel, 'Album/two.mp3'),
        'drop': lambda: store.drop(rel, store.snapshot(rel)),
        'restore': lambda: store.restore(rel, [{**store.snapshot(rel)[0], 'liked': True}]),
    }
    if operation == 'restore':
        snapshot = store.snapshot(rel)
        store.remove_many('account', [rel])
        actions['restore'] = lambda: store.restore(rel, snapshot)
    if operation == 'acquisition':
        from app.domains.user_library.acquisition_links import link_results
        from app.infra.identity import Principal
        from app.infra.media_requests import DownloadResult
        actions['acquisition'] = lambda: link_results(store, Principal('account', 'Account'), c.config.base_music_dir,
            [DownloadResult(success=True, file_path=c.config.base_music_dir / 'Album/two.mp3')])
    assert_moves(c, ['me:account'], actions[operation])


def test_noop_personal_writes_keep_the_revision(writers):
    store = writers.get_user_track_store()
    assert_moves(writers, [], lambda: store.add_many('account', ['Album/one.mp3']))
    assert_moves(writers, [], lambda: store.update_flags('account', 'Album/one.mp3', liked=False))
    assert_moves(writers, [], lambda: store.remove_many('account', ['Album/absent.mp3']))


@pytest.mark.parametrize('operation', ['create', 'add', 'remove', 'replace', 'reorder', 'rename', 'delete',
                                       'cover', 'import', 'assign'])
def test_playlist_file_writers_only_advance_playlists(writers, operation):
    c, name = writers, 'Fixture'
    service = c.get_playlist_service()
    paths = [c.config.base_music_dir / 'Album' / file for file in ('one.mp3', 'two.mp3')]
    service.add_tracks(name, paths)
    actions = {
        'create': lambda: service.create_playlist('New'),
        'add': lambda: service.add_tracks(name, paths),
        'remove': lambda: service.remove_tracks(name, [paths[0]]),
        'replace': lambda: service.replace_tracks(name, paths[::-1]),
        'reorder': lambda: service.reorder_tracks(name, paths[::-1]),
        'rename': lambda: service.rename_playlist(name, 'Renamed'),
        'delete': lambda: service.delete_playlist(name),
        'cover': lambda: service.update_cover(name, 'artwork'),
        'import': lambda: service.save_imported_playlist('Imported', None, []),
        'assign': lambda: c.get_playlist_repository().set_owner(name, 'account'),
    }
    expected = ['playlists', 'me:account'] if operation == 'assign' else ['playlists']
    assert_moves(c, expected, actions[operation])


@pytest.mark.parametrize('operation', ['save', 'offset', 'delete', 'pending', 'clear_pending'])
def test_lyrics_writers_only_advance_lyrics(writers, operation):
    c, rel = writers, 'Album/one.mp3'
    service = c.get_lyrics_service()
    if operation in ('offset', 'delete'):
        service.save(rel, kind='synced', text='[00:01.00]Words', source='manual')
    if operation == 'clear_pending':
        service.repository.mark_pending(PendingTrack(rel, 'Song', 'Artist', 'Album', 0))
    actions = {
        'save': lambda: service.save(rel, kind='plain', text='Words', source='manual'),
        'offset': lambda: service.set_offset(rel, 250),
        'delete': lambda: service.delete(rel),
        'pending': lambda: service.repository.mark_pending(PendingTrack(rel, 'Song', 'Artist', 'Album', 0)),
        'clear_pending': lambda: service.repository.clear_pending(rel),
    }
    assert_moves(c, ['lyrics'], actions[operation])


def test_agent_queue_advances_lyrics_and_jobs(writers):
    c = writers
    assert_moves(c, ['lyrics', 'jobs'], lambda: c.get_lyrics_service().agent_queue.enqueue([
        {'relPath': 'Album/one.mp3', 'item': 'Song'}]))


def test_server_config_put_advances_config_and_pending_restart(writers, monkeypatch):
    from app.infra import env_sources
    c = writers
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset())
    app = FastAPI()
    app.state.container = c
    app.dependency_overrides[get_container] = lambda: c
    app.dependency_overrides[current_principal] = lambda: LOCAL_OWNER
    app.include_router(server_router)
    client = TestClient(app)
    response = []
    assert_moves(c, ['config'], lambda: response.append(client.put('/api/server/config', json={
        'changes': {'KROBI_LYRICS_ENGINE': 'local'}})))
    assert response[0].status_code == 200
    assert response[0].json()['restart']['pending'] == ['KROBI_LYRICS_ENGINE']


@pytest.mark.parametrize('operation', ['enrol', 'state', 'touch', 'revoke', 'bye', 'working', 'finished', 'offline'])
def test_helper_writes_and_reaped_expiry_advance_helpers_and_jobs(writers, operation):
    c = writers
    worker = c.get_lyrics_service().agent_queue.worker
    clock = [1000.0]
    worker.now = lambda: clock[0]
    worker._last_reap = None
    agent = {'id': 'device', 'name': 'Helper', 'version': '0.10.0'}
    if operation != 'enrol':
        worker.seen(agent)
    if operation == 'finished':
        worker.working('job', 'device', 'Song', None)
    def expire():
        clock[0] += 91
        worker.reap()

    actions = {
        'enrol': lambda: worker.seen(agent),
        'state': lambda: worker.seen({**agent, 'state': 'working'}),
        'touch': lambda: (worker.bye('device', 'sleep'), worker.touch('device')),
        'revoke': lambda: worker.revoke('device'),
        'bye': lambda: worker.bye('device', 'sleep'),
        'working': lambda: worker.working('job', 'device', 'Song', None),
        'finished': lambda: worker.finished('job'),
        'offline': expire,
    }
    assert_moves(c, ['helpers', 'jobs'], actions[operation])


def test_repeat_check_ins_move_no_area(writers):
    """A connected helper polling every few seconds must not invalidate Home, jobs or settings."""
    c = writers
    worker = c.get_lyrics_service().agent_queue.worker
    clock = [1000.0]
    worker.now = lambda: clock[0]
    agent = {'id': 'device', 'name': 'Helper', 'version': '0.10.0'}
    worker.seen(agent)
    before = {area: c.changes.revision(area) for area in ('helpers', 'jobs')}
    for _ in range(10):
        clock[0] += 8
        worker.seen(agent)
        worker.touch('device')
    assert {area: c.changes.revision(area) for area in ('helpers', 'jobs')} == before
    assert worker.helpers()[0]['lastSeenAt'] == clock[0]


@pytest.mark.parametrize('operation', ['create', 'approve', 'decide', 'decline', 'decline_code', 'expire'])
def test_signin_transitions_only_advance_signin(writers, operation):
    c = writers
    store = c.get_token_store()
    account, _ = store.mint('Account', 'owner')
    store.set_username(account.user_id, 'account')
    codes = c.get_sign_in_codes()
    clock = [1000.0]
    codes.clock = lambda: clock[0]
    requested = codes.request('Phone', 'account')
    request_id = codes.requests(account.user_id)[0]['id']
    actions = {
        'create': lambda: codes.request('Another phone', 'account'),
        'approve': lambda: codes.approve(requested['code'], account.user_id),
        'decide': lambda: codes.decide(request_id, account.user_id),
        'decline': lambda: codes.decide(request_id, account.user_id, decline=True),
        'decline_code': lambda: codes.decline_code(requested['code'], account.user_id),
        'expire': lambda: clock.__setitem__(0, clock[0] + 601),
    }
    assert_moves(c, ['signin'], actions[operation])


def test_job_maintenance_runs_on_timer_and_stops():
    ticked = threading.Event()
    maintenance = JobMaintenance(ticked.set, interval=.01)
    maintenance.start()
    try:
        assert ticked.wait(2)
    finally:
        maintenance.stop()
    assert not maintenance.thread.is_alive()


def test_jobs_revision_and_list_do_not_write_even_with_pending_phases(writers):
    ledger = writers.get_jobs()
    clock = [1000.0]
    ledger.now = lambda: clock[0]
    ledger.phase_changed()
    clock[0] += .5
    ledger.phase_changed()
    clock[0] += 1
    with patch.object(ledger, 'retention', side_effect=AssertionError('retention on read')), \
         patch.object(ledger, '_bump', side_effect=AssertionError('revision write')):
        writers.changes.revision('jobs')
        ledger.list()


@pytest.mark.parametrize('operation', ['create', 'delete', 'transfer'])
def test_playlist_membership_also_advances_its_accounts(writers, operation):
    c = writers
    service = c.get_playlist_service()
    if operation != 'create':
        service.create_playlist('Owned', owner_id='account')
    actions = {
        'create': lambda: service.create_playlist('Owned', owner_id='account'),
        'delete': lambda: service.delete_playlist('Owned'),
        'transfer': lambda: c.get_playlist_repository().set_owner('Owned', 'other', previous_owner='account'),
    }
    expected = ['playlists', 'me:account'] + (['me:other'] if operation == 'transfer' else [])
    assert_moves(c, expected, actions[operation])
