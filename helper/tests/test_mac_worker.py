"""Runtime contract without importing a model: real HTTP/process tests elsewhere."""
import errno
import signal
import socket
import subprocess
import sys
import threading
import urllib.error
from unittest.mock import Mock

import pytest
from krobi_helper import agent as A
from krobi_helper import mac_facts as F


def test_stable_uuid_and_device_override(monkeypatch):
    first = F.stable_id()
    assert F.stable_id() == first
    monkeypatch.setenv('KROBI_WORKER_ID', 'device-id')
    assert F.stable_id() == 'device-id'
    monkeypatch.delenv('KROBI_WORKER_ID')
    assert F.stable_id() == first


def test_computer_name_and_hardware(monkeypatch):
    outputs = {('scutil', '--get', 'ComputerName'): 'Mac de Ana',
               ('sysctl', '-n', 'machdep.cpu.brand_string'): 'Apple M1 Pro',
               ('sysctl', '-n', 'hw.memsize'): '17179869184', ('sw_vers', '-productVersion'): '26.1'}
    def probe(args, **kw):
        assert kw['timeout'] == 2
        return outputs[args]
    monkeypatch.setattr(F.subprocess, 'check_output', probe)
    assert F.computer_name() == 'Mac de Ana'
    assert F.hardware() == {'chip': 'Apple M1 Pro', 'memoryBytes': 17179869184, 'macos': '26.1'}
    monkeypatch.setattr(F.subprocess, 'check_output', Mock(side_effect=OSError()))
    monkeypatch.setattr(F.socket, 'gethostname', lambda: 'fallback-host')
    assert F.computer_name() == 'fallback-host'
    assert F.hardware() == dict.fromkeys(('chip', 'memoryBytes', 'macos'))


@pytest.mark.parametrize('code', [401, 403])
def test_token_error(code):
    assert F.last_error(urllib.error.HTTPError('http://nest', code, 'no', {}, None), 'http://nest') == 'token-rejected'


@pytest.mark.parametrize('error', [OSError(errno.EHOSTUNREACH, 'unreachable'), urllib.error.URLError('No route to host')])
def test_lan_network_permission_error(monkeypatch, error):
    monkeypatch.setattr(F.socket, 'getaddrinfo', lambda *a, **kw: [(socket.AF_INET, 1, 6, '', ('192.168.1.20', 0))])
    assert F.last_error(error, 'http://nest.local:8000') == 'network-denied'


def test_other_network_errors(monkeypatch):
    monkeypatch.setattr(F.socket, 'getaddrinfo', lambda *a, **kw: [(socket.AF_INET, 1, 6, '', ('8.8.8.8', 0))])
    assert F.last_error(OSError(errno.EHOSTUNREACH, 'No route to host'), 'http://8.8.8.8') == 'nest-unreachable'
    assert F.last_error(TimeoutError('timeout'), 'http://192.168.1.1') == 'nest-unreachable'


def test_bye_is_bounded_and_sigterm_sends_quit(tmp_path):
    agent = A.Agent('http://localhost:9', 't', work_dir=tmp_path)
    calls = []
    def request(method, path, body, timeout):
        calls.append((method, path, body, timeout))
        raise TimeoutError('unreachable')
    agent._request = request
    agent.bye()
    assert calls[-1] == ('POST', '/api/helpers/bye', {'sessionId': agent.session_id, 'reason': 'sleep'}, 2)
    agent.stop(signal.SIGTERM, None)
    agent._goodbye.join(1)
    assert calls[-1][2]['reason'] == 'quit'
    assert agent._stopping.is_set()


@pytest.mark.parametrize('path', ['/api/lyrics/agent/heartbeat', '/api/stems/agent/heartbeat'])
def test_heartbeat_facts_and_replaced_stop_the_agent(tmp_path, path):
    logs = []
    agent = A.Agent('http://localhost:9', 't', work_dir=tmp_path, log=logs.append)
    def request(method, endpoint, body, **kw):
        assert body['agent']['id'] == agent.id
        assert body['agent']['state'] == 'working'
        assert all(k in body['agent'] for k in ('name', 'chip', 'memoryBytes', 'os', 'version', 'lastError'))
        # "macos" (the version) only comes from a Mac; the CI runner is Linux.
        assert ('macos' in body['agent']) == (sys.platform == 'darwin')
        return {'stop': True, 'reason': 'replaced'}
    agent._request = request
    heartbeat = A.Heartbeat(agent, path, lambda *_: {}, name='test')
    with pytest.raises(A.StopRequested):
        heartbeat.report('alineando', 10)
    assert agent._stopping.is_set() and agent._replaced
    assert any('agent replaced:' in line for line in logs)
    assert not hasattr(agent, '_goodbye'), 'old Mac must not close the replacement'


