"""Fire-and-forget work started by a request, kept alive until it finishes.

``asyncio.create_task`` holds only a weak reference to its task, so a job that
nothing else references can be garbage-collected mid-run. Every route that
answers with a ``progress_id`` and keeps working afterwards (downloads, imports,
catalog acquisitions, Spotify-export resolution) starts that work here, and
this one set holds all of them until they complete.
"""
from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any

_BACKGROUND_TASKS: set[asyncio.Task[Any]] = set()


def spawn_background(coro: Coroutine[Any, Any, Any]) -> asyncio.Task[Any]:
    """Schedule ``coro`` on the running loop and keep it alive until it finishes."""
    task = asyncio.create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return task
