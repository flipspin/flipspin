"""Waveforms use the selected ffmpeg."""
from unittest.mock import Mock

import numpy as np


def test_waveform_reads_the_live_path(config, tmp_path, monkeypatch):
    import logging
    from app.domains.music.services import MusicService
    audio = tmp_path / 'audio.wav'
    audio.touch()
    run = Mock(return_value=Mock(stdout=np.zeros(100, dtype='<f4').tobytes()))
    monkeypatch.setattr('app.infra.ffmpeg.subprocess.run', run)
    music = MusicService(Mock(), Mock(), config, logging.getLogger('test'))
    for binary in ['/first/ffmpeg', '/changed/ffmpeg']:
        config.ffmpeg_path = binary
        assert len(music.generate_waveform(audio)) == 1000
        cmd = run.call_args.args[0]
        assert cmd[0] == binary
        assert cmd[cmd.index('-ac') + 1] == '1'
        assert cmd[cmd.index('-f') + 1] == 'f32le'


def test_waveform_from_generated_wav(config, tmp_path, write_audio):
    import logging
    from app.domains.music.services import MusicService
    audio = tmp_path / 'short.wav'
    write_audio(audio, np.full((400, 2), 0.5), 8000)
    music = MusicService(Mock(), Mock(), config, logging.getLogger('test'))
    assert np.allclose(music.generate_waveform(audio, samples=100), [0.5] * 100)
    short = music.generate_waveform(audio, samples=500)
    assert np.allclose(short[:400], [0.5] * 400)
    assert short[400:] == [0.0] * 100
