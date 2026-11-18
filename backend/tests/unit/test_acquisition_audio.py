"""Real staged audio: copy AAC, encode only the fallback, reject before publish."""
import asyncio
import base64
import json
import logging
import subprocess
from unittest.mock import Mock

import pytest

from app.domains.acquisition import audio, import_stage, provider
from app.domains.acquisition.engine import DownloadEngine
from app.domains.metadata import tagwriter, tagreader
from app.domains.metadata.repositories import MetadataRepository
from app.infra.media_requests import DownloadOptions, TrackDownloadRequest, TrackMetadata
from tests.unit.test_acquisition import ANA, body, pipeline as pipeline, submit


def real_engine(pipeline, config, monkeypatch, source):
    from app.exceptions import SourceFailure

    monkeypatch.setattr(import_stage, 'validate', audio.validate)
    config.base_music_dir = pipeline.root
    commands = []
    class Port:
        id = 'youtube'
        async def fetch(self, candidate, directory, *, deadline, options, progress):
            commands.append(candidate)
            try:
                info = audio.probe(source, ffmpeg=config.ffmpeg_path)
                target = directory / 'audio.m4a'
                transcode = source.suffix != '.m4a'
                subprocess.run([config.ffmpeg_path, '-v', 'error', '-y', '-i', str(source), '-c:a',
                                'aac' if transcode else 'copy', *(['-b:a', '256k'] if transcode else []), str(target)], check=True)
                return dict(path=str(target), bytes=target.stat().st_size, duration=info["duration_s"],
                            codec='aac', sourceCodec=info["codec"], bitrateKbps=256 if transcode else 128, transcoded=transcode)
            except Exception as error:
                raise SourceFailure('Invalid source audio') from error
    engine = DownloadEngine(provider.DownloadRepository(config, Mock(), source=Port()), MetadataRepository(config, Mock()),
                            Mock(), None, config, logging.getLogger(__name__))
    engine._resolve_source_url = pipeline.engine._resolve_source_url
    pipeline.engine = engine
    return engine, commands


def encoded_audio(path, config):
    return subprocess.run([config.ffmpeg_path, '-v', 'error', '-i', str(path), '-map', '0:a:0',
                           '-c:a', 'copy', '-f', 'adts', '-'], capture_output=True, check=True).stdout


@pytest.mark.parametrize('extension,codec,transcoded', [('.m4a', 'aac', False), ('.opus', 'opus', True)])
def test_source_copy_or_fallback_and_durable_actual_format(pipeline, config, write_audio, monkeypatch, extension, codec, transcoded):
    import numpy as np
    source = config.temp_dir / f'input{extension}'
    write_audio(source, np.sin(np.arange(48000) * 0.1) * 0.3, 48000)
    engine, fetches = real_engine(pipeline, config, monkeypatch, source)
    original = subprocess.run
    commands = []

    def run(cmd, **kwargs):
        commands.append(cmd)
        return original(cmd, **kwargs)

    monkeypatch.setattr(audio.subprocess, 'run', run)
    request = body()
    request.tracks[0].duration_s = 1
    row = submit(pipeline, request)
    result = asyncio.run(pipeline.run(row['id']))[0]
    assert result.success and result.file_path.suffix == '.m4a'
    assert fetches
    conversion = [cmd for cmd in commands if '-c:a' in cmd]
    assert len(conversion) == 1
    assert conversion[0][conversion[0].index('-c:a') + 1] == ('aac' if transcoded else 'copy')
    assert ('-b:a' in conversion[0]) == transcoded
    if transcoded:
        assert conversion[0][conversion[0].index('-b:a') + 1] == '256k'
    else:
        assert encoded_audio(source, config) == encoded_audio(result.file_path, config)
    report = result.to_dict()['audio_format']
    measured = audio.probe(result.file_path, ffmpeg=config.ffmpeg_path)
    assert report == {**measured, 'source_codec': codec, 'transcoded': transcoded}
    assert report['codec'] == 'aac' and report['bitrate_bps'] > 0
    view = pipeline.view(row['id'], ANA)
    imported = next(item for item in view['items'] if item['stage'] == 'import')
    assert imported['detail']['audio_format'] == report
    fact = pipeline.health.last_format('youtube')
    assert fact == {'codec': measured['codec'], 'bitrateKbps': measured['bitrate_bps'] / 1000,
                    'container': measured['container'], 'transcoded': transcoded}
    # Existing published item measurements also supply the additive source fact.
    with pipeline.ledger.db:
        pipeline.ledger.db.execute("UPDATE acquisition_providers SET published_format=NULL WHERE provider='youtube'")
    assert pipeline.health.last_format('youtube') == fact
    assert pipeline._saved_results(row['id'], 1)[0].audio_format == report
    assert not list(pipeline.incoming.rglob('*.source'))
    assert not list(pipeline.root.rglob('*.json'))
    assert engine.metadata_repo.read_id3_tags(result.file_path).title == 'Song 0'


