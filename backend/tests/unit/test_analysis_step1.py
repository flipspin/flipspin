"""Server analysis contract checks 1–6, 10, 12, 15–17 and queue lifecycle."""
import logging
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TBPM, TKEY, TXXX

from app.dependencies import DependencyContainer, get_analysis_service, get_library_scope
from app.domains.helpers.mac_worker import WorkerRecord
from app.domains.music import analysis_constants as thresholds
from app.domains.music.analysis_jobs import AnalysisService
from app.domains.music.analysis_mood import _classify_mood
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_routes import router
from app.domains.music.analysis_tags import analysis_tags
from app.domains.music.repositories import MusicRepository
from app.infra.identity import Principal, require_owner
from app.infra.jobs import Jobs
from tests.unit.test_acquisition import pipeline  # noqa: F401

FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 40
AGENT = {'id': 'device', 'name': 'Helper', 'version': '0.10.0', 'sessionId': 'session',
         'os': 'linux', 'accel': 'cpu', 'memoryBytes': 256 << 20,
         'jobs': ['analysis'], 'labels': ['analysis>=2']}


@pytest.fixture
def analysis(config):
    ledger = Jobs(config.jobs_file)
    clock = [1000.0]
    ledger.now = lambda: clock[0]
    worker = WorkerRecord(now=lambda: clock[0])
    repository = AnalysisRepository(config.analysis_db)
    music = MusicRepository(config, logging.getLogger('test'), repository)
    service = AnalysisService(config, repository, music, ledger, worker)
    service.queue.now = lambda: clock[0]
    music.analysis_state = service.state
    music.refresh()  # Establish an empty library; test songs are subsequent arrivals.
    def song(name='song.mp3', folder='Album'):
        path = config.base_music_dir / folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(FRAME)
        return path
    yield SimpleNamespace(service=service, config=config, repo=repository, music=music,
                          worker=worker, ledger=ledger, clock=clock, song=song)
    service.stop()
    ledger.close()


def measurement(item, **changes):
    return {**{k: item[k] for k in ('relPath', 'size', 'mtimeNs')}, 'engine': 'keyfinder+tempocnn',
            'engineVersion': 2, 'key': '5A', 'keyConf': 0.9, 'bpm': 123.46, 'bpmConf': 0.9,
            'energy': .06, 'brightness': .25, 'pulse': 1.6, **changes}


def claim(a):
    got = a.service.claim(AGENT)
    assert got and got.get('job'), got
    return got


def submit(a, got, items=None):
    return a.service.result(got['job']['id'], got['lease'],
                            items or [measurement(i) for i in got['job']['input']['items']], 'device')


def put_tags(path, bpm='90', key='2A', marker=False):
    tags = ID3()
    tags.add(TBPM(encoding=3, text=[bpm]))
    tags.add(TKEY(encoding=3, text=[key]))
    if marker:
        tags.add(TXXX(encoding=3, desc='KROBI_ANALYSIS', text=['keyfinder+tempocnn@1']))
    tags.save(path)


def test_scan_acquisition_listing_idempotency_and_batch_25(analysis):
    a = analysis
    paths = [a.song(f'{i:02}.mp3') for i in range(26)]
    assert a.music.scan_albums()  # The listing's scan is a pure reader.
    assert a.service.queue.rows(('analysis',)) == []
    assert a.service.scan() == 26
    assert a.service.scan() == 0
    assert a.service.enqueue_files(paths) == 0
    records = a.ledger.list()
    assert len(records) == 1 and records[0]['kind'] == 'analysis'
    assert records[0]['starter_user_id'] == 'system' and records[0]['total'] == 26
    got = claim(a)
    items = got['job']['input']['items']
    assert len(items) == 25
    assert set(items[0]) == {'relPath', 'album', 'file', 'size', 'mtimeNs', 'mediaUrl'}
    rows = a.service.queue.rows(('analysis',))
    assert sum(r['status'] == 'leased' for r in rows) == 25
    assert {r['lease'] for r in rows if r['status'] == 'leased'} == {got['lease']}
    assert a.service.claim(AGENT) is None
    assert a.service.heartbeat(got['job']['id'], got['lease'], 'device', 'analizando', .5) == {'stop': False}
    submit(a, got)
    assert len(claim(a)['job']['input']['items']) == 1
    a.song('acquired.mp3')
    assert a.service.enqueue_files([a.config.base_music_dir / 'Album/acquired.mp3']) == 1


