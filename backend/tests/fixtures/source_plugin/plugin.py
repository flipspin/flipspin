"""Independent protocol peer: deliberately never imports the host or built-in."""
import json
import os
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

lock = threading.Lock()
log = Path(os.environ.get('FAKE_LOG', str(Path(os.environ.get('KROBI_SOURCE_DATA', '.')) / 'calls.jsonl')))
mode_file = Path('mode.txt')


def event(method, **fields):
    with lock:
        with log.open('a') as stream:
            stream.write(json.dumps({'method': method, 'pid': os.getpid(), 'at': time.monotonic(), **fields}) + '\n')


def send(message):
    with lock:
        print(json.dumps(message), flush=True)


def invoke(message):
    correlation, method, params = message['id'], message['method'], message['params']
    event(method, params=params)
    assert params['deadline'] > 0
    mode = os.environ.get('FAKE_MODE', mode_file.read_text().strip() if mode_file.exists() else '')
    if method == 'hello':
        result = {'id': os.environ.get('FAKE_ID', 'fake'), 'version': '1.0.0',
                  'protocol': 0 if mode == 'refuse' else 1, 'kinds': ['audio'], 'urlHosts': ['example.test']}
        manifest = Path('krobi-extension.json')
        if os.environ.get('KROBI_SOURCE_ID'):
            result['id'] = os.environ['KROBI_SOURCE_ID']
            if manifest.exists():
                result['version'] = json.loads(manifest.read_text())['version']
    elif method == 'test':
        result = {'ok': True}
    elif method == 'status':
        if mode == 'old':
            send({'id': correlation, 'error': {'kind': 'bug', 'message': 'Unknown method'}})
            return
        result = {'revision': 'one', 'facts': [{'label': 'Tool', 'value': 'one'}],
                  'actions': [{'id': 'update', 'label': 'Update now'}],
                  'toggles': [{'id': 'auto-update', 'label': 'Update automatically', 'value': True}]}
    elif method == 'action':
        if params['id'] != 'update':
            send({'id': correlation, 'error': {'kind': 'bug', 'message': 'Unknown action'}})
            return
        result = {'revision': 'two'}
    elif method == 'search':
        if mode == 'crash' and not log.with_suffix('.crashed').exists():
            log.with_suffix('.crashed').touch()
            os._exit(1)
        wanted = params['wanted']
        result = {'rows': [{'id': wanted['title'], 'title': wanted['title'], 'artist': wanted.get('artist') or '',
                            'url': 'https://example.test/' + wanted['title'], 'duration': 1, 'flags': []}]}
    elif method == 'fetch':
        candidate = params['id']
        if candidate == 'hang':
            time.sleep(30)
        if candidate in ('not-found', 'auth-required', 'rate-limited', 'blocked', 'network', 'broken', 'bug'):
            send({'id': correlation, 'error': {'kind': candidate, 'message': 'opaque words', 'retryAfter': 12}})
            return
        if candidate == 'progress':
            for pct in (10, 80):
                send({'id': correlation, 'progress': {'pct': pct}})
                time.sleep(0.26)
        else:
            time.sleep(0.1)
        target = Path(params['dir']) / 'audio.m4a'
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(os.environ['FAKE_AUDIO'], target)
        result = {'path': str(target), 'bytes': target.stat().st_size, 'duration': 1,
                  'codec': 'aac', 'bitrateKbps': 128, 'transcoded': False}
        if mode == 'bad-path':
            result['path'] = os.environ['FAKE_AUDIO']
        if mode == 'bad-result':
            result.pop('transcoded')
        event('fetched', candidate=candidate)
    else:
        send({'id': correlation, 'error': {'kind': 'bug', 'message': 'Unknown method'}})
        return
    send({'id': correlation, 'result': result})


with ThreadPoolExecutor(max_workers=4) as pool:
    for line in sys.stdin:
        pool.submit(invoke, json.loads(line))
