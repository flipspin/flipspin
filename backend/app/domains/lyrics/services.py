"""Collect enabled lyrics sources and rank synced matches before plain lyrics.

Automatic acceptance requires matching identity and duration; weaker results
stay pending. Explicit edits are protected from refetch. Scans and acquisition
completion share one queue and progress tracker; neither changes audio tags.
"""
from __future__ import annotations

import logging
import platform
import threading
from functools import wraps
import time
import uuid
from collections import deque
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from collections.abc import Callable, Sequence

from mutagen import File as AudioFile

from app.config import ConfigManager
from app.infra.changes import Changes
from app.infra.etags import strong_etag
from app.infra import demo_overrides
from app.domains.user_library.acquisition_links import rel_path_for
from app.infra.progress import ProgressTracker
from app.domains.lyrics.models import (
    KIND_INSTRUMENTAL,
    KIND_PLAIN,
    KIND_SYNCED,
    KINDS,
    LyricsCandidate,
    LyricsDocument,
    LyricsQuery,
    LyricsRecord,
    PendingTrack,
    ScanSummary,
    last_timestamp_s,
    lyrics_words,
)
from app.domains.lyrics.jobs import AgentQueue, QueueRow
from app.domains.lyrics.engine import EngineJob, EngineNotReadyError, LyricsEngine
from app.domains.lyrics.repositories import LyricsRepository
from app.domains.metadata.normalization import normalize_key
from app.exceptions import KrobiException
from app.providers.registry import Capability, ProviderKind, ProviderRegistry

#: Progress phase reported per item while a catalog is being asked. The renderer
#: maps it to words; keep it stable.
PHASE_SEARCHING = "lyrics"
#: How many newest pending songs the jobs snapshot names.
PENDING_PREVIEW = 20


class LyricsLockedError(KrobiException):
    """The existing lyric was edited by a person; refuse the automatic overwrite."""

    def __init__(self, message: str):
        super().__init__(message, "LYRICS_LOCKED")


class LyricsSearchUnavailable(RuntimeError):
    """Catalog transport failure, not evidence that lyrics do not exist."""

    def __init__(self, message: str, *, retry_after: int = 0):
        super().__init__(message)
        self.retry_after = retry_after


class LyricsNotFoundError(KrobiException):
    def __init__(self, message: str):
        super().__init__(message, "LYRICS_NOT_FOUND")


@dataclass
class _Batch:
    progress_id: str
    label: str
    total: int
    attempt: int = 1
    done: int = 0
    found: int = 0
    pending: int = 0
    skipped: int = 0
    errors: int = 0
    started_at: float = field(default_factory=time.time)

    def summary(self) -> ScanSummary:
        return ScanSummary(
            progress_id=self.progress_id,
            total=self.total,
            found=self.found,
            pending=self.pending,
            skipped=self.skipped,
            errors=self.errors,
        )


@dataclass(frozen=True)
class _Job:
    rel_path: str
    title: str
    artist: str
    album: str
    duration_s: float | None
    batch: _Batch


def _serialized_lyrics(method):
    """Keep revision checks and writes atomic across HTTP and worker threads."""
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._document_lock:
            return method(self, *args, **kwargs)
    return wrapped


