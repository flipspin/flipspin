"""Background work controls fence the real helper queue and owner boundary."""
# ruff: noqa: F811
from datetime import datetime

import pytest

from app.infra.jobs.compute import ComputeSettings
from app.infra.jobs.placement import decide, inside_window
from tests.integration.test_analysis import house, CLAIM  # noqa: F401


def test_summary_is_owner_only_and_helper_reads_only_own_limits(house):
    h = house
    assert h.member.get('/api/compute/summary').status_code == 403
    assert h.helper.get('/api/compute/summary').status_code == 403
    assert h.admin.get('/api/helpers/limits').status_code == 403
    response = h.admin.get('/api/compute/summary')
    assert response.status_code == 200, response.text
    body = response.json()
    assert [k['kind'] for k in body['kinds']] == ['align', 'stems', 'analysis']
    assert body['kinds'][0]['policy']['placement'] == 'helpers'
    assert body['kinds'][2]['policy']['placement'] == 'anywhere'
    assert body['computers'][0]['nest']
    assert body['computers'][0]['limits']['window'] is None
    assert h.helper.get('/api/helpers/limits').json()['pace'] == 'fast'


def test_default_nest_can_claim_library_lane_at_noon(house, monkeypatch):
    from app.domains.helpers.nest_helper import NEST_ID

    h = house
    noon = datetime(2026, 11, 10, 12)
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: noon)
    assert h.container.get_compute().settings.limits({'nest': True})['window'] is None
    h.service.enqueue_files([h.path], lane='library', nest=True)
    nest = {'id': NEST_ID, 'name': 'Nest', 'version': CLAIM['version'], 'jobs': ['analysis'],
            **CLAIM['capabilities']}
    h.service.worker.register_nest(nest)
    got = h.service.claim(nest)
    assert got and got['job']['input']['items'][0]['relPath'] == 'Album/song.mp3'
    row = h.service.queue.get(got['job']['id'])
    assert row['lane'] == 'library' and row['leased_by'] == NEST_ID


def enroll(h):
    response = h.helper.post('/api/helpers/claim', json=CLAIM)
    assert response.status_code == 204
    return next(c for c in h.admin.get('/api/compute/summary').json()['computers'] if not c['nest'])


@pytest.mark.parametrize('control', ['kind', 'computer', 'all', 'off', 'hours', 'use'])
def test_controls_prevent_claims_and_resume_without_losing_work(house, control):
    h = house
    computer = enroll(h)
    limits = computer['limits']
    url = '/api/compute/computers/' + computer['id']
    if control == 'kind':
        assert h.admin.put('/api/compute/kinds/analysis', json={'paused': True}).status_code == 200
    elif control == 'all':
        assert h.admin.put('/api/compute/pause', json={'paused': True}).status_code == 200
    else:
        values = {'computer': {'paused': True}, 'off': {'pace': 'off'},
                  'hours': {'window': {'days': [(datetime.now().weekday()+1) % 7], 'startMinute': 0, 'endMinute': 0}},
                  'use': {'use': {'analysis': False}}}[control]
        assert h.admin.put(url, json={**limits, **values}).status_code == 200
    h.service.scan()
    waiting = h.admin.get('/api/compute/summary').json()
    assert waiting['waiting'] == 1
    assert waiting['kinds'][2]['oldestAt'] is not None
    assert h.helper.post('/api/helpers/claim', json=CLAIM).status_code == 204
    assert h.admin.put('/api/compute/kinds/analysis', json={'paused': False}).status_code == 200
    assert h.admin.put('/api/compute/pause', json={'paused': False}).status_code == 200
    assert h.admin.put(url, json=limits).status_code == 200
    assert h.helper.post('/api/helpers/claim', json=CLAIM).status_code == 200


def test_pause_fences_active_result_and_preserves_attempt_budget(house):
    h = house
    h.service.scan()
    claim = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    row = h.service.queue.get(claim['job']['id'])
    assert row['attempts'] == 1
    h.admin.put('/api/compute/pause', json={'paused': True})
    assert h.service.queue.get(row['id'])['attempts'] == 0
    url = '/api/helpers/jobs/' + row['id']
    assert h.helper.post(url + '/heartbeat', json={'lease': claim['lease']}).json()['stop']
    assert not h.helper.post(url + '/result', json={'lease': claim['lease'], 'items': []}).json()['accepted']
    h.admin.put('/api/compute/pause', json={'paused': False})
    assert h.helper.post('/api/helpers/claim', json=CLAIM).status_code == 200


def test_memory_gate_and_kind_migration_are_durable(house, monkeypatch):
    h = house
    nest = h.container.get_nest_helper()
    monkeypatch.setattr(nest, 'view', lambda: {'memoryBytes': 4 << 30})
    for kind in ('align', 'stems'):
        for placement in ('anywhere', 'helpers-then-nest'):
            response = h.admin.put('/api/compute/kinds/' + kind, json={'placement': placement})
            assert response.status_code == 409
            assert response.json()['detail']['code'] == 'memory'
    compute = h.container.get_compute()
    compute.settings.save_policy('analysis', {'placement': 'helpers'})
    h.container.config.nest_processes = True
    reopened = ComputeSettings(h.container.get_jobs(), h.container.config)
    assert reopened.policy('analysis')['placement'] == 'helpers'


def test_charging_is_offered_only_when_readable_and_enforced(house):
    h = house
    computer = enroll(h)
    url = '/api/compute/computers/' + computer['id']
    assert h.admin.put(url, json={**computer['limits'], 'onlyCharging': True}).status_code == 409
    battery = {**CLAIM, 'capabilities': {**CLAIM['capabilities'], 'onBattery': True, 'powerReadable': True}}
    h.helper.post('/api/helpers/claim', json=battery)
    assert h.admin.put(url, json={**computer['limits'], 'onlyCharging': True}).status_code == 200
    h.service.scan()
    assert h.helper.post('/api/helpers/claim', json=battery).status_code == 204
    charging = {**battery, 'capabilities': {**battery['capabilities'], 'onBattery': False}}
    assert h.helper.post('/api/helpers/claim', json=charging).status_code == 200


def test_helper_overnight_window_uses_start_day_and_nest_has_no_schedule():
    window = {'days': [0], 'startMinute': 22*60, 'endMinute': 6*60}
    assert inside_window(window, datetime(2026, 11, 10, 2))
    assert not inside_window(window, datetime(2026, 11, 10, 7))
    policy = ComputeSettings.default_policy('analysis')
    limits = {**ComputeSettings.default_limits(), 'window': window}
    worker = {'nest': True, 'memoryBytes': 4 << 30}
    assert decide(policy, limits, worker, {'lane': 'new'}, datetime(2026, 11, 10, 12)) is None
    assert decide(policy, limits, worker, {'lane': 'library'}, datetime(2026, 11, 10, 12)) is None
    assert decide(policy, limits, {}, {'lane': 'library'}, datetime(2026, 11, 10, 12)) == 'hours'


def test_existing_nest_environment_pins_remain_authoritative(house, monkeypatch):
    from app.infra import env_sources
    h = house
    compute = h.container.get_compute()
    h.container.config.nest_cpu_percent = 25
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset({'KROBI_NEST_CPU_PERCENT'}))
    limits = compute.settings.limits({'nest': True})
    assert limits['cpuPercent'] == 25
    response = h.admin.put('/api/compute/computers/nest', json={**limits, 'cpuPercent': 100})
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'env-locked'
    assert h.admin.put('/api/compute/computers/nest', json={**limits, 'pace': 'off'}).status_code == 200
    assert h.container.config.nest_cpu_percent == 25
