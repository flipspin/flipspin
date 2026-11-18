"""Acquisition retries and restart recovery without duplicate downloads."""
import asyncio
from unittest.mock import Mock

import pytest

from app.domains.acquisition.repository import Requests
from app.domains.acquisition.services import Pipeline
from app.domains.user_library.store import UserTrackStore
from app.infra.jobs import Jobs
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import legacy_submit, ANA, body, configure_capacity, submit

pipeline = fixtures.pipeline


def test_retry_fetches_only_the_failed_track(pipeline):
    original = pipeline.engine._download_audio_file
    async def fail_one(url, destination, filename, percent_cb=None):
        if filename.startswith('02'):
            raise OSError('offline')
        return await original(url, destination, filename, percent_cb)
    pipeline.engine._download_audio_file = fail_one
    request = submit(pipeline, body(3))
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'parcial'
    pipeline.engine._download_audio_file = original
    pipeline.retry(request['id'], ANA, schedule=False)
    asyncio.run(pipeline.run(request['id']))
    assert len(pipeline.engine.calls) == 3
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'


def test_restart_reuses_a_finished_fetch_and_repairs_link(pipeline):
    from app.domains.acquisition import services
    request = submit(pipeline)
    original_import = services.import_file
    import_count = [0]
    def crash(staged, destination, **kwargs):
        import_count[0] += 1
        raise KeyboardInterrupt('process stopped after fetch committed')
    services.import_file = crash
    try:
        with pytest.raises(KeyboardInterrupt):
            asyncio.run(pipeline.run(request['id']))
    finally:
        services.import_file = original_import
    assert len(pipeline.engine.calls) == 1
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'importing'
    with pipeline.ledger.db:
        pipeline.ledger.db.execute("DELETE FROM acquisition_transfers WHERE state='running'")
    asyncio.run(pipeline.run(request['id']))
    assert len(pipeline.engine.calls) == 1
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 1
    assert all(i['state'] == 'done' for i in pipeline.view(request['id'], ANA)['items'])


def test_failed_link_retries_without_fetching_again(pipeline, monkeypatch):
    original = pipeline.user_tracks.add_many
    def refuse(*args, **kwargs):
        raise OSError('library is read-only')
    monkeypatch.setattr(pipeline.user_tracks, 'add_many', refuse)
    request = submit(pipeline)
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'parcial'
    monkeypatch.setattr(pipeline.user_tracks, 'add_many', original)
    pipeline.retry(request['id'], ANA, schedule=False)
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'
    assert len(pipeline.engine.calls) == 1