class LyricsService:
    def __init__(
        self,
        *,
        repository: LyricsRepository,
        music_repository,
        registry: ProviderRegistry,
        progress_tracker: ProgressTracker,
        config: ConfigManager,
        logger: logging.Logger,
        sleep: Callable[[float], None] = time.sleep,
        changes: Changes | None = None,
    ):
        self.changes = changes or getattr(music_repository, 'changes', None) or repository.changes
        self.repository = repository
        repository.changes = self.changes
        self.music_repository = music_repository
        self.registry = registry
        self.progress_tracker = progress_tracker
        self.config = config
        self.logger = logger
        self.sleep = sleep
        self._queue: deque[_Job] = deque()
        self._queue_lock = threading.Lock()
        self._document_lock = threading.RLock()
        self._wake = threading.Event()
        self._worker: threading.Thread | None = None
        self._current: _Job | None = None
        self._batches: dict[str, _Batch] = {}
        self._last_summary: ScanSummary | None = None
        self._scan_running = False
        self.scan_job_id: str | None = None
        #: ``rel_path → vocals stem`` of a fresh split, or None. Wired by the
        #: container to the stems service; the aligner then skips demucs.
        self.vocals_lookup: Callable[[str], Path | None] | None = None
        # The Mac engine. Its results come back through save(), so the edited
        # lock and the sidecar rules apply to a transcription like to anything.
        self.engine = LyricsEngine(
            config=config,
            progress_tracker=progress_tracker,
            logger=logger,
            on_result=self._engine_result,
            on_failure=self._engine_failure,
        )
        # The queue a Mac agent drains when this host cannot run the engine
        # itself (an x86 container). Same save path, same lock, same pending.
        self.agent_queue = AgentQueue(
            path=Path(config.lyrics_file).parent / "lyrics-queue.json",
            progress_tracker=progress_tracker,
            logger=logger,
            on_result=self._queue_result,
            on_failure=self._queue_failure,
            duration=self._track_duration,
            changes=self.changes,
        )

    def _track_duration(self, rel_path: str) -> float | None:
        audio = AudioFile(self.repository.audio_path(rel_path))
        return audio.info.length if audio is not None else None

    # ------------------------------------------------------------ providers

    def _providers(self) -> list[tuple[str, Any]]:
        out: list[tuple[str, Any]] = []
        for pid in self.registry.order(ProviderKind.LYRICS):
            entry = self.registry.get(pid)
            if entry is None:
                continue
            descriptor, instance = entry
            if Capability.LYRICS not in descriptor.capabilities:
                continue
            if not hasattr(instance, "search_lyrics"):
                continue
            out.append((pid, instance))
        return out

    def provider_ids(self) -> list[str]:
        return [pid for pid, _ in self._providers()]

    # --------------------------------------------------------------- lookup

    def _query_for(self, rel_path: str) -> LyricsQuery:
        path = self.repository.audio_path(rel_path)
        if not path.exists():
            raise LyricsNotFoundError(f"Track not found: {rel_path}")
        track = self.music_repository.get_track_info(path)
        album = (track.album or path.parent.name or "").strip()
        return LyricsQuery(
            title=(track.title or path.stem).strip(),
            artist=(track.artist or "").strip(),
            album=album,
            duration_s=track.duration,
        )

    @_serialized_lyrics
    def get(self, rel_path: str) -> LyricsDocument | None:
        """The local lyric: sidecar first, then embedded words."""
        record = self.repository.get_record(rel_path)
        if record is None or (record.source == "file" and record.sidecar is None and record.kind != KIND_INSTRUMENTAL):
            if not self.repository.audio_path(rel_path).exists():
                raise LyricsNotFoundError(f"Track not found: {rel_path}")
            record = self.repository.adopt(rel_path, None, None)
            if record is None:
                self.repository.remove_record(rel_path)
                return None
        text = self.repository.read_sidecar(record)
        if not text and record.kind != KIND_INSTRUMENTAL:
            # The sidecar disappeared concurrently (moved, deleted by hand). The
            # index row is now a lie; drop it so the pass can look again.
            self.repository.remove_record(rel_path)
            record = self.repository.adopt(rel_path, None, None)
            if record is None:
                return None
            text = self.repository.read_sidecar(record)
            if not text:
                self.repository.remove_record(rel_path)
                return None
        return LyricsDocument(record=record, text=text)

    def search(self, rel_path: str, *, source: str | None = None, plain_only: bool = False) -> tuple[LyricsQuery, list[LyricsCandidate]]:
        query = self._query_for(rel_path)
        if source:
            entry = self.registry.get(source)
            if entry is None or entry[0].kind != ProviderKind.LYRICS:
                raise ValueError("Unknown lyrics source.")
            status = self.registry.status_of(source)
            if not status.available:
                raise ValueError(f"{entry[0].name}: {status.unavailable_reason}")
            if not status.enabled:
                raise ValueError(f"{entry[0].name} is disabled. Enable it in Settings → Sources.")
        rows = self._collect(query, report_unavailable=True, source=source)
        if plain_only:
            rows = [replace(row, synced_lyrics=None) for row in rows if row.plain_lyrics and not row.instrumental]
        return query, rows

    def _collect(self, query: LyricsQuery, *, report_unavailable: bool = False, source: str | None = None) -> list[LyricsCandidate]:
        candidates: list[LyricsCandidate] = []
        failures = []
        retry_after = 0
        providers = [(pid, provider) for pid, provider in self._providers() if source is None or source == pid]
        if report_unavailable and not providers:
            raise LyricsSearchUnavailable("No lyrics catalogs are enabled. Check Settings → Lyrics.")
        for rank, (pid, provider) in enumerate(providers):
            try:
                rows = provider.search_lyrics(query) or []
            except Exception as e:  # a dead catalog never fails the search
                response = getattr(e, "response", None)
                status = getattr(e, "status_code", None) or getattr(response, "status_code", None)
                reason = f"HTTP {status} {getattr(response, 'reason', '')}".strip() if status else str(e)[:300]
                if status == 429:
                    reason = "HTTP 429 Too Many Requests"
                failures.append(f"{pid.upper() if pid == 'lrclib' else pid}: {reason}")
                retry_after = max(retry_after, getattr(e, "retry_after", 0))
                self.logger.warning("lyrics provider %s failed for %r: %s", pid, query.title, e)
                continue
            for row in rows:
                if query.duration_s is not None:
                    if row.duration_s is not None:
                        row.duration_delta_s = round(row.duration_s - query.duration_s, 2)
                    else:
                        ends = last_timestamp_s(row.synced_lyrics)
                        if ends is not None:
                            row.overrun_s = round(ends - query.duration_s, 2)
                candidates.append(row)
                row._rank = rank
        if report_unavailable and failures and not candidates:
            raise LyricsSearchUnavailable("; ".join(failures), retry_after=retry_after)
        return self.rank(candidates, query)

    @staticmethod
    def rank(candidates: list[LyricsCandidate], query: LyricsQuery) -> list[LyricsCandidate]:
        """Synced and in tolerance first; then plain; then the near misses."""
        wanted = normalize_key(query.artist, query.title)

        def key(c: LyricsCandidate):
            same = normalize_key(c.artist, c.title) == wanted
            known = c.duration_delta_s is not None
            if c.instrumental:
                tier = 4
            elif not c.within_tolerance:
                tier = 3
            elif c.synced_lyrics:
                tier = 0 if known else 1   # a measured match outranks a vacuous one
            else:
                tier = 2
            delta = abs(c.duration_delta_s) if known else 0.0
            return (tier, 0 if same else 1, delta, getattr(c, "_rank", 99))

        return sorted(candidates, key=key)

    @staticmethod
    def defensible(candidate: LyricsCandidate, query: LyricsQuery) -> bool:
        """What the library pass may save without a person looking.

        Duration inside the tolerance *and* the same normalized artist+title
        key. A plain-text provider with no duration passes the first test
        vacuously, so the key test is what stands between the pass and filing
        the wrong song's words.
        """
        if not candidate.within_tolerance:
            return False
        if candidate.kind == KIND_INSTRUMENTAL and candidate.duration_delta_s is None:
            return False
        return normalize_key(candidate.artist, candidate.title) == normalize_key(query.artist, query.title)

    # ----------------------------------------------------------------- save

    @_serialized_lyrics
    def set_offset(self, rel_path: str, offset_ms: int, *, expected_revision: str | None = None) -> LyricsDocument:
        from .offset import set_offset

        current = self.get(rel_path)
        if current is None:
            raise LyricsNotFoundError(f"No lyrics for {rel_path}")
        if expected_revision is not None and current.to_dict()["revision"] != expected_revision:
            raise LyricsLockedError("The lyric changed on the server. Review the local and server versions.")
        if current.record.kind != KIND_SYNCED or abs(offset_ms) > 600000:
            raise ValueError("Offset requires synced lyrics and must be within ±600000 ms")
        self.repository.write_offset(current.record, set_offset(current.text, offset_ms))
        return self.get(rel_path)

    @_serialized_lyrics
    def save(
        self,
        rel_path: str,
        *,
        kind: str,
        text: str,
        source: str,
        provider_ref: str | None = None,
        edited: bool = False,
        force: bool = False,
        title: str | None = None,
        artist: str | None = None,
        expected_revision: str | None = None,
        preserve_timing: bool = False,
        restore_metadata: dict[str, Any] | None = None,
        line_confidence: list[float] | None = None,
        low_lines: list[int] | None = None,
        result: dict[str, Any] | None = None,
    ) -> LyricsDocument:
        if kind not in KINDS:
            raise ValueError(f"Unknown lyrics kind {kind!r}")
        if kind != KIND_INSTRUMENTAL and not text.strip():
            raise ValueError("Lyrics text is empty")
        if expected_revision is not None:
            current = self.get(rel_path)
            revision = current.to_dict()["revision"] if current else ""
            if revision != expected_revision:
                raise LyricsLockedError("The lyric changed on the server. Review the local and server versions.")
        current = self.get(rel_path)
        existing = current.record if current else None
        if existing is not None and existing.edited and not force:
            raise LyricsLockedError(
                "This lyric was edited by hand; choose 'replace' to overwrite it."
            )
        if not self.repository.audio_path(rel_path).exists():
            raise LyricsNotFoundError(f"Track not found: {rel_path}")
        if title is None or artist is None:
            try:
                q = self._query_for(rel_path)
                title, artist = title or q.title, artist or q.artist
            except Exception:  # metadata is a nicety on the row, never a blocker
                pass
        # Demo-video exception: shift a *fetched* lyric (never a hand edit or a
        # transcription of the file itself, which is already in its time).
        if kind == KIND_SYNCED and not preserve_timing and not edited and source != "manual" and not source.startswith("stt") and not (result or {}).get("timingSource"):
            demo = demo_overrides.rule_for(f"{artist or ''} {title or ''}", rel_path)
            if demo and demo.lyrics_offset_s:
                text = demo_overrides.shift_lrc(text, demo.lyrics_offset_s)
                self.logger.warning("demo overrides: shifted lyric of %s by %+.1fs", rel_path, demo.lyrics_offset_s)
        sidecar = self.repository.write_sidecar(rel_path, kind, text)
        record = LyricsRecord(
            rel_path=rel_path,
            kind=kind,
            source=source,
            provider_ref=provider_ref,
            fetched_at=time.time(),
            edited=edited,
            sidecar=sidecar,
            title=title,
            artist=artist,
            result=result,
            line_confidence=line_confidence if kind == KIND_SYNCED else None,
            low_lines=low_lines if kind == KIND_SYNCED else None,
        )
        if restore_metadata is not None:
            record.fetched_at = restore_metadata["fetchedAt"]
            record.title = restore_metadata.get("title")
            record.artist = restore_metadata.get("artist")
            record.line_confidence = restore_metadata.get("lineConfidence") if kind == KIND_SYNCED else None
            record.low_lines = restore_metadata.get("lowLines") if kind == KIND_SYNCED else None
            record.result = restore_metadata.get("result")
        self.repository.put_record(record)
        return self.get(rel_path)

    def save_candidate(self, rel_path: str, candidate: LyricsCandidate, *, force: bool = False) -> LyricsDocument:
        return self.save(
            rel_path,
            kind=candidate.kind,
            text=candidate.text,
            source=candidate.provider,
            provider_ref=candidate.provider_ref,
            force=force,
        )

    @_serialized_lyrics
    def delete(self, rel_path: str, *, expected_revision: str | None = None) -> bool:
        if expected_revision is not None:
            current = self.get(rel_path)
            if (current.to_dict()["revision"] if current else "") != expected_revision:
                raise LyricsLockedError("The lyric changed on the server. Review it before deleting.")
        record = self.repository.remove_record(rel_path)
        self.repository.remove_sidecars(rel_path)
        return record is not None

    def forget_file(self, audio_path: Path) -> None:
        """The song was deleted: its lyric, index row and pending entry go too.

        A deliberate exception to the ``edited`` lock — that lock protects a
        person's correction from a refetch, and there is no song left to
        refetch for. Registered on ``MusicService.deletion_listeners``.
        """
        rel = rel_path_for(self.config.base_music_dir, audio_path)
        if rel is None:
            return
        removed = self.delete(rel)
        self.repository.clear_pending(rel)
        if removed:
            self.logger.info("lyric of deleted track %s removed", rel)

    # ------------------------------------------------------------- the pass

    def _tracks_without_lyrics(self, tracks: set[str] | None = None, allows: Callable[[str], bool] | None = None) -> list[_Job]:
        """Every library track with neither indexed nor local lyrics."""
        base = self.config.base_music_dir
        known = self.repository.all_records()
        jobs: list[_Job] = []
        for album in self.music_repository.scan_albums():
            for track in album.tracks:
                rel = rel_path_for(base, track.path)
                if tracks is not None and rel not in tracks:
                    continue
                if allows is not None and not allows(rel):
                    continue
                if rel is None or rel in known:
                    continue
                if self.repository.adopt(rel, track.title, track.artist) is not None:
                    continue
                jobs.append(
                    _Job(
                        rel_path=rel,
                        title=(track.title or "").strip(),
                        artist=(track.artist or "").strip(),
                        album=(track.album or album.name or "").strip(),
                        duration_s=track.duration,
                        batch=None,  # type: ignore[arg-type]  # set by the caller
                    )
                )
        return jobs

    def start_scan(self, tracks: Sequence[str] | None = None, *, allows: Callable[[str], bool] | None = None) -> ScanSummary | None:
        """Queue every lyric-less track. ``None`` if a pass is already queued."""
        with self._queue_lock:
            if self._scan_running:
                return None
            self._scan_running = True
            self.scan_job_id = f"lyrics-{uuid.uuid4()}"
        try:
            if tracks:
                for rel in tracks:
                    if not self.repository.audio_path(rel).exists():
                        raise LyricsNotFoundError(f"Track not found: {rel}")
            jobs = self._tracks_without_lyrics(set(tracks) if tracks else None, allows)
            return self._enqueue(jobs, label="scan", progress_id=self.scan_job_id)
        except Exception:
            with self._queue_lock:
                self._scan_running = False
            raise

    def _library_rel_paths(self) -> list[str]:
        """Song keys of the published library, rebuilt only when the library area or root changes."""
        root = self.config.base_music_dir
        # The repository chooses published reads with a live watcher, and checks
        # freshness for offline/dead-watcher consumers before consulting the memo.
        albums = self.music_repository.scan_albums()
        key = (root, self.changes.revision('library'))
        cached = getattr(self, '_rel_paths_memo', None)
        if cached and cached[0] == key:
            return cached[1]
        rels = [rel for album in albums for track in album.tracks
                if (rel := rel_path_for(root, track.path)) is not None]
        self._rel_paths_memo = (key, rels)
        return rels

    def states(self, allows: Callable[[str], bool]) -> tuple[dict, str]:
        """Read indexed results and live work without adopting or changing files."""
        records = self.repository.all_records()
        pending = {p.rel_path: p for p in self.repository.pending()}
        live = set(self.agent_queue.waiting_tracks())
        ledger = self.progress_tracker.ledger
        if ledger:
            live.update(ledger.live_lyrics_paths())
        with self._queue_lock:
            live.update(j.rel_path for j in self._queue)
            if self._current and self._current.batch.progress_id in self._batches:
                live.add(self._current.rel_path)
        states = {}
        no_singing = {
            'engine: no singing',
            'engine: No se reconoció voz cantada en el audio; parece instrumental.',
        }
        for rel in self._library_rel_paths():
            if not allows(rel):
                continue
            # Work overlays the saved result so selected pending/plain songs
            # visibly enter "Queued" until the producer reports an outcome.
            if rel in live:
                value = 'queued'
            elif rel in records:
                value = records[rel].kind
            elif rel in pending:
                value = 'instrumental' if pending[rel].reason in no_singing else 'pending'
            else:
                value = 'none'
            states[rel] = value
        counts = {kind: sum(v == kind for v in states.values())
                  for kind in ('synced', 'plain', 'instrumental', 'pending', 'queued', 'none')}
        body = {'states': states, 'counts': counts}
        etag = strong_etag([self.changes.boot_id, [self.changes.revision(area)
                            for area in ('lyrics', 'library', 'jobs')]])
        return body, etag

    def enqueue_files(self, file_paths: Sequence[object]) -> ScanSummary | None:
        """Songs that just landed (any client). Honours the auto-fetch switch."""
        if not getattr(self.config, "lyrics_auto_fetch", False):
            return None
        base = self.config.base_music_dir
        jobs: list[_Job] = []
        seen = set()
        for path in file_paths or ():
            rel = rel_path_for(base, path)
            if rel is None or rel in seen or self.repository.get_record(rel) is not None:
                continue
            seen.add(rel)
            if self.repository.adopt(rel, None, None) is not None:
                continue
            try:
                q = self._query_for(rel)
            except Exception:
                continue
            jobs.append(_Job(rel, q.title, q.artist, q.album, q.duration_s, None))  # type: ignore[arg-type]
        if not jobs:
            return None
        return self._enqueue(jobs, label="acquired")

    def _enqueue(self, jobs: list[_Job], *, label: str, progress_id=None) -> ScanSummary:
        progress_id = progress_id or f"lyrics-{uuid.uuid4()}"
        batch = _Batch(progress_id=progress_id, label=label, total=len(jobs))
        self.progress_tracker.create_progress(progress_id, len(jobs), kind='lyrics-search',
            label=((jobs[0].title or jobs[0].rel_path) if len(jobs) == 1 else f'{len(jobs)} canciones'),
            items=[{'item': f'{j.artist} – {j.title}'.strip(' –') or j.rel_path, 'rel_path': j.rel_path,
                    'detail': {'_retry': {'producer': 'lyrics-search', 'batch_label': label, 'rel_path': j.rel_path,
                               'title': j.title, 'artist': j.artist, 'album': j.album, 'duration_s': j.duration_s}}} for j in jobs])
        batch.attempt = self.progress_tracker.attempt_for(progress_id)
        bound = [
            _Job(j.rel_path, j.title, j.artist, j.album, j.duration_s, batch) for j in jobs
        ]
        with self._queue_lock:
            self._batches[progress_id] = batch
            if label == 'scan':
                self._scan_running = True
                self.scan_job_id = progress_id
            if not bound:
                self._finish_batch(batch)
            else:
                self._queue.extend(bound)
            self._ensure_worker_locked()
        self._wake.set()
        return batch.summary()

    def _ensure_worker_locked(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._run, name="lyrics-worker", daemon=True)
        self._worker.start()

    def _run(self) -> None:
        while True:
            with self._queue_lock:
                job = self._queue.popleft() if self._queue else None
                self._current = job
            if job is None:
                self._wake.clear()
                if not self._wake.wait(timeout=60):
                    with self._queue_lock:
                        if not self._queue:
                            self._current = None
                            self._worker = None
                            return
                continue
            self._process(job)

    def _process(self, job: _Job) -> None:
        batch = job.batch
        item = f"{job.artist} – {job.title}".strip(" –") or job.rel_path
        ledger = self.progress_tracker.ledger
        attempt = batch.attempt
        if ledger and not ledger.running(batch.progress_id, attempt):
            with self._queue_lock:
                batch.done += 1
                if batch.done >= batch.total:
                    if self._batches.get(batch.progress_id) is batch:
                        self._batches.pop(batch.progress_id, None)
                    if batch.label == 'scan':
                        self._scan_running = False
            return
        outcome, reason, detail = 'done', None, {'title': job.title, 'artist': job.artist}
        self.progress_tracker.set_track_phase(batch.progress_id, item, PHASE_SEARCHING)
        try:
            if self.repository.get_record(job.rel_path) is not None or self.repository.adopt(
                job.rel_path, job.title, job.artist,
            ) is not None:
                batch.skipped += 1
                outcome, reason = 'skipped', 'rejected'
            else:
                query = LyricsQuery(job.title, job.artist, job.album, job.duration_s)
                chosen = None
                for candidate in self._collect(query):
                    if self.defensible(candidate, query):
                        chosen = candidate
                        break
                if chosen is not None:
                    self.save_candidate(job.rel_path, chosen)
                    batch.found += 1
                else:
                    self.repository.mark_pending(
                        PendingTrack(job.rel_path, job.title, job.artist, job.album, time.time())
                    )
                    batch.pending += 1
                    outcome, reason = 'failed', 'no-results'
        except LyricsLockedError:
            batch.skipped += 1
            outcome, reason = 'skipped', 'rejected'
        except Exception as e:
            batch.errors += 1
            outcome, reason = 'failed', 'error'
            detail['reason'] = str(e)
            self.logger.warning("lyrics pass failed for %s: %s", job.rel_path, e)
        finally:
            if ledger:
                row = next((i for i in ledger.items(batch.progress_id) if i['rel_path'] == job.rel_path), None)
                if row:
                    ledger.item_transition(batch.progress_id, row['idx'], attempt, outcome, reason=reason, detail=detail)
            batch.done += 1
            if not ledger or ledger.get(batch.progress_id)['attempt'] == attempt:
                self.progress_tracker.update_progress(batch.progress_id, item)
            if batch.done >= batch.total:
                with self._queue_lock:
                    self._finish_batch(batch)

    def _finish_batch(self, batch: _Batch) -> None:
        # Called with _queue_lock held.
        if self.progress_tracker.ledger:
            record = self.progress_tracker.ledger.get(batch.progress_id)
            if not record or record['attempt'] != batch.attempt:
                return
        self.progress_tracker.complete_progress(
            batch.progress_id,
            "done",
            succeeded=batch.found,
            failed=batch.pending + batch.errors,
        )
        self._last_summary = batch.summary()
        self._batches.pop(batch.progress_id, None)
        if batch.label == "scan":
            self._scan_running = False

    # ----------------------------------------------------------------- jobs

    def jobs(self, allows: Callable[[str], bool] | None = None) -> dict[str, Any]:
        """``allows`` narrows the view to one member's songs; the household's passes stay hidden."""
        with self._queue_lock:
            current = self._current
            queued = len(self._queue)
            batches = [b for b in self._batches.values()]
        running = None
        if batches:
            # The oldest live batch is the one the panel names; the rest add up.
            head = min(batches, key=lambda b: b.started_at)
            running = {
                "progressId": head.progress_id,
                "label": head.label,
                "done": head.done,
                "total": head.total,
                "found": head.found,
                "pending": head.pending,
                "item": (f"{current.artist} – {current.title}".strip(" –") if current else None),
            }
        engine = self.engine_status()  # reap first: a lost lease can create a pending row
        pending = self.repository.pending()
        records = self.repository.all_records()
        if allows is not None:
            pending = [p for p in pending if allows(p.rel_path)]
            records = {k: v for k, v in records.items() if allows(k)}
            running, queued = None, 0
        waiting = {p.rel_path: p.tried_at for p in pending}
        for rel_path, created_at in self.agent_queue.waiting_tracks().items():
            if allows is None or allows(rel_path):
                waiting[rel_path] = min(waiting.get(rel_path, created_at), created_at)
        engine["waiting"] = {"count": len(waiting), "oldestAt": min(waiting.values(), default=None)}
        return {
            "autoFetch": bool(getattr(self.config, "lyrics_auto_fetch", False)),
            "providers": self.provider_ids(),
            "running": running,
            "queued": queued,
            "withLyrics": len(records),
            "pendingCount": len(pending),
            "oldestPendingAt": min((p.tried_at for p in pending), default=None),
            "pending": [p.to_dict() for p in pending[:PENDING_PREVIEW]],
            "lastRun": self._last_summary.to_dict() if self._last_summary and allows is None else None,
            # The engine rides along so the sidebar, the modal and Settings poll
            # one URL — the *service* view, with `mode` and the agent queue: the
            # raw engine says "unsupported-platform" on an x86 server even while
            # a Mac is online processing for it.
            "engine": engine,
        }

    def startup(self, delay_s: float = 20.0) -> None:
        """If auto-fetch is on, run a pass once the app has settled."""
        if not getattr(self.config, "lyrics_auto_fetch", False):
            return

        def _later() -> None:
            self.sleep(delay_s)
            try:
                self.start_scan()
            except Exception as e:
                self.logger.warning("startup lyrics pass did not start: %s", e)

        threading.Thread(target=_later, name="lyrics-startup", daemon=True).start()

    # --------------------------------------------------------------- engine

    @property
    def engine_mode(self) -> str:
        """Choose local subprocesses or an outbound helper from explicit placement.

        Auto uses local on macOS arm64 and agent elsewhere; a remote desktop does not
        make the server capable of running its own engine."""
        forced = str(getattr(self.config, "lyrics_engine_mode", "auto") or "auto").lower()
        if forced in ("local", "agent"):
            return forced
        return "local" if platform.system() == "Darwin" and platform.machine().lower() == "arm64" else "agent"

    def engine_status(self) -> dict[str, Any]:
        status = self.engine.status()
        mode = self.engine_mode
        status["mode"] = mode
        queue = self.agent_queue.status()
        status["queue"] = {k: queue[k] for k in ("queued", "leased", "agents", "online", "oldestQueuedAt")}
        status["worker"] = queue["worker"]
        status["helpers"] = queue["helpers"]
        status["waitReason"] = queue["waitReason"]
        status["oldestAt"] = queue["oldestAt"]
        if mode == "agent":
            status["ready"] = queue["online"]
            status["hint"] = "agent-online" if queue["online"] else "agent-needed"
            status["running"] = queue["running"]
        return status

    def _engine_job(self, rel_path: str, *, text: str | None, isolate: bool) -> EngineJob:
        query = self._query_for(rel_path)
        known = text
        if known is None:
            existing = self.repository.get_record(rel_path)
            if existing is not None and existing.kind == KIND_PLAIN:
                # A plain lyric on disk is the text to align — the whole point.
                # Hand-written ones too: aligning keeps every word as typed.
                known = self.repository.read_sidecar(existing) or None
        item = f"{query.artist} – {query.title}".strip(" –") or rel_path
        return EngineJob(
            rel_path=rel_path,
            audio=self.repository.audio_path(rel_path),
            item=item,
            text=known,
            isolate_vocals=isolate,
            vocals=self._vocals_for(rel_path) if known else None,
        )

    def _vocals_for(self, rel_path: str) -> Path | None:
        if self.vocals_lookup is None:
            return None
        try:
            return self.vocals_lookup(rel_path)
        except Exception as e:  # noqa: BLE001 — demucs is the fallback, never a failure
            self.logger.debug("no stems vocals for %s: %s", rel_path, e)
            return None

    def transcribe(self, requests: Sequence[tuple[str, str | None]], *, isolate: bool = True, lane: str | None = None) -> tuple[str, int]:
        """``requests`` are ``(rel_path, text_or_None)``. Returns ``(progress_id, total)``."""
        jobs: list[EngineJob] = []
        seen = set()
        for rel_path, text in requests:
            if rel_path in seen:
                continue
            seen.add(rel_path)
            existing = self.repository.get_record(rel_path)
            original = self.repository.read_sidecar(existing) if existing else None
            same_words = bool(original and text and lyrics_words(original) == lyrics_words(text))
            own_plain = existing is not None and existing.kind == KIND_PLAIN and text is None
            if existing is not None and existing.edited and not (same_words or own_plain):
                continue
            job = self._engine_job(rel_path, text=text, isolate=isolate)
            if same_words or own_plain:
                job.expected_lyric = original
            jobs.append(job)
        if not jobs:
            raise ValueError("Nothing to process: every song is edited by hand or already listed.")
        if self.engine_mode == "agent":
            progress_id = self.agent_queue.enqueue(
                [
                    {
                        "relPath": j.rel_path,
                        "item": j.item,
                        "text": j.text,
                        "expectedLyric": j.expected_lyric,
                        "isolateVocals": j.isolate_vocals,
                        "stemsVocals": j.vocals is not None,
                        'lane': lane or ('now' if len(jobs) == 1 else 'library'),
                    }
                    for j in jobs
                ]
            )
            return progress_id, len(jobs)
        return self.engine.run(jobs), len(jobs)

    def align(self, rel_path: str, *, text: str, source: str, provider_ref: str | None = None,
              edited: bool = False, force: bool = False, expected_revision: str | None = None) -> tuple[str, int]:
        if not text.strip():
            raise ValueError("Lyrics text is empty")
        current = self.get(rel_path)
        revision = current.to_dict()["revision"] if current else ""
        if expected_revision is not None and expected_revision != revision:
            raise LyricsLockedError("The lyric changed on the server.")
        if current and current.record.edited and not force:
            raise LyricsLockedError("This lyric was edited by hand.")
        if not self.engine_status()["ready"]:
            raise EngineNotReadyError("Engine not ready")
        selection = {"source": source, "providerRef": provider_ref, "edited": edited,
                     "force": force, "expectedRevision": revision}
        job = self._engine_job(rel_path, text=text, isolate=True)
        job.selection = selection
        if self.engine_mode == "agent":
            progress_id = self.agent_queue.enqueue([{
                "relPath": rel_path, "item": job.item, "text": text,
                "stemsVocals": job.vocals is not None, "selection": selection,
            }])
            return progress_id, 1
        return self.engine.run([job]), 1

    def cancel_processing(self, progress_id: str) -> bool:
        return self.engine.cancel(progress_id) or self.agent_queue.cancel(progress_id)

    def _queue_result(self, row: QueueRow, lrc: str, source: str, extra: dict[str, Any] | None = None) -> None:
        extra = extra or {}
        result = row.result
        if row.selection is not None:
            helper = next((h for h in self.agent_queue.worker.helpers() if h["id"] == row.leased_by), {})
            result = {**(result or {}), "helperName": helper.get("name")}
        self._save_engine_lrc(
            row.rel_path, lrc, source, extra.get("lineConfidence"), extra.get("lowLines"), row.expected_lyric, result, row.selection
        )

    @_serialized_lyrics
    def _save_engine_lrc(
        self, rel_path: str, lrc: str, source: str, line_confidence: Any = None, low_lines: Any = None,
        expected_lyric: str | None = None, result: dict[str, Any] | None = None,
        selection: dict[str, Any] | None = None,
    ) -> None:
        """Replace timings only while the explicitly aligned lyric is unchanged."""
        if selection is not None:
            self.save(rel_path, kind=KIND_SYNCED, text=lrc, source=selection["source"],
                      provider_ref=selection.get("providerRef"), edited=selection.get("edited", False),
                      force=selection.get("force", False), expected_revision=selection["expectedRevision"],
                      line_confidence=_float_list(line_confidence), low_lines=_int_list(low_lines),
                      result={**(result or {}), "timingSource": source})
            return
        existing = self.repository.get_record(rel_path)
        if expected_lyric is not None and (
            existing is None or self.repository.read_sidecar(existing) != expected_lyric
        ):
            raise LyricsLockedError("The lyric changed while alignment was running.")
        upgrade = bool(existing and existing.edited and expected_lyric is not None)
        self.save(
            rel_path,
            kind=KIND_SYNCED,
            text=lrc,
            source=source,
            provider_ref=None,
            edited=upgrade,
            force=upgrade,
            line_confidence=_float_list(line_confidence),
            low_lines=_int_list(low_lines),
            result=result,
        )
        self.repository.clear_pending(rel_path)

    def _queue_failure(self, row: QueueRow, reason: str) -> None:
        self.logger.warning("lyrics alignment failed for %s: %s", row.rel_path, reason)
        self.progress_tracker.add_failure(row.progress_id, {
            "item": row.item, "index": row.job_idx, "reason": reason, "kind": "error",
        })
        self._engine_failure(EngineJob(row.rel_path, self.repository.audio_path(row.rel_path), row.item), reason)

    def transcribe_pending(self, *, isolate: bool = True) -> tuple[str, int]:
        pending = [(p.rel_path, None) for p in self.repository.pending()]
        if not pending:
            raise ValueError("No pending songs.")
        progress_id, total = self.transcribe(pending, isolate=isolate, lane='library')
        if self.progress_tracker.ledger:
            self.progress_tracker.ledger.configure(progress_id, label=f'Biblioteca · {total} canciones sin letra')
        return progress_id, total

    def _engine_result(self, job: EngineJob, event: dict[str, Any]) -> None:
        lrc_path = Path(str(event.get("lrc") or ""))
        text = lrc_path.read_text(encoding="utf-8") if lrc_path.exists() else ""
        if not text.strip():
            raise ValueError("engine returned an empty lyric")
        self._save_engine_lrc(
            job.rel_path, text, str(event.get("source") or "stt"),
            event.get("lineConfidence"), event.get("lowLines"), job.expected_lyric,
            result={key: event[key] for key in ("accel", "fallbackReason", "gpu") if key in event}, selection=job.selection,
        )

    def _engine_failure(self, job: EngineJob, reason: str) -> None:
        if self.repository.get_record(job.rel_path) is not None:
            return
        query = None
        try:
            query = self._query_for(job.rel_path)
        except Exception:  # noqa: BLE001 — pending row is best effort
            pass
        self.repository.mark_pending(
            PendingTrack(
                job.rel_path,
                query.title if query else job.item,
                query.artist if query else "",
                query.album if query else "",
                time.time(),
                reason=f"engine: {reason}"[:200],
            )
        )


def _float_list(raw: Any) -> list[float] | None:
    if not isinstance(raw, list):
        return None
    try:
        return [round(float(x), 3) for x in raw]
    except (TypeError, ValueError):
        return None


def _int_list(raw: Any) -> list[int] | None:
    if not isinstance(raw, list):
        return None
    try:
        return [int(x) for x in raw]
    except (TypeError, ValueError):
        return None
