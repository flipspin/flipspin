"""Dataclasses for the lyrics domain. No ORM, no I/O.

``LyricsCandidate`` is what a provider answers and what the modal lists;
``LyricsRecord`` is one row of ``~/Krobi/lyrics.json`` — *metadata about* local
lyrics, never the text itself. Embedded words use source ``file`` and no
sidecar. Saved text lives in the sidecar, because the
``.lrc`` is the contract two clients and VLC read; the index only says where it
came from and whether a person has touched it.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any

from .offset import read_offset

_LRC_STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


def last_timestamp_s(lrc: str | None) -> float | None:
    """The last ``[mm:ss.xx]`` in an LRC body — a lower bound on the recording's length.

    LRCLIB rows sometimes carry ``duration: null``; the lyric's own timeline
    still says how long the song *at least* is, which is enough to veto a
    3:16 lyric against a 5:57 file.
    """
    if not lrc:
        return None
    last = None
    for m in _LRC_STAMP.finditer(lrc):
        minutes, seconds, frac = int(m.group(1)), int(m.group(2)), m.group(3)
        value = minutes * 60 + seconds + (int(frac) / (10 ** len(frac)) if frac else 0.0)
        last = value if last is None or value > last else last
    return last


def lyrics_words(text: str) -> str:
    """Untimed words in playback order, including repeated multi-stamp lines."""
    timed = []
    plain = []
    for raw in text.splitlines():
        if re.fullmatch(r"\s*\[(?:ti|ar|al|au|by|re|ve|length|offset):.*\]\s*", raw, re.I):
            continue
        stamps = list(_LRC_STAMP.finditer(raw))
        body = re.sub(r"<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>", "", _LRC_STAMP.sub("", raw)).strip()
        if stamps:
            for stamp in stamps:
                minute, second, fraction = stamp.groups()
                time = int(minute) * 60 + int(second) + (int(fraction) / 10 ** len(fraction) if fraction else 0)
                timed.append((time, body))
        else:
            plain.append(body)
    lines = [body for _, body in sorted(timed, key=lambda entry: entry[0])] if timed else plain
    return "\n".join(line for line in lines if line)

#: Kinds a lyric can be. ``instrumental`` is a real answer (LRCLIB flags it), and
#: recording it stops the library pass from asking for that song forever.
KIND_SYNCED = "synced"
KIND_PLAIN = "plain"
KIND_INSTRUMENTAL = "instrumental"
KINDS = (KIND_SYNCED, KIND_PLAIN, KIND_INSTRUMENTAL)

#: Sidecar extension per kind. Synced → ``.lrc`` (what every player reads);
#: plain → ``.txt`` (an ``.lrc`` with no timestamps is not an LRC file, and a
#: player that finds one shows nothing rather than the words).
SIDECAR_SUFFIX = {KIND_SYNCED: ".lrc", KIND_PLAIN: ".txt"}

#: Seconds of duration difference beyond which a catalog hit is a different
#: recording (the radio edit, the live take). Same number the ownership oracle
#: uses, for the same reason: "same recording" must mean one thing.
DURATION_TOLERANCE_S = 2.0


@dataclass(frozen=True)
class LyricsQuery:
    """Local-file metadata supplied to a lyrics catalog."""

    title: str
    artist: str
    album: str = ""
    duration_s: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "durationSeconds": self.duration_s,
        }


@dataclass
class LyricsCandidate:
    """One answer from one provider.

    ``synced_lyrics`` is LRC text; ``plain_lyrics`` is lines. Either may be
    ``None`` — Genius only ever fills the second. ``duration_delta_s`` is set by
    the service against the query, and is what the modal shows next to each row
    and what the ranking sorts on after "is it synced".
    """

    provider: str
    title: str
    artist: str
    album: str = ""
    duration_s: float | None = None
    synced_lyrics: str | None = None
    plain_lyrics: str | None = None
    instrumental: bool = False
    provider_ref: str | None = None   # e.g. "lrclib:3396226"
    url: str | None = None
    duration_delta_s: float | None = None

    @property
    def kind(self) -> str:
        if self.instrumental:
            return KIND_INSTRUMENTAL
        if self.synced_lyrics:
            return KIND_SYNCED
        return KIND_PLAIN

    @property
    def text(self) -> str:
        return (self.synced_lyrics or self.plain_lyrics or "").strip()

    #: Set by the service when the provider gave no duration but the LRC did:
    #: how far past the local file's end the lyric's last line falls (> 0 means
    #: the lyric outlives the file, so it is a different recording).
    overrun_s: float | None = None

    @property
    def within_tolerance(self) -> bool:
        """Unknown durations pass — unless the lyric's own timeline says otherwise."""
        if self.overrun_s is not None and self.overrun_s > DURATION_TOLERANCE_S:
            return False
        if self.duration_delta_s is None:
            return True
        return abs(self.duration_delta_s) <= DURATION_TOLERANCE_S

    def to_dict(self) -> dict[str, Any]:
        lines = [ln for ln in self.text.splitlines() if ln.strip()]
        return {
            "provider": self.provider,
            "providerRef": self.provider_ref,
            "url": self.url,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "durationSeconds": self.duration_s,
            "durationDeltaSeconds": self.duration_delta_s,
            "overrunSeconds": self.overrun_s,
            "withinTolerance": self.within_tolerance,
            "kind": self.kind,
            "instrumental": self.instrumental,
            "lineCount": len(lines),
            "preview": lines[:3],
            "text": self.text,
        }


