"""Safety, format and recovery checks for the sole tag mutation boundary."""
import hashlib
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from mutagen.id3 import ID3, GEOB, PRIV, TIT2, TXXX

from app.domains.metadata import tagwriter as w
from app.domains.music.analysis_writeback import write_tags
from app.domains.music.tag_edits import TagEdits

FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 40


@pytest.fixture
def edits(config):
    path = config.base_music_dir / 'Album/song.mp3'
    path.parent.mkdir(); path.write_bytes(FRAME)
    return TagEdits(config), path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_clear_noop_exact_native_undo_redo(edits):
    service, path = edits
    tags = ID3(); tags.add(TIT2(encoding=1, text=['Old', 'Second'])); tags.save(path)
    change = service.edit(path, {'genre': 'Rock', 'title': ['One', 'Two']})
    assert w.read(path)['fields']['title'] == ['One', 'Two']
    undo, _ = service.start_undo(change['editId'], 'owner'); service.run_undo(undo)
    assert ID3(path)['TIT2'].text == ['Old', 'Second']
    assert 'TCON' not in ID3(path)
    redo, _ = service.start_undo(undo, 'owner'); service.run_undo(redo)
    assert w.read(path)['fields']['genre'] == 'Rock'
    service.edit(path, {'genre': None})
    assert 'TCON' not in ID3(path)
    before = digest(path)
    assert service.edit(path, {'genre': ''})['editId'] is None
    assert digest(path) == before


@pytest.mark.parametrize('suffix', ['.mp3', '.flac', '.ogg', '.m4a'])
def test_all_formats_round_trip_and_undo(config, write_audio, suffix):
    path = config.base_music_dir / 'Album' / ('song' + suffix)
    path.parent.mkdir(); write_audio(path, [0.] * 8000, 8000)
    service = TagEdits(config)
    fields = {'title': 'Song', 'artist': ['A', 'B'], 'album': 'Album', 'albumArtist': 'Both', 'composer': ['Composer A', 'Composer B'], 'genre': ['Pop', 'Rock'],
              'year': 2024, 'trackNumber': 2, 'trackTotal': 9, 'discNumber': 1, 'discTotal': 2,
              'compilation': True, 'bpm': 123, 'key': '8A', 'isrc': 'AA0000000001', 'mbRecording': 'recording',
              'mbRelease': 'release', 'mbReleaseGroup': 'group', 'mbArtist': ['artist1', 'artist2'],
              'mbAlbumArtist': 'albumartist', 'comment': 'First\nSecond'}
    initial = w.read(path)['fields']
    change = service.edit(path, fields)
    assert w.read(path)['fields'] == {**initial, **fields, 'key': 'Am'}
    undo, _ = service.start_undo(change['editId'], 'owner'); service.run_undo(undo)
    assert w.read(path)['fields'] == initial
    assert service.get(change['editId'])['state'] == 'undone'


def test_v23_switch(edits):
    service, path = edits
    service.edit(path, {'artist': ['A', 'B'], 'year': 2023}, id3_version=3)
    assert ID3(path).version == (2, 3, 0)
    assert ID3(path)['TPE1'].text == ['A; B']
    assert str(ID3(path)['TDRC']) == '2023'


def test_foreign_frames_survive_byte_for_byte(edits):
    service, path = edits
    tags = ID3(); tags.add(TXXX(encoding=1, desc='Foreign DJ', text=['é', 'Mixed']))
    tags.add(GEOB(encoding=0, mime='application/octet-stream', desc='Serato Markers2', data=b'\x00\xffSerato\x00'))
    tags.add(PRIV(owner='other', data=b'\x00\xff\xfe')); tags.save(path)
    original = dict(w.raw_frames(path)[1])
    service.edit(path, {'title': 'New', 'key': '5A'})
    current = dict(w.raw_frames(path)[1])
    assert all(current[key] == raw for key, raw in original.items())
    assert ID3(path)['TKEY'].text == ['Cm']


