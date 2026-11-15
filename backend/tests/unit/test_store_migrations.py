"""Replay release stores and prove failure modes keep recoverable data."""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path

import pytest

from app.domains.accounts.identity import TokenStore
from app.infra import files, instance, migrations
from app.infra.jobs.schema import JOBS
from app.infra.migrations import (
    EXIT_CONFIG, SQLiteStore, StoreRefusal, check_data, open_store, row_counts, validate_claim,
)

FIXTURES = Path(__file__).parents[1] / 'fixtures' / 'stores'


def schema(db):
    """Compare columns, FK targets, index definitions and normalized DDL."""
    import re

    return sorted((kind, name, re.sub(r'\s+', '', sql or '').replace('IFNOTEXISTS', '').replace('"', ''))
                  for kind, name, sql in db.execute(
                      "SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"))


@pytest.mark.parametrize('label', ['today', 'pre-77b11d5'])
def test_release_replay_matches_fresh_and_is_idempotent(tmp_path, label):
    target = tmp_path / label
    shutil.copytree(FIXTURES / label, target)
    original = sqlite3.connect(target / 'jobs.sqlite')
    before = row_counts(original)
    rows = {table: original.execute(f'SELECT * FROM "{table}"').fetchall() for table in before}
    assert all(before.values())  # every historical table has synthetic rows
    original.close()
    fresh = open_store(tmp_path / 'fresh' / 'jobs.sqlite', JOBS)
    report = {}
    db = open_store(target / 'jobs.sqlite', JOBS, report=report)
    assert schema(db) == schema(fresh)
    assert db.execute('PRAGMA user_version').fetchone()[0] == JOBS.head
    assert db.execute('PRAGMA application_id').fetchone()[0] == JOBS.application_id
    assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    for table, count in before.items():
        assert row_counts(db)[table] == count
        # Additive columns may extend tuples; original fields must all survive.
        assert [tuple(r)[:len(rows[table][0])] for r in db.execute(f'SELECT * FROM "{table}"')] == rows[table]
    expected = schema(db), row_counts(db)
    db.close()
    fresh.close()
    snapshots = list((target / 'backups').glob('*.sqlite')) if (target / 'backups').exists() else []
    if label == 'today':
        assert report['from'] == 6
        assert len(snapshots) == 1  # add match without rewriting old import rows
    else:
        assert report['from'] == 2
        assert len(snapshots) == 1
        saved = sqlite3.connect(snapshots[0])
        assert row_counts(saved) == before
        assert "'upload'" not in saved.execute("SELECT sql FROM sqlite_schema WHERE name='jobs'").fetchone()[0]
        saved.close()
    check_data(target)
    bytes_before = {p.name: p.read_bytes() for p in target.glob('*.json')}
    db = open_store(target / 'jobs.sqlite', JOBS)
    assert (schema(db), row_counts(db)) == expected
    db.close()
    check_data(target)
    assert bytes_before == {p.name: p.read_bytes() for p in target.glob('*.json')}
    if snapshots:
        assert list((target / 'backups').glob('*.sqlite')) == snapshots
    else:
        assert not (target / 'backups').exists()


def test_every_step_tolerates_reapplication(tmp_path):
    db = open_store(tmp_path / 'jobs.sqlite', JOBS)
    before = schema(db), row_counts(db)
    for number, step in enumerate(JOBS.steps, 1):
        db.execute('PRAGMA foreign_keys=OFF')
        db.execute('BEGIN IMMEDIATE')
        step(db)
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
        db.commit()
        assert (schema(db), row_counts(db)) == before, number
    db.close()


