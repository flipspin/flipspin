"""Missing review, recovery, absence guards and household reference undo."""
import shutil

import pytest

from app.domains.metadata import tagwriter
from app.domains.lyrics.models import LyricsRecord
from app.domains.playlists.models import Playlist, PlaylistTrack
from tests.integration.test_analysis import house as house, FRAME

URL = '/api/library/missing'
REL = 'Album/song.mp3'


def prepare(h):
    tagwriter.write(h.path, {'title': 'Song', 'album': 'Album'}, expected=tagwriter.identity(h.path))
    music = h.container.get_music_repository()
    music.scan_albums()
    h.container.get_user_track_store().add_many(h.member_id, [REL])
    h.service.repository.fix(REL, 0, {'key': '2A', 'bpm': 132}, 'owner')
    other = h.path.parent.parent / 'Other' / 'other.mp3'
    other.parent.mkdir(exist_ok=True)
    other.write_bytes(FRAME + b'\0')
    h.container.get_missing_files()
    return music, other


def test_owner_gates_grouping_references_and_etag(house):
    h = house
    music, _ = prepare(h)
    playlists = h.container.get_playlist_repository()
    playlists.save_playlist(Playlist('Evening', [PlaylistTrack(h.path, 'Song')]))
    h.path.unlink()
    music.analysis.sweep(h.path.parent.parent)
    first = h.admin.get(URL)
    assert first.status_code == 200, first.text
    body = first.json()
    assert body['libraryAvailable'] is True
    row = body['rows'][0]
    assert row['cause'] == 'file' and row['references']['corrections'] == ['key', 'bpm']
    assert row['references']['accounts'] == [{'id': h.member_id, 'name': 'Member'}]
    assert row['references']['playlists'] == ['Evening'] and row['missingSince']
    assert h.admin.get(URL, headers={'If-None-Match': first.headers['etag']}).status_code == 304
    h.path.parent.rmdir()
    row = h.admin.get(URL).json()['rows'][0]
    assert (row['cause'], row['folder']) == ('folder', 'Album')
    assert h.member.get(URL).status_code == 403
    for action, body in [('remove', {'relPaths': [REL]}), ('preview', {'relPaths': [REL], 'folder': 'Other'}),
                         ('apply', {'rows': [{'relPath': REL, 'target': 'Other/other.mp3', 'rev': 'x'}]})]:
        assert h.member.post(URL + '/' + action, json=body).status_code == 403
    assert h.member.get('/api/me/library/missing').json()['relPaths'] == [REL]


@pytest.mark.parametrize('state', ['absent', 'empty', 'unreadable', 'device'])
def test_unavailable_root_refuses_even_with_large_confirmation(house, monkeypatch, state):
    h = house
    _, other = prepare(h)
    h.path.unlink()
    service = h.container.get_missing_files()
    if state == 'absent':
        shutil.rmtree(h.path.parent.parent)
    elif state == 'empty':
        other.unlink()
    elif state == 'unreadable':
        monkeypatch.setattr('app.domains.music.missing_files.discover', lambda *_: (_ for _ in ()).throw(PermissionError()))
    else:
        service.devices[str(service.base)] = -1
    response = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True})
    assert response.status_code == 409 and response.json()['detail']['reason'] == 'library-unavailable'
    assert h.container.get_user_track_store().get(h.member_id, REL)
    assert h.service.repository.get(REL)['fixed_key'] == '2A'


def test_large_confirmation_restore_at_write_and_repeat(house):
    h = house
    _, _ = prepare(h)
    content = h.path.read_bytes()
    h.path.unlink()
    response = h.admin.post(URL + '/remove', json={'relPaths': [REL]})
    assert response.status_code == 409 and response.json()['detail']['reason'] == 'confirm-large'
    assert response.json()['detail']['current']['count'] == 1
    h.path.write_bytes(content)
    response = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True})
    assert response.json()['rows'][0]['reason'] == 'not-missing'
    assert h.container.get_user_track_store().get(h.member_id, REL)
    h.path.unlink()
    first = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True})
    assert first.json()['rows'][0]['state'] == 'applied'
    repeat = h.admin.post(URL + '/remove', json={'relPaths': [REL]})
    assert repeat.json()['rows'][0]['reason'] == 'already'
    assert h.admin.get(URL).json()['rows'] == []


