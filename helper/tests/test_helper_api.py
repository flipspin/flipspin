"""Real worker loop, subprocess and HTTP serialization; transport needs no sockets."""
import io
import json
import sys
import urllib.error
from email.parser import BytesParser
from email.policy import default

import pytest

from krobi_helper import agent as A

ENGINE = '''
import json, sys
from pathlib import Path
args = sys.argv[1:]
out = Path(args[args.index('--out-dir') + 1]); out.mkdir(parents=True, exist_ok=True)
if '--jobs' in args:
    job = json.loads(Path(args[args.index('--jobs') + 1]).read_text())[0]
    assert Path(job['audio']).read_bytes() == b'AUDIO'
    (out / 'song.lrc').write_text('[00:01.00]hola')
    result = {'event': 'done', 'lrc': str(out / 'song.lrc'), 'source': 'stt:test'}
else:
    job = json.loads(Path(args[args.index('--job') + 1]).read_text())
    assert Path(job['audio']).read_bytes() == b'AUDIO'
    (out / 'song.json').write_text('{"version":1,"chops":{}}')
    for stem in ('drums', 'bass', 'vocals', 'other'):
        (out / (stem + '.ogg')).write_bytes(b'OggS')
    result = {'event': 'done'}
print(json.dumps({'event': 'phase', 'phase': 'separando', 'percent': 50}), flush=True)
print(json.dumps(result), flush=True)
'''


@pytest.mark.parametrize('kind', ['align', 'transcribe', 'stems'])
@pytest.mark.parametrize('old_server', [False, True])
def test_new_worker_completes_both_protocols(tmp_path, monkeypatch, kind, old_server):
    calls = []
    job = {'id': 'job1', 'file': 'Song.mp3', 'album': 'Album', 'mediaPath': '/api/media/Album/Song.mp3',
           'text': 'hola' if kind == 'align' else None, 'model': 'htdemucs'}

    def urlopen(request, timeout):
        path = request.full_url.removeprefix('http://nest')
        body = request.data
        content_type = request.get_header('Content-type', '')
        if body is not None and 'multipart/' not in content_type:
            body = json.loads(body)
        calls.append((path, body, content_type))
        if old_server and path.startswith('/api/helpers/'):
            raise urllib.error.HTTPError(request.full_url, 404, 'old server', {}, io.BytesIO())
        if path.startswith('/api/media/'):
            return io.BytesIO(b'AUDIO')
        if path == '/api/helpers/claim':
            assert body['kinds'] == ['align', 'transcribe', 'stems']
            assert body['capabilities']['memoryBytes'] == 16 << 30
            return io.BytesIO(json.dumps({'job': {'id': 'job1', 'kind': kind, 'input': job}, 'lease': 'lease1'}).encode())
        if path == '/api/lyrics/agent/claim':
            result = {'lease': 'lease1', 'jobs': [] if kind == 'stems' else [job]}
        elif path == '/api/stems/agent/claim':
            result = {**job, 'id': 'lease1', 'jobId': 'job1'}
        else:
            result = {'stop': False, 'accepted': True}
        return io.BytesIO(json.dumps(result).encode())

    monkeypatch.setattr(A.Agent, '_urlopen', lambda self, request, timeout: urlopen(request, timeout))
    monkeypatch.setattr(A.Agent, '_watch_parent', lambda self: None)
    monkeypatch.setattr(A.Agent, '_caffeinate', lambda *args: None)
    script = tmp_path / 'engine.py'
    script.write_text(ENGINE)
    worker = A.Agent('http://nest', 'token', work_dir=tmp_path / 'work', log=lambda _: None)
    worker.facts = {'os': 'macos', 'accel': 'mlx', 'memoryBytes': 16 << 30, 'jobs': ['align', 'transcribe', 'stems']}
    worker.job_command = worker.stems_command = [sys.executable, str(script)]
    assert worker.run(once=True) == 0
    worker.bye('quit')
    paths = [p for p, _, _ in calls]
    assert paths[:2] == ['/api/helpers/limits', '/api/helpers/claim']
    result_path = (f'/api/{"stems" if kind == "stems" else "lyrics"}/agent/result' if old_server
                   else '/api/helpers/jobs/job1/result')
    posts = [(body, ct) for path, body, ct in calls if path == result_path]
    assert len(posts) == 1
    if kind == 'stems':
        body, ct = posts[0]
        parsed = BytesParser(policy=default).parsebytes(b'Content-Type: ' + ct.encode() + b'\r\n\r\n' + body)
        fields = {p.get_param('name', header='content-disposition'): p.get_payload(decode=True) for p in parsed.iter_parts()}
        assert fields['id' if old_server else 'lease'] == b'lease1'
        assert all(fields[name] == b'OggS' for name in ('drums', 'bass', 'vocals', 'other'))
    else:
        assert posts[0][0]['lrc'] == '[00:01.00]hola'
    if old_server:
        assert worker._legacy_api
        assert paths.count('/api/helpers/claim') == 1
        assert '/api/lyrics/agent/claim' in paths
        if kind == 'stems':
            assert paths.index('/api/lyrics/agent/claim') < paths.index('/api/stems/agent/claim')
    else:
        assert not any('/agent/' in path for path in paths)
        assert '/api/helpers/jobs/job1/heartbeat' in paths
        assert paths[-1] == '/api/helpers/bye'
    assert not list(worker.work_dir.iterdir())