def test_crash_during_save_never_touches_original(edits, monkeypatch):
    service, path = edits
    before, original, paths = digest(path), ID3.save, []
    def broken(self, filename=None, **kwargs):
        if isinstance(filename, Path):
            paths.append(filename)
            assert filename.parent == path.parent and filename != path
            filename.write_bytes(b'partial write'); raise OSError('crash')
        return original(self, filename, **kwargs)
    monkeypatch.setattr(ID3, 'save', broken)
    with pytest.raises(w.TagError, match='write-failed'):
        service.edit(path, {'title': 'New'})
    assert paths and digest(path) == before
    assert not list(path.parent.glob('.krobi-tmp-*'))


def test_changed_rev_and_second_identity_check(edits, monkeypatch):
    service, path = edits
    old = w.read(path)['rev']; ID3().save(path); before = digest(path)
    with pytest.raises(w.TagError) as caught:
        service.edit(path, {'title': 'No'}, expected=old)
    assert caught.value.reason == 'changed-since' and caught.value.current['rev'] != old
    assert digest(path) == before
    original = service.prepared
    def outside(*args, **kwargs):
        original(*args, **kwargs); path.write_bytes(path.read_bytes() + b'outside')
    monkeypatch.setattr(service, 'prepared', outside)
    with pytest.raises(w.TagError, match='changed-since'):
        service.edit(path, {'title': 'No'})
    assert 'TIT2' not in ID3(path)


def test_editor_analysis_share_one_lock(edits, write_audio):
    service, path = edits
    write_audio(path, [0.] * 8000, 8000)
    expected, gate = w.identity(path), threading.Barrier(2)
    row = {'key': '5A', 'key_conf': 1., 'bpm': 123., 'bpm_conf': 1.}
    def run(kind):
        gate.wait()
        try:
            if kind == 'editor':
                service.edit(path, {'title': 'Editor', 'bpm': 90}, expected=expected)
            else:
                write_tags(path, row, expected=expected, writer=service.edit)
            return kind
        except w.TagError as error:
            return error.reason
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, ['editor', 'analysis']))
    assert results.count('changed-since') == 1
    fields = w.read(path)['fields']
    assert (fields['title'], fields['bpm'], fields['key']) in [('Editor', 90, None), (None, 123, 'Cm')]
    from mutagen.mp3 import MP3
    assert MP3(path).info.length > 0
    from app.infra.ffmpeg import decode_mono_pcm
    assert len(decode_mono_pcm(path, service.config.ffmpeg_path)) > 0


@pytest.mark.parametrize('phase', ['before', 'after'])
def test_restart_resolves_without_replay(edits, monkeypatch, phase):
    service, path = edits
    real_replace = os.replace
    class Crash(BaseException):
        pass
    def crash(source, target):
        if phase == 'after':
            real_replace(source, target)
        raise Crash()
    monkeypatch.setattr(w.os, 'replace', crash)
    with pytest.raises(Crash):
        service.edit(path, {'title': 'New'})
    orphan = path.parent / '.krobi-tmp-orphan.mp3'; orphan.write_bytes(b'partial')
    before = digest(path)
    restarted = TagEdits(service.config); restarted.recover()
    assert digest(path) == before and not orphan.exists()
    with restarted.repository.connection() as db:
        row = db.execute('SELECT state,reason FROM library_edit_row').fetchone()
    assert tuple(row) == (('applied', None) if phase == 'after' else ('skipped', 'interrupted'))
    restarted.recover(); assert digest(path) == before


