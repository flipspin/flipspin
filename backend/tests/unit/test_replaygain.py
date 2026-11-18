"""Loudness store, global album gating, tag precedence and lossless write policy."""
import json
import math
from pathlib import Path

import pytest
from mutagen.id3 import ID3, TXXX
from mutagen._vorbis import VCommentDict

from app.domains.metadata import tagreader, tagwriter
from app.domains.metadata.replaygain import gain_values
from app.domains.music.analysis_jobs import Measurement
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_tags import analysis_tags
from app.domains.music.analysis_writeback import reconcile_ownership, write_tags
from app.domains.music.loudness import album_values, integrated, replay_gain

CASES = json.loads((Path(__file__).parents[3] / 'contracts/replaygain.json').read_text())


@pytest.mark.parametrize('case', CASES['cases'], ids=lambda c: c['name'])
@pytest.mark.parametrize('mode', [0, 1, 2], ids=['id3', 'vorbis', 'mp4'])
def test_gain_contract(case, mode):
    native = ID3() if mode == 0 else VCommentDict() if mode == 1 else {}
    fields = {field: str(value) for field, value in case['tags'].items() if field in tagwriter.GAIN_TAG_FIELDS}
    if case['tags'].get('tag_owner') == 'krobi':
        fields['analysisMarker'] = 'keyfinder+tempocnn@2'
    tagwriter.patch(native, mode, fields)
    for tags in (analysis_tags(native), tagreader.read(native, mode)):
        if 'owned_fields' in case['tags']:
            tags['owned_fields'] = case['tags']['owned_fields']
        assert replay_gain(case['row'], tags) == case['expected']


def test_album_gate_uses_blocks_instead_of_track_gain_average():
    # The quiet song is excluded by the album's relative gate.
    rows = [{'loudness_blocks': json.dumps([-10.] * 10), 'true_peak': .9},
            {'loudness_blocks': json.dumps([-40.] * 100), 'true_peak': .1}]
    assert album_values(rows) == pytest.approx((-8, .9))
    assert integrated([-120, -80]) is None
    assert album_values([rows[0], None]) == (None, None)
    # Unequal lengths weight windows, rather than each track equally.
    expected = 10 * math.log10((10 * 10**-2 + 100 * 10**-2.5) / 110)
    assert integrated([-20.] * 10 + [-25.] * 100) == pytest.approx(expected)


@pytest.mark.parametrize('mode', [0, 1, 2])
def test_native_tags_and_r128_q78(mode):
    tags = ID3() if mode == 0 else VCommentDict() if mode == 1 else {}
    tagwriter.patch(tags, mode, {'trackGain': '-7.25 dB', 'r128AlbumGain': '-512', 'trackPeak': '0.75'})
    parsed = tagreader.read(tags, mode)
    assert parsed['trackGain'] == -7.25
    assert parsed['albumGain'] == 3
    assert parsed['trackPeak'] == .75
    assert gain_values({'trackGain': 'NaN', 'trackPeak': '-1', 'r128TrackGain': 'bad'})['trackGain'] is None
    assert gain_values({'r128TrackGain': '32768'})['trackGain'] is None


