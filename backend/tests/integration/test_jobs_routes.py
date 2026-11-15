"""Public ledger boundary: visibility, ETag, conditional actions and replay."""
import asyncio
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.infra.jobs_runtime import boot
from app.infra.job_requests import request_item, register_requests
from app.infra.progress import progress_principal
from app.dependencies import DependencyContainer, get_container
from app.domains.accounts.auth import current_principal
from app.domains.accounts.identity import LOCAL_OWNER, Principal
from app.domains.downloads.models import TrackDownloadRequest, TrackMetadata, DownloadResult
from app.domains.jobs.routes import router


@pytest.fixture
def setup(config):
    container = DependencyContainer(config)
    # Avoid HTTP/metadata/engine processes; queues, identity and ledger are real.
    container.get_lyrics_service().startup = Mock()
    app = FastAPI()
    app.include_router(router)
    actor = [LOCAL_OWNER]
    app.dependency_overrides[get_container] = lambda: container
    app.dependency_overrides[current_principal] = lambda: actor[0]
    client = TestClient(app)
    yield container, client, actor
    container.get_jobs().close()


def test_visibility_etag_failure_details_and_conditional_actions(setup):
    c, client, actor = setup
    ledger = c.get_jobs()
    own = ledger.start('download', 'Mine', [{'item': 'A', 'detail': {'reason': 'No results', '_retry': {'secret': 'private'}}}], 'member')
    other = ledger.start('stems', 'Other', ['B'], 'stranger')
    actor[0] = Principal('member', 'Member')
    response = client.get('/api/jobs')
    assert response.status_code == 200
    assert [r['id'] for r in response.json()['jobs']] == [own]
    tag = response.headers['etag']
    assert client.get('/api/jobs', headers={'If-None-Match': tag}).status_code == 304
    assert client.get('/api/jobs', headers={'If-None-Match': 'W/'+tag}).status_code == 304
    for path in ('items', 'cancel', 'retry'):
        method = client.get if path == 'items' else client.post
        foreign = method(f'/api/jobs/{other}/{path}')
        unknown = method(f'/api/jobs/unknown/{path}')
        assert foreign.status_code == unknown.status_code == 404
        assert foreign.json() == unknown.json()
    ledger.running(own, 1)
    response = client.get('/api/jobs', headers={'If-None-Match': tag})
    assert response.status_code == 200
    assert response.headers['etag'] != tag
    assert client.post(f'/api/jobs/{own}/cancel').status_code == 200
    assert ledger.get(own)['state'] == 'cancelled'
    assert client.post(f'/api/jobs/{own}/cancel').status_code == 409
    assert client.post('/api/jobs/clear').json() == {'cleared': 1}
    assert client.get('/api/jobs').json()['jobs'] == []
    actor[0] = LOCAL_OWNER
    assert [r['id'] for r in client.get('/api/jobs').json()['jobs']] == [other]
    ledger.item_transition(other, 0, 1, 'failed', detail={'title': 'B', 'reason': 'Error', '_retry': {'secret': 'hidden'}})
    ledger.finish(other, 1)
    details = client.get(f'/api/jobs/{other}/items?state=failed').json()['items']
    assert details[0]['detail'] == {'title': 'B', 'reason': 'Error'}
    # No valid dispatch payload: cannot offer a fake retry.
    assert client.post(f'/api/jobs/{other}/cancel').json() == {'detail': 'not-cancellable'}


def test_waiting_order_helper_projection_and_degraded_source(setup, monkeypatch):
    c, client, _ = setup
    ledger = c.get_jobs()
    queued = ledger.start('download', 'queued', ['a'])
    waiting = ledger.start('stems', 'waiting', ['b'])
    running = ledger.start('lyrics-search', 'running', ['c'])
    ledger.running(running, 1)
    queue = c.get_lyrics_service().agent_queue
    clock = [1000.0]
    monkeypatch.setattr(queue.worker, 'now', lambda: clock[0])
    agent = {'id': 'helper-device', 'name': 'Helper', 'version': '0.10.0', 'sessionId': 'session',
             'os': 'linux', 'accel': 'cpu', 'memoryBytes': 8 << 30, 'jobs': ['stems']}
    queue.worker.seen(agent)
    queue.worker.bye('helper-device', 'sleep', 'session')
    got = client.get('/api/jobs')
    assert [r['id'] for r in got.json()['jobs']] == [running,waiting,queued]
    assert got.json()['jobs'][1]['waitingOn'] == {'name': 'Helper', 'state': 'asleep'}
    tag = got.headers['etag']
    queue.worker.seen(agent)
    clock[0] += 3600
    assert client.get('/api/jobs', headers={'If-None-Match': tag}).status_code == 200
    monkeypatch.setattr(c.get_stems_service().queue, 'snapshot', Mock(side_effect=OSError('unreadable')))
    got = client.get('/api/jobs').json()
    assert got['degraded'] == ['stems']
    assert len(got['jobs']) == 3


