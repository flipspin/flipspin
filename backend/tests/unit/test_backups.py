"""Recovery tests use disposable state, including committed, uncheckpointed WAL."""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.backup import main
from app.infra.backup_restore import restore
from app.infra.backups import BackupManager, DAILY_INTERVAL, FIRST_DELAY, utc_stamp, verify_snapshot
from app.infra.data_lock import DataBusy, DataLock
from app.infra.sqlite_backup import check_integrity


@pytest.fixture
def backups(config):
    return BackupManager(config)


def write_state(manager):
    for filename in ('users.json', 'user_tracks.json', 'instance.json', 'providers.json', 'lyrics.json', 'subsonic-stars.json'):
        manager.target(filename).write_text(json.dumps({'work': filename}))
    (manager.config.playlist_dir / 'mix.json').write_text('{"tracks":["song"]}')


def database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA wal_autocheckpoint=0')
    db.execute('CREATE TABLE work (value TEXT)')
    db.execute("INSERT INTO work VALUES ('committed in WAL')")
    db.commit()
    return db


def test_snapshots_all_work_and_future_sqlite_with_live_wal(backups):
    write_state(backups)
    live = [database(backups.target(n)) for n in ('jobs.sqlite', 'analysis.sqlite', 'future/library.sqlite')]
    try:
        # An uncommitted row must not leak into a snapshot.
        live[0].execute("INSERT INTO work VALUES ('uncommitted')")
        result = backups.backup_now('before-bulk-tags')
        assert result['ok'] and result['reason'] == 'before-bulk-tags'
        directory = backups.directory / result['stamp']
        manifest = verify_snapshot(directory)
        assert manifest['appVersion']
        names = {item['path'] for item in manifest['files']}
        assert names == {'users.json', 'user_tracks.json', 'instance.json', 'providers.json', 'lyrics.json',
                         'subsonic-stars.json', 'playlists/mix.json', 'jobs.sqlite', 'analysis.sqlite', 'future/library.sqlite'}
        assert result['size'] == sum(item['size'] for item in manifest['files'])
        for item in manifest['files']:
            path = directory / item['path']
            assert item['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest()
            if path.suffix == '.sqlite':
                with closing(sqlite3.connect(path)) as db:
                    assert db.execute('SELECT value FROM work').fetchall() == [('committed in WAL',)]
        if os.name != 'nt':
            assert directory.stat().st_mode & 0o077 == 0
            assert all((directory / item['path']).stat().st_mode & 0o077 == 0 for item in manifest['files'])
    finally:
        for db in live:
            db.close()


def test_excludes_media_rebuildable_state_and_backups(backups):
    excluded = ['Music', 'stems', 'models', 'tools', 'temp', 'logs', 'backups']
    for name in excluded:
        directory = backups.data / name
        directory.mkdir(exist_ok=True)
        (directory / 'ignored.sqlite').write_bytes(b'not a database')
        (directory / 'song.mp3').write_bytes(b'audio')
    (backups.data / 'random.json').write_text('{}')
    result = backups.backup_now('manual')
    assert {row['path'] for row in verify_snapshot(backups.directory / result['stamp'])['files']} <= {'instance.json'}


def test_configured_stores_and_excluded_directories_are_respected(backups, tmp_path):
    backups.config.users_file = tmp_path / 'relocated-users.json'
    backups.config.users_file.write_text('{"work":true}')
    backups.config.analysis_db = tmp_path / 'relocated.sqlite'
    with closing(database(backups.config.analysis_db)):
        backups.config.base_music_dir = backups.data / 'custom-music'
        with closing(database(backups.config.base_music_dir / 'skip.sqlite')):
            result = backups.backup_now('manual')
    manifest = verify_snapshot(backups.directory / result['stamp'])
    assert {row['path'] for row in manifest['files']} == {'users.json', 'analysis.sqlite', 'instance.json'}


@pytest.mark.parametrize('name', ['users.json', 'playlists/mix.json', 'future.sqlite'])
def test_symlinks_fail_closed(backups, tmp_path, name):
    outside = tmp_path / 'outside'
    outside.write_text('private')
    target = backups.target(name)
    target.symlink_to(outside)
    with pytest.raises(ValueError, match='[Ss]ymlink'):
        backups.backup_now('manual')
    assert backups.list_backups() == []
    assert not list(backups.directory.glob('*.pending'))


def test_corrupt_sqlite_aborts_without_publishing(backups):
    backups.target('jobs.sqlite').write_text('not SQLite')
    with pytest.raises(sqlite3.DatabaseError):
        backups.backup_now('manual')
    assert backups.list_backups() == []
    assert list(backups.directory.iterdir()) == []


def test_full_disk_does_not_publish_or_prune(backups, monkeypatch):
    first = backups.backup_now('manual')
    write_state(backups)
    monkeypatch.setattr('app.infra.backups.write_bytes_atomic', Mock(side_effect=OSError('disk full')))
    with pytest.raises(OSError, match='disk full'):
        backups.backup_now('manual')
    assert backups.list_backups() == [first]


def test_retention_seven_daily_four_weekly_and_migration_files_untouched(backups):
    end = datetime(2026, 10, 30, 12, tzinfo=UTC)
    for day in range(50):
        backups.now = lambda day=day: end - timedelta(days=49-day)
        backups.backup_now('scheduled')
    # The most recent manual snapshot replaces today's daily bucket.
    backups.now = lambda: end + timedelta(hours=1)
    latest = backups.backup_now('manual')
    sentinel = backups.directory / 'jobs.v1-migration.sqlite'
    sentinel.write_bytes(b'migration')
    failed = backups.directory / '.failed.pending'
    failed.mkdir()
    backups.prune()
    rows = backups.list_backups()
    assert len(rows) == 11
    assert rows[0] == latest
    days = [(datetime.strptime(r['stamp'], '%Y%m%dT%H%M%S.%fZ')).date() for r in rows]
    assert days[:7] == [(end - timedelta(days=n)).date() for n in range(7)]
    assert len({d.isocalendar()[:2] for d in days[7:]}) == 4
    assert sentinel.exists() and failed.exists()


def test_schedule_first_ten_minutes_then_daily_and_retries_failure(backups):
    event = Mock()
    event.wait.side_effect = [False, False, True]
    backups._stop = event
    backups.backup_now = Mock(side_effect=[OSError('disk full'), {}])
    backups._run()
    assert [call.args[0] for call in event.wait.call_args_list] == [FIRST_DELAY, DAILY_INTERVAL, DAILY_INTERVAL]
    assert FIRST_DELAY == 600 and DAILY_INTERVAL == 86400
    assert backups.backup_now.call_count == 2


def test_scheduler_start_idempotent_and_shutdown_interrupts_wait(backups):
    backups.start()
    thread = backups._thread
    backups.start()
    assert backups._thread is thread and thread.is_alive()
    backups.stop()
    assert not thread.is_alive() and backups._thread is None


def test_restore_preserves_current_files_and_removes_newer_stores_and_wal(backups):
    write_state(backups)
    with closing(database(backups.target('jobs.sqlite'))):
        saved = backups.backup_now('before-risk')
    backups.target('users.json').write_text('current people')
    (backups.config.playlist_dir / 'later.json').write_text('later playlist')
    with closing(database(backups.target('later.sqlite'))):
        pass
    backups.target('jobs.sqlite-wal').write_bytes(b'stale WAL')
    preserved = restore(backups, saved['stamp'])
    assert backups.target('users.json').read_text() == '{"work": "users.json"}'
    assert (preserved[0] / 'users.json').read_text() == 'current people'
    assert (preserved[0] / 'playlists' / 'later.json').exists()
    assert (preserved[0] / 'jobs.sqlite-wal').read_bytes() == b'stale WAL'
    assert not backups.target('jobs.sqlite-wal').exists()
    assert not backups.target('later.sqlite').exists()
    assert not (backups.config.playlist_dir / 'later.json').exists()
    check_integrity(backups.target('jobs.sqlite'))


@pytest.mark.parametrize('tamper', ['sha', 'sqlite', 'inventory', 'traversal', 'symlink', 'manifest'])
def test_restore_verifies_before_moving_any_current_state(backups, tamper):
    write_state(backups)
    with closing(database(backups.target('jobs.sqlite'))):
        saved = backups.backup_now('manual')
    directory = backups.directory / saved['stamp']
    path = directory / 'manifest.json'
    manifest = json.loads(path.read_text())
    if tamper == 'sha':
        (directory / 'users.json').write_text('damaged')
    elif tamper == 'sqlite':
        db = directory / 'jobs.sqlite'
        db.write_bytes(b'corrupt')
        item = next(row for row in manifest['files'] if row['path'] == 'jobs.sqlite')
        item.update(size=7, sha256=hashlib.sha256(db.read_bytes()).hexdigest())
    elif tamper == 'inventory':
        (directory / 'extra.json').write_text('{}')
    elif tamper == 'traversal':
        manifest['files'][0]['path'] = '../users.json'
    elif tamper == 'symlink':
        (directory / 'users.json').unlink()
        (directory / 'users.json').symlink_to(backups.target('users.json'))
    else:
        manifest['version'] = 2
    path.write_text(json.dumps(manifest))
    before = backups.target('users.json').read_bytes()
    with pytest.raises((ValueError, sqlite3.Error)):
        restore(backups, saved['stamp'])
    assert backups.target('users.json').read_bytes() == before
    assert not list(backups.data.glob('.before-restore-*'))
    assert backups.list_backups()[0]['ok'] is False


def test_restore_rolls_back_publish_failure(backups, monkeypatch):
    write_state(backups)
    saved = backups.backup_now('manual')
    backups.target('users.json').write_text('new work')
    replace = os.replace
    def fail_once(source, target):
        if Path(source).name == 'value' and Path(target).name == 'users.json':
            raise OSError('publish failed')
        return replace(source, target)
    monkeypatch.setattr('app.infra.backup_restore.os.replace', fail_once)
    with pytest.raises(OSError, match='publish failed'):
        restore(backups, saved['stamp'])
    assert backups.target('users.json').read_text() == 'new work'
    assert (backups.config.playlist_dir / 'mix.json').exists()


def test_restore_and_backup_lock_refusals(backups):
    saved = backups.backup_now('manual')
    with DataLock(backups.data / '.server.lock'), pytest.raises(DataBusy):
        restore(backups, saved['stamp'])
    with DataLock(backups.data / '.backup.lock'):
        with pytest.raises(DataBusy):
            backups.backup_now('manual')
        with pytest.raises(DataBusy):
            restore(backups, saved['stamp'])


def test_kernel_lock_cross_process_and_released_on_exit(backups):
    code = 'from pathlib import Path; from app.infra.data_lock import DataLock; import sys; DataLock(Path(sys.argv[1])).__enter__()'
    path = backups.data / '.server.lock'
    with DataLock(path):
        result = subprocess.run([sys.executable, '-c', code, str(path)], capture_output=True, text=True)
        assert result.returncode != 0 and 'DataBusy' in result.stderr
    result = subprocess.run([sys.executable, '-c', code, str(path)], capture_output=True, text=True)
    assert result.returncode == 0
    with DataLock(path):
        pass


@pytest.mark.parametrize('stamp', ['../elsewhere', '/absolute', '20261399T250000.000000Z', 'missing'])
def test_invalid_restore_stamp(backups, stamp):
    with pytest.raises(ValueError):
        restore(backups, stamp)


def test_restore_cli_success_and_failure(backups, capsys):
    saved = backups.backup_now('manual')
    assert main(['restore', saved['stamp'], '--data', str(backups.data)]) == 0
    assert 'Previous state preserved' in capsys.readouterr().out
    with DataLock(backups.data / '.server.lock'):
        assert main(['restore', saved['stamp'], '--data', str(backups.data)]) == 1
    assert 'stop the server' in capsys.readouterr().err


def test_prune_failure_still_reports_completed_backup(backups, monkeypatch):
    monkeypatch.setattr(backups, 'prune', Mock(side_effect=OSError('read-only directory')))
    assert backups.backup_now('manual')['ok']


@pytest.mark.parametrize('reason', ['', ' ', 'x' * 201, None])
def test_reason_required(backups, reason):
    with pytest.raises(ValueError):
        backups.backup_now(reason)


def test_stamp_is_utc():
    assert utc_stamp(datetime(2026, 1, 1, tzinfo=UTC)) == '20260101T000000.000000Z'


@pytest.mark.parametrize('payload', ['[]', 'null', '{}', '{invalid'])
def test_malformed_manifests_are_failed_entries_not_listing_errors(backups, payload):
    saved = backups.backup_now('manual')
    (backups.directory / saved['stamp'] / 'manifest.json').write_text(payload)
    assert backups.list_backups() == [{'stamp': saved['stamp'], 'size': 0, 'reason': '', 'ok': False}]
    assert backups.latest() is None


def test_backup_timeout_never_publishes_partial_state(backups, monkeypatch):
    from app.infra import sqlite_backup
    with closing(database(backups.target('jobs.sqlite'))):
        times = iter([0, 121])
        monkeypatch.setattr(sqlite_backup, 'monotonic', lambda: next(times))
        with pytest.raises(TimeoutError):
            backups.backup_now('before-risk')
    assert backups.list_backups() == []


def test_configured_sqlite_inside_data_is_not_snapshotted_twice(backups):
    backups.config.jobs_file = backups.data / 'stores' / 'custom.sqlite'
    with closing(database(backups.config.jobs_file)):
        saved = backups.backup_now('manual')
    manifest = verify_snapshot(backups.directory / saved['stamp'])
    assert [row['path'] for row in manifest['files'] if row['path'].endswith('.sqlite')] == ['jobs.sqlite']
    restore(backups, saved['stamp'])
    check_integrity(backups.config.jobs_file)


def test_restore_empty_snapshot_also_moves_stray_sqlite_sidecars(backups):
    saved = backups.backup_now('manual')
    sidecar = Path(str(backups.config.jobs_file) + '-wal')
    sidecar.write_bytes(b'old state')
    preserved = restore(backups, saved['stamp'])
    assert not sidecar.exists()
    assert (preserved[0] / 'jobs.sqlite-wal').read_bytes() == b'old state'


def test_cli_refusal_does_not_initialize_or_migrate_stores(tmp_path, capsys):
    directory = tmp_path / 'fresh'
    assert main(['restore', '20260101T000000.000000Z', '--data', str(directory)]) == 1
    assert 'Restore refused' in capsys.readouterr().err
    assert {p.name for p in directory.iterdir()} == {'.server.lock', '.backup.lock'}


def test_cli_default_paths_follow_environment(backups, monkeypatch, capsys):
    from app.config import REQUIRED_DIRS, STATE_PATHS
    saved = backups.backup_now('manual')
    for field, (var, name) in {**REQUIRED_DIRS, **STATE_PATHS}.items():
        monkeypatch.setenv(var, str(getattr(backups.config, field, backups.data / name)))
    assert main(['restore', saved['stamp']]) == 0
    assert 'Backup restored' in capsys.readouterr().out


def test_health_verifies_only_the_newest_valid_backup(backups, monkeypatch):
    backups.now = lambda: datetime(2026, 1, 1, tzinfo=UTC)
    older = backups.backup_now('scheduled')
    backups.now = lambda: datetime(2026, 1, 2, tzinfo=UTC)
    newest = backups.backup_now('manual')
    describe = Mock(wraps=backups.describe)
    monkeypatch.setattr(backups, 'describe', describe)
    assert backups.latest() == newest
    assert describe.call_count == 1
    (backups.directory / newest['stamp'] / 'manifest.json').write_text('broken')
    describe.reset_mock()
    assert backups.latest() == older
    assert describe.call_count == 2


def test_final_verification_failure_aborts_risky_call_and_keeps_older_backup(backups, monkeypatch):
    from app.infra.backups import write_json_atomic
    older = backups.backup_now('scheduled')
    write_state(backups)
    def corrupt_after_write(path, payload, **kwargs):
        write_json_atomic(path, payload, **kwargs)
        (path.parent / 'users.json').write_text('disk corruption')
    monkeypatch.setattr('app.infra.backups.write_json_atomic', corrupt_after_write)
    with pytest.raises(ValueError, match='verification failed'):
        backups.backup_now('before-risk')
    entries = backups.list_backups()
    assert entries[0]['ok'] is False
    assert older in entries
