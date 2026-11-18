"""Run-control acceptance: corrections, leases, replay, lane and recovery."""
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from unittest.mock import Mock

import pytest
from mutagen.id3 import ID3

from app.domains.helpers.nest_helper import NEST_ID
from app.domains.music.analysis_jobs import AnalysisService, NEST_ANALYSIS_REST_S
from app.domains.music.analysis_runs import RunConflict
from app.domains.music.tag_edits import TagEdits
from tests.unit.test_analysis_step1 import (
    AGENT, analysis as analysis, claim, measurement, put_tags, submit,
)


def start(a, request='request', mode='all', scope='library', paths=()):
    return a.service.runs.start(request, mode, scope, paths, 'owner')


def prepare(a, **changes):
    path = a.song()
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(got['job']['input']['items'][0], **changes)])
    return path


def run_row(a, id):
    with a.repo.connection() as db:
        row = dict(db.execute('SELECT * FROM analysis_run WHERE id=?', (id,)).fetchone())
    row['counts'] = json.loads(row['counts'])
    return row


def test_a9_1_correction_and_confirmation_survive_reanalysis(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = prepare(a)
    row = a.repo.get('Album/song.mp3')
    a.service.fix('Album/song.mp3', path, row['rev'], {'key': '2A', 'bpm': row['bpm']}, 'owner')
    tags = ID3(path).pprint()
    run = start(a)['run']
    got = claim(a)
    submit(a, got, [measurement(got['job']['input']['items'][0], key='6A', bpm=140)])
    view = a.service.view('Album/song.mp3', path)
    assert view['key']['value'] == '2A' and view['computed']['key'] == '6A'
    assert view['bpm']['value'] == 123.5 and view['computed']['bpm'] == 140
    assert ID3(path).pprint() == tags
    with a.repo.connection() as db:
        history = json.loads(db.execute('SELECT before FROM analysis_history WHERE run_id=?', (run['id'],)).fetchone()[0])
    assert history['key'] == '5A' and history['fixed_key'] == '2A'


def test_a9_2_identical_run_changes_only_check_and_provenance(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = prepare(a)
    a.music.scan_albums()
    before = a.repo.get('Album/song.mp3')
    revision, generation, mtime = a.repo.revision, a.music.tag_revision, path.stat().st_mtime_ns
    with a.repo.connection() as db:
        edits = db.execute('SELECT count(*) FROM library_edit').fetchone()[0]
    run = start(a)['run']
    submit(a, claim(a))
    a.music.scan_albums()
    after = a.repo.get('Album/song.mp3')
    assert before['rev'] == after['rev'] and before['analyzed_at'] == after['analyzed_at']
    assert after['checked_at'] > before['checked_at']
    assert after['analyzed_by'] == 'device' and after['accel'] == 'cpu'
    assert (a.repo.revision, a.music.tag_revision, path.stat().st_mtime_ns) == (revision, generation, mtime)
    with a.repo.connection() as db:
        assert db.execute('SELECT count(*) FROM library_edit').fetchone()[0] == edits
        assert db.execute('SELECT count(*) FROM analysis_history WHERE run_id=?', (run['id'],)).fetchone()[0] == 0
    assert run_row(a, run['id'])['counts']['same'] == 1


def test_engine_version_only_upgrade_does_not_advance_value_revision(analysis):
    a = analysis
    path = prepare(a)
    before = a.repo.get('Album/song.mp3')
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET engine_version=0')
    revision, mtime = a.repo.revision, path.stat().st_mtime_ns
    run = start(a, mode='outdated', scope='song', paths=['Album/song.mp3'])['run']
    submit(a, claim(a))
    after = a.repo.get('Album/song.mp3')
    assert after['engine_version'] == 2 and after['checked_at'] > before['checked_at']
    assert (after['rev'], after['analyzed_at']) == (before['rev'], before['analyzed_at'])
    assert (a.repo.revision, path.stat().st_mtime_ns) == (revision, mtime)
    assert run_row(a, run['id'])['counts']['same'] == 1


def test_a9_3_one_library_run_concurrent_join_and_database_fence(analysis):
    a = analysis
    a.song()
    a.worker.seen(AGENT)
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda request: start(a, request), ('one', 'two')))
    assert sorted(r['joined'] for r in responses) == [False, True]
    assert responses[0]['run']['id'] == responses[1]['run']['id']
    with pytest.raises(RunConflict, match='run-in-progress'):
        start(a, 'new', 'new')
    with a.repo.connection() as db, pytest.raises(sqlite3.IntegrityError):
        db.execute('''INSERT INTO analysis_run SELECT 'second','second',mode,scope,size,job_id,
            requested_by,requested_at,nest_allowed,state,ended_at,counts,response FROM analysis_run''')