def test_undo_refuses_changed_newer_expired_per_file(edits):
    service, path = edits
    items = []
    for idx in range(4):
        sibling = path.with_name(f'{idx}.mp3'); sibling.write_bytes(FRAME)
        items.append({'relPath': f'Album/{idx}.mp3', 'rev': w.read(sibling)['rev']})
    edit, _ = service.batch(items, {'title': 'Bulk'}, 'owner'); service.run_batch(edit)
    outside = path.with_name('1.mp3'); tags = ID3(outside); tags.add(TIT2(text=['Outside'])); tags.save(outside)
    service.edit(path.with_name('2.mp3'), {'title': 'Newer'})
    kept = {idx: digest(path.with_name(f'{idx}.mp3')) for idx in (1, 2)}
    undo, _ = service.start_undo(edit, 'owner'); service.run_undo(undo)
    rows = {r['rel_before']: r for r in service.get(undo)['rows']}
    assert rows['Album/1.mp3']['reason'] == 'changed-since'
    assert rows['Album/2.mp3']['reason'] == 'newer-edit'
    for idx in (0, 3):
        assert w.read(path.with_name(f'{idx}.mp3'))['fields']['title'] is None
    for idx in (1, 2):
        assert digest(path.with_name(f'{idx}.mp3')) == kept[idx]
    assert service.get(edit)['state'] == 'undo-partial'
    change = service.edit(path, {'title': 'Expired'}); service.now = lambda: 10**12
    expired, _ = service.start_undo(change['editId'], 'owner'); before = digest(path); service.run_undo(expired)
    assert service.get(expired)['rows'][0]['reason'] == 'expired' and digest(path) == before


def test_double_undo_and_batch_busy_constraints(edits):
    service, path = edits
    edit = service.edit(path, {'title': 'One'})['editId']
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(service.start_undo, edit, 'owner') for _ in range(2)]
        results = [f.result() for f in futures]
    assert len({r[0] for r in results}) == 1 and sum(r[1] for r in results) == 1
    with pytest.raises(w.TagError, match='busy'):
        service.batch([{'relPath': 'Album/song.mp3', 'rev': w.read(path)['rev']}], {'title': 'Busy'}, 'owner')
    service.run_undo(results[0][0])


def test_hardlinks_and_space_refused(edits, monkeypatch):
    service, path = edits
    link = path.with_name('link.mp3'); os.link(path, link)
    with pytest.raises(w.TagError, match='hardlinked'):
        service.edit(path, {'title': 'No'})
    link.unlink(); monkeypatch.setattr(w.shutil, 'disk_usage', lambda _: SimpleNamespace(free=0))
    with pytest.raises(w.TagError) as error:
        service.edit(path, {'title': 'No'})
    assert error.value.reason == 'no-space' and error.value.status == 507


@pytest.mark.parametrize('fields', [{'year': 10000}, {'trackNumber': 1000}, {'discTotal': -1}, {'title': 'x'*1001},
                                   {'title': 'bad\x00'}, {'genre': 'bad\n'}, {'alien': 'x'}, {'key': 'bad'}])
def test_validation(fields):
    with pytest.raises(w.TagError):
        w.normalize(fields)


def test_only_one_mutagen_save_boundary():
    import runpy
    runpy.run_path(str(Path(__file__).resolve().parents[3] / 'scripts/check-tag-writes.py'), run_name='__main__')


@pytest.mark.parametrize('cut', range(20))
def test_batch_restart_at_each_row(config, cut, monkeypatch):
    service = TagEdits(config)
    folder = config.base_music_dir / 'Album'; folder.mkdir()
    items = []
    for idx in range(20):
        path = folder / f'{idx}.mp3'; path.write_bytes(FRAME)
        items.append({'relPath': f'Album/{idx}.mp3', 'rev': w.read(path)['rev']})
    edit, _ = service.batch(items, {'title': 'Batch'}, 'owner')
    real_replace = os.replace
    class Crash(BaseException):
        pass
    def crash(source, target):
        real_replace(source, target)
        if target.name == f'{cut}.mp3':
            raise Crash()
    monkeypatch.setattr(w.os, 'replace', crash)
    with pytest.raises(Crash):
        service.run_batch(edit)
    before = {p.name: digest(p) for p in folder.glob('*.mp3')}
    restarted = TagEdits(config); restarted.recover()
    assert {p.name: digest(p) for p in folder.glob('*.mp3')} == before
    rows = restarted.get(edit)['rows']
    assert all(r['state'] == ('applied' if idx <= cut else 'skipped') for idx, r in enumerate(rows))
    assert all(r['reason'] == 'interrupted' for r in rows[cut + 1:])
    assert len(list(folder.glob('*.mp3'))) == 20
    assert restarted.get(edit)['state'] == ('applied' if cut == 19 else 'partial')


