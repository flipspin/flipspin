"""Standard note names, private Camelot, and ownership-fenced retries."""
import threading
from unittest.mock import Mock

import pytest
from mutagen.id3 import ID3, TBPM, TKEY, TXXX
from pydantic import ValidationError

from app.domains.metadata import tagwriter as w
from app.domains.music.analysis_jobs import AnalysisService
from app.domains.music.analysis_tags import analysis_tags, tag_value
from app.domains.music.key_tag_migration import KEY_TAG_VERSION, KeyTagMigration
from app.domains.music.tag_edits import TagEdits
from app.domains.music.tag_routes import TagPatch
from app.utils.musical_key import key_info
from tests.unit.test_analysis_step1 import analysis as analysis, measurement

KEYS = [
    ('1A', 'G#m'), ('2A', 'D#m'), ('3A', 'A#m'), ('4A', 'Fm'),
    ('5A', 'Cm'), ('6A', 'Gm'), ('7A', 'Dm'), ('8A', 'Am'),
    ('9A', 'Em'), ('10A', 'Bm'), ('11A', 'F#m'), ('12A', 'C#m'),
    ('1B', 'B'), ('2B', 'F#'), ('3B', 'C#'), ('4B', 'G#'),
    ('5B', 'D#'), ('6B', 'A#'), ('7B', 'F'), ('8B', 'C'),
    ('9B', 'G'), ('10B', 'D'), ('11B', 'A'), ('12B', 'E'),
]


def migration(a):
    return KeyTagMigration(a.config, a.repo, a.music, a.worker, a.service._scan_lock, a.service._stop)


