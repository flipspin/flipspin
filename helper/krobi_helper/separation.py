"""Portable htdemucs, one segment at a time (no parallel CPU jobs)."""
from __future__ import annotations

from pathlib import Path

from .acceleration import detect


def load_model():
    from demucs.pretrained import get_model

    return get_model("htdemucs").eval()


def separate(wav: Path, model: str):
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model

    if model != "htdemucs":
        raise ValueError("Only htdemucs is supported")
    device = detect()["accel"]
    network = load_model()
    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    if sr != network.samplerate or audio.shape[1] != network.audio_channels:
        raise ValueError("Demucs requires decoded 44.1 kHz stereo audio")
    mix = torch.from_numpy(audio.T.copy())
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std().clamp_min(1e-8)
    mix = (mix - mean) / std
    with torch.inference_mode():
        # apply_model splits at the trained segment size. Each batch has one
        # segment; num_workers=0 prevents concurrent segments eating RAM.
        sources = apply_model(network, mix[None], device=device, shifts=1,
                              split=True, overlap=0.25, num_workers=0, progress=False)[0]
        sources = sources * std + mean
    return {name: np.asarray(source.cpu().T, dtype=np.float32)
            for name, source in zip(network.sources, sources)}, int(network.samplerate)
