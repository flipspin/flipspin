"""Bounded failure windows per peer and username, plus a non-evictable global cap.

Valid credentials are resolved first: failed guessing cannot lock out a device
that still has access. Usernames are normalized and hashed before retention.
"""
from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict

from app.infra.throttle import FailureThrottle


class CredentialThrottle:
    def __init__(self, burst: int = 30, window_seconds: float = 60, max_buckets: int = 4096,
                 global_burst: int = 300):
        self.burst = burst
        self.window_seconds = window_seconds
        self.max_buckets = max_buckets
        self._lock = threading.Lock()
        self._global = FailureThrottle(global_burst, window_seconds)
        self._buckets: OrderedDict[tuple[str, str], tuple[float, FailureThrottle]] = OrderedDict()

    def reject(self, key: tuple[str, str]) -> bool:
        """Count a failure against each independent window, never the guessed secret."""
        peer, username = key
        keys = [('ip', peer)]
        if username:
            keys.append(('username', hashlib.sha256(username.strip().lower().encode()).hexdigest()))
        with self._lock:
            now = time.monotonic()
            while self._buckets:
                oldest, (stamp, _) = next(iter(self._buckets.items()))
                if now - stamp < self.window_seconds:
                    break
                del self._buckets[oldest]
            limited = self._global.retry_after() is not None
            if not limited:
                self._global.record_failure()
            for bucket_key in keys:
                _, bucket = self._buckets.pop(bucket_key, (now, FailureThrottle(self.burst, self.window_seconds)))
                if bucket.retry_after() is not None:
                    limited = True
                else:
                    bucket.record_failure()
                self._buckets[bucket_key] = (now, bucket)
            while len(self._buckets) > self.max_buckets:
                self._buckets.popitem(last=False)
            return limited

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()
            self._global.reset()
