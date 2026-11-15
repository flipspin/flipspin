"""Duplicate jobs use owner gates, persist pair choices, and never alter audio."""
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from mutagen.id3 import ID3, TALB, TIT2, TPE1

from tests.integration.test_analysis import house as house, FRAME
from app.domains.music.duplicate_service import DuplicateService

BASE = '/api/library/duplicates'


@pytest.fixture
def duplicates(house, monkeypatch):
    h = house
    h.path.unlink()
    for idx in range(3):
        path = h.path.with_name(f'{idx}.mp3')
        path.write_bytes(FRAME)
        tags = ID3(); tags.add(TIT2(text=['Song'])); tags.add(TPE1(text=['Artist'])); tags.add(TALB(text=['Album'])); tags.save(path)
    monkeypatch.setattr('app.domains.music.duplicate_service.shutil.which', lambda _: None)
    h.duplicates = h.container.get_duplicate_service()
    return h


def scan(h):
    response = h.admin.post(BASE + '/scan')
    assert response.status_code == 202, response.text
    result = h.admin.get(BASE).json()
    assert response.json()['jobId'] == result['jobId']
    assert result['state'] == 'succeeded', result
    return result


def test_show_only_differences_plays_keep_dismiss_restart_and_rescan(duplicates):
    h = duplicates
    originals = {p: p.read_bytes() for p in h.path.parent.glob('*.mp3')}
    store = h.container.get_user_track_store()
    store.add_many(h.member_id, ['Album/0.mp3'])
    store.record_play(h.member_id, 'Album/0.mp3')
    result = scan(h)
    assert result['audio'] == 'unavailable' and result['audioSkipped'] == 0
    group = result['groups'][0]
    assert group['basis'] == 'tags' and len(group['files']) == 3
    assert next(f for f in group['files'] if f['relPath'] == 'Album/0.mp3')['plays'] == 1
    selected = 'Album/0.mp3' if group['keeper'] != 'Album/0.mp3' else 'Album/1.mp3'
    changed = h.admin.put(BASE + '/' + group['groupId'] + '/keeper', json={'keep': selected})
    assert changed.status_code == 200 and changed.json()['groups'][0]['keeper'] == selected
    assert scan(h)['groups'][0]['keeper'] == selected
    # Recompose against the same persisted music store and job ledger.
    fresh = DuplicateService(h.container.config, h.container.get_music_repository(), h.container.get_analysis_repository(),
                             h.container.get_progress_tracker(), store)
    assert fresh.view()['groups'][0]['keeper'] == selected
    url = BASE + '/' + fresh.view()['groups'][0]['groupId'] + '/dismiss'
    assert h.admin.post(url).json()['groups'] == []
    assert h.admin.post(url).json()['groups'] == []
    assert scan(h)['groups'] == []
    assert fresh.view()['groups'] == []
    with h.container.get_analysis_repository().connection() as db:
        assert db.execute('SELECT count(*) FROM duplicate_pair WHERE dismissed=1').fetchone()[0] == 3
    assert {p: p.read_bytes() for p in originals} == originals
    assert h.admin.delete(BASE + '/' + group['groupId'] + '/keeper').status_code == 405


@pytest.mark.parametrize('method,path,body', [
    ('get', '', None), ('post', '/scan', None), ('put', '/group/keeper', {'keep': 'Album/0.mp3'}), ('post', '/group/dismiss', None),
])
def test_members_and_anonymous_cannot_read_or_start_work(duplicates, method, path, body):
    h = duplicates
    kwargs = {'json': body} if body is not None else {}
    assert getattr(h.member, method)(BASE + path, **kwargs).status_code == 403
    assert getattr(h.admin, method)(BASE + path, headers={'Authorization': 'Bearer invalid'}, **kwargs).status_code == 401
    assert h.duplicates.view()['state'] == 'idle'


def test_missing_changed_files_and_invalid_paths_never_become_keeper(duplicates):
    h = duplicates
    group = scan(h)['groups'][0]
    selected = group['keeper']
    path = h.container.config.base_music_dir / selected
    path.unlink()
    view = h.admin.get(BASE).json()['groups'][0]
    assert view['keeper'] != selected and next(f for f in view['files'] if f['relPath'] == selected)['missing']
    for keep in (selected, '../escape.mp3', '/outside.mp3', 'not-in-group.mp3'):
        assert h.admin.put(BASE + '/' + group['groupId'] + '/keeper', json={'keep': keep}).status_code == 409
    assert h.admin.post(BASE + '/stale/dismiss').status_code == 409
    for file in h.path.parent.glob('*.mp3'):
        file.unlink()
    assert h.admin.get(BASE).json()['groups'] == []