@pytest.mark.parametrize('prober', ['ffprobe', 'ffmpeg'])
@pytest.mark.parametrize('invalid', ['short', 'undecodable', 'no-audio', 'decode-error'])
def test_invalid_staged_audio_is_broken_removed_and_never_imported(pipeline, config, write_audio, monkeypatch, invalid, prober):
    # The desktop bundles have ffmpeg alone, so both inspection paths must reject.
    if prober == 'ffprobe' and not audio._ffprobe_beside(config.ffmpeg_path):
        pytest.skip('no ffprobe on this machine')
    if prober == 'ffmpeg':
        monkeypatch.setattr(audio, '_ffprobe_beside', lambda ffmpeg: None)
    source = config.temp_dir / 'staged.m4a'
    write_audio(source, [0.1] * 19200, 48000)  # 40% of the expected recording
    real_engine(pipeline, config, monkeypatch, source)
    with pipeline.ledger.lock, pipeline.ledger.db:
        pipeline.ledger.db.execute("INSERT INTO acquisition_providers(provider,level) VALUES('youtube',2)")
    if invalid == 'undecodable':
        source.write_bytes(b'not audio')
    elif invalid == 'no-audio':
        original = subprocess.run
        def no_audio(cmd, **kwargs):
            if '-show_streams' in cmd:
                return type('Result', (), {'returncode': 0, 'stdout': b'{"streams":[],"format":{"duration":"1"}}'})()
            if cmd[-2:] == ['-i', str(cmd[-1])] and '-hide_banner' in cmd:
                summary = b"Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'staged.m4a':\n  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s\n"
                return type('Result', (), {'returncode': 1, 'stderr': summary})()
            return original(cmd, **kwargs)
        monkeypatch.setattr(audio.subprocess, 'run', no_audio)
    elif invalid == 'decode-error':
        original = subprocess.run
        def broken_decode(cmd, **kwargs):
            if '-xerror' in cmd:
                return type('Result', (), {'returncode': 1})()
            return original(cmd, **kwargs)
        monkeypatch.setattr(audio.subprocess, 'run', broken_decode)
    request = body()
    request.tracks[0].duration_s = 1 if invalid == 'short' else None
    row = submit(pipeline, request)
    results = asyncio.run(pipeline.run(row['id']))
    assert not results[0].success
    assert list(pipeline.root.rglob('*')) == []
    assert not [p for p in pipeline.incoming.rglob('*') if p.is_file()]
    failed = [i for i in pipeline.view(row['id'], ANA)['items'] if i['state'] == 'failed']
    assert failed and all(i['detail']['kind'] == 'broken' for i in failed)
    assert pipeline.user_tracks.list_for_user(ANA.user_id) == []
    assert pipeline.health.status('youtube')['level'] == 3


def test_m4a_tags_cover_replaygain_and_analysis_roundtrip(config, write_audio, tmp_path):
    import numpy as np
    path = tmp_path / 'track.m4a'
    write_audio(path, np.sin(np.arange(48000) * 0.1) * 0.25, 48000)
    before = encoded_audio(path, config)
    cover = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
    repo = MetadataRepository(config, Mock())
    engine = DownloadEngine(provider.DownloadRepository(config, Mock()), repo, Mock(), None, config, Mock())
    request = TrackDownloadRequest(metadata=TrackMetadata(title='Title', artist='Artist', album='Album', album_artist='Album Artist',
                                   track_number=2, track_total=12, disc_number=1, disc_total=2, year=2024, genre='Rock', isrc='USAAA2400001'),
                                   options=DownloadOptions(normalize=True), cover_data=cover)
    asyncio.run(engine._finish_staged_file(path, request, lambda *args: None))
    tagwriter.write(path, expected=tagwriter.identity(path), transform=lambda tags, mode: tagwriter.fill_gaps(
        tags, mode, {'bpm': 120, 'key': 'Am'}, overwrite=True))
    tags = repo.read_id3_tags(path)
    for field in ('title', 'artist', 'album', 'album_artist', 'track_number', 'track_total', 'disc_number', 'disc_total', 'year', 'genre', 'isrc'):
        assert getattr(tags, field) == getattr(request.metadata, field)
    assert tags.cover_art == cover == repo.extract_cover_art(path)
    _, native, mode = tagwriter.load(path)
    assert tags.bpm == 120 and tagreader.read(native, mode)['key'] == '8A'
    gains = tagreader.read(native, mode)
    assert gains['trackGain'] is not None and gains['trackPeak'] > 0
    assert json.loads(audio.receipt(path).read_text())['normalization'] == 'replaygain-only'
    assert encoded_audio(path, config) == before


