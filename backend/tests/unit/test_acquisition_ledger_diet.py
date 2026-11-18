"""Durable stage changes have bounded cost; disposable ticks have none."""
import asyncio
from functools import wraps
from unittest.mock import Mock

import pytest

from app.domains.acquisition.request_job import RequestJob
from app.domains.acquisition.services import Pipeline
from app.infra.jobs import Jobs
from tests.unit.test_acquisition import ANA, body, pipeline as pipeline, submit


def mutations(statements):
    return [sql for sql in statements if sql.startswith(('UPDATE ', 'INSERT ', 'DELETE '))]


def test_ten_songs_write_three_statements_per_stage_and_zero_per_percent(pipeline, monkeypatch):
    request = submit(pipeline, body(10))
    assert len(pipeline.ledger.list()) == 1
    assert all(item['stage'] == 'requested' and item['stage_at'] is not None for item in pipeline.ledger.items(request['id']))
    original_download = pipeline.engine._download_audio_file
    original_transition = pipeline.ledger.stage_transition
    original_items = pipeline.ledger.items
    statements, costs, ticks, notifications = [], [], [], []
    clock = [0.0]
    in_transition = [False]
    pipeline.tracker.now = lambda: clock[0]
    pipeline.ledger._on_change = lambda: notifications.append(None)
    pipeline.ledger.db.set_trace_callback(statements.append)

    def locked(function):
        @wraps(function)
        def call(*args, **kwargs):
            with pipeline.ledger.lock:
                return function(*args, **kwargs)
        return call

    @locked
    def items(*args, **kwargs):
        assert not in_transition[0], 'stage transition must not read the whole request'
        return original_items(*args, **kwargs)

    @locked
    def transition(*args, **kwargs):
        before = len(statements)
        in_transition[0] = True
        try:
            changed = original_transition(*args, **kwargs)
        finally:
            in_transition[0] = False
        if changed:
            costs.append(len(mutations(statements[before:])))
        return changed

    async def download(url, destination, filename, percent_cb=None):
        with pipeline.ledger.lock:
            emitted = []
            for value in range(101):
                before = len(statements)
                version, changes = pipeline.ledger.version, len(notifications)
                live_version = pipeline.tracker.current_version()
                percent_cb(value)
                assert not mutations(statements[before:])
                assert (pipeline.ledger.version, len(notifications)) == (version, changes)
                if pipeline.tracker.current_version() != live_version:
                    emitted.append(clock[0])
                clock[0] += 0.01
            ticks.append(emitted)
        return await original_download(url, destination, filename, percent_cb)

    monkeypatch.setattr(pipeline.ledger, 'items', items)
    monkeypatch.setattr(pipeline.ledger, 'stage_transition', transition)
    pipeline.engine._download_audio_file = download
    results = asyncio.run(pipeline.run(request['id']))
    pipeline.ledger.db.set_trace_callback(None)
    assert all(result.success for result in results), [result.error for result in results]
    assert costs == [3] * 50  # One item, one counter, one revision per transition.
    assert len(ticks) == 10
    assert all(2 <= len(times) <= 5 and all(b-a >= 0.25 for a, b in zip(times, times[1:], strict=False)) for times in ticks)
    assert len(pipeline.ledger.list()) == 1
    assert len(pipeline.ledger.items(request['id'])) == 10
    assert not pipeline.ledger.db.execute('SELECT 1 FROM acquisition_stages').fetchall()
    # Registration happened before tracing. The run writes five item stages
    # per song; other tables keep transfer and request lifecycle receipts.
    item_writes = [sql for sql in mutations(statements) if sql.startswith(('UPDATE items ', 'INSERT OR REPLACE INTO items'))]
    assert len(item_writes) == 51  # Includes the constant final no-op safety sweep.


