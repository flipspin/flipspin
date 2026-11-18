"""Health composes published facts; a poll must never inspect library files."""
from datetime import UTC, datetime, timedelta
import os
from unittest.mock import Mock, patch

import pytest

from app.domains.metadata import tagwriter
from tests.integration.test_analysis import house as house, FRAME
from tests.integration.test_wire_snapshots import assert_matches_snapshot

URL = '/api/library/health'
AT = '2026-11-01T12:00:00+00:00'


def prepare(h):
    health = h.container.get_library_health()
    music = h.container.get_music_repository()
    tagwriter.write(h.path, {'title': 'Song (Remastered 2009)', 'artist': 'Artist', 'album': 'Album'}, expected=tagwriter.identity(h.path))
    other = h.path.with_name('matched.mp3')
    other.write_bytes(FRAME)
    tagwriter.write(other, {'title': 'Live (Live)', 'mbRecording': 'a-recording'}, expected=tagwriter.identity(other))
    music.refresh(reason='fixture')
    return health, music


def checks(body):
    return {c['id']: c for c in body['checks']}


def test_owner_only_and_no_work_on_poll(house, monkeypatch):
    health, music = prepare(house)
    monkeypatch.setattr(music, 'scan_albums', Mock(side_effect=AssertionError('scan')))
    monkeypatch.setattr(music, 'read_tags', Mock(side_effect=AssertionError('tags')))
    monkeypatch.setattr(health.missing, 'rows', Mock(side_effect=AssertionError('listing')))
    monkeypatch.setattr(health.backups, 'latest', Mock(side_effect=AssertionError('backup I/O')))
    from pathlib import Path
    original = Path.stat
    def guard(path, *args, **kwargs):
        assert not path.is_relative_to(music.config.base_music_dir), 'library stat'
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'stat', guard)
    for _ in range(2):
        assert house.admin.get(URL).status_code == 200
    assert house.member.get(URL).status_code == 403
    assert house.admin.get(URL, headers={'Authorization': 'Bearer invalid'}).status_code == 401


def test_stored_checks_and_stats(house):
    health, music = prepare(house)
    body = house.admin.get(URL).json()
    found = checks(body)
    assert 'unreadable' not in found
    assert found['remaster']['count'] == 1
    assert found['remaster']['tracks'][0]['relPath'] == 'Album/song.mp3'
    assert found['unmatched']['count'] == found['unmatched']['songs'] == 1
    assert found['estimates']['count'] == 0
    assert found['duplicates']['state'] == 'unavailable'
    assert body['stats']['songs']['value'] == 2 and body['stats']['albums']['value'] == 1
    assert body['stats']['addedThisWeek']['value'] == 2
    assert body['stats']['lastScanAt']['value'] == music.scans.completed_at
    house.path.unlink()
    music.refresh(reason='fixture-removal')
    missing = checks(house.admin.get(URL).json())['missing']
    assert (missing['count'], missing['folders'], missing['topFolder']) == (1, 1, 'Album')
    assert missing['count'] == len(health.missing.rows()['rows'])
    # The rolling date window expires without any new scan.
    assert health.snapshot(datetime.now(UTC) + timedelta(days=8))['stats']['addedThisWeek']['value'] == 0


def test_added_this_week_uses_scan_arrival_despite_tag_writes_and_old_mtime(house):
    health = house.container.get_library_health()
    music = health.music
    before_tracking = datetime.now(UTC) - timedelta(days=30)
    os.utime(house.path, (before_tracking.timestamp(), before_tracking.timestamp()))
    first_scan = datetime.now(UTC) - timedelta(days=8)
    with patch('app.domains.music.library_scan.datetime', wraps=datetime) as clock:
        clock.now.return_value = first_scan
        music.refresh(reason='old-arrival')
    assert house.admin.get(URL).json()['stats']['addedThisWeek']['value'] == 0

    date_added = music.first_seen.get(house.path)
    mtime_ns = house.path.stat().st_mtime_ns
    tagwriter.write(house.path, {'key': '5A'}, expected=tagwriter.identity(house.path))
    music.refresh(reason='tag-write')
    assert house.path.stat().st_mtime_ns == mtime_ns
    assert house.admin.get(URL).json()['stats']['addedThisWeek']['value'] == 0
    # Listing dates come from durable first-seen records, independently of health arrivals.
    listing = house.admin.get('/api/listar-albums-con-metadata?covers=false').json()
    assert listing[0]['tracks'][0]['dateAdded'] == date_added

    new = house.path.with_name('new.mp3')
    new.write_bytes(FRAME)
    os.utime(new, (before_tracking.timestamp(), before_tracking.timestamp()))
    music.refresh(reason='new-arrival')
    stat = house.admin.get(URL).json()['stats']['addedThisWeek']
    assert stat['value'] == 1 and stat['state'] == 'ready'
    assert stat['source']['store'] == 'music-scan.tags.first_seen'
    assert health.snapshot(datetime.now(UTC) + timedelta(days=8))['stats']['addedThisWeek']['value'] == 0


