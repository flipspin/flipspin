"""Owner-selected source code, staged and probed before replacing a live tree."""
import asyncio
from contextlib import nullcontext
import errno
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import uuid
from datetime import datetime, UTC
from pathlib import Path

import requests

from app.config import APP_VERSION
from app.exceptions import SourceFailure
from app.infra.files import PRIVATE, write_json_atomic
from app.infra.jobs.kinds import JobKind
from app.utils.path_safety import safe_open_path
from .installed import installed_source, python_path, register_source, recover_installation, reserved_ids
from .manifest import read_manifest

logger = logging.getLogger(__name__)

INSTALL_KIND = JobKind('source-install', (), lambda **kwargs: None, 'source-install')
SKIP = {'.git', '.venv', '__pycache__'}
GITHUB = re.compile(r'https://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?')
ARCHIVE_LIMIT = 200 * 1024 * 1024


class InstallFailure(ValueError):
    """kind is the legacy failure word; cause is the code a client translates."""
    def __init__(self, kind, message, cause=None):
        self.kind = kind
        self.cause = cause
        super().__init__(message)


# The steps and causes a client may show; the same list is in docs/PLUGINS.md.
STEPS = ('download', 'unpack', 'verify', 'build', 'test', 'publish')
CAUSES = ('no-network', 'not-found', 'too-large', 'bad-archive', 'tool-missing', 'tool-failed', 'timeout',
          'build-failed', 'unsupported', 'invalid-manifest', 'id-in-use', 'handshake', 'test-failed',
          'space', 'cancelled', 'unknown')


def failure_cause(error):
    seen = error
    while seen is not None:
        if isinstance(seen, OSError) and seen.errno == errno.ENOSPC:
            return 'space'
        seen = seen.__cause__ or seen.__context__
    cause = getattr(error, 'cause', None)
    if cause:
        return cause
    kind = getattr(error, 'kind', None)
    if kind == 'cancelled':
        return 'cancelled'
    return 'unknown'


def copy_source(source, destination):
    """Reject links rather than copying any target outside the selected tree."""
    source = source.resolve(strict=True)
    def ignore(directory, names):
        return [name for name in names if name in SKIP or (Path(directory) / name).is_symlink()]
    safe_open_path(source.parent, source)
    shutil.copytree(source, destination, ignore=ignore)


