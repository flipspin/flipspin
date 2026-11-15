"""Summarize the data disk without repeatedly walking large libraries.

Cache music and stem totals per path. Derive other from used minus those sums,
floored at zero when content lives on another disk.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from collections.abc import Callable
from pathlib import Path

TTL_SECONDS = 300.0

_lock = threading.Lock()
_cache: dict[str, tuple[float, int]] = {}


def tree_size(root: Path) -> int:
    """Bytes held by the regular files under ``root``. Symlinks are not followed.

    A missing root is 0 (no stems yet); an unreadable entry is skipped rather
    than failing the whole answer.
    """
    total = 0
    stack = [str(root)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def cached_tree_size(
    root: Path,
    *,
    now: Callable[[], float] = time.monotonic,
    measure: Callable[[Path], int] = tree_size,
) -> int:
    """``tree_size`` memoized for ``TTL_SECONDS`` per resolved path.

    The walk runs outside the lock: two requests racing past an expired entry
    may both walk once, which is cheaper than holding every caller behind one
    slow walk.
    """
    key = str(root)
    with _lock:
        hit = _cache.get(key)
        if hit is not None and now() - hit[0] < TTL_SECONDS:
            return hit[1]
    size = measure(root)
    with _lock:
        _cache[key] = (now(), size)
    return size


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def storage_snapshot(data_dir: Path, music_dir: Path, stems_dir: Path) -> dict:
    """``{disk: {total, free}, music, stems, other}`` in bytes."""
    usage = shutil.disk_usage(data_dir)
    music = cached_tree_size(music_dir)
    stems = cached_tree_size(stems_dir)
    used = usage.total - usage.free
    return {
        "disk": {"total": usage.total, "free": usage.free},
        "music": music,
        "stems": stems,
        "other": max(0, used - music - stems),
    }
