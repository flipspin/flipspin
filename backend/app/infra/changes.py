"""Area revisions supplied by writers or composed sources of truth."""
from collections.abc import Callable, Iterable, Mapping
from threading import RLock
from uuid import uuid4


class Changes:
    def __init__(self, providers: Mapping[str, Callable] | None = None, *, wired: Iterable[str] = ()):
        self.boot_id = uuid4().hex
        self._providers = dict(providers or {})
        self._wired = frozenset(wired)
        self._counters: dict[str, int] = {}
        self._lock = RLock()
        self._listeners: set[Callable] = set()

    def revision(self, area: str):
        provider = self._providers.get(area)
        if provider is not None:
            return provider()
        with self._lock:
            return self._counters.get(area, 0)

    def bump(self, area: str, ids: Iterable[str] | None = None) -> None:
        # Providers still own their revisions; listeners receive transient nudges.
        with self._lock:
            self._counters[area] = self._counters.get(area, 0) + 1
            for listener in self._listeners:
                listener(area, ids)

    def counter(self, area: str) -> int:
        with self._lock:
            return self._counters.get(area, 0)

    def wired(self, area: str) -> bool:
        return area in self._wired or (area.startswith('me:') and 'me:<account>' in self._wired)

    def listen(self, listener: Callable) -> Callable[[], None]:
        with self._lock:
            self._listeners.add(listener)

        def remove():
            with self._lock:
                self._listeners.discard(listener)
        return remove

    def areas(self) -> set[str]:
        with self._lock:
            return (set(self._wired) | self._providers.keys() | self._counters.keys()) - {'me:<account>'}

    def provider_revisions(self, overrides: Mapping[str, Callable] | None = None) -> dict:
        providers = {**self._providers, **(overrides or {})}
        return {area: provider() for area, provider in providers.items()}
