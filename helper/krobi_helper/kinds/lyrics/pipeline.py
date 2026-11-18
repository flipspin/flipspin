"""Align known text to isolated vocals without a transcription pass.

Optional transcription supplies text only when none exists. Preserve line-level
timestamps and confidence for clients; stage outputs for server publication.
See docs/lyrics-align.md for the alignment pipeline and resource tradeoffs.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from . import align as aligner
from ... import protocol as P

Report = Callable[[str, Optional[float]], None]


class PipelineError(RuntimeError):
    pass


@dataclass
class Job:
    id: str
    audio: Path
    text: Optional[str] = None          # plain lyrics to align, if known
    isolate_vocals: bool = True
    language: Optional[str] = None      # ISO-639-1 hint for Whisper ("es")
    #: An already separated vocals stem (a song split by `stems`): skips demucs.
    vocals: Optional[Path] = None
    extra: Dict[str, object] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, object]) -> "Job":
        return cls(
            id=str(data["id"]),
            audio=Path(str(data["audio"])),
            text=(str(data["text"]) if data.get("text") else None),
            isolate_vocals=bool(data.get("isolateVocals", True)),
            language=(str(data["language"]) if data.get("language") else None),
            vocals=(Path(str(data["vocals"])) if data.get("vocals") else None),
        )


# ------------------------------------------------------------------ audio


def ffmpeg_binary() -> str:
    for candidate in ("ffmpeg",):
        found = shutil.which(candidate)
        if found:
            return found
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover - depends on the machine
        raise PipelineError("ffmpeg no está disponible en esta Mac.") from e


def decode(src: Path, out_dir: Path) -> Tuple[Path, Path]:
    """16 kHz mono for Whisper/the aligner, 44.1 kHz stereo for demucs."""
    ff = ffmpeg_binary()
    wav16 = out_dir / "mix16.wav"
    wav44 = out_dir / "mix44.wav"
    for target, args in ((wav16, ["-ac", "1", "-ar", "16000"]), (wav44, ["-ac", "2", "-ar", "44100"])):
        proc = subprocess.run(
            [ff, "-y", "-loglevel", "error", "-i", str(src), *args, str(target)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise PipelineError(f"ffmpeg no pudo leer el archivo: {proc.stderr.strip()[:200]}")
    return wav16, wav44


def isolate_vocals(wav44: Path, out_dir: Path) -> Path:
    """htdemucs through MLX; returns a 16 kHz mono vocals wav."""
    import numpy as np
    import soundfile as sf
    from ...acceleration import detect

    if detect()["accel"] == "mlx":
        from demucs_mlx import Separator

        # A single separation batch bounds unified-memory use with little latency cost.
        separator = Separator(model=P.DEMUCS_MODEL, batch_size=1)
        _origin, stems = separator.separate_audio_file(str(wav44))
        samplerate = int(getattr(separator, "samplerate", 44100))
    else:
        from ...separation import separate

        stems, samplerate = separate(wav44, P.DEMUCS_MODEL)
    vocals = np.asarray(stems["vocals"])
    if vocals.ndim == 2 and vocals.shape[0] <= 2:
        vocals = vocals.T  # (channels, samples) → (samples, channels)
    voc44 = out_dir / "vocals44.wav"
    sf.write(str(voc44), vocals, samplerate)
    voc16 = out_dir / "vocals16.wav"
    proc = subprocess.run(
        [ffmpeg_binary(), "-y", "-loglevel", "error", "-i", str(voc44), "-ac", "1", "-ar", "16000", str(voc16)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise PipelineError(f"ffmpeg no pudo convertir la voz aislada: {proc.stderr.strip()[:200]}")
    return voc16


# ------------------------------------------------------------- transcribe


def transcribe(wav16: Path, language: Optional[str]) -> Dict[str, object]:
    from ...acceleration import detect

    accel = detect()["accel"]
    if accel != "mlx":
        import whisper
        from ...cli import whisper_home

        model = whisper.load_model("large-v3-turbo", device=accel, download_root=str(whisper_home()))
        return model.transcribe(str(wav16), language=language, word_timestamps=True,
                                condition_on_previous_text=False, fp16=accel == "cuda")

    import mlx_whisper

    options: Dict[str, object] = {}
    if language:
        options["language"] = language
    return mlx_whisper.transcribe(
        str(wav16),
        path_or_hf_repo=P.WHISPER_REPO,
        word_timestamps=True,
        # Music loops Whisper into repeating itself when each window is
        # conditioned on the previous one; off is the safer default here.
        condition_on_previous_text=False,
        **options,
    )


#: What Whisper says when nobody is singing. Seen verbatim on an instrumental
#: nature-documentary track ("Thank you." × 4 at 30 s intervals); the others are
#: the well-known subtitle-credit hallucinations from its training data.
HALLUCINATIONS = {
    "thank you.", "thank you", "thanks for watching.", "thanks for watching",
    "subtítulos por la comunidad de amara.org", "subtitulos por la comunidad de amara.org",
    "subtítulos realizados por la comunidad de amara.org", "gracias por ver el video.",
    "gracias por ver.", "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage société radio-canada", "you", "bye.", "bye", "♪", "♪♪", "[music]", "[música]",
    "(música)", "(music)", "music", "música",
}
#: Whisper's own confidence that a window holds no speech; above this a
#: segment is treated as silence even if it carries text.
NO_SPEECH_MAX = 0.6
AVG_LOGPROB_MIN = -1.0


def clean_segments(result: Dict[str, object]) -> List[Dict[str, object]]:
    """Segments that are plausibly sung words: not silence, not a stock hallucination."""
    kept: List[Dict[str, object]] = []
    for segment in result.get("segments", []):  # type: ignore[union-attr]
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        if text.lower().strip(" .!¡¿?") in {h.strip(" .!¡¿?") for h in HALLUCINATIONS}:
            continue
        no_speech = segment.get("no_speech_prob")
        logprob = segment.get("avg_logprob")
        if isinstance(no_speech, (int, float)) and no_speech > NO_SPEECH_MAX:
            continue
        if isinstance(logprob, (int, float)) and logprob < AVG_LOGPROB_MIN:
            continue
        kept.append(segment)
    # A song whose every line is the same short phrase is a loop, not a lyric.
    distinct = {str(k.get("text", "")).strip().lower() for k in kept}
    if kept and len(distinct) == 1 and len(next(iter(distinct)).split()) <= 3:
        return []
    return kept


def lines_from_transcription(result: Dict[str, object]) -> List[Tuple[float, str]]:
    out: List[Tuple[float, str]] = []
    for segment in clean_segments(result):
        text = str(segment.get("text", "")).strip()
        out.append((float(segment.get("start", 0.0)), text))
    return out


# ------------------------------------------------------------------ align
#
# The aligner itself lives in `align.py`, standalone (no MLX, no server), so
# another app can call it with (audio, text). These wrappers keep this
# module's names for the line test the backend relies on.


def romanize_line(line: str) -> str:
    """Lower-case Latin letters only, the way the MMS dictionary wants them."""
    return aligner.romanize(line, aligner.guess_language(line))


def alignable_lines(text: str) -> List[Tuple[str, str]]:
    """``(original, romanized)`` per line that has at least one Latin letter."""
    return [(line.text, " ".join(line.words)) for line in aligner.prepare_text(text)]


# -------------------------------------------------------------------- lrc


def to_lrc(lines: List[Tuple[float, str]]) -> str:
    def stamp(seconds: float) -> str:
        seconds = max(0.0, seconds)
        minutes = int(seconds // 60)
        rest = seconds - minutes * 60
        return f"[{minutes:02d}:{rest:05.2f}]"

    return "".join(f"{stamp(t)} {text}\n" for t, text in sorted(lines, key=lambda x: x[0]))


# -------------------------------------------------------------------- job


def run_job(job: Job, out_dir: Path, report: Report) -> Dict[str, object]:
    work = out_dir / job.id
    work.mkdir(parents=True, exist_ok=True)
    try:
        if job.text and alignable_lines(job.text):
            return _align_job(job, work, report)
        return _transcribe_job(job, work, report)
    finally:
        # The big intermediates are not worth keeping around per song.
        for name in ("mix16.wav", "mix44.wav", "vocals44.wav", "vocals16.wav"):
            try:
                (work / name).unlink()
            except FileNotFoundError:
                pass


def _align_device() -> str:
    from ...acceleration import torch_device

    return torch_device()


def _align_job(job: Job, work: Path, report: Report) -> Dict[str, object]:
    """Known words: place them. Whisper never runs on this path."""
    report(P.PHASE_DECODING, None)
    if job.vocals and job.vocals.exists():
        source = job.vocals  # the song was split already; its vocals stem is the best input
        vocals_from = "stems"
    elif job.isolate_vocals:
        _wav16, wav44 = decode(job.audio, work)
        report(P.PHASE_SEPARATING, None)
        source = isolate_vocals(wav44, work)
        vocals_from = "demucs"
    else:
        source = job.audio
        vocals_from = None
    report(P.PHASE_ALIGNING, None)
    try:
        result = aligner.align_file(str(source), job.text or "", language=job.language, device=_align_device())
    except aligner.AlignError as e:
        raise PipelineError(str(e)) from e
    if not result.lines:
        raise PipelineError("No se pudo alinear ninguna línea.")
    report(P.PHASE_WRITING, None)
    lrc_path = work / "lyrics.lrc"
    words_path = work / "words.json"
    lrc_path.write_text(aligner.to_lrc(result.lines), encoding="utf-8")
    words_path.write_text(json.dumps(result.to_dict(), ensure_ascii=False), encoding="utf-8")
    return {
        "lrc": str(lrc_path),
        "words": str(words_path),
        "language": job.language,
        "source": P.SOURCE_ALIGNED,
        "kind": "synced",
        "lines": len(result.lines),
        # Per LRC line, in file order; the UI marks the low ones for review.
        "lineConfidence": [line.conf for line in result.lines],
        "lowLines": result.low_lines,
        "vocals": vocals_from,
        "device": result.device,
    }


def _transcribe_job(job: Job, work: Path, report: Report) -> Dict[str, object]:
    report(P.PHASE_DECODING, None)
    wav16, wav44 = decode(job.audio, work)
    source_audio = wav16
    if job.vocals and job.vocals.exists():
        source_audio = job.vocals
    elif job.isolate_vocals:
        report(P.PHASE_SEPARATING, None)
        source_audio = isolate_vocals(wav44, work)

    report(P.PHASE_TRANSCRIBING, None)
    result = transcribe(source_audio, job.language)
    language = str(result.get("language") or job.language or "")
    lines = lines_from_transcription(result)
    words = [
        {"start": w.get("start"), "end": w.get("end"), "text": str(w.get("word", "")).strip()}
        for seg in clean_segments(result)
        for w in (seg.get("words") or [])
    ]
    if not lines:
        raise PipelineError("No se reconoció voz cantada en el audio; parece instrumental.")

    report(P.PHASE_WRITING, None)
    lrc_path = work / "lyrics.lrc"
    words_path = work / "words.json"
    lrc_path.write_text(to_lrc(lines), encoding="utf-8")
    words_path.write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    return {
        "lrc": str(lrc_path),
        "words": str(words_path),
        "language": language or None,
        "source": P.SOURCE_TRANSCRIBED,
        "kind": "synced",
        "lines": len(lines),
    }