def test_remove_journal_and_undo_restore_positions_corrections_and_member_facts(house):
    h = house
    music, other = prepare(h)
    users = h.container.get_user_track_store()
    users.update_flags(h.member_id, REL, liked=True, offline=True)
    assert h.member.post('/api/me/plays', json={'relPath': REL}).status_code == 200
    before = users.get(h.member_id, REL)
    lyrics = h.container.get_lyrics_service().repository
    lyric = LyricsRecord(REL, 'synced', 'manual', edited=True, sidecar='song.lrc')
    lyrics.put_record(lyric)
    sidecar = h.path.with_suffix('.lrc'); sidecar.write_text('[00:01] Kept words')
    playlists = h.container.get_playlist_repository()
    playlists.save_playlist(Playlist('Evening', [PlaylistTrack(other, 'Other'), PlaylistTrack(h.path, 'Missing'), PlaylistTrack(other, 'Other again')]))
    stems = h.container.get_stems_service().repository.track_dir('Album', 'song.mp3')
    stems.mkdir(parents=True); (stems / 'keep').write_text('stems')
    h.path.unlink()
    response = h.admin.post(URL + '/remove', headers={'Idempotency-Key': 'remove'}, json={'relPaths': [REL], 'confirmLarge': True})
    assert response.status_code == 200, response.text
    edit_id = response.json()['editId']
    assert h.admin.post(URL + '/remove', headers={'Idempotency-Key': 'remove'}, json={'relPaths': [REL], 'confirmLarge': True}).json() == response.json()
    assert users.get(h.member_id, REL) is None and music.analysis.get(REL) is None
    assert not stems.exists()
    assert lyrics.get_record(REL) is None and sidecar.read_text() == '[00:01] Kept words'
    assert len(playlists.load_playlist('Evening').tracks) == 2
    assert h.container.get_library_keys().participants['plays'].snapshot(REL)['play_events'] == []
    journal = h.admin.get('/api/library/edits/' + edit_id).json()
    assert journal['kind'] == 'remove-missing' and journal['principal']
    assert 'refs_snapshot' not in journal['rows'][0]
    undo = h.admin.post('/api/library/edits/' + edit_id + '/undo')
    assert undo.status_code == 202, undo.text
    assert users.get(h.member_id, REL) == before
    assert music.analysis.get(REL)['fixed_key'] == '2A'
    assert playlists.load_playlist('Evening').tracks[1].path == h.path
    assert (stems / 'keep').read_text() == 'stems'
    assert lyrics.get_record(REL) == lyric and sidecar.read_text() == '[00:01] Kept words'
    assert len(h.container.get_library_keys().participants['plays'].snapshot(REL)['play_events']) == 1
    assert h.admin.get(URL).json()['rows'][0]['relPath'] == REL
    assert other.is_file() and not h.path.exists()


def test_folder_preview_applies_repoint_without_touching_audio(house):
    h = house
    music, _ = prepare(h)
    target = h.path.parent.parent / 'New' / h.path.name
    target.parent.mkdir(); h.path.rename(target); h.path.parent.rmdir()
    before = target.read_bytes()
    found = h.admin.get(URL).json()['rows'][0]
    assert found['movedTo'] == 'New/song.mp3'
    removal = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True})
    assert removal.json()['rows'][0]['reason'] == 'moved'
    preview = h.admin.post(URL + '/preview', json={'relPaths': [REL], 'folder': 'New'})
    assert preview.status_code == 200, preview.text
    match = preview.json()['rows'][0]
    assert match['target'] == 'New/song.mp3' and match['reason'] is None
    result = h.admin.post(URL + '/apply', json={'rows': [{k: match[k] for k in ('relPath', 'target', 'rev')}]})
    assert result.status_code == 200 and result.json()['rows'][0]['state'] == 'applied', result.text
    assert h.container.get_user_track_store().get(h.member_id, 'New/song.mp3')
    assert music.analysis.get('New/song.mp3')['fixed_key'] == '2A'
    assert music.analysis.get('New/song.mp3')['missing_since'] is None
    assert h.admin.get(URL).json()['rows'] == [] and target.read_bytes() == before


