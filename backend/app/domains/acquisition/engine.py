"""Core download engine - unified download logic."""
import logging
import asyncio
import shutil
import json
from pathlib import Path
from typing import NamedTuple
from collections.abc import Callable
import uuid
from collections import OrderedDict
from dataclasses import replace

from app.infra.capacity import capacity_job, capacity_track, _job_item
from app.config import ConfigManager
from app.infra import demo_overrides
from app.infra.files import PRIVATE, write_json_atomic
from app.exceptions import SourceFailure, FailureKind
from app.infra.progress import ProgressTracker, progress_principal
from app.infra.identity import is_real_user
from app.utils.library_paths import rel_path_for
from app.utils.path_safety import safe_open_path
from app.infra.media_requests import (
    DownloadResult,
    TrackDownloadRequest
)
from app.domains.acquisition.provider import (
    DownloadRepository, _summarise_source_output, source_download_context, source_download_track,
)
from app.domains.acquisition.audio import prepare_m4a, receipt
from app.domains.acquisition.matching import ranked_alternates, select_video, split_query
from app.domains.metadata.matching import WantedTrack
from app.domains.metadata.repositories import MetadataRepository, GeniusRepository
from app.domains.music.public import AudioMetadata

# Phase labels reported as a track moves through the pipeline. The frontend renders
# these (and the optional download percent) so the user sees "downloading 47%"
# rather than only "3 of 10 done". Kept as constants so producers and tests agree.
PHASE_SEARCHING = "searching"
PHASE_DOWNLOADING = "downloading"
PHASE_NORMALIZING = "normalizing"
PHASE_TAGGING = "tagging"
PHASE_EMBEDDING_COVER = "embedding_cover"

# Callback a producer passes to report a track's phase + optional 0-100 percent.
PhaseCallback = Callable[[str, float | None], None]


class ResolvedVideo(NamedTuple):
    """A resolved source URL, or nothing plus why there is nothing.

    The reason travels with the result because refusing to download is now a
    normal outcome (see `matching.select_video`). A refusal reason must
    reach the caller so the missing track can be resolved.
    """

    url: str | None
    reason: str = ""
    # "no-results" or "rejected" when url is None — see DownloadResult.failure_kind.
    kind: str = ""
    decision: str = "REVIEW"
    # Further acceptable candidates, best first, tried in the same fetch attempt
    # when the chosen one turns out to be gone (see `matching.ranked_alternates`).
    alternates: tuple[str, ...] = ()


# Failed requests kept for a person-driven retry, oldest dropped first. Memory
# only, like ProgressTracker: a restart forgets both, so a retry against a job
# from before it is a 404 the client explains.
_MAX_RETAINED_FAILURES = 500


def alternative_queries(request: TrackDownloadRequest) -> list[str]:
    """Offer alternate search wording for a person to choose after a failed search.

    Anonymous source search can return no results for an exact string while
    shorter or expanded queries work. Change words rather than capitalization.
    """
    title = (request.metadata.title or "").strip()
    artist = (request.metadata.artist or "").strip()
    original = (request.search_query or "").strip()
    options = [original]
    if title and artist:
        first_word = artist.split()[0]
        options += [
            f"{title} {artist} lyrics",
            f"{artist} {title} audio",
            f"{title} {first_word}" if first_word != artist else "",
            title,
        ]
    seen: set[str] = set()
    unique = []
    for option in options:
        if option and option not in seen:
            seen.add(option)
            unique.append(option)
    return unique


def _wanted_from_request(request: TrackDownloadRequest) -> WantedTrack:
    """Restate the request in the matcher's vocabulary.

    Most callers (Spotify, Genius) attach structured metadata. A bare
    `/download-search` does not, so the query is read with the same
    "Artist - Title" convention source titles use; failing that it stays one
    free-text string, which `select_video` compares differently on purpose.
    """
    if request.metadata.title:
        return WantedTrack(
            title=request.metadata.title,
            artist=request.metadata.artist,
            album=request.metadata.album,
            duration_s=request.duration_s,
        )

    artist, title = split_query(request.search_query or "")
    return WantedTrack(
        title=title,
        artist=request.metadata.artist or artist,
        album=request.metadata.album,
        duration_s=request.duration_s,
    )


