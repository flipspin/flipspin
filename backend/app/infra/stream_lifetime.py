"""Device-scoped stream cancellation, including writes already in flight."""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass, field
from threading import RLock

import anyio
from starlette.responses import Response

from app.infra.identity import Principal, TokenResolver


def check_stream_principal(principal: Principal, resolver: TokenResolver) -> None:
    """Close the gap between dependency resolution and stream registration.

    Call on the serving loop immediately before registration, without yielding.
    Synthetic principals have no revocable account/device row.
    """
    if principal.device_id is not None:
        record = resolver.get_user(principal.user_id)
        if record is None or record.device(principal.device_id) is None:
            from fastapi import HTTPException
            raise HTTPException(401, 'Access was revoked')


@dataclass(eq=False)
class StreamLifetime:
    principal: Principal
    loop: asyncio.AbstractEventLoop
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    stopped: Future = field(default_factory=Future)
    active: bool = False
    on_close: Callable[[], None] | None = None

    def close(self) -> None:
        """Only called on this stream's loop."""
        if not self.closed.is_set():
            self.closed.set()
            if self.on_close is not None:
                self.on_close()
        if not self.active and not self.stopped.done():
            self.stopped.set_result(None)


class PrincipalStreams:
    def __init__(self):
        self._streams: set[StreamLifetime] = set()
        self._lock = RLock()

    def subscribe(self, principal: Principal) -> StreamLifetime:
        stream = StreamLifetime(principal, asyncio.get_running_loop())
        with self._lock:
            self._streams.add(stream)
        return stream

    def discard(self, stream: StreamLifetime) -> None:
        stream.close()
        if not stream.active:
            with self._lock:
                self._streams.discard(stream)

    async def revoke(self, *, user_id: str | None = None, device_id: str | None = None) -> None:
        with self._lock:
            streams = [s for s in self._streams
                       if (user_id is None or s.principal.user_id == user_id)
                       and (device_id is None or s.principal.device_id == device_id)]
        for stream in streams:
            if stream.loop is asyncio.get_running_loop():
                stream.close()
            else:
                # Tests and embedded ASGI clients may use more than one loop.
                stream.loop.call_soon_threadsafe(stream.close)
        # Returning means even an in-flight, blocked send has been cancelled.
        for stream in streams:
            await asyncio.shield(asyncio.wrap_future(stream.stopped))
            with self._lock:
                self._streams.discard(stream)


class RevocableStreamResponse(Response):
    """Wrap either SSE transport without changing its headers or event frames."""
    def __init__(self, response: Response, streams: PrincipalStreams, lifetime: StreamLifetime):
        self.response = response
        self.streams = streams
        self.lifetime = lifetime
        self.status_code = response.status_code
        self.raw_headers = response.raw_headers
        self.background = response.background
        response.background = None

    async def __call__(self, scope, receive, send):
        lifetime = self.lifetime
        started = ended = False

        async def guarded_send(message):
            nonlocal started, ended
            if lifetime.closed.is_set():
                return
            await send(message)
            if message['type'] == 'http.response.start':
                started = True
            elif message['type'] == 'http.response.body' and not message.get('more_body', False):
                ended = True

        async def run():
            try:
                await self.response(scope, receive, guarded_send)
            finally:
                group.cancel_scope.cancel()

        async def revoked():
            await lifetime.closed.wait()
            group.cancel_scope.cancel()

        try:
            if not lifetime.closed.is_set():
                lifetime.active = True
                async with anyio.create_task_group() as group:
                    group.start_soon(run)
                    group.start_soon(revoked)
            # Complete the HTTP response after cancelling outstanding data writes.
            with anyio.move_on_after(getattr(self.response, 'send_timeout', .1)):
                if not started:
                    await send({'type': 'http.response.start', 'status': self.status_code, 'headers': self.raw_headers})
                if not ended:
                    await send({'type': 'http.response.body', 'body': b'', 'more_body': False})
        except OSError:
            pass
        finally:
            lifetime.active = False
            self.streams.discard(lifetime)
        if self.background is not None:
            await self.background()
