"""First-seen survives real writers and is shared by all catalog projections."""
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from mutagen.id3 import ID3, TIT2

from app.domains.metadata import tagwriter
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.domains.subsonic import ids
from tests.integration.test_analysis import house as house, CLAIM, result_item
from tests.integration.test_musicbrainz_match import match as match, start, plan, apply

CASES = json.loads((Path(__file__).parents[3] / 'contracts/library-date-added.json').read_text())['cases']


def projections(h, path=None):
    path = path or h.path
    repo = h.container.get_music_repository()
    repo.refresh()
    response = h.admin.get('/api/listar-albums-con-metadata?covers=false')
    assert response.status_code == 200
    track = next(t for album in response.json() for t in album['tracks'] if t['path'] == str(path))
    playlist = h.admin.get('/api/playlists/Arrival')
    assert playlist.status_code == 200, playlist.text
    rel = repo.get_track_info(path)
    from app.utils.library_paths import rel_path_for
    token = h.admin.headers['Authorization'].split(' ', 1)[1]
    subsonic = h.admin.get('/rest/getSong', params={
        'f': 'json', 'v': '1.16.1', 'c': 'test', 'apiKey': token,
        'id': ids.make(ids.SONG, rel_path_for(repo.config.base_music_dir, path)),
    }).json()['subsonic-response']
    assert subsonic['status'] == 'ok', subsonic
    return track['dateAdded'], playlist.json()['tracks'][0]['dateAdded'], subsonic['song']['created'], rel.date_added


def seed(h, stamp):
    repo = h.container.get_music_repository()
    repo.first_seen.get(h.path, receipt=stamp)
    h.container.get_playlist_repository().save_playlist(Playlist(name='Arrival', tracks=[
        PlaylistTrack(path=h.path, title='Song', date_added=stamp + 1000),
    ]))
    return repo


@pytest.mark.parametrize('writer', ['tag-edit', 'match-apply', 'analysis', 'replaygain'])
def test_all_writers_keep_dates_and_file_times(match, writer, monkeypatch):
    h = match
    stamp = CASES[0]['before']
    seed(h, stamp)
    expected = projections(h)
    assert expected == (stamp, stamp, datetime.fromtimestamp(int(stamp), UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), stamp)
    writes = []
    original_write = tagwriter.write
    def checked_write(path, *args, **kwargs):
        before_write = path.stat()
        result = original_write(path, *args, **kwargs)
        after_write = path.stat()
        assert (after_write.st_atime_ns, after_write.st_mtime_ns) == (before_write.st_atime_ns, before_write.st_mtime_ns)
        writes.append(result[2])
        return result
    monkeypatch.setattr(tagwriter, 'write', checked_write)
    # Use a clearly different file timestamp; no projection may inherit it.
    os.utime(h.path, ns=(1111111111000000000, 1888888888123456789))
    if writer in ('analysis', 'replaygain'):
        h.service.config.write_analysis_tags = True
        h.service.scan()
        claim = h.helper.post('/api/helpers/claim', json=CLAIM).json()
        before = h.path.stat()
        items = [result_item(i) for i in claim['job']['input']['items']]
        if writer == 'replaygain':
            items = [{**i, 'trackLufs': -12.0, 'truePeak': .8} for i in items]
        response = h.helper.post('/api/helpers/jobs/' + claim['job']['id'] + '/result', json={
            'lease': claim['lease'], 'items': items})
        assert response.status_code == 200 and response.json()['items'][0]['status'] == 200
        after = h.path.stat()
        tags = ID3(h.path)
        assert ('TXXX:REPLAYGAIN_TRACK_GAIN' in tags) if writer == 'replaygain' else ('TBPM' in tags)
    elif writer == 'match-apply':
        job, _ = start(h)
        proposal = plan(h, job, ['year', 'mbRecording']).json()
        before = h.path.stat()
        assert apply(h, proposal).status_code == 202
        after = h.path.stat()
        assert str(ID3(h.path)['TDRC']) == '1979'
    else:
        rev = h.admin.get('/api/library/tags/Album/song.mp3').json()['rev']
        before = h.path.stat()
        assert h.admin.put('/api/library/tags/Album/song.mp3', json={'rev': rev, 'set': {'title': 'Edited'}}).status_code == 200
        after = h.path.stat()
        assert str(ID3(h.path)['TIT2']) == 'Edited'
    assert after.st_mtime_ns == before.st_mtime_ns
    assert any(writes)
    assert projections(h) == expected
    assert expected[0] == CASES[0]['expected']
    # Even an external rewrite that changes mtime cannot change the durable date.
    os.utime(h.path, (1893456000, CASES[0]['fileMtimeAfter']))
    assert projections(h) == expected


