"""Whole-track measurements; one batch lives in one disposable process."""
import os
import re
import time
import shutil
import subprocess
from pathlib import Path

import numpy as np

from .tempo import TempoCNN

ENGINE = "keyfinder+tempocnn"
ENGINE_VERSION = 2
RATE = 44100
# libKeyFinder enum: A major, A minor, Bb major, Bb minor, ... Ab minor.
CAMELOT = ("11B", "8A", "6B", "3A", "1B", "10A", "8B", "5A", "3B", "12A", "10B", "7A",
           "5B", "2A", "12B", "9A", "7B", "4A", "2B", "11A", "9B", "6A", "4B", "1A")


class DecodeError(Exception):
    pass


def ffmpeg() -> str:
    return os.environ.get("KROBI_FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"


def decode(path: Path) -> tuple[np.ndarray, dict]:
    # Split before downmixing: loudness and true peak must retain source channels.
    started = time.perf_counter()
    filters = ("[0:a:0]asplit=2[rg][mono];"
               "[rg]ebur128=peak=true:metadata=1,ametadata=print,anullsink;"
               "[mono]aformat=channel_layouts=mono,aresample=44100[out]")
    try:
        result = subprocess.run([ffmpeg(), "-hide_banner", "-nostats", "-i", str(path),
                                 "-filter_complex", filters, "-map", "[out]", "-f", "f32le", "-"],
                                capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise DecodeError from exc
    samples = np.frombuffer(result.stdout, dtype="<f4")
    if not len(samples) or not np.isfinite(samples).all():
        raise DecodeError
    values = {}
    blocks = []
    for name, raw in re.findall(rb"lavfi\.r128\.(M|I|LRA|true_peak)=([-+0-9.e]+)", result.stderr):
        value = float(raw)
        if not np.isfinite(value):
            raise DecodeError
        if name == b"M" and value >= -70:
            blocks.append(value)
        values[name] = value
    if not all(name in values for name in (b"I", b"LRA", b"true_peak")):
        raise DecodeError
    return samples, {"trackLufs": values[b"I"] if blocks else None,
                     "truePeak": values[b"true_peak"], "lra": values[b"LRA"],
                     "loudnessBlocks": blocks, "decodeSeconds": time.perf_counter() - started}


def tempo_audio(samples: np.ndarray) -> np.ndarray:
    result = subprocess.run([ffmpeg(), "-v", "error", "-f", "f32le", "-ar", str(RATE), "-ac", "1",
                             "-i", "-", "-ar", "11025", "-f", "f32le", "-"],
                            input=samples.astype("<f4", copy=False).tobytes(), capture_output=True, check=True)
    return np.frombuffer(result.stdout, dtype="<f4")


def mood_measurements(samples: np.ndarray) -> dict:
    """RMS amplitude, magnitude centroid/Nyquist, onset std/mean.

    Pulse is the coefficient of variation of positive spectral flux over
    2048-sample Hann windows at hop 512. Silence yields zero for every value.
    This preserves the server rule's amplitude and dimensionless ratio units.
    """
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(samples, (0, 2048)), 2048)[::512]
    centroid_sum = flux_sum = flux_square_sum = 0.0
    flux_count = 0
    previous = None
    window = np.hanning(2048)
    frequencies = np.linspace(0, 1, 1025)
    for start in range(0, len(frames), 256):
        magnitude = np.abs(np.fft.rfft(frames[start:start + 256] * window, axis=1))
        centroid_sum += float(((magnitude @ frequencies) / np.maximum(magnitude.sum(axis=1), 1e-12)).sum())
        sequence = magnitude if previous is None else np.concatenate((previous[None], magnitude))
        flux = np.maximum(np.diff(sequence, axis=0), 0).sum(axis=1)
        flux_sum += float(flux.sum())
        flux_square_sum += float(flux @ flux)
        flux_count += len(flux)
        previous = magnitude[-1]
    mean = flux_sum / max(flux_count, 1)
    variance = max(0.0, flux_square_sum / max(flux_count, 1) - mean * mean)
    return {"energy": float(np.sqrt(np.einsum("i,i->", samples, samples, dtype=np.float64) / len(samples))),
            "brightness": centroid_sum / len(frames),
            "pulse": float(np.sqrt(variance) / mean) if mean > 0 else 0.0}


def analyse(path: Path, tempo: TempoCNN) -> dict:
    samples, loudness = decode(path)
    if len(samples) < RATE * 12:
        return {"engine": ENGINE, "engineVersion": ENGINE_VERSION, "key": None, "keyConf": 0.,
                "bpm": None, "bpmConf": 0., **mood_measurements(samples), **loudness}
    from krobi_keyfinder import analyse as keyfinder

    label, scores = keyfinder(np.ascontiguousarray(samples, dtype=np.float32), RATE)
    if not 0 <= label < 24:
        raise ValueError("engine-failed")
    best = sorted(scores)[-2:]
    bpm, bpm_conf = tempo.predict(tempo_audio(samples))
    return {"engine": ENGINE, "engineVersion": ENGINE_VERSION, "key": CAMELOT[label],
            "keyConf": float(np.clip(best[1] - best[0], 0, 1)), "bpm": bpm, "bpmConf": bpm_conf,
            **mood_measurements(samples), **loudness}


def run_batch(items, tempo, report, stopping=lambda: False):
    outcomes = []
    for index, item in enumerate(items):
        if stopping():
            return None
        report("analizando", index / 25)
        identity = {key: item[key] for key in ("relPath", "size", "mtimeNs")}
        try:
            outcome = {**identity, **analyse(Path(item["audio"]), tempo)}
        except DecodeError:
            outcome = {"relPath": item["relPath"], "ok": False, "error": "undecodable", "final": True}
        except Exception as exc:  # noqa: BLE001 — keep processing sibling items
            reason = "too-short" if str(exc) == "too-short" else "engine-failed"
            outcome = {"relPath": item["relPath"], "ok": False, "error": reason, "final": reason == "too-short"}
        outcomes.append(outcome)
        report("analizando", (index + 1) / 25)
    return None if stopping() else outcomes
