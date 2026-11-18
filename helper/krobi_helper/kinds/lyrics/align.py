"""Align known lyrics to audio with windowed MMS_FA emissions and numpy CTC.

Preserve original output text and confidence flags; apply no implicit timing lead.
See docs/lyrics-align.md#how-it-works-and-why-each-step.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path
from ...paths import state_path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.request import urlopen

MMS_SHA256 = "20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680"
MMS_URLS = (
    "https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt",
    "https://huggingface.co/selectorrrr/ctc_alignment_mling_uroman/resolve/c13912af40f24d0f910181f141d6f917caf6edcc/model.pt",
)

def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        digest = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
        return digest.hexdigest()


def ensure_aligner() -> Path:
    """Verify before publication or torch.load. TLS verification stays enabled."""
    models = state_path("KROBI_MODELS_DIR", "models")
    target = Path(os.environ.get("TORCH_HOME") or models / "torch") / "hub/checkpoints/model.pt"
    if target.is_file() and sha256(target) == MMS_SHA256:
        return target
    target.unlink(missing_ok=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    errors = []
    for url in MMS_URLS:
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                with urlopen(url, timeout=60) as response:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            actual = sha256(temporary)
            if actual != MMS_SHA256:
                raise ValueError(f"SHA-256 mismatch: expected {MMS_SHA256}, got {actual}")
            temporary.replace(target)
            return target
        except Exception as exc:
            print(f"MMS download failed ({url}): {exc}", file=sys.stderr, flush=True)
            errors.append(f"{url}: {exc}")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    raise RuntimeError("aligner: " + " | ".join(errors))

SAMPLE_RATE = 16000
WINDOW_S = 8.0
CONTEXT_S = 3.0
#: Window tilings averaged (see ``emissions``).
TILINGS = 1
#: A line whose characters average below this posterior is flagged for review.
LOW_CONFIDENCE = 0.15
#: Keep the wildcard free, as in MMS_FA: a per-frame penalty collapses it to
#: one frame and can shift alignment away from the sung words.
STAR_LOGP = 0.0
#: Inside one word, characters further apart than this are strays the CTC path
#: parked early (a single "l" 8 s before "ittle"): the word starts after them.
MAX_CHAR_GAP_S = 1.0
#: Where the wildcard goes: before every line, only at stanza breaks (blank
#: line in the text) plus the ends, only at the ends, or nowhere.
WILDCARDS = ("line", "stanza", "edges", "none")
SOURCE = "aligned:mms-fa"


class AlignError(RuntimeError):
    """The text or the audio cannot be aligned (no Latin letters, no audio)."""


# ------------------------------------------------------------------ text

_KEEP = re.compile(r"[^a-z0-9' ]")
_LABEL = re.compile(
    r"^\s*(\[[^\]]*\]|\((?:x|×)\s*\d+\)|(?:pre[- ]?)?(?:coro|chorus|estribillo|verso|verse|intro|outro|puente|bridge|hook|refr[aá]n)"
    r"(?:\s*\d+)?\s*(?:\([^)]*\))?\s*:?)\s*$",
    re.IGNORECASE,
)

_ES_UNITS = "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte veintiuno veintidos veintitres veinticuatro veinticinco veintiseis veintisiete veintiocho veintinueve".split()
_ES_TENS = {3: "treinta", 4: "cuarenta", 5: "cincuenta", 6: "sesenta", 7: "setenta", 8: "ochenta", 9: "noventa"}
_ES_HUNDREDS = {1: "ciento", 2: "doscientos", 3: "trescientos", 4: "cuatrocientos", 5: "quinientos", 6: "seiscientos", 7: "setecientos", 8: "ochocientos", 9: "novecientos"}
_EN_UNITS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_EN_TENS = {2: "twenty", 3: "thirty", 4: "forty", 5: "fifty", 6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety"}


def spell_number(n: int, language: str = "es") -> str:
    """0–999 999 in words, the way it is sung. Larger numbers stay digits."""
    if n < 0 or n > 999_999:
        return str(n)
    return _spell_es(n) if language == "es" else _spell_en(n)


def _spell_es(n: int) -> str:
    if n < 30:
        return _ES_UNITS[n]
    if n < 100:
        tens, unit = divmod(n, 10)
        return _ES_TENS[tens] + (f" y {_ES_UNITS[unit]}" if unit else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        if n == 100:
            return "cien"
        return _ES_HUNDREDS[hundreds] + (f" {_spell_es(rest)}" if rest else "")
    thousands, rest = divmod(n, 1000)
    head = "mil" if thousands == 1 else f"{_spell_es(thousands)} mil"
    return head + (f" {_spell_es(rest)}" if rest else "")


def _spell_en(n: int) -> str:
    if n < 20:
        return _EN_UNITS[n]
    if n < 100:
        tens, unit = divmod(n, 10)
        return _EN_TENS[tens] + (f" {_EN_UNITS[unit]}" if unit else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        return f"{_EN_UNITS[hundreds]} hundred" + (f" {_spell_en(rest)}" if rest else "")
    thousands, rest = divmod(n, 1000)
    return f"{_spell_en(thousands)} thousand" + (f" {_spell_en(rest)}" if rest else "")


_ES_HINTS = {"que", "de", "la", "el", "y", "en", "no", "me", "te", "lo", "los", "las", "mi", "tu", "pa", "por", "con", "una", "un", "es", "yo", "se"}
_EN_HINTS = {"the", "and", "you", "i", "to", "a", "it", "my", "me", "in", "of", "that", "is", "your", "we", "on", "for", "be", "this", "know"}


def guess_language(text: str) -> str:
    """``es`` or ``en`` — only to spell digits; the acoustic model is language-blind."""
    words = re.findall(r"[a-záéíóúñü']+", text.lower())
    es = sum(w in _ES_HINTS for w in words) + 3 * len(re.findall(r"[ñáéíóú¿¡]", text.lower()))
    en = sum(w in _EN_HINTS for w in words)
    return "en" if en > es else "es"


def romanize(text: str, language: str = "es") -> str:
    """Lower-case ``a–z'`` words, digits spelled out — what the MMS dictionary takes."""
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    ascii_only = ascii_only.replace("ß", "ss").replace("æ", "ae").replace("ø", "o").lower()
    ascii_only = ascii_only.replace("’", "'").replace("‘", "'")
    cleaned = _KEEP.sub(" ", ascii_only)
    cleaned = re.sub(r"\d+", lambda m: f" {spell_number(int(m.group()), language)} ", cleaned)
    words = [w.strip("'") for w in cleaned.split()]
    return " ".join(w for w in words if re.search(r"[a-z]", w))


