"""Progress tracking for long-running operations."""
import asyncio
import threading
import time
from dataclasses import dataclass, field
from copy import deepcopy
from contextvars import ContextVar
from fastapi import Request

from app.infra.identity import Principal

progress_principal: ContextVar[Principal | None] = ContextVar("progress_principal", default=None)


async def attribute_progress(request: Request):
    """Attribute jobs created by this request and its background tasks."""
    token = progress_principal.set(getattr(request.state, "principal", None))
    try:
        yield
    finally:
        progress_principal.reset(token)


@dataclass
class ProgressState:
    """State of a progress tracker."""
    progress_id: str
    total: int
    done: list[str] = field(default_factory=list)
    status: str = "in_progress"  # "in_progress", then a final value on completion
    created_at: float = field(default_factory=time.time)
    starter_user_id: str | None = None  # Internal attribution, never serialized.
    # Per-item sub-state for work currently in flight: maps an item name to its
    # current phase (e.g. "searching", "downloading", "tagging") and an optional
    # 0-100 percent for the download phase. An item lives here while it's being
    # processed and is moved to `done` on completion. Lets the UI show fine-grained
    # progress ("downloading 47%") instead of only "3 of 10 done".
    active: dict[str, dict] = field(default_factory=dict)

    # Outcome counts, set by `complete_progress`. `completed` above counts items
    # that were *attempted*, not items that worked — a failed download still
    # lands in `done`, so a one-track job that failed reports completed == total
    # == 1 at 100%. Without these, the only evidence of failure is the prose in
    # `status` ("Downloaded 0/1 tracks (1 failed)") and consumers end up
    # regex-parsing it. Prose gets reworded; counts do not.
    succeeded: int | None = None
    failed: int | None = None

    # One entry per item that did not work, with enough to offer the person a
    # way out: why it failed and which other searches to try. The engine keeps
    # the request itself (a destination path, cover bytes) — this is only what a
    # client needs to draw the row and ask for a retry by (progress_id, index).
    failures: list[dict] = field(default_factory=list)

    # Catalog member acquisitions report every requested item, including two
    # recordings with the same title. Older producers retain title deduplication.
    deduplicate_items: bool = True

    @property
    def completed(self) -> int:
        """Number of completed items."""
        return len(self.done)

    @property
    def is_terminal(self) -> bool:
        """True once the operation has finished (success or failure).

        ``complete_progress`` overwrites ``status`` with its final value — which may
        be ``"done"``, ``"failed"``, or a human summary like ``"Downloaded 5/5
        tracks"`` — so any status other than the initial ``"in_progress"`` means the
        work is over. The SSE stream uses this to know when to close.
        """
        return self.status not in {"in_progress", "queued"}

    @property
    def percentage(self) -> float:
        """Completion percentage."""
        if self.total == 0:
            return 100.0
        return (self.completed / self.total) * 100.0

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "progress_id": self.progress_id,
            "total": self.total,
            "completed": self.completed,
            "percentage": round(self.percentage, 2),
            "status": self.status,
            "terminal": self.is_terminal,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "items": list(self.done),
            "active": {item: dict(sub) for item, sub in self.active.items()},
            "failures": [dict(f) for f in self.failures],
            "created_at": self.created_at
        }


