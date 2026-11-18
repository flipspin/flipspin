"""Arrival-only automatic analysis and durable discovery baselines."""
from unittest.mock import Mock

import pytest

from app.domains.music.analysis_jobs import AnalysisService
from app.domains.music.repositories import MusicRepository
from app.domains.music.scan_store import SCAN_CACHE, ScanStore
from app.infra.migrations import SQLiteStore, open_store
from tests.unit.test_analysis_step1 import AGENT, analysis as analysis, claim, measurement, submit


@pytest.fixture(autouse=True)
def fresh_library(analysis):
    with analysis.music.scans.store.connection() as db:
        db.execute('DELETE FROM analysis_baselines')


def defaults(a):
    assert a.config.analysis_auto


def test_fresh_library_is_idle_but_completion_arrivals_are_queued(analysis):
    a = analysis
    defaults(a)
    for i in range(50):
        a.song(f'{i:02}.mp3')
    assert a.service.scan() == 0
    assert a.service.queue.rows(('analysis',)) == []
    assert a.service.summary()['waiting'] == 50
    fresh = a.song('download.mp3')
    assert a.service.enqueue_files([fresh]) == 1
    row, = a.service.queue.rows(('analysis',))
    assert (row['lane'], row['autoSource']) == ('new', 'arrival')
    assert a.service.scan() == 0


def test_hand_copied_arrival_survives_restart_and_analysis_switch(analysis):
    a = analysis
    defaults(a)
    existing = a.song('existing.mp3')
    assert a.service.scan() == 0
    a.service.set_auto(False)
    copied = a.song('copied.mp3')
    assert a.service.scan() == 0  # Arrival is remembered while disabled.
    restarted_music = MusicRepository(a.config, a.music.logger, a.repo)
    restarted = AnalysisService(a.config, a.repo, restarted_music, a.ledger, a.worker)
    restarted.set_auto(True)
    assert restarted.scan() == 1
    row, = restarted.queue.rows(('analysis',))
    assert (row['relPath'], row['lane'], row['autoSource']) == ('Album/copied.mp3', 'new', 'arrival')
    assert str(copied) in restarted_music.scans.store.analysis_arrivals(a.config.base_music_dir)
    assert str(existing) not in restarted_music.scans.store.analysis_arrivals(a.config.base_music_dir)


@pytest.mark.parametrize('old_engine', [False, True])
def test_analysed_content_change_is_an_arrival_even_with_old_engine(analysis, old_engine):
    a = analysis
    defaults(a)
    path = a.song()
    a.service.enqueue_files([path])
    submit(a, claim(a))
    if old_engine:
        with a.repo.connection() as db:
            db.execute('UPDATE track_analysis SET engine_version=0')
    path.write_bytes(path.read_bytes() + b'changed')
    a.service.set_auto(False)
    assert a.service.scan() == 0
    a.service.set_auto(True)
    assert a.service.scan() == 1
    row, = a.service.queue.rows(('analysis',))
    assert row['lane'] == 'new' and row['autoSource'] == 'arrival' and not row.get('night')
    job = a.ledger.list()[0]
    assert a.ledger.items(job['id'])[0]['detail']['trigger'] == 'new'





@pytest.mark.parametrize('mode', ['new', 'outdated', 'all'])
def test_owner_library_runs_work_with_all_automatic_settings_off(analysis, mode):
    a = analysis
    defaults(a)
    a.service.set_auto(False)
    a.song()
    assert a.service.scan() == 0
    a.worker.seen(AGENT)
    run = a.service.runs.start('owner', mode, 'library', [], 'owner')
    assert run['queued'] == 1
    submit(a, claim(a))
    assert a.repo.get('Album/song.mp3')['analyzed_at']


def test_root_change_and_switching_back_start_new_baselines(analysis):
    a = analysis
    defaults(a)
    root = a.config.base_music_dir
    a.song('existing.mp3')
    assert a.service.scan() == 0
    second = root.parent / 'second-music'
    second.mkdir()
    a.config.base_music_dir = second
    a.song('second.mp3')
    assert a.service.scan() == 0
    copied = a.song('later.mp3')
    assert a.service.scan() == 1
    assert a.service.queue.rows(('analysis',))[0]['file'] == copied.name
    # Files arriving while a root is unselected are part of its next baseline.
    a.config.base_music_dir = root
    a.song('while-away.mp3')
    assert a.service.scan() == 0
    assert a.music.scans.store.analysis_arrivals(root) == set()


def test_failed_discovery_does_not_record_a_partial_baseline(analysis, monkeypatch):
    a = analysis
    defaults(a)
    a.song('first.mp3')
    with monkeypatch.context() as patch:
        patch.setattr(a.music, 'build_album', Mock(side_effect=OSError('unavailable')))
        with pytest.raises(OSError):
            a.service.scan()
    with a.music.scans.store.connection() as db:
        assert db.execute('SELECT * FROM analysis_baselines').fetchall() == []
    a.song('also-existing.mp3')
    assert a.service.scan() == 0
    a.song('arrival.mp3')
    assert a.service.scan() == 1


def test_baseline_migration_is_appended_replayable_and_nulls_stay_existing(analysis):
    a = analysis
    defaults(a)
    path = a.song()
    store_path = a.music.scans.store.path
    store_path.unlink()
    db = open_store(store_path, SQLiteStore(SCAN_CACHE.name, SCAN_CACHE.steps[:-1]))
    with db:
        db.execute('INSERT INTO tags (path,mtime_ns,size,value,first_seen) VALUES (?,0,0,?,NULL)', (str(path), '{}'))
    db.close()
    a.music.scans.store = ScanStore(store_path)
    assert a.service.scan() == 0
    a.song('arrival.mp3')
    assert a.service.scan() == 1
    with a.music.scans.store.connection() as db:
        before = db.execute('SELECT * FROM analysis_baselines').fetchall()
        db.execute(f'PRAGMA user_version={len(SCAN_CACHE.steps) - 1}')
    replayed = ScanStore(store_path)
    with replayed.connection() as db:
        assert db.execute('SELECT * FROM analysis_baselines').fetchall() == before
        assert db.execute('SELECT first_seen FROM tags WHERE path=?', (str(path),)).fetchone() == (None,)
    assert str(path) not in replayed.analysis_arrivals(a.config.base_music_dir)