def _source_wanted(request):
    wanted = _wanted_from_request(request)
    return {k: v for k, v in {'title': wanted.title, 'artist': wanted.artist or '', 'album': wanted.album,
                             'duration': wanted.duration_s, 'isrc': request.metadata.isrc}.items() if v is not None}


class DownloadEngine:
    """Core download engine with unified download logic."""
    
    def __init__(
        self,
        download_repo: DownloadRepository,
        metadata_repo: MetadataRepository,
        genius_repo: GeniusRepository,
        progress_tracker: ProgressTracker,
        config: ConfigManager,
        logger: logging.Logger,
        ownership=None,
    ):
        """Initialize download engine."""
        self.download_repo = download_repo
        self.metadata_repo = metadata_repo
        self.genius_repo = genius_repo
        self.progress_tracker = progress_tracker
        self.config = config
        self.logger = logger
        self.ownership = ownership
        self.acquisition = None
        # Called after every batch with the paths that landed. The lyrics
        # worker hangs off this so any acquisition, from any client, can be
        # followed by a catalog lookup — the engine stays ignorant of lyrics,
        # and a listener that raises never fails a download.
        self.completion_listeners: list[Callable[[list[Path]], object]] = []
        # (progress_id, index) -> the request that failed, for `retry_request`.
        self._failed_requests: OrderedDict[tuple[str, int], TrackDownloadRequest] = OrderedDict()

    def _remember_failure(
        self, progress_id: str, index: int, request: TrackDownloadRequest, result: DownloadResult
    ) -> None:
        index = _job_item.get() if _job_item.get() is not None else index
        self._failed_requests[(progress_id, index)] = request
        while len(self._failed_requests) > _MAX_RETAINED_FAILURES:
            self._failed_requests.popitem(last=False)
        self.progress_tracker.add_failure(progress_id, {
            "index": index,
            "item": request.metadata.title or request.search_query or "Unknown Track",
            "title": request.metadata.title,
            "artist": request.metadata.artist,
            "album": request.metadata.album,
            "durationS": request.duration_s,
            "query": request.search_query,
            "kind": result.failure_kind or "error",
            "reason": result.error,
            "suggestions": alternative_queries(request),
            "retriedAs": None,
        })

    def retry_request(
        self, progress_id: str, index: int, youtube_url: str
    ) -> TrackDownloadRequest | None:
        """The failed request, pointed at the video the person picked.

        None when the engine no longer holds it (a restart, or evicted).
        """
        request = self._failed_requests.get((progress_id, index))
        if request is None and getattr(self.progress_tracker, 'ledger', None):
            from app.infra.job_requests import decode_request
            item = next((i for i in self.progress_tracker.ledger.items(progress_id) if i['idx'] == index), None)
            payload = item['detail'].get('_retry', {}) if item else {}
            if payload.get('producer') == 'download':
                request = decode_request(payload['request'])
        if request is None:
            return None
        return replace(request, search_query=None, youtube_url=youtube_url)
    
    @capacity_job
    @capacity_track
    async def download_single_track(
        self,
        request: TrackDownloadRequest,
        progress_cb: PhaseCallback | None = None,
    ) -> DownloadResult:
        """Acquire and tag one track in staging, then publish with one rename.

        The optional progress callback receives (phase, percent); percent is set only
        during download. See docs/DEVELOPER_GUIDE.md#spotify-export-import.
        """
        if self.acquisition is not None and not {'download_single_track', '_build_in_staging'}.intersection(self.__dict__):
            return (await self.acquisition.legacy([request]))[0]
        self.logger.info("Starting unified track download")

        def phase(name: str, percent: float | None = None) -> None:
            if progress_cb is not None:
                progress_cb(name, percent)

        invalid = self._invalid_request_result(request)
        if invalid is not None:
            return invalid

        principal = progress_principal.get()
        if is_real_user(principal) and principal.role == "member":
            existing = await asyncio.to_thread(self._existing_member_track, request)
            if existing is not None:
                result = self._success_result(existing, request)
                result.already_present = True
                return result
            # A root-level file has no album/file identity to link or serve.
            if await asyncio.to_thread(request.destination.resolve) == await asyncio.to_thread(Path(self.config.base_music_dir).resolve):
                request = replace(request, destination=request.destination / "Singles")

        phase(PHASE_SEARCHING)
        resolved = await self._resolve_source_url(request)
        if not resolved.url:
            return self._unresolved_result(resolved)

        filename = request.get_filename()

        # Stage outside the library so scans and media responses cannot expose a
        # growing file. Publish the complete result with one rename; otherwise a
        # client can cache truncated audio under a valid Content-Length.
        staging = self._staging_dir(request.destination)
        try:
            outcome = await self._build_in_staging(
                request,
                youtube_url=resolved.url,
                filename=filename,
                staging=staging,
                phase=phase,
                percent_cb=(lambda pct: phase(PHASE_DOWNLOADING, pct)) if progress_cb else None,
            )
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        if isinstance(outcome, DownloadResult):
            return outcome
        return self._success_result(outcome, request)

    def _existing_member_track(self, request: TrackDownloadRequest) -> Path | None:
        """Reuse the catalog ownership oracle; a hit has the normal success shape."""
        wanted = _wanted_from_request(request)
        if self.ownership is not None and wanted.title:
            try:
                verdict = self.ownership.lookup(wanted.artist, wanted.title, wanted.duration_s)
                if verdict.owned and verdict.match:
                    path = safe_open_path(self.config.base_music_dir, Path(verdict.match.path))
                    if path.is_file() and rel_path_for(self.config.base_music_dir, path):
                        return path
                # Do not override a duration veto with a filename match.
                if verdict.near_match:
                    return None
            except Exception:
                self.logger.debug("Member acquisition lookup unavailable", exc_info=True)
        # Direct URLs may carry only a filename, with no catalog identity.
        if request.filename or request.metadata.title:
            destination = request.destination
            if destination.resolve() == Path(self.config.base_music_dir).resolve():
                destination = destination / "Singles"
            try:
                for extension in ('.m4a', '.mp3', '.flac', '.ogg', '.opus', '.wav', '.aac', '.aiff', '.aif', '.wma'):
                    candidate = destination / f"{request.get_filename()}{extension}"
                    if candidate.is_file():
                        path = safe_open_path(self.config.base_music_dir, candidate)
                        if rel_path_for(self.config.base_music_dir, path):
                            return path
            except Exception:
                self.logger.debug("Member acquisition target unavailable", exc_info=True)
        return None

    def _invalid_request_result(self, request: TrackDownloadRequest) -> DownloadResult | None:
        """The failed result for a request that cannot run at all, else None."""
        is_valid, error = request.validate()
        if is_valid:
            return None
        self.logger.error(f"Invalid request: {error}")
        return DownloadResult(
            success=False,
            file_path=None,
            error=f"Invalid request: {error}"
        )

    @staticmethod
    def _unresolved_result(resolved: ResolvedVideo) -> DownloadResult:
        """A refusal to download, carrying why — see `ResolvedVideo`."""
        return DownloadResult(
            success=False,
            file_path=None,
            error=f"Could not resolve source URL: {resolved.reason}"
                  if resolved.reason else "Could not resolve source URL",
            failure_kind=resolved.kind or "error",
        )

    async def _build_in_staging(
        self,
        request: TrackDownloadRequest,
        *,
        youtube_url: str,
        filename: str,
        staging: Path,
        phase: PhaseCallback,
        percent_cb: Callable[[float], None] | None,
    ) -> Path | DownloadResult:
        """Download into ``staging``, finish the file, then publish it.

        Returns the published path, or the failed result when the download or
        the final rename did not happen. The caller owns removing ``staging``.
        """
        phase(PHASE_DOWNLOADING, 0)
        with source_download_context(request.metadata.title or request.search_query or filename):
            file_path = await self._download_audio_file(
                youtube_url=youtube_url,
                destination=staging,
                filename=filename,
                percent_cb=percent_cb,
            )
        if not file_path:
            return DownloadResult(
                success=False,
                file_path=None,
                error="Failed to download audio",
                failure_kind="download",
            )

        file_path = await self._finish_staged_file(file_path, request, phase)

        # The album gains the track in a single rename.
        try:
            report = {}
            final = await asyncio.to_thread(self._publish, file_path, request.destination, expected_duration=request.duration_s, format_report=report)
            result = self._success_result(final, request)
            result.audio_format = report
            return result
        except OSError as e:
            self.logger.error(f"Could not move finished track into the album: {e}")
            return DownloadResult(
                success=False,
                file_path=None,
                error=f"Could not move finished track into the album: {e}",
            )

    async def _finish_staged_file(
        self, file_path: Path, request: TrackDownloadRequest, phase: PhaseCallback
    ) -> Path:
        """Package m4a, then apply best-effort ReplayGain, metadata and artwork.

        A failed step is logged and the track still ships: an untagged song is
        more useful than none.
        """
        worker = asyncio.create_task(asyncio.to_thread(self._finish_staged_file_sync, file_path, request, phase))
        try:
            return await asyncio.shield(worker)
        except asyncio.CancelledError:
            # Keep the processing slot until its thread and ffmpeg have exited.
            try:
                await asyncio.shield(worker)
            except Exception:
                pass
            raise

    def _finish_staged_file_sync(self, file_path, request, phase):
        if file_path.suffix == '.source':
            file_path = prepare_m4a(file_path, ffmpeg=self.config.ffmpeg_path, timeout=self.config.download_timeout)
        # Keep all post-download I/O in one worker, including phase callbacks.
        # Demo-video exception (off unless KROBI_DEMO_OVERRIDES is set).
        demo = demo_overrides.rule_for(
            f"{request.metadata.artist or ''} {request.metadata.title or ''}",
            request.search_query,
        )
        if demo and demo.trim_start_s:
            demo_overrides.trim_head(file_path, demo.trim_start_s, self.config.ffmpeg_path)

        phase(PHASE_NORMALIZING)
        normalized = self._apply_normalization(file_path, request)
        if not normalized:
            self.logger.warning("ReplayGain measurement failed, continuing anyway")
        if request.options.normalize:
            provenance = json.loads(receipt(file_path).read_text()) if receipt(file_path).exists() else {}
            provenance['normalization'] = 'replaygain-only' if normalized else 'replaygain-unavailable'
            write_json_atomic(receipt(file_path), provenance, mode=PRIVATE)

        phase(PHASE_TAGGING)
        if not self._apply_metadata(file_path, request.metadata):
            self.logger.warning("Metadata application failed, continuing anyway")

        phase(PHASE_EMBEDDING_COVER)
        if not self._download_and_embed_cover(file_path, request):
            self.logger.warning("Cover art embedding failed, continuing anyway")
        return file_path

    def _success_result(self, file_path: Path, request: TrackDownloadRequest) -> DownloadResult:
        """The success result, titled from the tags the file ended up with.

        Falls back to the request's own metadata when the tags cannot be read.
        """
        try:
            final_metadata = self.metadata_repo.read_id3_tags(file_path)
            title = final_metadata.title
            artist = final_metadata.artist
            album = final_metadata.album
        except Exception as e:
            self.logger.warning(f"Could not read final metadata: {e}")
            title = request.metadata.title
            artist = request.metadata.artist
            album = request.metadata.album

        self.logger.info(f"Successfully completed track download: {file_path}")
        return DownloadResult(
            success=True,
            file_path=file_path,
            error=None,
            title=title,
            artist=artist,
            album=album
        )

    @capacity_job
    async def download_multiple_tracks(
        self,
        requests: list[TrackDownloadRequest],
        progress_id: str | None = None
    ) -> list[DownloadResult]:
        """
        Download multiple tracks with concurrent processing.
        
        Args:
            requests: List of track download requests
            progress_id: Optional progress tracker ID
            
        Returns:
            List of DownloadResult objects
        """
        if self.acquisition is not None and not {'download_single_track', '_build_in_staging'}.intersection(self.__dict__):
            return await self.acquisition.legacy(requests, progress_id=progress_id)
        self.logger.info(f"Starting batch download of {len(requests)} tracks")
        
        # Create progress tracker if not provided
        if not progress_id:
            progress_id = str(uuid.uuid4())

        # Don't clobber a progress entry the caller already created. An endpoint that
        # backgrounds this download creates it synchronously first (so the SSE stream
        # can attach without racing a 404); re-creating here would reset that state.
        if self.progress_tracker.get_progress(progress_id) is None:
            self.progress_tracker.create_progress(progress_id, len(requests))
        
        # Catalog acquisitions can pre-complete on-disk tracks before sending
        # only the misses here. Include those successes in the first terminal
        # snapshot, before an SSE client observes it and closes its stream.
        initial_successes = self.progress_tracker.get_progress(progress_id).completed

        # Each single-track pipeline enters the shared nest limiter.

        ledger = getattr(self.progress_tracker, 'ledger', None)
        if ledger:
            record = ledger.get(progress_id)
            indices = [i['idx'] for i in ledger.items(progress_id) if i['attempt'] == record['attempt'] and i['state'] in ('queued', 'running')]
        else:
            indices = list(range(len(requests)))

        async def download_with_progress(request: TrackDownloadRequest, index: int) -> DownloadResult:
            """Download single track and update progress."""
            token = _job_item.set(indices[index] if index < len(indices) else index)
            try:
                # Generate track name for progress
                track_name = request.metadata.title or request.search_query or "Unknown Track"

                self.logger.info(f"Downloading track {index + 1}/{len(requests)}: {track_name}")

                # Report this track's per-step progress (phase + download %) into
                # the tracker, keyed by track_name so concurrent downloads don't
                # clobber each other. It rides the same SSE stream as the count.
                def report(phase: str, percent: float | None = None, _name=track_name) -> None:
                    self.progress_tracker.set_track_phase(progress_id, _name, phase, percent)

                # Download track
                result = await self.download_single_track(request, progress_cb=report)

                if not result.success:
                    self._remember_failure(progress_id, index, request, result)

                # Update progress (moves the track out of the in-flight set)
                self.progress_tracker.update_progress(progress_id, track_name)

                return result

            except Exception as e:
                if not isinstance(e, SourceFailure):
                    self.logger.error(f"Error downloading track {index}: {e}")
                track_name = request.metadata.title or request.search_query or "Unknown Track"
                result = DownloadResult(
                    success=False,
                    file_path=None,
                    error=str(e),
                    failure_kind="auth" if getattr(e, "kind", None) == FailureKind.AUTH_REQUIRED else "error",
                )
                self._remember_failure(progress_id, index, request, result)
                self.progress_tracker.update_progress(progress_id, track_name)

                return result
            finally:
                _job_item.reset(token)

        # Download all tracks concurrently
        tasks = [download_with_progress(req, i) for i, req in enumerate(requests)]
        results = await asyncio.gather(*tasks)
        
        success_count = initial_successes + sum(1 for r in results if r.success)
        failed_count = len(results) + initial_successes - success_count
        
        # Mark progress as complete
        status = f"Downloaded {success_count}/{len(requests) + initial_successes} tracks"
        if failed_count > 0:
            status += f" ({failed_count} failed)"
        
        self.progress_tracker.complete_progress(
            progress_id, status, succeeded=success_count, failed=failed_count
        )
        
        self.logger.info(f"Batch download complete: {success_count} successful, {failed_count} failed")

        landed = [r.file_path for r in results if r.success and r.file_path]
        if landed:
            for listener in list(self.completion_listeners):
                try:
                    listener(landed)
                except Exception as e:  # never let a follow-up fail the download
                    self.logger.warning("download completion listener failed: %s", e)
        
        return results
    
    async def _resolve_source_url(self, request: TrackDownloadRequest, *, exclude: tuple[str, ...] = ()) -> ResolvedVideo:
        """Resolve a direct URL or score search results by recording identity.

        Title, artist, duration, and version qualifiers prevent a high-ranked live
        take or extended mix from replacing the requested recording. The matcher
        can refuse every result."""
        if hasattr(self.download_repo, "select"):
            self.download_repo.select(request.youtube_url)
        # If direct URL provided, use it
        if request.youtube_url:
            self.logger.info(f"Using direct source URL: {request.youtube_url}")
            return ResolvedVideo(request.youtube_url, "direct URL")

        # If search query provided, search source
        if request.search_query:
            self.logger.info(f"Searching source for: {request.search_query}")
            try:
                # Ask for more than the repo default. Selection now vetoes live
                # takes, remixes and anything off by more than DURATION_VETO_S,
                # so a shortlist can be refused *entirely* — where the old
                # substring filter always returned something. Official videos
                # rank high and often run long (Blinding Lights' video is 4:22
                # against a 3:20 track), so a top-5 can plausibly be all vetoes
                # and download nothing. Extra candidates cost one search, not
                # one download, and they only ever widen recall.
                from .lookups import current_lookups
                memo = current_lookups.get()
                search_results = (await memo.search(self.download_repo, request.search_query, wanted=_source_wanted(request)) if memo else
                                  await self.download_repo.search_source(request.search_query, max_results=10, wanted=_source_wanted(request)))
            except SourceFailure as e:
                # Bot wall — let it propagate so the user gets the cookie hint
                # instead of a generic "Could not resolve source URL".
                self._log_download_failure(request.metadata.title or request.search_query, e)
                raise
            except Exception as e:
                self._log_download_failure(request.metadata.title or request.search_query, e)
                return ResolvedVideo(None, f"source search failed: {e}")

            if not search_results:
                self.logger.warning(f"No results found for: {request.search_query}")
                return ResolvedVideo(None, f"no source results for '{request.search_query}'", "no-results")

            if hasattr(self.download_repo, 'remember_candidates'):
                self.download_repo.remember_candidates(search_results)
            # Candidates this attempt already found gone are not offered again.
            search_results = [row for row in search_results if row.get('url') not in exclude]
            source_id = getattr(self.download_repo, 'source_id', None)
            options = {'provider': source_id} if isinstance(source_id, str) else {}
            wanted = _wanted_from_request(request)
            choice = select_video(wanted, search_results, **options)
            if not choice.url:
                self.logger.warning(f"Rejected all source results for '{request.search_query}': {choice.reason}")
                return ResolvedVideo(None, choice.reason, "rejected")

            self.logger.info(f"Found source URL: {choice.url} ({choice.reason})")
            alternates = ranked_alternates(wanted, search_results, chosen=choice.url, **options)
            return ResolvedVideo(choice.url, choice.reason, decision=choice.match.confidence.value.upper(), alternates=alternates)

        return ResolvedVideo(None, "request carried neither a URL nor a search query")

    def _staging_dir(self, destination: Path) -> Path:
        staging = getattr(self.config, 'jobs_file', self.config.base_music_dir.parent / 'jobs.sqlite').parent / 'incoming' / uuid.uuid4().hex
        staging.mkdir(parents=True, exist_ok=True)
        return staging

    def _publish(self, staged: Path, destination: Path, **options) -> Path:
        from .import_stage import import_file
        return import_file(staged, destination, ffmpeg=self.config.ffmpeg_path,
            timeout=self.config.download_timeout, **options,
            root=self.config.base_music_dir if self.acquisition is not None else destination,
            incoming=getattr(self.config, 'jobs_file', self.config.base_music_dir.parent / 'jobs.sqlite').parent / 'incoming',
            recycle=getattr(self.config, 'jobs_file', self.config.base_music_dir.parent / 'jobs.sqlite').parent / 'recycle')

    async def _download_audio_file(
        self,
        youtube_url: str,
        destination: Path,
        filename: str,
        percent_cb: Callable[[float], None] | None = None,
    ) -> Path | None:
        """Download audio file from source URL."""
        try:
            # Ensure destination exists
            await asyncio.to_thread(destination.mkdir, parents=True, exist_ok=True)

            output_path_arg = destination / f"{filename}.source"

            # Download audio
            output_path = await self.download_repo.download_source_audio(
                url=youtube_url,
                output_path=output_path_arg,
                format="m4a",
                progress_cb=percent_cb,
                extract_audio=False,
            )
            
            self.logger.info(f"Downloaded audio to: {output_path}")
            return output_path

        except asyncio.CancelledError:
            self.logger.info("Download cancelled · «%s»", source_download_track(filename))
            raise
        except SourceFailure as e:
            # Propagate the bot-wall case so the user is told to add cookies.
            self._log_download_failure(source_download_track(filename), e)
            raise
        except Exception as e:
            self._log_download_failure(source_download_track(filename), e)
            return None

    def _log_download_failure(self, track: str, error: Exception) -> None:
        reason = getattr(error, 'source_reason', None) or str(error)
        self.logger.error("Download failed · «%s» · Source: %s",
                          " ".join(track.split())[:200], _summarise_source_output(reason))
    
    def _apply_normalization(
        self, 
        file_path: Path, 
        request: TrackDownloadRequest
    ) -> bool:
        """Apply audio normalization if requested."""
        if not request.options.normalize:
            return True
        
        try:
            self.logger.info(f"Normalizing audio: {file_path}")
            self.download_repo.normalize_audio(
                file_path=file_path,
                effect_type=request.options.effect_type,
                volume_boost=request.options.volume_boost
            )
            return True
        except Exception as e:
            self.logger.error(f"Error normalizing audio: {e}")
            return False
    
    def _apply_metadata(
        self, 
        file_path: Path, 
        metadata
    ) -> bool:
        """Apply metadata to audio file."""
        if not metadata.has_required_fields():
            self.logger.info("No metadata to apply")
            return True
        
        try:
            self.logger.info(f"Applying metadata to: {file_path}")
            audio_metadata = AudioMetadata(
                title=metadata.title,
                artist=metadata.artist,
                album=metadata.album,
                track_number=metadata.track_number,
                year=metadata.year,
                genre=metadata.genre,
                album_artist=metadata.album_artist,
                composer=metadata.composer,
                disc_number=metadata.disc_number,
                isrc=metadata.isrc,
                track_total=metadata.track_total,
                disc_total=metadata.disc_total,
                compilation=metadata.compilation,
                recording_mbid=metadata.recording_mbid,
                release_mbid=metadata.release_mbid,
                release_group_mbid=metadata.release_group_mbid,
                artist_mbid=metadata.artist_mbid,
                cover_art=None  # Cover art handled separately
            )
            self.metadata_repo.write_id3_tags(file_path, audio_metadata, overwrite=True)
            return True
        except Exception as e:
            self.logger.error(f"Error applying metadata: {e}")
            return False
    
    def _download_and_embed_cover(
        self, 
        file_path: Path, 
        request: TrackDownloadRequest
    ) -> bool:
        """Download and embed cover art if available."""
        cover_data = request.cover_data
        
        # Download cover if URL provided and no data yet
        if request.cover_url and not cover_data:
            try:
                self.logger.info(f"Downloading cover art from: {request.cover_url}")
                
                cover_dir = file_path.parent / "cover"
                cover_dir.mkdir(parents=True, exist_ok=True)
                cover_file = cover_dir / "cover.jpg"
                
                from .lookups import current_lookups
                def load():
                    self.genius_repo.download_cover_art(request.cover_url, cover_file)
                    return cover_file.read_bytes()
                memo = current_lookups.get()
                cover_data = memo.cover(request.cover_url, load) if memo else load()
                
                self.logger.info(f"Downloaded and saved cover to: {cover_file}")
            except Exception as e:
                self.logger.warning(f"Could not download cover art: {e}")
                return False
        
        if cover_data:
            try:
                cover_dir = file_path.parent / "cover"
                cover_dir.mkdir(parents=True, exist_ok=True)
                cover_file = cover_dir / "cover.jpg"
                
                # Only save if it doesn't exist
                if not cover_file.exists():
                    with open(cover_file, 'wb') as f:
                        f.write(cover_data)
                    self.logger.info(f"Saved cover to: {cover_file}")
            except Exception as e:
                self.logger.warning(f"Could not save cover to disk: {e}")
            
            # Embed through the format-aware tag writer
            try:
                self.logger.info(f"Embedding cover art in: {file_path}")
                self.metadata_repo.embed_cover_art(file_path, cover_data)
                return True
            except Exception as e:
                self.logger.error(f"Error embedding cover art: {e}")
                return False
        
        return True
