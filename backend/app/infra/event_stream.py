"""Async SSE transport with bounded writes and event-driven disconnection."""
import json

import anyio
from starlette.responses import Response

from app.infra.change_bus import ChangeBus, Subscription
from app.infra.stream_lifetime import RevocableStreamResponse


def frame(event: str, data: dict, sequence: int | None = None) -> bytes:
    prefix = f'id: {sequence}\n' if sequence is not None else ''
    return f'{prefix}event: {event}\ndata: {json.dumps(data, separators=(",", ":"))}\n\n'.encode()


class _ChangeTransport(Response):
    media_type = 'text/event-stream'

    def __init__(self, bus: ChangeBus, client: Subscription, *, heartbeat: float = 15, send_timeout: float = 20):
        super().__init__(headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
        del self.headers['content-length']
        self.bus = bus
        self.client = client
        self.heartbeat = heartbeat
        self.send_timeout = send_timeout

    async def __call__(self, scope, receive, send):
        async def write(message):
            with anyio.fail_after(self.send_timeout):
                await send(message)

        async def stream():
            try:
                await write({'type': 'http.response.start', 'status': self.status_code, 'headers': self.raw_headers})
                await write({'type': 'http.response.body', 'body': frame('hello', self.client.hello.model_dump()),
                             'more_body': True})
                while not self.client.closed.is_set():
                    with anyio.move_on_after(self.heartbeat) as timeout:
                        sequence, event = await self.client.queue.get()
                    body = b': heartbeat\n\n' if timeout.cancel_called else frame(
                        'change', event.model_dump(exclude_none=True), sequence)
                    await write({'type': 'http.response.body', 'body': body, 'more_body': True})
            except (TimeoutError, OSError):
                # Slow/broken transports resync through hello on reconnect.
                pass

        async def disconnect():
            while (await receive())['type'] != 'http.disconnect':
                pass

        async def until_done(work):
            try:
                await work()
            finally:
                group.cancel_scope.cancel()

        try:
            async with anyio.create_task_group() as group:
                group.start_soon(until_done, stream)
                group.start_soon(until_done, disconnect)
                group.start_soon(until_done, self.client.closed.wait)
        finally:
            self.bus.unsubscribe(self.client)
        # Finish a clean response too (queue overflow / connection replacement).
        try:
            await write({'type': 'http.response.body', 'body': b'', 'more_body': False})
        except (TimeoutError, OSError):
            pass
        if self.background is not None:
            await self.background()


class ChangeEventResponse(RevocableStreamResponse):
    media_type = 'text/event-stream'

    def __init__(self, bus: ChangeBus, client: Subscription, *, heartbeat: float = 15, send_timeout: float = 20):
        transport = _ChangeTransport(bus, client, heartbeat=heartbeat, send_timeout=send_timeout)
        super().__init__(transport, bus.streams, client.lifetime)
        self.bus = bus
        self.client = client
        self.heartbeat = heartbeat
        self.send_timeout = send_timeout
