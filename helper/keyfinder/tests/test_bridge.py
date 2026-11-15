import numpy as np
import pytest
from krobi_keyfinder import analyse


def test_scores_and_label():
    rate = 44100
    time = np.arange(rate * 3) / rate
    audio = sum(np.sin(2 * np.pi * hz * time) for hz in (261.63, 329.63, 392)).astype(np.float32)
    label, scores = analyse(audio, rate)
    assert label == 6  # C major
    assert len(scores) == 24
    assert label == int(np.argmax(scores))
    assert np.isfinite(scores).all()
    assert 0 <= max(scores) - sorted(scores)[-2] <= 1


def test_invalid_buffer():
    with pytest.raises(ValueError):
        analyse(np.zeros(10, dtype=np.float64), 44100)
