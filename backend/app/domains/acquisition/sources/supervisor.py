"""A long-running, multiplexed JSON-lines child with bounded calls and restarts.

The synchronous transport also works across the registry's worker event loops.
Reader threads own pipes; a timeout kills the whole process group and fails all
pending calls. Stderr never participates in the wire protocol.
"""
import asyncio
import concurrent.futures
import json
import logging
import math
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from app.exceptions import FailureKind, SourceFailure
from app.utils.path_safety import safe_open_path
from .manifest import read_manifest
from ..failures import failure_from_wire

logger = logging.getLogger(__name__)
MAX_LINE = 1024 * 1024


def broken(message):
    return SourceFailure(message)


class SourceSupervisor:
    def __init__(self, manifest: Path, *, env=None, revision=lambda: None, backoff=0.1, python=None, cwd=None):
        self.manifest, self.state, self.reason = read_manifest(manifest)
        self.id = self.manifest.get('id', '')
        self.env, self.revision = env, revision
        self.python, self.cwd, self.url_hosts = str(python or sys.executable), cwd, frozenset()
        self.backoff, self.failures, self.next_start = backoff, 0, 0.0
        self.lock = threading.RLock()
        self.idle = threading.Condition(self.lock)
        self.start_lock = threading.Lock()
        self.process = None
        self.pending = {}
        self.threads = []
        self.closed = False
        self.loaded_revision = None

    def _stop(self, process, message, *, penalize=True):
        with self.lock:
            if process is not self.process:
                return
            self.process = None
            if penalize:
                self.failures += 1
                self.next_start = time.monotonic() + min(5, self.backoff * 2 ** min(self.failures - 1, 6))
                if self.state == 'on':
                    self.state, self.reason = 'failed:broken', message
            calls, self.pending = self.pending, {}
            self.idle.notify_all()
            if process and process.poll() is None:
                try:
                    if os.name == 'posix':
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
            for future, _ in calls.values():
                if not future.done():
                    future.set_exception(broken(message))
        if process:
            process.wait()
            if process.stdin:
                process.stdin.close()

    def _read(self, process):
        try:
            while line := process.stdout.readline(MAX_LINE + 1):
                if len(line) > MAX_LINE or not line.endswith(b'\n'):
                    raise ValueError('Oversized or incomplete source line')
                message = json.loads(line)
                if not isinstance(message, dict) or not isinstance(message.get('id'), str):
                    raise ValueError('Invalid source envelope')
                with self.lock:
                    if process is not self.process:
                        return
                    call = self.pending.get(message['id'])
                    if call is None:
                        raise ValueError('Unknown source correlation id')
                    future, progress = call
                    if 'progress' in message:
                        pct = message['progress']['pct']
                        if not isinstance(pct, (int, float)) or not math.isfinite(pct) or not 0 <= pct <= 100:
                            raise ValueError('Invalid source progress')
                        if progress:
                            try:
                                progress(pct)
                            except Exception:
                                logger.debug('Source progress listener failed', exc_info=True)
                        continue
                    if ('result' in message) == ('error' in message):
                        raise ValueError('Expected a result or error')
                    if 'error' in message:
                        error = message['error']
                        FailureKind(error['kind'])
                        if not isinstance(error['message'], str):
                            raise ValueError('Invalid source error')
                        failure = failure_from_wire(error)
                        if failure.kind == FailureKind.AUTH_REQUIRED:
                            failure.message = f"{self.manifest['name']} needs sign-in. Configure its cookies in Settings."
                            failure.args = (failure.message,)
                        retry = error.get('retryAfter')
                        if retry is not None and (not isinstance(retry, (float, int)) or not math.isfinite(retry) or retry < 0):
                            raise ValueError('Invalid retryAfter')
                        failure.retry_after = retry
                        future.set_exception(failure)
                    else:
                        if not isinstance(message['result'], dict):
                            raise ValueError('Invalid source result')
                        future.set_result(message['result'])
                    self.pending.pop(message['id'])
                    self.idle.notify_all()
        except Exception:
            logger.debug('Invalid source protocol', exc_info=True)
        finally:
            self._stop(process, 'Source process exited or sent an invalid response.')
            process.stdout.close()

    def _logs(self, process):
        try:
            while line := process.stderr.readline(8192):
                logger.debug('Source %s: %s', self.id, line.decode(errors='replace').rstrip())
        finally:
            process.stderr.close()

    def _exchange(self, method, params, expires, progress=None):
        with self.lock:
            process = self.process
            if process is None:
                raise broken('Source process is unavailable.')
            correlation = uuid.uuid4().hex
            future = concurrent.futures.Future()
            self.pending[correlation] = future, progress
            remaining = max(1, int((expires - time.monotonic()) * 1000))
            message = {'id': correlation, 'method': method, 'params': {**params, 'deadline': remaining}}
            try:
                process.stdin.write((json.dumps(message, allow_nan=False) + '\n').encode())
                process.stdin.flush()
            except (OSError, ValueError):
                self._stop(process, 'Source pipe failed.')
        try:
            return future.result(timeout=max(0, expires - time.monotonic()))
        except TimeoutError:
            self._stop(process, 'Source call exceeded its deadline.')
            # Retrieve the same broken outcome as all sibling calls.
            return future.result()

    def _start(self, expires):
        acquired = self.start_lock.acquire(timeout=max(0, expires - time.monotonic()))
        if not acquired:
            with self.lock:
                process = self.process
            self._stop(process, 'Source call exceeded its deadline during startup.')
            raise broken('Source call exceeded its deadline during startup.')
        try:
            if self.closed or self.state in ('invalid', 'incompatible'):
                raise broken(self.reason or 'Source is closed.')
            revision = self.revision()
            with self.lock:
                process = self.process
                if process and self.loaded_revision == revision:
                    return
            if process:
                # A tool switch leaves existing calls on their immutable release.
                # Admit new work only after they finish and the child restarts.
                with self.idle:
                    while self.process is process and self.pending:
                        remaining = expires - time.monotonic()
                        if remaining <= 0:
                            raise broken('Source is waiting to restart after a tool update.')
                        self.idle.wait(timeout=remaining)
                self._stop(process, 'Source tool version changed.', penalize=False)
            delay = max(0, self.next_start - time.monotonic())
            if time.monotonic() + delay >= expires:
                raise broken('Source restart is backing off.')
            if delay:
                time.sleep(delay)
            command = [self.python if part == '{python}' else part for part in self.manifest['entry']['command']]
            try:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.PIPE, env=self.env() if callable(self.env) else self.env,
                                           start_new_session=os.name == 'posix', cwd=self.cwd)
            except OSError as error:
                self.state, self.reason = 'failed:broken', 'Source could not start.'
                self.failures += 1
                self.next_start = time.monotonic() + min(5, self.backoff * 2 ** min(self.failures - 1, 6))
                raise broken(self.reason) from error
            with self.lock:
                if self.closed:
                    process.kill()
                    process.communicate()
                    raise broken('Source is closed.')
                self.process, self.loaded_revision = process, revision
                self.threads = [thread for thread in self.threads if thread.is_alive()]
                for target in (self._read, self._logs):
                    thread = threading.Thread(target=target, args=(process,), daemon=True)
                    self.threads.append(thread)
                    thread.start()
            try:
                hello = self._exchange('hello', {'protocol': [1]}, min(expires, time.monotonic() + 5))
            except SourceFailure:
                if self.process is process:
                    self.state, self.reason = 'incompatible', 'Source refused the protocol handshake.'
                    self._stop(process, self.reason, penalize=False)
                raise
            if (type(hello.get('protocol')) is not int or hello['protocol'] != 1 or hello.get('id') != self.id
                    or hello.get('version') != self.manifest['version']
                    or not isinstance(hello.get('kinds'), list) or 'audio' not in hello['kinds']):
                self.state, self.reason = 'incompatible', 'Source hello does not support protocol 1 and audio.'
                self._stop(process, self.reason, penalize=False)
                raise broken(self.reason)
            hosts = hello.get('urlHosts', [])
            if not isinstance(hosts, list) or not all(isinstance(host, str) and host and '/' not in host and ':' not in host for host in hosts):
                self._stop(process, 'Invalid source URL hosts.')
                raise broken('Invalid source URL hosts.')
            self.url_hosts = frozenset(host.lower().rstrip('.') for host in hosts)
            self.state, self.reason = 'on', None
        finally:
            self.start_lock.release()

    def ready(self):
        with self.lock:
            if self.process is not None and self.state == 'on' and self.process.poll() is None:
                return True
        try:
            self._start(time.monotonic() + 5)
            return True
        except SourceFailure:
            return False

    def call(self, method, params, deadline, progress=None, cancelled=None):
        if not isinstance(deadline, int) or deadline <= 0:
            raise ValueError('deadline must be positive milliseconds')
        expires = time.monotonic() + deadline / 1000
        self._start(expires)
        if cancelled is not None and cancelled.is_set():
            self._stop(self.process, 'Source call was cancelled.')
            raise broken('Source call was cancelled.')
        result = self._exchange(method, params, expires, progress)
        self.failures = 0
        return result

    async def _call(self, method, params, deadline, progress=None):
        cancelled = threading.Event()
        worker = asyncio.create_task(asyncio.to_thread(self.call, method, params, deadline, progress, cancelled))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            cancelled.set()
            with self.lock:
                process = self.process
            self._stop(process, 'Source call was cancelled.')
            try:
                await asyncio.shield(worker)
            except Exception:
                pass
            raise

    async def test(self, *, deadline=30_000):
        result = await self._call('test', {}, deadline)
        if result.get('ok') is not True:
            raise broken('Invalid source test response.')
        return result

    async def status(self, *, deadline=30_000):
        return await self._call('status', {}, deadline)

    async def action(self, id, value=None, *, deadline=120_000):
        params = {'id': id}
        if value is not None:
            params['value'] = value
        return await self._call('action', params, deadline)

    async def search(self, wanted, *, limit=10, deadline=30_000, options=None):
        result = await self._call('search', {'wanted': wanted, 'limit': limit, 'options': options or {}}, deadline)
        try:
            rows = result['rows']
            if not isinstance(rows, list) or len(rows) > limit:
                raise ValueError('Invalid rows')
            for row in rows:
                if (not all(isinstance(row[k], str) for k in ('id', 'title', 'artist', 'url'))
                        or not isinstance(row['flags'], list)
                        or not all(isinstance(flag, str) for flag in row['flags'])
                        or (row['duration'] is not None and (not isinstance(row['duration'], (int, float))
                            or not math.isfinite(row['duration']) or row['duration'] < 0))):
                    raise ValueError('Invalid row')
            return rows
        except (KeyError, TypeError, ValueError) as error:
            raise broken('Invalid source search result.') from error

    async def fetch(self, candidate_id, directory, *, deadline, options=None, progress=None):
        result = await self._call('fetch', {'id': candidate_id, 'dir': str(directory), 'format': 'm4a-copy',
                                          'options': options or {}}, deadline, progress)
        try:
            path = safe_open_path(directory, Path(result['path']))
            if (not path.is_file() or path.suffix != '.m4a' or type(result['bytes']) is not int
                    or result['bytes'] != path.stat().st_size or result['bytes'] <= 0
                    or not isinstance(result['duration'], (int, float)) or not math.isfinite(result['duration'])
                    or result['duration'] <= 0 or not isinstance(result['codec'], str)
                    or type(result['transcoded']) is not bool
                    or (result['bitrateKbps'] is not None and (not isinstance(result['bitrateKbps'], (int, float))
                        or not math.isfinite(result['bitrateKbps']) or result['bitrateKbps'] <= 0))):
                raise ValueError('Invalid audio facts')
            return {**result, 'path': str(path)}
        except Exception as error:
            raise broken('Invalid source fetch result.') from error

    def close(self):
        self.closed = True
        with self.lock:
            process = self.process
        self._stop(process, 'Source host stopped.', penalize=False)
        for thread in self.threads:
            if thread is not threading.current_thread():
                thread.join(timeout=2)