@pytest.mark.parametrize('first_seen', [None, datetime(2020, 1, 1, tzinfo=UTC).timestamp()])
@pytest.mark.parametrize('target_scanned', [False, True])
def test_linked_move_preserves_first_seen(house, first_seen, target_scanned):
    health = house.container.get_library_health()
    music = health.music
    music.refresh()
    with music.scans.store.connection() as db:
        db.execute('UPDATE tags SET first_seen=? WHERE path=?', (first_seen, str(house.path)))
    target = house.path.with_name('moved.mp3')
    house.path.rename(target)
    if target_scanned:
        music.refresh(reason='moved')
    missing_url = '/api/library/missing'
    assert house.admin.get(missing_url).json()['rows'][0]['movedTo'] == 'Album/moved.mp3'
    match = house.admin.post(missing_url + '/preview', json={
        'relPaths': ['Album/song.mp3'], 'target': 'Album/moved.mp3',
    }).json()['rows'][0]
    response = house.admin.post(missing_url + '/apply', json={
        'rows': [{k: match[k] for k in ('relPath', 'target', 'rev')}],
    })
    assert response.status_code == 200 and response.json()['rows'][0]['state'] == 'applied'
    music.refresh(reason='linked-move')
    with music.scans.store.connection() as db:
        assert db.execute('SELECT first_seen FROM tags WHERE path=?', (str(target),)).fetchone()[0] == first_seen
    assert house.admin.get(URL).json()['stats']['addedThisWeek']['value'] == 0


def test_legacy_health_snapshot_never_counts_cached_mtimes(house):
    health, music = prepare(house)
    cached = music.scans.store.health(music.config.base_music_dir)
    cached.pop('firstSeen')
    cached['added'] = [datetime.now(UTC).timestamp()] * 2
    music.scans.store.save_health(music.config.base_music_dir, cached)
    assert health.snapshot()['stats']['addedThisWeek']['value'] == 0


def test_estimates_use_analysis_precedence(house):
    health, music = prepare(house)
    path = house.path
    house.service.repository.apply('Album/song.mp3', {
        'size': path.stat().st_size, 'mtime_ns': path.stat().st_mtime_ns,
        'engine': 'keyfinder+tempocnn', 'engine_version': 2,
        'key': '5A', 'key_conf': 0, 'bpm': 123, 'bpm_conf': .1,
        'energy': 0, 'brightness': 0, 'pulse': 0,
    }, None)
    music.refresh(reason='analysis')
    estimate = checks(house.admin.get(URL).json())['estimates']
    assert (estimate['count'], estimate['keys'], estimate['bpms']) == (1, 1, 1)
    assert house.service.summary()['estimated'] == {'songs': 1, 'keys': 1, 'bpms': 1}
    house.service.repository.fix('Album/song.mp3', 0, {'key': '5A', 'bpm': 123}, 'owner')
    music.refresh(reason='correction')
    assert checks(house.admin.get(URL).json())['estimates']['count'] == 0


def test_duplicate_groups_exclude_dismissed_pairs(house):
    health, _ = prepare(house)
    def file(rel, fingerprint=None):
        return {'relPath': rel, 'title': 'Song', 'artist': 'Artist', 'album': 'Album', 'duration': 10,
                'format': 'FLAC', 'bitrate': 1000, 'signature': '1:1', 'missing': False, 'plays': 0, 'fingerprint': fingerprint}
    root = str(health.music.config.base_music_dir.resolve())
    health.duplicates.store_scan(root, 'job', {'checked': True, 'checkedAt': AT,
        'candidates': [[file('Album/a.flac', 'fp'), file('Album/b.flac', 'fp')], [file('Other/a.flac'), file('Other/b.flac')]]})
    found = checks(house.admin.get(URL).json())['duplicates']
    assert (found['count'], found['sameAudio'], found['sameTags']) == (2, 1, 1)
    assert found['source']['asOf'] == AT
    health.duplicates.prefer(root, 'Album/a.flac', 'Album/b.flac', dismissed=True)
    assert checks(house.admin.get(URL).json())['duplicates']['count'] == 1


def test_source_failure_and_new_root_never_look_clear(house, monkeypatch):
    health, music = prepare(house)
    monkeypatch.setattr(health.missing, 'known', Mock(side_effect=OSError('source')))
    music.refresh(reason='fixture')
    assert checks(house.admin.get(URL).json())['missing']['reason'] == 'source-failed'
    monkeypatch.setattr(health.duplicates, 'scan', Mock(side_effect=OSError('source')))
    assert checks(house.admin.get(URL).json())['duplicates']['reason'] == 'source-failed'
    music.config.base_music_dir = music.config.base_music_dir / 'Changed'
    body = house.admin.get(URL).json()
    assert body['stats']['songs']['value'] is None
    assert all(c['state'] == 'unavailable' for c in body['checks'])


