"""Decode, separate, chop and encode stems with their song manifest.

Keep chop end after start and preserve zero-crossing samples in timestamp rounding.
See docs/stems.md#chop-selection.
"""
from __future__ import annotations

import json
import platform
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ... import protocol as P

Report = Callable[[str, Optional[float]], None]
Chop = Dict[str, object]

STEMS = ("drums", "bass", "vocals", "other")
MAX_CHOPS = 16
SAMPLE_RATE = 44100
OPUS_BITRATE = "192k"
#: Search radius for a zero crossing around each chop point.
ZC_WINDOW_S = 0.005
#: A chop shorter than this is noise, not a pad.
MIN_CHOP_S = 0.05
#: Pre-roll before a detected onset, so the transient's attack is kept.
ONSET_PREROLL_S = 0.005
#: Spectral-flux frame and hop, at the decimated (≤ 24 kHz) rate.
ONSET_FRAME = 1024
ONSET_HOP = 256
#: Frame-quantisation slack when snapping a phrase edge to a beat.
BEAT_SNAP_SLACK_S = 0.02
NOTES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Krumhansl–Kessler key profiles.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


class StemsError(RuntimeError):
    """A verdict about the song (unreadable, silent): final, not retried."""


@dataclass
class StemsJob:
    id: str
    audio: Path
    album: str = ""
    file: str = ""
    model: str = P.DEMUCS_MODEL

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "StemsJob":
        return cls(
            id=str(data["id"]),
            audio=Path(str(data["audio"])),
            album=str(data.get("album") or ""),
            file=str(data.get("file") or ""),
            model=str(data.get("model") or P.DEMUCS_MODEL),
        )


# ===================================================================== chopper


