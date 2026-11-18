"""Known identity survives the request, publication, tags and subsequent scan."""
import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, TXXX
from pydantic import ValidationError

from app.domains.acquisition.models import Track, AcquisitionError
from app.domains.acquisition.adapters import SpotifyAdapter
from app.domains.metadata.repositories import MetadataRepository
from app.domains.music.models import AudioMetadata
from app.domains.music.relocation import TrackRelocator
from app.domains.music.repositories import MusicRepository
from app.infra.identity import Principal
from app.infra.job_requests import encode_request, decode_request
from app.utils.library_paths import rel_path_for
from tests.unit import test_acquisition as helpers

pipeline = helpers.pipeline
body = helpers.body

ISRC = 'USAAA2400001'
RECORDING = '11111111-1111-4111-8111-111111111111'
RELEASE = '22222222-2222-4222-8222-222222222222'
MEMBER = Principal('member', 'Member')
OWNER = Principal('owner', 'Owner', 'owner')
COVER = 'https://cdn-images.dzcdn.net/images/cover/abc123/500x500-000000-80-0-0.jpg'


@pytest.mark.parametrize('url,expected', [(COVER, COVER.replace('500x500', '1000x1000')),
                                           ('https://example.test/500x500.jpg', 'https://example.test/500x500.jpg'),
                                           (None, None)])
def test_request_upgrades_only_provider_cover(pipeline, url, expected):
    data = body()
    data.tracks[0].cover_url = url
    assert pipeline._requests(data.model_dump())[0].cover_url == expected


def test_isrc_is_durable_and_reaches_lookup_and_metadata(pipeline):
    data = body()
    data.tracks[0].isrc = ISRC
    lookup = Mock()
    lookup.lookup.return_value = ('Rock', 2024, [])
    pipeline.metadata_lookup = lambda: lookup
    row = pipeline.submit(data, MEMBER, schedule=False)
    assert pipeline.store.work(row['id'])['body']['tracks'][0]['isrc'] == ISRC
    seen = []

    async def tag(path, request, phase):
        seen.append(request.metadata.isrc)

    pipeline.engine._finish_staged_file = tag
    assert asyncio.run(pipeline.run(row['id']))[0].success
    assert seen == [ISRC]
    lookup.lookup.assert_called_once_with('Artist', 'Album', 'Song 0', ISRC)


@pytest.mark.parametrize('rel', ['/Album/old.mp3', '../old.mp3', 'Album/../old.mp3', 'Album/..',
                                  'Album\\old.mp3', 'Album/old\x00.mp3', 'Album/..∕old.mp3', '', 'old.mp3'])
def test_replacement_requires_library_key(rel):
    with pytest.raises(ValidationError):
        Track(title='New', replaces=rel)


def test_replacement_rejects_symlink_escape_before_persisting(pipeline, tmp_path):
    outside = tmp_path / 'outside'
    outside.mkdir()
    (pipeline.root / 'Escape').symlink_to(outside, target_is_directory=True)
    data = body()
    data.tracks[0].replaces = 'Escape/old.mp3'
    with pytest.raises(AcquisitionError, match='invalid-replacement'):
        pipeline.submit(data, MEMBER, schedule=False)
    assert pipeline.store.list(MEMBER.user_id) == []


def replacement(pipeline, principal, nested=False):
    old = pipeline.root / ('Artist/Previous/CD1' if nested else 'Previous') / 'old.mp3'
    old.parent.mkdir(parents=True)
    old.write_bytes(b'old recording')
    old_rel = rel_path_for(pipeline.root, old)
    for account in (principal.user_id, 'listener'):
        pipeline.user_tracks.add_many(account, [old_rel])
    music = Mock()
    music.delete_track.side_effect = lambda path: path.unlink()
    mover = TrackRelocator(base_music_dir=pipeline.root, music_service=music, user_tracks=pipeline.user_tracks)
    pipeline.relocator = lambda: mover
    data = body()
    data.tracks[0].replaces = old_rel
    pipeline.ownership.lookup_many.return_value = [SimpleNamespace(owned=True, match=SimpleNamespace(path=str(old)))]
    pipeline.ownership.lookup_many.side_effect = None
    return old, old_rel, mover, pipeline.submit(data, principal, schedule=False)


