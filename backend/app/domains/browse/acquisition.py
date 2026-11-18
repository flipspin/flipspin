"""Catalog acquisition: link what is already here, download what is not.

The logic behind ``POST /api/browse/acquire`` (``routes.py`` only parses the
body, maps the two refusals below onto status codes and returns). Built per
request from the route's injected dependencies, so a test that overrides one of
them (the ownership index, the download service, the user-track store) still
reaches the code it means to.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter
from pathlib import Path
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, Field

from app.infra.progress import ProgressTracker
from app.infra.tasks import spawn_background
from app.infra.identity import Principal, is_real_user
from app.domains.browse.repositories import full_size_image_url
from app.domains.downloads.models import CATALOG_EFFECT_TYPE, CATALOG_VOLUME_BOOST_DB
from app.domains.metadata.genres import AlbumGenres, fill_tracks
from app.domains.user_library.acquisition_links import link_acquired, link_results, rel_path_for
from app.domains.user_library.store import UserTrackStore
from app.domains.user_library.scope import LibraryScope
from app.utils.library_paths import resolve_rel_path
from app.providers.registry import ProviderKind
from app.utils.path_safety import safe_music_subpath

logger = logging.getLogger(__name__)


class NoStreamingSource(Exception):
    """Every STREAMING provider is switched off — a 409, not worth a retry."""


class InvalidDestination(Exception):
    """``folder`` does not resolve under the music root — a 400."""


class AcquireTrack(BaseModel):
    """One catalog track to acquire.

    Deliberately mirrors what a browse tracklist already renders, so the client
    forwards the rows it has rather than re-deriving them. Every field here
    exists because the download pipeline needs it:

    * ``title``/``artistName`` — the search identity and the ID3 tags;
    * ``albumTitle`` — decides the destination folder and the cover-beside-track
      convention;
    * ``durationSeconds`` — the only thing arming ``DURATION_VETO_S``, which is
      what refuses a live take or an extended mix of the right title;
    * ``trackPosition`` — the filename prefix and the track tag;
    * ``coverUrl`` — embedded as artwork, after being upgraded to the provider's
      full-size variant here. The client sends back the display-size URL it was
      given, because that is the row it already has; it does not have to know
      that a library file wants a bigger image than a card does.
    """

    title: str = Field(..., min_length=1, max_length=500)
    artistName: str | None = Field(default=None, max_length=500)
    albumTitle: str | None = Field(default=None, max_length=500)
    trackPosition: int | None = Field(default=None, ge=0, le=1000)
    durationSeconds: float | None = Field(default=None, ge=0, le=86400)
    coverUrl: str | None = Field(default=None, max_length=2000)
    isrc: str | None = Field(default=None, max_length=32)
    #: The server path of a library file this download takes the place of —
    #: another version of the song (an ownership verdict's ``nearMatch`` or
    #: ``match``). Skips the dedupe for this track, and when it lands the old
    #: file is deleted and every row and playlist follows the new one
    #: (``domains/music/relocation.py``). A failed download deletes nothing.
    replaces: str | None = Field(default=None, max_length=4096)


class AcquireRequest(BaseModel):
    tracks: list[AcquireTrack] = Field(..., min_length=1, max_length=200)
    #: Parent folder under the music root. Leave unset for an album — the
    #: download adapter files tracks under their own album name, so naming it
    #: here as well nests the album inside itself.
    folder: str | None = Field(default=None, max_length=255)
    label: str | None = Field(default=None, max_length=120)


def _dedupe_hits(ownership, tracks: list[AcquireTrack], base_music_dir) -> dict[int, str]:
    """Return resolvable owned paths by request index using one oracle batch.

    Reuse the browse markers' matcher. Oracle errors or unresolvable paths fall
    back to acquisition. See docs/DEVELOPER_GUIDE.md#spotify-export-import.
    """
    try:
        verdicts = ownership.lookup_many(
            [
                {"title": t.title, "artist": t.artistName, "duration_s": t.durationSeconds}
                for t in tracks
            ]
        )
        hits: dict[int, str] = {}
        for i, verdict in enumerate(verdicts):
            match = getattr(verdict, "match", None)
            if not getattr(verdict, "owned", False) or match is None:
                continue
            rel_path = rel_path_for(base_music_dir, getattr(match, "path", None))
            if rel_path:
                hits[i] = rel_path
        return hits
    except Exception as e:  # noqa: BLE001 — never block an acquisition on this
        logger.warning("Dedupe check failed; acquiring everything: %s", e)
        return {}


def _replace_landed(relocator, wanted: list[AcquireTrack], results) -> None:
    """The "Swap for this version" half: each landed track with ``replaces``
    takes the old file's place. Positional — the engine answers one result per
    requested track. Raises nothing: the download worked either way."""
    for track, result in zip(wanted, results or (), strict=False):
        if not track.replaces or not getattr(result, "success", False):
            continue
        new = getattr(result, "file_path", None)
        if not new:
            continue
        try:
            old = relocator.library_file(track.replaces)
        except Exception as e:  # noqa: BLE001 — already absent or owned elsewhere
            logger.warning("Replacement target %s not usable: %s", track.replaces, e)
            continue
        try:
            relocator.replace(old, Path(new))
        except Exception:  # noqa: BLE001
            logger.exception("Could not replace %s with %s", old, new)




class CatalogAcquisition:
    """One acquisition request's collaborators, and the work it starts."""

    def __init__(
        self,
        *,
        registry,
        download_service,
        progress_tracker: ProgressTracker,
        ownership,
        user_tracks: UserTrackStore,
        relocator,
        genre_lookup: Callable[[], AlbumGenres | None],
    ):
        self.registry = registry
        self.download_service = download_service
        self.progress_tracker = progress_tracker
        self.ownership = ownership
        self.user_tracks = user_tracks
        self.relocator = relocator
        #: Asked only after the STREAMING gate, once per request.
        self._genre_lookup = genre_lookup

    async def start(self, data: AcquireRequest, principal: Principal) -> dict[str, Any]:
        """Link the hits, queue the misses, and answer the response body.

        Raises ``NoStreamingSource`` or ``InvalidDestination`` before anything
        is linked or queued.
        """
        # Gate acquisition on enabled streaming sources before linking or queuing work.
        if not self.registry.order(ProviderKind.STREAMING):
            raise NoStreamingSource()

        # A configured engine routes every production catalog acquisition to
        # the same durable pipeline. Unconfigured engines remain injectable
        # for callers migrating from the old standalone facade.
        from app.domains.acquisition.services import Pipeline
        pipeline = getattr(self.download_service.engine, 'acquisition', None)
        if isinstance(pipeline, Pipeline):
            try:
                return await pipeline.catalog(data, principal, relocator=self.relocator)
            except ValueError as error:
                from app.domains.acquisition.models import AcquisitionError
                if isinstance(error, AcquisitionError):
                    from fastapi import HTTPException
                    raise HTTPException(error.status, detail={'reason': error.reason})
                raise InvalidDestination(str(error)) from error

        logger.info("Catalog acquisition requested by %s (%d tracks)", principal, len(data.tracks))

        # `folder` is the *parent* of wherever the tracks land, not the album
        # folder. The download adapter already files each track under
        # `destination / clean_filename(album)`, so defaulting this to the album
        # title produced Music/Discovery/Discovery — caught by looking at the disk,
        # not by any test. An album therefore passes no folder at all and inherits
        # the music root; a playlist passes its own name and gets
        # Playlist/<album>/... , matching what the export import already does.
        base = self.download_service.config.base_music_dir
        try:
            destination = safe_music_subpath(base, data.folder) if data.folder else base
        except Exception as e:  # ValidationError from path_safety
            raise InvalidDestination(str(e)) from e

        member = not LibraryScope.for_principal(principal, self.user_tracks).unrestricted

        # ---------------------------------------------------------------- the hit
        # Ask the ownership oracle once, off the event loop: a stale index rebuilds
        # by reading tags from every file in the library, which is not something an
        # async handler may do inline.
        hits = await asyncio.to_thread(_dedupe_hits, self.ownership, data.tracks, base)
        # A replacement is asked for *because* the library answers for this song:
        # the dedupe hit is exactly what it must not take.
        for i, t in enumerate(data.tracks):
            if t.replaces:
                hits.pop(i, None)

        # The song is on disk, so it becomes the caller's now — one row, nothing
        # transferred. Sentinels (the desktop) fall straight through this, silently.
        instant = link_acquired(
            self.user_tracks,
            principal,
            base,
            [resolve_rel_path(base, rel_path) if member else Path(base) / rel_path for rel_path in hits.values()],
            logger_=logger,
        )
        already_present = [
            {
                "title": data.tracks[i].title,
                "relPath": rel_path,
                # Whether the caller now holds a row for it. False for the desktop,
                # which has no library — not an error, just not applicable.
                "linked": rel_path in instant.rel_paths,
            }
            for i, rel_path in sorted(hits.items())
        ]

        # --------------------------------------------------------------- the miss
        wanted = [t for i, t in enumerate(data.tracks) if i not in hits]
        tracks_data = [_engine_track(t) for t in wanted]

        # Registered synchronously so a client attaching to the SSE stream the
        # instant this returns cannot race a 404. Members see a download for
        # every requested item; owners retain the queued-only progress total.
        progress_id = str(uuid.uuid4())
        total = len(data.tracks) if member else len(tracks_data)
        from app.infra.jobs import Jobs
        ledger = getattr(self.progress_tracker, 'ledger', None)
        if isinstance(ledger, Jobs):
            ledger.start('download', data.label or data.folder or data.tracks[0].albumTitle or data.tracks[0].title,
                         [{'item': t.title} for t in (data.tracks if member else wanted)], principal,
                         job_id=progress_id, total=total)
        self.progress_tracker.create_progress(
            progress_id, total, **({"deduplicate_items": False} if member else {})
        )
        if member:
            for i in hits:
                if self.progress_tracker.ledger:
                    self.progress_tracker.ledger.outcome(progress_id, data.tracks[i].title, success=True, idx=i)
                self.progress_tracker.update_progress(progress_id, data.tracks[i].title)
        from app.infra.job_requests import record_call
        record_call(self.progress_tracker, progress_id, 'download_spotify_playlist', tracks=tracks_data,
                    destination=destination, normalize=False, effect_type=CATALOG_EFFECT_TYPE,
                    volume_boost=CATALOG_VOLUME_BOOST_DB)
        genre_lookup = self._genre_lookup()

        if tracks_data:
            # Held from here, synchronously, so the index never rebuilds while this
            # job's files are landing; released in `_download`'s `finally`.
            try:
                self.ownership.acquisition_started()
            except Exception:  # noqa: BLE001
                logger.debug("Could not hold the ownership index", exc_info=True)
            spawn_background(
                self._download(
                    progress_id, wanted, tracks_data, destination, base, principal, genre_lookup,
                    hit_count=len(hits) if member else 0, member=member,
                )
            )
        else:
            # Everything was already here. The entry still exists and still carries
            # the id that was handed out — a client opening the SSE stream must get
            # a snapshot and a close, not a 404 — but it is terminal from birth,
            # because there is no work to report. Prose in English like every other
            # completion status (`downloadsStore.js` renders it and does not parse it).
            self.progress_tracker.complete_progress(
                progress_id,
                (f"Downloaded {total}/{total} tracks" if member else
                 f"Already in the library ({len(already_present)}) — nothing to download"),
                succeeded=total if member else 0,
                failed=0,
            )

        return {
            "success": True,
            "status": "started",
            "progress_id": progress_id,
            "total": total,
            "destination": str(destination),
            #: How many tracks the request named.
            "requested": len(data.tracks),
            #: Members see every requested track as queued; owners see real misses.
            "queued": total,
            #: Only owners see the dedupe hits and whether they were linked.
            "alreadyPresent": [] if member else already_present,
            #: ``"user"`` — rows are kept for the caller, for these and for whatever
            #: the download lands. ``"skipped"`` — this credential has no library of
            #: its own (the desktop); the download is unaffected.
            "linking": "user" if is_real_user(principal) else "skipped",
        }

    async def _download(
        self,
        progress_id: str,
        wanted: list[AcquireTrack],
        tracks_data: list[dict[str, Any]],
        destination: Path,
        base: Path,
        principal: Principal,
        genre_lookup: AlbumGenres | None,
        *,
        hit_count: int = 0,
        member: bool = False,
    ) -> None:
        # Genre and year, which no catalog track row carries (see
        # `metadata/genres.py`). Only through Deezer, and only while it is enabled
        # in Settings → Sources; looked up here in the background job, never before
        # the response, and a lookup that fails leaves the tag empty as before.
        if genre_lookup is not None:
            try:
                filled = await asyncio.to_thread(
                    fill_tracks, tracks_data, [t.isrc for t in wanted], genre_lookup
                )
                logger.info("Genres found for %d of %d acquired tracks", filled, len(tracks_data))
            except Exception:  # noqa: BLE001 — an enrichment never stops a download
                logger.info("Genre lookup skipped", exc_info=True)
        try:
            results = await self.download_service.download_spotify_playlist(
                tracks=tracks_data,
                destination=destination,
                normalize=False,
                effect_type=CATALOG_EFFECT_TYPE,
                volume_boost=CATALOG_VOLUME_BOOST_DB,
                progress_id=progress_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Catalog acquisition failed: %s", e)
            if member:
                self._record_remaining(progress_id, wanted, hit_count)
                self._complete_member(progress_id, hit_count, len(wanted))
            else:
                self.progress_tracker.complete_progress(progress_id, "failed")
        else:
            # The engine's return value *is* its completion report: one result
            # per requested track, carrying the path the bytes landed at. This
            # is the miss half of the feature — the requester gets their row now
            # that the file exists. It raises nothing and it is idempotent, so a
            # job that reports twice converges on one row; a link that fails must
            # never undo a download that worked.
            link_results(self.user_tracks, principal, base, results, logger_=logger)
            if member:
                # A member's "Swap for this version" swaps their own row, never
                # the shared file every other account still plays.
                swapped = []
                for t, r in zip(wanted, results or (), strict=False):
                    if not t.replaces or not getattr(r, "success", False):
                        continue
                    try:
                        rel = rel_path_for(base, self.relocator.library_file(t.replaces))
                    except Exception:  # noqa: BLE001 — gone already; nothing to swap
                        continue
                    if rel:
                        swapped.append(rel)
                if swapped:
                    self.user_tracks.remove_many(principal.user_id, swapped)
            else:
                await asyncio.to_thread(_replace_landed, self.relocator, wanted, results)
            if member:
                succeeded = sum(bool(getattr(r, "success", False)) for r in (results or ()))
                self._record_remaining(progress_id, wanted, hit_count)
                self._complete_member(progress_id, hit_count + succeeded, len(wanted) - succeeded)
        finally:
            # New files landed, so the ownership index is stale. Marking it here
            # rather than waiting for the directory-mtime signal means the
            # tracklist's owned marker flips when the page refetches — after a
            # short settle window, so a burst of acquisitions rebuilds the index
            # once instead of once per song (see ownership.py).
            try:
                self.ownership.acquisition_finished()
            except Exception:  # noqa: BLE001
                logger.debug("Could not mark the ownership index stale", exc_info=True)

    def _record_remaining(self, progress_id: str, wanted: list[AcquireTrack], hit_count: int) -> None:
        """Finish unreported items if an engine failed before completing the batch."""
        state = self.progress_tracker.get_progress(progress_id)
        if state is None:
            return
        reported = Counter(state.done[hit_count:])
        for track in wanted:
            if reported[track.title]:
                reported[track.title] -= 1
            else:
                self.progress_tracker.update_progress(progress_id, track.title)

    def _complete_member(self, progress_id: str, succeeded: int, failed: int) -> None:
        status = f"Downloaded {succeeded}/{succeeded + failed} tracks"
        if failed:
            status += f" ({failed} failed)"
        self.progress_tracker.complete_progress(progress_id, status, succeeded=succeeded, failed=failed)


def _engine_track(t: AcquireTrack) -> dict[str, Any]:
    """The engine's own track shape ('name', not 'title').

    duration is converted to milliseconds exactly once, here: browse payloads
    are seconds end to end and the engine wants ms, so this is the single
    boundary between the two.
    """
    return {
        "name": t.title,
        "artist": t.artistName or "",
        "album": t.albumTitle,
        "track_number": t.trackPosition,
        "duration_ms": int(t.durationSeconds * 1000) if t.durationSeconds else None,
        # Upgraded to the full-size variant here, and only here. `coverUrl`
        # is the size a browse card draws (500 px), but this one is embedded
        # into a file the user keeps forever, and a 250 px cover living
        # permanently in the library is the complaint that started this.
        # `full_size_image_url` rewrites the size in the URL rather than
        # re-reading the album, so it costs no extra Deezer request and it
        # also repairs a URL a client kept from a browse page cached before
        # the ladder was fixed.
        "album_images": [{"url": full_size_image_url(t.coverUrl)}] if t.coverUrl else None,
    }
