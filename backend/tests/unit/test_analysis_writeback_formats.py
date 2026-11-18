"""Analysis effects use native atoms and preserve metadata across file formats."""
import numpy as np
import pytest
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, TXXX
from mutagen.mp4 import MP4FreeForm

from app.domains.metadata import tagreader, tagwriter
from app.domains.music.analysis_constants import ENGINE, ENGINE_VERSION
from app.domains.music.analysis_tags import analysis_tags
from app.domains.music.analysis_writeback import write_tags
from tests.unit.test_analysis_step1 import analysis as analysis, claim, submit


def fixture_audio(tmp_path, write_audio, suffix):
    path = tmp_path / ('song' + suffix)
    write_audio(path, np.zeros(4410), 44100)
    tagwriter.write(path, {'title': 'Original title', 'artist': ['Original artist']}, expected=tagwriter.identity(path))
    if suffix == '.mp3':
        tags = ID3(path)
        tags.add(TXXX(encoding=3, desc='FOREIGN', text=['keep me']))
        tags.save(path)
    else:
        audio = MutagenFile(path)
        if suffix in ('.m4a', '.mp4'):
            audio['----:example:FOREIGN'] = [MP4FreeForm(b'keep me')]
        else:
            audio['FOREIGN'] = ['keep me']
        audio.save()
    return path


def read_tags(path):
    _, tags, mode = tagwriter.load(path)
    return tags, tagreader.read(tags, mode)


def assert_foreign(tags, suffix):
    if suffix == '.mp3':
        assert tags['TXXX:FOREIGN'].text == ['keep me']
    elif suffix in ('.m4a', '.mp4'):
        assert tags['----:example:FOREIGN'] == [b'keep me']
    else:
        assert tags['FOREIGN'] == ['keep me']


@pytest.mark.parametrize('suffix', ['.m4a', '.mp4', '.mp3', '.flac', '.ogg'])
def test_analysis_tags_round_trip_and_correction(tmp_path, write_audio, suffix):
    path = fixture_audio(tmp_path, write_audio, suffix)
    row = {'bpm': 128, 'key': '8A', 'bpm_conf': .9, 'key_conf': .9}
    assert write_tags(path, row) == (True, 'krobi', ['bpm', 'key'])
    tags, read = read_tags(path)
    assert analysis_tags(tags) == {'bpm': 128, 'key': '8A', 'tag_owner': 'krobi'}
    assert {field: read[field] for field in ('bpm', 'key', 'tag_owner')} == analysis_tags(tags)
    assert read['title'] == 'Original title'
    assert read['artist'] == 'Original artist'
    assert_foreign(tags, suffix)
    if suffix in ('.m4a', '.mp4'):
        assert tags['tmpo'] == [128]
        assert tags['----:com.apple.iTunes:initialkey'] == [b'Am']
        assert tags['----:com.apple.iTunes:KROBI_ANALYSIS'] == [f'{ENGINE}@{ENGINE_VERSION}'.encode()]

    assert write_tags(path, {**row, 'tag_owner': 'krobi'}, fixed={'bpm': 132, 'key': '9B'}) == (True, 'krobi', ['bpm', 'key'])
    tags, read = read_tags(path)
    assert analysis_tags(tags) == {'bpm': 132, 'key': '9B', 'tag_owner': 'krobi'}
    assert {field: read[field] for field in ('bpm', 'key', 'tag_owner')} == analysis_tags(tags)
    assert_foreign(tags, suffix)
    assert read['title'] == 'Original title'


@pytest.mark.parametrize('suffix', ['.m4a', '.mp4'])
def test_foreign_analysis_atoms_survive_until_explicit_correction(tmp_path, write_audio, suffix):
    path = fixture_audio(tmp_path, write_audio, suffix)
    tagwriter.write(path, {'bpm': 90, 'key': '2A'}, expected=tagwriter.identity(path))
    row = {'bpm': 128, 'key': '8A', 'bpm_conf': .9, 'key_conf': .9}
    assert write_tags(path, row) == (False, None, None)
    tags, read = read_tags(path)
    assert read['bpm'] == 90
    assert read['key'] == '2A'
    assert '----:com.apple.iTunes:KROBI_ANALYSIS' not in tags
    assert_foreign(tags, suffix)
    assert write_tags(path, row, fixed={'bpm': 132, 'key': '9B'}) == (True, 'krobi', ['bpm', 'key'])
    tags, read = read_tags(path)
    assert read['bpm'] == 132
    assert read['key'] == '9B'
    assert_foreign(tags, suffix)


@pytest.mark.parametrize('suffix', ['.m4a', '.mp4'])
def test_owned_atoms_are_removed_when_confidence_drops(tmp_path, write_audio, suffix):
    path = fixture_audio(tmp_path, write_audio, suffix)
    row = {'bpm': 128, 'key': '8A', 'bpm_conf': .9, 'key_conf': .9}
    write_tags(path, row)
    assert write_tags(path, {**row, 'tag_owner': 'krobi', 'bpm_conf': 0, 'key_conf': 0}) == (True, None, [])
    tags, read = read_tags(path)
    assert analysis_tags(tags) == {'bpm': None, 'key': None, 'tag_owner': None}
    assert {field: read[field] for field in ('bpm', 'key', 'tag_owner')} == analysis_tags(tags)
    assert_foreign(tags, suffix)


def test_analysis_service_retains_ownership_after_native_bpm_rounding(analysis, write_audio):
    a = analysis
    album = a.config.base_music_dir / 'Album'
    album.mkdir(exist_ok=True)
    path = fixture_audio(album, write_audio, '.m4a')
    rel = 'Album/' + path.name
    a.config.write_analysis_tags = True
    assert a.service.scan() == 1
    submit(a, claim(a))  # Analysis rounds 123.46 to 123.5 BPM; tmpo stores whole numbers.
    tags, read = read_tags(path)
    assert read['bpm'] == 124
    assert read['key'] == '5A'
    assert read['tag_owner'] == 'krobi'
    assert a.service.view(rel, path)['bpm']['source'] == 'computed'
    assert a.repo.tag_fields(rel) == ['bpm', 'key']
    row = a.repo.get(rel)
    ok, _ = a.service.fix(rel, path, row['rev'], {'bpm': 132, 'key': '9B'}, 'owner')
    assert ok
    tags, read = read_tags(path)
    assert read['bpm'] == 132
    assert read['key'] == '9B'
    assert_foreign(tags, '.m4a')
    assert a.service.scan() == 0
