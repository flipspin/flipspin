"""Download identity uses the same transactional writer and Picard field table."""
import logging
from dataclasses import replace
from unittest.mock import Mock

import pytest
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, TIT2, TXXX, UFID

from app.domains.acquisition.engine import DownloadEngine
from app.domains.metadata import tagwriter as w
from app.domains.metadata.repositories import MetadataRepository
from app.domains.music.models import AudioMetadata
from app.domains.music.tag_edits import TagEdits
from app.infra.job_requests import encode_request, decode_request
from app.infra.jobs.schema import JOBS
from app.infra.media_requests import TrackMetadata
from app.infra.migrations import open_store
from tests.unit import test_acquisition as helpers

pipeline = helpers.pipeline
GROUP = '33333333-3333-4333-8333-333333333333'
ARTISTS = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'ogg', 'm4a'])
def test_known_group_artists_and_composer_keep_picard_names(config, write_audio, extension):
    path = config.temp_dir / f'identity.{extension}'
    write_audio(path, [0.] * 8000, 8000)
    edits = TagEdits(config)
    repo = MetadataRepository(config, logging.getLogger(__name__), tag_writer=edits.edit)
    meta = AudioMetadata(title='Known', release_group_mbid=GROUP, artist_mbid=ARTISTS, composer='Composer')
    repo.write_id3_tags(path, meta)
    tags = MutagenFile(path).tags
    if extension == 'mp3':
        assert tags['TXXX:MusicBrainz Release Group Id'].text == [GROUP]
        assert tags['TXXX:MusicBrainz Artist Id'].text == ARTISTS
        assert tags['TCOM'].text == ['Composer']
    elif extension == 'm4a':
        assert tags['----:com.apple.iTunes:MusicBrainz Release Group Id'] == [GROUP.encode()]
        assert tags['----:com.apple.iTunes:MusicBrainz Artist Id'] == [v.encode() for v in ARTISTS]
        assert tags['©wrt'] == ['Composer']
    else:
        assert tags['MUSICBRAINZ_RELEASEGROUPID'] == [GROUP]
        assert tags['MUSICBRAINZ_ARTISTID'] == ARTISTS
        assert tags['COMPOSER'] == ['Composer']
    before = path.read_bytes()
    replacement = AudioMetadata(release_group_mbid='new-group', artist_mbid='new-artist', composer='New composer')
    repo.write_id3_tags(path, replacement)
    assert path.read_bytes() == before
    repo.write_id3_tags(path, replacement, overwrite=True)
    fields = w.read(path)['fields']
    assert (fields['mbReleaseGroup'], fields['mbArtist'], fields['composer']) == ('new-group', 'new-artist', 'New composer')


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'ogg', 'm4a'])
@pytest.mark.parametrize('overwrite', [False, True])
def test_import_omits_missing_numbers_and_preserves_native_totals(config, write_audio, extension, overwrite):
    path = config.temp_dir / f'no-number.{extension}'
    write_audio(path, [0.] * 8000, 8000)
    repo = MetadataRepository(config, logging.getLogger(__name__))
    repo.write_id3_tags(path, AudioMetadata(title='Song', track_total=12, disc_total=2), overwrite=overwrite)
    tags = MutagenFile(path).tags
    assert all(key not in tags for key in ('TRCK', 'TPOS', 'trkn', 'disk', 'TRACKNUMBER', 'DISCNUMBER'))
    if extension in ('flac', 'ogg'):
        assert tags['TRACKTOTAL'] == ['12'] and tags['DISCTOTAL'] == ['2']
    repo.write_id3_tags(path, AudioMetadata(track_number=3, track_total=12, disc_number=1, disc_total=2), overwrite=True)
    before = path.read_bytes()
    repo.write_id3_tags(path, AudioMetadata(track_total=99, disc_total=99), overwrite=overwrite)
    changed = overwrite and extension in ('flac', 'ogg')
    assert (path.read_bytes() != before) is changed
    fields = w.read(path)['fields']
    assert (fields['trackNumber'], fields['trackTotal'], fields['discNumber'], fields['discTotal']) == (3, 99 if changed else 12, 1, 99 if changed else 2)


@pytest.mark.parametrize('prefix,key', [('track', 'TRCK'), ('disc', 'TPOS')])
@pytest.mark.parametrize('extension', ['mp3', 'm4a'])
def test_safe_writer_never_creates_total_only_pairs(config, write_audio, prefix, key, extension):
    path = config.temp_dir / f'no-pair.{extension}'
    write_audio(path, [0.] * 8000, 8000)
    before = path.read_bytes()
    outcome = w.write(path, {prefix + 'Total': 12}, expected=w.identity(path))
    assert outcome[2] is False and path.read_bytes() == before
    assert key not in MutagenFile(path).tags
    assert ('trkn' if prefix == 'track' else 'disk') not in MutagenFile(path).tags


