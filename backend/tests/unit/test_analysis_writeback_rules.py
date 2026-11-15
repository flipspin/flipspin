"""Startup reapplies file effects without recomputing or claiming foreign fields."""
import threading
from unittest.mock import Mock

import pytest
from mutagen.id3 import ID3, TBPM, TKEY, TXXX

from app.domains.music.analysis_constants import WRITEBACK_RULES_VERSION
from app.domains.music.analysis_jobs import AnalysisService
from app.domains.music.analysis_tags import analysis_tags
from tests.unit.test_analysis_step1 import analysis as analysis, claim, submit


def raw_bpm_frame(path):
    """Read the literal ID3v2.4 frame from these fixtures, including its header."""
    data, offset = path.read_bytes(), 10
    while data[offset:offset + 4].strip(b'\0'):
        size = 0
        for byte in data[offset + 4:offset + 8]:
            size = (size << 7) | byte
        end = offset + 10 + size
        if data[offset:offset + 4] == b'TBPM':
            return data[offset:end]
        offset = end
    return None


def owned_song(a, name='song.mp3', **changes):
    """Simulate tags written before the cutoffs changed, without changing the rules."""
    path = a.song(name)
    a.service.scan()
    submit(a, claim(a))
    rel = 'Album/' + name
    row = a.repo.get(rel)
    tags = ID3()
    tags.add(TBPM(encoding=3, text=[str(row['bpm'])]))
    tags.add(TKEY(encoding=3, text=[row['key']]))
    tags.add(TXXX(encoding=3, desc='KROBI_ANALYSIS', text=['old-engine']))
    tags.save(path)
    a.repo.signature(rel, path.stat(), 'krobi', ['bpm', 'key'])
    if changes:
        with a.repo.connection() as db:
            db.execute(f"UPDATE track_analysis SET {','.join(f'{field}=?' for field in changes)} WHERE rel_path=?",
                       (*changes.values(), rel))
    return path, rel


@pytest.mark.parametrize('bpm_conf,key_conf,expected,fields', [
    (.4, .004, {'bpm': 123.5, 'key': '5A', 'tag_owner': 'krobi'}, ['bpm', 'key']),
    (.399, .003, {'bpm': None, 'key': None, 'tag_owner': None}, []),
    (.399, .004, {'bpm': None, 'key': '5A', 'tag_owner': 'krobi'}, ['key']),
    (.4, .003, {'bpm': 123.5, 'key': None, 'tag_owner': 'krobi'}, ['bpm']),
])
def test_reapply_confidence_per_field_and_refresh_signature(analysis, bpm_conf, key_conf, expected, fields, caplog):
    a = analysis
    path, rel = owned_song(a, bpm_conf=bpm_conf, key_conf=key_conf)
    before, ledger_version = a.repo.get(rel), a.ledger.version
    a.config.write_analysis_tags = True

    assert a.service.reapply_writeback_rules()

    assert analysis_tags(ID3(path)) == expected
    if expected['tag_owner']:
        assert ID3(path)['TXXX:KROBI_ANALYSIS'].text == ['keyfinder+tempocnn@2']
    row = a.repo.get(rel)
    assert row == {**before, 'size': path.stat().st_size, 'mtime_ns': path.stat().st_mtime_ns,
                   'tag_owner': expected['tag_owner']}
    assert a.repo.tag_fields(rel) == fields
    assert a.repo.meta('writeback_rules_version') == WRITEBACK_RULES_VERSION
    assert a.service.scan() == 0
    assert a.ledger.version == ledger_version
    assert f'rewritten={int(bool(fields))} removed={int(not fields)} untouched=0' in caplog.text