def test_large_download_stays_on_new_lane(analysis, pipeline, monkeypatch):  # noqa: F811
    import asyncio
    from app.dependencies import DependencyContainer
    from tests.unit.test_acquisition import body, submit

    a = analysis
    monkeypatch.setattr(a.config, 'base_music_dir', pipeline.root)
    pipeline.music = a.music
    invalidate = Mock()
    monkeypatch.setattr(a.music, 'invalidate_scan', invalidate)
    refresh = Mock(wraps=a.music.refresh_folders)
    monkeypatch.setattr(a.music, 'refresh_folders', refresh)
    monkeypatch.setattr('app.domains.music.repositories.MutagenFile', lambda path: None)
    container = DependencyContainer(a.config)
    monkeypatch.setattr(container, 'get_analysis_service', lambda: a.service)
    pipeline.engine.completion_listeners = [container._enqueue_analysis_files]
    request = submit(pipeline, body(200))
    assert all(r.success for r in asyncio.run(pipeline.run(request['id'])))
    rows = a.service.queue.rows(('analysis',))
    assert len(rows) == 200
    assert all(r['lane'] == 'new' and r['nest'] for r in rows)
    invalidate.assert_not_called()
    refresh.assert_called_once()


def test_bulk_enqueue_never_demotes_queued_work(analysis):
    a = analysis
    paths = [a.song(f'{i}.mp3') for i in range(3)]
    assert a.service.enqueue_files(paths[:1]) == 1
    assert a.service.enqueue_files(paths[1:2], lane='now') == 1
    assert a.service.enqueue_files(paths, lane='library', nest=False) == 1
    rows = {r['file']: r for r in a.service.queue.rows(('analysis',))}
    assert (rows['0.mp3']['lane'], rows['0.mp3']['nest']) == ('new', True)
    assert (rows['1.mp3']['lane'], rows['1.mp3']['nest']) == ('now', True)
    assert (rows['2.mp3']['lane'], rows['2.mp3']['nest']) == ('library', False)
    assert a.service.enqueue_files(paths[2:]) == 0
    assert next(r for r in a.service.queue.rows(('analysis',)) if r['file'] == '2.mp3')['lane'] == 'new'


def test_population_rank_changes_notify_the_listing_without_waiting_for_its_timer(analysis, monkeypatch):
    a = analysis
    path = a.song()
    a.song('present.mp3')
    a.service.scan()
    submit(a, claim(a))
    invalidate = Mock()
    monkeypatch.setattr(a.music, 'invalidate_scan', invalidate)
    path.unlink()
    assert a.service.scan() == 0
    invalidate.assert_called_once_with()
    assert a.repo.get('Album/song.mp3')['arousal'] is None
    invalidate.reset_mock()
    assert a.service.scan() == 0
    invalidate.assert_not_called()