def test_a9_4_request_replays_after_completion_and_even_library_removal(analysis):
    a = analysis
    path = prepare(a)
    first = start(a)
    submit(a, claim(a))
    path.unlink()
    assert start(a, mode='new') == first
    assert len(a.ledger.list()) == 2  # initial automatic pass and one owner run


def test_a9_5_switch_off_evicts_automatic_keeps_leases_and_owners(analysis):
    a = analysis
    paths = [a.song(f'{i}.mp3') for i in range(27)]
    a.service.enqueue_files(paths)
    got = claim(a)
    a.song('owner.mp3')
    start(a, mode='new', scope='song', paths=['Album/owner.mp3'])
    a.service.set_auto(False)
    rows = a.service.queue.rows(('analysis',))
    assert sum(r['status'] == 'leased' for r in rows) == 25
    assert [r['file'] for r in rows if r['status'] == 'queued'] == ['owner.mp3']
    fresh = a.song('fresh.mp3')
    assert a.service.scan() == a.service.enqueue_files([fresh]) == 0
    submit(a, got)
    assert a.service.summary()['waiting'] == 3  # two evicted songs and the new song
    assert a.service.state('Album/fresh.mp3', fresh) == 'none'


def test_a9_7_cancel_sticks_and_fences_late_helpers(analysis):
    from app.infra.jobs import JobConflict
    a = analysis
    prepare(a)
    run = start(a)['run']
    got = claim(a)
    a.service.cancel_job(run['jobId'])
    assert a.service.heartbeat(got['job']['id'], got['lease'], 'device')['stop']
    assert submit(a, got)['stop']
    assert a.service.scan() == a.service.scan() == 0
    assert run_row(a, run['id'])['state'] == 'cancelled'
    a.service.set_auto(False)
    path = a.song('waiting.mp3')
    run = start(a, 'waiting', 'new', 'song', ['Album/waiting.mp3'])['run']
    a.service.cancel_job(run['jobId'])
    assert a.service.scan() == a.service.scan() == 0
    assert a.service.state('Album/waiting.mp3', path) == 'none'
    with pytest.raises(JobConflict):
        a.service.cancel_job(run['jobId'])


@pytest.mark.parametrize('scan_first', [False, True])
def test_a9_8_changed_file_preserves_run_job_lane_and_size(analysis, scan_first):
    a = analysis
    a.service.set_auto(False)
    path = a.song()
    run = start(a, mode='new')['run']
    got = claim(a)
    original = a.service.queue.rows(('analysis',))[0]
    path.write_bytes(path.read_bytes() + b'changed')
    if scan_first:
        assert a.service.scan() == 1
        assert submit(a, got)['stop']
    else:
        assert submit(a, got)['items'][0]['dropped']
    row = a.service.queue.rows(('analysis',))[0]
    assert (row['runId'], row['lane'], row['id']) == (run['id'], original['lane'], original['id'])
    assert a.service.summary()['run']['done'] == 0
    submit(a, claim(a))
    assert run_row(a, run['id'])['state'] == 'done'
    assert a.ledger.get(run['jobId'])['succeeded'] == 1
    assert len(a.ledger.list()) == 1


def test_a9_9_analysis_journal_does_not_evict_person_undo(analysis):
    a = analysis
    path = a.song()
    edits = TagEdits(a.config, a.repo, a.music)
    owner = edits.edit(path, {'title': 'Chosen'}, principal='owner')['editId']
    with a.repo.connection() as db:
        db.executemany('''INSERT INTO library_edit (id,kind,principal,state,created_at,expires_at)
            VALUES (?,'tags','analysis','applied',1,9999999999)''', [(f'auto-{i}',) for i in range(5000)])
    extra, _ = edits.create('tags', 'analysis', [{'relPath': 'Album/song.mp3'}])
    assert edits.get(owner)['principal'] == 'owner'
    undo_id, _ = edits.start_undo(owner, 'owner')
    edits.run_undo(undo_id)
    assert edits.get(undo_id)['state'] == 'applied'
    assert a.music.read_tags(path).get('title') != 'Chosen'


