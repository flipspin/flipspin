"""Source classification, durable health, and independent stage admission."""
import asyncio
import sqlite3
from dataclasses import replace

import pytest

from app.exceptions import FailureKind, ProviderRateLimitedError
from app.domains.acquisition.failures import POLICIES
from tests.source_plugin_support import failure
from app.domains.acquisition.failures import classify_failure
from app.domains.acquisition.health import SourceHealth, LADDER
from app.infra.jobs import Jobs
from app.infra.jobs.schema import JOBS, source_health
from app.infra.migrations import open_store
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, body, configure_capacity, submit

pipeline = fixtures.pipeline






@pytest.mark.parametrize('error,kind', [(OSError('local network'), 'network'), (TimeoutError(), 'network'),
                                      (TypeError('wrong argument'), 'bug')])
def test_native_failure_types(error, kind):
    assert classify_failure(error).kind == kind


@pytest.mark.parametrize('kind', list(FailureKind))
def test_only_rate_limit_blocked_and_broken_escalate(pipeline, kind):
    now = [10000.0]
    pipeline.ledger.now = lambda: now[0]
    health = SourceHealth(pipeline.ledger, started_at=0, jitter=lambda: 1)
    error = failure(kind)
    health.failure('fake', error)
    status = health.status('fake')
    if POLICIES[kind].penalize:
        assert status == {'state': 'busy' if kind == FailureKind.RATE_LIMITED else 'broken',
                          'kind': kind, 'level': 1, 'until': 10060, 'since': 10000, 'firstFailureAt': 10000, 'lastFailureAt': 10000}
        now[0] = 10061
        health.success('fake')
        assert health.status('fake') == {'state': 'ok', 'kind': None, 'level': 0, 'until': None, 'since': None, 'firstFailureAt': 10000, 'lastFailureAt': 10000}
    elif kind == FailureKind.AUTH_REQUIRED:
        assert status['state'] == 'broken' and status['kind'] == 'auth-required'
        assert status['level'] == 0 and status['until'] is None
    else:
        assert status == {'state': 'ok'}


def test_full_ladder_caps_and_steps_down_one_per_success(pipeline):
    now = [10000.0]
    pipeline.ledger.now = lambda: now[0]
    health = SourceHealth(pipeline.ledger, started_at=0, jitter=lambda: 1)
    error = failure('rate-limited')
    for level, delay in enumerate((*LADDER, LADDER[-1]), 1):
        health.failure('fake', error)
        status = health.status('fake')
        assert status['level'] == min(9, level)
        assert status['until'] == now[0] + delay
        assert status['since'] == 10000
        now[0] = status['until'] + 1
    for level in range(8, -1, -1):
        health.success('fake')
        assert health.status('fake')['level'] == level


def test_retry_wakes_queued_fetch_and_preserves_ladder(pipeline):
    request = submit(pipeline)
    pipeline.health.failure('youtube', ProviderRateLimitedError('slow down', retry_after=86400))
    before = pipeline.health.status('youtube')

    async def scenario():
        sleeping = asyncio.Event()
        async def sleep(seconds):
            sleeping.set()
            await asyncio.Event().wait()
        pipeline.sleep = sleep
        task = asyncio.create_task(pipeline.run(request['id']))
        try:
            await asyncio.wait_for(sleeping.wait(), 2)
            assert not pipeline.engine.calls
            health = await asyncio.to_thread(pipeline.health.retry, 'youtube')
            assert health['state'] == 'ok' and health['until'] is None
            assert health['level'] == before['level']
            assert all(item['reason'] != 'en-pausa' for item in pipeline.view(request['id'], ANA)['items'])
            results = await asyncio.wait_for(task, 2)
            assert results[0].success
            assert pipeline.health.status('youtube')['level'] == 0
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())


