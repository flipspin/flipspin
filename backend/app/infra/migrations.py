"""Safe store upgrades and offline verification. Refusals exit with EX_CONFIG (78).

Run ``python -m app.infra.migrations --check --data DIR`` on a disposable copy.
Never copy a live SQLite file directly: use the online backup API, including WAL state.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.infra.files import PRIVATE, write_bytes_atomic, write_json_atomic
from app.infra.sqlite_backup import snapshot_database as online_snapshot

EXIT_CONFIG = 78
BUSY_TIMEOUT_MS = 5000
logger = logging.getLogger(__name__)


class StoreRefusal(SystemExit):
    """Bypass generic exception fallbacks, including ASGI startup handling."""

    def __init__(self):
        super().__init__(EXIT_CONFIG)


def refuse(store, old, head, step, error, snapshot=None):
    # A single physical log line, without a traceback or any stored row values.
    message = ' '.join(str(error).splitlines())
    logger.critical('store=%s from=v%s to=v%s step=%s error=%s snapshot=%s action=refused-to-start',
                    store, old, head, step, message, snapshot or '-')
    raise StoreRefusal()


@dataclass(frozen=True)
class SQLiteStore:
    name: str
    steps: tuple[Callable, ...]
    baseline: Callable = lambda db: 0
    application_id: int = 0
    rebuild_steps: frozenset[int] = frozenset()

    @property
    def head(self):
        return len(self.steps)


def fsync_directory(path):
    if os.name != 'nt':
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def snapshot_path(path, store, old):
    from app.config import APP_VERSION

    version = re.sub(r'[^a-zA-Z0-9._-]', '_', APP_VERSION)
    stamp = datetime.now(UTC).strftime('%Y%m%dT%H%M%S.%fZ')
    return path.parent / 'backups' / f'{store.name}.v{old}-{version}-{stamp}-{time.time_ns()}.sqlite'


def snapshot_database(db, snapshot):
    directory = snapshot.parent
    directory.mkdir(parents=True, exist_ok=True)
    write_bytes_atomic(Path(str(snapshot) + '.failed'), b'pending or failed migration\n', mode=PRIVATE)
    online_snapshot(db, snapshot)
    fsync_directory(directory)
    return snapshot


def prune_snapshots(path, store, snapshot):
    Path(str(snapshot) + '.failed').unlink()
    candidates = sorted((path.parent / 'backups').glob(f'{store.name}.v*.sqlite'), reverse=True)
    # Old schema numbers need not sort chronologically, so order by creation.
    candidates.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
    successful = [p for p in candidates if not Path(str(p) + '.failed').exists()]
    for obsolete in successful[3:]:
        obsolete.unlink()
    fsync_directory(snapshot.parent)


def quarantine(path):
    """Only called after closing this runner's connection; never overwrite one."""
    target = path.with_name(f'{path.name}.broken-{time.time_ns()}')
    for suffix in ('', '-wal', '-shm'):
        source = Path(str(path) + suffix)
        if source.exists():
            source.rename(Path(str(target) + suffix))
    fsync_directory(path.parent)
    return target


def row_counts(db):
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    return {name: db.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0]
            for name in names}