def test_a9_10_library_nest_fence_song_delay_and_rest(analysis):
    a = analysis
    a.song()
    nest = {**AGENT, 'id': NEST_ID, 'sessionId': 'nest'}
    a.worker.register_nest(nest)
    with pytest.raises(RunConflict, match='no-helper'):
        start(a)
    start(a, 'song', 'all', 'song', ['Album/song.mp3'])
    assert a.service.claim(nest) is None
    a.clock[0] += 601
    got = a.service.claim(nest)
    assert got and got['job']
    a.service.result(got['job']['id'], got['lease'], [measurement(i) for i in got['job']['input']['items']], NEST_ID)
    # The rest is specific to owner work; automatic songs retain ordinary fallback.
    a.service._nest_finished_at['rest-run'] = a.clock[0]
    assert not a.service._claimable({'nest': True, 'runId': 'rest-run'}, NEST_ID)
    a.clock[0] += NEST_ANALYSIS_REST_S
    assert a.service._claimable({'nest': True, 'runId': 'rest-run'}, NEST_ID)
    assert not a.service._claimable({'nest': False}, NEST_ID)
    a.worker.seen(AGENT)
    start(a, 'library')
    a.worker.bye('device', 'sleep', 'session')
    a.clock[0] += 601
    assert a.service.claim(nest) is None
    assert a.service.summary()['run']['waiting'] == 'helpers-offline'


def test_a9_13_unavailable_library_does_not_sweep_or_create(analysis):
    a = analysis
    a.repo.fix('Album/ghost.mp3', 0, {'key': '2A'}, 'owner')
    with pytest.raises(RunConflict, match='library-unavailable'):
        start(a, mode='new')
    assert a.service.scan() == 0
    assert a.repo.get('Album/ghost.mp3')['missing_since'] is None
    assert a.ledger.list() == [] and a.service.runs.store.live() == []