@pytest.mark.parametrize('stop_at', ['matched', 'fetched', 'processed'])
def test_restart_resumes_exact_song_stage_without_repeating_completed_work(pipeline, monkeypatch, stop_at):
    from app.domains.acquisition import services

    request = submit(pipeline)
    original_fetch = pipeline.engine._download_audio_file
    original_process = pipeline.engine._finish_staged_file
    original_import = services.import_file
    search = Mock(wraps=pipeline.engine._resolve_source_url)
    pipeline.engine._resolve_source_url = search

    async def fetch(*args):
        if stop_at == 'matched':
            raise asyncio.CancelledError()
        return await original_fetch(*args)

    async def process(*args):
        if stop_at == 'fetched':
            raise asyncio.CancelledError()
        return await original_process(*args)

    def publish(*args, **kwargs):
        raise KeyboardInterrupt('stop after processing')

    pipeline.engine._download_audio_file = fetch
    pipeline.engine._finish_staged_file = process
    if stop_at == 'processed':
        monkeypatch.setattr(services, 'import_file', publish)
    with pytest.raises(KeyboardInterrupt if stop_at == 'processed' else asyncio.CancelledError):
        asyncio.run(pipeline.run(request['id']))
    assert pipeline.ledger.items(request['id'])[0]['stage'] == stop_at
    pipeline.engine._download_audio_file = original_fetch
    pipeline.engine._finish_staged_file = original_process
    monkeypatch.setattr(services, 'import_file', original_import)
    pipeline.ledger.close()
    pipeline.ledger = Jobs(pipeline.data / 'jobs.sqlite')
    pipeline.ledger.boot()
    resumed = Pipeline(ledger=pipeline.ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                       user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data)
    pending = []
    resumed.kick = pending.append
    resumed.resume()
    assert pending == [request['id']]
    assert asyncio.run(resumed.run(request['id']))[0].success
    assert len(pipeline.engine.calls) == 1
    assert search.call_count == 1
    assert resumed.ledger.items(request['id'])[0]['stage'] == 'linked'
    assert all(isinstance(item['stageAt'], float) for item in resumed.view(request['id'], ANA)['items'])


def test_retry_keeps_one_job_and_fences_the_old_attempt(pipeline):
    original = pipeline.engine._download_audio_file

    async def fail_one(url, destination, filename, percent_cb=None):
        if filename.startswith('02'):
            raise OSError('connection refused')
        return await original(url, destination, filename, percent_cb)

    pipeline.engine._download_audio_file = fail_one
    request = submit(pipeline, body(2))
    asyncio.run(pipeline.run(request['id']))
    old = RequestJob.find(pipeline.ledger, request['id'], pipeline.tracker)
    assert pipeline.ledger.get(old.id)['failed'] == 1
    pipeline.retry(request['id'], ANA, schedule=False)
    version = pipeline.ledger.version
    assert not old.advance(1, 'matched')
    assert pipeline.ledger.version == version
    pipeline.engine._download_audio_file = original
    assert all(r.success for r in asyncio.run(pipeline.run(request['id'])))
    assert len(pipeline.engine.calls) == 2
    assert len(pipeline.ledger.list()) == 1
    job = pipeline.ledger.get(old.id)
    assert (job['attempt'], job['succeeded'], job['failed']) == (2, 2, 0)
    assert [item['attempt'] for item in pipeline.ledger.items(old.id)] == [1, 2]


def test_broken_retry_requeues_new_song_stages_once_under_the_same_job(pipeline):
    from tests.source_plugin_support import failure

    pipeline.ledger.now = lambda: 100.0
    original = pipeline.engine._download_audio_file

    entered = [0]
    both_fetching = asyncio.Event()
    async def broken_or_offline(url, destination, filename, percent_cb=None):
        entered[0] += 1
        if entered[0] == 2:
            both_fetching.set()
        await both_fetching.wait()
        raise failure('broken' if filename.startswith('01') else 'network')

    pipeline.engine._download_audio_file = broken_or_offline
    pipeline.sleep = lambda seconds: asyncio.sleep(0)
    request = submit(pipeline, body(2))
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.retry_broken(0, 101, 'test-release')[0] == [request['id']]
    pipeline.ledger.now = lambda: 10000.0
    pipeline.engine._download_audio_file = original
    asyncio.run(pipeline.run(request['id']))
    assert len(pipeline.ledger.list()) == 1
    items = pipeline.ledger.items(request['id'])
    assert items[0]['stage'] == 'linked'
    assert items[0]['detail']['sourceRetry'] == 'test-release'
    assert items[1]['stage'] == 'failed:network'
    assert items[1]['detail']['failedAt'] == 100
    assert pipeline.retry_broken(0, 10001, 'next-release') == ([], True)
    assert len(pipeline.engine.calls) == 1


def test_cancelling_before_execution_closes_the_registered_request_job(pipeline):
    request = submit(pipeline)
    pipeline.tracker.create_progress(request['id'], 1)
    pipeline.cancel(request['id'], ANA)
    assert pipeline.tracker.get_progress(request['id']).is_terminal
    assert pipeline.ledger.get(request['id'])['state'] == 'cancelled'
    assert asyncio.run(pipeline.run(request['id'])) == []
    assert not pipeline.engine.calls