def test_unknown_recovery_and_alias_clear(edits):
    service, path = edits
    rev = w.read(path)['rev']
    edit, _ = service.batch([{'relPath': 'Album/song.mp3', 'rev': rev}], {'title': 'Never'}, 'owner')
    path.write_bytes(path.read_bytes() + b'outside')
    before = digest(path); service.recover()
    assert digest(path) == before
    assert service.get(edit)['rows'][0]['reason'] == 'unknown-state'
    tags = ID3(); tags.add(TXXX(desc='INITIALKEY', text=['8A'])); tags.save(path)
    service.edit(path, {'key': None})
    assert 'TXXX:INITIALKEY' not in ID3(path)


def test_cover_embedding_uses_same_boundary(edits):
    import logging
    from app.domains.metadata.repositories import MetadataRepository
    service, path = edits
    repo = MetadataRepository(service.config, logging.getLogger(__name__), tag_writer=service.edit)
    repo.embed_cover_art(path, b'image-bytes')
    assert ID3(path)['APIC:Cover'].data == b'image-bytes'
    with service.repository.connection() as db:
        edit = db.execute('SELECT id FROM library_edit').fetchone()[0]
    undo, _ = service.start_undo(edit, 'owner'); service.run_undo(undo)
    assert not ID3(path).getall('APIC')


def test_read_detects_external_change_during_tag_load(edits, monkeypatch):
    _, path = edits
    original = w.load
    def raced(path):
        result = original(path)
        path.write_bytes(path.read_bytes() + b'outside')
        return result
    monkeypatch.setattr(w, 'load', raced)
    with pytest.raises(w.TagError, match='changed-since'):
        w.read(path)


def test_unreadable_and_unsupported_reads(edits):
    _, path = edits
    bad = path.with_suffix('.flac'); bad.write_bytes(b'not audio')
    assert w.read(bad)['reason'] == 'unreadable'
    unsupported = path.with_suffix('.wav'); unsupported.write_bytes(b'not audio')
    assert w.read(unsupported)['reason'] == 'unsupported-format'


def test_undo_restores_analysis_tag_provenance(edits):
    service, path = edits
    rel = 'Album/song.mp3'
    service.repository.mark_legacy_tags([(rel, path.stat().st_size, path.stat().st_mtime_ns)], '{}')
    service.repository.signature(rel, path.stat(), 'krobi', ['bpm', 'key'])
    service.repository.tag_record(rel, 'tag_values', {'bpm': 123, 'key': '5A'})
    service.edit(path, {'bpm': 123})
    # Establish an owned file state, then hand-edit the same field.
    service.repository.signature(rel, path.stat(), 'krobi', ['bpm', 'key'])
    provenance = service.provenance(rel)
    changed = service.edit(path, {'bpm': 90})
    assert service.repository.tag_fields(rel) == ['key']
    undo, _ = service.start_undo(changed['editId'], 'owner'); service.run_undo(undo)
    assert service.provenance(rel) == provenance
    assert w.read(path)['fields']['bpm'] == 123


