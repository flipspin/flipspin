"""Summary row decoding follows ledger writes, while availability stays live."""
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.helpers.compute import Compute
from app.domains.helpers.mac_worker import AGENT_ONLINE_S, MIN_WORKER_VERSION, WorkerRecord
from app.infra.jobs import Jobs
from app.infra.jobs.kinds import JobKind
from app.infra.jobs.queue import Queue


@pytest.fixture
def system(tmp_path, config):
    clock = [1000.0]
    ledger = Jobs(tmp_path / 'jobs.sqlite', now=lambda: clock[0])
    queue = Queue(ledger, now=lambda: clock[0])
    worker = WorkerRecord(now=lambda: clock[0])
    compute = Compute(queue, worker, config)
    for kind in ('align', 'transcribe', 'stems', 'analysis'):
        ledger_kind = 'lyrics-helper' if kind in ('align', 'transcribe') else kind
        queue.kinds.register(JobKind(kind, (), lambda row: None, ledger_kind))
    helper = {'id': 'helper', 'name': 'Helper', 'version': MIN_WORKER_VERSION,
              'jobs': ['align', 'transcribe', 'stems', 'analysis'], 'memoryBytes': 16 << 30}
    worker.seen(helper)
    nest = {'id': 'nest', 'nest': True, 'jobs': [], 'memoryBytes': 0}
    try:
        yield SimpleNamespace(clock=clock, ledger=ledger, queue=queue, worker=worker,
                              compute=compute, helper=helper, nest=nest)
    finally:
        ledger.close()


def summary(system, kind='align'):
    return next(k for k in system.compute.summary(system.nest)['kinds']
                if k['kind'] == ('align' if kind == 'transcribe' else kind))


def test_unchanged_summary_decodes_each_row_only_once(system, monkeypatch):
    for kind in ('align', 'transcribe', 'stems', 'analysis'):
        system.queue.enqueue(kind, kind, {'item': kind})
    decode = Mock(wraps=system.queue._decode)
    rows = Mock(wraps=system.queue.rows)
    monkeypatch.setattr(system.queue, '_decode', decode)
    monkeypatch.setattr(system.queue, 'rows', rows)

    first = system.compute.summary(system.nest)
    assert first['waiting'] == 4
    assert [k['waiting'] for k in first['kinds']] == [2, 1, 1]
    assert system.compute.summary(system.nest) == first
    assert decode.call_count == 4
    assert rows.call_count == 3


@pytest.mark.parametrize('kind', ['align', 'transcribe', 'stems', 'analysis'])
def test_summary_refreshes_after_enqueue_lease_heartbeat_and_finish(system, kind):
    assert summary(system, kind)['waiting'] == 0
    row = system.queue.enqueue(kind, 'song', {'item': 'Song'})
    assert summary(system, kind)['waiting'] == 1
    claimed = system.queue.claim((kind,), 'helper')
    assert claimed is not None
    running = summary(system, kind)
    assert running['waiting'] == 0
    assert running['running'] == [{'workerId': 'helper', 'title': 'Song', 'progress': None}]

    system.clock[0] += 1
    assert system.queue.heartbeat(row['id'], claimed['lease'], 'working', 42) == {'stop': False}
    assert summary(system, kind)['running'][0]['progress'] == 42
    assert system.queue.complete(row['id'], claimed['lease'])
    assert summary(system, kind)['running'] == []
    assert summary(system, kind)['waiting'] == 0


@pytest.mark.parametrize('operation', ['heartbeat', 'phase', 'finish', 'fail', 'cancel',
                                       'hide', 'replace', 'save_payload', 'recover'])
def test_queue_row_writes_advance_version_and_refresh_summary(system, operation, monkeypatch):
    queue = system.queue
    row = queue.enqueue('align', 'song', {'item': 'Song'})
    claimed = queue.claim(('align',), 'helper')
    assert summary(system)['running']
    version = system.ledger.version
    before = queue.rows(('align',))
    system.clock[0] += 1

    if operation == 'heartbeat':
        assert queue.heartbeat(row['id'], claimed['lease']) == {'stop': False}
    elif operation == 'phase':
        assert queue.heartbeat(row['id'], claimed['lease'], 'working', 25) == {'stop': False}
    elif operation == 'finish':
        assert queue.complete(row['id'], claimed['lease'])
    elif operation == 'fail':
        assert queue.fail(row['id'], claimed['lease'], 'failed') is False
    elif operation == 'cancel':
        assert queue.cancel(row['id'])
    elif operation == 'hide':
        queue.hide(row['id'])
    elif operation == 'replace':
        assert queue.replace(row['id'], {'item': 'Replacement'})
    elif operation == 'save_payload':
        queue.save_payload({**row, 'item': 'Renamed'})
    else:
        assert queue.recover(('align',), holder='helper')

    assert system.ledger.version > version
    assert queue.rows(('align',)) != before
    decode = Mock(wraps=queue._decode)
    monkeypatch.setattr(queue, '_decode', decode)
    updated = summary(system)
    assert decode.call_count == (0 if operation in ('hide', 'cancel') else 1)
    if operation in ('replace', 'recover'):
        assert updated['waiting'] == 1
        assert updated['running'] == []
    elif operation == 'save_payload':
        assert updated['running'][0]['title'] == 'Renamed'
    elif operation == 'phase':
        assert updated['running'][0]['progress'] == 25
    elif operation != 'heartbeat':
        assert updated['running'] == []
        assert updated['failed'] == (1 if operation == 'fail' else 0)


