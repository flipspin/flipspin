import json
from datetime import datetime
from pathlib import Path

import pytest

from app.infra.jobs.compute import ComputeSettings
from app.infra.jobs.placement import decide

CONTRACT = json.loads((Path(__file__).parents[3] / 'contracts/compute-placement.json').read_text())


@pytest.mark.parametrize('case', CONTRACT['cases'], ids=lambda c: c['name'])
def test_shared_compute_contract(case):
    policy = {**ComputeSettings.default_policy('analysis'), **case['policy']}
    limits = {**ComputeSettings.default_limits(), **case['limits']}
    assert decide(policy, limits, case['worker'], case['row'], datetime.fromisoformat(CONTRACT['clock']),
                  paused_all=case['pausedAll']) == case['reason']


@pytest.mark.parametrize('start,end', [(0, 0), (5, 5), (1, 7), (22, 6)])
def test_nest_window_defaults_and_environment_pins(config, tmp_path, monkeypatch, start, end):
    from app.infra import env_sources
    from app.infra.jobs import Jobs

    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset())
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    try:
        settings = ComputeSettings(ledger, config)
        assert ComputeSettings.default_limits(True)['window'] is None
        assert settings.limits({'nest': True})['window'] is None
        expected = None
        assert ComputeSettings.default_limits(True, config)['window'] == expected
        monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset({'KROBI_NEST_LIBRARY_START_HOUR', 'KROBI_NEST_LIBRARY_END_HOUR'}))
        assert settings.limits({'nest': True})['window'] == expected
        # Old persisted schedules and old clients' schedule writes are inert.
        monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset())
        saved = {'days': list(range(7)), 'startMinute': start * 60, 'endMinute': end * 60}
        with ledger.lock, ledger.db:
            settings._write('worker_limits', 'worker_id', 'nest', {**settings.default_limits(True), 'window': saved})
        assert settings.limits({'nest': True})['window'] is None
        assert settings.save_limits({'nest': True}, {'window': saved})['window'] is None
        assert settings.save_limits({'id': 'helper'}, {'window': saved})['window'] == saved
        reopened = ComputeSettings(ledger, config)
        assert reopened.limits({'nest': True})['window'] == expected
    finally:
        ledger.close()


def test_migration_uses_legacy_values_once_and_respects_memory(tmp_path):
    from types import SimpleNamespace
    from app.infra.jobs import Jobs
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    config = SimpleNamespace(nest_processes=True, lyrics_engine_mode='local', stems_background=True)
    settings = ComputeSettings(ledger, config, nest_memory_bytes=4 << 30)
    assert settings.policy('align')['placement'] == settings.policy('stems')['placement'] == 'helpers'
    assert settings.policy('analysis')['placement'] == 'helpers-then-nest'
    assert settings.policy('stems')['libraryPass'] == 'auto'
    settings.save_policy('analysis', {'placement': 'anywhere'})
    config.nest_processes = False
    config.stems_background = False
    reopened = ComputeSettings(ledger, config, nest_memory_bytes=16 << 30)
    assert reopened.policy('analysis')['placement'] == 'anywhere'
    assert reopened.policy('stems')['libraryPass'] == 'auto'
    assert config.lyrics_engine_mode == 'agent'
    ledger.close()


def test_claim_time_placement_uses_existing_ranking_and_memory(tmp_path):
    from types import SimpleNamespace
    from app.infra.jobs import Jobs
    from app.infra.jobs.queue import Queue
    from app.infra.jobs.kinds import JobKind
    from app.domains.helpers.mac_worker import WorkerRecord
    from app.domains.helpers.compute import Compute
    from app.domains.helpers.helper_ranking import default_needs

    clock = [1000.0]
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    queue = Queue.for_ledger(ledger, now=lambda: clock[0])
    worker = WorkerRecord(now=lambda: clock[0])
    compute = Compute(queue, worker, SimpleNamespace(nest_processes=False, lyrics_engine_mode='agent', stems_background=False))
    needs = tuple(default_needs('stems'))
    queue.kinds.register(JobKind('stems', needs, lambda *a: None, 'stems', can_claim=worker.can_claim))
    worker.register_needs('stems', needs)
    agent = {'id': 'nest-worker', 'name': 'Nest', 'version': '0.14.1', 'jobs': ['stems'], 'os': 'linux', 'accel': 'cpu', 'memoryBytes': 16 << 30}
    worker.register_nest(agent)
    compute.settings.save_limits({'nest': True}, {'window': None})
    row = queue.enqueue('stems', 'song', {'kind': 'stems', 'needs': list(needs), 'lane': 'now'})
    assert queue.claim(('stems',), 'nest-worker') is None
    compute.settings.save_policy('stems', {'placement': 'anywhere'})
    assert queue.claim(('stems',), 'nest-worker')
    queue.defer_holder('nest-worker')
    compute.settings.save_policy('stems', {'placement': 'helpers-then-nest'})
    helper = {**agent, 'id': 'helper', 'name': 'Helper'}
    worker.seen(helper)
    clock[0] += 601
    worker.register_nest(agent)
    assert queue.claim(('stems',), 'nest-worker') is None
    worker.bye('helper', 'sleep')
    clock[0] += 601
    worker.register_nest(agent)
    assert queue.claim(('stems',), 'nest-worker')
    queue.defer_holder('nest-worker')
    worker.register_nest({**agent, 'memoryBytes': 4 << 30})
    assert compute.reason(row, 'nest-worker') == 'memory'
    assert queue.claim(('stems',), 'nest-worker') is None
    ledger.close()
