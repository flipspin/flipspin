"""Match catalog requests against the published library snapshot.

Preserve recording qualifiers and apply the duration veto; coalesce burst rebuilds.
See docs/library-scanning.md#catalog-ownership.
"""
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.infra import demo_overrides
from app.domains.metadata.matching import DURATION_VETO_S
from app.domains.metadata.normalization import normalize_key
from app.domains.music.repositories import library_signature

#: Duration tolerance for calling two recordings the same one. Deliberately the
#: matcher's own constant rather than a second number: "same recording" must
#: mean the same thing whether it is being matched against source or against
#: the user's own disk.
OWNERSHIP_DURATION_TOLERANCE_S = DURATION_VETO_S

#: Quiet time after the last acquisition lands before the index rebuilds. Long
#: enough to fold back-to-back downloads into one rebuild, short enough that the
#: page's refetch (which waits it out) still shows the new song as owned.
ACQUISITION_SETTLE_S = 3.0


@dataclass(frozen=True)
class OwnedTrack:
    """A local file that answers for a catalog track."""

    title: str
    artist: str
    album: str
    path: str
    duration_s: float | None = None
    track_number: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "path": self.path,
            "durationSeconds": self.duration_s,
            "trackNumber": self.track_number,
        }


@dataclass(frozen=True)
class OwnershipVerdict:
    """The answer for one queried track."""

    owned: bool
    match: OwnedTrack | None = None
    #: Set when a same-key file exists but was rejected — the user wants to know.
    near_match: OwnedTrack | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "owned": self.owned,
            "match": self.match.to_dict() if self.match else None,
            "nearMatch": self.near_match.to_dict() if self.near_match else None,
            "reason": self.reason,
        }


def _signature(base_dir: Path) -> tuple[Any, ...]:
    """A cheap fingerprint of the library's shape.

    One ``iterdir`` plus a ``stat`` per album directory — no file reads and no
    tag parsing, so it is orders of magnitude cheaper than the scan it guards.
    The same fingerprint now also guards the memoized album scan itself, so
    the one definition lives in the music repository.
    """
    return library_signature(base_dir)


