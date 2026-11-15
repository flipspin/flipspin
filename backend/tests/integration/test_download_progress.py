"""Check progress snapshots and SSE for unknown, active, and terminal jobs.

Unknown ids fail before opening a stream; terminal snapshots close it.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.dependencies import get_progress_tracker
from app.infra.progress import ProgressTracker
from app.domains.downloads.routes import progress_event_stream


def _events(chunk):
    """Parse SSE text into a list of (event_name, data_dict) tuples.

    Heartbeat comment lines (`: ...`) are ignored; an event with no explicit name
    defaults to ``"message"`` (the EventSource default).
    """
    parsed = []
    for block in chunk.split("\n\n"):
        name, data = "message", None
        for line in block.splitlines():
            if line.startswith("data:"):
                data = json.loads(line[len("data:"):].strip())
            elif line.startswith("event:"):
                name = line[len("event:"):].strip()
        if data is not None:
            parsed.append((name, data))
    return parsed


@pytest.fixture
def client_and_tracker():
    """Inject a controlled progress tracker through the real dependency boundary."""
    tracker = ProgressTracker()
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    try:
        yield TestClient(app), tracker
    finally:
        app.dependency_overrides.pop(get_progress_tracker, None)


def test_unknown_progress_id_returns_404_not_500(client_and_tracker):
    client, _ = client_and_tracker
    resp = client.get("/api/download-progress/does-not-exist")
    assert resp.status_code == 404


def test_known_progress_returns_frontend_shape(client_and_tracker):
    client, tracker = client_and_tracker
    tracker.create_progress("pid1", total=3)
    tracker.update_progress("pid1", "Song A.mp3")
    tracker.update_progress("pid1", "Song B.mp3")

    resp = client.get("/api/download-progress/pid1")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["status"] == "in_progress"
    # Frontend polls `done`; `items` is kept as an alias for the same list.
    assert body["done"] == ["Song A.mp3", "Song B.mp3"]
    assert body["items"] == body["done"]
    assert body["completed"] == 2


def test_stream_unknown_progress_id_returns_404(client_and_tracker):
    """Unknown IDs 404 before the stream opens (parity with the polling endpoint)."""
    client, _ = client_and_tracker
    resp = client.get("/api/download-progress-stream/does-not-exist")
    assert resp.status_code == 404


# Drive the async generator directly and mutate between snapshots.

@pytest.mark.asyncio
async def test_stream_generator_emits_incremental_then_terminal_and_stops():
    """Generator pushes the current snapshot, then a terminal one, then stops."""
    tracker = ProgressTracker()
    tracker.create_progress("pid", total=2)
    tracker.update_progress("pid", "A.mp3")

    gen = progress_event_stream(tracker, "pid")

    (name, first), = _events(await anext(gen))
    assert name == "message"
    assert first["terminal"] is False
    assert first["status"] == "in_progress"
    assert first["done"] == ["A.mp3"]

    # Mutate before advancing, so the generator sees a new version and never blocks.
    tracker.update_progress("pid", "B.mp3")
    tracker.complete_progress("pid", "Downloaded 2/2 tracks")

    (name, final), = _events(await anext(gen))
    assert final["terminal"] is True
    assert final["status"] == "Downloaded 2/2 tracks"
    assert final["done"] == ["A.mp3", "B.mp3"]

    # Terminal snapshot ends the stream.
    with pytest.raises(StopAsyncIteration):
        await anext(gen)


@pytest.mark.asyncio
async def test_stream_generator_of_finished_progress_emits_terminal_once():
    """Opening a stream on already-finished work yields one terminal event, then stops."""
    tracker = ProgressTracker()
    tracker.create_progress("pid", total=1)
    tracker.update_progress("pid", "Only.mp3")
    tracker.complete_progress("pid", "done")

    gen = progress_event_stream(tracker, "pid")

    (name, payload), = _events(await anext(gen))
    assert payload["terminal"] is True
    assert payload["status"] == "done"
    assert payload["done"] == ["Only.mp3"]

    with pytest.raises(StopAsyncIteration):
        await anext(gen)


@pytest.mark.asyncio
async def test_stream_generator_emits_heartbeat_when_idle():
    """With no change, the generator parks then flushes a heartbeat comment."""
    tracker = ProgressTracker()
    tracker.create_progress("pid", total=5)

    # Short heartbeat so the idle wait returns quickly without any mutation.
    gen = progress_event_stream(tracker, "pid", heartbeat=0.05)

    await anext(gen)  # initial in_progress snapshot
    heartbeat = await anext(gen)  # no change → wait times out → keep-alive comment
    assert heartbeat.startswith(":")
    assert _events(heartbeat) == []


@pytest.mark.asyncio
async def test_stream_generator_ends_if_entry_deleted_midstream():
    """If the tracked entry is deleted mid-stream, the generator emits `end`, stops."""
    tracker = ProgressTracker()
    tracker.create_progress("pid", total=2)

    gen = progress_event_stream(tracker, "pid")
    await anext(gen)  # initial snapshot

    tracker.delete_progress("pid")
    end_chunk = await anext(gen)
    (name, data), = _events(end_chunk)
    assert name == "end"

    with pytest.raises(StopAsyncIteration):
        await anext(gen)


@pytest.mark.asyncio
async def test_idle_streams_wait_without_worker_threads(monkeypatch):
    import asyncio

    tracker = ProgressTracker()
    tracker.create_progress('pid', 1)
    def blocking_wait(*args, **kwargs):
        pytest.fail('SSE occupied a worker thread')
    monkeypatch.setattr(tracker, 'wait_for_change', blocking_wait)
    streams = [progress_event_stream(tracker, 'pid') for _ in range(50)]
    for stream in streams:
        await anext(stream)
    pending = [asyncio.create_task(anext(stream)) for stream in streams]
    await asyncio.sleep(0)
    assert all(not task.done() for task in pending)
    await asyncio.to_thread(tracker.complete_progress, 'pid', 'done')
    snapshots = await asyncio.wait_for(asyncio.gather(*pending), 1)
    assert all(_events(snapshot)[0][1]['terminal'] for snapshot in snapshots)
    for stream in streams:
        await stream.aclose()
    assert not tracker._async_waiters


@pytest.mark.asyncio
async def test_stream_snapshot_lock_does_not_block_the_event_loop():
    import asyncio
    import threading

    tracker = ProgressTracker()
    tracker.create_progress('pid', 1)
    locked, release = threading.Event(), threading.Event()

    def slow_producer():
        with tracker._cond:
            locked.set()
            release.wait(2)

    producer = asyncio.create_task(asyncio.to_thread(slow_producer))
    assert await asyncio.to_thread(locked.wait, 1)
    stream = progress_event_stream(tracker, 'pid')
    snapshot = asyncio.create_task(anext(stream))
    try:
        await asyncio.sleep(0.01)
        # Snapshot reads and waiter registration must both leave the loop free
        # while a producer holds the state lock for a durable ledger operation.
        assert not snapshot.done()
        version = tracker.current_version()
        assert await tracker.wait_for_change_async(version, timeout=0.001) == version
    finally:
        release.set()
        await producer
        await snapshot
        await stream.aclose()
