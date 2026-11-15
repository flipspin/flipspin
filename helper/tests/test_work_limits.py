from datetime import datetime
from types import SimpleNamespace
import threading

from krobi_helper import work_limits as limits
from krobi_helper.agent import Agent, Heartbeat


def test_windows_and_charging_have_distinct_local_reasons():
    window = {'days': [0], 'startMinute': 22 * 60, 'endMinute': 6 * 60}
    assert limits.paused_reason({'window': window}, False, datetime(2026, 11, 10, 2)) is None
    assert limits.paused_reason({'window': window}, False, datetime(2026, 11, 10, 7)) == 'hours'
    assert limits.paused_reason({'onlyCharging': True}, True) == 'battery'
    assert limits.paused_reason({'onlyCharging': True}, None) == 'battery'
    assert limits.paused_reason({'pace': 'off'}, False) == 'off'
    assert limits.paused_reason({'paused': True}, False) == 'paused'


def test_gentle_child_reduces_threads_and_priority_without_changing_parent():
    argv, options = limits.launch_options(['engine', 'analysis'], {'pace': 'gentle'})
    assert options['env']['OMP_NUM_THREADS'] == options['env']['OPENBLAS_NUM_THREADS'] == '1'
    assert options['env']['KROBI_HELPER_GENTLE'] == '1'
    if limits.os.name != 'nt':
        assert argv == ['nice', '-n', '10', 'engine', 'analysis']
    assert limits.launch_options(['engine'], {'pace': 'fast'})[0] == ['engine']


def test_power_probe_distinguishes_laptops_and_unknown(monkeypatch):
    monkeypatch.setattr(limits.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(limits.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=0, stdout="Now drawing from 'Battery Power'\nInternalBattery"))
    assert limits.on_battery() is True
    monkeypatch.setattr(limits.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=0, stdout="Now drawing from 'AC Power'\nInternalBattery"))
    assert limits.on_battery() is False
    monkeypatch.setattr(limits.subprocess, 'run', lambda *a, **k: SimpleNamespace(returncode=0, stdout="Now drawing from 'AC Power'"))
    assert limits.on_battery() is None


def test_limits_are_applied_before_claim_and_use_is_reversible(tmp_path, monkeypatch):
    from krobi_helper import agent as module
    monkeypatch.setattr(module, 'on_battery', lambda: False)
    worker = Agent('http://nest', 'token', work_dir=tmp_path)
    worker.facts = {'jobs': ['align', 'analysis']}
    requests = []
    def request(method, path, body=None, **kw):
        requests.append((method, path, body))
        if path.endswith('/limits'):
            return {'pace': 'gentle', 'use': {'align': False}}
        return None
    monkeypatch.setattr(worker, '_request', request)
    assert worker._claim() is None
    assert requests[0][1] == '/api/helpers/limits'
    assert requests[1][2]['kinds'] == ['analysis']
    assert worker.work_limits['pace'] == 'gentle'
    worker.work_limits = {}
    assert worker.identity()['jobs'] == ['align', 'analysis']


def test_charging_change_stops_child_even_without_model_output(tmp_path, monkeypatch):
    from krobi_helper import agent as module
    monkeypatch.setattr(module, 'on_battery', lambda: True)
    worker = Agent('http://nest', 'token', work_dir=tmp_path)
    worker.work_limits = {'onlyCharging': True}
    worker._stopping = threading.Event()
    monkeypatch.setattr(worker, '_heartbeat_request', lambda *a: {'stop': False})
    beat = Heartbeat(worker, '/api/helpers/jobs/job/heartbeat', lambda *a: {}, name='test')
    beat.beat()
    assert beat.stop_requested.is_set()