def old_song(a, name='song.mp3', *, key='5A', marker=True, fields=('key',), owner='krobi'):
    path = a.song(name)
    tags = ID3()
    tags.add(TKEY(encoding=1, text=[key]))
    tags.add(TBPM(encoding=0, text=['90.00']))
    tags.add(TXXX(encoding=1, desc='Foreign DJ', text=['Keep exactly']))
    if marker:
        tags.add(TXXX(encoding=1, desc='KROBI_ANALYSIS', text=['old-engine']))
    tags.save(path)
    stat = path.stat()
    rel = 'Album/' + name
    result = measurement({'relPath': rel, 'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns})
    data = {**result, 'mtime_ns': stat.st_mtime_ns, 'engine_version': 1, 'key_conf': .9, 'bpm_conf': .9}
    a.repo.apply(rel, data, 'calm')
    a.repo.signature(rel, stat, owner, list(fields) if fields is not None else None)
    a.repo.tag_record(rel, 'tag_values', {'key': '5A', 'bpm': 90})
    a.config.write_analysis_tags = True
    return path, rel


@pytest.mark.parametrize('camelot,note', KEYS)
def test_all_24_keys_convert_both_ways(camelot, note):
    info = key_info(camelot)
    assert info['key'] + ('m' if info['scale'] == 'minor' else '') == note
    assert key_info(note)['camelot'] == camelot
    assert len(note) <= 3


@pytest.mark.parametrize('note,camelot', [('Bbm', '3A'), ('Dbm', '12A'), ('Gb', '2B'), ('Eb', '5B')])
def test_common_flat_spellings_remain_readable(note, camelot):
    assert key_info(note)['camelot'] == camelot


def test_api_derives_private_companion_and_rejects_direct_edits():
    assert TagPatch(set={'key': '5A'}).set == {'key': 'Cm', 'camelot': '5A'}
    assert TagPatch(set={'key': None}).set == {'key': None, 'camelot': None}
    with pytest.raises(ValidationError, match='Reserved field'):
        TagPatch(set={'camelot': '2A'})


@pytest.mark.parametrize('suffix', ['.mp3', '.flac', '.ogg', '.opus', '.m4a', '.mp4'])
def test_writer_all_keys_companion_clear_and_undo(config, write_audio, suffix):
    path = config.base_music_dir / ('song' + suffix)
    write_audio(path, [0.] * 8000, 8000)
    edits = TagEdits(config)
    for camelot, note in KEYS:
        change = edits.edit(path, {'key': camelot})
        _, tags, mode = w.load(path)
        assert tag_value(tags, (w.FIELDS['key'][mode],)) == note
        assert tag_value(tags, (w.FIELDS['camelot'][mode],)) == camelot
        assert analysis_tags(tags)['key'] == camelot
        assert not edits.edit(path, {'key': note})['changed']
        assert change['changed']
    before = w.identity(path)
    clear = edits.edit(path, {'key': None})
    _, tags, mode = w.load(path)
    assert all(w.FIELDS[field][mode] not in tags for field in ('key', 'camelot'))
    undo, _ = edits.start_undo(clear['editId'], 'owner')
    edits.run_undo(undo)
    _, tags, mode = w.load(path)
    assert tag_value(tags, (w.FIELDS['key'][mode],)) == 'E'
    assert tag_value(tags, (w.FIELDS['camelot'][mode],)) == '12B'
    assert w.identity(path)['tagSha'] == before['tagSha']


@pytest.mark.parametrize('marker,fields', [(True, None), (True, ('key',)), (False, ('key',))])
def test_migration_only_key_frames_signature_and_journal(analysis, marker, fields, caplog):
    a = analysis
    path, rel = old_song(a, marker=marker, fields=fields)
    before = dict(w.raw_frames(path)[1])
    row = a.repo.get(rel)
    assert migration(a).run()
    after = dict(w.raw_frames(path)[1])
    for key in before.keys() - {'TKEY'}:
        assert after[key] == before[key]
    assert ID3(path)['TKEY'].text == ['Cm']
    assert ID3(path)['TXXX:KROBI_CAMELOT'].text == ['5A']
    assert a.repo.get(rel) == {**row, 'size': path.stat().st_size, 'mtime_ns': path.stat().st_mtime_ns}
    assert a.repo.tag_fields(rel) == (list(fields) if fields is not None else None)
    assert a.repo.tag_record(rel, 'tag_values')['key'] == '5A'
    assert a.service.scan() == 0
    assert a.repo.meta('key_tag_version') == KEY_TAG_VERSION
    assert 'rewritten=1 untouched=0 failed=0 complete=True' in caplog.text
    with a.repo.connection() as db:
        edit = db.execute("SELECT id FROM library_edit WHERE principal='key-tag-migration'").fetchone()
    assert edit and TagEdits(a.config, a.repo).get(edit['id'])['state'] == 'applied'
    before = path.read_bytes(), path.stat(), a.repo.revision
    assert migration(a).run()
    assert (path.read_bytes(), path.stat(), a.repo.revision) == before


@pytest.mark.parametrize('case', ['foreign', 'foreign-sibling', 'hand-edit', 'stale-marker', 'no-proof', 'untracked'])
def test_foreign_and_outside_corrections_are_byte_identical(analysis, case):
    a = analysis
    path, rel = old_song(a)
    if case == 'foreign':
        a.repo.ownership(rel, None)
        tags = ID3(path); tags.delall('TXXX:KROBI_ANALYSIS'); tags.save(path)
    elif case == 'foreign-sibling':
        # Krobi owns only BPM; its marker cannot claim the key.
        a.repo.signature(rel, path.stat(), 'krobi', ['bpm'])
    elif case == 'hand-edit':
        TagEdits(a.config, a.repo, a.music).edit(path, {'key': '2A'})
    elif case == 'stale-marker':
        tags = ID3(path); tags.add(TKEY(text=['2A'])); tags.save(path)
    elif case == 'no-proof':
        tags = ID3(path); tags.delall('TXXX:KROBI_ANALYSIS'); tags.save(path)
        with a.repo.connection() as db:
            db.execute('DELETE FROM meta WHERE key=?', ('tag_fields:' + rel,))
    elif case == 'untracked':
        a.repo.forget(rel)
    before = path.read_bytes(), path.stat(), a.repo.get(rel)
    assert migration(a).run()
    assert (path.read_bytes(), path.stat(), a.repo.get(rel)) == before


@pytest.mark.parametrize('alias', ['same', 'conflict'])
def test_initialkey_alias_and_conflicting_foreign_alias(analysis, alias):
    a = analysis
    path, rel = old_song(a)
    tags = ID3(path)
    tags.delall('TKEY')
    tags.add(TXXX(desc='INITIALKEY', text=['5A']))
    if alias == 'conflict':
        tags.add(TKEY(text=['2A']))
    tags.save(path)
    before = path.read_bytes()
    assert migration(a).run()
    if alias == 'same':
        assert ID3(path)['TKEY'].text == ['Cm']
        assert a.service.scan() == 0
    else:
        assert path.read_bytes() == before


@pytest.mark.parametrize('suffix', ['.flac', '.ogg', '.opus', '.m4a', '.mp4'])
def test_migration_native_formats_preserves_foreign_fields(analysis, write_audio, suffix):
    a = analysis
    path, rel = old_song(a)
    a.repo.forget(rel)
    path.unlink()
    path = path.with_suffix(suffix)
    rel = 'Album/' + path.name
    write_audio(path, [0.] * 8000, 8000)
    audio, tags, mode = w.load(path)
    w.patch(tags, mode, {'key': '5A', 'analysisMarker': 'old-engine', 'bpm': 90})
    if mode == 1:
        tags['KEY'] = ['5A']
        tags['CAMELOT'] = ['FOREIGN']
        tags['FOREIGN_DJ'] = ['Keep exactly']
    audio.save(path)
    stat = path.stat()
    result = measurement({'relPath': rel, 'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns})
    a.repo.apply(rel, {**result, 'mtime_ns': stat.st_mtime_ns, 'engine_version': 1,
                       'key_conf': .9, 'bpm_conf': .9}, 'calm')
    a.repo.signature(rel, stat, 'krobi', ['key'])
    before = a.repo.get(rel)
    assert migration(a).run()
    _, tags, mode = w.load(path)
    assert tag_value(tags, (w.FIELDS['key'][mode],)) == 'Cm'
    assert tag_value(tags, (w.FIELDS['camelot'][mode],)) == '5A'
    assert tag_value(tags, (w.FIELDS['analysisMarker'][mode],)) == 'old-engine'
    assert tag_value(tags, (w.FIELDS['bpm'][mode],)) == '90'
    if mode == 1:
        assert tags['camelot'] == ['FOREIGN']
        assert tags['foreign_dj'] == ['Keep exactly']
    assert a.repo.get(rel) == {**before, 'size': path.stat().st_size, 'mtime_ns': path.stat().st_mtime_ns}
    assert a.service.scan() == 0


def test_multi_value_key_is_never_collapsed(analysis):
    a = analysis
    path, _ = old_song(a)
    tags = ID3(path)
    tags.add(TKEY(text=['5A', '2A']))
    tags.save(path)
    before = path.read_bytes()
    assert migration(a).run()
    assert path.read_bytes() == before


def test_empty_library_leaves_version_pending(analysis):
    a = analysis
    a.config.write_analysis_tags = True
    assert migration(a).run()
    assert a.repo.meta('key_tag_version') is None


@pytest.mark.parametrize('interruption', ['stop', 'error'])
def test_interrupted_pass_resumes_without_rewriting_completed_files(analysis, monkeypatch, interruption):
    a = analysis
    first, _ = old_song(a, 'a.mp3')
    second, _ = old_song(a, 'b.mp3')
    job = migration(a)
    rewrite = job.rewrite_file

    def interrupt(path):
        if path == second:
            raise OSError('interrupted')
        outcome = rewrite(path)
        if interruption == 'stop':
            a.service._stop.set()
        return outcome

    monkeypatch.setattr(job, 'rewrite_file', interrupt)
    if interruption == 'stop':
        assert not job.run()
    else:
        with pytest.raises(OSError, match='interrupted'):
            job.run()
    assert a.repo.meta('key_tag_version') is None
    assert ID3(first)['TKEY'].text == ['Cm']
    assert ID3(second)['TKEY'].text == ['5A']
    first_state = first.read_bytes(), first.stat()
    a.service._stop.clear()
    assert migration(a).run()
    assert (first.read_bytes(), first.stat()) == first_state
    assert ID3(second)['TKEY'].text == ['Cm']
    assert a.service.scan() == 0


def test_recovery_after_replace_refreshes_signature_before_retry(analysis, monkeypatch):
    a = analysis
    path, rel = old_song(a)
    signature = a.repo.signature
    monkeypatch.setattr(a.repo, 'signature', Mock(side_effect=OSError('after replace')))
    with pytest.raises(OSError, match='after replace'):
        migration(a).run()
    assert ID3(path)['TKEY'].text == ['Cm']
    assert a.repo.meta('key_tag_version') is None
    before = path.stat(), path.read_bytes()
    monkeypatch.setattr(a.repo, 'signature', signature)
    TagEdits(a.config, a.repo, a.music).recover()
    assert migration(a).run()
    assert (path.stat(), path.read_bytes()) == before
    assert a.repo.get(rel)['mtime_ns'] == path.stat().st_mtime_ns
    assert a.service.scan() == 0


def test_pacing_scan_lock_and_disabled_writeback(analysis, monkeypatch):
    a = analysis
    first, _ = old_song(a, 'a.mp3')
    old_song(a, 'b.mp3')
    a.config.write_analysis_tags = False
    before = first.read_bytes(), a.repo.revision
    assert migration(a).run()
    assert (first.read_bytes(), a.repo.revision) == before
    assert a.repo.meta('key_tag_version') is None
    a.config.write_analysis_tags = True
    waits = []

    def pause(seconds):
        assert seconds >= .1
        waits.append(seconds)
        if len(waits) == 1:
            a.service._scan_lock.release()
        else:
            assert a.service._scan_lock.acquire(blocking=False)
            a.service._scan_lock.release()
        return False

    a.service._scan_lock.acquire()
    monkeypatch.setattr(a.service._stop, 'wait', pause)
    assert migration(a).run()
    assert waits == [.1, .1, .1]


def test_startup_runs_migration_before_scan(analysis, monkeypatch):
    a = analysis
    path, _ = old_song(a)
    scanned = threading.Event()

    def scan(**_):
        assert a.repo.meta('key_tag_version') == KEY_TAG_VERSION
        assert ID3(path)['TKEY'].text == ['Cm']
        a.service._stop.set()
        scanned.set()

    monkeypatch.setattr(a.service, 'scan', scan)
    a.service.startup()
    assert scanned.wait(3)
    a.service.stop()
    again = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    assert KeyTagMigration(a.config, a.repo, a.music, a.worker, again._scan_lock, again._stop).run()


def test_v23_migration_keeps_foreign_frames_and_version(analysis):
    a = analysis
    path, _ = old_song(a)
    tags = ID3(path)
    tags.add(TXXX(encoding=1, desc='Foreign DJ', text=['x' * 200]))
    tags.save(path, v2_version=3)
    original = dict(w.raw_frames(path)[1])
    assert migration(a).run()
    assert ID3(path).version == (2, 3, 0)
    current = dict(w.raw_frames(path)[1])
    assert all(current[name] == frame for name, frame in original.items() if name != 'TKEY')


def test_outside_companion_edit_is_not_overwritten(analysis):
    a = analysis
    path, _ = old_song(a)
    tags = ID3(path)
    tags.add(TXXX(desc='KROBI_CAMELOT', text=['2A']))
    tags.save(path)
    before = path.read_bytes()
    assert migration(a).run()
    assert path.read_bytes() == before


@pytest.mark.parametrize('fields', [None, ('key',)])
def test_legacy_whole_file_ownership_never_adopts_an_outside_bpm_edit(analysis, fields):
    a = analysis
    path, rel = old_song(a, fields=fields)
    tags = ID3(path)
    tags.add(TBPM(text=['140']))
    tags.save(path)
    before = path.read_bytes()
    assert migration(a).run()
    if fields is None:
        assert path.read_bytes() == before
    else:
        assert ID3(path)['TKEY'].text == ['Cm']
        assert ID3(path)['TBPM'].text == ['140']
        assert a.repo.tag_fields(rel) == ['key']
