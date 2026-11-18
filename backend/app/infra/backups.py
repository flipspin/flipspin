"""Private, verified state snapshots. Media and rebuildable caches stay out.

Retention keeps the newest snapshot on seven distinct UTC days, then the
newest in four older ISO weeks. Manual snapshots participate in those buckets.
Incomplete staging directories and migration snapshots are never pruned here.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from app.config import APP_VERSION
from app.infra.data_lock import DataLock
from app.infra.files import PRIVATE, write_bytes_atomic, write_json_atomic
from app.infra.migrations import fsync_directory
from app.infra.sqlite_backup import check_integrity, snapshot_database
from app.utils.path_safety import resolve_under

logger = logging.getLogger(__name__)
STAMP = re.compile(r'\d{8}T\d{6}\.\d{6}Z')
JSON_STORES = ('users.json', 'user_tracks.json', 'instance.json', 'providers.json',
               'lyrics.json', 'subsonic-stars.json')
EXCLUDED = frozenset(('Music', 'music', 'stems', 'models', 'tools', 'temp', 'logs',
                      'backups'))
FIRST_DELAY = 10 * 60
DAILY_INTERVAL = 24 * 60 * 60


def utc_stamp(now: datetime) -> str:
    return now.astimezone(UTC).strftime('%Y%m%dT%H%M%S.%fZ')


def stamp_time(stamp: str) -> datetime:
    if not STAMP.fullmatch(stamp):
        raise ValueError('Invalid backup stamp')
    return datetime.strptime(stamp, '%Y%m%dT%H%M%S.%fZ').replace(tzinfo=UTC)


def safe_file(base: Path, name: str) -> Path:
    """Reject traversal and symlinks in every existing path component."""
    parts = PurePosixPath(name).parts
    if not parts or '\\' in name or '\x00' in name or any(p in ('', '.', '..') for p in name.split('/')) or name.startswith('/'):
        raise ValueError('Invalid backup file')
    path = base
    if base.is_symlink():
        raise ValueError('Symlinks cannot be backed up or restored')
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError('Symlinks cannot be backed up or restored')
    if base.is_dir():
        resolve_under(base, *parts)
    elif not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('Backup file escapes directory')
    return path


def is_store(name: str) -> bool:
    parts = PurePosixPath(name).parts
    return (name in JSON_STORES or
            (len(parts) > 1 and parts[0] == 'playlists') or
            (name.endswith('.sqlite') and not EXCLUDED.intersection(parts[:-1])))


def file_record(path: Path, name: str) -> dict:
    with path.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    return {'path': name, 'size': path.stat().st_size, 'sha256': digest}


def verify_snapshot(directory: Path) -> dict:
    stamp_time(directory.name)
    manifest = json.loads(safe_file(directory, 'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict):
        raise ValueError('Invalid backup manifest')
    if (manifest.get('version') != 1 or manifest.get('stamp') != directory.name or
            not isinstance(manifest.get('reason'), str) or not isinstance(manifest.get('appVersion'), str) or
            manifest.get('directories') != ['playlists'] or not isinstance(manifest.get('files'), list)):
        raise ValueError('Invalid backup manifest')
    names = set()
    for item in manifest['files']:
        name = item['path']
        if not is_store(name) or name in names:
            raise ValueError('Invalid or duplicate backup store')
        names.add(name)
        path = safe_file(directory, name)
        if file_record(path, name) != item:
            raise ValueError('Backup checksum or size mismatch')
        if name.endswith('.sqlite'):
            check_integrity(path)
    actual = set()
    for root, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            path = safe_file(directory, (Path(root) / name).relative_to(directory).as_posix())
            if path.is_file():
                actual.add(path.relative_to(directory).as_posix())
    if actual != names | {'manifest.json'}:
        raise ValueError('Backup inventory mismatch')
    return manifest


class BackupManager:
    def __init__(self, config, *, now=None):
        self.config = config
        self.data = config.data_root
        self.directory = self.data / 'backups'
        self.now = now or (lambda: datetime.now(UTC))
        self._stop = threading.Event()
        self._thread = None
        self.health = {'value': None, 'state': 'unavailable', 'reason': 'not-checked',
                       'source': {'store': 'backups.latest', 'asOf': None}}

    def target(self, name: str) -> Path:
        configured = {filename: getattr(self.config, field) for filename, field in (
            ('users.json', 'users_file'), ('user_tracks.json', 'user_tracks_file'),
            ('instance.json', 'instance_file'), ('providers.json', 'providers_file'),
            ('lyrics.json', 'lyrics_file'), ('jobs.sqlite', 'jobs_file'), ('analysis.sqlite', 'analysis_db'))}
        configured['subsonic-stars.json'] = Path(self.config.users_file).with_name('subsonic-stars.json')
        if name in configured:
            path = Path(configured[name])
            # Configured stores may be outside the data directory, but never symlinks.
            safe_file(path.parent, path.name)
            return path
        if name.startswith('playlists/'):
            return safe_file(self.config.playlist_dir, name.removeprefix('playlists/'))
        return safe_file(self.data, name)

    def sources(self) -> dict[str, Path]:
        sources = {}
        for name in (*JSON_STORES, 'jobs.sqlite', 'analysis.sqlite'):
            path = self.target(name)
            if path.exists():
                sources[name] = path
        excluded_paths = [self.directory, *(Path(getattr(self.config, field)) for field in
                          ('base_music_dir', 'stems_dir', 'models_dir', 'tools_dir', 'temp_dir', 'log_dir'))]
        for root, dirs, files in os.walk(self.data, followlinks=False):
            dirs[:] = [d for d in dirs if d not in EXCLUDED and not d.startswith('.') and
                       not any((Path(root) / d).resolve().is_relative_to(p.resolve()) for p in excluded_paths)]
            for name in files:
                if name.endswith('.sqlite'):
                    rel = (Path(root) / name).relative_to(self.data).as_posix()
                    path = safe_file(self.data, rel)
                    # A relocated known store is authoritative over its old default.
                    if rel not in ('jobs.sqlite', 'analysis.sqlite') and path.resolve() not in {p.resolve() for p in sources.values()}:
                        sources[rel] = path
        if self.config.playlist_dir.exists():
            safe_file(self.config.playlist_dir.parent, self.config.playlist_dir.name)
            for root, dirs, files in os.walk(self.config.playlist_dir, followlinks=False):
                for name in dirs + files:
                    path = safe_file(self.config.playlist_dir, (Path(root) / name).relative_to(self.config.playlist_dir).as_posix())
                    if path.is_file():
                        sources['playlists/' + path.relative_to(self.config.playlist_dir).as_posix()] = path
        return sources

    def backup_now(self, reason: str) -> dict:
        """Synchronous port for owners and callers about to perform risky work.

        Raises on failure so a risky caller can abort before changing state.
        Migrations retain their existing per-store snapshots via the same
        online SQLite primitive; they must not also call this port.
        """
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 200:
            raise ValueError('A backup reason is required (at most 200 characters)')
        with DataLock(self.data / '.backup.lock'):
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            if self.directory.is_symlink():
                raise ValueError('Symlinked backup directory')
            self.directory.chmod(0o700)
            stamp = utc_stamp(self.now())
            stage = self.directory / ('.' + stamp + '.pending')
            final = self.directory / stamp
            if final.exists():
                raise FileExistsError('Backup stamp already exists')
            stage.mkdir(mode=0o700)
            try:
                (stage / 'playlists').mkdir(mode=0o700)
                files = []
                for name, source in sorted(self.sources().items()):
                    destination = safe_file(stage, name)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if name.endswith('.sqlite'):
                        with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as db:
                            snapshot_database(db, destination)
                        fsync_directory(destination.parent)
                    else:
                        write_bytes_atomic(destination, source.read_bytes(), mode=PRIVATE)
                    files.append(file_record(destination, name))
                write_json_atomic(stage / 'manifest.json', {
                    'version': 1, 'stamp': stamp, 'appVersion': APP_VERSION, 'reason': reason.strip(),
                    'directories': ['playlists'], 'files': files,
                }, mode=PRIVATE)
                fsync_directory(stage)
                stage.rename(final)
                fsync_directory(self.directory)
            except BaseException:
                shutil.rmtree(stage, ignore_errors=True)
                raise
            result = self.describe(final)
            if not result['ok']:
                raise ValueError('Backup verification failed')
            try:
                self.prune()
            except OSError:
                logger.exception('Backup completed but retention failed')
            self.refresh_health()
            return result

    def describe(self, directory: Path) -> dict:
        result = {'stamp': directory.name, 'size': 0, 'reason': '', 'ok': False}
        try:
            manifest = verify_snapshot(directory)
            result.update(size=sum(item['size'] for item in manifest['files']), reason=manifest['reason'], ok=True)
        except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
            pass
        return result

    def _directories(self) -> list[Path]:
        if not self.directory.exists() or self.directory.is_symlink():
            return []
        return [path for path in sorted(self.directory.iterdir(), reverse=True)
                if STAMP.fullmatch(path.name) and path.is_dir() and not path.is_symlink()]

    def list_backups(self) -> list[dict]:
        return [self.describe(path) for path in self._directories()]

    def latest(self) -> dict | None:
        # Health polls need only the latest valid copy, not every retained DB.
        for path in self._directories():
            entry = self.describe(path)
            if entry['ok']:
                return entry
        return None

    def prune(self) -> None:
        daily, weekly = set(), set()
        for item in self.list_backups():
            if not item['ok']:
                continue
            date = stamp_time(item['stamp']).date()
            week = date.isocalendar()[:2]
            if date not in daily and len(daily) < 7:
                daily.add(date)
            elif date not in daily and week not in weekly and len(weekly) < 4:
                weekly.add(week)
            else:
                shutil.rmtree(self.directory / item['stamp'])
        fsync_directory(self.directory)

    def refresh_health(self):
        as_of = self.now().isoformat()
        try:
            latest = self.latest()
            self.health = {'value': stamp_time(latest['stamp']).isoformat() if latest else None,
                           'state': 'ready', 'reason': None, 'source': {'store': 'backups.latest', 'asOf': as_of}}
        except (OSError, ValueError):
            self.health = {'value': None, 'state': 'unavailable', 'reason': 'source-failed',
                           'source': {'store': 'backups.latest', 'asOf': as_of}}

    def _run(self) -> None:
        self.refresh_health()
        delay = FIRST_DELAY
        while not self._stop.wait(delay):
            try:
                self.backup_now('scheduled')
            except Exception:
                logger.exception('Scheduled backup failed; will retry tomorrow')
            delay = DAILY_INTERVAL

    def start(self) -> None:
        if self._thread is None:
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name='state-backups', daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            # Wait for an in-flight snapshot before the data lock is released.
            self._thread.join()
            self._thread = None
