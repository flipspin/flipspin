"""Colliding physical files cannot be read or changed through a shared key."""
import json
from urllib.parse import quote

import pytest

from app.domains.metadata import tagwriter
from app.domains.music.analysis_writeback import write_tags
from app.exceptions import AmbiguousLibraryKeyError
from tests.integration.test_analysis import house as house

REL = 'Artist∕Album/song.mp3'


@pytest.fixture
def collision(house):
    h = house
    root = h.path.parent.parent
    source = root / 'Artist/Album/song.mp3'
    source.parent.mkdir(parents=True)
    source.write_bytes(h.path.read_bytes())
    rev = tagwriter.read(source)['rev']
    lyric_url = '/api/lyrics/' + quote(REL)
    assert h.admin.put(lyric_url, json={'kind': 'plain', 'text': 'Keep these words', 'edited': True}).status_code == 200
    stems = h.container.get_stems_service().repository.track_dir('Artist∕Album', 'song.mp3')
    stems.mkdir(parents=True)
    (stems / 'song.json').write_text(json.dumps({'version': 1, 'stems': {}}))
    other = root / 'Artist∕Album/song.mp3'
    other.parent.mkdir()
    other.write_bytes(source.read_bytes() + b'other-file')
    return h, source, other, stems, rev


@pytest.mark.parametrize('operation', [
    'play', 'tags-read', 'tags-write', 'batch', 'alias', 'move', 'delete',
    'lyrics-read', 'lyrics-write', 'lyrics-offset', 'lyrics-delete',
    'stems-read', 'stems-audio', 'stems-write', 'stems-delete',
    'analysis-read', 'analysis-write', 'waveform',
])
def test_ambiguous_key_returns_409_without_changing_either_file(collision, operation):
    h, source, other, stems, rev = collision
    rel = quote(REL)
    root = source.parents[2]
    before = {path: path.read_bytes() for path in [source, other, source.with_suffix('.txt'), stems / 'song.json']}
    lyrics = h.container.get_lyrics_service().repository
    record = lyrics.get_record(REL)
    calls = {
        'play': ('GET', '/api/media/' + rel, None),
        'tags-read': ('GET', '/api/library/tags/' + rel, None),
        'tags-write': ('PUT', '/api/library/tags/' + rel, {'rev': rev, 'set': {'title': 'Wrong'}}),
        'batch': ('POST', '/api/library/tags/batch', {'items': [{'relPath': REL, 'rev': rev}], 'set': {'title': 'Wrong'}}),
        'alias': ('POST', '/api/update-tags', {'path': str(source), 'title': 'Wrong'}),
        'move': ('POST', '/api/library/move-track', {'path': str(source), 'albumTitle': 'Moved'}),
        'delete': ('POST', '/api/delete-track', {'path': str(source)}),
        'lyrics-read': ('GET', '/api/lyrics/' + rel, None),
        'lyrics-write': ('PUT', '/api/lyrics/' + rel, {'kind': 'plain', 'text': 'Wrong', 'force': True}),
        'lyrics-offset': ('PUT', '/api/lyrics/' + rel + '/offset', {'offsetMs': 100}),
        'lyrics-delete': ('DELETE', '/api/lyrics/' + rel, None),
        'stems-read': ('GET', '/api/stems/' + rel, None),
        'stems-audio': ('GET', '/api/stems/' + rel + '/vocals', None),
        'stems-write': ('POST', '/api/stems/request', {'album': 'Artist∕Album', 'file': 'song.mp3'}),
        'stems-delete': ('DELETE', '/api/stems/' + rel, None),
        'analysis-read': ('GET', '/api/analysis/' + rel, None),
        'analysis-write': ('PUT', '/api/analysis/' + rel + '/fixed', {'rev': 0, 'bpm': 100}),
        'waveform': ('GET', '/api/waveform/' + rel, None),
    }
    method, url, body = calls[operation]
    response = h.admin.request(method, url, json=body)
    assert response.status_code == 409, response.text
    assert 'Ambiguous library key' in response.text
    assert all(path.read_bytes() == content for path, content in before.items())
    assert lyrics.get_record(REL) == record
    assert not (root / 'Moved').exists()


@pytest.mark.parametrize('which', ['nested', 'literal'])
def test_analysis_tag_write_refuses_physical_path_collision(collision, which):
    h, source, other, _, _ = collision
    originals = [source.read_bytes(), other.read_bytes()]
    path = source if which == 'nested' else other
    with pytest.raises(AmbiguousLibraryKeyError, match='Ambiguous library key'):
        write_tags(path, {'bpm': 120, 'bpm_conf': 1}, writer=h.container.get_tag_edits().edit)
    assert [source.read_bytes(), other.read_bytes()] == originals


def test_move_cannot_create_a_colliding_key(house):
    h = house
    root = h.path.parent.parent
    existing = root / 'Artist/Album/song.mp3'
    existing.parent.mkdir(parents=True)
    existing.write_bytes(h.path.read_bytes())
    target = root / 'Artist∕Album'
    target.mkdir()
    before = h.path.read_bytes(), existing.read_bytes()
    response = h.admin.post('/api/library/move-track', json={'path': str(h.path), 'albumDir': 'Artist∕Album'})
    assert response.status_code == 409
    assert (h.path.read_bytes(), existing.read_bytes()) == before
    assert not (target / 'song.mp3').exists()


def test_journal_batch_and_recovery_refuse_a_collision_appearing_after_planning(collision):
    h, source, other, _, rev = collision
    edits = h.container.get_tag_edits()
    original = source.read_bytes(), other.read_bytes()
    edit_id, _ = edits.batch([{'relPath': REL, 'rev': rev}], {'title': 'Wrong'}, 'owner')
    edits.run_batch(edit_id)
    assert edits.get(edit_id)['rows'][0]['reason'] == 'ambiguous-library-key'
    recovery_id, _ = edits.create('tags', 'owner', [{'relPath': REL, 'rev': rev, 'set': {'title': 'Wrong'}}])
    edits.recover_entry(recovery_id)
    assert edits.get(recovery_id)['rows'][0]['reason'] == 'ambiguous-library-key'
    assert (source.read_bytes(), other.read_bytes()) == original


def test_undo_is_rejected_if_a_collision_appears_after_the_edit(house):
    h = house
    root = h.path.parent.parent
    source = root / 'Artist/Album/song.mp3'
    source.parent.mkdir(parents=True)
    source.write_bytes(h.path.read_bytes())
    change = h.container.get_tag_edits().edit(source, {'title': 'Keep'})
    other = root / 'Artist∕Album/song.mp3'
    other.parent.mkdir()
    other.write_bytes(source.read_bytes() + b'other')
    before = source.read_bytes(), other.read_bytes()
    response = h.admin.post('/api/library/edits/' + change['editId'] + '/undo')
    assert response.status_code == 409 and 'Ambiguous library key' in response.text
    assert (source.read_bytes(), other.read_bytes()) == before


def test_analysis_scan_skips_ambiguous_files_and_keeps_unique_files(collision):
    h, _, _, _, _ = collision
    assert h.service.scan() == 1
    assert {row['relPath'] for row in h.service.queue.rows(('analysis',))} == {'Album/song.mp3'}