def test_a9_14_confidence_flips_count_and_foreign_tags_survive(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = prepare(a)
    run = start(a)['run']
    got = claim(a)
    submit(a, got, [measurement(got['job']['input']['items'][0], keyConf=0, bpmConf=0)])
    assert 'TBPM' not in ID3(path) and 'TKEY' not in ID3(path)
    assert run_row(a, run['id'])['counts']['toEstimated'] == 2
    run = start(a, 'confident')['run']
    submit(a, claim(a))
    assert 'TBPM' in ID3(path) and 'TKEY' in ID3(path)
    assert run_row(a, run['id'])['counts']['toConfident'] == 2
    put_tags(path, bpm='90', key='2A')
    original = path.read_bytes()
    start(a, 'foreign')
    got = claim(a)
    submit(a, got, [measurement(got['job']['input']['items'][0], keyConf=0, bpmConf=0)])
    assert path.read_bytes() == original


def test_a9_16_restart_repairs_live_leases_and_intent_before_job(analysis):
    a = analysis
    a.service.set_auto(False)
    a.song('one.mp3'); a.song('two.mp3')
    first = start(a, mode='new')['run']
    got = claim(a)
    restarted = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    assert all(r['status'] == 'queued' for r in restarted.queue.rows(('analysis',)))
    assert restarted.runs.progress()['size'] == 2
    assert restarted.result(got['job']['id'], got['lease'], [], 'device')['stop']
    got = restarted.claim(AGENT)
    restarted.result(got['job']['id'], got['lease'], [measurement(i) for i in got['job']['input']['items']], 'device')
    assert run_row(a, first['id'])['state'] == 'done'
    a.song('three.mp3')
    materialize = a.service.runs.materialize
    a.service.runs.materialize = Mock(side_effect=OSError('interrupted before job'))
    with pytest.raises(OSError):
        start(a, 'interrupted', 'new')
    a.service.runs.materialize = materialize
    restarted = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    assert restarted.runs.progress()['size'] == 1
    assert [r['file'] for r in restarted.queue.rows(('analysis',)) if r['status'] == 'queued'] == ['three.mp3']


def test_preview_is_pure_and_measured_estimate_modes_failures_and_skips(analysis, monkeypatch):
    a = analysis
    prepare(a)
    a.service.set_auto(False)
    a.song('new.mp3')
    a.repo.error('Album/failed.mp3', 'undecodable')
    failed = a.song('failed.mp3')
    a.repo.error('Album/failed.mp3', 'undecodable', (failed.stat().st_size, failed.stat().st_mtime_ns))
    before = a.repo.revision, a.ledger.version
    preview = a.service.runs.preview('all')
    assert (preview['waiting'], preview['failed'], preview['size']) == (1, 1, 3)
    assert (a.repo.revision, a.ledger.version) == before
    # Supply a completed-work rate and known durations; no assumed rate is used.
    a.worker.record_result('device', 'analysis', 6, 180)
    read = a.music.read_tags
    monkeypatch.setattr(a.music, 'read_tags', lambda p: {**read(p), 'duration': 180})
    preview = a.service.runs.preview('all')
    assert preview['estimateSeconds'] is not None
    a.worker._helpers['device']['speed'] = {}
    assert a.service.runs.preview('all')['estimateSeconds'] is None
    response = start(a, mode='new', scope='selection', paths=['../outside', 'Album/missing.mp3', 'Album/new.mp3'])
    assert response['queued'] == 1
    assert {r['reason'] for r in response['skipped']} == {'outside', 'missing'}
    assert a.service.runs.preview('new')['size'] == 1


def test_library_background_single_song_upgrade_and_new_songs_first(analysis):
    a = analysis
    prepare(a)
    a.service.set_auto(False)
    start(a)
    a.service.set_auto(True)
    a.song('fresh.mp3')
    a.service.scan()
    rows = a.service.queue.rows(('analysis',))
    assert next(r for r in rows if r['file'] == 'song.mp3')['lane'] == 'library'
    start(a, 'song', 'all', 'song', ['Album/song.mp3'])
    rows = a.service.queue.rows(('analysis',))
    assert next(r for r in rows if r['file'] == 'song.mp3')['lane'] == 'now'
    assert len(rows) == 2


def test_joined_progress_and_cancel_only_the_requesting_job(analysis):
    a = analysis
    path = a.song()
    a.service.scan()  # An automatic job already owns the song.
    automatic = a.ledger.list()[0]['id']
    run = start(a, mode='new')['run']
    a.service.set_auto(False)
    assert a.service.summary()['run']['counts']['joined'] == 1
    got = claim(a)
    a.service.cancel_job(run['jobId'])
    assert a.ledger.get(automatic)['state'] == 'running'
    assert not a.service.heartbeat(got['job']['id'], got['lease'], 'device')['stop']
    submit(a, got)
    assert a.service.view('Album/song.mp3', path)['key']['value'] == '5A'
    assert run_row(a, run['id'])['state'] == 'cancelled'


def test_joining_changed_automatic_item_keeps_new_signature_with_nest_fence(analysis):
    a = analysis
    path = a.song()
    a.service.scan()
    claim(a)
    path.write_bytes(path.read_bytes() + b'changed')
    run = start(a)['run']
    row = a.service.queue.rows(('analysis',))[0]
    assert row['size'] == path.stat().st_size and row['mtimeNs'] == path.stat().st_mtime_ns
    assert row['nest'] is False and row['ownerRuns'] == [run['id']]
    a.service.set_auto(False)
    submit(a, claim(a))
    assert run_row(a, run['id'])['state'] == 'done'


def test_joined_success_and_final_failure_complete_run_and_job(analysis):
    a = analysis
    a.song('good.mp3'); a.song('bad.mp3')
    a.service.scan()
    run = start(a, mode='new')['run']
    got = claim(a)
    items = got['job']['input']['items']
    values = [measurement(i) if i['file'] == 'good.mp3' else {
        'relPath': i['relPath'], 'ok': False, 'error': 'undecodable', 'final': True} for i in items]
    submit(a, got, values)
    record = run_row(a, run['id'])
    assert record['state'] == 'done'
    assert record['counts']['failed'] == record['counts']['changed'] == 1
    assert a.ledger.get(run['jobId'])['state'] == 'partial'
    assert a.ledger.get(run['jobId'])['succeeded'] == a.ledger.get(run['jobId'])['failed'] == 1


def test_engine_upgrade_requires_owner_and_modes_skip_failures(analysis, monkeypatch):
    a = analysis
    prepare(a)
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET engine_version=0')
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: datetime(2026, 11, 9, 12))
    assert a.service.scan() == 0
    assert a.service.runs.preview('new')['size'] == 0
    assert a.service.runs.preview('outdated')['size'] == 1
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: datetime(2026, 11, 9, 3))
    assert a.service.scan() == 0
    start(a, request='upgrade', mode='outdated')
    got = claim(a)
    item = got['job']['input']['items'][0]
    submit(a, got, [{'relPath': item['relPath'], 'ok': False, 'error': 'undecodable', 'final': True}])
    assert a.service.runs.preview('outdated')['size'] == 0
    assert a.service.runs.preview('all')['size'] == 1
    start(a)
    submit(a, claim(a))
    assert a.repo.get('Album/song.mp3')['error'] is None