async def _settled(ledger, *job_ids, tries=200):
    """Wait until every job has left queued/running (CI runners are slower than a fixed nap)."""
    for _ in range(tries):
        if all(ledger.get(j)['state'] not in ('queued', 'running') for j in job_ids):
            return
        await asyncio.sleep(.025)


@pytest.mark.asyncio
async def test_retry_dispatches_only_failed_items_as_original_member(setup, monkeypatch):
    c, client, _ = setup
    ledger = c.get_jobs()
    user, _ = c.get_token_store().mint('Member', 'member')
    principal = user.principal()
    seen = []
    engine = c.get_download_service().engine
    async def process(request, progress_cb=None):
        seen.append((request.metadata.title, progress_principal.get()))
        return DownloadResult(success=True, file_path=None)
    monkeypatch.setattr(engine, 'download_single_track', process)
    requests = [TrackDownloadRequest(search_query=f'Song {i}', metadata=TrackMetadata(title=f'Song {i}'), destination=c.config.base_music_dir / 'Album') for i in range(4)]
    job = ledger.start('download', 'Album', [request_item(r) for r in requests], principal)
    ledger.running(job, 1)
    for idx, state in enumerate(('done','failed','skipped','interrupted')):
        ledger.item_transition(job, idx, 1, state)
    ledger.finish(job, 1)
    from app.domains.jobs.routes import retry_job, RetryRequest
    one = await retry_job(job, RetryRequest(attempt=1), LOCAL_OWNER, c)
    two = await retry_job(job, RetryRequest(attempt=1), LOCAL_OWNER, c)
    assert one == two == {'id': job, 'attempt': 2}
    for _ in range(20):
        await asyncio.sleep(.01)
        if ledger.get(job)['state'] not in ('queued','running'):
            break
    assert [title for title,_ in seen] == ['Song 1','Song 2','Song 3']
    assert all(actor.user_id == principal.user_id and actor.role == 'member' for _,actor in seen)
    assert ledger.get(job)['state'] == 'succeeded'
    assert ledger.get(job)['attempt'] == 2


@pytest.mark.asyncio
async def test_raising_download_handler_is_partial_never_succeeded(setup, monkeypatch):
    c, _, _ = setup
    engine = c.get_download_service().engine
    async def process(request, progress_cb=None):
        if request.metadata.title == 'bad':
            raise RuntimeError('handler failed')
        return DownloadResult(success=True, file_path=None)
    monkeypatch.setattr(engine, 'download_single_track', process)
    job = 'handler-test'
    requests = [TrackDownloadRequest(search_query=name, metadata=TrackMetadata(title=name), destination=c.config.base_music_dir) for name in ('good','bad')]
    await engine.download_multiple_tracks(requests, progress_id=job)
    assert c.get_jobs().get(job)['state'] == 'partial'
    failed = c.get_jobs().items(job, 'failed')
    assert failed[0]['item'] == 'bad'
    assert failed[0]['detail']['reason'] == 'handler failed'
    assert c.get_jobs().retryable(job)


@pytest.mark.asyncio
async def test_reboot_queued_download_resumes_once_running_never_reruns(setup, monkeypatch):
    c, _, _ = setup
    ledger = c.get_jobs()
    engine = c.get_download_service().engine
    seen = []
    async def process(request, progress_cb=None):
        seen.append(request.search_query)
        return DownloadResult(success=True, file_path=None)
    monkeypatch.setattr(engine, 'download_single_track', process)
    request = TrackDownloadRequest(search_query='queued', metadata=TrackMetadata(title='queued'), destination=c.config.base_music_dir)
    queued = ledger.start('download', 'queued', [request_item(request)], LOCAL_OWNER)
    running = ledger.start('download', 'running', [request_item(request)], LOCAL_OWNER)
    ledger.running(running, 1)
    boot(c)
    await _settled(ledger, queued)
    assert seen == ['queued']
    assert ledger.get(queued)['state'] == 'succeeded'
    assert ledger.get(running)['state'] == 'interrupted'
    assert ledger.items(running)[0]['state'] == 'interrupted'
    boot(c)
    await asyncio.sleep(.01)
    assert seen == ['queued']