def test_arrival_before_baseline_keeps_its_gate_when_queued_content_changes(analysis):
    a = analysis
    path = a.song()
    a.service.enqueue_files([path], lane='library')  # Bulk completion before the first scan.
    assert a.service.scan() == 0
    path.write_bytes(path.read_bytes() + b'changed')
    assert a.service.scan() == 1
    row, = a.service.queue.rows(('analysis',))
    assert row['autoSource'] == 'arrival' and row['lane'] == 'new'
    a.service.set_auto(False)
    assert a.service.queue.rows(('analysis',)) == []


def test_idle_loop_does_no_pass_until_the_library_changes(analysis):
    a = analysis
    defaults(a)
    for i in range(5):
        a.song(f'{i:02}.mp3')
    assert a.service.scan() == 0
    assert not a.service._scan_due()  # Unchanged library: no walk, no per-file reads.
    a.repo.get = Mock(side_effect=AssertionError('no per-file read for unchanged folders'))
    a.music.refresh(reason='periodic')
    assert not a.service._scan_due()
    del a.repo.get
    fresh = a.song('fresh.mp3')
    a.music.refresh(reason='filesystem')
    assert a.service._scan_due()
    assert a.service.scan() == 1
    row, = a.service.queue.rows(('analysis',))
    assert row['relPath'].endswith(fresh.name) and row['autoSource'] == 'arrival'
    assert not a.service._scan_due()


@pytest.mark.parametrize('legacy', [
    {'autoSource': 'library'}, {'autoSource': 'upgrade'}, {'night': True},
    {'autoSource': 'arrival', 'night': True}, {'lane': 'library'},
])
def test_boot_evicts_retired_queued_work_but_keeps_leases_arrivals_and_owner_work(analysis, legacy):
    a = analysis
    paths = [a.song(name) for name in ('queued.mp3', 'leased.mp3', 'joined.mp3', 'owned.mp3', 'arrival.mp3')]
    # Seed persisted legacy payloads directly, as an older server would have left them.
    for path in paths[:3]:
        payload = {**a.service.payload(path), **legacy}
        a.service.queue.enqueue('analysis', payload['relPath'], payload)
    a.worker.seen(AGENT)
    a.service.runs.start('joined', 'new', 'song', ['Album/joined.mp3'], 'owner')
    a.service.runs.start('owned', 'new', 'song', ['Album/owned.mp3'], 'owner')
    a.service.enqueue_files([paths[4]], lane='library')
    # Lease one legacy row without claiming the queued owner/automatic rows.
    leased = a.service.queue.claim(('analysis',), 'device', eligible=lambda row: row['file'] == 'leased.mp3')
    assert leased
    queued = next(r for r in a.service.queue.rows(('analysis',)) if r['file'] == 'queued.mp3')
    restarted = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    rows = restarted.queue.rows(('analysis',))
    assert {r['file'] for r in rows} == {'leased.mp3', 'joined.mp3', 'owned.mp3', 'arrival.mp3'}
    assert restarted.queue.get(queued['id']) is None
    with a.ledger.lock:
        state, visible = a.ledger.db.execute('SELECT state,queue_visible FROM items WHERE queue_id=?', (queued['id'],)).fetchone()
    assert state == 'skipped' and not visible
    # Recovered leases and owner work finish normally, at any server hour.
    while any(r['status'] == 'queued' for r in restarted.queue.rows(('analysis',))):
        got = restarted.claim(AGENT)
        assert got and got['job']
        restarted.result(got['job']['id'], got['lease'], [
            measurement(i)
            for i in got['job']['input']['items']], 'device')
    assert a.repo.get('Album/leased.mp3')['analyzed_at']


@pytest.mark.parametrize('scan_first', [False, True])
@pytest.mark.parametrize('count', [1, 13])
def test_completion_and_scan_create_one_job_and_one_tag_edit(analysis, caplog, scan_first, count):
    a = analysis
    a.config.write_analysis_tags = True
    a.song('existing.mp3', 'Baseline')
    assert a.service.scan() == 0
    paths = [a.song(f'new-{idx}.mp3') for idx in range(count)]
    if scan_first:
        assert a.service.scan() == count
        assert a.service.enqueue_files(paths) == 0
    else:
        assert a.service.enqueue_files(paths) == count
        assert a.service.scan() == 0
    assert len([j for j in a.ledger.list() if j['kind'] == 'analysis']) == 1
    got = claim(a)
    from tests.unit.test_analysis_step1 import measurement
    measured = [measurement(item, trackLufs=-24., truePeak=.5, loudnessBlocks=[-24.] * 10)
                for item in got['job']['input']['items']]
    with caplog.at_level('INFO', logger='app.domains.music.tag_edits'):
        response = submit(a, got, measured)
        assert submit(a, got, measured) == response
    assert len([r for r in caplog.records if 'edited by analysis' in r.message]) == count
    assert a.service.scan() == 0
    assert a.service.enqueue_files(paths) == 0
    assert len([j for j in a.ledger.list() if j['kind'] == 'analysis']) == 1
    with a.repo.connection() as db:
        assert db.execute("SELECT count(*) FROM library_edit WHERE principal='analysis'").fetchone()[0] == count