def test_backups_are_sampled_off_request_path(house, monkeypatch):
    health, _ = prepare(house)
    monkeypatch.setattr(health.backups, 'latest', lambda: {'stamp': '20261101T120000.000000Z'})
    health.backups.refresh_health()
    stat = house.admin.get(URL).json()['stats']['lastBackupAt']
    assert stat['value'] == AT and stat['state'] == 'ready'
    monkeypatch.setattr(health.backups, 'latest', Mock(side_effect=OSError('offline')))
    health.backups.refresh_health()
    assert house.admin.get(URL).json()['stats']['lastBackupAt']['reason'] == 'source-failed'


def test_health_wire(house):
    health, music = prepare(house)
    music.scans.completed_at = AT
    body = house.admin.get(URL).json()
    body['checkedAt'] = AT
    for stat in body['stats'].values():
        stat['source']['asOf'] = AT
    for check in body['checks']:
        check['source']['asOf'] = AT
    assert_matches_snapshot('library-health', body)


@pytest.mark.parametrize('title,expected', [
    ('Song (Remastered 2009)', True), ('Song - 2011 Remaster', True), ('Song [Re-master]', True),
    ('Song (Live)', False), ('Song (Remix)', False), ('Remaster the world', False), ('Song (feat. Remaster)', False),
])
def test_remaster_rule(title, expected):
    from app.domains.metadata.normalization import has_remaster_suffix
    assert has_remaster_suffix(title) is expected


def test_missing_release_id_is_still_an_unmatched_album(house):
    health, music = prepare(house)
    tagwriter.write(house.path, {'mbRecording': 'recording'}, expected=tagwriter.identity(house.path))
    music.refresh(reason='recordings-matched')
    unmatched = checks(house.admin.get(URL).json())['unmatched']
    assert unmatched['songs'] == 0 and unmatched['count'] == 1 and unmatched['albumKeys'] == ['Album']
    for path in house.path.parent.glob('*.mp3'):
        tagwriter.write(path, {'mbRelease': 'release'}, expected=tagwriter.identity(path))
    music.refresh(reason='release-matched')
    assert checks(house.admin.get(URL).json())['unmatched']['count'] == 0


def test_failed_snapshot_read_and_publication_report_unavailable(house, monkeypatch):
    health, music = prepare(house)
    with monkeypatch.context() as patch:
        patch.setattr(music.scans.store, 'health', Mock(side_effect=OSError('store')))
        body = house.admin.get(URL).json()
        assert body['stats']['songs']['reason'] == 'source-failed'
        assert checks(body)['remaster']['state'] == 'unavailable'
    monkeypatch.setattr(music.scans.store, 'save_health', Mock(side_effect=OSError('store')))
    music.refresh(reason='health-failed')
    assert music.scans.health_error == 'source-failed'
    assert checks(house.admin.get(URL).json())['estimates']['state'] == 'unavailable'


def test_existing_ignored_files_are_not_missing_and_titles_never_come_from_filenames(house):
    health = house.container.get_library_health()
    music = house.container.get_music_repository()
    path = house.path.with_name('Song (Remastered 2009).mp3')
    house.path.rename(path)
    music.refresh(reason='untagged')
    assert checks(house.admin.get(URL).json())['remaster']['count'] == 0
    hidden = house.path.with_name('.hidden.mp3')
    hidden.write_bytes(FRAME)
    house.container.get_user_track_store().add_many(house.member_id, ['Album/.hidden.mp3'])
    music.refresh(reason='ignored')
    missing = checks(house.admin.get(URL).json())['missing']
    assert missing['count'] == len(health.missing.rows()['rows']) == 0


def test_duplicate_snapshot_uses_the_scanned_canonical_root(house):
    health, music = prepare(house)
    health.duplicates.store_scan(str(music.config.base_music_dir.resolve()), 'job', {'checked': True, 'checkedAt': AT, 'candidates': []})
    alias = music.config.base_music_dir.with_name('Alias')
    alias.symlink_to(music.config.base_music_dir, target_is_directory=True)
    music.config.base_music_dir = alias
    music.refresh(reason='root-alias')
    duplicate = checks(house.admin.get(URL).json())['duplicates']
    assert duplicate['state'] == 'ready' and duplicate['count'] == 0


def test_first_poll_does_not_initialize_the_filesystem_listing(house, monkeypatch):
    monkeypatch.setattr('app.domains.music.missing_files.MissingFiles.__init__', Mock(side_effect=AssertionError('filesystem listing initialized on request')))
    body = house.admin.get(URL)
    assert body.status_code == 200
    assert checks(body.json())['missing']['state'] == 'unavailable'
