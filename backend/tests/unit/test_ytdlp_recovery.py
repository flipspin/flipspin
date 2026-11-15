"""Update recovery selects durable broken outcomes and reuses normal acquisition."""
import asyncio
import json

import pytest

from tests.source_plugin_support import failure
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, body, legacy_submit as submit

pipeline = fixtures.pipeline


def failed_request(pipeline, kinds, *, at=100):
    pipeline.ledger.now = lambda: at
    request = submit(pipeline, body(len(kinds)))
    requests = pipeline._requests(pipeline.store.work(request['id'])['body'])
    job = pipeline._stage(request['id'], 'fetch', requests, ANA, share=False)
    for index, text in enumerate(kinds):
        pipeline._done(job, index, error=failure(text), reason='fallo-descarga')
    pipeline.ledger.finish(job, 1)
    pipeline.store.state(request['id'], 'fetching')
    pipeline.store.state(request['id'], 'fallido')
    return request['id'], job


def test_only_broken_songs_reenter_normal_fetch_and_keep_other_outcomes(pipeline):
    id, old_job = failed_request(pipeline, ['broken', 'rate-limited', 'network', 'auth-required'])
    ids, complete = pipeline.retry_broken(0, 200, '2026.10.01')
    assert ids == [id]
    assert not complete  # The queued retry is durable work still in flight.
    assert pipeline.store.get(id, ANA.user_id)['state'] == 'approved'
    assert pipeline.ledger.items(old_job)[0]['detail']['sourceRetry'] == '2026.10.01'
    assert 'sourceRetry' not in pipeline.ledger.items(old_job)[1]['detail']
    asyncio.run(pipeline.run(id))
    assert len(pipeline.engine.calls) == 1
    view = pipeline.view(id, ANA)
    assert len(set(view['stages'].values())) == 5
    items = view['items']
    fetch = [item for item in items if item['stage'] == 'fetch']
    assert fetch[0]['state'] == 'done'
    assert fetch[0]['detail']['sourceRetry'] == '2026.10.01'
    assert [item['detail'].get('kind') for item in fetch[1:]] == ['rate-limited', 'network', 'auth-required']
    assert pipeline.retry_broken(0, 300, '2026.11.01') == ([], True)
    assert len(pipeline.engine.calls) == 1




@pytest.mark.parametrize('since,until', [(100, 200), (0, 99)])
def test_failures_outside_update_window_are_untouched(pipeline, since, until):
    id, _ = failed_request(pipeline, ['broken'])
    assert pipeline.retry_broken(since, until, '2026.10.01') == ([], True)
    assert pipeline.store.get(id, ANA.user_id)['state'] == 'fallido'


def test_last_failure_kind_controls_selection(pipeline):
    id, _ = failed_request(pipeline, ['broken'])
    pipeline.retry(id, ANA, schedule=False)

    async def offline(*args):
        raise OSError('offline')

    pipeline.engine._download_audio_file = offline
    asyncio.run(pipeline.run(id))
    assert pipeline.retry_broken(0, 200, '2026.10.01') == ([], True)


def test_window_waits_for_inflight_failure_then_recovers_it(pipeline):
    pipeline.ledger.now = lambda: 100
    request = submit(pipeline)
    assert pipeline.retry_broken(0, 200, '2026.10.01') == ([], False)
    work = pipeline.store.work(request['id'])
    job = pipeline._stage(request['id'], 'fetch', pipeline._requests(work['body']), ANA, share=False)
    error = failure('broken')
    error.failed_at = 150  # The triggering failure predates the swap.
    pipeline.ledger.now = lambda: 250
    pipeline._done(job, 0, error=error, reason='fallo-descarga')
    pipeline.ledger.finish(job, 1)
    pipeline.store.state(request['id'], 'fetching')
    pipeline.store.state(request['id'], 'fallido')
    assert pipeline.retry_broken(0, 200, '2026.10.01')[0] == [request['id']]


def test_disabled_source_defers_retry_without_marking_it_consumed(pipeline):
    id, job = failed_request(pipeline, ['broken'])
    pipeline.sources = lambda: []
    assert pipeline.retry_broken(0, 200, '2026.10.01') == ([], False)
    assert 'sourceRetry' not in pipeline.ledger.items(job)[0]['detail']
    pipeline.sources = lambda: ['youtube']
    assert pipeline.retry_broken(0, 200, '2026.10.01')[0] == [id]


def test_committed_retry_can_be_woken_again_after_a_crash(pipeline):
    id, _ = failed_request(pipeline, ['broken'])
    assert pipeline.retry_broken(0, 200, '2026.10.01')[0] == [id]
    assert pipeline.retry_broken(0, 200, '2026.10.01')[0] == [id]
    marks = pipeline.store.work(id)['body']['_source_retried']
    assert marks == {'0': '2026.10.01'}


def test_manual_item_retry_does_not_make_an_old_held_failure_recent(pipeline):
    from app.domains.acquisition.models import RetrySelection

    id, _ = failed_request(pipeline, ['broken', 'network'])
    pipeline.ledger.now = lambda: 250
    pipeline.retry(id, ANA, selection=RetrySelection(index=1), schedule=False)
    asyncio.run(pipeline.run(id))
    assert pipeline.store.get(id, ANA.user_id)['state'] == 'parcial'
    assert pipeline.retry_broken(200, 300, '2026.10.01') == ([], True)
    failures = [item for item in pipeline.view(id, ANA)['items'] if item['state'] == 'failed']
    assert all(item['detail']['failedAt'] == 100 for item in failures)


def test_revision_retry_is_scoped_to_source_and_typed_kinds(pipeline):
    from tests.unit.test_source_plugin import CASES
    case = CASES['revision-change']
    id, job = failed_request(pipeline, ['broken', 'blocked', 'blocked', 'network', 'auth-required'])
    with pipeline.ledger.db:
        item = pipeline.ledger.items(job)[1]
        detail = {**item['detail'], 'provider': 'other'}
        pipeline.ledger.db.execute('UPDATE items SET detail=? WHERE job_id=? AND idx=? AND attempt=?',
                                  (json.dumps(detail), job, item['idx'], item['attempt']))
    assert case['sameSourceOnly'] and set(case['retryKinds']) == {'broken', 'blocked'}
    pipeline.sources = lambda: ['other']
    assert pipeline.retry_broken(0, 200, 'revision-two', source_id='youtube') == ([], False)
    pipeline.sources = lambda: ['youtube', 'other']
    assert pipeline.retry_broken(0, 200, 'revision-two', source_id='youtube')[0] == [id]
    assert pipeline.store.work(id)['body']['_source_retried'] == {'0': 'revision-two', '2': 'revision-two'}