def test_store_upgrade_preserves_corrections_and_complete_album_signatures(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    repo.fix('A/1', 0, {'bpm': 120}, 'owner')
    result = dict(size=1, mtime_ns=2, engine='keyfinder+tempocnn', engine_version=2,
                  key='8B', key_conf=.9, bpm=100, bpm_conf=.9, energy=.1, brightness=.2, pulse=1,
                  track_lufs=-24, true_peak=.5, lra=2, decode_seconds=.3, loudness_blocks=[-24.] * 10)
    repo.apply('A/1', result, 'calm')
    repo.apply('A/2', result, 'calm')
    assert repo.album_loudness({'A/1': (1, 2), 'A/2': (1, 2)}) == pytest.approx((6, .5))
    row = repo.get('A/1')
    assert row['fixed_bpm'] == 120 and row['decode_seconds'] == .3
    assert row['album_gain'] == pytest.approx(6)
    revision = repo.revision
    assert repo.album_loudness({'A/1': (1, 2), 'A/2': (1, 3)}) == (None, None)
    assert repo.get('A/1')['album_gain'] is None and repo.revision > revision


def test_loudness_upgrade_preserves_arousal_and_its_triggers(tmp_path):
    from app.domains.music.analysis_schema import ANALYSIS
    from app.infra.migrations import SQLiteStore, open_store

    path = tmp_path / 'analysis.sqlite'
    db = open_store(path, SQLiteStore(ANALYSIS.name, ANALYSIS.steps[:8], ANALYSIS.baseline))
    with db:
        db.execute("INSERT INTO track_analysis (rel_path,energy,pulse,bpm,fixed_bpm,rev,arousal) VALUES ('A/1',.3,.8,120,80,4,.5)")
        db.execute("INSERT INTO meta VALUES ('arousal_rule_version','1')")
        db.execute("DELETE FROM meta WHERE key='arousal_dirty'")
    db.close()
    repo = AnalysisRepository(path)
    row = repo.get('A/1')
    assert (row['arousal'], row['fixed_bpm'], row['rev']) == (.5, 80, 4)
    assert row['track_lufs'] is None and row['album_gain'] is None
    assert repo.meta('arousal_dirty') is None
    with repo.connection() as db:
        assert db.execute('PRAGMA user_version').fetchone()[0] == len(ANALYSIS.steps)
        db.execute("UPDATE track_analysis SET energy=.4 WHERE rel_path='A/1'")
    assert repo.meta('arousal_dirty') == '1'
    revision = repo.revision
    with repo.connection() as db:
        db.execute("UPDATE track_analysis SET track_lufs=-24,true_peak=.5 WHERE rel_path='A/1'")
    assert repo.revision > revision


def test_writeback_uses_writer_preserves_foreign_gain_and_audio(tmp_path):
    path = tmp_path / 'song.mp3'
    audio = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 40
    path.write_bytes(audio)
    tags = ID3()
    tags.add(TXXX(encoding=3, desc='R128_TRACK_GAIN', text=['-256']))
    tags.add(TXXX(encoding=3, desc='OTHER', text=['preserve']))
    tags.save(path)
    row = dict(track_lufs=-24., true_peak=.5, album_gain=-2., album_peak=.8)
    write_tags(path, row)
    after = ID3(path)
    assert 'TXXX:REPLAYGAIN_TRACK_GAIN' not in after
    assert after['TXXX:R128_TRACK_GAIN'].text == ['-256']
    assert after['TXXX:REPLAYGAIN_ALBUM_GAIN'].text == ['-2.00 dB']
    assert after['TXXX:KROBI_ANALYSIS'].text == ['keyfinder+tempocnn@2']
    assert after['TXXX:OTHER'].text == ['preserve']
    assert path.read_bytes()[after.size:] == audio
    write_tags(path, {**row, 'album_gain': 10})
    assert ID3(path)['TXXX:REPLAYGAIN_ALBUM_GAIN'].text == ['-2.00 dB']


def test_reject_nonfinite_and_unbounded_helper_blocks():
    from test_analysis_step1 import measurement
    item = measurement({'relPath': 'A/a', 'size': 1, 'mtimeNs': 2})
    for bad in (float('nan'), float('inf'), -71, 31):
        with pytest.raises(ValueError):
            Measurement.model_validate({**item, 'loudnessBlocks': [bad]})


@pytest.mark.parametrize('save', [False, True])
def test_helper_result_album_store_projection_and_opt_in(analysis, save):
    from test_analysis_step1 import claim, measurement, submit
    a = analysis
    a.config.write_analysis_tags = save
    paths = [a.song('one.mp3', 'Artist/Album/CD1'), a.song('two.mp3', 'Artist/Album/CD2')]
    before = [p.read_bytes() for p in paths]
    assert a.service.enqueue_files(paths) == 2
    got = claim(a)
    items = [measurement(item, trackLufs=-24., truePeak=.5, lra=2., decodeSeconds=.2, loudnessBlocks=[-24.] * 10)
             for item in got['job']['input']['items']]
    reply = submit(a, got, items)
    assert all(i['status'] == 200 for i in reply['items'])
    assert a.repo.get(items[0]['relPath'])['album_gain'] == pytest.approx(6)
    assert a.repo.get(items[0]['relPath'])['arousal'] is not None
    tracks = a.music.scan_albums()[0].tracks
    for index, song in enumerate(tracks):
        assert song.analysis['replayGain']['trackGain'] == pytest.approx(6, abs=.01)
        assert song.analysis['replayGain']['albumGain'] == pytest.approx(6, abs=.01)
        if save:
            tags = ID3(song.path)
            assert tags['TXXX:REPLAYGAIN_TRACK_GAIN'].text == ['+6.00 dB']
            assert tags['TXXX:REPLAYGAIN_ALBUM_GAIN'].text == ['+6.00 dB']
            assert song.path.read_bytes()[tags.size:] == before[index]
            rel = items[index]['relPath']
            assert {'trackGain', 'albumGain', 'trackPeak', 'albumPeak'} <= set(a.repo.tag_fields(rel))
        else:
            assert song.path.read_bytes() == before[index]
    # A changed sibling invalidates the computed album gain at the next scan.
    paths[1].write_bytes(paths[1].read_bytes() + b'changed')
    a.music.invalidate_scan()
    current = a.music.scan_albums()[0].tracks[0].analysis['replayGain']
    if not save:
        assert current['albumGain'] is None
        assert current['trackGain'] == 6


@pytest.fixture
def analysis(config):
    # Reuse the real queue/store/catalog fixture without duplicating its wiring.
    from test_analysis_step1 import analysis as fixture
    yield from fixture.__wrapped__(config)


@pytest.mark.parametrize('suffix,codec', [('.opus', 'libopus'), ('.m4a', 'aac')])
def test_gain_writeback_for_opus_and_mp4_uses_standard_tags(tmp_path, suffix, codec):
    import shutil
    import subprocess
    from mutagen import File
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg not installed')
    path = tmp_path / ('song' + suffix)
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
                    '-c:a', codec, str(path)], check=True)
    row = dict(track_lufs=-24., true_peak=.5, album_gain=-2., album_peak=.8)
    write_tags(path, row)
    audio = File(path)
    parsed = tagreader.read(audio.tags, tagwriter.FORMATS[suffix])
    assert parsed['trackGain'] == pytest.approx(6)
    assert parsed['albumGain'] == pytest.approx(-2)
    if suffix == '.opus':
        assert audio.tags['R128_TRACK_GAIN'] == ['256']
        assert audio.tags['R128_ALBUM_GAIN'] == ['-1792']
        assert not any(key.upper().startswith('REPLAYGAIN_') for key in audio.tags.keys())
    write_tags(path, {**row, 'album_gain': 10})
    assert tagreader.read(File(path).tags, tagwriter.FORMATS[suffix])['albumGain'] == pytest.approx(-2)


