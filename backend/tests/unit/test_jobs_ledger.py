"""Crash recovery, fencing, replay and retention of the durable jobs record."""
from concurrent.futures import ThreadPoolExecutor
import threading
import pytest
from app.infra.jobs import Jobs, JobConflict
from app.infra.migrations import StoreRefusal
from app.domains.accounts.identity import Principal


def items(n=3):
    return [{'item': f'Song {i}', 'detail': {'_retry': {'producer': 'download', 'value': i}}} for i in range(n)]


def test_wal_full_and_corrupt_quarantine(tmp_path, caplog):
    path = tmp_path / 'jobs.sqlite'
    path.write_bytes(b'not sqlite')
    with pytest.raises(StoreRefusal) as error:
        Jobs(path)
    assert error.value.code == 78
    assert list(tmp_path.glob('jobs.sqlite.broken-*'))
    assert 'refused-to-start' in caplog.text
    assert 'ledger-reset' not in caplog.text
    ledger = Jobs(path)
    assert ledger.list() == []
    assert ledger.db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    assert ledger.db.execute('PRAGMA synchronous').fetchone()[0] == 2
    ledger.close()


def test_crash_sweep_every_state(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    first = Jobs(path, now=lambda: 100)
    ids = {}
    for state in ('interrupted','queued','succeeded','partial','failed','cancelled','running'):
        job = first.start('download', state, items(), 'starter')
        ids[state] = job
        if state == 'queued':
            continue
        first.running(job, 1)
        if state == 'running':
            first.item_transition(job, 0, 1, 'done')
            first.item_transition(job, 1, 1, 'running')
        elif state == 'cancelled':
            first.cancel(job, 1)
        elif state == 'interrupted':
            first.boot()
        else:
            for i in range(3):
                first.item_transition(job, i, 1, 'done' if state == 'succeeded' or (state == 'partial' and i == 0) else 'failed')
            first.finish(job, 1)
    first.close()  # no shutdown sweep
    second = Jobs(path, now=lambda: 150)
    queued = second.boot()
    assert [j['id'] for j in queued] == [ids['queued']]
    assert second.get(ids['running'])['state'] == 'interrupted'
    assert second.get(ids['running'])['ended_at'] == 150
    assert [i['state'] for i in second.items(ids['running'])] == ['done','interrupted','interrupted']
    for state in ('succeeded','partial','failed','cancelled','interrupted'):
        assert second.get(ids[state])['state'] == state
    version = second.version
    second.boot()
    assert second.version == version
    assert not second.item_transition(ids['running'], 1, 1, 'done')
    second.close()


def test_cancel_complete_race_250_times(tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    with ThreadPoolExecutor(2) as pool:
        for _ in range(250):
            job = ledger.start('download', 'Race', items(1))
            ledger.running(job, 1)
            ledger.item_transition(job, 0, 1, 'done')
            barrier = threading.Barrier(2)
            def cancel(barrier=barrier, job=job):
                barrier.wait()
                try:
                    ledger.cancel(job, 1)
                    return True
                except JobConflict:
                    return False
            def complete(barrier=barrier, job=job):
                barrier.wait()
                return ledger.finish(job, 1)
            a, b = pool.submit(cancel), pool.submit(complete)
            assert sum((a.result(), b.result())) == 1
            assert ledger.get(job)['state'] in ('succeeded','cancelled')
            assert ledger.get(job)['ended_at'] is not None
            assert all(i['state'] not in ('queued','running') for i in ledger.items(job))
            with pytest.raises(JobConflict, match='not-cancellable'):
                ledger.cancel(job, 1)
    queued = ledger.start('download', 'Cancel twice', items(1))
    ledger.cancel(queued, 1)
    with pytest.raises(JobConflict):
        ledger.cancel(queued, 1)
    ledger.close()


def test_retry_subset_double_click_and_attempt_fence(tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    job = ledger.start('download', 'Four', items(4), Principal('member', 'Member'))
    ledger.running(job, 1)
    for idx, state in enumerate(('done','failed','skipped','interrupted')):
        ledger.item_transition(job, idx, 1, state)
    ledger.finish(job, 1)
    assert ledger.get(job)['state'] == 'partial'
    assert ledger.retry(job, 1) == (2, True)
    assert ledger.retry(job, 1) == (2, False)
    assert [i['idx'] for i in ledger.items(job) if i['attempt'] == 2] == [1,2,3]
    assert ledger.get(job)['starter_user_id'] == 'member'
    assert ledger.get(job)['succeeded'] == 1
    assert not ledger.finish(job, 1)
    assert not ledger.item_transition(job, 1, 1, 'done')
    for attempt in range(2, 21):
        ledger.running(job, attempt)
        ledger.finish(job, attempt, error=True)
        if attempt < 20:
            ledger.retry(job, attempt)
    assert not ledger.retryable(job)
    with pytest.raises(JobConflict, match='not-retryable'):
        ledger.retry(job, 20)
    assert ledger.db.execute('SELECT count(*) FROM items WHERE job_id=? AND idx=0', (job,)).fetchone()[0] == 1
    ledger.close()


def test_unreported_handler_cannot_succeed_and_terminal_invariant(tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    job = ledger.start('import', 'Raises', items(2))
    ledger.running(job, 1)
    ledger.outcome(job, 'Song 0', success=True)
    ledger.finish(job, 1, error=True)
    assert ledger.get(job)['state'] == 'partial'
    assert [i['state'] for i in ledger.items(job)] == ['done','failed']
    other = ledger.start('import', 'All raise', [], total=3)
    ledger.finish(other, 1, error=True)
    assert ledger.get(other)['state'] == 'failed'
    assert len(ledger.items(other)) == 3
    assert all(i['state'] == 'failed' for i in ledger.items(other))
    ledger.close()


def test_retention_fake_clock(tmp_path):
    clock = [100.0]
    ledger = Jobs(tmp_path / 'jobs.sqlite', now=lambda: clock[0])
    success = ledger.start('download', 'Success', items(1), 'one')
    ledger.item_transition(success, 0, 1, 'done')
    ledger.finish(success, 1)
    failed = ledger.start('download', 'Failed', items(1), 'two')
    ledger.finish(failed, 1)
    clock[0] += 299
    assert len(ledger.list()) == 2
    clock[0] += 1
    assert len(ledger.list()) == 2  # Reads leave retention to the timer.
    ledger.retention()
    assert [j['id'] for j in ledger.list()] == [failed]
    assert ledger.get(success)['cleared_at'] == 400
    clock[0] += 86400
    assert [j['id'] for j in ledger.list()] == [failed]
    assert ledger.clear('one') == 0
    assert ledger.clear('two') == 1
    clock[0] += 30*86400
    ledger.retention()
    assert ledger.get(failed) is None
    assert ledger.get(success) is None
    for i in range(510):
        job = ledger.start('download', str(i), items(1))
        ledger.finish(job, 1)
        clock[0] += 1
    ledger.retention()
    assert len(ledger.list()) == 500
    assert ledger.list()[-1]['label'] == '10'
    ledger.close()


def test_transition_versions_and_coalesced_phases(tmp_path):
    clock = [0.0]
    ledger = Jobs(tmp_path / 'jobs.sqlite', now=lambda: clock[0])
    version = ledger.version
    job = ledger.start('stems', 'Title', items(1))
    assert ledger.version > version
    for change in (lambda: ledger.running(job, 1), lambda: ledger.item_transition(job, 0, 1, 'running'),
                   lambda: ledger.item_transition(job, 0, 1, 'done'), lambda: ledger.finish(job, 1)):
        version = ledger.version
        change()
        assert ledger.version > version
    ledger.phase_changed()
    version = ledger.version
    clock[0] = .5
    ledger.phase_changed()
    assert ledger.version == version
    clock[0] = 1
    assert ledger.version == version + 1
    assert ledger.version == version + 1
    ledger.close()


def test_legacy_poll_cleanup_keeps_live_durable_jobs(tmp_path):
    from app.infra.progress import ProgressTracker
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    tracker = ProgressTracker(ledger)
    tracker.create_progress('long-running', 1, items=['Song'])
    tracker.set_status('long-running', 'in_progress')
    with tracker._cond:
        tracker._progress['long-running'].created_at = 0
    assert tracker.cleanup_old_progress() == 0
    tracker.update_progress('long-running', 'Song')
    tracker.complete_progress('long-running', succeeded=1, failed=0)
    assert ledger.get('long-running')['state'] == 'succeeded'
    assert tracker.cleanup_old_progress() == 1
    ledger.close()


def test_kind_migration_runs_again_on_an_already_rebuilt_table(tmp_path, caplog):
    """Repeat kind migration after SQLite quotes the rebuilt jobs table name.

    Every existing row must survive the second rebuild.
    """
    import sqlite3
    from datetime import UTC, datetime
    from types import SimpleNamespace
    from app.domains.user_library.plays import record_batch
    from app.domains.user_library.store import UserTrackStore
    from app.infra.idempotency import Receipts
    path = tmp_path / 'jobs.sqlite'
    ledger = Jobs(path)
    job = ledger.start('download', 'Before', items(2))
    ledger.close()
    tracks = UserTrackStore(tmp_path / 'user_tracks.json')
    tracks.add_many('member', ['Album/song.mp3'])
    play = SimpleNamespace(trackKey='Album/song.mp3', listenedAt=datetime(2001, 1, 1, tzinfo=UTC), clientPlayId='offline-play')
    assert record_batch(path, tracks, 'member', [play]) == {'accepted': 1}
    receipts = Receipts(path)
    assert receipts.begin('offline-key', 'member', '/route', {'x': 1}) is None
    receipts.finish('offline-key', 'member', '/route', 200, {'ok': True})
    db = sqlite3.connect(path)
    sql = db.execute("SELECT sql FROM sqlite_master WHERE name='jobs'").fetchone()[0]
    import re
    older = re.sub(r'^\s*CREATE\s+TABLE\s+["`\[]?jobs["`\]]?', 'CREATE TABLE jobs_old', sql.replace(",'upload'", ''), count=1)
    assert "'upload'" not in older
    db.execute('PRAGMA foreign_keys=OFF')
    db.execute(older)
    db.execute('INSERT INTO jobs_old SELECT * FROM jobs')
    db.execute('DROP TABLE jobs')
    db.execute('ALTER TABLE jobs_old RENAME TO jobs')
    db.execute('PRAGMA user_version=0')  # historical files were unversioned
    db.commit()
    assert db.execute("SELECT sql FROM sqlite_master WHERE name='jobs'").fetchone()[0].startswith('CREATE TABLE "jobs"')
    db.close()
    ledger = Jobs(path)
    assert 'jobs-ledger-reset' not in caplog.text
    assert not list(tmp_path.glob('jobs.sqlite.broken-*'))
    assert "'upload'" in ledger.db.execute("SELECT sql FROM sqlite_master WHERE name='jobs'").fetchone()[0]
    assert [j['id'] for j in ledger.list()] == [job]
    assert len(ledger.items(job)) == 2
    ledger.close()
    assert receipts.begin('offline-key', 'member', '/route', {'x': 1}) == (200, {'ok': True})
    assert record_batch(path, tracks, 'member', [play]) == {'accepted': 0}
    assert tracks.get('member', 'Album/song.mp3').play_count == 1


def test_legacy_download_listing_holds_only_download_kinds(tmp_path):
    """Phones draw every /api/downloads/active row as a download."""
    from app.infra.jobs_runtime import legacy_states
    from app.infra.progress import ProgressTracker
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    tracker = ProgressTracker(ledger)
    tracker.create_progress('song', 1, items=['Song'])
    ledger.start('acquisition-request', 'Album', ['A'], job_id='album')
    ledger.start('analysis', 'Biblioteca', ['A', 'B'], job_id='analysis')
    tracker.create_progress('lyrics', 1, kind='lyrics-helper', items=['Song'])
    ledger.start('stems', 'Song', ['Song'], job_id='stems')

    assert {s.progress_id for s in legacy_states(tracker)} == {'song', 'album'}
    ledger.close()