def test_startup_recomputes_derived_values_in_background_without_reanalysis(analysis, monkeypatch):
    a = analysis
    a.song()
    a.service.scan()
    submit(a, claim(a))
    with a.repo.connection() as db:
        db.execute("UPDATE track_analysis SET mood = 'melancholic', arousal = NULL")
        db.execute("UPDATE meta SET value='0' WHERE key='arousal_rule_version'")
    before = a.repo.get('Album/song.mp3')
    ledger_version = a.ledger.version
    started, release, scanned = threading.Event(), threading.Event(), threading.Event()
    recompute = a.repo.recompute_moods
    scan = a.service.scan

    def blocked_recompute():
        started.set()
        assert release.wait(3)
        recompute()

    def scan_after_recompute(**_):
        assert a.repo.meta('mood_rule_version') == '2'
        assert a.repo.meta('arousal_rule_version') == '1'
        assert a.repo.get('Album/song.mp3') == {**before, 'mood': 'upbeat', 'arousal': .5}
        assert scan() == 0
        assert a.ledger.version == ledger_version
        a.service._stop.set()
        scanned.set()

    monkeypatch.setattr(a.repo, 'recompute_moods', blocked_recompute)
    monkeypatch.setattr(a.service, 'scan', scan_after_recompute)
    a.service.startup()
    try:
        assert started.wait(3)
        assert a.service._thread.is_alive()
        assert a.repo.meta('mood_rule_version') is None
        release.set()
        assert scanned.wait(3)
    finally:
        release.set()
        a.service.stop()


def test_check_1_computed_never_writes_fixed_and_mood_is_server_owned(analysis):
    a = analysis
    path = a.song()
    assert a.service.fix('Album/song.mp3', path, 0, {'key': '2A'}, 'owner')[0]
    a.service.scan()
    submit(a, claim(a))
    row, view = a.repo.get('Album/song.mp3'), a.service.view('Album/song.mp3', path)
    assert row['key'] == '5A' and row['fixed_key'] == '2A'
    assert view['key']['value'] == '2A' and view['computed']['key'] == '5A'
    assert row['mood'] == _classify_mood(123.5, .06, .25, 1.6)
    assert row['bpm'] == 123.5 and row['fixed_by'] == 'owner' and row['rev'] == 2


def test_check_2_changed_file_drops_and_requeues(analysis):
    a = analysis
    path = a.song()
    a.service.scan()
    got = claim(a)
    path.write_bytes(path.read_bytes() + b'changed')
    assert submit(a, got)['items'][0]['dropped']
    assert a.repo.get('Album/song.mp3') is None
    rows = a.service.queue.rows(('analysis',))
    assert len(rows) == 1 and rows[0]['status'] == 'queued' and rows[0]['size'] == path.stat().st_size


def test_scan_supersedes_leased_signature_and_fences_old_result(analysis):
    a = analysis
    path = a.song()
    a.service.scan()
    got = claim(a)
    path.write_bytes(path.read_bytes() + b'changed')
    assert a.service.scan() == 1
    assert submit(a, got)['stop']
    assert a.repo.get('Album/song.mp3') is None
    assert a.service.scan() == 0