@pytest.mark.parametrize('code', [401, 403, 422, 500])
def test_only_404_falls_back(tmp_path, monkeypatch, code):
    worker = A.Agent('http://nest', 'token', work_dir=tmp_path)
    paths = []
    def request(method, path, *args, **kwargs):
        paths.append(path)
        raise urllib.error.HTTPError(path, code, 'refused', {}, None)
    monkeypatch.setattr(worker, '_request', request)
    with pytest.raises(urllib.error.HTTPError):
        worker._claim()
    assert paths == ['/api/helpers/limits', '/api/helpers/claim']
    assert worker._legacy_api is False


@pytest.mark.parametrize('operation', ['heartbeat', 'result', 'bye', 'stems-result'])
def test_each_operation_falls_back_on_404(tmp_path, monkeypatch, operation):
    worker = A.Agent('http://nest', 'token', work_dir=tmp_path, log=lambda _: None)
    worker._stems_jobs['lease1'] = 'job1'
    calls = []
    def request(*args, **kwargs):
        path = args[1] if args[0] == 'POST' else args[0]
        calls.append((path, args))
        if path.startswith('/api/helpers/'):
            raise urllib.error.HTTPError(path, 404, 'old server', {}, None)
        return {'stop': False, 'accepted': True}
    monkeypatch.setattr(worker, '_request', request)
    monkeypatch.setattr(worker, '_post_multipart', request)
    if operation == 'heartbeat':
        worker._heartbeat_request('/api/lyrics/agent/heartbeat', {'jobId': 'job1', 'lease': 'lease1'})
        tail = '/api/lyrics/agent/heartbeat'
    elif operation == 'result':
        worker._post_result('lease1', 'job1', ok=False)
        tail = '/api/lyrics/agent/result'
    elif operation == 'bye':
        worker.bye()
        tail = '/api/lyrics/agent/bye'
    else:
        worker._post_stems_failure('lease1', 'error', False)
        tail = '/api/stems/agent/result'
    assert calls[0][0].startswith('/api/helpers/')
    assert calls[-1][0] == tail
    assert len(calls) == 2


def test_custom_proxy_headers_merge_and_redact(monkeypatch, tmp_path):
    monkeypatch.setenv('KROBI_CUSTOM_HEADERS', json.dumps({'CF-Access-Client-Id': 'client-id',
                                                         'CF-Access-Client-Secret': 'proxy-secret'}))
    logs = []
    worker = A.Agent('http://nest', 'token', work_dir=tmp_path, log=logs.append)
    headers = worker._headers('application/json')
    assert headers['CF-Access-Client-Id'] == 'client-id'
    assert headers['CF-Access-Client-Secret'] == 'proxy-secret'
    assert headers['Authorization'] == 'Bearer token'
    assert headers['Content-Type'] == 'application/json'
    assert headers['User-Agent'] == f'Flipspin/{A.__version__} ( https://github.com/flipspin/flipspin )'
    headers.clear()
    assert worker._headers()['CF-Access-Client-Secret'] == 'proxy-secret'
    worker.log('error from proxy-secret for client-id')
    assert logs == ['error from [REDACTED] for [REDACTED]']


def test_too_old_claim_idles_without_crashing_or_starting_work(tmp_path, monkeypatch):
    worker = A.Agent('http://nest', 'token', work_dir=tmp_path, log=lambda _: None)
    monkeypatch.setattr(worker, '_watch_parent', lambda: None)
    monkeypatch.setattr(worker, '_caffeinate', lambda *args: None)
    monkeypatch.setattr(worker, '_claim', lambda: {'stop': True, 'reason': 'too-old', 'minimum': '0.10.0'})
    monkeypatch.setattr(worker, '_process', lambda *args: pytest.fail('refused helper must not process'))
    waits = []
    def idle(seconds):
        waits.append(seconds)
        worker._stopping.set()
        return True
    monkeypatch.setattr(worker._stopping, 'wait', idle)
    assert worker.run() == 0
    assert waits == [A.IDLE_POLL_S]
