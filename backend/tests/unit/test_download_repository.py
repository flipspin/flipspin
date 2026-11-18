"""The legacy repository delegates to SourcePort and keeps local ReplayGain."""
import asyncio
import logging
from unittest.mock import AsyncMock, Mock

from app.domains.acquisition.provider import DownloadRepository


def test_normalization_reads_live_ffmpeg(config, tmp_path, monkeypatch):
    from app.domains.downloads import repositories as repo
    from app.domains.metadata import tagwriter
    target = tmp_path / 'song.m4a'
    target.touch()
    calls = []
    def measure(cmd, **kwargs):
        calls.append(cmd)
        return type('Result', (), {'returncode': 0, 'stderr': b'{"input_i":"-20", "input_tp":"-1"}'})()
    monkeypatch.setattr(repo.subprocess, 'run', measure)
    monkeypatch.setattr(tagwriter, 'write', Mock())
    monkeypatch.setattr(tagwriter, 'identity', Mock())
    download = repo.DownloadRepository(config, logging.getLogger('test'))
    for binary in ['/first/ffmpeg', '/changed/ffmpeg']:
        config.ffmpeg_path = binary
        download.normalize_audio(target)
        assert calls[-1][0] == binary
        assert calls[-1][-3:] == ['-f', 'null', '-']
        assert not target.with_suffix('.normalized.mp3').exists()



def test_search_passes_wanted_and_cookie_file_without_command_line(config, tmp_path):
    cookie = tmp_path / 'cookies.txt'
    cookie.write_text('# Netscape HTTP Cookie File\n')
    config.source_cookies_file = str(cookie)
    port = Mock()
    port.search = AsyncMock(return_value=[])
    repo = DownloadRepository(config, Mock(), source=port)
    wanted = {'title': 'Song', 'artist': 'Artist', 'duration': 180}
    assert asyncio.run(repo.search_source('Song Artist', wanted=wanted)) == []
    port.search.assert_awaited_once_with(wanted, limit=5, deadline=30000,
        options={'cookiesFile': str(cookie), 'ffmpeg': config.ffmpeg_path, 'query': 'Song Artist'})


def test_fetch_reads_live_options_and_keeps_compatibility_filename(config, tmp_path):
    port = Mock()
    async def fetch(candidate, directory, **kwargs):
        path = directory / 'random.m4a'
        path.write_bytes(b'audio')
        return {'path': str(path), 'bytes': 5, 'duration': 1, 'codec': 'aac', 'bitrateKbps': 128, 'transcoded': False}
    port.fetch = AsyncMock(side_effect=fetch)
    repo = DownloadRepository(config, Mock(), source=port)
    for ffmpeg in ('first-ffmpeg', 'changed-ffmpeg'):
        config.ffmpeg_path = ffmpeg
        target = tmp_path / 'Song.source'
        landed = asyncio.run(repo.download_source_audio('--exec=not-an-option', target))
        assert landed == tmp_path / 'Song.m4a' and landed.read_bytes() == b'audio'
        assert port.fetch.call_args.args[0] == '--exec=not-an-option'
        assert port.fetch.call_args.kwargs['options']['ffmpeg'] == ffmpeg
        assert port.fetch.call_args.kwargs['deadline'] == config.download_timeout * 1000