def is_label(line: str) -> bool:
    """"[Coro]", "Verse 2:", "(x2)" — structure written down, not sung."""
    return bool(_LABEL.match(line))


@dataclass
class TextLine:
    """One line to place: the original spelling and, per original token, its
    romanized words (a token like "12" becomes two words, "—" none)."""

    text: str
    tokens: List[Tuple[str, List[str]]]
    stanza_start: bool = False

    @property
    def words(self) -> List[str]:
        return [w for _, ws in self.tokens for w in ws]


def prepare_text(text: str, language: Optional[str] = None) -> List[TextLine]:
    """Lines worth aligning, in order. Blank lines only mark stanza breaks."""
    lang = language or guess_language(text)
    out: List[TextLine] = []
    stanza = True
    for raw in text.splitlines():
        original = raw.strip()
        if not original:
            stanza = True
            continue
        if is_label(original):
            stanza = True
            continue
        tokens = [(tok, romanize(tok, lang).split()) for tok in original.split()]
        line = TextLine(original, tokens, stanza_start=stanza)
        if line.words:
            out.append(line)
            stanza = False
    return out


# ------------------------------------------------------------- windows


#: wav2vec2's frame hop and receptive field, in samples at 16 kHz.
HOP = 320
RECEPTIVE = 400


def windows(n_samples: int, sample_rate: int = SAMPLE_RATE, window_s: float = WINDOW_S,
            context_s: float = CONTEXT_S, offset_s: float = 0.0) -> List[Tuple[int, int, int, int]]:
    """``(lo, hi, keep_start, keep_end)`` sample bounds: the model sees
    ``[lo, hi)``, the caller keeps the frames of ``[keep_start, keep_end)``.
    The kept spans tile ``[0, n_samples)`` exactly, without gaps or overlap;
    with ``offset_s`` the first one is that short, so a second tiling puts its
    edges in the middle of the first one's windows. Every bound is a whole
    number of frame hops, so frame *j* of a window is frame ``lo // HOP + j``
    of the song — no rounding drift from one window to the next."""
    if n_samples <= 0:
        return []
    win = max(HOP, int(round(window_s * sample_rate / HOP)) * HOP)
    ctx = max(0, int(round(context_s * sample_rate / HOP)) * HOP)
    first = int(round(offset_s * sample_rate / HOP)) * HOP
    edges = [0] + ([first] if 0 < first < n_samples else [])
    while edges[-1] + win < n_samples:
        edges.append(edges[-1] + win)
    edges.append(n_samples)
    return [(max(0, a - ctx), min(n_samples, b + ctx), a, b) for a, b in zip(edges, edges[1:], strict=False)]