def test_failure_dates_keep_initial_failure_and_advance_last_failure(pipeline):
    now = [10000]
    pipeline.ledger.now = lambda: now[0]
    pipeline.health.failure('youtube', failure('blocked'))
    now[0] += 30
    pipeline.health.failure('youtube', failure('blocked'))
    health = pipeline.health.status('youtube')
    assert health['since'] == health['firstFailureAt'] == 10000
    assert health['lastFailureAt'] == 10030


@pytest.mark.parametrize('jitter', [0.9, 1.1])
def test_jitter_and_startup_grace(pipeline, jitter):
    now = [10000.0]
    pipeline.ledger.now = lambda: now[0]
    health = SourceHealth(pipeline.ledger, jitter=lambda: jitter)
    for _ in range(9):
        health.failure('fake', failure('rate-limited'))
    assert health.status('fake')['until'] == 10300
    now[0] += 900  # grace expires at exactly 15 minutes
    health.failure('fake', failure('rate-limited'))
    assert health.status('fake')['until'] == now[0] + 86400 * jitter




def test_health_survives_reopen_and_network_does_not_change_it(pipeline):
    pipeline.health.failure('fake', failure('blocked'))
    before = pipeline.health.status('fake')
    pipeline.health.failure('fake', classify_failure(ConnectionError('offline')))
    assert pipeline.health.status('fake') == before
    db = Jobs(pipeline.data / 'jobs.sqlite')
    try:
        assert SourceHealth(db).status('fake') == before
    finally:
        db.close()


def test_additive_migration_keeps_old_cooldown_and_unused_next_at(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    old = open_store(path, replace(JOBS, steps=JOBS.steps[:JOBS.steps.index(source_health)]))
    old.execute("INSERT INTO acquisition_providers VALUES('fake',20000,15000)")
    old.commit()
    old.close()
    db = Jobs(path)
    try:
        row = dict(db.db.execute('SELECT * FROM acquisition_providers').fetchone())
        assert row == {'provider': 'fake', 'until_at': 20000, 'next_at': 15000, 'level': 1, 'kind': 'rate-limited', 'since': None, 'first_failure_at': None, 'last_failure_at': None, 'published_format': None}
        assert db.db.execute('PRAGMA foreign_key_check').fetchall() == []
    finally:
        db.close()
    with sqlite3.connect(path) as check:
        assert check.execute('SELECT next_at FROM acquisition_providers').fetchone()[0] == 15000


def test_thirteen_songs_take_seven_fetch_batches_without_start_spacing(pipeline):
    configure_capacity(pipeline, 2)
    request = submit(pipeline, body(13))
    original = pipeline.engine._download_audio_file

    async def scenario():
        entered = asyncio.Queue()
        releases = asyncio.Semaphore(0)
        async def download(*args):
            entered.put_nowait(None)
            await releases.acquire()
            return await original(*args)
        pipeline.engine._download_audio_file = download
        # A historic next_at must have no effect on any start.
        with pipeline.ledger.db:
            pipeline.ledger.db.execute("INSERT INTO acquisition_providers(provider,next_at) VALUES('youtube',?)", (pipeline.ledger.now() + 86400,))
        task = asyncio.create_task(pipeline.run(request['id']))
        try:
            for batch in range(7):
                count = 1 if batch == 6 else 2
                for _ in range(count):
                    await asyncio.wait_for(entered.get(), 2)
                assert entered.empty()
                assert pipeline.engine.config.download_limiter.active == count
                if batch == 0:
                    assert pipeline.process_limiter.active == pipeline.import_limiter.active == 0
                for _ in range(count):
                    releases.release()
            results = await asyncio.wait_for(task, 3)
            assert sum(result.success for result in results) == 13
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())


