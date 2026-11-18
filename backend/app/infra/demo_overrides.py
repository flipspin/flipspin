"""Apply optional demo acquisition rules from KROBI_DEMO_OVERRIDES.

Rules match normalized artist/title substrings, trim audio starts, and shift
fetched synced lyrics without touching explicit edits. Negative lyric lines
are dropped. Log each rule at WARNING so modified audio is traceable.
See docs/CONFIGURATION.md for configuration.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("app.infra.demo_overrides")

ENV_VAR = "KROBI_DEMO_OVERRIDES"

#: How far in the first surviving line must start before the line the trim cut
#: into is kept at zero. See ``shift_lrc``.
_CUT_LINE_GAP_S = 1.0

_STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


@dataclass(frozen=True)
class DemoRule:
    match: str
    trim_start_s: float = 0.0
    lyrics_offset_s: float = 0.0


def _fold(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def load_rules() -> list[DemoRule]:
    """Read the rule file on every call — editing it between takes needs no restart."""
    path = os.environ.get(ENV_VAR, "").strip()
    if not path:
        return []
    try:
        raw = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.warning("demo overrides: could not read %s: %s", path, e)
        return []
    rules = []
    for item in raw if isinstance(raw, list) else []:
        try:
            rules.append(DemoRule(
                match=_fold(str(item["match"])),
                trim_start_s=float(item.get("trim_start_s", 0) or 0),
                lyrics_offset_s=float(item.get("lyrics_offset_s", 0) or 0),
            ))
        except (KeyError, TypeError, ValueError):
            logger.warning("demo overrides: skipping malformed rule %r", item)
    return [r for r in rules if r.match]


def rule_for(*texts: str | None) -> DemoRule | None:
    """The first rule whose ``match`` appears in any of ``texts`` (folded)."""
    haystacks = [_fold(t) for t in texts if t]
    for rule in load_rules():
        if any(rule.match in h for h in haystacks):
            return rule
    return None


def trim_head(file_path: Path, seconds: float, ffmpeg: str = "ffmpeg") -> bool:
    """Cut at a packet boundary, preserving the source audio without an encode."""
    if seconds <= 0:
        return True
    tmp = file_path.with_name(f".trim-{file_path.name}")
    cmd = [ffmpeg, "-y", "-loglevel", "error", "-ss", f"{seconds:.3f}", "-i", str(file_path),
           "-map", "0:a", "-map_metadata", "0", "-c:a", "copy", "--", str(tmp)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        os.replace(tmp, file_path)
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning("demo overrides: trim of %s failed: %s", file_path.name, e)
        tmp.unlink(missing_ok=True)
        return False
    logger.warning("demo overrides: trimmed first %.1fs off %s", seconds, file_path.name)
    return True


def shift_lrc(text: str, offset_s: float) -> str:
    """Shift every ``[mm:ss.xx]`` stamp by ``offset_s``.

    Lines pushed before zero are dropped — except the last of them when the
    first surviving line starts more than ``_CUT_LINE_GAP_S`` in: the trim cut
    into that line and it is still being sung, so it is kept at
    ``[00:00.00]`` (Technologic cut at 19 s lands 0.11 s into "Surf it,
    scroll it…", and dropping it left two blank seconds). A shorter gap means
    the lyric was nudged later than the cut and the pre-zero line is not in
    the audio at all; showing it would only flash a line nobody hears.
    """
    if not offset_s:
        return text
    out = []
    cut_line: tuple[float, str] | None = None  # (shifted time, body) of the latest pre-zero line
    first_timed = None  # index in `out` where the first surviving timed line went
    for line in text.splitlines():
        stamps = list(_STAMP.finditer(line))
        if not stamps:
            out.append(line)  # metadata tags ([ar:], [ti:]) and blank lines
            continue
        body = _STAMP.sub("", line)
        kept = []
        for m in stamps:
            frac = m.group(3)
            t = int(m.group(1)) * 60 + int(m.group(2)) + (int(frac) / 10 ** len(frac) if frac else 0.0)
            t += offset_s
            if t >= 0:
                cs = int(round(t * 100))
                kept.append(f"[{cs // 6000:02d}:{(cs // 100) % 60:02d}.{cs % 100:02d}]")
            elif body.strip() and (cut_line is None or t > cut_line[0]):
                cut_line = (t, body)
        if kept:
            if first_timed is None:
                first_timed = len(out)
            out.append("".join(kept) + body)
    if cut_line is not None:
        first = _STAMP.match(out[first_timed]) if first_timed is not None else None
        first_s = int(first.group(1)) * 60 + int(first.group(2)) + float(f"0.{first.group(3) or 0}") if first else None
        if first_s is None or first_s > _CUT_LINE_GAP_S:
            out.insert(len(out) if first_timed is None else first_timed, "[00:00.00]" + cut_line[1])
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")
