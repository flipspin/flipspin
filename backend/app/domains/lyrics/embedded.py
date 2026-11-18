"""Read embedded words without changing audio tags or creating sidecars."""
import re
from pathlib import Path

from mutagen import File as MutagenFile, MutagenError
from mutagen.id3 import ID3

from app.domains.lyrics.models import KIND_PLAIN, KIND_SYNCED

_STAMP = re.compile(r"\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]")


def _sylt(frame, info) -> str:
    # ID3 supports MPEG-frame counts as well as milliseconds. MPEG-2/2.5
    # layer III uses 576 samples/frame; layer I 384, other layers 1152.
    factor = 1.0
    if frame.format == 1:
        rate = getattr(info, "sample_rate", 0)
        if not rate:
            return ""
        layer = getattr(info, "layer", 3)
        samples = 384 if layer == 1 else 576 if layer == 3 and getattr(info, "version", 1) != 1 else 1152
        factor = samples * 1000 / rate
    elif frame.format != 2:
        return ""
    lines = []
    # SYLT may timestamp whole lines or individual syllables. With explicit
    # line breaks, join the fragments and retain the first syllable's time.
    fragments = any("\n" in text or "\r" in text for text, _ in frame.text)
    current, start = "", 0
    for text, stamp in frame.text:
        milliseconds = round(stamp * factor)
        if milliseconds < 0:
            continue
        parts = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        for index, part in enumerate(parts):
            if index:
                if current.strip():
                    lines.append((start, current.strip()))
                current = ""
            if not current:
                start = milliseconds
            current += part
        if not fragments and current.strip():
            lines.append((start, current.strip()))
            current = ""
    if current.strip():
        lines.append((start, current.strip()))
    result = []
    for milliseconds, text in lines:
        minutes, remainder = divmod(milliseconds, 60000)
        seconds, fraction = divmod(remainder, 1000)
        result.append(f"[{minutes:02d}:{seconds:02d}.{fraction:03d}]{text}")
    return "\n".join(result)


def read_embedded(path: Path) -> tuple[str, str] | None:
    """Return (kind, text); synced ID3 wins over USLT when both are present."""
    try:
        audio = MutagenFile(path)
        if audio is None or audio.tags is None:
            return None
        tags = audio.tags
        if isinstance(tags, ID3):
            for frame in tags.getall("SYLT"):
                if frame.type not in (0, 1):
                    continue
                text = _sylt(frame, audio.info)
                if text:
                    return KIND_SYNCED, text
            for frame in tags.getall("USLT"):
                if frame.text.strip():
                    return KIND_PLAIN, frame.text.strip()
        else:
            # Iterate actual keys: Vorbis rejects non-ASCII lookups such as ©lyr.
            for wanted in ("©lyr", "lyrics", "unsyncedlyrics"):
                for key in tags.keys():
                    if key.lower() != wanted:
                        continue
                    for value in tags[key]:
                        if isinstance(value, str) and value.strip():
                            text = value.strip()
                            return (KIND_SYNCED if _STAMP.search(text) else KIND_PLAIN), text
    except (OSError, ValueError, MutagenError):
        return None
    return None