def frame_count(n_samples: int) -> int:
    """Frames wav2vec2 yields for ``n_samples`` (at least one)."""
    return max(1, (n_samples - RECEPTIVE) // HOP + 1)


# ------------------------------------------------------------- targets


@dataclass(frozen=True)
class Owner:
    line: int
    word: int  # index into TextLine.words


def build_targets(lines: Sequence[TextLine], dictionary: Dict[str, int], star: int,
                  wildcard: str = "stanza") -> Tuple[List[int], List[Optional[Owner]]]:
    """Token ids for CTC, and for each id the line/word it spells (``None`` = wildcard).

    The blank (id 0) and characters outside the dictionary are skipped."""
    if wildcard not in WILDCARDS:
        raise ValueError(f"wildcard must be one of {WILDCARDS}")
    targets: List[int] = []
    owners: List[Optional[Owner]] = []
    for li, line in enumerate(lines):
        if wildcard == "line" or (wildcard in ("stanza",) and line.stanza_start) or (wildcard in ("edges", "stanza") and li == 0):
            targets.append(star)
            owners.append(None)
        for wi, word in enumerate(line.words):
            for ch in word:
                idx = dictionary.get(ch)
                if idx:
                    targets.append(idx)
                    owners.append(Owner(li, wi))
    if wildcard in ("edges", "stanza") and lines:
        targets.append(star)
        owners.append(None)
    return targets, owners


# -------------------------------------------------------------- result


@dataclass
class Word:
    text: str
    start: float
    end: float
    conf: float


@dataclass
class Line:
    text: str
    start: float
    end: float
    conf: float
    low: bool
    words: List[Word] = field(default_factory=list)


@dataclass
class Alignment:
    lines: List[Line]
    device: str
    seconds: Dict[str, float]
    threshold: float = LOW_CONFIDENCE
    lead_s: float = 0.0
    source: str = SOURCE

    @property
    def low_lines(self) -> List[int]:
        return [i for i, line in enumerate(self.lines) if line.low]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "device": self.device,
            "seconds": self.seconds,
            "threshold": self.threshold,
            "leadSeconds": self.lead_s,
            "lowLines": self.low_lines,
            "lines": [asdict(line) for line in self.lines],
        }


def drop_strays(chars: List[Tuple[int, int, float]], max_gap_frames: int) -> List[Tuple[int, int, float]]:
    """The tail of a word's character spans after its last gap wider than
    ``max_gap_frames`` — what is left once early strays are cut off."""
    if max_gap_frames <= 0 or len(chars) < 2:
        return chars
    cut = 0
    for i in range(1, len(chars)):
        if chars[i][0] - chars[i - 1][1] > max_gap_frames:
            cut = i
    return chars[cut:]


def assemble(lines: Sequence[TextLine], spans: Sequence[Tuple[int, int, float]],
             owners: Sequence[Optional[Owner]], seconds_per_frame: float,
             threshold: float = LOW_CONFIDENCE, lead_s: float = 0.0,
             max_char_gap_s: float = MAX_CHAR_GAP_S) -> List[Line]:
    """Per-token spans ``(start_frame, end_frame, prob)`` → lines with words.

    A word's time is its first character's start; an original token that
    spells no word ("—") rides on the word before it. A line none of whose
    characters were placed is left out (it had none to place)."""
    per_word: Dict[Tuple[int, int], List[Tuple[int, int, float]]] = {}
    for span, owner in zip(spans, owners, strict=True):
        if owner is None:
            continue
        per_word.setdefault((owner.line, owner.word), []).append(span)

    def t(frame: int) -> float:
        return round(max(0.0, frame * seconds_per_frame - lead_s), 3)

    max_gap = int(round(max_char_gap_s / seconds_per_frame)) if max_char_gap_s else 0
    out: List[Line] = []
    for li, line in enumerate(lines):
        words: List[Word] = []
        wi = 0
        probs: List[float] = []
        for token, roman in line.tokens:
            chars: List[Tuple[int, int, float]] = []
            for _ in roman:
                chars.extend(per_word.get((li, wi), []))
                wi += 1
            if not chars:
                if words:
                    words[-1].text = f"{words[-1].text} {token}"
                continue
            probs.extend(c[2] for c in chars)
            chars = drop_strays(chars, max_gap)
            words.append(Word(token, t(chars[0][0]), t(chars[-1][1]), round(sum(c[2] for c in chars) / len(chars), 3)))
        if not words:
            continue
        conf = round(sum(probs) / len(probs), 3)
        out.append(Line(line.text, words[0].start, words[-1].end, conf, conf < threshold, words))
    return out