def open_store(path, store, *, report=None):
    """Open, validate, snapshot and upgrade, returning a normal sqlite connection.

    Each step owns exactly one explicit transaction. No step may commit, begin,
    or use executescript. Unversioned stores are stamped by shape detection;
    their matching steps are never replayed.
    """
    path = Path(path)
    db = None
    old = 0
    step = 'open'
    snapshot = None
    corrupt = False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.exists()
        # A read-only first connection avoids SQLite deleting a malformed WAL
        # on close before quarantine with its database.
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True,
                             timeout=BUSY_TIMEOUT_MS / 1000, check_same_thread=False) if existing else sqlite3.connect(
                                 path, timeout=BUSY_TIMEOUT_MS / 1000, check_same_thread=False)
        db.row_factory = sqlite3.Row
        db.execute(f'PRAGMA busy_timeout={BUSY_TIMEOUT_MS}')
        step = 'quick_check'
        result = [r[0] for r in db.execute('PRAGMA quick_check')]
        if result != ['ok']:
            corrupt = True
            raise sqlite3.DatabaseError('quick_check failed')
        if existing:
            db.close()
            db = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000, check_same_thread=False)
            db.row_factory = sqlite3.Row
            db.execute(f'PRAGMA busy_timeout={BUSY_TIMEOUT_MS}')
        old = db.execute('PRAGMA user_version').fetchone()[0]
        if old > store.head:
            raise ValueError('newer database than this build')
        before = row_counts(db)
        step = 'baseline'
        detected = store.baseline(db) if old == 0 else old
        identity = db.execute('PRAGMA application_id').fetchone()[0]
        if identity not in (0, store.application_id):
            raise ValueError('unexpected application_id')
        # Always obtain a write reservation, even at head: a second writer must
        # wait and refuse rather than race startup or trigger a reset.
        db.execute('BEGIN IMMEDIATE')
        if identity == 0:
            db.execute(f'PRAGMA application_id={store.application_id}')
        if detected != old:
            db.execute(f'PRAGMA user_version={detected}')
        db.commit()
        old = detected
        if old < store.head:
            step = 'snapshot'
            snapshot = snapshot_path(path, store, old)
            snapshot_database(db, snapshot)
        for number, migrate in enumerate(store.steps, 1):
            if number <= old:
                continue
            step = number
            rebuild = number in store.rebuild_steps
            db.execute(f'PRAGMA foreign_keys={"OFF" if rebuild else "ON"}')
            db.execute('BEGIN IMMEDIATE')
            try:
                migrate(db)
                if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                    raise sqlite3.IntegrityError('foreign_key_check failed')
                db.execute(f'PRAGMA user_version={number}')
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.execute('PRAGMA foreign_keys=ON')
        step = 'counts'
        after = row_counts(db)
        if any(after.get(table, 0) < count for table, count in before.items()):
            raise ValueError('row count decreased')
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA foreign_keys=ON')
        if snapshot:
            prune_snapshots(path, store, snapshot)
        if report is not None:
            report.update(store=store.name, **{'from': old, 'to': store.head}, before=before, after=after)
        return db
    except Exception as error:
        if db is not None:
            db.close()
        # Error classification is limited to SQLite's own corruption messages,
        # or an actual failed quick_check. A migration bug is never corruption.
        malformed = isinstance(error, sqlite3.DatabaseError) and any(
            message in str(error).lower() for message in
            ('file is not a database', 'database disk image is malformed'))
        if (corrupt or malformed) and step in ('open', 'quick_check'):
            try:
                saved = quarantine(path)
                error = f'{error}; quarantined={saved}'
            except OSError as quarantine_error:
                error = f'{error}; quarantine failed: {quarantine_error}'
        refuse(store.name, old, store.head, step, error, snapshot)


