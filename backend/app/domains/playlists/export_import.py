"""Resolve, review, and acquire Spotify exports through one process-wide service.

Resolution ids must outlive their starting request. Pass injected collaborators
per call so FastAPI overrides apply instead of being captured at construction.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from mutagen import File as MutagenFile

from app.utils.images import full_size_image_url
from app.infra.progress import ProgressTracker
from app.domains.user_library.acquisition_links import link_results
from app.infra.tasks import spawn_background
from app.domains.downloads.models import PLAIN_EFFECT_TYPE, PLAIN_VOLUME_BOOST_DB
from app.domains.downloads.utils import clean_filename
from app.domains.metadata.matching import DURATION_VETO_S, Confidence
from app.domains.playlists.spotify_export import ExportedTrack

logger = logging.getLogger(__name__)

# How many finished resolutions to keep addressable for their results.
MAX_RETAINED_JOBS = 32


@dataclass
class ResolveJob:
    """One resolution run: its cancel switch, its status, and its results.

    Results live here rather than in the ProgressTracker because the tracker
    carries counts and phases, not payloads. Partial results are readable while
    the job is still running, which matters when the run takes half an hour.
    """

    progress_id: str
    playlist_name: str
    total: int
    cancel: threading.Event = field(default_factory=threading.Event)
    status: str = "in_progress"
    error: str | None = None
    # Appended to from the worker thread, read from the event loop. list.append
    # and list() are atomic under the GIL, which is all the synchronisation a
    # single producer and a snapshotting reader need.
    results: list[dict[str, Any]] = field(default_factory=list)

    @property
    def is_terminal(self) -> bool:
        return self.status != "in_progress"


def progress_labels(tracks: list[ExportedTrack]) -> list[str]:
    """Human-readable, *unique* progress labels, one per track.

    ProgressTracker keys completed items by label and ignores repeats, so two
    tracks with the same artist and title would stall the count one short.
    Playlists repeat songs; the count has to survive that.
    """
    labels: list[str] = []
    seen: dict[str, int] = {}
    for track in tracks:
        base = f"{track.artist} - {track.title}" if track.artist else track.title
        seen[base] = seen.get(base, 0) + 1
        labels.append(base if seen[base] == 1 else f"{base} ({seen[base]})")
    return labels


def group_by_confidence(results: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Group MatchResult dicts into strong / review / rejected buckets."""
    grouped: dict[str, list[dict[str, Any]]] = {c.value: [] for c in Confidence}
    for result in results:
        bucket = str(result.get("confidence") or Confidence.REJECTED.value)
        grouped.setdefault(bucket, []).append(result)
    return grouped


def export_folder_name(playlist_name: str) -> str:
    """The stored playlist name, retained for existing playlist-file naming."""
    return clean_filename(playlist_name.replace(" ", "_")) or "ImportedPlaylists"


def verify_acquired_durations(tracks: list, results: list) -> list[str]:
    """Flag downloaded files whose duration differs from the approved recording.

    Use the matcher's veto threshold but retain the audio: a mismatch suggests
    a wrong recording, not corruption.
    See docs/DEVELOPER_GUIDE.md#recording-resolution.
    """
    expected: dict[tuple, float] = {}
    for t in tracks:
        if t.duration_seconds:
            expected[((t.title or "").lower(), (t.artist or "").lower())] = t.duration_seconds
    if not expected:
        return []

    warnings: list[str] = []
    for r in results:
        if not (getattr(r, "success", False) and getattr(r, "file_path", None)):
            continue
        want = expected.get(((r.title or "").lower(), (r.artist or "").lower()))
        if not want:
            continue
        try:
            audio = MutagenFile(str(r.file_path))
            actual = getattr(getattr(audio, "info", None), "length", None)
        except Exception:  # an unreadable file is a different problem
            continue
        if not actual:
            continue
        if abs(actual - want) > DURATION_VETO_S:
            warnings.append(
                f"{r.title or r.file_path}: got {actual:.0f}s, expected ~{want:.0f}s "
                f"— probably not the recording you approved"
            )

    if warnings:
        logger.warning(
            "Export import: %d of %d acquired files differ from the approved "
            "duration by more than %.0fs", len(warnings), len(results), DURATION_VETO_S,
        )
    return warnings