def test_locate_preview_stale_revision_ambiguous_and_containment(house, tmp_path):
    h = house
    prepare(h)
    h.path.unlink()
    root = h.path.parent.parent
    for folder in ('New/A', 'New/B'):
        path = root / folder / 'song.mp3'; path.parent.mkdir(parents=True); path.write_bytes(FRAME)
    preview = h.admin.post(URL + '/preview', json={'relPaths': [REL], 'folder': 'New'})
    assert preview.json()['rows'][0]['reason'] == 'ambiguous'
    target = 'New/A/song.mp3'
    preview = h.admin.post(URL + '/preview', json={'relPaths': [REL], 'target': target})
    assert preview.status_code == 200, preview.text
    match = preview.json()['rows'][0]
    (root / 'New/A/song.mp3').write_bytes(FRAME + b'changed')
    result = h.admin.post(URL + '/apply', json={'rows': [{k: match[k] for k in ('relPath', 'target', 'rev')}]})
    assert result.json()['rows'][0]['reason'] == 'changed-since'
    for folder in ('../outside', str(tmp_path)):
        assert h.admin.post(URL + '/preview', json={'relPaths': [REL], 'folder': folder}).status_code == 422
    (root / 'Escape').symlink_to(tmp_path, target_is_directory=True)
    assert h.admin.post(URL + '/preview', json={'relPaths': [REL], 'folder': 'Escape'}).status_code == 422


def test_album_ghost_owner_only_and_restore(house):
    h = house
    music, _ = prepare(h)
    content = h.path.read_bytes(); h.path.unlink()
    music.invalidate_scan()
    owner = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()
    ghost = next(t for a in owner for t in a['tracks'] if t['relPath'] == REL)
    assert ghost['missingFromNest'] is True and ghost['keyFixed'] is True
    assert not any(t['relPath'] == REL for a in h.member.get('/api/listar-albums-con-metadata?covers=false').json() for t in a['tracks'])
    h.path.write_bytes(content); music.invalidate_scan()
    restored = next(t for a in h.admin.get('/api/listar-albums-con-metadata?covers=false').json() for t in a['tracks'] if t['relPath'] == REL)
    assert restored['missingFromNest'] is False and restored['keyFixed'] is True


def test_interrupted_removal_compensates_instead_of_replaying(house):
    h = house
    music, _ = prepare(h)
    service = h.container.get_missing_files()
    h.path.unlink()
    import json
    edit_id, _ = service.edits.create('remove-missing', 'owner', [{'relPath': REL}])
    snapshot = service.keys.snapshot(REL)
    with music.analysis.connection() as db:
        db.execute('UPDATE library_edit_row SET refs_snapshot=? WHERE edit_id=?', (json.dumps({'missingReferences': snapshot}), edit_id))
    service.keys.drop(REL, snapshot)
    service.edits.recover()
    assert service.users.get(h.member_id, REL)
    assert music.analysis.get(REL)['fixed_key'] == '2A'
    assert service.edits.get(edit_id)['rows'][0]['reason'] == 'interrupted'


def test_absent_root_keeps_review_and_ghosts_and_allows_reference_undo(house):
    h = house
    music, _ = prepare(h)
    h.path.unlink()
    edit = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True}).json()['editId']
    shutil.rmtree(h.path.parent.parent)
    undo = h.admin.post('/api/library/edits/' + edit + '/undo')
    assert undo.status_code == 202, undo.text
    body = h.admin.get(URL).json()
    assert body['libraryAvailable'] is False
    assert body['rows'][0]['relPath'] == REL
    music.invalidate_scan()
    albums = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()
    assert any(t['missingFromNest'] for a in albums for t in a['tracks'] if t['relPath'] == REL)


