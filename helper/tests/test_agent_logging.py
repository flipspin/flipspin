"""Diagnostics stay readable without changing protocol output or retry timing."""
import errno
import io
import json
import re
import sys
import threading
import urllib.error
from datetime import datetime

import pytest
from krobi_helper import agent as A
from krobi_helper import protocol as P

STAMP = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d ")


@pytest.fixture
def worker(tmp_path, monkeypatch):
    monkeypatch.setattr(A.Agent, '_watch_parent', lambda self: None)
    return A.Agent('http://server.example', 'token', 'test-device', work_dir=tmp_path)


def messages(capsys):
    captured = capsys.readouterr()
    assert captured.out == ''
    lines = captured.err.splitlines()
    assert all(STAMP.match(line) for line in lines)
    return [STAMP.sub('', line) for line in lines]


def test_timestamp_local_offset_multiline_and_protocol_stdout(worker, capsys, monkeypatch):
    protocol_out = io.StringIO()
    monkeypatch.setattr(P, "_PROTOCOL_OUT", protocol_out)
    worker.log('first\nsecond')
    A.log_stderr('lock diagnostic')
    P.emit('phase', phase='test', percent=10)
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(protocol_out.getvalue()) == {'event': 'phase', 'phase': 'test', 'percent': 10}
    lines = captured.err.splitlines()
    assert [STAMP.sub('', line) for line in lines] == ['first', 'second', 'lock diagnostic']
    for line in lines:
        assert STAMP.match(line)
        assert datetime.fromisoformat(line.split(' ', 1)[0]).utcoffset() == datetime.now().astimezone().utcoffset()


def test_connected_once_per_start_wake_and_reconnect(worker, monkeypatch, capsys):
    monkeypatch.setattr(worker, '_urlopen', lambda *a, **k: io.BytesIO(b''))
    worker._request('GET', '/api/helpers/limits')
    assert messages(capsys) == []
    for path in ['/api/helpers/claim', '/api/helpers/claim', '/api/helpers/jobs/job/heartbeat']:
        worker._request('POST', path)
    assert messages(capsys) == ['connected to http://server.example as test-device']
    monkeypatch.setattr(worker, 'bye', lambda *a: None)
    worker.sleeping()
    worker._request('POST', '/api/helpers/claim')
    worker._request('POST', '/api/helpers/claim')
    assert messages(capsys) == ['connected to http://server.example as test-device']

    def denied(*a, **k):
        raise urllib.error.URLError(ConnectionRefusedError(errno.ECONNREFUSED, 'Connection refused'))

    monkeypatch.setattr(worker, '_urlopen', denied)
    with pytest.raises(urllib.error.URLError):
        worker._request('POST', '/api/helpers/jobs/job/heartbeat')
    assert messages(capsys) == ['waiting for network…']
    monkeypatch.setattr(worker, '_urlopen', lambda *a, **k: io.BytesIO(b''))
    worker._request('GET', '/api/helpers/limits')
    assert messages(capsys) == []
    worker._request('POST', '/api/helpers/jobs/job/heartbeat')
    worker._request('POST', '/api/helpers/claim')
    assert messages(capsys) == ['connected to http://server.example as test-device']


@pytest.mark.parametrize('error', [
    urllib.error.URLError(OSError(errno.EHOSTUNREACH, 'No route to host')),
    urllib.error.URLError('nest-unreachable'),
    ConnectionRefusedError(errno.ECONNREFUSED, 'Connection refused'),
])
def test_first_minute_waits_once_then_reports_at_backoff(worker, monkeypatch, capsys, error):
    now = [0.0]
    monkeypatch.setattr(A.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(A.time, 'time', lambda: now[0])
    worker._network_since = worker._clock_offset = 0
    attempts, waits = [], []

    def urlopen(request, **kwargs):
        if request.full_url.endswith('/claim'):
            attempts.append(now[0])
            if len(attempts) == 6:
                worker._stopping.set()
                return io.BytesIO(b'')
        raise error  # limits and claim must not each produce a diagnostic

    def wait(delay):
        waits.append(delay)
        now[0] += delay

    monkeypatch.setattr(worker, '_urlopen', urlopen)
    monkeypatch.setattr(worker._stopping, 'wait', wait)
    assert worker.run() == 0
    logs = messages(capsys)
    assert attempts == [0, 8, 24, 56, 116, 176]
    assert waits == [8, 16, 32, 60, 60]
    assert logs.count('waiting for network…') == 1
    failures = [line for line in logs if 'claim failed' in line]
    assert len(failures) == 1
    assert 'retrying in 60s' in failures[0]
    assert logs[-2:] == ['connected to http://server.example as test-device', 'agent stopping']


def test_wake_restarts_grace_after_long_sleep(worker, monkeypatch, capsys):
    now = [1000.0]
    monkeypatch.setattr(A.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(A.time, 'time', lambda: now[0])
    monkeypatch.setattr(worker, 'bye', lambda *a: None)
    worker._network_since = 0
    worker.sleeping()
    now[0] += 3600
    worker._network_activity()
    error = urllib.error.URLError('nest-unreachable')
    worker._claim_failure(error, 8)
    now[0] += 59
    worker._claim_failure(error, 16)
    assert messages(capsys) == ['waiting for network…']
    now[0] += 1
    worker._claim_failure(error, 32)
    assert 'claim failed' in messages(capsys)[0]


def test_identical_failures_collapse_and_flush_on_change_recovery(worker, monkeypatch, capsys):
    worker._network_since = A.time.monotonic() - 60
    error = urllib.error.URLError('unavailable')
    for backoff in [8, 16, 32, 60, 60, 60, 60, 60]:
        worker._claim_failure(error, backoff)
    logs = messages(capsys)
    assert len(logs) == 2
    assert 'repeated 5×' in logs[1]
    worker._claim_failure(ValueError('bad JSON'), 60)
    logs = messages(capsys)
    assert 'repeated 2×' in logs[0]
    assert 'bad JSON' in logs[1]
    worker._claim_failure(ValueError('bad JSON'), 60)
    monkeypatch.setattr(worker, '_urlopen', lambda *a, **k: io.BytesIO(b''))
    worker._request('POST', '/api/helpers/claim')
    logs = messages(capsys)
    assert 'repeated 1×' in logs[0]
    assert logs[1] == 'connected to http://server.example as test-device'


def test_http_errors_are_not_a_network_wait(worker, capsys):
    worker._claim_failure(urllib.error.HTTPError('http://server.example', 401, 'Unauthorized', {}, None), 8)
    logs = messages(capsys)
    assert len(logs) == 1 and 'claim failed [token-rejected]' in logs[0]


@pytest.mark.parametrize('batch', [False, True])
def test_child_stderr_is_timestamped_and_stdout_stays_protocol(worker, monkeypatch, capsys, batch):
    monkeypatch.setattr(worker, '_acquire_keep_awake', lambda pid: None)
    code = "import sys; sys.stderr.write('diagnostic\\n' * 2000); print('{\"event\":\"done\",\"job\":\"j1\"}')"
    args = [sys.executable, '-c', code]
    if batch:
        outcome = worker._run_process_many(args, lambda *a: None, threading.Event())['j1']
    else:
        outcome = worker._run_process(args, lambda *a: None, threading.Event())
    assert outcome == {'event': 'done', 'job': 'j1'}
    assert messages(capsys) == ['diagnostic'] * 2000