@pytest.mark.parametrize('principal', [OWNER, MEMBER])
@pytest.mark.parametrize('nested', [False, True])
def test_replacement_publishes_then_relocates_or_swaps_only_member(pipeline, principal, nested):
    old, old_rel, mover, row = replacement(pipeline, principal, nested)
    result = asyncio.run(pipeline.run(row['id']))[0]
    assert result.success and not result.already_present
    assert len(pipeline.engine.calls) == 1  # ownership never suppresses a version choice
    new_rel = rel_path_for(pipeline.root, result.file_path)
    assert pipeline.user_tracks.get(principal.user_id, new_rel)
    assert pipeline.user_tracks.get(principal.user_id, old_rel) is None
    if principal.is_owner:
        assert not old.exists()
        assert [p.read_bytes() for p in pipeline.recycle.iterdir()] == [b'old recording']
        assert pipeline.user_tracks.get('listener', new_rel)
        mover.music.delete_track.assert_called_once_with(old)
    else:
        assert old.read_bytes() == b'old recording'
        assert pipeline.user_tracks.get('listener', old_rel)
        assert not list(pipeline.recycle.glob('*'))
        mover.music.delete_track.assert_not_called()
    assert pipeline.view(row['id'], principal)['state'] == 'completo'


@pytest.mark.parametrize('principal', [OWNER, MEMBER])
@pytest.mark.parametrize('stage', ['download', 'import'])
def test_failed_replacement_keeps_old_file_and_rows(pipeline, principal, stage, monkeypatch):
    old, old_rel, mover, row = replacement(pipeline, principal)
    if stage == 'download':
        async def fail(*args, **kwargs):
            raise OSError('transfer failed')
        pipeline.engine._download_audio_file = fail
    else:
        monkeypatch.setattr('app.domains.acquisition.services.import_file', Mock(side_effect=OSError('publish failed')))
    assert not asyncio.run(pipeline.run(row['id']))[0].success
    assert old.read_bytes() == b'old recording'
    assert pipeline.user_tracks.get(principal.user_id, old_rel)
    assert pipeline.user_tracks.get('listener', old_rel)
    mover.music.delete_track.assert_not_called()
    assert not list(pipeline.recycle.glob('*'))


@pytest.mark.parametrize('principal', [OWNER, MEMBER])
def test_restart_repairs_replacement_link_without_refetch(pipeline, principal, monkeypatch):
    old, old_rel, mover, row = replacement(pipeline, principal)
    original = pipeline._done

    def interrupted(job, idx, **kwargs):
        if job.name == 'link':
            raise KeyboardInterrupt('interrupted before link receipt')
        original(job, idx, **kwargs)

    monkeypatch.setattr(pipeline, '_done', interrupted)
    with pytest.raises(KeyboardInterrupt):
        asyncio.run(pipeline.run(row['id']))
    monkeypatch.setattr(pipeline, '_done', original)
    results = asyncio.run(pipeline.run(row['id']))
    assert results[0].success
    assert len(pipeline.engine.calls) == 1
    assert pipeline.user_tracks.get(principal.user_id, old_rel) is None
    assert pipeline.view(row['id'], principal)['state'] == 'completo'
    assert old.exists() != principal.is_owner


def test_adapter_retains_resolver_and_provider_identity(tmp_path):
    supplied = dict(isrc=ISRC, album_artist='Album Artist', track_number=3, track_total=12,
                    disc_number=2, disc_total=2, compilation=True, recording_mbid=RECORDING, release_mbid=RELEASE)
    request = SpotifyAdapter(Mock(), Mock())._build_track_requests(
        [{'name': 'Track', 'artist': 'Artist', **supplied}], tmp_path, False, 'none', 0)[0]
    restored = decode_request(encode_request(request))
    for field, value in supplied.items():
        assert getattr(restored.metadata, field) == value