@pytest.mark.parametrize('foreign', ['90.00', None])
def test_reapply_never_claims_foreign_sibling_even_when_empty(analysis, foreign):
    a = analysis
    path, rel = owned_song(a, key_conf=0)
    tags = ID3(path)
    tags.delall('TBPM')
    if foreign:
        tags.add(TBPM(encoding=0, text=[foreign]))
    tags.save(path)
    a.repo.signature(rel, path.stat(), 'krobi', ['key'])
    before = raw_bpm_frame(path)
    a.config.write_analysis_tags = True

    assert a.service.reapply_writeback_rules()

    after = ID3(path)
    assert raw_bpm_frame(path) == before
    assert analysis_tags(after) == {'bpm': float(foreign) if foreign else None, 'key': None, 'tag_owner': None}


def test_foreign_file_and_fixed_written_tags_are_byte_identical(analysis):
    a = analysis
    path, rel = owned_song(a, bpm_conf=0, key_conf=0)
    a.config.write_analysis_tags = True
    assert a.service.fix(rel, path, 0, {'bpm': 140, 'key': '2A'}, 'owner')[0]
    before = path.read_bytes(), a.repo.get(rel)
    assert a.service.reapply_writeback_rules()
    assert (path.read_bytes(), a.repo.get(rel)) == before


def test_external_edit_relinquishes_ownership_without_touching_file(analysis):
    a = analysis
    path, rel = owned_song(a, bpm_conf=0, key_conf=0)
    tags = ID3(path)
    tags.add(TBPM(encoding=3, text=['140']))
    tags.save(path)
    before = path.read_bytes()
    a.config.write_analysis_tags = True
    assert a.service.reapply_writeback_rules()
    assert path.read_bytes() == before
    assert a.repo.get(rel)['tag_owner'] is None


def test_writeback_off_leaves_file_row_and_version_untouched(analysis):
    a = analysis
    path, rel = owned_song(a, bpm_conf=0, key_conf=0)
    before = path.read_bytes(), a.repo.get(rel), a.repo.revision
    assert a.service.reapply_writeback_rules()
    assert (path.read_bytes(), a.repo.get(rel), a.repo.revision) == before
    assert a.repo.meta('writeback_rules_version') is None


def test_startup_reapplies_before_scan_and_second_boot_does_nothing(analysis, monkeypatch):
    a = analysis
    path, rel = owned_song(a, bpm_conf=0, key_conf=0)
    a.config.write_analysis_tags = True
    scanned = threading.Event()
    scan = a.service.scan

    def scan_after_reapply(**_):
        assert a.repo.meta('writeback_rules_version') == WRITEBACK_RULES_VERSION
        assert analysis_tags(ID3(path))['tag_owner'] is None
        assert scan() == 0
        a.service._stop.set()
        scanned.set()

    monkeypatch.setattr(a.service, 'scan', scan_after_reapply)
    a.service.startup()
    assert scanned.wait(3)
    a.service.stop()
    before = path.read_bytes(), path.stat(), a.repo.get(rel), a.repo.revision
    again = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    monkeypatch.setattr('app.domains.music.analysis_jobs.write_tags', Mock(side_effect=AssertionError('second boot')))
    assert again.reapply_writeback_rules()
    assert (path.read_bytes(), path.stat(), a.repo.get(rel), a.repo.revision) == before


@pytest.mark.parametrize('interruption', ['stop', 'failure'])
def test_interrupted_pass_resumes_on_next_boot(analysis, monkeypatch, interruption):
    a = analysis
    first, _ = owned_song(a, 'a.mp3', bpm_conf=0, key_conf=0)
    second, _ = owned_song(a, 'b.mp3', bpm_conf=0, key_conf=0)
    a.config.write_analysis_tags = True
    apply_file = a.service._reapply_file_writeback

    def interrupt(rel):
        if rel.endswith('b.mp3'):
            raise OSError('interrupted file write')
        result = apply_file(rel)
        if interruption == 'stop':
            a.service._stop.set()
        return result

    monkeypatch.setattr(a.service, '_reapply_file_writeback', interrupt)
    if interruption == 'stop':
        assert not a.service.reapply_writeback_rules()
    else:
        with pytest.raises(OSError, match='interrupted file write'):
            a.service.reapply_writeback_rules()
    assert a.repo.meta('writeback_rules_version') is None
    assert analysis_tags(ID3(first))['tag_owner'] is None
    assert analysis_tags(ID3(second))['tag_owner'] == 'krobi'

    again = AnalysisService(a.config, a.repo, a.music, a.ledger, a.worker)
    assert again.reapply_writeback_rules()
    assert analysis_tags(ID3(second))['tag_owner'] is None
    assert a.repo.meta('writeback_rules_version') == WRITEBACK_RULES_VERSION
    assert again.scan() == 0