def test_retry_request_survives_tracker_and_engine_replacement(setup):
    c, _, _ = setup
    ledger = c.get_jobs()
    request = TrackDownloadRequest(search_query='Title Artist', metadata=TrackMetadata(title='Title', artist='Artist'), destination=c.config.base_music_dir, cover_data=b'image')
    job = ledger.start('download', 'Title', [request_item(request)], LOCAL_OWNER)
    ledger.finish(job, 1)
    retry = c.get_download_service().engine.retry_request(job, 0, 'https://youtube.com/watch?v=x')
    assert retry.search_query is None
    assert retry.metadata.title == 'Title'
    assert retry.cover_data == b'image'
    c.get_progress_tracker().mark_failure_retried(job, 0, 'new-id')
    assert ledger.items(job)[0]['detail']['retriedAs'] == 'new-id'


def test_request_registration_preserves_successful_duplicate_titles(setup):
    c, _, _ = setup
    tracker, ledger = c.get_progress_tracker(), c.get_jobs()
    tracker.create_progress('duplicates', 3, items=[{'item':'Same'}]*3)
    ledger.outcome('duplicates', 'Same', success=True, idx=0)
    requests = [TrackDownloadRequest(search_query=f'Same {i}', metadata=TrackMetadata(title='Same'), destination=c.config.base_music_dir) for i in range(2)]
    register_requests(tracker, 'duplicates', requests)
    rows = ledger.items('duplicates')
    assert rows[0]['state'] == 'done'
    assert [i['detail']['_retry']['request']['search_query'] for i in rows[1:]] == ['Same 0','Same 1']


@pytest.mark.asyncio
async def test_queued_unresolved_download_call_resumes_once(setup, monkeypatch):
    from app.infra.job_requests import record_call
    c, _, _ = setup
    ledger, tracker = c.get_jobs(), c.get_progress_tracker()
    token = progress_principal.set(LOCAL_OWNER)
    try:
        tracker.create_progress('unresolved', 2, items=[{'item':'A'}, {'item':'B'}])
    finally:
        progress_principal.reset(token)
    record_call(tracker, 'unresolved', 'download_spotify_playlist',
                tracks=[{'name':'A'}, {'name':'B'}], destination=c.config.base_music_dir)
    ledger.outcome('unresolved', 'A', success=True, idx=0)
    seen = []
    async def process(request, progress_cb=None):
        seen.append(request.metadata.title)
        return DownloadResult(success=True, file_path=None)
    monkeypatch.setattr(c.get_download_service().engine, 'download_single_track', process)
    boot(c)
    await _settled(ledger, 'unresolved')
    assert seen == ['B']
    assert ledger.get('unresolved')['state'] == 'succeeded'
    assert ledger.get('unresolved')['succeeded'] == 2


def test_unreadable_queue_is_reported_without_hiding_other_jobs(setup):
    c, client, _ = setup
    c.get_jobs().start('download', 'Visible', ['Song'])
    c.get_stems_service().repository.queue_file.write_text('{bad JSON')
    got = client.get('/api/jobs').json()
    assert got['degraded'] == ['stems']
    assert got['jobs'][0]['label'] == 'Visible'


def test_old_catalog_batch_cannot_execute_a_new_attempt(setup, monkeypatch):
    from app.domains.lyrics.services import _Job
    c, _, _ = setup
    lyrics = c.get_lyrics_service()
    monkeypatch.setattr(lyrics, '_ensure_worker_locked', lambda: None)
    summary = lyrics._enqueue([_Job('A/song.mp3', 'Song', 'Artist', 'Album', None, None)], label='scan')
    job_id = summary.progress_id
    old = lyrics._queue.popleft()
    c.get_jobs().cancel(job_id, 1)
    c.get_jobs().retry(job_id, 1)
    collector = Mock(side_effect=AssertionError('old item must not run'))
    monkeypatch.setattr(lyrics, '_collect', collector)
    lyrics._process(old)
    collector.assert_not_called()
    assert c.get_jobs().get(job_id)['state'] == 'queued'
    assert c.get_jobs().get(job_id)['attempt'] == 2