def test_restart_mid_album_keeps_published_and_staged_indices(pipeline):
    configure_capacity(pipeline)
    request = submit(pipeline, body(3))
    original = pipeline.engine._download_audio_file

    async def scenario():
        blocked = asyncio.Event()
        async def download(url, destination, filename, percent_cb=None):
            if filename.startswith('03'):
                blocked.set()
                await asyncio.Event().wait()
            return await original(url, destination, filename, percent_cb)

        pipeline.engine._download_audio_file = download
        task = asyncio.create_task(pipeline.run(request['id']))
        await asyncio.wait_for(blocked.wait(), 2)
        async def published():
            while len(pipeline.user_tracks.list_for_user(ANA.user_id)) < 2:
                await asyncio.sleep(0.001)
        await asyncio.wait_for(published(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert len(pipeline.engine.calls) == 2
        pipeline.engine._download_audio_file = original
        pipeline.ledger.close()
        pipeline.ledger = Jobs(pipeline.data / 'jobs.sqlite')
        pipeline.store = Requests(pipeline.ledger)
        pipeline.user_tracks = UserTrackStore(pipeline.data / 'tracks.json')
        resumed = Pipeline(ledger=pipeline.ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                           user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data)
        pending = []
        resumed.kick = pending.append
        resumed.resume()
        assert pending == [request['id']]
        results = await asyncio.wait_for(resumed.run(request['id']), 2)
        assert [result.file_path.name for result in results] == [f'{i+1:02} - Song {i}.mp3' for i in range(3)]

    asyncio.run(scenario())
    assert len(pipeline.engine.calls) == 3
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 3
    assert len(list(pipeline.root.rglob('*.mp3'))) == 3
    assert not list(pipeline.recycle.glob('*'))
    assert pipeline.view(request['id'], ANA)['state'] == 'completo'
    assert all(item['state'] == 'done' for item in pipeline.view(request['id'], ANA)['items'])


@pytest.mark.parametrize('before_link_receipt', [False, True])
def test_restart_repairs_published_receipt_without_refetch(pipeline, monkeypatch, before_link_receipt):
    request = submit(pipeline)
    original = pipeline._done

    def interrupted(job, idx, **kwargs):
        stage = f'acquisition-{job.name}'
        if stage == ('acquisition-link' if before_link_receipt else 'acquisition-import'):
            raise KeyboardInterrupt('process stopped after publication')
        return original(job, idx, **kwargs)

    monkeypatch.setattr(pipeline, '_done', interrupted)
    with pytest.raises(KeyboardInterrupt):
        asyncio.run(pipeline.run(request['id']))
    monkeypatch.setattr(pipeline, '_done', original)
    with pipeline.ledger.db:
        pipeline.ledger.db.execute("DELETE FROM acquisition_transfers WHERE state='running'")
    asyncio.run(pipeline.run(request['id']))
    assert len(pipeline.engine.calls) == 1
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 1
    assert not list(pipeline.recycle.glob('*'))
    assert pipeline.view(request['id'], ANA)['state'] == 'completo'
    assert all(item['state'] == 'done' for item in pipeline.view(request['id'], ANA)['items'])


def test_restart_resumes_sparse_stages_from_batch_pipeline(pipeline):
    request = legacy_submit(pipeline, body(3))
    id = request['id']
    work = pipeline.store.work(id)
    requests = pipeline._requests(work['body'])
    pipeline.store.state(id, 'fetching')
    match_job = pipeline._stage(id, 'match', requests, ANA)
    fetch_job = pipeline._stage(id, 'fetch', requests, ANA)
    for idx in range(3):
        pipeline._done(match_job, idx, detail={'decision': 'STRONG'})
    pipeline._done(fetch_job, 0, error='source refused', reason='fallo-descarga')
    identity = pipeline._identity(work['body'], 0)
    with pipeline.ledger.db:
        pipeline.ledger.db.execute("INSERT INTO acquisition_transfers(identity,provider,job_id,state,reason,owner_request_id) VALUES(?,?,?,'failed',?,?)",
                                  (identity, 'youtube', fetch_job, 'fallo-descarga', id))
    # The old pipeline staged all successes, then imported a sparse subset.
    import_job = pipeline._stage(id, 'import', requests[1:], ANA, [1, 2])
    for idx in (1, 2):
        path = pipeline.incoming / fetch_job / str(idx) / f'{requests[idx].get_filename()}.mp3'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'complete audio')
        pipeline._done(fetch_job, idx, path=path)
        if idx == 1:
            from app.domains.acquisition.import_stage import import_file
            landed = import_file(path, requests[idx].destination, root=pipeline.root,
                                 incoming=pipeline.incoming, recycle=pipeline.recycle)
            pipeline._done(import_job, 0, path=landed)
    for job in (match_job, fetch_job):
        pipeline.ledger.finish(job, pipeline.ledger.get(job)['attempt'])
    pipeline.store.state(id, 'importing')
    asyncio.run(pipeline.run(id))
    live = pipeline.view(id, ANA)
    assert live['state'] == 'parcial'
    assert pipeline.engine.calls == []
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 2
    assert len(list(pipeline.root.rglob('*.mp3'))) == 2
    imports = [item for item in live['items'] if item['stage'] == 'import']
    assert [item['detail']['index'] for item in imports] == [1, 2]
    assert all(item['state'] == 'done' for item in imports)
    assert not list(pipeline.recycle.glob('*'))


def test_restart_while_other_songs_are_searching_keeps_published_song(pipeline):
    request = submit(pipeline, body(4))
    original = pipeline.engine._resolve_source_url
    async def scenario():
        blocked = asyncio.Event()
        async def search(req):
            if req.metadata.track_number > 1:
                blocked.set()
                await asyncio.Event().wait()
            return await original(req)
        pipeline.engine._resolve_source_url = search
        task = asyncio.create_task(pipeline.run(request['id']))
        await asyncio.wait_for(blocked.wait(), 2)
        async def published():
            while not pipeline.user_tracks.list_for_user(ANA.user_id):
                await asyncio.sleep(0.001)
        await asyncio.wait_for(published(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert pipeline.search_limiter.active == 0
        pipeline.engine._resolve_source_url = original
        pipeline.ledger.close()
        pipeline.ledger = Jobs(pipeline.data / 'jobs.sqlite')
        pipeline.store = Requests(pipeline.ledger)
        resumed = Pipeline(ledger=pipeline.ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                           user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data)
        resumed.kick = Mock()
        resumed.resume()
        resumed.kick.assert_called_once_with(request['id'])
        await asyncio.wait_for(resumed.run(request['id']), 2)
    asyncio.run(scenario())
    assert len(pipeline.engine.calls) == 4
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 4
    assert pipeline.view(request['id'], ANA)['state'] == 'completo'


@pytest.mark.parametrize('stage', ['fetch', 'import'])
def test_unexpected_item_error_records_retryable_kind(pipeline, monkeypatch, stage):
    from app.domains.acquisition import services

    async def fetch(*args):
        raise RuntimeError('unexpected fetch error')
    def publish(*args, **kwargs):
        raise RuntimeError('unexpected import error')
    if stage == 'fetch':
        monkeypatch.setattr(pipeline.engine, '_download_audio_file', fetch)
    else:
        monkeypatch.setattr(services, 'import_file', publish)
    request = submit(pipeline)
    asyncio.run(pipeline.run(request['id']))
    view = pipeline.view(request['id'], ANA)
    assert view['state'] == 'fallido'
    assert view['retryable'] is True
    failed = next(item for item in view['items'] if item['stage'] == stage and item['state'] == 'failed')
    assert failed['detail']['kind'] == ('broken' if stage == 'fetch' else 'RuntimeError')
    assert failed['detail']['retryable'] is True
    assert not any(item['state'] in ('queued', 'running') for item in view['items'])
    assert pipeline.retry(request['id'], ANA, schedule=False)['state'] == 'approved'


@pytest.mark.asyncio
@pytest.mark.parametrize('state,stage', [('fetching', 'fetch'), ('importing', 'import')])
async def test_restarted_run_with_unexpected_error_finishes_retryable(pipeline, monkeypatch, state, stage):
    from app.domains.acquisition import services

    request = legacy_submit(pipeline)
    id = request['id']
    pipeline.store.state(id, 'fetching')
    if state == 'importing':
        pipeline.store.state(id, 'importing')
    work = pipeline.store.work(id)
    job = pipeline._stage(id, stage, pipeline._requests(work['body']), ANA)
    pipeline.ledger.item_transition(job, 0, 1, 'running')
    pipeline.ledger.close()
    pipeline.ledger = Jobs(pipeline.data / 'jobs.sqlite')
    pipeline.ledger.boot()
    pipeline.store = Requests(pipeline.ledger)
    resumed = Pipeline(ledger=pipeline.ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                       user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data)
    original = resumed._run
    async def unexpected(*args, **kwargs):
        raise RuntimeError('unexpected resumed error')
    monkeypatch.setattr(resumed, '_run', unexpected)
    tasks = []
    def spawn(coro):
        task = asyncio.create_task(coro)
        tasks.append(task)
        return task
    monkeypatch.setattr(services, 'spawn_background', spawn)
    resumed.resume()
    await asyncio.wait_for(asyncio.gather(*tasks), 2)
    view = resumed.view(id, ANA)
    assert view['state'] == 'fallido'
    assert view['retryable'] is True
    assert not resumed._active
    failed = next(item for item in view['items'] if item['stage'] == stage)
    assert failed['state'] == 'failed'
    assert failed['detail']['kind'] == 'RuntimeError'
    monkeypatch.setattr(resumed, '_run', original)
    resumed.retry(id, ANA, schedule=False)
    await asyncio.wait_for(resumed.run(id), 2)
    assert resumed.view(id, ANA)['state'] == 'completo'


@pytest.mark.asyncio
async def test_catalog_unexpected_error_completes_progress(pipeline, monkeypatch):
    from app.domains.acquisition import services
    from app.domains.browse.acquisition import AcquireRequest
    from app.infra.progress import ProgressTracker

    pipeline.tracker = ProgressTracker(pipeline.ledger)
    async def unexpected(*args, **kwargs):
        raise RuntimeError('unexpected catalog error')
    monkeypatch.setattr(pipeline, '_run', unexpected)
    tasks = []
    def spawn(coro):
        task = asyncio.create_task(coro)
        tasks.append(task)
        return task
    monkeypatch.setattr(services, 'spawn_background', spawn)
    response = await pipeline.catalog(AcquireRequest(tracks=[{'title': 'Song', 'artistName': 'Artist'}]), ANA)
    await asyncio.wait_for(asyncio.gather(*tasks), 2)
    snapshot = pipeline.tracker.get_progress(response['progress_id']).to_dict()
    assert snapshot['terminal'] is True
    assert snapshot['status'] == 'failed'
    assert snapshot['failures'][0]['kind'] == 'RuntimeError'
    row = pipeline.store.list(ANA.user_id)[0]
    assert pipeline.view(row['id'], ANA)['retryable'] is True
