#!/usr/bin/env python3
"""Run an isolated backend and desktop; stop them together on every platform."""
import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / '.dev-data'
CONTROL = ROOT / '.dev-control.json'
PASSWORD = 'flipspin-development'


def environment(root):
    # Ignore inherited install credentials, sources and individual path pins.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('KROBI_', 'FLIPSPIN_', 'SPOTIFY_'))}
    env.pop('CREDENTIALS_DIRECTORY', None)
    env.update(FLIPSPIN_DATA_DIR=str(root), KROBI_DEFAULT_SONGS_PATH=str(REPO / 'resources/default-songs'),
               KROBI_BACKEND_URL='http://127.0.0.1:8000', KROBI_ADVERTISE='false',
               KROBI_UPDATE_CHECK='false', KROBI_ANALYSIS_AUTO='false', PYTHONUNBUFFERED='1')
    return env


def request(port, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.load(response)


def stop():
    if not CONTROL.exists():
        print('No dev session is running.')
        return
    state = json.loads(CONTROL.read_text())
    # A private control token avoids signalling a stale/reused process id.
    try:
        with socket.create_connection(('127.0.0.1', state['port']), timeout=3) as connection:
            connection.sendall(state['token'].encode())
    except ConnectionRefusedError:
        CONTROL.unlink(missing_ok=True)
        print('Removed stale dev session record.')
        return
    for _ in range(100):
        if not CONTROL.exists():
            return
        time.sleep(.1)
    raise RuntimeError('Dev session did not stop')


def terminate(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name != 'nt':
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def run(root, check=False):
    if not check and CONTROL.exists():
        raise RuntimeError('A dev session is recorded; run make stop before starting another')
    root.mkdir(parents=True, exist_ok=True)
    env = environment(root)
    # Check uses its own port so it cannot adopt or disturb another server.
    port = 8000
    if check:
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
    children = []
    stopped = threading.Event()
    control = socket.socket()
    try:
        if not check:
            control.bind(('127.0.0.1', 0))
            control.listen()
            control.settimeout(.5)
            token = secrets.token_urlsafe(32)
            CONTROL.parent.mkdir(exist_ok=True)
            with CONTROL.open('x') as out:
                json.dump({'port': control.getsockname()[1], 'token': token}, out)
            CONTROL.chmod(0o600)
            def listen():
                while not stopped.is_set():
                    try:
                        connection, _ = control.accept()
                        with connection:
                            connection.settimeout(1)
                            if secrets.compare_digest(connection.recv(1024).decode(), token):
                                stopped.set()
                    except (TimeoutError, OSError):
                        continue
            threading.Thread(target=listen, daemon=True).start()
        if (root / '.dev-seeded').exists():
            env.pop('KROBI_DEFAULT_SONGS_PATH', None)
        options = {'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
        server = subprocess.Popen([sys.executable, '-m', 'app', '--data-dir', str(root),
                                   '--host', '127.0.0.1', '--port', str(port)],
                                  cwd=REPO / 'backend', env=env, **options)
        children.append(server)
        for _ in range(120):
            if server.poll() is not None:
                raise RuntimeError('Dev backend exited during startup')
            if stopped.is_set():
                return
            try:
                health = request(port, '/api/health')
                if Path(health['base_music_dir']).resolve() != (root / 'Music').resolve():
                    raise RuntimeError('Port belongs to a server outside the dev root')
                break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(.25)
        else:
            raise RuntimeError('Dev backend did not become healthy')
        marker = root / '.dev-seeded'
        if not marker.exists():
            try:
                request(port, '/api/claim', {'label': 'Dev owner', 'username': 'dev', 'password': PASSWORD})
            except urllib.error.HTTPError as error:
                if error.code != 409:
                    raise
            marker.touch()
        print(f'Dev root: {root}\nSign in as dev with password: {PASSWORD}', flush=True)
        if check:
            assert (root / 'users.json').is_file(), 'Dev owner was not seeded'
            print('Dev server health and owner seed passed.', flush=True)
            return
        npm = shutil.which('npm')
        if not npm:
            raise RuntimeError('npm is missing; run make install first')
        # Windows .cmd launchers require the command processor.
        command = [npm, 'start'] if os.name != 'nt' else ['cmd', '/c', npm, 'start']
        children.append(subprocess.Popen(command, cwd=REPO, env=env, **options))
        while not stopped.wait(.5):
            if any(child.poll() is not None for child in children):
                break
    finally:
        stopped.set()
        for child in reversed(children):
            terminate(child)
        control.close()
        if not check:
            CONTROL.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start', 'stop', 'reset', 'check'], nargs='?', default='start')
    command = parser.parse_args().command
    if command == 'stop':
        stop()
    elif command == 'reset':
        stop()
        shutil.rmtree(ROOT, ignore_errors=True)
        print('Removed .dev-data')
    elif command == 'check':
        with tempfile.TemporaryDirectory(prefix='flipspin-dev-check-') as directory:
            directory = Path(directory)
            home = Path(os.environ['HOME']) if os.environ.get('HOME') else directory / 'home'
            home.mkdir(parents=True, exist_ok=True)
            if any(home.iterdir()):
                raise RuntimeError('dev-check requires HOME to point at an empty temporary directory')
            run(directory / 'data', check=True)
            assert not any(home.iterdir()), 'Dev startup wrote outside its data root into HOME'
            print('Empty HOME stayed empty.')
    else:
        run(ROOT)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