@dataclass
class LyricsRecord:
    """One row of the index: where the sidecar for ``rel_path`` came from."""

    rel_path: str
    kind: str
    source: str                      # "lrclib" | "genius" | "file" | "manual" | "stt:…"
    provider_ref: str | None = None
    fetched_at: float = 0.0
    #: A person changed the text. Nothing automatic may overwrite it again.
    edited: bool = False
    sidecar: str | None = None    # sidecar file name, beside the audio
    title: str | None = None
    artist: str | None = None
    #: Aligner scores follow LRC line order. Refetches and explicit edits clear
    #: scores and review markers because they no longer describe the saved text.
    line_confidence: list[float] | None = None
    low_lines: list[int] | None = None
    result: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "relPath": self.rel_path,
            "kind": self.kind,
            "source": self.source,
            "providerRef": self.provider_ref,
            "fetchedAt": self.fetched_at,
            "edited": self.edited,
            "sidecar": self.sidecar,
            "title": self.title,
            "artist": self.artist,
            "lineConfidence": self.line_confidence,
            "lowLines": self.low_lines,
            "result": self.result,
        }

    @classmethod
    def from_dict(cls, rel_path: str, data: dict[str, Any]) -> LyricsRecord:
        return cls(
            rel_path=rel_path,
            kind=str(data.get("kind") or KIND_PLAIN),
            source=str(data.get("source") or "file"),
            provider_ref=data.get("providerRef"),
            fetched_at=float(data.get("fetchedAt") or 0.0),
            edited=bool(data.get("edited", False)),
            sidecar=data.get("sidecar"),
            title=data.get("title"),
            artist=data.get("artist"),
            line_confidence=_floats(data.get("lineConfidence")),
            low_lines=_ints(data.get("lowLines")),
            result=data.get("result"),
        )


def _floats(raw: Any) -> list[float] | None:
    if not isinstance(raw, list):
        return None
    try:
        return [float(x) for x in raw]
    except (TypeError, ValueError):
        return None


def _ints(raw: Any) -> list[int] | None:
    if not isinstance(raw, list):
        return None
    try:
        return [int(x) for x in raw]
    except (TypeError, ValueError):
        return None


@dataclass
class PendingTrack:
    """A song the catalogs did not have. Not an error: a candidate for the Mac."""

    rel_path: str
    title: str
    artist: str
    album: str = ""
    tried_at: float = 0.0
    reason: str = "not-found"

    def to_dict(self) -> dict[str, Any]:
        return {
            "relPath": self.rel_path,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "triedAt": self.tried_at,
            "reason": self.reason,
        }

    @classmethod
    def from_dict(cls, rel_path: str, data: dict[str, Any]) -> PendingTrack:
        return cls(
            rel_path=rel_path,
            title=str(data.get("title") or ""),
            artist=str(data.get("artist") or ""),
            album=str(data.get("album") or ""),
            tried_at=float(data.get("triedAt") or 0.0),
            reason=str(data.get("reason") or "not-found"),
        )


@dataclass
class LyricsDocument:
    """A record plus the text of its sidecar — what ``GET`` answers."""

    record: LyricsRecord
    text: str

    def to_dict(self) -> dict[str, Any]:
        data = self.record.to_dict()
        data["text"] = self.text
        data["revision"] = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        data["offsetMs"] = read_offset(self.text)
        return data


@dataclass
class ScanSummary:
    """What a library pass did. Mirrors ``ProgressState`` counts plus the split."""

    progress_id: str
    total: int
    found: int = 0
    pending: int = 0
    skipped: int = 0
    errors: int = 0
    items: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "progressId": self.progress_id,
            "total": self.total,
            "found": self.found,
            "pending": self.pending,
            "skipped": self.skipped,
            "errors": self.errors,
        }