def test_replaced_claim_has_distinct_exit_code(tmp_path):
    agent = A.Agent('http://localhost:9', 't', work_dir=tmp_path)
    agent._request = lambda *a, **kw: {'stop': True, 'reason': 'replaced'}
    assert agent.run(once=True) == A.REPLACED_EXIT_CODE


def test_caffeinate_watches_job_pid_and_ends_after_job(tmp_path, monkeypatch):
    agent = A.Agent('http://localhost:9', 't', work_dir=tmp_path)
    real_popen = subprocess.Popen
    assertions = []
    def popen(argv, **kw):
        if argv[0] == 'caffeinate':
            assert argv[1:3] == ['-i', '-w']
            assert int(argv[3]) > 0
            assertion = Mock()
            assertions.append(assertion)
            return assertion
        return real_popen(argv, **kw)
    monkeypatch.setattr(A.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(A.subprocess, 'Popen', popen)
    assert agent._run_process([sys.executable, '-c', 'print(\'{"event":"done"}\')'], lambda *_: None, threading.Event())['event'] == 'done'
    assert len(assertions) == 1
    assertions[0].wait.assert_called_once_with(timeout=2)


def test_local_status_is_private_atomic_and_never_contains_token(tmp_path, monkeypatch):
    import json
    import stat
    status = tmp_path / 'status.json'
    monkeypatch.setenv('KROBI_AGENT_STATUS_PATH', str(status))
    agent = A.Agent('http://localhost:9', 'secret-must-not-leave-worker', work_dir=tmp_path)
    agent.last_error = 'token-rejected'
    agent._publish_status()
    assert json.loads(status.read_text())['lastError'] == 'token-rejected'
    assert stat.S_IMODE(status.stat().st_mode) == 0o600
    assert 'secret-must-not-leave-worker' not in status.read_text()
    agent.last_error = None
    agent._publish_status(state='working', connected=True)
    assert json.loads(status.read_text()) == dict(id=agent.id, state='working', connected=True, lastError=None)
    agent._control(dict(stop=True, reason='replaced'))
    assert json.loads(status.read_text())['lastError'] == 'replaced'


def test_sleep_signal_sends_bye_and_agent_continues_on_wake(tmp_path, monkeypatch):
    """Real process + signal + HTTP; no models or sleep of the actual host."""
    import http.server
    import json
    import os
    import time
    calls = []
    class Nest(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            calls.append((self.path, body))
            result = None if self.path.endswith('/claim') else {}
            data = json.dumps(result).encode()
            self.send_response(204 if result is None else 200)
            self.end_headers()
            if result is not None:
                self.wfile.write(data)
        def log_message(self, *_):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Nest)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {**os.environ, 'KROBI_API_TOKEN': 'fixture-worker-token', 'KROBI_WORKER_ID': 'fixture-device'}
    code = 'from krobi_helper.agent import Agent; import os; a=Agent(os.environ["NEST"], os.environ["KROBI_API_TOKEN"]); a.run()'
    env['NEST'] = f'http://127.0.0.1:{server.server_port}'
    proc = subprocess.Popen([sys.executable, '-c', code], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    def until(predicate, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.05)
        assert predicate(), calls
    try:
        until(lambda: any(p.endswith('/claim') for p, _ in calls))
        os.kill(proc.pid, signal.SIGUSR1)
        until(lambda: any(p.endswith('/bye') and b['reason'] == 'sleep' for p, b in calls))
        count = sum(p == '/api/helpers/claim' for p, _ in calls)
        until(lambda: sum(p == '/api/helpers/claim' for p, _ in calls) > count)
        assert proc.poll() is None
        proc.terminate()
        proc.wait(timeout=8)
        session = next(b['sessionId'] for p, b in calls if p == '/api/helpers/claim')
        assert any(p.endswith('/bye') and b == {'sessionId': session, 'reason': 'quit'} for p, b in calls)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        server.shutdown()