# ------------------------------------------------------------------ io


def ffmpeg_binary() -> str:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:  # pragma: no cover - depends on the machine
        raise AlignError("ffmpeg is not available") from e


def load_audio(path: str, sample_rate: int = SAMPLE_RATE):
    """Any file ffmpeg reads → float32 mono at ``sample_rate``."""
    import numpy as np

    proc = subprocess.run(
        [ffmpeg_binary(), "-nostdin", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(sample_rate), "-f", "f32le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise AlignError(f"ffmpeg could not read {path}: {proc.stderr.decode(errors='replace').strip()[:200]}")
    samples = np.frombuffer(proc.stdout, dtype=np.float32)
    if samples.size == 0:
        raise AlignError(f"{path} has no audio")
    return samples


# ------------------------------------------------------------- viterbi


def viterbi(logp, targets: Sequence[int], blank: int = 0) -> List[Tuple[int, int, float]]:
    """The best CTC path of ``targets`` through ``logp`` (frames × vocab, log
    probabilities): per target, ``(start_frame, end_frame, mean_prob)``.

    Uses this implementation instead of ``torchaudio.functional.forced_align``: torchaudio 2.11
    (torch 2.14) returns paths measurably worse than the optimum — a 100-frame
    case scoring −21 where −1 exists, a letter put 49 frames late — and that
    API is on torchaudio's deprecation path anyway. Standard CTC topology:
    states alternate blank / target; a state is entered from itself, from the
    one before, or skipping a blank between two different targets.
    """
    import numpy as np

    logp = np.asarray(logp, dtype=np.float32)
    frames = logp.shape[0]
    n = len(targets)
    if n == 0:
        return []
    states = 2 * n + 1
    tok = np.array(targets, dtype=np.int64)
    label = np.full(states, blank, dtype=np.int64)
    label[1::2] = tok
    # A blank between targets is needed only when they repeat a token.
    skip = np.zeros(states, dtype=bool)
    skip[3::2] = tok[1:] != tok[:-1]
    min_frames = n + int(np.sum(tok[1:] == tok[:-1]))
    if min_frames > frames:
        raise AlignError("the text is longer than the audio can hold")
    neg = np.float32(-1e30)
    alpha = np.full(states, neg, dtype=np.float32)
    alpha[0] = logp[0, label[0]]
    alpha[1] = logp[0, label[1]]
    back = np.zeros((frames, states), dtype=np.int8)
    for t in range(1, frames):
        stay = alpha
        one = np.concatenate(([neg], alpha[:-1]))
        two = np.where(skip, np.concatenate(([neg, neg], alpha[:-2])), neg)
        best = np.maximum(stay, np.maximum(one, two))
        back[t] = np.where(best == stay, 0, np.where(best == one, 1, 2))
        alpha = best + logp[t, label]
    state = states - 1 if alpha[states - 1] >= alpha[states - 2] else states - 2
    path = np.empty(frames, dtype=np.int64)
    for t in range(frames - 1, -1, -1):
        path[t] = state
        state -= int(back[t, state])
    spans: List[Tuple[int, int, float]] = []
    probs = np.exp(logp[np.arange(frames), label[path]])
    for k in range(n):
        hit = np.flatnonzero(path == 2 * k + 1)
        spans.append((int(hit[0]), int(hit[-1]) + 1, float(probs[hit].mean())))
    return spans


# --------------------------------------------------------------- model

_MODEL: Dict[str, Any] = {}


def pick_device(requested: Optional[str] = None) -> str:
    if requested:
        return requested
    if __package__:
        from ...acceleration import torch_device

        return torch_device()
    # Keep the copyable, standalone aligner usable outside the worker package.
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _model(device: str):
    import torchaudio

    if device not in _MODEL:
        ensure_aligner()
        bundle = torchaudio.pipelines.MMS_FA
        _MODEL[device] = bundle.get_model(with_star=True).to(device).eval()
    return _MODEL[device]


def emissions(samples, device: str, window_s: float = WINDOW_S, context_s: float = CONTEXT_S,
              tilings: int = 1):
    """Log-probabilities per 20 ms frame, ``(frames, vocab)`` on the CPU.

    ``tilings`` > 1 runs the song again with the window edges shifted by a
    fraction of a window and averages the probabilities, so no frame is only
    ever seen next to an edge (costs that many times the compute)."""
    import torch

    model = _model(device)
    total = frame_count(len(samples))
    runs = []
    with torch.inference_mode():
        for k in range(max(1, tilings)):
            out = None
            for lo, hi, keep_start, keep_end in windows(len(samples), SAMPLE_RATE, window_s, context_s,
                                                        offset_s=window_s * k / max(1, tilings)):
                chunk = torch.from_numpy(samples[lo:hi].copy()).float()[None].to(device)
                em = model(chunk)[0][0].float().cpu()
                if out is None:
                    # Frames no window reached (a tail shorter than the receptive
                    # field) read as certain blank.
                    out = torch.full((total, em.shape[1]), -1e4)
                    out[:, 0] = 0.0
                first = lo // HOP
                a = keep_start // HOP - first
                b = min(em.shape[0], -(-keep_end // HOP) - first, total - first)
                if b > a:
                    out[first + a:first + b] = em[a:b]
            runs.append(out)
    if len(runs) == 1:
        return runs[0]
    return torch.logsumexp(torch.stack(runs), dim=0) - torch.log(torch.tensor(float(len(runs))))


def align_samples(samples, text: str, *, language: Optional[str] = None, device: Optional[str] = None,
                  wildcard: str = "stanza", window_s: float = WINDOW_S, context_s: float = CONTEXT_S,
                  threshold: float = LOW_CONFIDENCE, lead_s: float = 0.0, star_logp: float = STAR_LOGP,
                  max_char_gap_s: float = MAX_CHAR_GAP_S, tilings: int = TILINGS) -> Alignment:
    """Place ``text`` on 16 kHz mono ``samples``."""
    import torchaudio

    lines = prepare_text(text, language)
    if not lines:
        raise AlignError("the text has no Latin letters to align")
    timings: Dict[str, float] = {}
    dev = pick_device(device)
    started = time.time()
    em = emissions(samples, dev, window_s, context_s, tilings)
    timings["emissions"] = round(time.time() - started, 2)

    dictionary = torchaudio.pipelines.MMS_FA.get_dict(star="*")
    logp = em.numpy().copy()  # the tensor was made under inference_mode
    logp[:, dictionary["*"]] = star_logp
    targets, owners = build_targets(lines, dictionary, dictionary["*"], wildcard)
    started = time.time()
    spans = viterbi(logp, targets)
    timings["align"] = round(time.time() - started, 2)
    seconds_per_frame = HOP / SAMPLE_RATE
    return Alignment(
        lines=assemble(lines, spans, owners, seconds_per_frame, threshold, lead_s, max_char_gap_s),
        device=dev, seconds=timings, threshold=threshold, lead_s=lead_s,
    )


def align_file(audio: str, text: str, **kwargs: Any) -> Alignment:
    """``audio`` is anything ffmpeg reads; a vocals stem aligns best."""
    started = time.time()
    samples = load_audio(audio)
    decode = round(time.time() - started, 2)
    result = align_samples(samples, text, **kwargs)
    result.seconds = {"decode": decode, **result.seconds}
    return result


# ----------------------------------------------------------------- lrc


def stamp(seconds: float, brackets: str = "[]") -> str:
    seconds = max(0.0, seconds)
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    if round(rest, 2) >= 60:
        minutes, rest = minutes + 1, 0.0
    return f"{brackets[0]}{minutes:02d}:{rest:05.2f}{brackets[1]}"


def to_lrc(lines: Sequence[Line], *, word_tags: bool = False) -> str:
    """Line-level LRC, in time order. ``word_tags`` adds enhanced ``<mm:ss.xx>``
    word stamps — off by default, because not every reader strips them (KROBI
    Móvil's parser shows them as text)."""
    out = []
    for line in sorted(lines, key=lambda x: x.start):
        if word_tags and line.words:
            body = " ".join(f"{stamp(w.start, '<>')} {w.text}" for w in line.words)
        else:
            body = line.text
        out.append(f"{stamp(line.start)} {body}\n")
    return "".join(out)