def test_source_wait_holds_no_stage_slots_and_has_a_typed_reason(pipeline):
    configure_capacity(pipeline, 2)
    request = submit(pipeline, body(3))
    pipeline.health.jitter = lambda: 1
    pipeline.health.failure('youtube', ProviderRateLimitedError('any display text', retry_after=120))
    observed = []
    async def sleep(seconds):
        assert pipeline.search_limiter.active == pipeline.engine.config.download_limiter.active == 0
        assert pipeline.process_limiter.active == pipeline.import_limiter.active == 0
        items = pipeline.view(request['id'], ANA)['items']
        waiting = [item for item in items if item['reason'] == 'en-pausa']
        assert waiting and all(item['detail']['kind'] == 'rate-limited' and item['detail']['until'] for item in waiting)
        observed.append(seconds)
        pipeline.ledger.now = lambda: pipeline.health.started_at + 121
    pipeline.sleep = sleep
    asyncio.run(pipeline.run(request['id']))
    assert observed and len(pipeline.engine.calls) == 3


def test_capacity_is_independent_per_source(pipeline):
    async def scenario():
        async with pipeline.fetch_limiter('one').slot(), pipeline.fetch_limiter('one').slot():
            async with pipeline.fetch_limiter('two').slot():
                assert pipeline.fetch_limiter('one').active == 2
                assert pipeline.fetch_limiter('two').active == 1
    asyncio.run(scenario())


def test_processing_is_serial_across_requests_without_holding_fetch_slots(pipeline):
    configure_capacity(pipeline, 2)
    first = submit(pipeline, body(3))
    second = submit(pipeline, body(3).model_copy(update={'provider_id': 'second'}))
    original = pipeline.engine._finish_staged_file
    async def scenario():
        entered, release = asyncio.Queue(), asyncio.Event()
        active = peak = 0
        async def finish(*args):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            entered.put_nowait(None)
            try:
                await release.wait()
                return await original(*args)
            finally:
                active -= 1
        pipeline.engine._finish_staged_file = finish
        tasks = [asyncio.create_task(pipeline.run(row['id'])) for row in (first, second)]
        try:
            await asyncio.wait_for(entered.get(), 2)
            async def fetched_all():
                while len(pipeline.engine.calls) < 6:
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(fetched_all(), 2)
            assert entered.empty() and active == 1
            assert pipeline.engine.config.download_limiter.active == 0
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 3)
            assert peak == 1
        finally:
            release.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(scenario())


def test_source_packaging_precedes_core_processing(pipeline, config, write_audio):
    import shutil
    from unittest.mock import Mock
    from app.domains.acquisition.engine import DownloadEngine
    from app.domains.acquisition.provider import DownloadRepository
    from app.domains.metadata.repositories import MetadataRepository
    source = config.temp_dir / 'fixture.m4a'
    write_audio(source, [0.1] * 44100, 44100)
    class Port:
        id = 'youtube'
        async def fetch(self, candidate, directory, **kwargs):
            assert pipeline.fetch_limiter('youtube').active == 1
            assert pipeline.process_limiter.active == 0
            target = directory / 'audio.m4a'
            shutil.copyfile(source, target)
            return {'path': str(target), 'codec': 'aac', 'transcoded': False}
    engine = DownloadEngine(DownloadRepository(config, Mock(), source=Port()), MetadataRepository(config, Mock()),
                            None, None, config, Mock())
    engine._resolve_source_url = pipeline.engine._resolve_source_url
    pipeline.engine = engine
    original = engine._finish_staged_file
    async def process(path, *args):
        assert pipeline.fetch_limiter('youtube').active == 0
        assert pipeline.process_limiter.active == 1
        assert path.suffix == '.m4a'
        return await original(path, *args)
    engine._finish_staged_file = process
    row = submit(pipeline)
    result = asyncio.run(pipeline.run(row['id']))[0]
    assert result.success and result.file_path.suffix == '.m4a'


def test_container_uses_registry_source_choices(config):
    from app.dependencies import DependencyContainer
    from app.domains.acquisition.models import AcquisitionError
    from app.providers.registry import ProviderKind
    container = DependencyContainer(config)
    registry = container.get_provider_registry()
    assert registry.order(ProviderKind.STREAMING) == []
    assert registry.order(ProviderKind.METADATA)
    with pytest.raises(AcquisitionError, match='no-sources') as refused:
        container.get_acquisition().submit(body(), ANA, schedule=False)
    assert refused.value.status == 409


