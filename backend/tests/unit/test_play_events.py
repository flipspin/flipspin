"""History migration, retention, recovery and relocation against real stores."""
from dataclasses import replace
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

from app.domains.music.relocation import TrackRelocator
from app.domains.user_library.plays import history, record_batch
from app.domains.user_library.store import UserTrackStore
from app.infra.idempotency import Receipts, database
from app.infra.jobs.schema import JOBS
from app.infra.jobs import Jobs
from app.infra.migrations import open_store

OLD, NEW = 'Old/song.mp3', 'New/song.mp3'


def play(key, day=1):
    return SimpleNamespace(trackKey=key, listenedAt=datetime(2001, 1, day, tzinfo=UTC), clientPlayId=f'{key}-{day}')


def test_upgrade_backfills_real_receipts_once_and_preserves_baselines(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    # Start before play-history migration 9, even when newer migrations exist.
    db = open_store(path, replace(JOBS, steps=JOBS.steps[:8]))
    db.execute('INSERT INTO plays VALUES(?,?,?,?)', ('user-a', OLD, '2001-01-01T00:00:00+00:00', 'old-play'))
    db.execute('INSERT INTO plays_baselines VALUES(?,?,?)', ('user-a', OLD, 17))
    db.commit()
    db.close()
    before = set((tmp_path / 'backups').glob('*.sqlite'))
    for _ in range(2):
        db = open_store(path, JOBS)
        row, = db.execute('SELECT * FROM play_events').fetchall()
        assert row['user_id'] == 'user-a' and row['track_key'] == OLD
        assert row['started_at'] == '2001-01-01T00:00:00+00:00'
        assert row['completed'] == 1 and row['device_id'] is None and row['duration_played_s'] is None
        assert db.execute('SELECT count FROM plays_baselines').fetchone()[0] == 17
        assert [r[2] for r in db.execute('PRAGMA index_info(play_events_user_started)')] == ['user_id', 'started_at']
        db.close()
    snapshots = list((tmp_path / 'backups').glob('*.sqlite'))
    assert len(set(snapshots) - before) == 1


def test_a_retry_recovers_stats_after_event_commit_without_duplicating(tmp_path, monkeypatch):
    path = tmp_path / 'jobs.sqlite'
    store = UserTrackStore(tmp_path / 'tracks.json')
    store.add_many('user-a', [OLD])
    original = store.set_play_stats
    monkeypatch.setattr(store, 'set_play_stats', Mock())
    assert record_batch(path, store, 'user-a', [play(OLD)]) == {'accepted': 1}
    assert store.get('user-a', OLD).play_count == 0
    monkeypatch.setattr(store, 'set_play_stats', original)
    assert record_batch(path, store, 'user-a', [play(OLD)]) == {'accepted': 0}
    assert store.get('user-a', OLD).play_count == 1
    assert len(history(path, 'user-a')['events']) == 1


def test_move_and_merge_preserve_events_collisions_baselines_and_future_counts(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    store = UserTrackStore(tmp_path / 'tracks.json')
    for account in ('user-a', 'user-b'):
        store.add_many(account, [OLD, NEW])
        store.record_play(account, OLD)  # pre-receipt baseline
        store.record_play(account, NEW)
        record_batch(path, store, account, [play(OLD), play(NEW)])
    identities = {account: {row['id'] for row in history(path, account)['events']}
                  for account in ('user-a', 'user-b')}
    cursor = history(path, 'user-a', limit=1)['nextCursor']
    # History is retained and moved even after a person removes membership.
    store.remove_many('user-b', [OLD, NEW])
    relocator = TrackRelocator(base_music_dir=tmp_path, music_service=Mock(), user_tracks=store, jobs_file=path)
    relocator.repoint(tmp_path / OLD, tmp_path / NEW, keep_lyric=False)
    relocator.repoint(tmp_path / OLD, tmp_path / NEW, keep_lyric=False)  # harmless repeat
    for account in ('user-a', 'user-b'):
        rows = history(path, account)['events']
        assert len(rows) == 2 and all(row['relPath'] == NEW for row in rows)
        assert {row['id'] for row in rows} == identities[account]
    assert len(history(path, 'user-a', after=cursor)['events']) == 1
    assert record_batch(path, store, 'user-a', [play(NEW, 2)]) == {'accepted': 1}
    assert store.get('user-a', NEW).play_count == 5
    with database(path) as db:
        for table, key in (('plays', 'track_key'), ('plays_baselines', 'track_key'), ('play_events', 'track_key')):
            assert db.execute(f'SELECT count(*) FROM {table} WHERE {key}=?', (OLD,)).fetchone()[0] == 0


def test_request_receipt_retention_never_prunes_old_events(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    store = UserTrackStore(tmp_path / 'tracks.json')
    store.add_many('user-a', [OLD])
    record_batch(path, store, 'user-a', [play(OLD)])
    receipts = Receipts(path)
    receipts.begin('old', 'user-a', '/test', {})
    with database(path) as db:
        db.execute('UPDATE idempotency_keys SET created_at=0')
    receipts.begin('new', 'user-a', '/test', {})
    ledger = Jobs(path, now=lambda: 100)
    job = ledger.start('download', 'Expired job', [])
    ledger.finish(job, 1)
    ledger.clear_one(job)
    ledger.now = lambda: 100 + 365 * 86400
    ledger.retention()
    assert ledger.get(job) is None
    ledger.close()
    assert len(history(path, 'user-a')['events']) == 1
    with database(path) as db:
        assert db.execute('SELECT count(*) FROM idempotency_keys').fetchone()[0] == 1