def test_helper_going_offline_changes_summary_without_ledger_write(system, monkeypatch):
    system.queue.enqueue('align', 'song', {'item': 'Song'})
    decode = Mock(wraps=system.queue._decode)
    monkeypatch.setattr(system.queue, '_decode', decode)
    assert summary(system)['reason'] == 'helpers-busy'
    version = system.ledger.version

    system.clock[0] += AGENT_ONLINE_S + 1
    assert summary(system)['reason'] == 'helpers-offline'
    assert system.ledger.version == version
    assert decode.call_count == 1


def test_local_hours_change_summary_without_ledger_write(system, monkeypatch):
    wall_clock = [datetime(2026, 11, 9, 12)]
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: wall_clock[0])
    system.compute.settings.save_limits(system.helper, {
        'window': {'days': [0], 'startMinute': 9 * 60, 'endMinute': 17 * 60}})
    system.queue.enqueue('align', 'song', {'item': 'Song'})
    assert summary(system)['reason'] == 'helpers-busy'
    version = system.ledger.version
    wall_clock[0] = datetime(2026, 11, 9, 18)
    assert summary(system)['reason'] == 'hours'
    assert system.ledger.version == version


@pytest.mark.parametrize('change', ['paused', 'kind-paused', 'worker-paused', 'policy'])
def test_settings_remain_live_without_queue_version_change(system, change):
    settings = system.compute.settings
    system.queue.enqueue('align', 'song', {'item': 'Song'})
    assert summary(system)['reason'] == 'helpers-busy'
    version = system.ledger.version
    if change == 'paused':
        settings.pause(True)
    elif change == 'kind-paused':
        settings.save_policy('align', {'paused': True})
    elif change == 'worker-paused':
        settings.save_limits(system.helper, {'paused': True})
    else:
        settings.save_policy('align', {'placement': 'anywhere'})
    updated = summary(system)
    if change == 'policy':
        assert updated['policy']['placement'] == 'anywhere'
    else:
        assert updated['reason'] == 'paused'
    assert system.ledger.version == version


def test_mutable_queue_rows_and_summary_results_do_not_share_cached_dicts(system):
    queue = system.queue
    row = queue.enqueue('align', 'song', {'item': 'Song', 'needs': []})
    queue.claim(('align',), 'helper')
    first = summary(system)
    first['running'][0]['title'] = 'Changed response'
    external = queue.rows(('align',))
    external[0]['item'] = 'Changed row'
    external[0]['needs'].append('unavailable')
    external[0]['status'] = 'failed'
    assert queue.get(row['id'])['item'] == 'Song'
    assert queue.rows(('align',))[0]['needs'] == []
    assert summary(system)['running'][0]['title'] == 'Song'
    assert summary(system)['failed'] == 0


def test_saving_unchanged_payload_keeps_summary_cache_valid(system, monkeypatch):
    payload = {'id': 'song', 'item': 'Song'}
    system.queue.enqueue('align', 'song', payload)
    decode = Mock(wraps=system.queue._decode)
    monkeypatch.setattr(system.queue, '_decode', decode)
    first = summary(system)
    version = system.ledger.version
    system.queue.save_payload(payload)
    assert system.ledger.version == version
    assert summary(system) == first
    assert decode.call_count == 1


def test_too_old_helper_is_visible_until_revoked(system):
    system.worker.seen(system.helper | {'version': '0.9.9'})
    row = next(h for h in system.compute.summary(system.nest)['computers'] if h['id'] == 'helper')
    assert row['versionState'] == 'too-old'
    system.worker.revoke('helper')
    assert [h['id'] for h in system.compute.summary(system.nest)['computers']] == ['nest']