def _playlist_entry(result) -> dict[str, Any]:
    """One playlist row for a landed song: the file's own tags first.

    Every client draws a playlist row (and finds its cover) from these fields;
    a row without artist and album showed no artist and no cover on the phones.
    """
    path = Path(str(result.file_path))
    tags: dict[str, str] = {}
    try:
        import mutagen

        audio = mutagen.File(str(path), easy=True)
        if audio is not None and audio.tags is not None:
            for key in ("title", "artist", "album"):
                value = audio.tags.get(key)
                if value:
                    tags[key] = str(value[0]).strip()
    except Exception:  # noqa: BLE001 — a tag read never loses the row
        pass
    return {
        "title": tags.get("title") or result.title or path.stem,
        "artist": tags.get("artist") or result.artist or "",
        "album": tags.get("album") or path.parent.name or None,
        "path": str(path),
    }


def save_export_playlist(playlist_service, playlist_name: str, results: list, principal=None) -> None:
    """Persist the tracks that landed as a playlist. Best effort, never raises.

    Mirrors what a URL import does: a download that produced files but no
    playlist would leave the user with loose folders and nothing to play.
    """
    try:
        tracks = [_playlist_entry(r) for r in results if r.success and r.file_path]
        if not tracks:
            return
        playlist_service.save_imported_playlist(
            name=export_folder_name(playlist_name),
            source_url=None,
            tracks=tracks,
            description="Imported from a Spotify data export",
            # The importer owns what it imports. If the name collides with
            # another user's playlist the service refuses rather than replacing
            # it, so the acquired files simply keep no playlist JSON — the
            # warning below is the only trace, which is the right trade against
            # overwriting somebody else's track list.
            principal=principal,
        )
    except Exception as e:
        logger.warning("Could not save playlist JSON for %r: %s", playlist_name, e)


def engine_tracks(refs: list) -> list[dict[str, Any]]:
    """Map approved rows to the engine's name-based track shape.

    Leave track_number unset: playlist order is not release order. Preserve duration
    so video selection can reject live takes and edits of the approved recording.
    """
    return [
        {
            "name": t.title,
            "artist": t.artist or "",
            "album": t.album,
            "album_images": [{"url": full_size_image_url(t.cover_url)}] if t.cover_url else None,
            "provider": t.provider,
            "provider_id": t.provider_id,
            "isrc": t.isrc,
            "recording_mbid": t.mbid or t.recording_mbid,
            "duration_ms": int(t.duration_seconds * 1000) if t.duration_seconds else None,
        }
        for t in refs
    ]