def test_journal_and_fsync_precede_replace(edits, monkeypatch):
    service, path = edits
    events = []
    replace, fsync = os.replace, os.fsync
    def synced(fd):
        events.append('fsync'); return fsync(fd)
    def replaced(source, target):
        with service.repository.connection() as db:
            row = db.execute('SELECT e.state,r.identity_before,r.identity_after,r.fields_before FROM library_edit e JOIN library_edit_row r ON e.id=r.edit_id').fetchone()
        assert row['state'] == 'applying' and all(row[key] is not None for key in ('identity_before', 'identity_after', 'fields_before'))
        assert events[-1] == 'fsync'
        events.append('replace'); return replace(source, target)
    monkeypatch.setattr(w.os, 'fsync', synced); monkeypatch.setattr(w.os, 'replace', replaced)
    service.edit(path, {'title': 'Durable'})
    assert events.index('replace') > events.index('fsync')
    assert events[-1] == 'fsync'


def test_history_cap_and_row_state_constraints(edits):
    import sqlite3
    service, path = edits
    with service.repository.connection() as db:
        db.executemany("INSERT INTO library_edit(id,kind,principal,state,created_at,expires_at) VALUES(?,'tags','owner','applied',0,?)",
                       [(f'old-{idx}', service.now() + 1000) for idx in range(5000)])
    service.edit(path, {'title': 'Newest'})
    with service.repository.connection() as db:
        assert db.execute('SELECT count(*) FROM library_edit').fetchone()[0] == 5000
        assert db.execute("SELECT id FROM library_edit WHERE id='old-0'").fetchone() is None
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE library_edit SET state='mystery'")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE library_edit_row SET state='mystery'")


def test_revision_catches_equal_stat_external_tag_change(edits):
    service, path = edits
    service.edit(path, {'title': 'Old'})
    expected, stat = w.identity(path), path.stat()
    tags = ID3(path); tags.add(TIT2(encoding=3, text=['New'])); tags.save(path)
    assert path.stat().st_size == stat.st_size
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert w.identity(path)['tagSha'] != expected['tagSha']
    with pytest.raises(w.TagError, match='changed-since'):
        service.edit(path, {'title': 'Lost'}, expected=expected)


def test_cap_keeps_original_while_undo_is_applying(edits):
    service, path = edits
    change = service.edit(path, {'title': 'Oldest'})['editId']
    with service.repository.connection() as db:
        db.executemany("INSERT INTO library_edit(id,kind,principal,state,created_at,expires_at) VALUES(?,'tags','owner','applied',0,?)",
                       [(f'filler-{idx}', service.now() + 1000) for idx in range(4999)])
    undo, _ = service.start_undo(change, 'owner')
    service.run_undo(undo)
    assert service.get(change)['state'] == 'undone'
    assert w.read(path)['fields']['title'] is None


def test_v23_converts_foreign_utf8_without_losing_binary_payload(edits):
    service, path = edits
    tags = ID3(); tags.add(TXXX(encoding=3, desc='Other app', text=['é', 'Two']))
    tags.add(GEOB(encoding=3, desc='Serato Markers2', mime='application/octet-stream', data=b'\xff\x00binary'))
    tags.save(path)
    service.edit(path, {'title': 'New'}, id3_version=3)
    tags = ID3(path, translate=False)
    assert tags.version == (2, 3, 0)
    assert tags['TXXX:Other app'].encoding == 1
    assert tags['TXXX:Other app'].text == ['é; Two']
    assert tags['GEOB:Serato Markers2'].data == b'\xff\x00binary'


def test_journal_attributes_request_and_correction_actors(edits):
    from app.infra.identity import Principal
    from app.infra.progress import progress_principal
    service, path = edits
    token = progress_principal.set(Principal('request-owner', 'Owner', 'owner'))
    try:
        edit = service.edit(path, {'title': 'By owner'})['editId']
    finally:
        progress_principal.reset(token)
    assert service.get(edit)['principal'] == 'request-owner'
    write_tags(path, {'key': '5A', 'bpm': 123, 'key_conf': 1., 'bpm_conf': 1.},
               fixed={'key': '2A'}, writer=service.edit, principal='correction-owner')
    with service.repository.connection() as db:
        assert db.execute('SELECT principal FROM library_edit ORDER BY rowid DESC LIMIT 1').fetchone()[0] == 'correction-owner'