def test_reapply_waits_for_scan_and_yields_between_files(analysis, monkeypatch):
    a = analysis
    owned_song(a, 'a.mp3')
    owned_song(a, 'b.mp3')
    a.config.write_analysis_tags = True
    waits = []
    wait = a.service._stop.wait
    a.service._scan_lock.acquire()

    def pause(seconds):
        waits.append(seconds)
        assert seconds > 0
        # The first wait must be for the active scan, before any write.
        if len(waits) == 1:
            assert a.repo.meta('writeback_rules_version') is None
            a.service._scan_lock.release()
        else:
            assert a.service._scan_lock.acquire(blocking=False)
            a.service._scan_lock.release()
        return wait(0)

    monkeypatch.setattr(a.service._stop, 'wait', pause)
    assert a.service.reapply_writeback_rules()
    assert len(waits) == 3


def test_marker_only_cleanup_and_interruption_after_file_save(analysis, monkeypatch):
    a = analysis
    path, rel = owned_song(a, bpm_conf=0, key_conf=0)
    tags = ID3(path)
    tags.delall('TBPM')
    tags.delall('TKEY')
    tags.save(path)
    a.config.write_analysis_tags = True
    signature = a.repo.signature
    monkeypatch.setattr(a.repo, 'signature', Mock(side_effect=OSError('interrupted after save')))

    with pytest.raises(OSError, match='interrupted after save'):
        a.service.reapply_writeback_rules()
    assert analysis_tags(ID3(path)) == {'bpm': None, 'key': None, 'tag_owner': None}
    assert a.repo.get(rel)['tag_owner'] == 'krobi'
    assert a.repo.meta('writeback_rules_version') is None

    monkeypatch.setattr(a.repo, 'signature', signature)
    assert a.service.reapply_writeback_rules()
    assert a.repo.get(rel)['tag_owner'] is None
    assert a.repo.tag_fields(rel) == []
    assert a.service.scan() == 0


def test_concurrent_passes_are_serialized_and_scan_cannot_overlap_write(analysis, monkeypatch):
    a = analysis
    owned_song(a)
    a.config.write_analysis_tags = True
    started, release, waiting = threading.Event(), threading.Event(), threading.Event()
    apply_file, wait = a.service._reapply_file_writeback, a.service._stop.wait
    results, calls = [], []

    def blocked_write(rel):
        calls.append(rel)
        started.set()
        assert release.wait(3)
        assert a.service.scan() == 0  # A scan cannot enter during this write.
        return apply_file(rel)

    def pause(seconds):
        waiting.set()
        return wait(seconds)

    monkeypatch.setattr(a.service, '_reapply_file_writeback', blocked_write)
    monkeypatch.setattr(a.service._stop, 'wait', pause)
    first = threading.Thread(target=lambda: results.append(a.service.reapply_writeback_rules()))
    second = threading.Thread(target=lambda: results.append(a.service.reapply_writeback_rules()))
    first.start()
    try:
        assert started.wait(3)
        second.start()
        assert waiting.wait(3)
        assert a.repo.meta('writeback_rules_version') is None
    finally:
        release.set()
        first.join(3)
        if second.ident:
            second.join(3)
    assert results == [True, True]
    assert calls == ['Album/song.mp3']
