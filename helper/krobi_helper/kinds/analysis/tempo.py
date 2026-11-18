"""TempoCNN features and CPU inference, using only numpy and onnxruntime."""
from pathlib import Path

import numpy as np

SAMPLE_RATE = 11025
FRAME = 1024
HOP = 512

# Essentia's latest published tag v2.1_beta5 predates TempoCNN. These numerical
# definitions are pinned to commit 23ae7baddecfc3227ba23ad69fa11f73ac5293a4:
# https://github.com/MTG/essentia/blob/23ae7baddecfc3227ba23ad69fa11f73ac5293a4/src/algorithms/spectral/tensorflowinputtempocnn.cpp
# Also tensorflowpredicttempocnn.cpp, triangularbands.cpp, framecutter.cpp and
# tensornormalize.cpp at that revision. Magnitude, unit_tri, no log compression
# (MelBands defaults log=false); standardization occurs per patch, batchSize=1.


def mel_filters() -> np.ndarray:
    def mel(hz):
        return hz / (200 / 3) if hz < 1000 else 15 + np.log(hz / 1000) / (np.log(6.4) / 27)

    values = np.linspace(mel(20), mel(5000), 42)
    edges = np.where(values < 15, values * (200 / 3), 1000 * np.exp((values - 15) * np.log(6.4) / 27))
    frequencies = np.fft.rfftfreq(FRAME, 1 / SAMPLE_RATE)
    left, middle, right = edges[:-2, None], edges[1:-1, None], edges[2:, None]
    weights = np.maximum(0, np.minimum((frequencies - left) / (middle - left), (right - frequencies) / (right - middle)))
    return (weights * 2 / (right - left)).T.astype(np.float32)


def features(audio: np.ndarray) -> np.ndarray:
    """Centered Hann magnitude mel frames, including the final padded frame."""
    if not len(audio):
        return np.empty((0, 40), dtype=np.float32)
    padded = np.pad(np.asarray(audio, dtype=np.float32), (FRAME // 2, FRAME))
    count = int(np.ceil(len(audio) / HOP)) + 1
    frames = np.lib.stride_tricks.sliding_window_view(padded, FRAME)[::HOP][:count]
    window, filters = np.hanning(FRAME).astype(np.float32), mel_filters()
    bands = np.empty((len(frames), 40), dtype=np.float32)
    for start in range(0, len(frames), 256):
        spectrum = np.abs(np.fft.rfft(frames[start:start + 256] * window, axis=1))
        bands[start:start + 256] = spectrum @ filters
    return bands


def patches(bands: np.ndarray):
    """Discard incomplete patches; yield NHWC (1,40,256,1) tensors."""
    for start in range(0, len(bands) - 255, 128):
        patch = bands[start:start + 256]
        deviation = patch.std()
        normalized = (patch - patch.mean()) / (deviation if deviation else 1)
        yield np.ascontiguousarray(normalized.T[None, :, :, None], dtype=np.float32)


class TempoCNN:
    def __init__(self, model: Path):
        import onnxruntime as ort

        settings = ort.SessionOptions()
        settings.intra_op_num_threads = settings.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), sess_options=settings, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def predict(self, audio: np.ndarray) -> tuple[float, float]:
        predictions = [self.session.run(None, {self.input: patch})[0].reshape(256)
                       for patch in patches(features(audio))]
        if not predictions:
            raise ValueError("too-short")
        probabilities = np.mean(predictions, axis=0)
        winner = int(np.argmax(probabilities))
        return float(winner + 30), float(np.clip(probabilities[winner], 0, 1))