def run(command, *, cwd=None):
    name = Path(command[0]).name
    try:
        # A clone that asks for credentials fails at once instead of waiting for the timeout.
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        # The nest's stdin is the desktop's shutdown pipe; a tool must not inherit it.
        # Tool output is UTF-8 whatever the Windows code page is.
        result = subprocess.run(
            command, cwd=cwd, capture_output=True, stdin=subprocess.DEVNULL, text=True,
            encoding='utf-8', errors='replace', timeout=600, env=env,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.TimeoutExpired as error:
        logger.warning('plugin installer: %s timed out after %ss', name, error.timeout)
        raise InstallFailure('build', f'{name} did not finish in 10 minutes.', 'timeout') from error
    except FileNotFoundError as error:
        logger.warning('plugin installer: %s is not installed (errno=%s winerror=%s)',
                       command[0], error.errno, getattr(error, 'winerror', None))
        raise InstallFailure('build', f'{name} is needed to install from this address.', 'tool-missing') from error
    except OSError as error:
        logger.warning('plugin installer: could not start %s (resolved %s): errno=%s winerror=%s %s',
                       command[0], shutil.which(command[0]), error.errno,
                       getattr(error, 'winerror', None), error.strerror)
        raise InstallFailure('build', f'Could not run {name}: {error.strerror or error}.', 'tool-failed') from error
    if result.returncode:
        # The tail is actionable build output, kept with the owner-visible job.
        raise InstallFailure('build', (result.stderr or result.stdout or 'Plugin build failed.').strip()[-2000:], 'build-failed')
    return result.stdout.strip()


def download(url, limit):
    try:
        with requests.get(url, stream=True, timeout=60, headers={'User-Agent': f'Flipspin/{APP_VERSION}'}) as response:
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_content(1 << 16):
                body += chunk
                if len(body) > limit:
                    raise InstallFailure('build', 'The source download is too large.', 'too-large')
            return bytes(body)
    except requests.HTTPError as error:
        logger.warning('plugin installer: download failed for %s: %s', url, error)
        status = error.response.status_code if error.response is not None else None
        if status == 404:
            raise InstallFailure('location', 'The source was not found at that address.', 'not-found') from error
        raise InstallFailure('network', f'Could not download the source: network error (HTTP {status}).', 'no-network') from error
    except requests.RequestException as error:
        logger.warning('plugin installer: download failed for %s: %s', url, error)
        raise InstallFailure('network', f'Could not download the source: network error ({type(error).__name__}).', 'no-network') from error


def fetch_github(owner, repo, destination, unpacking=lambda: None):
    """Fetch the default branch's tree over HTTPS, so installing needs no git."""
    refs = download(f'https://github.com/{owner}/{repo}.git/info/refs?service=git-upload-pack', 16 * 1024 * 1024)
    head = re.search(rb'([0-9a-f]{40}) HEAD\x00', refs)
    if not head:
        raise InstallFailure('location', 'The repository has no default branch.', 'not-found')
    commit = head.group(1).decode()
    archive = download(f'https://codeload.github.com/{owner}/{repo}/tar.gz/{commit}', ARCHIVE_LIMIT)
    unpacking()
    unpacked = destination.parent / 'archive'
    unpacked.mkdir()
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
            # Links are dropped, as in copy_source; the data filter refuses paths outside the folder.
            members = [m for m in bundle.getmembers() if m.isfile() or m.isdir()]
            bundle.extractall(unpacked, members=members, filter='data')
    except (tarfile.TarError, OSError, EOFError) as error:
        raise InstallFailure('build', 'The source download is not a valid archive.', 'bad-archive') from error
    tops = list(unpacked.iterdir())
    if len(tops) != 1 or not tops[0].is_dir():
        raise InstallFailure('build', 'The source download is not a valid archive.', 'bad-archive')
    tops[0].rename(destination)
    shutil.rmtree(unpacked, ignore_errors=True)
    return commit


class SourceInstaller:
    def __init__(self, container):
        self.container = container
        self.lock = threading.RLock()
        self.operation_lock = threading.RLock()
        self.threads = {}

    @property
    def root(self):
        return self.container.config.data_root / 'sources'

    def submit(self, location):
        if not location.strip():
            raise InstallFailure('location', 'Enter a repository URL or a folder on the nest.')
        tracker = self.container.get_progress_tracker()
        job_id = str(uuid.uuid4())
        tracker.create_progress(job_id, 1, kind=INSTALL_KIND.ledger_kind, label='Install plugin',
            items=[{'item': 'Install plugin', 'detail': {'location': location, '_retry': {'producer': 'source-install', 'location': location}}}])
        self.kick(job_id)
        return job_id

    def kick(self, job_id):
        with self.lock:
            if job_id in self.threads:
                return
            thread = threading.Thread(target=self._job, args=(job_id,), name='source-install', daemon=True)
            self.threads[job_id] = thread
            thread.start()

    def _job(self, job_id):
        tracker = self.container.get_progress_tracker()
        ledger = self.container.get_jobs()
        row = ledger.get(job_id)
        item = ledger.items(job_id)[0]
        try:
            if tracker.get_progress(job_id) is None:
                tracker.create_progress(job_id, 1)
            tracker.set_status(job_id, 'in_progress')
            def phase(value):
                current = ledger.get(job_id)
                if not current or current['state'] not in ('queued', 'running') or current['attempt'] != row['attempt']:
                    raise InstallFailure('cancelled', 'Plugin installation was cancelled.', 'cancelled')
                tracker.set_track_phase(job_id, item['item'], value)
            def finished():
                ledger.outcome(job_id, item['item'], success=True, attempt=row['attempt'])
                tracker.update_progress(job_id, item['item'])
                tracker.complete_progress(job_id, 'done', succeeded=1, failed=0)
            self.install(item['detail']['location'], phase=phase, fence=ledger.lock, finished=finished)
        except Exception as error:
            current = ledger.get(job_id)
            if not current or current['attempt'] != row['attempt'] or current['state'] not in ('queued', 'running'):
                return
            kind = getattr(error, 'kind', 'installation')
            message = str(error) or 'Plugin installation failed.'
            failure = {'item': item['item'], 'kind': str(kind), 'error': message, 'reason': message,
                       'step': getattr(error, 'step', None) or 'download', 'cause': failure_cause(error)}
            ledger.outcome(job_id, item['item'], success=False, reason=str(kind), detail={**item['detail'], **failure}, attempt=row['attempt'])
            tracker.add_failure(job_id, failure)
            tracker.complete_progress(job_id, 'failed', succeeded=0, failed=1)
        finally:
            with self.lock:
                self.threads.pop(job_id, None)
                current = ledger.get(job_id)
                if current and current['state'] == 'queued':
                    self.kick(job_id)

    def install(self, location, *, phase=lambda value: None, fence=None, finished=lambda: None):
        with self.operation_lock:
            registry = self.container.get_provider_registry()
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            staging = self.root / '.staging'
            staging.mkdir(exist_ok=True, mode=0o700)
            work = Path(tempfile.mkdtemp(dir=staging))
            candidate = work / 'candidate'
            candidate.mkdir()
            probe = None
            step = ['download']
            def at(value):
                # The progress phase stays as shipped; the step is the client's failure code.
                step[0] = {'fetch': 'download', 'validate': 'verify', 'hello': 'test'}.get(value, value)
                phase(value)
            try:
                at('fetch')
                src = candidate / 'src'
                kind = 'git' if location.startswith(('https://', 'git@')) else 'path'
                commit = None
                github = GITHUB.fullmatch(location)
                if github:
                    commit = fetch_github(*github.groups(), src, unpacking=lambda: step.__setitem__(0, 'unpack'))
                elif kind == 'git':
                    run(['git', 'clone', '--depth', '1', '--', location, str(src)])
                    commit = run(['git', '-C', str(src), 'rev-parse', 'HEAD'])
                else:
                    local = Path(location).expanduser()
                    if not local.is_dir():
                        raise InstallFailure('location', 'The folder does not exist on this nest.', 'not-found')
                    copy_source(local, src)
                at('validate')
                try:
                    shutil.copyfile(src / 'krobi-extension.json', candidate / 'krobi-extension.json')
                except OSError as error:
                    raise InstallFailure('invalid', 'Manifest is unreadable or missing.', 'invalid-manifest') from error
                manifest, state, reason = read_manifest(candidate / 'krobi-extension.json')
                if state != 'on':
                    raise InstallFailure(state, reason, 'invalid-manifest')
                id = manifest['id']
                existing = registry.get(id)
                if id in reserved_ids(self.container.config.data_root) or (existing and not hasattr(existing[1], 'source')):
                    raise InstallFailure('invalid', 'Extension id is already in use.', 'id-in-use')
                target = self.root / id
                if target.exists():
                    safe_open_path(self.root, target)
                    if target.is_symlink():
                        raise InstallFailure('invalid', 'Source installation cannot be a symlink.', 'invalid-manifest')
                data = candidate / 'data'
                if (target / 'data').exists():
                    copy_source(target / 'data', data)
                else:
                    data.mkdir(mode=0o700)
                at('build')
                uv = os.environ.get('KROBI_UV')
                # The venv is built in staging and renamed on publish, so its console-script
                # launchers must use relative paths or they point at the deleted staging dir.
                if uv:
                    run([uv, 'venv', '--relocatable', '--python', '3.12', '--seed', str(candidate / 'venv')])
                    run([uv, 'pip', 'install', '--python', str(python_path(candidate)), '--', str(src)])
                elif not getattr(sys, 'frozen', False):
                    run([sys.executable, '-m', 'venv', str(candidate / 'venv')])
                    run([str(python_path(candidate)), '-m', 'pip', 'install', '--', str(src)])
                else:
                    raise InstallFailure('build', "This nest can't build plugins", 'unsupported')
                at('hello')
                probe = installed_source(candidate)
                # The staging directory's name is not the installed identity.
                probe.env['KROBI_SOURCE_ID'] = id
                if not probe.ready():
                    raise InstallFailure(probe.state, probe.reason or 'Source hello failed.', 'handshake')
                at('test')
                asyncio.run(probe.test(deadline=30_000))
                probe.close()
                probe = None
                write_json_atomic(candidate / 'install.json', {'location': location, 'kind': kind,
                    **({'commit': commit} if commit else {}), 'version': manifest['version'],
                    'installedAt': datetime.now(UTC).isoformat()}, mode=PRIVATE)
                with fence or nullcontext():
                    at('publish')
                    with registry._lock:
                        self._publish(candidate, target, work, registry)
                    finished()
                self.container.get_source_status().forget(id)
                self.container.changes.bump('config')
                return id
            except SourceFailure as error:
                failure = InstallFailure(str(error.kind), str(error), 'test-failed' if step[0] == 'test' else 'handshake')
                failure.step = step[0]
                raise failure from error
            except BaseException as error:
                if not getattr(error, 'step', None):
                    try:
                        error.step = step[0]
                    except AttributeError:
                        pass
                raise
            finally:
                if probe:
                    probe.close()
                shutil.rmtree(work, ignore_errors=True)

    def _publish(self, candidate, target, work, registry):
        previous = work / 'previous'
        journal = self.root / '.transaction.json'
        write_json_atomic(journal, {'id': target.name, 'work': work.name, 'hadPrevious': target.exists()}, mode=PRIVATE)
        old = registry.get(target.name)
        published = False
        try:
            if old:
                old[1].source.close()
            if target.exists():
                target.rename(previous)
            # Preserve the actual old data, including writes made during probe.
            if (previous / 'data').exists():
                shutil.rmtree(candidate / 'data')
                (previous / 'data').rename(candidate / 'data')
            candidate.rename(target)
            published = True
            registry.unregister(target.name)
            register_source(registry, target, self.container.config)
        except BaseException:
            if published:
                target.rename(candidate)
            if previous.exists():
                if (candidate / 'data').exists() and not (previous / 'data').exists():
                    (candidate / 'data').rename(previous / 'data')
                previous.rename(target)
            registry.unregister(target.name)
            if target.exists():
                register_source(registry, target, self.container.config)
            raise
        finally:
            journal.unlink(missing_ok=True)

    def _target(self, id):
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,40}', id) or (self.root / id).is_symlink():
            raise FileNotFoundError(id)
        target = safe_open_path(self.root, self.root / id)
        if not target.is_dir() or target.parent != self.root.resolve() or target.name != id:
            raise FileNotFoundError(id)
        return target

    def remove(self, id):
        with self.operation_lock:
            registry = self.container.get_provider_registry()
            target = self._target(id)
            with registry._lock:
                current = registry.get(id)
                if current:
                    current[1].source.close()
                    # Persist its slot even when no preferences file existed yet.
                    registry._persist()
                    registry.unregister(id)
            shutil.rmtree(target)
            self.container.get_source_status().forget(id, permanent=True)
            self.container.changes.bump('config')

    def location(self, id):
        target = self._target(id)
        return json.loads(safe_open_path(target, target / 'install.json').read_text())['location']

    def recover(self):
        with self.operation_lock:
            recover_installation(self.root)
            shutil.rmtree(self.root / '.staging', ignore_errors=True)
            for row in self.container.get_jobs().list():
                if row['kind'] == 'source-install' and row['state'] in ('queued', 'running'):
                    self.kick(row['id'])

    def maintain(self):
        for row in self.container.get_jobs().list():
            if row["kind"] == "source-install" and row["state"] == "queued":
                self.kick(row["id"])