class ProgressTracker:
    """Thread-safe progress tracking for long-running operations.

    Besides snapshot access (:meth:`get_progress`), the tracker supports change
    notification so a Server-Sent Events stream can wake on each update instead of
    busy-polling. Every mutation bumps a monotonic version and wakes waiters via a
    shared :class:`threading.Condition`; :meth:`wait_for_change` blocks until that
    version advances past the caller's last-seen value (or a timeout elapses). This
    is mode-agnostic: any producer that drives the tracker (the playlist batch loop,
    the single-track one-click path, …) is streamed without per-mode wiring.
    """

    def __init__(self, ledger=None, *, now=time.monotonic):
        """Initialize progress tracker."""
        self.ledger = ledger
        self._volatile = set()
        self._tick_at = {}
        self._song_phases = {}
        self.now = now
        self._attempts: dict[str, int] = {}
        self._progress: dict[str, ProgressState] = {}
        # A Condition (over its own RLock) doubles as the state lock and the wakeup
        # channel for subscribers. `_version` advances on every observable change.
        self._cond = threading.Condition()
        self._version = 0
        # Async notification never waits behind ledger I/O under _cond.
        self._async_lock = threading.Lock()
        self._async_waiters: set[asyncio.Future] = set()

    def attempt_for(self, progress_id):
        from app.infra.capacity import _job
        running = _job.get()
        if running and running[0] is self and running[1] == progress_id:
            return running[2]
        return self._attempts.get(progress_id, 1)

    def _bump_locked(self) -> None:
        """Advance the version and wake all waiters. Caller must hold ``self._cond``."""
        with self._async_lock:
            self._version += 1
            waiters = list(self._async_waiters)
            self._async_waiters.clear()
        self._cond.notify_all()
        for waiter in waiters:
            waiter.get_loop().call_soon_threadsafe(self._wake_async, waiter)

    def _wake_async(self, waiter):
        if not waiter.done():
            waiter.set_result(None)

    def create_progress(self, progress_id: str, total: int, *, deduplicate_items: bool = True, kind="download", label=None, items=None) -> None:
        """
        Initialize a new progress tracker.

        Args:
            progress_id: Unique identifier for this progress
            total: Total number of items to process
            deduplicate_items: Whether repeated completion labels are ignored
        """
        with self._cond:
            if self.ledger:
                self.ledger.start(kind, label or f"{total} canciones", items or [], progress_principal.get(), job_id=progress_id, total=total)
                record = self.ledger.get(progress_id)
                self._attempts[progress_id] = record['attempt']
                if record['kind'].startswith('acquisition-'):
                    self._volatile.add(progress_id)
            self._tick_at = {k: v for k, v in self._tick_at.items() if k[0] != progress_id}
            self._song_phases = {k: v for k, v in self._song_phases.items() if k[0] != progress_id}
            self._progress[progress_id] = ProgressState(
                progress_id=progress_id,
                total=total,
                status="in_progress",
                deduplicate_items=deduplicate_items,
                starter_user_id=getattr(progress_principal.get(), "user_id", None),
            )
            if self.ledger:
                cached = self._progress[progress_id]
                cached.starter_user_id = record['starter_user_id']
                cached.total = record['total']
                cached.done = [i['item'] for i in self.ledger.items(progress_id) if i['state'] == 'done']
            self._bump_locked()

    def set_status(self, progress_id: str, status: str) -> None:
        with self._cond:
            if progress_id in self._progress:
                if self.ledger and status == 'in_progress':
                    self.ledger.running(progress_id, self.attempt_for(progress_id))
                self._progress[progress_id].status = status
                self._bump_locked()

    def set_total(self, progress_id: str, total: int) -> None:
        """Resize progress after background discovery supplies the item count.

        Registering total=0 first lets SSE attach without racing a missing entry.
        Unknown ids and unchanged totals leave the change version untouched.
        """
        with self._cond:
            state = self._progress.get(progress_id)
            if state is None or state.total == total:
                return
            if self.ledger:
                self.ledger.configure(progress_id, total=total)
            state.total = total
            self._bump_locked()

    def update_progress(self, progress_id: str, item: str, *, index: int | None = None) -> None:
        """
        Update progress for an operation.

        Args:
            progress_id: Progress identifier
            item: Item that was completed
        """
        with self._cond:
            state = self._progress.get(progress_id)
            if state is None:
                return

            self._song_phases.pop((progress_id, index), None)
            changed = False
            # An item that finishes leaves the in-flight set.
            if item in state.active:
                del state.active[item]
                changed = True
            if not state.deduplicate_items or item not in state.done:
                state.done.append(item)
                changed = True
            if changed:
                self._bump_locked()

    def set_track_phase(
        self,
        progress_id: str,
        item: str,
        phase: str,
        percent: float | None = None,
        *, index: int | None = None,
    ) -> None:
        """Record phase and rounded percent without flooding the change stream.

        Only changed sub-state advances the version; unknown ids are ignored.
        """
        with self._cond:
            state = self._progress.get(progress_id)
            if state is None:
                return

            sub = {"phase": phase, "percent": round(percent) if percent is not None else None}
            if progress_id in self._volatile:
                key = (progress_id, index if index is not None else item)
                now = self.now()
                if percent is not None and self._song_phases.get(key, state.active.get(item, {})).get('phase') == phase and now - self._tick_at.get(key, float('-inf')) < 0.25:
                    return
                if percent is not None:
                    self._tick_at[key] = now
                self._song_phases[key] = sub
            if state.active.get(item) != sub:
                if self.ledger and progress_id not in self._volatile:
                    attempt = self.attempt_for(progress_id)
                    record = self.ledger.get(progress_id)
                    if not record or record['attempt'] != attempt or record['state'] not in ('queued','running'):
                        return
                    if phase not in ('en cola', 'queued'):
                        entry = next((i for i in self.ledger.items(progress_id) if i['item'] == item and i['state'] == 'queued'), None)
                        if entry:
                            self.ledger.item_transition(progress_id, entry['idx'], attempt, 'running')
                    self.ledger.phase_changed()
                state.active[item] = sub
                self._bump_locked()

    def track_phase(self, progress_id, index):
        """A song's disposable phase, even when display titles repeat."""
        with self._cond:
            return dict(self._song_phases.get((progress_id, index), {}))

    def get_progress(self, progress_id: str) -> ProgressState | None:
        """
        Get a detached progress snapshot, copied under the state lock.

        Args:
            progress_id: Progress identifier

        Returns:
            ProgressState if found, None otherwise
        """
        with self._cond:
            state = self._progress.get(progress_id)
            return deepcopy(state) if state is not None else None

    def complete_progress(
        self,
        progress_id: str,
        status: str = "done",
        succeeded: int | None = None,
        failed: int | None = None,
    ) -> None:
        """Record terminal status with optional succeeded/failed counts.

        Pass counts when known: 100% completion alone says nothing about success.
        They remain optional for existing callers.
        """
        with self._cond:
            state = self._progress.get(progress_id)
            if state is not None:
                if self.ledger:
                    attempt = self.attempt_for(progress_id)
                    record = self.ledger.get(progress_id)
                    if not record or record['attempt'] != attempt:
                        return
                    # Precise producers record outcomes themselves. Legacy producers
                    # can resolve their attempted labels, but exceptions never succeed.
                    existing = self.ledger.items(progress_id)
                    failures = {f.get('item'): f for f in state.failures}
                    for name in state.done:
                        pending = next((i for i in existing if i['item'] == name and i['state'] in ('queued','running')), None)
                        if pending and status != 'failed':
                            failure = failures.get(name)
                            self.ledger.outcome(progress_id, name, success=not failure, detail=failure, attempt=attempt)
                    self.ledger.finish(progress_id, attempt, error=status == 'failed', cancelled=status == 'cancelled')
                    if record['state'] in ('cancelled', 'interrupted'):
                        status = record['state']
                state.status = status
                if succeeded is not None:
                    state.succeeded = succeeded
                if failed is not None:
                    state.failed = failed
                self._bump_locked()

    def add_failure(self, progress_id: str, failure: dict) -> None:
        """Record one item that failed. No-op for an unknown id."""
        with self._cond:
            state = self._progress.get(progress_id)
            if state is None:
                return
            if self.ledger and progress_id not in self._volatile:
                self.ledger.failure_detail(progress_id, failure.get('index', 0), failure, self.attempt_for(progress_id))
                self.ledger.outcome(progress_id, failure.get('item', ''), success=False, detail=failure,
                                    reason=failure.get('kind', 'error'), attempt=self.attempt_for(progress_id), idx=failure.get('index'))
            state.failures.append(dict(failure))
            self._bump_locked()

    def mark_failure_retried(self, progress_id: str, index: int, retry_id: str) -> None:
        """Record the retry of failure ``index`` as job ``retry_id``."""
        with self._cond:
            if self.ledger:
                self.ledger.mark_retried(progress_id, index, retry_id)
            state = self._progress.get(progress_id)
            if state is None:
                return
            for failure in state.failures:
                if failure.get("index") == index:
                    failure["retriedAs"] = retry_id
                    self._bump_locked()
                    return

    def delete_progress(self, progress_id: str) -> None:
        """
        Delete a progress tracker.

        Args:
            progress_id: Progress identifier
        """
        with self._cond:
            if progress_id in self._progress:
                del self._progress[progress_id]
                self._volatile.discard(progress_id)
                self._tick_at = {k: v for k, v in self._tick_at.items() if k[0] != progress_id}
                self._song_phases = {k: v for k, v in self._song_phases.items() if k[0] != progress_id}
                self._bump_locked()

    def current_version(self) -> int:
        """Return the current change version (advances on every observable change)."""
        with self._async_lock:
            return self._version

    def wait_for_change(self, last_version: int, timeout: float | None = None) -> int:
        """Wait for a change or timeout and return the current version.

        An unchanged version lets SSE emit a heartbeat and check for disconnection.
        """
        with self._cond:
            if self._version == last_version:
                self._cond.wait(timeout)
            return self._version

    async def wait_for_change_async(self, last_version: int, timeout: float | None = None) -> int:
        """Wait without occupying a worker; registration and version check are atomic."""
        waiter = asyncio.get_running_loop().create_future()
        with self._async_lock:
            if self._version != last_version:
                return self._version
            self._async_waiters.add(waiter)
        try:
            try:
                await asyncio.wait_for(waiter, timeout)
            except TimeoutError:
                pass
        finally:
            with self._async_lock:
                self._async_waiters.discard(waiter)
        return self.current_version()

    def cleanup_old_progress(self, max_age_hours: int = 24) -> int:
        """
        Remove old progress entries.

        Args:
            max_age_hours: Maximum age in hours before cleanup

        Returns:
            Number of entries removed
        """
        cutoff_time = time.time() - (max_age_hours * 3600)
        removed = 0

        with self._cond:
            to_remove = [
                progress_id
                for progress_id, state in self._progress.items()
                if state.created_at < cutoff_time and (self.ledger is None or state.is_terminal)
            ]

            for progress_id in to_remove:
                del self._progress[progress_id]
                self._volatile.discard(progress_id)
                self._tick_at = {k: v for k, v in self._tick_at.items() if k[0] != progress_id}
                self._song_phases = {k: v for k, v in self._song_phases.items() if k[0] != progress_id}
                removed += 1

            if removed:
                # Wake any stream subscribed to a now-deleted entry so it can close.
                self._bump_locked()

        return removed

    def list_all_progress(self) -> list[ProgressState]:
        """
        List all progress trackers.

        Returns:
            List of all progress states
        """
        with self._cond:
            return deepcopy(list(self._progress.values()))
