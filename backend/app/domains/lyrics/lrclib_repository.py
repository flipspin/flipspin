"""Query LRCLIB for synced lyrics without requiring a key.

Try the exact title/artist/album/duration signature before search. Search keeps
duration near misses for the service to rank. Pace requests and back off on
429; publishing uses LRCLIB's proof-of-work protocol. https://lrclib.net/docs
"""
from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
import os
import threading
import time
from typing import Any
from collections.abc import Callable
from collections import OrderedDict
from copy import deepcopy

import requests

from app.config import APP_VERSION, ConfigManager
from app.domains.lyrics.models import LyricsCandidate, LyricsQuery

DEFAULT_BASE_URL = "https://lrclib.net/api"
DEFAULT_CONTACT = "https://github.com/flipspin/flipspin"
#: Client-side pacing. Lower it only in tests.
MIN_INTERVAL_S = 1.0
#: How many results ``/api/search`` may hand back to the caller.
SEARCH_LIMIT = 10


def retry_after_seconds(value: str | None, default: float = 5.0) -> float:
    try:
        return max(1.0, float(value or default))
    except (TypeError, ValueError):
        try:
            return max(1.0, (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return default


class CatalogRateLimited(requests.HTTPError):
    status_code = 429

    def __init__(self, retry_after: float):
        super().__init__("LRCLIB: HTTP 429 Too Many Requests (rate-limited)")
        self.retry_after = max(1, math.ceil(retry_after))


class LrclibRepository:
    """Thin, paced HTTP client. Never raises for "no lyrics"; only for transport."""

    def __init__(
        self,
        config: ConfigManager,
        logger: logging.Logger,
        *,
        base_url: str = DEFAULT_BASE_URL,
        contact: str | None = None,
        timeout_s: float = 10.0,
        min_interval_s: float = MIN_INTERVAL_S,
        session: requests.Session | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.config = config
        self.logger = logger
        self.base_url = base_url.rstrip("/")
        self.contact = (
            contact
            or getattr(config, "musicbrainz_contact", None)
            or os.getenv("KROBI_MUSICBRAINZ_CONTACT")
            or DEFAULT_CONTACT
        )
        self.timeout_s = timeout_s
        self.min_interval_s = min_interval_s
        self.session = session or requests.Session()
        self.sleep = sleep
        self._lock = threading.Lock()
        self._last_request_at = 0.0
        self._rate_limited_until = 0.0
        self._cache: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()

    @property
    def user_agent(self) -> str:
        return f"Flipspin/{APP_VERSION} ( {self.contact} )"

    # ------------------------------------------------------------------ http

    def _get(self, path: str, params: dict[str, Any]) -> Any | None:
        """One paced GET. ``None`` for a 404 (LRCLIB's "no lyrics")."""
        key = (path, tuple(sorted(params.items())))
        # Serialize the request AND retry: concurrent library/manual searches
        # must not bypass pacing or make duplicate calls for the same song.
        with self._lock:
            cached = self._cache.get(key)
            if cached and time.monotonic() - cached[0] < 900:
                self._cache.move_to_end(key)
                return deepcopy(cached[1])
            if time.monotonic() < self._rate_limited_until:
                raise CatalogRateLimited(self._rate_limited_until - time.monotonic())
            headers = {"User-Agent": self.user_agent, "Lrclib-Client": self.user_agent}
            for attempt in range(2):
                wait = self.min_interval_s - (time.monotonic() - self._last_request_at)
                if wait > 0:
                    self.sleep(wait)
                self._last_request_at = time.monotonic()
                response = self.session.get(
                    f"{self.base_url}{path}", params=params, headers=headers, timeout=self.timeout_s
                )
                if response.status_code != 429 or attempt:
                    break
                retry_after = retry_after_seconds(response.headers.get("Retry-After"))
                self.logger.warning("LRCLIB throttled us; waiting %.0fs", retry_after)
                self.sleep(min(retry_after, 30.0))
            if response.status_code == 404:
                return None
            if response.status_code == 429:
                # A shared cooldown keeps background scans and repeated clicks
                # from immediately starting another pair of throttled requests.
                self._rate_limited_until = time.monotonic() + max(60.0, retry_after_seconds(response.headers.get("Retry-After")))
                raise CatalogRateLimited(self._rate_limited_until - time.monotonic())
            response.raise_for_status()
            data = response.json()
            # Cache successful answers, never failures or empty search results.
            if data:
                self._cache[key] = (time.monotonic(), deepcopy(data))
                self._cache.move_to_end(key)
                while len(self._cache) > 256:
                    self._cache.popitem(last=False)
            return data

    # --------------------------------------------------------------- queries

    def get_exact(self, query: LyricsQuery) -> LyricsCandidate | None:
        """``/api/get`` — the one-request path. Needs album and duration."""
        if not query.album or query.duration_s is None:
            return None
        data = self._get(
            "/get",
            {
                "track_name": query.title,
                "artist_name": query.artist,
                "album_name": query.album,
                "duration": int(round(query.duration_s)),
            },
        )
        return self._candidate(data) if isinstance(data, dict) else None

    def search(self, query: LyricsQuery, limit: int = SEARCH_LIMIT) -> list[LyricsCandidate]:
        """``/api/search`` by title + artist. Unranked; the service sorts."""
        params: dict[str, Any] = {"track_name": query.title}
        if query.artist:
            params["artist_name"] = query.artist
        data = self._get("/search", params)
        if not isinstance(data, list):
            return []
        out: list[LyricsCandidate] = []
        for row in data[:limit]:
            candidate = self._candidate(row)
            if candidate is not None:
                out.append(candidate)
        return out

    # --------------------------------------------------------------- mapping

    @staticmethod
    def _candidate(row: Any) -> LyricsCandidate | None:
        if not isinstance(row, dict):
            return None
        synced = (row.get("syncedLyrics") or "").strip() or None
        plain = (row.get("plainLyrics") or "").strip() or None
        instrumental = bool(row.get("instrumental"))
        if not synced and not plain and not instrumental:
            return None
        ident = row.get("id")
        duration = row.get("duration")
        return LyricsCandidate(
            provider="lrclib",
            title=str(row.get("trackName") or ""),
            artist=str(row.get("artistName") or ""),
            album=str(row.get("albumName") or ""),
            duration_s=float(duration) if isinstance(duration, (int, float)) else None,
            synced_lyrics=synced,
            plain_lyrics=plain,
            instrumental=instrumental,
            provider_ref=f"lrclib:{ident}" if ident is not None else None,
            url=f"https://lrclib.net/api/get/{ident}" if ident is not None else None,
        )