@pytest.mark.parametrize('auto', [False, True])
@pytest.mark.parametrize('hour', [3, 12])
def test_engine_upgrade_defaults_off_and_keeps_outdated_results(analysis, monkeypatch, auto, hour):

    a = analysis
    path = prepare(a)
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET engine_version=0')
    before = a.repo.get('Album/song.mp3')
    a.service.set_auto(auto)
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: datetime(2026, 11, 9, hour))
    assert a.service.scan() == a.service.enqueue_files([path]) == 0
    assert not any(r['status'] in ('queued', 'leased') for r in a.service.queue.rows(('analysis',)))
    assert a.service.runs.preview('outdated')['outdated'] == 1
    assert a.service.runs.preview('new')['size'] == 0
    assert a.repo.get('Album/song.mp3') == before
    assert a.service.view('Album/song.mp3', path)['state'] == 'analyzed'
    assert a.service.summary()['waiting'] == 1


@pytest.mark.parametrize('mode', ['outdated', 'all'])
@pytest.mark.parametrize('scope', ['song', 'library'])
def test_owner_can_reanalyse_outdated_any_time_with_both_automatic_settings_off(analysis, monkeypatch, mode, scope):

    a = analysis
    prepare(a)
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET engine_version=0')
    a.service.set_auto(False)
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: datetime(2026, 11, 9, 12))
    run = start(a, mode=mode, scope=scope, paths=['Album/song.mp3'])
    assert run['queued'] == 1
    submit(a, claim(a))
    assert a.repo.get('Album/song.mp3')['engine_version'] == a.service.engine_version


@pytest.mark.parametrize('state', ['cancelled', 'succeeded'])
def test_boot_matches_terminal_job_after_crash_before_run_transition(analysis, state):
    a = analysis
    a.service.set_auto(False)
    a.song()
    run = start(a, mode='new')['run']
    if state == 'cancelled':
        a.ledger.cancel(run['jobId'], 1)
    else:
        # A helper result committed its ledger outcome before run reconciliation.
        original = a.service.runs.reconcile
        a.service.runs.reconcile = lambda *args, **kwargs: None
        submit(a, claim(a))
        a.service.runs.reconcile = original
    AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    assert run_row(a, run['id'])['state'] == ('cancelled' if state == 'cancelled' else 'done')


def test_numbered_upgrade_keeps_existing_values_and_backfills_last_check(tmp_path):
    from dataclasses import replace
    from app.domains.music.analysis_repository import AnalysisRepository
    from app.domains.music.analysis_schema import ANALYSIS
    from app.infra.migrations import open_store

    assert tuple(step.__name__ for step in ANALYSIS.steps) == (
        'base', 'missing_since', 'listing_revision', 'library_edits', 'match_proposals', 'run_controls', 'duplicate_schema', 'arousal_schema', 'loudness', 'missing_listing_revision', 'first_seen_schema')
    path = tmp_path / 'analysis.sqlite'
    db = open_store(path, replace(ANALYSIS, steps=ANALYSIS.steps[:5]))
    with db:
        db.execute('''INSERT INTO track_analysis (rel_path,key,fixed_key,rev,analyzed_at)
            VALUES ('Album/song.mp3','5A','2A',7,'2026-11-01T00:00:00+00:00')''')
    with db:
        db.execute("INSERT INTO match_proposal VALUES ('proposal','owner',1,'{}','{}')")
        db.execute("INSERT INTO track_identity VALUES ('Album/song.mp3','recording','release','musicbrainz')")
    db.close()
    repository = AnalysisRepository(path)
    row = repository.get('Album/song.mp3')
    assert (row['key'], row['fixed_key'], row['rev']) == ('5A', '2A', 7)
    assert row['checked_at'] == row['analyzed_at']
    assert row['analyzed_by'] is row['accel'] is None
    with repository.connection() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == len(ANALYSIS.steps)
        assert db.execute('SELECT job_id FROM match_proposal').fetchone()[0] == 'proposal'
        assert db.execute('SELECT mb_recording FROM track_identity').fetchone()[0] == 'recording'
    version = repository.revision
    AnalysisRepository(path)
    assert repository.revision == version