def test_start_is_cheap_deduplicated_and_registered_before_background_work(duplicates, monkeypatch):
    h = duplicates
    monkeypatch.setattr(h.duplicates.music, 'album_files', Mock(side_effect=AssertionError('request touched disk')))
    with ThreadPoolExecutor(2) as pool:
        starts = list(pool.map(lambda _: h.duplicates.start(), range(2)))
    assert starts[0][0] == starts[1][0] and sum(s[2] for s in starts) == 1
    job = h.container.get_jobs().get(starts[0][0])
    assert job['kind'] == 'scan' and job['state'] == 'queued'
    # GET is read-only and cannot invoke discovery.
    assert h.admin.get(BASE).status_code == 200


def test_optional_fpcalc_audio_level_signature_cache_failure_and_versions(duplicates, monkeypatch):
    h = duplicates
    monkeypatch.setattr('app.domains.music.duplicate_service.shutil.which', lambda _: 'fpcalc')
    run = Mock(return_value=SimpleNamespace(stdout=json.dumps({'fingerprint': 'same-recording'}).encode()))
    monkeypatch.setattr('app.domains.music.duplicate_service.subprocess.run', run)
    first = scan(h)
    assert first['audio'] == 'available' and first['groups'][0]['basis'] == 'audio'
    assert run.call_count == 3
    scan(h)
    assert run.call_count == 3
    path = h.path.with_name('0.mp3')
    tags = ID3(path); tags.add(TIT2(text=['Song (Live)'])); tags.save(path)
    view = scan(h)
    assert run.call_count == 4 and len(view['groups'][0]['files']) == 2
    command = run.call_args.args[0]
    assert command[:4] == ['fpcalc', '-json', '-length', '120'] and run.call_args.kwargs['timeout'] == 30
    path = h.path.with_name('1.mp3')
    path.write_bytes(path.read_bytes() + b'changed')
    run.side_effect = OSError('unavailable')
    assert scan(h)['audioSkipped'] == 1


def test_library_root_switch_failure_and_external_symlink(duplicates, monkeypatch, tmp_path):
    h = duplicates
    scan(h)
    old_root = h.container.config.base_music_dir
    outside = tmp_path / 'outside.mp3'; outside.write_bytes(FRAME)
    (old_root / 'Album/external.mp3').symlink_to(outside)
    assert sum(len(g['files']) for g in scan(h)['groups']) == 3
    h.container.config.base_music_dir = tmp_path / 'other'
    assert h.admin.get(BASE).json()['groups'] == []
    h.admin.post(BASE + '/scan')
    assert h.admin.get(BASE).json()['state'] == 'failed'
    h.container.config.base_music_dir = old_root
    assert len(h.admin.get(BASE).json()['groups']) == 1


def test_cancelled_job_cannot_publish_over_the_next_scan(duplicates, monkeypatch):
    h = duplicates
    original = scan(h)
    job_id, root, _ = h.duplicates.start()
    ledger = h.container.get_jobs()
    ledger.cancel(job_id, 1)
    next_id, _, created = h.duplicates.start()
    assert created and next_id != job_id
    h.duplicates.run(job_id, root)
    view = h.duplicates.view()
    assert view['jobId'] == next_id and view['groups'] == original['groups']
    assert ledger.get(job_id)['state'] == 'cancelled'
    h.duplicates.run(next_id, root)
    assert h.duplicates.view()['state'] == 'succeeded'


@pytest.mark.parametrize('output', ['not-json', '[]', 'null', '{}', '{"fingerprint": 17}'])
def test_invalid_fingerprint_output_only_skips_audio_not_tags(duplicates, monkeypatch, output):
    h = duplicates
    monkeypatch.setattr('app.domains.music.duplicate_service.shutil.which', lambda _: 'fpcalc')
    monkeypatch.setattr('app.domains.music.duplicate_service.subprocess.run', lambda *a, **kw: SimpleNamespace(stdout=output))
    result = scan(h)
    assert result['audioSkipped'] == 3
    assert result['groups'][0]['basis'] == 'tags'


def test_fpcalc_timeout_only_skips_audio_and_can_be_retried(duplicates, monkeypatch):
    h = duplicates
    monkeypatch.setattr('app.domains.music.duplicate_service.shutil.which', lambda _: 'fpcalc')
    run = Mock(side_effect=subprocess.TimeoutExpired('fpcalc', 30))
    monkeypatch.setattr('app.domains.music.duplicate_service.subprocess.run', run)
    assert scan(h)['audioSkipped'] == 3
    assert scan(h)['audioSkipped'] == 3
    assert run.call_count == 6


def test_result_survives_job_history_retention(duplicates, monkeypatch):
    h = duplicates
    result = scan(h)
    monkeypatch.setattr(h.container.get_jobs(), 'get', lambda _: None)
    view = h.admin.get(BASE).json()
    assert view['state'] == 'succeeded' and view['groups'] == result['groups']