def test_decode_timing_is_bookkeeping_and_failed_audio_has_no_gain(tmp_path):
    repo = AnalysisRepository(tmp_path / 'analysis.sqlite')
    result = dict(size=1, mtime_ns=2, engine='keyfinder+tempocnn', engine_version=2,
                  key='8B', key_conf=.9, bpm=100, bpm_conf=.9, energy=.1, brightness=.2, pulse=1,
                  track_lufs=-24, true_peak=.5, lra=2, decode_seconds=.3, loudness_blocks=[-24.] * 10)
    repo.apply('A/1', result, 'calm')
    repo.album_loudness({'A/1': (1, 2)})
    before, revision = repo.get('A/1'), repo.revision
    assert not repo.apply('A/1', {**result, 'decode_seconds': .4}, 'calm')
    after = repo.get('A/1')
    assert after['rev'] == before['rev'] and repo.revision == revision
    assert after['album_gain'] == before['album_gain']
    assert after['decode_seconds'] == .4
    repo.error('A/1', 'undecodable', (3, 4))
    assert album_values([repo.get('A/1')]) == (None, None)


def test_gain_tags_are_reserved_from_the_editor_and_case_insensitive(tmp_path):
    from app.domains.music.tag_routes import TagPatch
    for field in tagwriter.GAIN_TAG_FIELDS:
        with pytest.raises(ValueError):
            TagPatch.model_validate({'set': {field: '1'}})
    tags = ID3()
    tags.add(TXXX(encoding=3, desc='replaygain_track_gain', text=['-3.2 dB']))
    assert tagreader.read(tags, 0)['trackGain'] == -3.2
    path = tmp_path / 'tagged.mp3'
    path.write_bytes((b'\xff\xfb\x90\x00' + b'\x00' * 413) * 40)
    tags.save(path)
    write_tags(path, {'track_lufs': -24.})
    assert ID3(path)['TXXX:replaygain_track_gain'].text == ['-3.2 dB']
    assert 'trackGain' not in tagwriter.read(path)['fields']