@pytest.mark.parametrize('value,expected', [(123.4, 123), (123.5, 124), ('123.5', 124), (124.5, 124)])
def test_mp4_tempo_rounds_float_values(config, write_audio, value, expected):
    path = config.base_music_dir / 'Album/tempo.m4a'
    path.parent.mkdir()
    write_audio(path, [0.] * 8000, 8000)
    repo = MetadataRepository(config, logging.getLogger(__name__))
    repo.write_id3_tags(path, AudioMetadata(bpm=value))
    tempo = MutagenFile(path).tags['tmpo']
    assert tempo == [expected]
    assert type(tempo[0]) is int
    edits = TagEdits(config)
    before = path.read_bytes()
    result = edits.edit(path, {'bpm': float(value)})
    assert result['changed'] is False and result['editId'] is None
    assert path.read_bytes() == before


def test_gap_fill_respects_legacy_recording_alias_and_fills_empty_native_values(config, write_audio):
    path = config.temp_dir / 'legacy.mp3'
    write_audio(path, [0.] * 8000, 8000)
    tags = ID3()
    tags.add(TIT2(encoding=3, text=['']))
    tags.add(TXXX(encoding=3, desc='MusicBrainz Track Id', text=['legacy-recording']))
    tags.add(UFID(owner='http://musicbrainz.org', data=b''))
    tags.save(path)
    repo = MetadataRepository(config, logging.getLogger(__name__))
    repo.write_id3_tags(path, AudioMetadata(title='Filled', recording_mbid='new-recording'))
    tags = ID3(path)
    assert tags['TIT2'].text == ['Filled']
    assert tags['TXXX:MusicBrainz Track Id'].text == ['legacy-recording']
    assert tags['UFID:http://musicbrainz.org'].data == b''
    repo.write_id3_tags(path, AudioMetadata(recording_mbid='new-recording'), overwrite=True)
    assert ID3(path)['UFID:http://musicbrainz.org'].data == b'new-recording'


def test_gap_choice_is_made_inside_writer_lock(config, write_audio):
    path = config.temp_dir / 'locked.mp3'
    write_audio(path, [0.] * 8000, 8000)
    def writer(file_path, fields, **kwargs):
        # Another user fills the gap after the adapter is called, before its
        # transform runs under the actual write lock.
        tags = ID3(); tags.add(TIT2(text=['Another user'])); tags.save(file_path)
        return w.write(file_path, fields, expected=w.identity(file_path), **kwargs)
    repo = MetadataRepository(config, logging.getLogger(__name__), tag_writer=writer)
    repo.write_id3_tags(path, AudioMetadata(title='Fallback', isrc='USAAA2400001'))
    assert ID3(path)['TIT2'].text == ['Another user']
    assert ID3(path)['TSRC'].text == ['USAAA2400001']


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'ogg', 'm4a'])
def test_download_import_durably_carries_new_ids_through_safe_writer(pipeline, config, write_audio, monkeypatch, extension):
    data = helpers.body()
    data.tracks[0].release_group_mbid = GROUP
    data.tracks[0].artist_mbid = ARTISTS
    row = pipeline.submit(data, helpers.ANA, schedule=False)
    work = pipeline.store.work(row['id'])['body']
    request = decode_request(encode_request(pipeline._requests(work)[0]))
    assert request.metadata.release_group_mbid == GROUP and request.metadata.artist_mbid == ARTISTS
    assert isinstance(request.metadata, TrackMetadata)
    path = config.temp_dir / f'download.{extension}'
    write_audio(path, [0.] * 8000, 8000)
    edits = TagEdits(config)
    pipeline.engine.logger = logging.getLogger(__name__)
    pipeline.engine.metadata_repo = MetadataRepository(config, logging.getLogger(__name__), tag_writer=edits.edit)
    spy = Mock(wraps=w.write)
    monkeypatch.setattr(w, 'write', spy)
    assert DownloadEngine._apply_metadata(pipeline.engine, path, request.metadata)
    assert spy.call_count == 1
    assert w.read(path)['fields']['mbReleaseGroup'] == GROUP
    assert w.read(path)['fields']['mbArtist'] == ARTISTS


def test_upstream_v9_play_history_survives_edit_ledger_migration(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    upstream = replace(JOBS, steps=JOBS.steps[:9], rebuild_steps=JOBS.rebuild_steps - {10})
    db = open_store(path, upstream)
    db.execute("INSERT INTO play_events VALUES('event','user','Album/song.mp3','start','listen',12,1,'desktop',NULL)")
    db.commit(); db.close()
    db = open_store(path, JOBS)
    assert db.execute('PRAGMA user_version').fetchone()[0] == JOBS.head
    assert tuple(db.execute('SELECT * FROM play_events').fetchone()) == ('event', 'user', 'Album/song.mp3', 'start', 'listen', 12, 1, 'desktop', None)
    sql = db.execute("SELECT sql FROM sqlite_schema WHERE name='jobs'").fetchone()[0]
    assert all(repr(kind) in sql for kind in ('library-edit', 'analysis', 'match'))
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    db.close()
