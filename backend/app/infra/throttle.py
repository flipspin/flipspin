"""Limit secret-guessing attempts with one in-memory bucket per endpoint.

Keep buckets global: caller-controlled addresses and usernames are unsafe keys.
See docs/DEVELOPER_GUIDE.md#secret-attempt-throttling.
"""
from __future__ import annotations

import threading
import time
from collections import deque


class FailureThrottle:
    """A sliding window of recent failures, shared by everyone hitting one route.

    Successes are deliberately never counted: the thing being limited is
    *guessing*, and a caller who got it right has stopped guessing.
    """

    def __init__(self, burst: int, window_seconds: float) -> None:
        self.burst = burst
        self.window_seconds = window_seconds
        self._lock = threading.Lock()
        self._failures: deque[float] = deque()

    def retry_after(self) -> int | None:
        """Seconds the caller must wait, or ``None`` if it may attempt now."""
        with self._lock:
            self._evict(time.monotonic())
            if len(self._failures) < self.burst:
                return None
            oldest = self._failures[0]
            remaining = self.window_seconds - (time.monotonic() - oldest)
            # Never advertise 0: a Retry-After of zero reads as "go ahead".
            return max(1, int(remaining) + 1)

    def record_failure(self) -> None:
        """Count one rejected attempt. Successes are deliberately not counted."""
        with self._lock:
            now = time.monotonic()
            self._evict(now)
            self._failures.append(now)

    def reset(self) -> None:
        """Forget every recorded failure. For tests and for a fresh process."""
        with self._lock:
            self._failures.clear()

    def _evict(self, now: float) -> None:
        """Drop failures that have aged out. Caller holds the lock."""
        cutoff = now - self.window_seconds
        while self._failures and self._failures[0] <= cutoff:
            self._failures.popleft()


__all__ = ["FailureThrottle"]