@pytest.mark.parametrize('r128', [False, True], ids=['replaygain', 'r128'])
@pytest.mark.parametrize('edit', [None, 'gain', 'marker'])
def test_gain_ownership_uses_record_and_marker_and_detects_external_edits(analysis, r128, edit):
    from test_analysis_step1 import claim, measurement, submit
    a = analysis
    path = a.song()
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(got['job']['input']['items'][0], trackLufs=-24., truePeak=.5)])
    rel = 'Album/song.mp3'
    native = ID3()
    field = 'R128_TRACK_GAIN' if r128 else 'REPLAYGAIN_TRACK_GAIN'
    native.add(TXXX(encoding=3, desc=field, text=['256' if r128 else '+6.00 dB']))
    native.add(TXXX(encoding=3, desc='KROBI_ANALYSIS', text=['keyfinder+tempocnn@2']))
    native.save(path)
    a.repo.signature(rel, path.stat(), 'krobi', ['trackGain'])
    a.repo.tag_record(rel, 'tag_values', a.music.read_tags(path))
    # New measurements must beat the old Krobi tag, without rewriting the file.
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET track_lufs=-20 WHERE rel_path=?', (rel,))
    if edit == 'gain':
        native.add(TXXX(encoding=3, desc=field, text=['-512' if r128 else '-2.00 dB']))
        native.save(path)
    elif edit == 'marker':
        native.delall('TXXX:KROBI_ANALYSIS')
        native.save(path)
    a.music.invalidate_scan()
    row, tags = reconcile_ownership(a.repo, rel, a.repo.get(rel), a.music.read_tags(path), path.stat())
    expected = 2 if edit is None else (3 if r128 else -2) if edit == 'gain' else 6
    assert replay_gain(row, tags)['trackGain'] == expected
    assert a.repo.get(rel)['tag_owner'] == ('krobi' if edit is None else None)
    if edit is None:
        assert a.music.scan_albums()[0].tracks[0].analysis['replayGain']['trackGain'] == 2


def test_album_writeback_keeps_gain_ownership_on_subsequent_passes(analysis):
    from test_analysis_step1 import claim, measurement, submit
    a = analysis
    a.config.write_analysis_tags = True
    path = a.song()
    a.service.scan()
    got = claim(a)
    submit(a, got, [measurement(got['job']['input']['items'][0], trackLufs=-24., truePeak=.5, loudnessBlocks=[-24.] * 10)])
    rel = 'Album/song.mp3'
    with a.repo.connection() as db:
        db.execute('UPDATE track_analysis SET track_lufs=-20, album_gain=2 WHERE rel_path=?', (rel,))
    a.service._writeback(rel, path)
    tags = analysis_tags(ID3(path))
    assert tags['trackGain'] == tags['albumGain'] == 2
    assert {'trackGain', 'albumGain', 'trackPeak', 'albumPeak'} <= set(a.repo.tag_fields(rel))