def test_upload_followups_backfill_existing_manifest_and_survive_reopen(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    previous = replace(JOBS, steps=JOBS.steps[:11])
    db = open_store(path, previous)
    with db:
        db.execute("INSERT INTO upload_batches VALUES('batch','owner','{}','subiendo','keep-both',1000)")
        for idx in range(40):
            db.execute('INSERT INTO upload_members VALUES(?,?,?,?)', ('batch', str(idx), str(idx), idx))
    db.close()
    db = open_store(path, JOBS)
    row = db.execute('SELECT * FROM upload_followups').fetchone()
    assert tuple(row) == ('batch', 40, None, 0)
    assert db.execute('SELECT * FROM upload_completions').fetchall() == []
    with db:
        db.execute("INSERT INTO upload_completions VALUES('batch','Uploads/song.wav')")
        db.execute('UPDATE upload_followups SET refresh_pending=1,refreshed_at=1100')
    db.close()
    db = open_store(path, JOBS)
    assert tuple(db.execute('SELECT * FROM upload_followups').fetchone()) == ('batch', 40, 1100, 1)
    assert tuple(db.execute('SELECT * FROM upload_completions').fetchone()) == ('batch', 'Uploads/song.wav')
    db.close()


def test_failed_step_rolls_back_and_keeps_snapshot_forever(tmp_path, caplog):
    path = tmp_path / 'jobs.sqlite'
    db = open_store(path, JOBS)
    db.execute("INSERT INTO queue_migrations VALUES('keep')")
    db.commit()
    db.close()

    def broken(db):
        db.execute("DELETE FROM queue_migrations")
        db.execute('CREATE TABLE never_committed(id)')
        raise RuntimeError('synthetic failure\nsecond line')

    failing = replace(JOBS, steps=(*JOBS.steps, broken))
    with pytest.raises(StoreRefusal) as error:
        open_store(path, failing)
    assert error.value.code == EXIT_CONFIG == 78
    messages = [r.message for r in caplog.records if 'refused-to-start' in r.message]
    assert len(messages) == 1
    assert f'from=v{JOBS.head} to=v{JOBS.head+1} step={JOBS.head+1}' in messages[0]
    assert '\n' not in messages[0]
    failed = list((tmp_path / 'backups').glob('*.sqlite.failed'))
    assert len(failed) == 1
    protected = Path(str(failed[0]).removesuffix('.failed'))
    assert f'snapshot={protected}' in messages[0]
    saved = sqlite3.connect(protected)
    assert saved.execute('SELECT path FROM queue_migrations').fetchone()[0] == 'keep'
    saved.close()
    db = sqlite3.connect(path)
    assert db.execute('PRAGMA user_version').fetchone()[0] == JOBS.head
    assert db.execute('SELECT path FROM queue_migrations').fetchone()[0] == 'keep'
    assert not db.execute("SELECT name FROM sqlite_schema WHERE name='never_committed'").fetchall()
    db.close()
    # Later successful upgrades retain only their last three, never the failed run's.
    for number in range(7, 12):
        store = replace(JOBS, steps=(*JOBS.steps, *(lambda db: None for _ in range(number - 6))))
        open_store(path, store).close()
    assert protected.exists() and failed[0].exists()
    assert len(list((tmp_path / 'backups').glob('*.sqlite'))) == 4
    assert not list(tmp_path.glob('*.broken-*'))


def test_held_lock_waits_then_refuses_without_moving_anything(tmp_path, monkeypatch, caplog):
    path = tmp_path / 'jobs.sqlite'
    db = open_store(path, JOBS)
    db.execute("INSERT INTO queue_migrations VALUES('keep')")
    db.commit()
    db.execute('BEGIN IMMEDIATE')
    monkeypatch.setattr(migrations, 'BUSY_TIMEOUT_MS', 100)
    inode = path.stat().st_ino
    start = time.monotonic()
    with pytest.raises(StoreRefusal) as error:
        open_store(path, JOBS)
    assert time.monotonic() - start >= .09
    assert error.value.code == 78
    assert path.stat().st_ino == inode
    assert not list(tmp_path.glob('*.broken-*'))
    assert 'locked' in caplog.text
    db.rollback()
    assert db.execute('SELECT path FROM queue_migrations').fetchone()[0] == 'keep'
    db.close()


@pytest.mark.parametrize('label', ['today', 'pre-77b11d5'])
def test_newer_sqlite_is_untouched(tmp_path, label):
    path = tmp_path / 'jobs.sqlite'
    shutil.copy2(FIXTURES / label / 'jobs.sqlite', path)
    db = sqlite3.connect(path)
    db.execute(f'PRAGMA user_version={JOBS.head + 1}')
    db.close()
    before = path.read_bytes()
    with pytest.raises(StoreRefusal):
        open_store(path, JOBS)
    assert path.read_bytes() == before
    assert not (tmp_path / 'backups').exists()
    assert not list(tmp_path.glob('*.broken-*'))


def test_malformed_sqlite_and_sidecars_quarantined_without_overwrite(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    for _ in range(2):
        path.write_bytes(b'not a database at all')
        Path(str(path) + '-wal').write_bytes(b'wal evidence')
        Path(str(path) + '-shm').write_bytes(b'shm evidence')
        with pytest.raises(StoreRefusal) as error:
            open_store(path, JOBS)
        assert error.value.code == 78
        assert not path.exists()
    copies = [p for p in tmp_path.glob('*.broken-*') if not p.name.endswith(('-wal', '-shm'))]
    assert len(copies) == 2
    for copy in copies:
        assert copy.read_bytes() == b'not a database at all'
        assert Path(str(copy) + '-wal').read_bytes() == b'wal evidence'
        assert Path(str(copy) + '-shm').exists()  # SQLite may rebuild this transient index


def test_failed_quick_check_quarantines(tmp_path, monkeypatch):
    path = tmp_path / 'jobs.sqlite'
    open_store(path, JOBS).close()
    original = sqlite3.connect

    class Damaged(sqlite3.Connection):
        def execute(self, sql, *args):
            if sql == 'PRAGMA quick_check':
                return iter([('*** in database main ***',)])
            return super().execute(sql, *args)

    monkeypatch.setattr(migrations.sqlite3, 'connect', lambda *a, **k: original(*a, **k, factory=Damaged))
    with pytest.raises(StoreRefusal):
        open_store(path, JOBS)
    assert not path.exists()
    assert list(tmp_path.glob('jobs.sqlite.broken-*'))


@pytest.mark.parametrize('contents', ['{broken', '', '{"version":3,"users":[]}'])
def test_claimed_users_corrupt_or_empty_keeps_claim_closed(tmp_path, contents):
    shutil.copytree(FIXTURES / 'today', tmp_path, dirs_exist_ok=True)
    path = tmp_path / 'users.json'
    path.write_text(contents)
    store = TokenStore(path)
    with pytest.raises(StoreRefusal) as error:
        store.has_users()
    assert error.value.code == 78
    assert path.read_text() == contents
    with pytest.raises(StoreRefusal):
        store.claim_first_owner('intruder')


def test_missing_users_after_legacy_claim_cannot_reopen_window(tmp_path):
    shutil.copytree(FIXTURES / 'today', tmp_path, dirs_exist_ok=True)
    identity = json.loads((tmp_path / 'instance.json').read_text())
    identity.pop('setupDone')  # legacy household before setup wizard
    (tmp_path / 'instance.json').write_text(json.dumps(identity))
    validate_claim(tmp_path / 'users.json', tmp_path / 'instance.json', record=True)
    assert json.loads((tmp_path / 'instance.json').read_text())['claimed'] is True
    (tmp_path / 'users.json').unlink()
    with pytest.raises(StoreRefusal):
        TokenStore(tmp_path / 'users.json').has_users()


@pytest.mark.parametrize('filename,head,rows', [('users.json', 3, 'users'), ('user_tracks.json', 1, 'rows'),
                                               ('instance.json', 1, None)])
def test_json_ceiling_and_invalid_versions_keep_bytes(tmp_path, filename, head, rows):
    path = tmp_path / filename
    for version in (head + 1, '1', -1, True):
        payload = {'version': version, **({rows: []} if rows else {'instanceId': 'keep'})}
        path.write_text(json.dumps(payload))
        before = path.read_bytes()
        with pytest.raises(StoreRefusal):
            migrations.read_json_store(path, head, rows=rows)
        assert path.read_bytes() == before


@pytest.mark.parametrize('version', [1, 2])
def test_json_migrating_save_backs_up_original_once(tmp_path, version):
    path = tmp_path / 'users.json'
    shutil.copy2(FIXTURES.parent / f'users_v{version}.json', path)
    before = path.read_bytes()
    store = TokenStore(path)
    users = store.list_users()
    assert users
    store._save({u.user_id: u for u in users})
    backup = Path(f'{path}.v{version}.bak')
    assert backup.read_bytes() == before
    assert json.loads(path.read_text())['version'] == 3
    store._save({u.user_id: u for u in users})
    assert backup.read_bytes() == before


def test_atomic_writer_syncs_file_before_replace_then_directory(tmp_path, monkeypatch):
    events = []
    replace_file, sync = os.replace, os.fsync
    monkeypatch.setattr(files.os, 'replace', lambda *a: (events.append('replace'), replace_file(*a))[-1])
    monkeypatch.setattr(files.os, 'fsync', lambda fd: (events.append('fsync'), sync(fd))[-1])
    files.write_bytes_atomic(tmp_path / 'state.json', b'keep')
    assert events == ['fsync', 'replace', 'fsync']


def test_cli_copy_replay_reports_counts_and_exit_status(tmp_path):
    shutil.copytree(FIXTURES / 'pre-77b11d5', tmp_path, dirs_exist_ok=True)
    command = [sys.executable, '-m', 'app.infra.migrations', '--check', '--data', str(tmp_path)]
    result = subprocess.run(command, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    reports = [json.loads(line) for line in result.stdout.splitlines()]
    assert {r['store'] for r in reports} == {'jobs', 'users', 'user_tracks', 'instance'}
    jobs = reports[0]
    assert all(jobs['after'][table] >= count for table, count in jobs['before'].items())
    (tmp_path / 'users.json').write_text('{broken')
    result = subprocess.run(command, text=True, capture_output=True)
    assert result.returncode == 78
    assert result.stderr.count('action=refused-to-start') == 1
    assert 'Traceback' not in result.stderr


def test_count_loss_is_a_refusal_and_preserves_snapshot(tmp_path):
    path = tmp_path / 'test.sqlite'
    def create(db):
        db.execute('CREATE TABLE entries(id)')
        db.execute('INSERT INTO entries VALUES(1)')
    store = SQLiteStore('test', (create,))
    open_store(path, store).close()
    dropping = replace(store, steps=(*store.steps, lambda db: db.execute('DELETE FROM entries')))
    with pytest.raises(StoreRefusal):
        open_store(path, dropping)
    failed = list((tmp_path / 'backups').glob('*.failed'))
    assert len(failed) == 1
    saved = sqlite3.connect(str(failed[0]).removesuffix('.failed'))
    assert saved.execute('SELECT count(*) FROM entries').fetchone()[0] == 1
    saved.close()


def test_instance_corruption_never_regenerates_identity(tmp_path):
    path = tmp_path / 'instance.json'
    path.write_text('{invalid')
    with pytest.raises(StoreRefusal):
        instance.read_or_create_instance_id(path)
    assert path.read_text() == '{invalid'


def test_configured_instance_path_keeps_claim_closed(tmp_path):
    user_path = tmp_path / 'accounts' / 'users.json'
    identity_path = tmp_path / 'elsewhere' / 'identity.json'
    instance.read_or_create_instance_id(identity_path)
    store = TokenStore(user_path, instance_path=identity_path)
    store.mint('Synthetic Owner', 'owner')
    assert json.loads(identity_path.read_text())['claimed'] is True
    user_path.unlink()
    with pytest.raises(StoreRefusal):
        TokenStore(user_path, instance_path=identity_path).has_users()


def test_unknown_legacy_columns_refuse_without_stamping_or_moving(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    db = sqlite3.connect(path)
    db.execute('CREATE TABLE jobs(id TEXT PRIMARY KEY, important_payload TEXT)')
    db.execute("INSERT INTO jobs VALUES('keep','payload')")
    db.commit()
    db.close()
    before = path.read_bytes()
    with pytest.raises(StoreRefusal):
        open_store(path, JOBS)
    assert path.read_bytes() == before
    assert not list(tmp_path.glob('*.broken-*'))


@pytest.mark.parametrize('case', ['users-corrupt', 'users-missing', 'users-empty', 'instance-corrupt', 'jobs-newer'])
def test_real_server_entrypoint_exits_78_before_claim_window(tmp_path, case):
    from app.config import REQUIRED_DIRS, STATE_PATHS

    data = tmp_path / 'data'
    shutil.copytree(FIXTURES / 'today', data)
    if case == 'users-corrupt':
        (data / 'users.json').write_text('{broken')
    elif case == 'users-missing':
        (data / 'users.json').unlink()
    elif case == 'users-empty':
        (data / 'users.json').write_text('{"version":3,"users":[]}')
    elif case == 'instance-corrupt':
        (data / 'instance.json').write_text('{broken')
    elif case == 'jobs-newer':
        db = sqlite3.connect(data / 'jobs.sqlite')
        db.execute(f'PRAGMA user_version={JOBS.head+1}')
        db.close()
    before = {p.name: p.read_bytes() for p in data.glob('*.json')}
    env = {key: value for key, value in os.environ.items() if not key.startswith('KROBI_')}
    env['HOME'] = str(tmp_path)
    env['KROBI_ADVERTISE'] = 'false'
    for variable, name in [*REQUIRED_DIRS.values(), *STATE_PATHS.values()]:
        env[variable] = str(data / name)
    result = subprocess.run([sys.executable, '-m', 'app'], env=env, text=True, capture_output=True, timeout=30)
    assert result.returncode == 78, result.stderr
    assert result.stderr.count('action=refused-to-start') == 1
    assert 'FIRST RUN' not in result.stderr
    assert 'Traceback' not in result.stderr
    for filename, contents in before.items():
        if filename != 'instance.json':  # valid instance may record the existing secret-key fingerprint
            assert (data / filename).read_bytes() == contents
    if case == 'instance-corrupt':
        assert (data / 'instance.json').read_text() == '{broken'


def test_constraint_failure_keeps_readable_database_and_snapshot(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    open_store(path, JOBS).close()
    def invalid(db):
        db.execute("INSERT INTO queue_receipts VALUES(NULL,NULL,NULL)")
    with pytest.raises(StoreRefusal):
        open_store(path, replace(JOBS, steps=(*JOBS.steps, invalid)))
    assert path.exists()
    assert not list(tmp_path.glob('*.broken-*'))
    assert list((tmp_path / 'backups').glob('*.failed'))


def test_rebuild_preserves_views_indexes_and_triggers(tmp_path):
    shutil.copy2(FIXTURES / 'pre-77b11d5' / 'jobs.sqlite', tmp_path / 'jobs.sqlite')
    db = sqlite3.connect(tmp_path / 'jobs.sqlite')
    db.executescript('''CREATE INDEX custom_label ON jobs(label);
        CREATE VIEW custom_jobs AS SELECT id,label FROM jobs;
        CREATE TRIGGER custom_label_limit BEFORE UPDATE OF label ON jobs
        WHEN NEW.label = 'forbidden' BEGIN SELECT RAISE(ABORT,'custom rule'); END;''')
    db.close()
    db = open_store(tmp_path / 'jobs.sqlite', JOBS)
    assert db.execute('SELECT id FROM custom_jobs').fetchone()[0] == 'fixture-job'
    assert db.execute("SELECT name FROM sqlite_schema WHERE name='custom_label'").fetchone()
    with pytest.raises(sqlite3.IntegrityError, match='custom rule'):
        db.execute("UPDATE jobs SET label='forbidden'")
    db.rollback()
    db.close()


def test_unknown_job_column_is_never_lost_in_rebuild(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    shutil.copy2(FIXTURES / 'pre-77b11d5' / 'jobs.sqlite', path)
    db = sqlite3.connect(path)
    db.execute('ALTER TABLE jobs ADD COLUMN unknown_valuable_data TEXT')
    db.execute("UPDATE jobs SET unknown_valuable_data='keep this'")
    db.commit()
    db.close()
    with pytest.raises(StoreRefusal):
        open_store(path, JOBS)
    db = sqlite3.connect(path)
    assert db.execute('SELECT unknown_valuable_data FROM jobs').fetchone()[0] == 'keep this'
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    db.close()
    assert not list(tmp_path.glob('*.broken-*'))


def test_match_kind_upgrade_keeps_existing_imports_and_items(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    previous = replace(JOBS, steps=JOBS.steps[:6], rebuild_steps=frozenset({3}))
    db = open_store(path, previous)
    db.execute("INSERT INTO jobs(id,kind,label,state,attempt,total,created_at) VALUES('old','import','Collection','queued',1,1,0)")
    db.execute("INSERT INTO items(job_id,idx,attempt,item,state) VALUES('old',0,1,'Track','queued')")
    db.commit()
    db.close()
    db = open_store(path, JOBS)
    assert db.execute("SELECT kind FROM jobs WHERE id='old'").fetchone()[0] == 'import'
    assert db.execute("SELECT item FROM items WHERE job_id='old'").fetchone()[0] == 'Track'
    db.execute("INSERT INTO jobs(id,kind,label,state,attempt,total,created_at) VALUES('new','match','Collection','queued',1,0,0)")
    db.commit()
    assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    db.close()