class ExportImportService:
    def __init__(self, logger: logging.Logger | None = None, max_retained_jobs: int = MAX_RETAINED_JOBS, metadata_lookup=None):
        self.logger = logger or logging.getLogger(__name__)
        self._metadata_lookup = metadata_lookup
        self._max_retained_jobs = max_retained_jobs
        self._jobs: dict[str, ResolveJob] = {}
        self._jobs_lock = threading.Lock()

    # ------------------------------------------------------------- the job table

    def register_job(self, job: ResolveJob) -> None:
        """Store a job, evicting the oldest finished ones past the retention cap."""
        with self._jobs_lock:
            self._jobs[job.progress_id] = job
            while len(self._jobs) > self._max_retained_jobs:
                for pid, existing in list(self._jobs.items()):
                    if existing.is_terminal:
                        del self._jobs[pid]
                        break
                else:
                    # Everything still running: keep it all rather than cut a live job.
                    break

    def job(self, progress_id: str) -> ResolveJob | None:
        with self._jobs_lock:
            return self._jobs.get(progress_id)

    # ---------------------------------------------------------------- resolution

    def start_resolution(
        self,
        playlist_name: str,
        tracks: list[ExportedTrack],
        resolution_service,
        progress_tracker: ProgressTracker,
    ) -> ResolveJob:
        """Register a resolution job and run it in the background.

        The progress entry is created synchronously so a client attaching to
        the SSE stream the instant this returns can never race a 404.
        """
        labels = progress_labels(tracks)
        progress_id = str(uuid.uuid4())
        progress_tracker.create_progress(progress_id, len(tracks), kind="match", label=playlist_name, items=[{"item": label} for label in labels])
        job = ResolveJob(progress_id=progress_id, playlist_name=playlist_name, total=len(tracks))
        self.register_job(job)

        # Which track resolve_many is working on. Only the worker thread touches
        # it, through the two hooks resolve_many calls in lock-step: should_cancel
        # before each lookup, progress_callback after it.
        cursor = {"index": 0}

        def _should_cancel() -> bool:
            """Cancel check, doubling as the 'this track is now in flight' signal."""
            if progress_tracker.ledger:
                record = progress_tracker.ledger.get(progress_id)
                if record['state'] not in ('queued', 'running'):
                    job.cancel.set()
                    return True
                progress_tracker.ledger.running(progress_id, record['attempt'])
            if job.cancel.is_set():
                return True
            index = cursor["index"]
            if index < len(labels):
                progress_tracker.set_track_phase(progress_id, labels[index], "resolving")
            return False

        def _on_resolved(completed: int, total: int, result) -> None:
            index = cursor["index"]
            job.results.append(result.to_dict())
            if progress_tracker.ledger and index < len(labels):
                progress_tracker.ledger.outcome(progress_id, labels[index], idx=index,
                    success=result.confidence is not Confidence.REJECTED, reason='rejected',
                    detail={'reason': result.explanation, 'title': result.wanted.title, 'artist': result.wanted.artist})
            if index < len(labels):
                progress_tracker.update_progress(progress_id, labels[index])
            cursor["index"] = index + 1

        async def _run_resolution() -> None:
            try:
                # Provider lookups are blocking HTTP, paced at MusicBrainz's 1 req/s.
                # Keep the whole batch off the event loop.
                results = await asyncio.to_thread(
                    resolution_service.resolve_many,
                    tracks,
                    progress_callback=_on_resolved,
                    should_cancel=_should_cancel,
                )
                # resolve_many returns short when it was cancelled; that is the only
                # way to tell a stopped run from a finished one.
                if len(results) < len(tracks):
                    job.status = "cancelled"
                    logger.info(
                        "Resolution %s cancelled after %d/%d tracks",
                        progress_id, len(results), len(tracks),
                    )
                    progress_tracker.complete_progress(progress_id, "cancelled")
                else:
                    job.status = "done"
                    progress_tracker.complete_progress(
                        progress_id, f"Resolved {len(job.results)}/{job.total} tracks"
                    )
            except Exception as e:
                # Provider/item failures are already degraded to rejected rows. A structural
                # failure still leaves resolved results readable; report the completed count
                # so clients can recover partial work.
                job.status = "failed"
                job.error = f"{e} (failed after {len(job.results)}/{len(tracks)} tracks)"
                logger.error(
                    "Background resolution failed after %d/%d tracks: %s",
                    len(job.results), len(tracks), e,
                )
                # The status stays the bare "failed" the clients switch on; the
                # count goes in `error`, which is the field they actually show.
                progress_tracker.complete_progress(progress_id, "failed")

        spawn_background(_run_resolution())
        return job

    def resolution_snapshot(self, progress_id: str) -> dict[str, Any] | None:
        """A job's results grouped by confidence, or None for an unknown id."""
        job = self.job(progress_id)
        if job is None:
            return None
        results = list(job.results)
        grouped = group_by_confidence(results)
        return {
            "progressId": job.progress_id,
            "playlistName": job.playlist_name,
            "status": job.status,
            "total": job.total,
            "resolved": len(results),
            "counts": {bucket: len(items) for bucket, items in grouped.items()},
            "results": grouped,
            "error": job.error,
        }

    def cancel_resolution(self, progress_id: str) -> dict[str, Any] | None:
        """Ask a running job to stop (a no-op once finished); None if unknown."""
        job = self.job(progress_id)
        if job is None:
            return None
        if not job.is_terminal:
            job.cancel.set()
        return {
            "success": True,
            "progressId": job.progress_id,
            "status": job.status,
            "resolved": len(job.results),
        }

    # -------------------------------------------------------------------- import

    def start_import(
        self,
        playlist_name: str,
        refs: list,
        destination: Path,
        download_service,
        playlist_service,
        progress_tracker: ProgressTracker,
        principal=None,
        user_tracks=None,
    ) -> tuple[str, int]:
        """Queue the approved tracks and save what lands as a playlist.

        Returns ``(progress_id, total)``. The progress entry is registered
        synchronously; ``download_multiple_tracks`` honours an existing entry
        rather than re-creating it, and sets the terminal summary itself.
        """
        # Creation is serialized and refuses every name collision. Re-imports
        # keep their current tracks until save_export_playlist replaces them.
        from app.exceptions import PlaylistError
        try:
            playlist_service.create_playlist(
                export_folder_name(playlist_name),
                description="Imported from a Spotify data export",
                owner_id=getattr(principal, "user_id", None),
            )
        except PlaylistError:
            pass
        tracks_data = engine_tracks(refs)
        progress_id = str(uuid.uuid4())
        progress_tracker.create_progress(progress_id, len(tracks_data), kind="import", label=playlist_name, deduplicate_items=False,
                                         items=[{'item': t['name']} for t in tracks_data])
        from app.infra.job_requests import record_call
        record_call(progress_tracker, progress_id, 'download_spotify_playlist', after={'mode': 'export', 'name': playlist_name}, tracks=tracks_data,
                    destination=destination, normalize=False, effect_type=PLAIN_EFFECT_TYPE,
                    volume_boost=PLAIN_VOLUME_BOOST_DB)

        async def _run_import() -> None:
            try:
                if self._metadata_lookup:
                    try:
                        from app.domains.metadata.import_enrichment import enrich_tracks
                        lookup = self._metadata_lookup()
                        if lookup:
                            await asyncio.to_thread(enrich_tracks, tracks_data, lookup)
                            record_call(progress_tracker, progress_id, 'download_spotify_playlist',
                                        after={'mode': 'export', 'name': playlist_name}, tracks=tracks_data,
                                        destination=destination, normalize=False, effect_type=PLAIN_EFFECT_TYPE,
                                        volume_boost=PLAIN_VOLUME_BOOST_DB)
                    except Exception:
                        logger.info("Export metadata lookup skipped", exc_info=True)
                results = await download_service.download_spotify_playlist(
                    tracks=tracks_data,
                    destination=destination,
                    normalize=False,
                    effect_type=PLAIN_EFFECT_TYPE,
                    volume_boost=PLAIN_VOLUME_BOOST_DB,
                    progress_id=progress_id,
                )
                link_results(user_tracks, principal, download_service.config.base_music_dir, results)
                # Checked before the playlist is written, so a suspect file is
                # flagged even if saving the playlist later fails.
                for warning in verify_acquired_durations(refs, results):
                    logger.warning("Export import mismatch — %s", warning)
                save_export_playlist(playlist_service, playlist_name, results, principal)
            except Exception as e:
                # Per-track failures are already swallowed and counted downstream;
                # this catches the earlier ones so the stream terminates instead of
                # hanging forever.
                logger.error("Background export import failed: %s", e)
                progress_tracker.complete_progress(progress_id, "failed")

        spawn_background(_run_import())
        return progress_id, len(tracks_data)