def to_mono(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 2:
        # (samples, channels) or (channels, samples)
        return x.mean(axis=1) if x.shape[0] > x.shape[1] else x.mean(axis=0)
    return x


def snap_to_zero_crossing(mono: np.ndarray, sr: int, t: float, window_s: float = ZC_WINDOW_S) -> float:
    """The sample nearest ``t`` where the signal changes sign (the quieter of the
    pair), within ``window_s``; the quietest sample in the window when there is
    none. Snapped on the mono signal (L/R differ), so clients still fade 2–5 ms."""
    n = len(mono)
    if n == 0:
        return max(0.0, t)
    i = int(round(t * sr))
    i = min(max(i, 0), n - 1)
    w = max(1, int(window_s * sr))
    lo, hi = max(0, i - w), min(n - 1, i + w)
    seg = mono[lo : hi + 1]
    if len(seg) < 2:
        return i / sr
    signs = np.signbit(seg)
    idx = np.nonzero(signs[1:] != signs[:-1])[0]
    if len(idx) == 0:
        # Silence or DC: the quietest sample is the least audible cut.
        return (lo + int(np.argmin(np.abs(seg)))) / sr
    after_quieter = np.abs(seg[idx + 1]) < np.abs(seg[idx])
    candidates = lo + idx + after_quieter.astype(int)
    best = candidates[np.argmin(np.abs(candidates - i))]
    return int(best) / sr


def finalize(
    raw: Sequence[Tuple[float, float, str]],
    mono: np.ndarray,
    sr: int,
    duration: float,
    *,
    prefix: Optional[str] = None,
    limit: int = MAX_CHOPS,
) -> List[Chop]:
    """Snap, clamp, drop the degenerate, sort by time, cap at ``limit``.
    With ``prefix`` the labels are renumbered in time order (``hit 1``…)."""
    out: List[Tuple[float, float, str]] = []
    for start, end, label in raw:
        s = snap_to_zero_crossing(mono, sr, min(max(start, 0.0), duration))
        e = snap_to_zero_crossing(mono, sr, min(max(end, 0.0), duration))
        s, e = max(0.0, s), min(duration, e)
        if e - s >= MIN_CHOP_S:
            out.append((s, e, label))
    out.sort(key=lambda c: c[0])
    out = out[:limit]
    chops: List[Chop] = []
    for index, (s, e, label) in enumerate(out):
        chops.append({
            "start": round(s, 6),
            "end": round(e, 6),
            "label": f"{prefix} {index + 1}" if prefix else label,
        })
    return chops


def beat_period(beats: Sequence[float], default: float = 0.5) -> float:
    if len(beats) >= 2:
        d = np.diff(np.asarray(beats, dtype=float))
        d = d[d > 0]
        if len(d):
            return float(np.median(d))
    return default


def estimate_bpm(beats: Sequence[float]) -> Optional[float]:
    if len(beats) < 2:
        return None
    return round(60.0 / beat_period(beats), 1)


def bars_from(downbeats: Sequence[float], beats: Sequence[float], duration: float) -> List[Tuple[float, float]]:
    """Bar spans from the downbeats (or groups of four beats). The last, open
    bar counts only when the song runs on for at least 0.9 of a typical bar."""
    marks = [float(t) for t in downbeats if 0.0 <= t < duration]
    if len(marks) < 2:
        b = [float(t) for t in beats if 0.0 <= t < duration]
        marks = b[::4] if len(b) >= 8 else []
    if len(marks) < 2:
        return []
    spans = [(marks[i], marks[i + 1]) for i in range(len(marks) - 1)]
    typical = float(np.median([e - s for s, e in spans]))
    if duration - marks[-1] >= 0.9 * typical:
        spans.append((marks[-1], min(duration, marks[-1] + typical)))
    return [(s, e) for s, e in spans if e > s]


def regular_bars(bars: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    """Drop "bars" shorter than 0.75× the median: odd-meter bridges and downbeat glitches."""
    if not bars:
        return []
    med = float(np.median([e - s for s, e in bars]))
    return [(s, e) for s, e in bars if e - s >= 0.75 * med]


def beat_spans(beats: Sequence[float], duration: float) -> List[Tuple[float, float]]:
    b = [float(t) for t in beats if 0.0 <= t < duration]
    return [(b[i], b[i + 1]) for i in range(len(b) - 1) if b[i + 1] > b[i]]


def _rms_db(mono: np.ndarray, sr: int, start: float, end: float) -> float:
    seg = mono[int(start * sr) : int(end * sr)]
    if not len(seg):
        return -180.0
    return float(20 * np.log10(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-9))


def _spread(items: list, count: int) -> list:
    """``count`` items spread evenly over ``items`` (all of them when fewer), order kept."""
    if len(items) <= count:
        return list(items)
    picks = np.unique(np.linspace(0, len(items) - 1, count).round().astype(int))
    return [items[i] for i in picks]


def chop_full(mono: np.ndarray, sr: int, duration: float, beats, downbeats) -> List[Chop]:
    """Spread phrases across the song, choosing the largest bar count that yields sixteen."""
    bars = bars_from(downbeats, beats, duration)
    if not bars:
        # No grid at all: equal slices are the honest fallback.
        n = MAX_CHOPS if duration >= MAX_CHOPS * 0.5 else max(1, int(duration / 0.5))
        edges = np.linspace(0.0, duration, n + 1)
        raw = [(float(edges[i]), float(edges[i + 1]), f"slice {i + 1}") for i in range(n)]
        return finalize(raw, mono, sr, duration)
    k = next((c for c in (8, 4, 2, 1) if len(bars) >= MAX_CHOPS * c), 1)
    groups = [(i, bars[i][0], bars[i + k - 1][1]) for i in range(0, len(bars) - k + 1, k)]
    raw = [(s, e, f"bar {i + 1}" if k == 1 else f"bars {i + 1}-{i + k}") for i, s, e in _spread(groups, MAX_CHOPS)]
    return finalize(raw, mono, sr, duration)


def chop_grid(mono: np.ndarray, sr: int, duration: float, beats, downbeats, *, active_db: float = 20.0) -> List[Chop]:
    """Bass/other: one bar each on the bars where the stem plays (within ``active_db``
    of its loudest bar, and above −60 dBFS), spread over the song; beat-length
    chops when that gives more."""

    def pick(units: List[Tuple[float, float]], kind: str) -> List[Tuple[float, float, str]]:
        levels = [_rms_db(mono, sr, s, e) for s, e in units]
        if not levels:
            return []
        top = max(levels)
        act = [(i, s, e) for i, ((s, e), lvl) in enumerate(zip(units, levels)) if lvl >= top - active_db and lvl > -60.0]
        return [(s, e, f"{kind} {i + 1}") for i, s, e in _spread(act, MAX_CHOPS)]

    raw = pick(regular_bars(bars_from(downbeats, beats, duration)), "bar")
    if len(raw) < MAX_CHOPS:
        alt = pick(beat_spans(beats, duration), "beat")
        if len(alt) > len(raw):
            raw = alt
    return finalize(raw, mono, sr, duration)


def onset_envelope(mono: np.ndarray, sr: int, *, frame: int = ONSET_FRAME, hop: int = ONSET_HOP) -> Tuple[np.ndarray, float]:
    """Half-wave-rectified log spectral flux; returns ``(envelope, frames_per_second)``.
    Computed in blocks so a long song never holds the whole spectrogram."""
    x = np.asarray(mono, dtype=np.float32)
    if sr > 24000:  # 2× decimation with a 2-tap average: onsets do not need 20 kHz
        x = x[: len(x) // 2 * 2].reshape(-1, 2).mean(axis=1)
        sr = sr // 2
    if len(x) < frame:
        return np.zeros(0, dtype=np.float32), sr / hop
    n_frames = 1 + (len(x) - frame) // hop
    window = np.hanning(frame).astype(np.float32)
    flux = np.zeros(n_frames, dtype=np.float32)
    prev = None
    block = 2048
    for b0 in range(0, n_frames, block):
        b1 = min(n_frames, b0 + block)
        idx = (np.arange(b0, b1)[:, None] * hop) + np.arange(frame)[None, :]
        mag = np.log1p(100.0 * np.abs(np.fft.rfft(x[idx] * window, axis=1))).astype(np.float32)
        head = prev[None, :] if prev is not None else mag[:1]
        flux[b0:b1] = np.maximum(0.0, np.diff(np.vstack([head, mag]), axis=0)).sum(axis=1)
        prev = mag[-1]
    return flux, sr / hop


def pick_peaks(env: np.ndarray, fps: float, *, min_gap_s: float = 0.03) -> Tuple[np.ndarray, np.ndarray]:
    """Local maxima above an adaptive threshold → ``(frame indices, strengths)``."""
    if len(env) < 3:
        return np.zeros(0, dtype=int), np.zeros(0)
    w = max(1, int(0.1 * fps))
    kernel = np.ones(2 * w + 1) / (2 * w + 1)
    local_mean = np.convolve(env, kernel, mode="same")
    threshold = local_mean + 0.5 * float(np.std(env))
    is_peak = (env[1:-1] > env[:-2]) & (env[1:-1] >= env[2:]) & (env[1:-1] > threshold[1:-1])
    peaks = np.nonzero(is_peak)[0] + 1
    kept: List[int] = []
    gap = max(1, int(min_gap_s * fps))
    for p in peaks:  # thin peaks closer than min_gap, keeping the stronger
        if kept and p - kept[-1] < gap:
            if env[p] > env[kept[-1]]:
                kept[-1] = int(p)
            continue
        kept.append(int(p))
    k = np.array(kept, dtype=int)
    return k, env[k] if len(k) else np.zeros(0)


def chop_drums(mono: np.ndarray, sr: int, duration: float, beats, *, min_spacing_s: Optional[float] = None) -> List[Chop]:
    """The strongest onsets, at least max(1 s, 2 beats) apart so the pads are
    distinct hits from across the song; each runs to the next onset, at most a
    beat. A loudness gate (max(−45 dB, loudest − 30 dB)) skips near-silent hits:
    a quiet drum stem gives fewer than 16, not noise."""
    env, fps = onset_envelope(mono, sr)
    peaks, strength = pick_peaks(env, fps)
    if len(peaks) == 0:
        return []
    # A flux peak is the frame whose window *centre* meets the transient.
    times = np.maximum(0.0, (peaks + ONSET_FRAME / ONSET_HOP / 2) / fps - ONSET_PREROLL_S)
    ibi = beat_period(beats)
    spacing = min_spacing_s if min_spacing_s is not None else max(1.0, 2 * ibi)
    probe = min(ibi, 0.25)
    order = np.argsort(-strength, kind="stable")
    loudest = max(_rms_db(mono, sr, float(times[j]), float(times[j]) + probe) for j in order[:8])
    gate = max(-45.0, loudest - 30.0)
    chosen: List[float] = []
    for j in order:
        t = float(times[j])
        if _rms_db(mono, sr, t, t + probe) < gate:
            continue
        if all(abs(t - c) >= spacing for c in chosen):
            chosen.append(t)
            if len(chosen) == MAX_CHOPS:
                break
    onsets = np.sort(times)
    raw = []
    for t in chosen:
        later = onsets[onsets > t + 0.03]
        end = min(float(later[0]) if len(later) else t + ibi, t + ibi, duration)
        raw.append((t, max(end, t + 0.06), "hit"))
    return finalize(raw, mono, sr, duration, prefix="hit")


def voiced_regions(
    mono: np.ndarray, sr: int, *, hop_s: float = 0.0116, top_db: float = 35.0, min_gap_s: float = 0.25
) -> List[Tuple[float, float]]:
    """Non-silent intervals (frame RMS within ``top_db`` of the loudest frame), breaths merged."""
    hop = max(1, int(hop_s * sr))
    n = len(mono) // hop
    if n == 0:
        return []
    rms = np.sqrt(np.mean(mono[: n * hop].astype(np.float64).reshape(n, hop) ** 2, axis=1))
    peak = float(rms.max())
    if peak <= 1e-5:
        return []
    on = rms > peak * (10 ** (-top_db / 20))
    regions: List[List[float]] = []
    edges = np.diff(np.concatenate([[0], on.astype(np.int8), [0]]))
    for i, j in zip(np.nonzero(edges == 1)[0], np.nonzero(edges == -1)[0]):
        s, e = i * hop / sr, j * hop / sr
        if regions and s - regions[-1][1] < min_gap_s:
            regions[-1][1] = e
        else:
            regions.append([s, e])
    return [(s, e) for s, e in regions]


def _snap_to_beat(t: float, beats: np.ndarray, maxdist: float, mode: str) -> float:
    """The beat at/before (``floor``), at/after (``ceil``) or nearest ``t`` within ``maxdist``; else ``t``."""
    if len(beats) == 0:
        return t
    if mode == "floor":
        c = beats[beats <= t + BEAT_SNAP_SLACK_S]
        return float(c[-1]) if len(c) and t - c[-1] <= maxdist else t
    if mode == "ceil":
        c = beats[beats >= t - BEAT_SNAP_SLACK_S]
        return float(c[0]) if len(c) and c[0] - t <= maxdist else t
    j = int(np.argmin(np.abs(beats - t)))
    return float(beats[j]) if abs(beats[j] - t) <= maxdist else t


def chop_vocals(mono: np.ndarray, sr: int, duration: float, beats, downbeats=(), *, min_len: float = 0.4) -> List[Chop]:
    """Phrases split at silences; the start snapped back to the beat before (keeps
    the pickup), the end forward to the next beat. Phrases longer than two bars
    are cut at downbeats; while there are fewer than 16, the longest is halved
    on the beat grid; then 16 are spread over the song."""
    b = np.asarray(sorted(float(t) for t in beats), dtype=float)
    ibi = beat_period(b)
    bars = bars_from(downbeats, beats, duration)
    bar_len = float(np.median([e - s for s, e in bars])) if bars else 4 * ibi
    max_len = 2 * bar_len
    regions = voiced_regions(mono, sr)
    phrases: List[Tuple[float, float]] = []
    for i, (a, z) in enumerate(regions):
        nxt = regions[i + 1][0] if i + 1 < len(regions) else None
        s = _snap_to_beat(a, b, ibi, "floor")
        e = _snap_to_beat(z, b, ibi, "ceil")
        if nxt is not None and e > nxt:
            e = z
        if e - s >= min_len:
            phrases.append((s, e))
    dbs = np.array([s for s, _ in bars])
    pieces: List[Tuple[float, float]] = []
    for s, e in phrases:
        while e - s > max_len:
            cut = dbs[(dbs > s + bar_len * 0.75) & (dbs <= s + max_len)] if len(dbs) else dbs
            c = float(cut[-1]) if len(cut) else s + max_len
            pieces.append((s, c))
            s = c
        pieces.append((s, e))
    pieces = [(s, e) for s, e in pieces if e - s >= min_len and _rms_db(mono, sr, s, e) > -50.0]
    while 0 < len(pieces) < MAX_CHOPS:
        j = max(range(len(pieces)), key=lambda k: pieces[k][1] - pieces[k][0])
        s, e = pieces[j]
        if e - s < 2 * min_len + 0.2:
            break
        mid = _snap_to_beat((s + e) / 2, b, ibi, "nearest")
        if not (s + min_len <= mid <= e - min_len):
            mid = (s + e) / 2
        pieces[j : j + 1] = [(s, mid), (mid, e)]
    raw = [(s, e, "phrase") for s, e in _spread(sorted(pieces), MAX_CHOPS)]
    return finalize(raw, mono, sr, duration, prefix="phrase")


def estimate_key(mono: np.ndarray, sr: int) -> Optional[str]:
    """Krumhansl–Schmuckler on a long-term chroma of the harmonic stems."""
    x = np.asarray(mono, dtype=np.float32)
    factor = max(1, sr // 11025)
    if factor > 1:
        x = x[: len(x) // factor * factor].reshape(-1, factor).mean(axis=1)
    rate = sr / factor
    frame, hop = 8192, 4096
    if len(x) < frame:
        return None
    freqs = np.fft.rfftfreq(frame, 1.0 / rate)
    band = (freqs >= 55.0) & (freqs <= 2000.0)
    pcs = (np.round(12 * np.log2(freqs[band] / 440.0)).astype(int) + 9) % 12
    chroma = np.zeros(12)
    window = np.hanning(frame).astype(np.float32)
    n_frames = 1 + (len(x) - frame) // hop
    for b0 in range(0, n_frames, 512):
        b1 = min(n_frames, b0 + 512)
        idx = (np.arange(b0, b1)[:, None] * hop) + np.arange(frame)[None, :]
        power = (np.abs(np.fft.rfft(x[idx] * window, axis=1)) ** 2)[:, band]
        np.add.at(chroma, pcs, power.sum(axis=0))
    if chroma.sum() <= 0:
        return None
    chroma = chroma / chroma.sum()
    best, name = -2.0, None
    for tonic in range(12):
        for profile, mode in ((_MAJOR, "major"), (_MINOR, "minor")):
            r = float(np.corrcoef(chroma, np.roll(profile, tonic))[0, 1])
            if r > best:
                best, name = r, f"{NOTES[tonic]} {mode}"
    return name


def build_chops(
    mix: np.ndarray, sources: Dict[str, np.ndarray], sr: int, duration: float, beats, downbeats
) -> Dict[str, List[Chop]]:
    mono = {name: to_mono(sig) for name, sig in sources.items()}
    return {
        "full": chop_full(to_mono(mix), sr, duration, beats, downbeats),
        "drums": chop_drums(mono["drums"], sr, duration, beats),
        "bass": chop_grid(mono["bass"], sr, duration, beats, downbeats),
        "other": chop_grid(mono["other"], sr, duration, beats, downbeats),
        "vocals": chop_vocals(mono["vocals"], sr, duration, beats, downbeats),
    }


# ==================================================================== pipeline


def _ff(args: List[str], what: str) -> None:
    from ..lyrics.pipeline import ffmpeg_binary

    proc = subprocess.run([ffmpeg_binary(), "-y", "-loglevel", "error", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg ({what}): {proc.stderr.strip()[:200]}")


def decode(src: Path, work: Path) -> Path:
    wav = work / "mix44.wav"
    try:
        _ff(["-i", str(src), "-ac", "2", "-ar", str(SAMPLE_RATE), str(wav)], "decode")
    except RuntimeError as e:
        raise StemsError(f"ffmpeg no pudo leer el archivo: {e}") from e
    return wav


def separate(wav: Path, model: str) -> Tuple[Dict[str, np.ndarray], int]:
    """htdemucs through MLX → ``{stem: (samples, 2) float32}``."""
    from ...acceleration import detect

    if detect()["accel"] != "mlx":
        from ...separation import separate as portable_separate

        return portable_separate(wav, model)
    from demucs_mlx import Separator

    # A single batch bounds unified-memory use and avoids Metal timeout spikes.
    separator = Separator(model=model, batch_size=1)
    _origin, stems = separator.separate_audio_file(str(wav))
    out: Dict[str, np.ndarray] = {}
    for name in STEMS:
        arr = np.asarray(stems[name], dtype=np.float32)
        if arr.ndim == 2 and arr.shape[0] <= 2:
            arr = arr.T
        out[name] = arr
    return out, int(getattr(separator, "samplerate", SAMPLE_RATE))


def detect_beats(mix: np.ndarray, sr: int) -> Tuple[List[float], List[float]]:
    """beat_this (CPJKU, MIT) on the full mix. MPS when it works, CPU otherwise."""
    from ...acceleration import torch_device
    from beat_this.inference import Audio2Beats

    device = torch_device()
    beats, downbeats = Audio2Beats(checkpoint_path="final0", device=device, dbn=False)(mix, sr)
    return [round(float(t), 4) for t in beats], [round(float(t), 4) for t in downbeats]


def encode(wav: Path, target: Path) -> None:
    _ff(
        ["-i", str(wav), "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-vbr", "on", "-application", "audio",
         "-ar", "48000", "-ac", "2", str(target)],
        "encode",
    )


def run_stems(job: StemsJob, out_dir: Path, report: Report) -> Dict[str, object]:
    import soundfile as sf

    started = time.monotonic()
    timings: Dict[str, float] = {}
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"
    work.mkdir(exist_ok=True)

    def phase(name: str, percent: Optional[float] = None) -> float:
        report(name, percent)
        return time.monotonic()

    t = phase(P.PHASE_DECODING)
    wav = decode(job.audio, work)
    mix, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    duration = len(mix) / sr
    if duration < 1.0 or float(np.max(np.abs(mix))) < 1e-4:
        raise StemsError("el audio está vacío o en silencio")
    timings["decode"] = round(time.monotonic() - t, 2)

    # Detect beats before MLX separation to avoid GPU contention with torch on MPS.
    t = phase(P.PHASE_RHYTHM)
    beats, downbeats = detect_beats(mix, sr)
    timings["beats"] = round(time.monotonic() - t, 2)

    t = phase(P.PHASE_SEPARATING)
    sources, src_sr = separate(wav, job.model)
    if src_sr != sr:
        raise RuntimeError(f"demucs devolvió {src_sr} Hz, se esperaba {sr}")
    for name, sig in sources.items():
        sf.write(str(work / f"{name}.wav"), sig, sr)
    timings["separate"] = round(time.monotonic() - t, 2)

    t = phase(P.PHASE_CHOPPING)
    chops = build_chops(mix, sources, sr, duration, beats, downbeats)
    harmonic = to_mono(sources["bass"]) + to_mono(sources["other"])
    key = estimate_key(harmonic, sr)
    timings["chop"] = round(time.monotonic() - t, 2)

    t = phase(P.PHASE_ENCODING, 0)
    # Four ffmpeg processes at once: 2 s instead of ~6 for a 3-minute song.
    with ThreadPoolExecutor(max_workers=len(STEMS)) as pool:
        for _ in pool.map(lambda n: encode(work / f"{n}.wav", out_dir / f"{n}.ogg"), STEMS):
            pass
    report(P.PHASE_ENCODING, 100)
    timings["encode"] = round(time.monotonic() - t, 2)

    manifest = {
        "version": 1,
        "track": {"album": job.album, "file": job.file, "duration": round(duration, 3), "sampleRate": sr},
        "model": job.model,
        "stems": {name: f"{name}.ogg" for name in STEMS},  # the server rewrites these to URLs
        "analysis": {"bpm": estimate_bpm(beats), "key": key, "beats": beats, "downbeats": downbeats},
        "chops": chops,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "worker": {
            "host": socket.gethostname().split(".")[0],
            "platform": f"{platform.system().lower()}-{platform.machine()}",
            "seconds": round(time.monotonic() - started, 2),
            "timings": timings,
        },
    }
    manifest_path = out_dir / "song.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    for leftover in work.iterdir():
        leftover.unlink()
    work.rmdir()
    return {"dir": str(out_dir), "manifest": str(manifest_path), "seconds": manifest["worker"]["seconds"]}  # type: ignore[index]