class OwnershipIndex:
    """Normalized-key index over the local library, rebuilt only when it moves."""

    def __init__(self, music_repository, config, logger):
        self.repository = music_repository
        self.config = config
        self.logger = logger
        self._lock = threading.Lock()
        self._signature: tuple[Any, ...] | None = None
        self._tag_revision: int | None = None
        self._by_key: dict[str, list[OwnedTrack]] = {}
        # Coalescing state (see "Bursts of acquisitions" above).
        self._state_lock = threading.Lock()
        self._built = False
        self._dirty = False
        self._in_flight = 0
        self._settle_deadline = 0.0
        # Injectable so tests can drive the settle window without sleeping.
        self._clock = time.monotonic
        self._sleep = time.sleep

    # ------------------------------------------------------------------ build

    def _build(self, signature: tuple[Any, ...]) -> tuple[dict[str, list[OwnedTrack]], int]:
        index: dict[str, list[OwnedTrack]] = {}
        albums = self.repository.scan_albums(signature=signature)
        tag_revision = self.repository.tag_revision
        for album in albums:
            for track in album.tracks:
                title = (track.title or "").strip()
                if not title:
                    continue
                owned = OwnedTrack(
                    title=title,
                    artist=(track.artist or "").strip(),
                    album=(track.album or album.name or "").strip(),
                    path=str(track.path),
                    duration_s=track.duration,
                    track_number=track.track_number,
                )
                index.setdefault(normalize_key(owned.artist, title), []).append(owned)
        return index, tag_revision

    def _hold_reason(self) -> str | None:
        """Why a rebuild must wait right now, if it must; ``None`` if it may run."""
        with self._state_lock:
            if self._in_flight:
                return "in_flight"
            if self._clock() < self._settle_deadline:
                return "settling"
            return None

    def _wait_for_first_snapshot(self):
        scans = getattr(self.repository, 'scans', None)
        worker = getattr(scans, 'worker', None)
        if not worker or not worker.thread or not worker.thread.is_alive():
            return
        base = self.config.base_music_dir
        if scans.root != base:
            worker.request('root-changed')
        if scans.completed_at is None or scans.root != base:
            with worker.condition:
                worker.condition.wait_for(lambda: (scans.completed_at is not None and scans.root == base)
                                          or scans.error is not None or worker.stopping
                                          or not (worker.pending or worker.running))

    def _ensure_fresh(self) -> dict[str, list[OwnedTrack]]:
        self._wait_for_first_snapshot()
        if self._built:
            # Never rebuild mid-burst: answer from the current index. A cold index
            # (never built) always builds — there is nothing stale to serve.
            # The settle wait is bounded so a stream of invalidations can never
            # pin a request; past the bound it rebuilds anyway.
            waited = 0.0
            while (reason := self._hold_reason()) is not None:
                if reason == "in_flight":
                    return self._by_key
                with self._state_lock:
                    remaining = self._settle_deadline - self._clock()
                if remaining <= 0:
                    continue
                if waited >= 2 * ACQUISITION_SETTLE_S:
                    break
                self._sleep(remaining)
                waited += remaining

        base_dir = self.config.base_music_dir
        managed = getattr(getattr(self.repository, "scans", None), "worker", None) is not None
        signature = (str(base_dir), self.repository.tag_revision) if managed else _signature(base_dir)
        # Fast path: no lock, no scan. The overwhelmingly common case.
        if (
            signature == self._signature
            and self.repository.tag_revision == self._tag_revision
            and not self._dirty
        ):
            return self._by_key
        with self._lock:
            # Re-check under the lock so N concurrent first-hits build once.
            if (
                signature == self._signature
                and self.repository.tag_revision == self._tag_revision
                and not self._dirty
            ):
                return self._by_key
            self._dirty = False
            self.logger.info("Rebuilding ownership index for %s", base_dir)
            self._by_key, self._tag_revision = self._build(signature)
            self._signature = signature
            self._built = True
            self.logger.info("Ownership index holds %d distinct keys", len(self._by_key))
            return self._by_key

    def invalidate(self) -> None:
        """Rebuild on the next query, after the settle window.

        For changes the directory-mtime signature cannot see. Debounced like an
        acquisition landing, so a run of invalidations costs one rebuild.
        """
        with self._state_lock:
            self._dirty = True
            self._settle_deadline = self._clock() + ACQUISITION_SETTLE_S

    def acquisition_started(self) -> None:
        """An acquisition job is about to write into the library: hold rebuilds."""
        with self._state_lock:
            self._in_flight += 1

    def acquisition_finished(self, *, refresh=True) -> None:
        """An acquisition job is done (whatever its outcome).

        New files probably landed, so the index is dirty; the rebuild waits for
        the settle window, which every further finish pushes back.
        """
        if refresh and getattr(getattr(self.repository, "scans", None), "worker", None) is not None:
            self.repository.invalidate_scan("acquisition")
        with self._state_lock:
            self._in_flight = max(0, self._in_flight - 1)
            self._dirty = True
            self._settle_deadline = self._clock() + ACQUISITION_SETTLE_S

    # ------------------------------------------------------------------ query

    def lookup(
        self, artist: str | None, title: str, duration_s: float | None = None
    ) -> OwnershipVerdict:
        return self._lookup_in(self._ensure_fresh(), artist, title, duration_s)

    @staticmethod
    def _lookup_in(
        by_key: dict[str, list[OwnedTrack]],
        artist: str | None,
        title: str,
        duration_s: float | None = None,
    ) -> OwnershipVerdict:
        """One lookup against an already-fresh index.

        Split out so a batch pays the freshness check once. The check stats
        every album directory, so doing it per track turned a 50-track album
        page into 50 full directory walks.
        """
        if not title or not title.strip():
            return OwnershipVerdict(owned=False, reason="no title to match on")

        candidates = by_key.get(normalize_key(artist, title.strip()), [])
        if not candidates:
            return OwnershipVerdict(owned=False)

        # Without duration, use the matched key rather than requiring a signal
        # the caller does not have.
        if duration_s is None:
            return OwnershipVerdict(owned=True, match=candidates[0])

        # A demo override cropped this song's head on download; the file on
        # disk is short by exactly that much and is still the same recording.
        demo = demo_overrides.rule_for(f"{artist or ''} {title}")
        if demo and demo.trim_start_s:
            duration_s = max(0.0, duration_s - demo.trim_start_s)

        best: OwnedTrack | None = None
        best_delta = float("inf")
        for candidate in candidates:
            if candidate.duration_s is None:
                # An untimed local file cannot be refused on duration.
                if best is None:
                    best, best_delta = candidate, 0.0
                continue
            delta = abs(candidate.duration_s - duration_s)
            if delta < best_delta:
                best, best_delta = candidate, delta

        if best is not None and best_delta <= OWNERSHIP_DURATION_TOLERANCE_S:
            return OwnershipVerdict(owned=True, match=best)

        return OwnershipVerdict(
            owned=False,
            near_match=best,
            reason=(
                f"a file with this name exists but runs {best.duration_s:.0f}s "
                f"against {duration_s:.0f}s — likely a different recording"
                if best is not None and best.duration_s is not None
                else "same name, different recording"
            ),
        )

    def lookup_many(
        self, queries: list[dict[str, Any]], *, allowed_rel_paths: frozenset[str] | None = None
    ) -> list[OwnershipVerdict]:
        """Answer a whole tracklist. One freshness check, N dictionary hits."""
        by_key = self._ensure_fresh()
        if allowed_rel_paths is not None:
            from app.utils.library_paths import rel_path_for

            base = self.config.base_music_dir
            keys = {normalize_key(q.get("artist"), (q.get("title") or "").strip()) for q in queries}
            by_key = {
                key: [t for t in by_key.get(key, []) if rel_path_for(base, Path(t.path)) in allowed_rel_paths]
                for key in keys
            }
        return [
            self._lookup_in(by_key, q.get("artist"), q.get("title") or "", q.get("duration_s"))
            for q in queries
        ]


__all__ = [
    "ACQUISITION_SETTLE_S",
    "OWNERSHIP_DURATION_TOLERANCE_S",
    "OwnedTrack",
    "OwnershipIndex",
    "OwnershipVerdict",
]