@pytest.mark.parametrize('message,kind', [('429', 'rate-limited'), ('403', 'blocked'),
                                          ('unknown', 'broken'), ('authentication required', 'auth-required')])
def test_shared_failed_transfer_preserves_kind_without_reclassifying_message(pipeline, message, kind):
    import json
    from app.exceptions import SourceFailure
    error = failure(kind)
    with pipeline.ledger.db:
        pipeline.ledger.db.execute("INSERT INTO acquisition_transfers(identity,provider,job_id,state,error,reason) VALUES('shared','fake','job','failed',?,'fallo-descarga')",
                                   (json.dumps({'kind': error.kind, 'details': error.details}),))
    with pytest.raises(SourceFailure) as received:
        pipeline._reserve_transfer('shared', 'job', 'other-account')
    assert received.value.kind == kind
    assert received.value.details == error.details


def test_import_is_serial_across_requests(pipeline, monkeypatch):
    import threading
    from app.domains.acquisition import services
    configure_capacity(pipeline, 2)
    rows = [submit(pipeline, body(3).model_copy(update={'provider_id': str(i)})) for i in range(2)]
    original = services.import_file
    started, release = threading.Event(), threading.Event()
    active = peak = 0
    def publish(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        started.set()
        try:
            assert release.wait(5)
            return original(*args, **kwargs)
        finally:
            active -= 1
    monkeypatch.setattr(services, 'import_file', publish)
    async def scenario():
        tasks = [asyncio.create_task(pipeline.run(row['id'])) for row in rows]
        try:
            async def fetched_all():
                while not started.is_set() or len(pipeline.engine.calls) < 6:
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(fetched_all(), 3)
            assert active == 1
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 3)
            assert peak == 1
        finally:
            release.set()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(scenario())


def test_bug_kind_controls_retry_and_does_not_penalize_source(pipeline):
    from app.domains.acquisition.models import AcquisitionError
    async def bug(*args):
        raise TypeError('bad plugin argument')
    pipeline.engine._download_audio_file = bug
    row = submit(pipeline)
    asyncio.run(pipeline.run(row['id']))
    view = pipeline.view(row['id'], ANA)
    assert view['retryable'] is False
    failed = next(item for item in view['items'] if item['stage'] == 'fetch')
    assert failed['detail']['kind'] == 'bug' and not failed['detail']['retryable']
    assert pipeline.health.status('youtube') == {'state': 'ok'}
    with pytest.raises(AcquisitionError, match='cannot-retry'):
        pipeline.retry(row['id'], ANA, schedule=False)


def test_raw_diagnostic_is_durable_without_exposing_staging_paths(pipeline):
    import json
    raw = f'Unknown source failure while writing {pipeline.incoming}'
    async def fail(*args):
        raise failure('broken', details={'raw': raw})
    pipeline.engine._download_audio_file = fail
    row = submit(pipeline)
    asyncio.run(pipeline.run(row['id']))
    view = pipeline.view(row['id'], ANA)
    assert str(pipeline.incoming) not in json.dumps(view)
    fetch = pipeline.ledger.items(view['stages']['fetch'])[0]
    assert fetch['detail']['kind'] == 'broken'
    assert fetch['detail']['_diagnostic']['raw'] == raw


def test_recovered_source_starts_a_new_failure_window(pipeline):
    now = [10000]
    pipeline.ledger.now = lambda: now[0]
    pipeline.health.failure('youtube', failure('rate-limited'))
    pipeline.health.retry('youtube')
    pipeline.health.success('youtube')
    now[0] += 1000
    pipeline.health.failure('youtube', failure('blocked'))
    health = pipeline.health.status('youtube')
    assert health['since'] == health['firstFailureAt'] == health['lastFailureAt'] == 11000