def read_json_store(path, head, *, rows=None):
    """Missing is first boot; existing unreadable/newer/invalid files are fatal."""
    path = Path(path)
    old = 0
    try:
        try:
            raw = json.loads(path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            return None
        if not isinstance(raw, dict):
            raise ValueError('expected JSON object')
        old = raw.get('version', 0)
        if type(old) is not int or old < 0:
            raise ValueError('invalid storage version')
        if old > head:
            raise ValueError('newer file than this build')
        if rows is not None and not isinstance(raw.get(rows), list):
            raise ValueError(f'expected {rows} list')
        if rows is not None:
            seen = set()
            for row in raw[rows]:
                if not isinstance(row, dict):
                    raise ValueError('malformed stored row')
                if rows == 'users':
                    key = row.get('id')
                    devices = row.get('devices')
                    if devices is None and old <= 1:
                        devices = [row]
                    if not isinstance(key, str) or not key or not isinstance(devices, list) or not devices:
                        raise ValueError('malformed user row')
                    if any(not isinstance(d, dict) or not isinstance(d.get('token_sha256'), str)
                           or not d['token_sha256'] for d in devices):
                        raise ValueError('malformed device row')
                else:
                    user, rel = row.get('user_id'), row.get('rel_path')
                    if (not isinstance(user, str) or not user or not isinstance(rel, str)
                            or len(rel.split('/')) != 2 or any(p in ('', '.', '..') or p != p.strip()
                            for p in rel.split('/')) or any(c in rel for c in ('\\', '\x00', '?', '#'))):
                        raise ValueError('malformed user_track row')
                    key = (user, rel)
                if key in seen:
                    raise ValueError('duplicate stored row')
                seen.add(key)
        if path.name == 'instance.json':
            if not isinstance(raw.get('instanceId'), str) or not raw['instanceId']:
                raise ValueError('existing instance file has no usable instanceId')
        return raw
    except (OSError, ValueError, TypeError) as error:
        refuse(path.stem, old, head, 'read', error)


def backup_json(path, head):
    raw = read_json_store(path, head)
    if raw is not None and raw.get('version', 0) < head:
        backup = Path(f'{path}.v{raw.get("version", 0)}.bak')
        if not backup.exists():
            try:
                write_bytes_atomic(backup, Path(path).read_bytes(), mode=PRIVATE)
            except OSError as error:
                refuse(Path(path).stem, raw.get('version', 0), head, 'snapshot', error, backup)
        return backup
    return None


def write_json_store(path, payload, head, **kwargs):
    """Back up a migrating write, and never swallow storage write failures."""
    rows = 'users' if 'users' in payload else 'rows' if 'rows' in payload else None
    raw = read_json_store(path, head, rows=rows)
    old = raw.get('version', 0) if raw is not None else 0
    snapshot = backup_json(path, head)
    payload = {**payload, 'version': head}
    try:
        write_json_atomic(path, payload, **kwargs)
    except OSError as error:
        refuse(Path(path).stem, old, head, 'write', error, snapshot)


def validate_claim(users_path, instance_path, *, record=False):
    """An existing user file itself is evidence that this is not first boot."""
    instance = read_json_store(instance_path, 1)
    if instance is not None and (not isinstance(instance.get('instanceId'), str) or not instance['instanceId']):
        refuse('instance', instance.get('version', 0), 1, 'read', 'existing instance file has no usable instanceId')
    users = read_json_store(users_path, 3, rows='users')
    claimed = instance is not None and (isinstance(instance.get('setupDone'), bool) or instance.get('claimed'))
    if (users is not None or claimed) and not (users and users['users']):
        refuse('users', users.get('version', 0) if users else 0, 3, 'claim',
               'claimed server has missing or empty users.json')
    if record and users and users['users'] and not (instance and instance.get('claimed')):
        import uuid

        payload = instance or {'version': 1, 'instanceId': uuid.uuid4().hex}
        payload['claimed'] = True
        write_json_store(instance_path, payload, 1, mode=PRIVATE)
    return users


def check_data(directory):
    """CLI deliberately uses only infra; no server import or startup side effects."""
    from app.infra.jobs.schema import JOBS

    directory = Path(directory)
    report = {}
    db = open_store(directory / 'jobs.sqlite', JOBS, report=report)
    db.close()
    print(json.dumps(report, sort_keys=True))
    validate_claim(directory / 'users.json', directory / 'instance.json')
    for filename, head, rows in (('users.json', 3, 'users'), ('user_tracks.json', 1, 'rows'),
                                 ('instance.json', 1, None)):
        path = directory / filename
        raw = read_json_store(path, head, rows=rows)
        if raw is None:
            print(json.dumps({'store': path.stem, 'from': 0, 'to': 0, 'before': 0, 'after': 0}))
            continue
        old = raw.get('version', 0)
        before = len(raw[rows]) if rows else 1
        if old < head:
            if filename == 'users.json':
                for user in raw['users']:
                    if 'devices' not in user:
                        user['devices'] = [{key: user[key] for key in
                                           ('id', 'label', 'token_sha256', 'created_at', 'last_seen_at') if key in user}]
                        user.pop('token_sha256', None)
                        user.pop('last_seen_at', None)
            raw['version'] = head
            write_json_store(path, raw, head, mode=PRIVATE)
        print(json.dumps({'store': path.stem, 'from': old, 'to': head, 'before': before,
                          'after': len(raw[rows]) if rows else 1}))
    validate_claim(directory / 'users.json', directory / 'instance.json', record=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', required=True)
    parser.add_argument('--data', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        check_data(args.data)
    except Exception as error:
        refuse('check', 0, 0, 'check', error)


if __name__ == '__main__':
    main()
