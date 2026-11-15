"""Transient, bounded change nudges on the server's single asyncio loop."""
from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from itertools import islice
from threading import RLock

from pydantic import BaseModel

from app.infra.changes import Changes
from app.infra.identity import Principal
from app.infra.idempotency import canonical

SHARED_AREAS = ('library', 'analysis', 'jobs', 'lyrics', 'playlists', 'config', 'helpers', 'signin')
logger = logging.getLogger(__name__)


def revision_token(value) -> int | str:
    # Some provider projections contain settings (including secrets), paths or
    # live state. Only their opaque fingerprint may leave the server.
    if type(value) is int:
        return value
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class ChangeEvent(BaseModel):
    area: str
    rev: int | str
    ids: list[str] | None = None


class HelloEvent(BaseModel):
    bootId: str
    revisions: dict[str, int | str]


def visible(principal: Principal, area: str) -> bool:
    return principal.is_owner or area in SHARED_AREAS or area == f'me:{principal.user_id}'


@dataclass(eq=False)
class Subscription:
    principal: Principal
    queue: asyncio.Queue
    hello: HelloEvent
    closed: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class Batch:
    started: float
    ids: set[str] | None
    full: bool = False


class ChangeBus:
    def __init__(self, changes: Changes, *, debounce: float = .5, id_cap: int = 128,
                 queue_size: int = 64, principal_limit: int = 4, total_limit: int = 32):
        self.changes = changes
        self.debounce = debounce
        self.id_cap = id_cap
        self.queue_size = queue_size
        self.principal_limit = principal_limit
        self.total_limit = total_limit
        self._clients: list[Subscription] = []
        self._sequence = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._unlisten = None
        self._pending: dict[str, Batch] = {}
        self._timers: dict[str, asyncio.TimerHandle] = {}
        self._inbox: dict[str, Batch] = {}
        self._inbox_lock = RLock()

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def subscribe(self, principal: Principal, account_areas: Iterable[str] = ()) -> Subscription:
        """Register and snapshot without yielding, so no change can fall in a gap."""
        loop = asyncio.get_running_loop()
        first = not self._clients
        if first:
            self._loop = loop
            self._unlisten = self.changes.listen(self._notify)
        try:
            areas = set(SHARED_AREAS) | set(self.changes.areas()) | set(account_areas) | {f'me:{principal.user_id}'}
            hello = HelloEvent(bootId=self.changes.boot_id, revisions={
                area: self._revision(area) for area in sorted(areas) if visible(principal, area)
            })
        except Exception:
            if first:
                self._stop()
            raise
        client = Subscription(principal, asyncio.Queue(self.queue_size), hello)
        self._clients.append(client)
        # Add before evicting: replacing the only stream must not stop the bus.
        same_user = [c for c in self._clients if c.principal.user_id == principal.user_id]
        if len(same_user) > self.principal_limit:
            self.unsubscribe(same_user[0])
        if len(self._clients) > self.total_limit:
            self.unsubscribe(self._clients[0])
        return client

    def unsubscribe(self, client: Subscription) -> None:
        if client in self._clients:
            self._clients.remove(client)
        client.closed.set()
        # Release queued nudges immediately, including for a stalled sender.
        while not client.queue.empty():
            client.queue.get_nowait()
        if not self._clients:
            self._stop()

    def _stop(self) -> None:
        if self._unlisten:
            self._unlisten()
            self._unlisten = None
        for timer in self._timers.values():
            timer.cancel()
        self._timers.clear()
        self._pending.clear()
        with self._inbox_lock:
            self._loop = None
            self._inbox.clear()

    async def close(self) -> None:
        for client in tuple(self._clients):
            self.unsubscribe(client)

    def _revision(self, area: str) -> int | str:
        return revision_token(self.changes.revision(area))

    def _merge(self, target: Batch, incoming: Batch) -> None:
        target.full = target.full or incoming.full
        if target.ids is None or incoming.ids is None:
            target.ids = None
        else:
            target.ids.update(islice(incoming.ids, self.id_cap))
            if len(target.ids) >= self.id_cap:
                target.full = True
            if len(target.ids) > self.id_cap:
                target.ids = None

    def _notify(self, area: str, ids: Iterable[str] | None) -> None:
        """Coalesce on the writer thread before scheduling a single loop wakeup."""
        values = list(islice(ids, self.id_cap + 1)) if ids is not None else None
        full = values is not None and len(values) >= self.id_cap
        hints = set(values) if values is not None and len(values) <= self.id_cap else None
        with self._inbox_lock:
            loop = self._loop
            if loop is None:
                return
            batch = Batch(loop.time(), hints, full)
            if area in self._inbox:
                self._merge(self._inbox[area], batch)
            else:
                wake = not self._inbox
                self._inbox[area] = batch
                if wake:
                    loop.call_soon_threadsafe(self._drain)

    def _drain(self) -> None:
        with self._inbox_lock:
            inbox, self._inbox = self._inbox, {}
        if not self._clients:
            return
        for area, batch in inbox.items():
            self._schedule(area, batch)

    def _schedule(self, area: str, batch: Batch) -> None:
        if not self._clients:
            return
        if area in self._pending:
            self._merge(self._pending[area], batch)
        else:
            self._pending[area] = batch
            self._timers[area] = self._loop.call_at(batch.started + self.debounce, self._flush, area)
        if self._pending[area].full:
            self._flush(area)

    def _flush(self, area: str) -> None:
        batch = self._pending.pop(area)
        self._timers.pop(area).cancel()
        try:
            rev = self._revision(area)
        except Exception:
            logger.exception('Cannot read change revision for %s', area)
            # A lost nudge cannot be repaired by replay: force a fresh hello.
            for client in tuple(self._clients):
                self.unsubscribe(client)
            return
        self._sequence += 1
        event = ChangeEvent(area=area, rev=rev, ids=sorted(batch.ids) if batch.ids else None)
        for client in tuple(self._clients):
            if visible(client.principal, area):
                try:
                    client.queue.put_nowait((self._sequence, event))
                except asyncio.QueueFull:
                    self.unsubscribe(client)