def test_check_3_own_writeback_does_not_requeue(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = a.song()
    a.service.scan()
    got = claim(a)
    result = submit(a, got)
    row = a.repo.get('Album/song.mp3')
    assert (row['size'], row['mtime_ns']) == (path.stat().st_size, path.stat().st_mtime_ns)
    assert row['tag_owner'] == 'krobi'
    tags = analysis_tags(ID3(path))
    assert tags['bpm'] == 123.5 and tags['key'] == '5A' and tags['tag_owner'] == 'krobi'
    before = row.copy(), path.read_bytes(), a.ledger.version
    assert submit(a, got) == result
    assert before == (a.repo.get('Album/song.mp3'), path.read_bytes(), a.ledger.version)
    assert a.service.scan() == 0
    track = a.music.scan_albums()[0].tracks[0]
    assert track.analysis['analysisState'] == 'analyzed'
    assert track.analysis['bpm_source'] == 'estimated'


def test_check_4_estimated_never_written_and_flags(analysis, monkeypatch):
    a = analysis
    monkeypatch.setattr(thresholds, 'BPM_CONFIDENCE_THRESHOLD', .95)
    monkeypatch.setattr(thresholds, 'KEY_CONFIDENCE_THRESHOLD', .95)
    a.config.write_analysis_tags = True
    path = a.song()
    before = path.read_bytes()
    a.service.scan()
    submit(a, claim(a))
    assert path.read_bytes() == before
    from app.domains.music.analysis_precedence import listing_analysis, precedence
    effective = precedence(a.repo.get('Album/song.mp3'), {}, bpm_threshold=.95, key_threshold=.95)
    flags = listing_analysis(effective)
    assert flags['bpmEstimated'] and flags['keyEstimated']
    assert a.service.view('Album/song.mp3', path)['bpm']['estimated']


@pytest.mark.parametrize('field,value', [('key', '13A'), ('bpm', 301), ('keyConf', 1.1),
                                         ('bpmConf', -1), ('energy', float('nan')),
                                         ('brightness', float('inf')), ('pulse', float('-inf')),
                                         ('trackLufs', -70.001), ('trackLufs', .001),
                                         ('trackLufs', float('nan')), ('trackLufs', float('inf')),
                                         ('trackLufs', float('-inf')),
                                         ('truePeak', -.001), ('truePeak', 8.001),
                                         ('truePeak', float('nan')), ('truePeak', float('inf')),
                                         ('truePeak', float('-inf'))])
def test_invalid_item_422_does_not_fail_batch(analysis, field, value):
    a = analysis
    a.song('bad.mp3'); a.song('good.mp3')
    a.service.scan()
    got = claim(a)
    bad, good = got['job']['input']['items']
    result = submit(a, got, [measurement(bad, **{field: value}), measurement(good)])
    assert [r['status'] for r in result['items']] == [422, 200]
    assert a.repo.get(bad['relPath'])['error'] == 'invalid-result'
    assert a.repo.get(good['relPath'])['key'] == '5A'
    job = a.ledger.list()[0]
    assert job['state'] == 'partial' and job['succeeded'] == 1 and job['failed'] == 1
    failed = next(r for r in a.service.queue.rows(('analysis',)) if r['relPath'] == bad['relPath'])
    assert failed['status'] == 'failed' and failed['attempts'] == 1
    assert a.service.claim(AGENT) is None  # Invalid measurements are final, with no retry.
    assert submit(a, got, [measurement(bad), measurement(good)]) == result


def test_failures_final_per_song_and_retry_budget(analysis):
    a = analysis
    a.song(); a.service.scan()
    got = claim(a)
    item = got['job']['input']['items'][0]
    result = submit(a, got, [{'relPath': item['relPath'], 'ok': False, 'error': 'undecodable', 'final': True}])
    assert result['accepted'] and a.repo.get(item['relPath'])['error'] == 'undecodable'
    assert a.service.scan() == 0
    assert a.service.summary()['failed'] == 1
    a.song('crash.mp3'); a.service.scan()
    for _attempt in range(3):
        got = claim(a)
        a.clock[0] += 601
        assert submit(a, got)['stop']
        a.service.reap()
    rows = [r for r in a.service.queue.rows(('analysis',)) if r['file'] == 'crash.mp3']
    assert rows[0]['attempts'] == 3 and rows[0]['status'] == 'failed'
    assert a.repo.get('Album/crash.mp3')['error']


def test_check_10_outdated_or_unlabelled_helper_refused_no_memory_floor(analysis):
    a = analysis
    a.song(); a.service.scan()
    assert a.service.claim(AGENT | {'labels': ['analysis>=0']}) is None
    assert a.service.claim(AGENT | {'labels': []}) is None
    assert a.service.claim(AGENT | {'labels': ['analysis>=2'], 'memoryBytes': 1})['job']


def test_check_12_stale_or_other_holder_cannot_apply(analysis):
    a = analysis
    a.song(); a.service.scan()
    got = claim(a)
    items = [measurement(i) for i in got['job']['input']['items']]
    assert a.service.result(got['job']['id'], got['lease'], items, 'stranger')['stop']
    assert a.service.result(got['job']['id'], 'old', items, 'device')['stop']
    assert a.repo.get('Album/song.mp3') is None


def test_check_15_foreign_tags_untouched(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = a.song(); put_tags(path)
    before = path.read_bytes()
    a.service.scan(); submit(a, claim(a))
    assert path.read_bytes() == before
    view = a.service.view('Album/song.mp3', path)
    assert view['key']['source'] == 'tag' and view['bpm']['value'] == 90


def test_check_16_own_tags_replaced_then_removed(analysis, monkeypatch):
    a = analysis
    a.config.write_analysis_tags = True
    path = a.song(); put_tags(path, marker=True)
    # Equivalent to ownership established by the migration/previous result.
    a.repo.mark_legacy_tags([('Album/song.mp3', path.stat().st_size, path.stat().st_mtime_ns)], '{}')
    a.service.scan(); submit(a, claim(a))
    assert analysis_tags(ID3(path))['key'] == '5A'
    path.write_bytes(path.read_bytes() + b'changed')
    monkeypatch.setattr(thresholds, 'BPM_CONFIDENCE_THRESHOLD', .95)
    monkeypatch.setattr(thresholds, 'KEY_CONFIDENCE_THRESHOLD', .95)
    a.service.scan(); submit(a, claim(a))
    assert all(analysis_tags(ID3(path))[f] is None for f in ('key', 'bpm', 'tag_owner'))
    assert a.service.scan() == 0


def test_check_17_correction_overwrites_without_marker_and_null_removes_owned_tag(analysis):
    a = analysis
    path = a.song(); put_tags(path, marker=True)
    a.config.write_analysis_tags = True
    ok, view = a.service.fix('Album/song.mp3', path, 0, {'key': '8B', 'bpm': 132}, 'owner')
    assert ok and view['fixed'] == {'key': '8B', 'bpm': 132}
    assert analysis_tags(ID3(path)) == {'bpm': 132, 'key': '8B', 'tag_owner': None}
    assert a.service.fix('Album/song.mp3', path, 1, {'key': None}, 'owner')[0]
    assert analysis_tags(ID3(path)) == {'bpm': 132, 'key': None, 'tag_owner': None}
    assert a.repo.get('Album/song.mp3')['fixed_bpm'] == 132
    assert a.music.scan_albums()[0].tracks[0].analysis['bpm_source'] == 'fixed'


def test_after_external_tag_edit_ownership_clears(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    path = a.song(); a.service.scan(); submit(a, claim(a))
    tags = ID3(path); tags.add(TBPM(encoding=3, text=['100'])); tags.save(path)
    assert a.music.get_track_info(path).bpm == 100
    assert a.repo.get('Album/song.mp3')['tag_owner'] is None
    before = path.read_bytes()
    a.service.scan(); submit(a, claim(a))
    assert path.read_bytes() == before


def test_tag_failure_keeps_committed_values(analysis, monkeypatch, caplog):
    a = analysis
    a.config.write_analysis_tags = True
    a.song(); a.service.scan()
    monkeypatch.setattr('app.domains.music.analysis_jobs.write_tags', Mock(side_effect=OSError('read-only')))
    assert submit(a, claim(a))['accepted']
    assert a.repo.get('Album/song.mp3')['key'] == '5A'
    assert 'Analysis tag write failed' in caplog.text
    assert a.service.scan() == 0


def test_summary_counts_and_boot_scan_single_pass(analysis, monkeypatch):
    a = analysis
    a.song('a.mp3'); a.song('b.mp3'); a.song('c.mp3')
    a.service.scan()
    got = claim(a)
    one, two, three = got['job']['input']['items']
    submit(a, got, [measurement(one), {'relPath': two['relPath'], 'ok': False, 'error': 'too-short', 'final': True},
                    {'relPath': three['relPath'], 'ok': False, 'error': 'engine-failed', 'final': False}])
    assert a.service.summary() == {'total': 3, 'analyzed': 1, 'outdated': 0, 'queued': 1, 'failed': 1, 'engineVersion': 2,
                                  'helper': {'online': True, 'name': 'Helper', 'working': False},
                                  'estimated': {'songs': 0, 'keys': 0, 'bpms': 0}, 'waiting': 0, 'run': None}
    a.song('boot.mp3')
    done = threading.Event()
    original = a.service.scan
    def scan(**kw):
        result = original(**kw); done.set(); return result
    monkeypatch.setattr(a.service, 'scan', scan)
    a.service.startup(); thread = a.service._thread; a.service.startup()
    assert a.service._thread is thread and done.wait(5)
    a.service.stop()
    assert a.service.summary()['total'] == 4 and a.service.summary()['queued'] == 2


@pytest.fixture
def api(analysis):
    from app.domains.user_library.scope import LibraryScope
    a = analysis
    path = a.song(folder='Artist/Album/CD1')
    rel = 'Artist∕Album/CD1∕song.mp3'
    app = FastAPI(); app.include_router(router)
    app.state.container = DependencyContainer(a.config)
    app.state.container._repositories["music_repository"] = a.music
    app.state.container._services.update(analysis_repository=a.repo, jobs=a.ledger)
    app.dependency_overrides[get_analysis_service] = lambda: a.service
    app.dependency_overrides[get_library_scope] = lambda: LibraryScope(frozenset({rel}))
    app.dependency_overrides[require_owner] = lambda: Principal('owner', 'Owner', 'owner')
    return SimpleNamespace(client=TestClient(app), app=app, path=path, rel=rel)


def test_check_5_conflict_carries_current_row_and_null_clears_one_field(analysis, api):
    client, url = api.client, '/api/analysis/' + api.rel
    first = client.put(url + '/fixed', json={'key': '2A', 'bpm': 132, 'rev': 0})
    assert first.status_code == 200, first.text
    conflict = client.put(url + '/fixed', json={'key': '3A', 'rev': 0})
    assert conflict.status_code == 409 and conflict.json() == first.json()
    cleared = client.put(url + '/fixed', json={'key': None, 'rev': 1})
    assert cleared.status_code == 200 and cleared.json()['fixed'] == {'key': None, 'bpm': 132}
    assert analysis.repo.get(api.rel)['rev'] == 2
    assert api.path.read_bytes() == FRAME
    for body in ({'key': '13A', 'rev': 2}, {'bpm': 19, 'rev': 2}):
        assert client.put(url + '/fixed', json=body).status_code == 422


def test_check_6_scope_and_summary_etag(api):
    from app.domains.user_library.scope import LibraryScope
    url = '/api/analysis/' + api.rel
    assert api.client.get(url).status_code == 200
    api.app.dependency_overrides[get_library_scope] = lambda: LibraryScope(frozenset())
    missing = api.client.get('/api/analysis/Album/missing.mp3')
    assert api.client.get(url).status_code == missing.status_code == 404
    assert api.client.get(url).json() == missing.json()
    for rel in ('..∕escape/song.mp3', 'Album/..∕escape.mp3'):
        assert api.client.get('/api/analysis/' + rel).status_code == 404
    response = api.client.get('/api/analysis/summary')
    assert response.status_code == 200
    assert api.client.get('/api/analysis/summary', headers={'If-None-Match': response.headers['etag']}).status_code == 304
    from fastapi import HTTPException
    def member():
        raise HTTPException(403, 'owner-required')
    api.app.dependency_overrides[require_owner] = member
    assert api.client.put(url + '/fixed', json={'rev': 0, 'key': '2A'}).status_code == 403
    assert api.client.get('/api/analysis/summary').status_code == 403


@pytest.mark.parametrize('suffix', ['.flac', '.ogg'])
def test_vorbis_writeback_and_correction(analysis, suffix, write_audio):
    a = analysis
    path = a.config.base_music_dir / 'Album' / ('song' + suffix)
    path.parent.mkdir()
    write_audio(path, [0.] * 8000, 8000)
    a.config.write_analysis_tags = True
    a.service.scan(); submit(a, claim(a))
    from mutagen import File
    tags = analysis_tags(File(path).tags)
    assert tags == {'key': '5A', 'bpm': 123.5, 'tag_owner': 'krobi'}
    rel = 'Album/' + path.name
    assert a.service.scan() == 0
    assert a.service.fix(rel, path, 0, {'bpm': 132, 'key': '2A'}, 'owner')[0]
    assert analysis_tags(File(path).tags) == {'key': '2A', 'bpm': 132, 'tag_owner': None}
    assert a.service.scan() == 0


def test_unsupported_correction_is_store_only(analysis):
    a = analysis
    path = a.song('song.m4a')
    a.config.write_analysis_tags = True
    assert a.service.fix('Album/song.m4a', path, 0, {'key': '2A'}, 'owner')[0]
    assert path.read_bytes() == FRAME


def test_foreign_field_survives_sibling_write_and_marker(analysis):
    a = analysis
    path = a.song()
    tags = ID3(); tags.add(TBPM(encoding=3, text=['90'])); tags.save(path)
    a.config.write_analysis_tags = True
    a.service.scan(); submit(a, claim(a))
    tags = analysis_tags(ID3(path))
    assert tags['bpm'] == 90 and tags['key'] == '5A' and tags['tag_owner'] == 'krobi'
    view = a.service.view('Album/song.mp3', path)
    assert view['bpm']['source'] == 'tag' and view['bpm']['value'] == 90
    assert view['key']['source'] == 'computed'
    assert a.service.scan() == 0
    tags = ID3(path); tags.add(TKEY(encoding=3, text=['2A'])); tags.save(path)
    assert a.service.view('Album/song.mp3', path)['key']['source'] == 'tag'
    assert a.service.view('Album/song.mp3', path)['key']['value'] == '2A'


def test_superseded_first_item_does_not_fence_unchanged_batch_siblings(analysis):
    a = analysis
    paths = [a.song(f'{i}.mp3') for i in range(3)]
    a.service.scan(); got = claim(a)
    paths[0].write_bytes(paths[0].read_bytes() + b'changed')
    assert a.service.scan() == 1
    result = submit(a, got)
    assert result['accepted'] and result['items'][0]['dropped']
    assert a.repo.get('Album/0.mp3') is None
    assert a.repo.get('Album/1.mp3')['key'] == a.repo.get('Album/2.mp3')['key'] == '5A'
    assert a.service.summary()['queued'] == 1


def test_summary_counts_only_older_engine_outdated_category(analysis):
    a = analysis
    names = ('current', 'older', 'changed', 'failed', 'missing', 'future', 'unknown')
    paths = {name: a.song(f'{name}.mp3') for name in names}
    a.service.scan()
    submit(a, claim(a))
    with a.repo.connection() as db:
        db.execute("UPDATE track_analysis SET engine_version=1 WHERE rel_path NOT LIKE '%current.mp3'")
        db.execute("UPDATE track_analysis SET engine_version=NULL WHERE rel_path LIKE '%unknown.mp3'")
        db.execute("UPDATE track_analysis SET engine_version=3 WHERE rel_path LIKE '%future.mp3'")
        db.execute("UPDATE track_analysis SET error='failed' WHERE rel_path LIKE '%failed.mp3'")
        db.execute("UPDATE track_analysis SET missing_since='2026-01-01' WHERE rel_path LIKE '%missing.mp3'")
    older = a.repo.get('Album/older.mp3')
    a.service.fix('Album/older.mp3', paths['older'], older['rev'], {'key': '2A'}, 'owner')
    paths['changed'].write_bytes(paths['changed'].read_bytes() + b'changed')
    before = a.repo.revision, a.ledger.version
    summary = a.service.summary()
    assert summary['outdated'] == 1
    assert summary['total'] == 6 and summary['analyzed'] == 1
    assert (a.repo.revision, a.ledger.version) == before