def test_member_filename_reuse_accepts_m4a_and_keeps_existing_mp3(config, tmp_path):
    config.base_music_dir = tmp_path
    album = tmp_path / 'Album'
    album.mkdir()
    engine = DownloadEngine(Mock(), Mock(), Mock(), None, config, Mock())
    request = TrackDownloadRequest(destination=album, filename='Track')
    for extension in ('.mp3', '.m4a'):
        path = album / f'Track{extension}'
        path.write_bytes(b'existing recording')
        assert engine._existing_member_track(request) == path
        path.unlink()



@pytest.mark.parametrize('extension', ['.m4a', '.mp3'])
def test_recording_ownership_reuses_existing_audio_without_a_fetch(pipeline, config, write_audio, monkeypatch, extension):
    from app.domains.music.ownership import OwnershipIndex
    from app.domains.music.repositories import MusicRepository
    existing = pipeline.root / 'Album' / f'Existing{extension}'
    existing.parent.mkdir()
    write_audio(existing, [0.1] * 48000, 48000)
    tagwriter.write(existing, {'title': 'Song 0', 'artist': 'Artist', 'album': 'Album'}, expected=tagwriter.identity(existing))
    before = existing.read_bytes()
    _, fetches = real_engine(pipeline, config, monkeypatch, existing)
    repository = MusicRepository(config, Mock())
    repository.refresh()
    pipeline.ownership = OwnershipIndex(repository, config, Mock())
    data = body()
    data.tracks[0].duration_s = 1
    row = submit(pipeline, data)
    result = asyncio.run(pipeline.run(row['id']))[0]
    assert result.success and result.already_present and result.file_path == existing
    assert fetches == [] and existing.read_bytes() == before
    assert list(pipeline.root.rglob('*' + extension)) == [existing]
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 1


@pytest.mark.parametrize('expected', [None, 0])
def test_unknown_expected_duration_still_checks_decode(config, tmp_path, write_audio, expected):
    path = tmp_path / 'short.m4a'
    write_audio(path, [0.1] * 19200, 48000)
    report = audio.validate(path, expected_duration=expected, ffmpeg=config.ffmpeg_path)
    assert 0.39 <= report['duration_s'] <= 0.42


@pytest.mark.parametrize('extension,codec,container', [('.m4a', 'aac', 'm4a'), ('.opus', 'opus', 'ogg'), ('.flac', 'flac', 'flac')])
def test_probe_without_ffprobe_reads_the_same_facts_from_ffmpeg(config, write_audio, monkeypatch, extension, codec, container):
    import numpy as np
    source = config.temp_dir / f'probe{extension}'
    write_audio(source, np.sin(np.arange(96000) * 0.1) * 0.3, 48000)
    with_ffprobe = audio.probe(source, ffmpeg=config.ffmpeg_path) if audio._ffprobe_beside(config.ffmpeg_path) else None
    monkeypatch.setattr(audio, '_ffprobe_beside', lambda ffmpeg: None)
    alone = audio.probe(source, ffmpeg=config.ffmpeg_path)
    assert (alone['codec'], alone['container']) == (codec, container)
    assert alone['duration_s'] == pytest.approx(2, abs=0.05)
    if with_ffprobe:
        assert (alone['codec'], alone['container']) == (with_ffprobe['codec'], with_ffprobe['container'])
        assert alone['duration_s'] == pytest.approx(with_ffprobe['duration_s'], abs=0.02)


def test_probe_without_ffprobe_rejects_a_file_that_is_not_audio(config, monkeypatch):
    from app.exceptions import SourceFailure
    junk = config.temp_dir / 'junk.m4a'
    junk.write_bytes(b'not audio at all')
    monkeypatch.setattr(audio, '_ffprobe_beside', lambda ffmpeg: None)
    with pytest.raises(SourceFailure):
        audio.probe(junk, ffmpeg=config.ffmpeg_path)
