"""Request-local cover reuse and durable, query-keyed source search answers."""
import asyncio
from contextvars import ContextVar
from threading import Lock
from .sources.compat import LEGACY_SOURCE_ID

# Context follows asyncio.to_thread into the finishing worker. Standalone engine
# callers still work without a pipeline or a durable acquisition store.
current_lookups = ContextVar('acquisition_lookups', default=None)


class RequestLookups:
    def __init__(self, store):
        self.store = store
        self._covers = {}
        self._cover_lock = Lock()
        self._search_locks = {}

    def cover(self, url, load):
        with self._cover_lock:
            if url not in self._covers:
                try:
                    self._covers[url] = load()
                except Exception:
                    # A broken cover is best effort, once per request as well.
                    self._covers[url] = None
                    raise
            return self._covers[url]

    async def search(self, provider, query, *, wanted=None):
        source = getattr(provider, 'source_id', None)
        source = source if isinstance(source, str) else LEGACY_SOURCE_ID
        key = self.store.search_key(query, source)
        async with self._search_locks.setdefault(key, asyncio.Lock()):
            cached = await asyncio.to_thread(self.store.search_get, query, source)
            if cached is not None:
                return cached
            rows = await provider.search_source(query, max_results=10, wanted=wanted)
            if rows:
                await asyncio.to_thread(self.store.search_put, query, rows, source)
            return rows