@pytest.mark.asyncio
async def test_retry_unresolved_import_expands_into_individual_items(setup, monkeypatch):
    from app.infra.job_requests import record_call
    from app.infra.jobs_runtime import dispatch
    c, _, _ = setup
    tracker, ledger = c.get_progress_tracker(), c.get_jobs()
    token = progress_principal.set(LOCAL_OWNER)
    try:
        tracker.create_progress('import-before-list', 0, kind='import', label='List')
    finally:
        progress_principal.reset(token)
    record_call(tracker, 'import-before-list', 'import_playlist_from_url',
                playlist_url='https://example.com/list', destination=c.config.base_music_dir)
    ledger.cancel('import-before-list', 1)
    ledger.retry('import-before-list', 1)
    # The producer discovers the list only after the retry starts.
    service = c.get_download_service()
    async def import_call(**kwargs):
        tracker.set_total('import-before-list', 2)
        requests = [TrackDownloadRequest(search_query=name, metadata=TrackMetadata(title=name), destination=c.config.base_music_dir) for name in ('One','Two')]
        return 'List', await service.engine.download_multiple_tracks(requests, progress_id=kwargs['progress_id'])
    monkeypatch.setattr(service, 'import_playlist_from_url', import_call)
    async def process(request, progress_cb=None):
        return DownloadResult(success=True, file_path=None)
    monkeypatch.setattr(service.engine, 'download_single_track', process)
    dispatch(c, 'import-before-list')
    await _settled(ledger, 'import-before-list')
    assert ledger.get('import-before-list')['state'] == 'succeeded'
    assert [i['item'] for i in ledger.items('import-before-list')] == ['One','Two']
    assert ledger.get('import-before-list')['succeeded'] == 2


@pytest.mark.asyncio
async def test_per_song_retry_is_durable_before_its_background_task(setup, monkeypatch):
    from types import SimpleNamespace
    from app.domains.downloads import routes
    c, _, _ = setup
    from app.providers.registry import ProviderDescriptor, ProviderKind
    from app.providers.adapters import SourceStreamingProvider
    port = SimpleNamespace(id='fake', url_hosts=frozenset({'youtube.com'}), ready=lambda: True, close=lambda: None)
    c.get_provider_registry().register(ProviderDescriptor(id='fake', name='Fake', kind=ProviderKind.STREAMING, description=''), SourceStreamingProvider(port))
    ledger = c.get_jobs()
    request = TrackDownloadRequest(search_query='Title', metadata=TrackMetadata(title='Title'), destination=c.config.base_music_dir)
    original = ledger.start('download', 'Title', [request_item(request)], LOCAL_OWNER)
    ledger.finish(original, 1)
    monkeypatch.setattr(routes, 'spawn_background', lambda coro: coro.close())
    result = await routes.retry_download(
        routes.RetryDownloadRequest(progress_id=original, index=0, youtube_url='https://youtube.com/watch?v=chosen'),
        download_service=c.get_download_service(), progress_tracker=c.get_progress_tracker(),
        user_tracks=c.get_user_track_store(), principal=LOCAL_OWNER, scope=SimpleNamespace(unrestricted=True))
    item = ledger.items(result.progress_id)[0]
    assert ledger.get(result.progress_id)['state'] == 'queued'
    assert item['detail']['_retry']['request']['youtube_url'] == 'https://youtube.com/watch?v=chosen'
    assert ledger.items(original)[0]['detail']['retriedAs'] == result.progress_id


@pytest.mark.parametrize('owner', [False, True])
def test_clear_one_is_scoped_terminal_and_idempotent(setup, owner):
    c, client, actor = setup
    ledger = c.get_jobs()
    own = ledger.start('download', 'Finished', ['A'], 'member')
    other = ledger.start('download', 'Other', ['B'], 'stranger')
    running = ledger.start('import', 'Running', ['C'], 'member')
    ledger.running(running, 1)
    ledger.finish(own, 1)
    ledger.finish(other, 1)
    actor[0] = LOCAL_OWNER if owner else Principal('member', 'Member')
    assert client.post(f'/api/jobs/{running}/clear').status_code == 409
    assert client.post('/api/jobs/unknown/clear').status_code == 404
    assert client.post(f'/api/jobs/{other}/clear').status_code == (200 if owner else 404)
    tag = client.get('/api/jobs').headers['etag']
    assert client.post(f'/api/jobs/{own}/clear').json() == {'cleared': 1}
    assert client.post(f'/api/jobs/{own}/clear').json() == {'cleared': 0}
    response = client.get('/api/jobs', headers={'If-None-Match': tag})
    assert response.status_code == 200
    assert own not in {r['id'] for r in response.json()['jobs']}
    assert ledger.get(running)['cleared_at'] is None
    if not owner:
        assert ledger.get(other)['cleared_at'] is None


def test_match_kind_is_readable_and_cancel_stops_resolution(setup):
    c, client, _ = setup
    job = c.get_jobs().start('match', 'Collection', ['Track'], LOCAL_OWNER)
    service = Mock()
    c._services['export_import_service'] = service
    assert client.get('/api/jobs').json()['jobs'][0]['kind'] == 'match'
    assert client.post(f'/api/jobs/{job}/cancel').status_code == 200
    service.cancel_resolution.assert_called_once_with(job)