def metadata(**kwargs):
    return AudioMetadata(title='Track', artist='Artist', album='Album', isrc=ISRC,
                         album_artist='Album Artist', track_number=3, track_total=12,
                         disc_number=2, disc_total=2, compilation=kwargs.pop('compilation', True),
                         recording_mbid=RECORDING, release_mbid=RELEASE, **kwargs)


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'm4a'])
@pytest.mark.parametrize('compilation', [False, True])
def test_identity_tags_round_trip(config, write_audio, extension, compilation):
    path = config.temp_dir / f'track.{extension}'
    write_audio(path, [0] * 4410, 44100)
    repo = MetadataRepository(config, logging.getLogger(__name__))
    repo.write_id3_tags(path, metadata(compilation=compilation))
    tags = MutagenFile(path).tags
    if extension == 'mp3':
        expected = {'TSRC': ISRC, 'TPE2': 'Album Artist', 'TRCK': '3/12', 'TPOS': '2/2',
                    'TCMP': str(int(compilation)), 'TXXX:MusicBrainz Album Id': RELEASE}
        for key, value in expected.items():
            assert tags[key].text == [value]
        assert tags['UFID:http://musicbrainz.org'].data == RECORDING.encode()
    elif extension == 'flac':
        expected = {'ISRC': ISRC, 'ALBUMARTIST': 'Album Artist', 'TRACKNUMBER': '3', 'TRACKTOTAL': '12',
                    'DISCNUMBER': '2', 'DISCTOTAL': '2', 'COMPILATION': str(int(compilation)),
                    'MUSICBRAINZ_TRACKID': RECORDING, 'MUSICBRAINZ_ALBUMID': RELEASE}
        for key, value in expected.items():
            assert tags[key] == [value]
    else:
        assert tags['----:com.apple.iTunes:ISRC'] == [ISRC.encode()]
        assert tags['aART'] == ['Album Artist']
        assert tags['trkn'] == [(3, 12)]
        assert tags['disk'] == [(2, 2)]
        assert tags['cpil'] is compilation
        assert tags['----:com.apple.iTunes:MusicBrainz Track Id'] == [RECORDING.encode()]
        assert tags['----:com.apple.iTunes:MusicBrainz Album Id'] == [RELEASE.encode()]


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'm4a'])
def test_existing_tags_survive_gap_fill_and_unrelated_tags_survive_fresh_tagging(config, write_audio, extension):
    path = config.temp_dir / f'track.{extension}'
    write_audio(path, [0] * 4410, 44100)
    repo = MetadataRepository(config, logging.getLogger(__name__))
    original = metadata(compilation=False)
    original.title = 'Existing title'
    original.isrc = 'USAAA2300001'
    original.album_artist = 'Existing Album Artist'
    original.track_number, original.track_total = 8, 15
    original.disc_number, original.disc_total = 1, 3
    original.recording_mbid, original.release_mbid = RELEASE, RECORDING
    repo.write_id3_tags(path, original)
    audio = MutagenFile(path)
    private = 'TXXX:OTHER_APP' if extension == 'mp3' else '----:com.apple.iTunes:OTHER_APP' if extension == 'm4a' else 'OTHER_APP'
    if extension == 'mp3':
        audio.tags.add(TXXX(encoding=3, desc='OTHER_APP', text='keep'))
    else:
        audio.tags[private] = [b'keep'] if extension == 'm4a' else ['keep']
    audio.save()
    before = dict(MutagenFile(path).tags)
    repo.write_id3_tags(path, metadata())
    assert dict(MutagenFile(path).tags) == before
    repo.write_id3_tags(path, metadata(), overwrite=True)
    tags = MutagenFile(path).tags
    assert tags[private] == before[private if extension != 'flac' else private.lower()]
    isrc = tags['TSRC'].text[0] if extension == 'mp3' else tags['ISRC'][0] if extension == 'flac' else tags['----:com.apple.iTunes:ISRC'][0].decode()
    assert isrc == ISRC


def test_scan_reads_tsrc_without_changing_listing_shape(config, write_audio):
    path = config.base_music_dir / 'Album' / 'track.mp3'
    path.parent.mkdir()
    write_audio(path, [0] * 4410, 44100)
    repo = MetadataRepository(config, logging.getLogger(__name__))
    repo.write_id3_tags(path, metadata())
    music = MusicRepository(config, logging.getLogger(__name__))
    track = music.scan_albums()[0].tracks[0]
    assert ID3(path)['TSRC'].text == [ISRC]
    assert music.read_tags(path)['isrc'] == track.isrc == ISRC
    assert 'isrc' not in track.to_dict()


def test_pre_upgrade_idempotency_key_still_replays(pipeline):
    data = body()
    previous = data.model_dump()
    previous['tracks'] = [{key: value for key, value in track.items() if key in
                           ('title', 'artist', 'album', 'provider_id', 'duration_s', 'track_number', 'cover_url', 'youtube_url')}
                          for track in previous['tracks']]
    original, fresh = pipeline.store.create(previous, MEMBER, key='pre-upgrade')
    assert fresh
    assert pipeline.submit(data, MEMBER, key='pre-upgrade', schedule=False) == original