def test_locate_renamed_file_success_and_duplicate_target_refusal(house):
    h = house
    music, _ = prepare(h)
    target = h.path.with_name('renamed.mp3')
    h.path.rename(target)
    match = h.admin.post(URL + '/preview', json={'relPaths': [REL], 'target': 'Album/renamed.mp3'}).json()['rows'][0]
    body = {'rows': [{k: match[k] for k in ('relPath', 'target', 'rev')}]}
    response = h.admin.post(URL + '/apply', json=body)
    assert response.status_code == 200 and response.json()['rows'][0]['state'] == 'applied'
    assert music.analysis.get('Album/renamed.mp3')['fixed_key'] == '2A'
    assert h.container.get_user_track_store().get(h.member_id, 'Album/renamed.mp3')


def test_remove_participant_failure_compensates_and_journals(house):
    h = house
    prepare(h)
    service = h.container.get_missing_files()

    class Plugin:
        def snapshot(self, rel):
            return {'fact': 12}

        def drop(self, rel, snapshot):
            raise OSError('Synthetic failure')

        def restore(self, rel, snapshot):
            assert snapshot == {'fact': 12}

    service.keys.register('example', Plugin())
    h.path.unlink()
    response = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True})
    assert response.json()['rows'][0]['reason'] == 'write-failed'
    assert service.users.get(h.member_id, REL)
    assert service.music.analysis.get(REL)['fixed_key'] == '2A'


def test_undo_records_playlist_append_after_other_entries_were_removed(house):
    h = house
    _, other = prepare(h)
    playlists = h.container.get_playlist_repository()
    playlists.save_playlist(Playlist('Evening', [PlaylistTrack(other, 'Other'), PlaylistTrack(h.path, 'Song')]))
    h.path.unlink()
    edit = h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True}).json()['editId']
    playlist = playlists.load_playlist('Evening'); playlist.tracks = []; playlists.save_playlist(playlist)
    undo = h.admin.post('/api/library/edits/' + edit + '/undo').json()['editId']
    detail = h.admin.get('/api/library/edits/' + undo).json()
    assert detail['rows'][0]['reason'] == 'playlist-appended'
    assert len(playlists.load_playlist('Evening').tracks) == 1


def test_new_file_at_a_removed_key_is_visible_and_can_become_a_ghost_again(house):
    h = house
    music, _ = prepare(h)
    content = h.path.read_bytes(); h.path.unlink()
    assert h.admin.post(URL + '/remove', json={'relPaths': [REL], 'confirmLarge': True}).json()['rows'][0]['state'] == 'applied'
    h.path.write_bytes(content)
    music.scan_albums()
    albums = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()
    assert any(not t['missingFromNest'] for a in albums for t in a['tracks'] if t['relPath'] == REL)
    h.path.unlink(); music.scan_albums()
    assert REL in {r['relPath'] for r in h.admin.get(URL).json()['rows']}


def test_partial_album_keeps_ghost_in_the_same_album_and_disc_order(house):
    h = house
    music, _ = prepare(h)
    disc = h.path.parent / 'CD2'; disc.mkdir()
    gone = disc / '02.mp3'; gone.write_bytes(h.path.read_bytes())
    tagwriter.write(gone, {'title': 'Missing on disc two', 'trackNumber': 2}, expected=tagwriter.identity(gone))
    music.scan_albums(); gone.unlink(); music.scan_albums()
    albums = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()
    matches = [a for a in albums if a['mediaKey'] == 'Album']
    assert len(matches) == 1
    assert [t['relPath'] for t in matches[0]['tracks']] == [REL, 'Album/CD2∕02.mp3']
    ghost = matches[0]['tracks'][1]
    assert ghost['missingFromNest'] and ghost['discNumber'] == 2
    assert ghost['title'] == 'Missing on disc two'


def test_exactly_twenty_percent_needs_no_large_confirmation(house):
    h = house
    prepare(h)
    for i in range(3):
        h.path.with_name(f'present-{i}.mp3').write_bytes(FRAME + bytes([i]))
    h.path.unlink()
    response = h.admin.post(URL + '/remove', json={'relPaths': [REL]})
    assert response.status_code == 200, response.text
    assert response.json()['rows'][0]['state'] == 'applied'