def test_restart_with_auto_off_evicts_persisted_automatic_work_and_preserves_owner(analysis):
    a = analysis
    automatic = a.song('automatic.mp3')
    a.service.enqueue_files([automatic])
    a.song('owner.mp3')
    run = start(a, mode='new', scope='song', paths=['Album/owner.mp3'])['run']
    # Simulate restart after settings persistence but before its eviction hook.
    a.config.analysis_auto = False
    restarted = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    rows = restarted.queue.rows(('analysis',))
    assert len(rows) == 1 and rows[0]['relPath'] == 'Album/owner.mp3'
    assert rows[0]['runId'] == run['id']


@pytest.mark.parametrize('mode', ['new', 'outdated', 'all'])
@pytest.mark.parametrize('window', [(1, 7, 12, 2), (22, 5, 12, 23)])
def test_library_run_window_and_cpu_fences_survive_restart(analysis, monkeypatch, mode, window):

    a = analysis
    if mode == 'new':
        a.song()
        a.worker.seen(AGENT)
    else:
        prepare(a)
        if mode == 'outdated':
            with a.repo.connection() as db:
                db.execute('UPDATE track_analysis SET engine_version=0')
    a.service.set_auto(False)
    begin, end, outside, inside = window
    hour = [outside]
    monkeypatch.setattr('app.domains.helpers.compute.local_time', lambda worker: datetime(2026, 11, 9, hour[0]))
    run = start(a, mode=mode)['run']
    assert not run_row(a, run['id'])['nest_allowed']
    row = a.service.queue.rows(('analysis',))[0]
    assert row['lane'] == 'library' and row['libraryRun'] and not row['nest']
    assert 'priority' not in row
    # Helpers follow their own hours; the nest window never delays them.
    assert a.service.queue.kinds['analysis'].can_claim(row, 'device')
    restarted = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    nest = {**AGENT, 'id': NEST_ID, 'sessionId': 'nest'}
    a.worker.register_nest(nest)
    a.worker.bye('device', 'sleep', 'session')
    a.clock[0] += 601
    assert restarted.claim(nest) is None
    got = restarted.claim(AGENT)
    assert got and got['job']
    hour[0] = inside
    restarted.result(got['job']['id'], got['lease'], [measurement(i) for i in got['job']['input']['items']], 'device')
    assert run_row(a, run['id'])['state'] == 'done'
    detail = a.ledger.items(run['jobId'])[0]['detail']['result']
    assert detail['analyzed_by'] == 'device' and detail['accel'] == 'cpu'


def test_library_run_join_revokes_existing_nest_lease(analysis):
    a = analysis
    a.song()
    a.service.scan()
    nest = {**AGENT, 'id': NEST_ID, 'sessionId': 'nest'}
    a.worker.register_nest(nest)
    a.clock[0] += 601
    got = a.service.claim(nest)
    assert got and got['job']
    run = start(a, mode='new')['run']
    assert a.service.heartbeat(got['job']['id'], got['lease'], NEST_ID)['stop']
    assert a.service.result(got['job']['id'], got['lease'], [], NEST_ID)['stop']
    row = a.service.queue.rows(('analysis',))[0]
    assert row['status'] == 'queued' and row['libraryRun'] and not row['nest']
    assert a.service.claim(nest) is None
    submit(a, claim(a))
    assert run_row(a, run['id'])['state'] == 'done'


def test_lane_order_claims_owner_then_acquisition_then_library(analysis):
    a = analysis
    prepare(a)
    a.service.set_auto(False)
    library = start(a)['run']
    a.service.set_auto(True)
    fresh = a.song('new.mp3')
    a.service.enqueue_files([fresh])
    a.song('owner.mp3')
    start(a, 'song', 'all', 'song', ['Album/owner.mp3'])
    for expected in ('owner.mp3', 'new.mp3', 'song.mp3'):
        got = claim(a)
        assert [item['file'] for item in got['job']['input']['items']] == [expected]
        submit(a, got)
    assert run_row(a, library['id'])['state'] == 'done'
