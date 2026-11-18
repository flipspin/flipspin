"""Resizable nest-wide admission limits, safe across event loops and threads."""
import asyncio
import threading
import inspect
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from contextvars import ContextVar
from functools import wraps


class CapacityLimiter:
    def __init__(self, limit: Callable[[], int]):
        self.limit = limit
        self.active = 0
        self._lock = threading.Lock()
        self._waiters: set[asyncio.Future] = set()

    def wake(self) -> None:
        with self._lock:
            for waiter in self._waiters:
                if not waiter.get_loop().is_closed():
                    waiter.get_loop().call_soon_threadsafe(self._notify, waiter)

    @staticmethod
    def _notify(waiter: asyncio.Future) -> None:
        if not waiter.done():
            waiter.set_result(None)

    @asynccontextmanager
    async def slot(self):
        while True:
            with self._lock:
                if self.active < self.limit():
                    self.active += 1
                    break
                waiter = asyncio.get_running_loop().create_future()
                self._waiters.add(waiter)
            try:
                await waiter
            finally:
                with self._lock:
                    self._waiters.discard(waiter)
        try:
            yield
        finally:
            with self._lock:
                self.active -= 1
            self.wake()


_job = ContextVar("capacity_job", default=None)
_job_item = ContextVar("capacity_job_item", default=None)


class JobCancelled(asyncio.CancelledError):
    pass


def capacity_job(method):
    """One progress row and job slot across nested services, adapters and tracks."""
    signature = inspect.signature(method)
    accepts_id = "progress_id" in signature.parameters

    @wraps(method)
    async def run(self, *args, **kwargs):
        label = kwargs.pop('label', None)
        supplied_id = kwargs.pop('progress_id', None) if not accepts_id else kwargs.get('progress_id')
        parent = _job.get()
        bound = signature.bind(self, *args, **kwargs)
        if parent is not None:
            if accepts_id and not bound.arguments.get("progress_id"):
                bound.arguments["progress_id"] = parent[1]
            if getattr(self.progress_tracker, 'ledger', None) and method.__name__ in ('download_multiple_tracks', 'download_single_track'):
                from app.infra.job_requests import register_requests
                existing = self.progress_tracker.ledger.items(parent[1])
                if method.__name__ == 'download_multiple_tracks':
                    register_requests(self.progress_tracker, parent[1], bound.arguments['requests'])
                elif not any(i['detail'].get('_retry', {}).get('producer') == 'download' for i in existing):
                    register_requests(self.progress_tracker, parent[1], [bound.arguments['request']])
            return await method(*bound.args, **bound.kwargs)
        tracker = self.progress_tracker
        progress_id = supplied_id or str(uuid.uuid4())
        if accepts_id:
            bound.arguments["progress_id"] = progress_id
        supplied = bound.arguments.get("requests", bound.arguments.get("tracks"))
        total = len(supplied) if supplied is not None else (0 if "import" in method.__name__ else 1)
        if tracker.get_progress(progress_id) is None:
            tracker.create_progress(progress_id, total)
        ledger = getattr(tracker, 'ledger', None)
        if ledger:
            from app.infra.job_requests import register_requests
            if method.__name__ == 'download_multiple_tracks':
                register_requests(tracker, progress_id, bound.arguments['requests'])
            elif method.__name__ == 'download_single_track':
                register_requests(tracker, progress_id, [bound.arguments['request']])
            if method.__name__ not in ('download_single_track', 'download_multiple_tracks'):
                from app.infra.job_requests import record_call
                record_call(tracker, progress_id, method.__name__, **{k: v for k,v in bound.arguments.items() if k not in ('self','progress_id')})
            metadata = bound.arguments.get('metadata')
            label = label or bound.arguments.get('album_name') or (
                ' · '.join(x for x in (metadata.title, metadata.artist) if x) if metadata else None)
            if label:
                ledger.configure(progress_id, label=label)
            if 'import' in method.__name__:
                ledger.configure(progress_id, kind='import')
            attempt = ledger.get(progress_id)['attempt']
        else:
            attempt = 1
        tracker.set_status(progress_id, "queued")
        try:
            async with self.config.job_limiter.slot():
                if ledger and not ledger.running(progress_id, attempt):
                    raise JobCancelled()
                token = _job.set((tracker, progress_id, attempt))
                tracker.set_status(progress_id, "in_progress")
                try:
                    result = await method(*bound.args, **bound.kwargs)
                    state = tracker.get_progress(progress_id)
                    if state is not None and not state.is_terminal:
                        outcomes = result[1] if isinstance(result, tuple) else result
                        outcomes = outcomes if isinstance(outcomes, list) else [outcomes]
                        succeeded = sum(bool(getattr(r, "success", False)) for r in outcomes)
                        tracker.complete_progress(progress_id, "done", succeeded=succeeded,
                                                  failed=len(outcomes) - succeeded)
                    return result
                finally:
                    _job.reset(token)
        except asyncio.CancelledError:
            if not ledger or ledger.get(progress_id)['attempt'] == attempt:
                tracker.complete_progress(progress_id, "cancelled")
            raise
        except BaseException:
            if not ledger or ledger.get(progress_id)['attempt'] == attempt:
                tracker.complete_progress(progress_id, "failed")
            raise
    return run


def capacity_track(method):
    @wraps(method)
    async def run(self, *args, **kwargs):
        async with self.config.download_limiter.slot():
            # Single-track jobs use the same progress path as batch tracks.
            job = _job.get()
            request = args[0] if args else kwargs["request"]
            name = request.metadata.title or request.search_query or "Unknown Track"
            if job and getattr(job[0], 'ledger', None):
                row = job[0].ledger.get(job[1])
                if not row or row['state'] not in ('queued', 'running') or row['attempt'] != job[2]:
                    raise JobCancelled()
                index = _job_item.get()
                if index is None:
                    entry = next((i for i in job[0].ledger.items(job[1]) if i['item'] == name and i['state'] == 'queued'), None)
                    index = entry['idx'] if entry else None
                if index is not None:
                    job[0].ledger.item_transition(job[1], index, job[2], 'running')
            if job:
                job[0].set_track_phase(job[1], name, "searching")
            try:
                result = await method(self, *args, **kwargs)
                if job and getattr(job[0], 'ledger', None):
                    job[0].ledger.outcome(job[1], name, success=result.success,
                        detail={'reason': result.error, 'kind': result.failure_kind} if not result.success else {'_result': {'path': str(result.file_path) if result.file_path else None, 'title': result.title, 'artist': result.artist}},
                        reason=result.failure_kind or 'error', attempt=job[2], idx=_job_item.get())
                if job and not result.success and hasattr(self, '_remember_failure'):
                    callback = args[1] if len(args) > 1 else kwargs.get('progress_cb')
                    if callback is None:
                        self._remember_failure(job[1], _job_item.get() or 0, request, result)
                return result
            finally:
                callback = args[1] if len(args) > 1 else kwargs.get("progress_cb")
                if job and callback is None:
                    job[0].update_progress(job[1], name)
    return run