def test_move_and_rename_keep_all_projections_and_restart(house):
    h = house
    stamp = CASES[1]['before']
    repo = seed(h, stamp)
    expected = projections(h)
    target = h.path.parent.with_name('Moved')
    moved = h.container.get_track_relocator().move(h.path, target, album_title='Moved')
    renamed = moved.with_name('renamed.mp3')
    moved.rename(renamed)
    h.container.get_track_relocator().repoint(moved, renamed, keep_lyric=True)
    os.utime(renamed, (1893456000, CASES[1]['fileMtimeAfter']))
    assert projections(h, renamed) == expected
    assert expected[0] == CASES[1]['expected']
    from app.domains.music.repositories import MusicRepository
    restarted = MusicRepository(repo.config, repo.logger)
    assert restarted.get_track_info(renamed).date_added == stamp


def test_same_size_tag_change_is_seen_by_scanner_and_drops_leased_analysis(house):
    h = house
    edits = h.container.get_tag_edits()
    edits.edit(h.path, {'title': 'Old'})
    edits.edit(h.path, {'title': 'One'})  # Remove initial ID3 padding before the equal-size mutation.
    repo = h.container.get_music_repository()
    repo.refresh()
    h.service.scan()
    claim = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    before = h.path.stat()
    edits.edit(h.path, {'title': 'New'})
    assert (h.path.stat().st_size, h.path.stat().st_mtime_ns) == (before.st_size, before.st_mtime_ns)
    assert repo.refresh()[0].tracks[0].title == 'New'
    response = h.helper.post('/api/helpers/jobs/' + claim['job']['id'] + '/result', json={
        'lease': claim['lease'], 'items': [result_item(i) for i in claim['job']['input']['items']]})
    assert response.json()['items'][0]['dropped'] is True
    assert h.service.queue.rows(('analysis',))[0]['status'] == 'queued'


def test_equal_stat_external_change_requeues_completed_analysis(house):
    h = house
    h.container.get_tag_edits().edit(h.path, {'title': 'Old'})
    h.service.scan()
    claim = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post('/api/helpers/jobs/' + claim['job']['id'] + '/result', json={
        'lease': claim['lease'], 'items': [result_item(i) for i in claim['job']['input']['items']]})
    before = h.path.stat()
    tags = ID3(h.path); tags.add(TIT2(encoding=3, text=['New'])); tags.save(h.path)
    os.utime(h.path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert h.path.stat().st_size == before.st_size
    assert h.service.scan() == 1
    assert tagwriter.read(h.path)['fields']['title'] == 'New'


def test_startup_backfills_before_publishing_and_logs_once(house, monkeypatch, caplog):
    from app.main import _library_scan_startup
    h = house
    ledger = h.container.get_jobs()
    ledger.now = lambda: 1234567890.5
    job = ledger.start('import', 'Import', [{'item': 'Song', 'detail': {'_path': str(h.path)}}])
    ledger.item_transition(job, 0, 1, 'running')
    ledger.item_transition(job, 0, 1, 'done')
    ledger.finish(job, 1)
    os.utime(h.path, (1900000000, 1900000000))
    repo = h.container.get_music_repository()
    monkeypatch.setattr(repo, 'start_scanner', lambda: None)
    _library_scan_startup()
    _library_scan_startup()
    assert repo.get_track_info(h.path).date_added == 1234567890.5
    assert caplog.text.count('Library first-seen backfill') == 1


@pytest.mark.asyncio
async def test_startup_saves_receipts_before_job_retention(house, monkeypatch):
    from app.main import _jobs_startup_sweep, _stop_job_maintenance
    h = house
    ledger = h.container.get_jobs()
    ledger.now = lambda: 1234567890.5
    job = ledger.start('import', 'Import', [{'item': 'Song', 'detail': {'_path': str(h.path)}}])
    ledger.item_transition(job, 0, 1, 'running')
    ledger.item_transition(job, 0, 1, 'done')
    ledger.finish(job, 1)
    ledger.clear_one(job)
    ledger.now = lambda: 2000000000
    repo = h.container.get_music_repository()
    def boot(container):
        ledger.retention()
        assert ledger.get(job) is None
        assert repo.first_seen.get(h.path) == 1234567890.5
    monkeypatch.setattr('app.infra.jobs_runtime.boot', boot)
    try:
        await _jobs_startup_sweep()
        assert repo.get_track_info(h.path).date_added == 1234567890.5
    finally:
        _stop_job_maintenance()
