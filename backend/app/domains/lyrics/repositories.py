"""Keep durable lyrics beside audio and provenance in a separate index.

Embedded lyrics stay in the audio until explicitly saved as sidecars. Atomic
writes and an RLock protect concurrent routes and scans. Read the music root
at call time so library relocation takes effect.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

from app.infra.changes import Changes
from app.infra.files import write_json_atomic, write_text_atomic
from app.config import ConfigManager
from app.domains.lyrics.models import (
    KIND_INSTRUMENTAL,
    KIND_PLAIN,
    KIND_SYNCED,
    SIDECAR_SUFFIX,
    LyricsRecord,
    PendingTrack,
)
from app.domains.lyrics.embedded import read_embedded
from app.utils.library_paths import resolve_track

INDEX_VERSION = 1

#: Recognized sidecars on disk when nothing in the index claims them —
#: a library that already had ``.lrc`` files from another tool is adopted, not
#: re-fetched. Order is preference when both exist.
KNOWN_SIDECARS: tuple[tuple[str, str], ...] = ((".lrc", KIND_SYNCED), (".txt", KIND_PLAIN))


def split_rel_path(rel_path: str) -> tuple[str, str]:
    album, _, file_name = rel_path.partition("/")
    return album, file_name


class LyricsRepository:
    def __init__(self, config: ConfigManager, logger: logging.Logger, *, changes: Changes | None = None):
        self.changes = changes or Changes()
        self.config = config
        self.logger = logger
        self._lock = threading.RLock()
        self._loaded_from: Path | None = None
        self._entries: dict[str, LyricsRecord] = {}
        self._pending: dict[str, PendingTrack] = {}

    # ------------------------------------------------------------- locations

    @property
    def index_path(self) -> Path:
        return Path(self.config.lyrics_file)

    def audio_path(self, rel_path: str) -> Path:
        """The audio file for a ``<albumDir>/<fileName>`` key, containment-checked."""
        album, file_name = split_rel_path(rel_path)
        return resolve_track(self.config.base_music_dir, album, file_name)

    def sidecar_path(self, rel_path: str, kind: str) -> Path:
        audio = self.audio_path(rel_path)
        suffix = SIDECAR_SUFFIX.get(kind)
        if suffix is None:
            raise ValueError(f"kind {kind!r} has no sidecar")
        return audio.with_suffix(suffix)

    # ----------------------------------------------------------------- index

    def _ensure_loaded(self) -> None:
        path = self.index_path
        if self._loaded_from == path:
            return
        entries: dict[str, LyricsRecord] = {}
        pending: dict[str, PendingTrack] = {}
        try:
            if path.exists():
                with open(path, encoding="utf-8") as fh:
                    raw = json.load(fh)
                for rel, data in (raw.get("entries") or {}).items():
                    if isinstance(data, dict):
                        entries[rel] = LyricsRecord.from_dict(rel, data)
                for rel, data in (raw.get("pending") or {}).items():
                    if isinstance(data, dict):
                        pending[rel] = PendingTrack.from_dict(rel, data)
        except (OSError, ValueError) as e:
            # A settings-grade file is not worth taking lyrics down for: start
            # empty, log it, and the next save rewrites a valid one.
            self.logger.warning("lyrics index %s unreadable (%s); starting empty", path, e)
        self._entries = entries
        self._pending = pending
        self._loaded_from = path

    def _save_locked(self) -> None:
        path = self.index_path
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": INDEX_VERSION,
            "entries": {rel: rec.to_dict() for rel, rec in self._entries.items()},
            "pending": {rel: p.to_dict() for rel, p in self._pending.items()},
        }
        for row in payload["entries"].values():
            row.pop("relPath", None)
        for row in payload["pending"].values():
            row.pop("relPath", None)
        write_json_atomic(path, payload)
        self.changes.bump('lyrics')

    def get_record(self, rel_path: str) -> LyricsRecord | None:
        with self._lock:
            self._ensure_loaded()
            return self._entries.get(rel_path)

    def all_records(self) -> dict[str, LyricsRecord]:
        with self._lock:
            self._ensure_loaded()
            return dict(self._entries)

    def put_record(self, record: LyricsRecord) -> None:
        with self._lock:
            self._ensure_loaded()
            self._entries[record.rel_path] = record
            self._pending.pop(record.rel_path, None)
            self._save_locked()

    def remove_record(self, rel_path: str) -> LyricsRecord | None:
        with self._lock:
            self._ensure_loaded()
            record = self._entries.pop(rel_path, None)
            if record is not None:
                self._save_locked()
            return record

    # --------------------------------------------------------------- pending

    def pending(self) -> list[PendingTrack]:
        with self._lock:
            self._ensure_loaded()
            return sorted(self._pending.values(), key=lambda p: p.tried_at, reverse=True)

    def mark_pending(self, track: PendingTrack) -> None:
        with self._lock:
            self._ensure_loaded()
            if track.rel_path in self._entries:
                return
            self._pending[track.rel_path] = track
            self._save_locked()

    def clear_pending(self, rel_path: str) -> None:
        with self._lock:
            self._ensure_loaded()
            if self._pending.pop(rel_path, None) is not None:
                self._save_locked()

    # -------------------------------------------------------------- sidecars

    def read_sidecar(self, record: LyricsRecord) -> str:
        if record.source == "file" and record.sidecar is None and record.kind != KIND_INSTRUMENTAL:
            embedded = read_embedded(self.audio_path(record.rel_path))
            return embedded[1] if embedded is not None else ""
        if record.kind == KIND_INSTRUMENTAL or not record.sidecar:
            return ""
        # Beside the audio, wherever it is: a song in a disc folder keeps
        # its sidecar there too, which the album key alone would miss.
        path = self.audio_path(record.rel_path).with_name(record.sidecar)
        try:
            with path.open(encoding="utf-8", newline="") as stream:
                return stream.read()
        except FileNotFoundError:
            return ""
        except UnicodeDecodeError:
            return path.read_text(encoding="latin-1", errors="replace")

    def write_offset(self, record: LyricsRecord, text: str) -> None:
        """Only replace the existing sidecar; never publish or rebuild index metadata."""
        target = self.audio_path(record.rel_path).with_name(record.sidecar)
        write_text_atomic(target, text)
        self.changes.bump('lyrics')

    def write_sidecar(self, rel_path: str, kind: str, text: str) -> str | None:
        """Write the text beside the audio. Returns the sidecar's file name.

        Staged then renamed, so a reader never sees half a lyric. Writing a
        synced lyric removes a stale plain one and vice versa: two sidecars for
        one song is how a player shows the wrong one.
        """
        if kind == KIND_INSTRUMENTAL:
            self._remove_sidecars(rel_path)
            return None
        target = self.sidecar_path(rel_path, kind)
        target.parent.mkdir(parents=True, exist_ok=True)
        write_text_atomic(target, text.rstrip("\n") + "\n")
        self.changes.bump('lyrics')
        other_kind = KIND_PLAIN if kind == KIND_SYNCED else KIND_SYNCED
        other = self.sidecar_path(rel_path, other_kind)
        if other.exists():
            try:
                other.unlink()
            except OSError as e:
                self.logger.warning("could not remove stale sidecar %s: %s", other, e)
        return target.name

    def _remove_sidecars(self, rel_path: str) -> None:
        for kind in (KIND_SYNCED, KIND_PLAIN):
            path = self.sidecar_path(rel_path, kind)
            if path.exists():
                try:
                    path.unlink()
                    self.changes.bump('lyrics')
                except OSError as e:
                    self.logger.warning("could not remove sidecar %s: %s", path, e)

    def remove_sidecars(self, rel_path: str) -> None:
        self._remove_sidecars(rel_path)

    def find_unindexed_sidecar(self, rel_path: str) -> tuple[str, str] | None:
        """A sidecar on disk that the index does not know about: ``(name, kind)``.

        This is how a library that already had ``.lrc`` files — from another
        tool, or from a phone that wrote them — is adopted instead of refetched.
        """
        audio = self.audio_path(rel_path)
        for suffix, kind in KNOWN_SIDECARS:
            candidate = audio.with_suffix(suffix)
            if candidate.exists() and candidate.is_file():
                return candidate.name, kind
        return None

    def adopt(self, rel_path: str, title: str | None, artist: str | None) -> LyricsRecord | None:
        found = self.find_unindexed_sidecar(rel_path)
        if found is None:
            embedded = read_embedded(self.audio_path(rel_path))
            if embedded is None:
                return None
            kind, _ = embedded
            name = None
        else:
            name, kind = found
        # Parsing a file can overlap an explicit save. Check and publish under
        # the same lock so local adoption cannot clear the saved provenance or
        # the edited lock that arrived while the file was being read.
        with self._lock:
            existing = self.get_record(rel_path)
            if existing is not None:
                if existing.edited or existing.source != "file":
                    return existing
                if existing.sidecar == name and existing.kind == kind:
                    return existing
            record = LyricsRecord(
                rel_path=rel_path,
                kind=kind,
                source="file",
                fetched_at=time.time(),
                sidecar=name,
                title=title,
                artist=artist,
            )
            self.put_record(record)
            return record
