"""Search MusicBrainz for recording metadata and MBIDs.

Identify the application in User-Agent and serialize requests through the limiter.
See docs/DEVELOPER_GUIDE.md#provider-request-budgets.
"""
import logging
import os
import re
import threading
import time
from typing import Any
from collections.abc import Callable

import requests

from app.config import APP_VERSION, ConfigManager
from app.domains.metadata.matching import Candidate
from app.domains.metadata.normalization import strip_noise
from app.exceptions import ExternalAPIError

MUSICBRAINZ_API_BASE = "https://musicbrainz.org/ws/2"
PROVIDER_NAME = "musicbrainz"

DEFAULT_TIMEOUT_S = 10.0
MAX_SEARCH_LIMIT = 25

# MusicBrainz permits one request per second per source IP. Leave headroom
# because its limiter measures arrival time, which includes network jitter.
# https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
MIN_REQUEST_INTERVAL_S = 1.1

# A 503 can mean per-IP throttling or service saturation. Back off before
# retrying; after two retries, let another provider resolve the track.
THROTTLE_RETRY_ATTEMPTS = 3
THROTTLE_BACKOFF_BASE_S = 2.0
THROTTLE_BACKOFF_CAP_S = 8.0

# Where to reach the operator of this client. Overridable with
# KROBI_MUSICBRAINZ_CONTACT so a fork/self-host supplies its own contact identity.
DEFAULT_CONTACT = "https://github.com/flipspin/flipspin"

# Lucene syntax characters that must be escaped in a free-text query, or the
# search 400s on a title containing a colon or a stray bracket.
_LUCENE_SPECIALS = re.compile(r'([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)')

# Lookup ids are interpolated into the URL path, so they are validated first.
_MBID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_ISRC_RE = re.compile(r"^[A-Z0-9]{12}$")

# Relation targets include artist-credit only when artist-credits is requested.
# Performance dates may come from the relation's begin field; targets do not
# carry first-release-date.
RECORDING_LOOKUP_INC = ("recording-rels", "work-rels", "url-rels", "isrcs", "artist-credits", "releases")
WORK_LOOKUP_INC = ("recording-rels", "artist-credits")
ISRC_LOOKUP_INC = ("artist-credits",)


def artist_credit_text(credits: Any) -> str | None:
    """Rebuild the display artist from an ``artist-credit`` list, honouring join phrases ("X feat. Y")."""
    if not isinstance(credits, list):
        return None
    parts: list[str] = []
    for credit in credits:
        if isinstance(credit, str):
            parts.append(credit)
            continue
        if not isinstance(credit, dict):
            continue
        name = credit.get("name")
        if not name:
            artist = credit.get("artist")
            name = artist.get("name") if isinstance(artist, dict) else None
        if name:
            parts.append(str(name))
        join = credit.get("joinphrase")
        if join:
            parts.append(str(join))
    joined = "".join(parts).strip()
    return joined or None


class _Throttled(Exception):
    """Internal signal: MusicBrainz answered 503, so wait and try again.

    Not an :class:`ExternalAPIError` because it never leaves this module — it
    exists so the retry loop can tell "throttled, transient" apart from every
    other failure without re-inspecting a status code it already read.
    """


class _RateLimiter:
    """Serialize requests, holding the lock across sleep to pace all worker threads.

    Keep provider pacing local: MusicBrainz rejects excess traffic with 503,
    while Deezer has different error and retry rules.
    """

    def __init__(
        self,
        min_interval_s: float,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.min_interval_s = max(0.0, min_interval_s)
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.Lock()
        self._last_at: float | None = None

    def wait(self) -> None:
        if self.min_interval_s <= 0:
            return
        with self._lock:
            now = self._clock()
            if self._last_at is not None:
                remaining = self.min_interval_s - (now - self._last_at)
                if remaining > 0:
                    self._sleep(remaining)
                    now = self._clock()
            self._last_at = now


class MusicBrainzRepository:
    """Read-only client for the MusicBrainz web service. No auth required."""

    def __init__(
        self,
        config: ConfigManager,
        logger: logging.Logger,
        contact: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        min_interval_s: float = MIN_REQUEST_INTERVAL_S,
        session: requests.Session | None = None,
        sleep: Callable[[float], None] = time.sleep,
        throttle_retry_attempts: int = THROTTLE_RETRY_ATTEMPTS,
    ):
        """Configure a descriptive User-Agent, pacing, and bounded 503 retries.

        Contact falls back through config, environment, and DEFAULT_CONTACT. Inject
        session and sleep to test request schedules without network or real delays.
        """
        self.config = config
        self.logger = logger
        self.contact = (
            contact
            or getattr(config, "musicbrainz_contact", None)
            or os.getenv("KROBI_MUSICBRAINZ_CONTACT")
            or DEFAULT_CONTACT
        )
        self.timeout_s = timeout_s
        self.session = session or requests.Session()
        self._sleep = sleep
        self.throttle_retry_attempts = max(1, int(throttle_retry_attempts))
        self._limiter = _RateLimiter(min_interval_s, sleep=sleep)

    @property
    def user_agent(self) -> str:
        """The MusicBrainz-mandated descriptive User-Agent with contact info."""
        return f"Flipspin/{APP_VERSION} ( {self.contact} )"

    # ------------------------------------------------------------------ public

    def search_candidates(self, query: str, limit: int = 5) -> list[Candidate]:
        """Return recording candidates in MusicBrainz relevance order.

        Limit is clamped to 1..25. Transport, rejected User-Agent, and non-JSON
        responses raise ExternalAPIError.
        """
        if not query or not query.strip():
            return []
        return self._search(self._escape(strip_noise(query) or query), limit)

    def search_recordings(
        self, title: str, artist: str | None = None, limit: int = 5
    ) -> list[Candidate]:
        """Fielded search — markedly better than free text when the artist is known.

        ``recording:"Get Lucky" AND artist:"Daft Punk"`` scores far more sharply
        than the same words thrown at the general index, which matters because
        an export supplies no duration to corroborate with.
        """
        if not title or not title.strip():
            return []
        clauses = [f'recording:"{self._escape_phrase(strip_noise(title) or title)}"']
        cleaned_artist = strip_noise(artist or "") if artist else ""
        if cleaned_artist:
            clauses.append(f'artist:"{self._escape_phrase(cleaned_artist)}"')
        return self._search(" AND ".join(clauses), limit)

    def lookup_recording(
        self, mbid: str, inc: tuple[str, ...] | list[str] = RECORDING_LOOKUP_INC
    ) -> dict[str, Any]:
        """``GET /recording/{mbid}?inc=…`` — the raw recording, relations included.

        Parsing stays with the caller: relation shapes
        are MusicBrainz's, documented at /relationships/recording-recording.

        Raises:
            ValueError: ``mbid`` is not a UUID.
            ExternalAPIError: request failed (404 carries ``details["status"]``).
        """
        return self._get(f"/recording/{self._mbid(mbid)}", self._lookup_params(inc))

    def search_releases(self, title: str, artist: str | None = None, *, free_text=False, limit=5):
        """Release search through this repository's shared pacing and User-Agent."""
        query = self._escape(title) if free_text else f'release:"{self._escape_phrase(title)}"'
        if artist and not free_text:
            query += f' AND artist:"{self._escape_phrase(artist)}"'
        return self._get('/release', {'query': query, 'fmt': 'json', 'limit': max(1, min(limit, 5))}).get('releases', [])

    def lookup_release(self, mbid: str):
        return self._get(f'/release/{self._mbid(mbid)}', self._lookup_params(
            ('recordings', 'artist-credits', 'isrcs', 'release-groups')))

    def lookup_work(
        self, work_mbid: str, inc: tuple[str, ...] | list[str] = WORK_LOOKUP_INC
    ) -> dict[str, Any]:
        """``GET /work/{mbid}?inc=…`` — the raw work (with ``recording-rels``: its performances)."""
        return self._get(f"/work/{self._mbid(work_mbid)}", self._lookup_params(inc))

    def lookup_isrc(
        self, isrc: str, inc: tuple[str, ...] | list[str] = ISRC_LOOKUP_INC
    ) -> dict[str, Any] | None:
        """``GET /isrc/{isrc}?inc=…`` — the recordings carrying this ISRC, or None if unknown.

        MusicBrainz answers an ISRC it has never seen with a 404; that is an
        empty answer, not a failure.
        """
        code = str(isrc or "").strip().upper().replace("-", "")
        if not _ISRC_RE.match(code):
            raise ValueError(f"invalid ISRC {isrc!r}: expected 12 letters/digits")
        try:
            return self._get(f"/isrc/{code}", self._lookup_params(inc))
        except ExternalAPIError as e:
            if e.details.get("status") == 404:
                return None
            raise

    # ----------------------------------------------------------------- private

    @staticmethod
    def _mbid(value: str) -> str:
        text = str(value or "").strip().lower()
        if not _MBID_RE.match(text):
            raise ValueError(f"invalid MusicBrainz id {value!r}: expected a UUID")
        return text

    @staticmethod
    def _lookup_params(inc: tuple[str, ...] | list[str]) -> dict[str, Any]:
        params: dict[str, Any] = {"fmt": "json"}
        if inc:
            params["inc"] = "+".join(inc)
        return params

    def _search(self, lucene_query: str, limit: int) -> list[Candidate]:
        capped = max(1, min(int(limit), MAX_SEARCH_LIMIT))
        payload = self._get(
            "/recording",
            {"query": lucene_query, "fmt": "json", "limit": capped},
        )
        candidates: list[Candidate] = []
        for raw in payload.get("recordings") or []:
            candidate = self._to_candidate(raw)
            if candidate is not None:
                candidates.append(candidate)
            if len(candidates) >= capped:
                break
        self.logger.debug(
            "MusicBrainz search %r -> %d candidates", lucene_query, len(candidates)
        )
        return candidates

    @staticmethod
    def _escape(text: str) -> str:
        return _LUCENE_SPECIALS.sub(r"\\\1", text or "")

    @staticmethod
    def _escape_phrase(text: str) -> str:
        """Inside a quoted phrase only ``\\`` and ``"`` need escaping."""
        return (text or "").replace("\\", "\\\\").replace('"', '\\"')

    @classmethod
    def _to_candidate(cls, raw: Any) -> Candidate | None:
        """Map one recording. ``length`` is MILLISECONDS on this API."""
        if not isinstance(raw, dict):
            return None
        mbid = raw.get("id")
        title = raw.get("title")
        if not isinstance(mbid, str) or not mbid:
            return None
        if not isinstance(title, str) or not title.strip():
            return None

        # MusicBrainz reports `length` in milliseconds — the opposite of
        # Deezer's `duration`, which is seconds. Forgetting the /1000 here makes
        # every candidate look ~1000x too long, which trips the duration veto in
        # matching.py and rejects every MusicBrainz result.
        length = raw.get("length")
        duration_s = (
            float(length) / 1000.0
            if isinstance(length, (int, float)) and length > 0
            else None
        )

        isrcs = raw.get("isrcs")
        isrc = isrcs[0] if isinstance(isrcs, list) and isrcs and isinstance(isrcs[0], str) else None

        return Candidate(
            title=title.strip(),
            provider=PROVIDER_NAME,
            # The recording MBID *is* the MusicBrainz identity, so it is both
            # the provider id and the identity key — no second lookup needed.
            provider_id=mbid,
            artist=cls._artist_credit(raw.get("artist-credit")),
            album=cls._first_release_title(raw.get("releases")),
            duration_s=duration_s,
            isrc=isrc,
            recording_mbid=mbid,
        )

    @staticmethod
    def _artist_credit(credits: Any) -> str | None:
        """Rebuild the display artist, honouring join phrases ("X feat. Y")."""
        return artist_credit_text(credits)

    @staticmethod
    def _first_release_title(releases: Any) -> str | None:
        if not isinstance(releases, list):
            return None
        for release in releases:
            if isinstance(release, dict):
                title = release.get("title")
                if isinstance(title, str) and title.strip():
                    return title.strip()
        return None

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        """One rate-limited, identified GET, retried only on a 503.

        503 is the *only* status MusicBrainz uses for throttling — per-IP rate,
        anonymous-User-Agent pool, and global saturation all come back as 503 —
        and it is transient by definition, so it is the only one worth waiting
        out. Everything else fails immediately: 403 will never change, and a
        timeout or a 500 is cheaper to hand to the other provider than to sit on.
        """
        delay = THROTTLE_BACKOFF_BASE_S
        for attempt in range(1, self.throttle_retry_attempts + 1):
            try:
                return self._request_once(path, params)
            except _Throttled as e:
                if attempt == self.throttle_retry_attempts:
                    raise ExternalAPIError(
                        f"MusicBrainz is rate-limiting or unavailable (503) after "
                        f"{attempt} attempts. The resolution falls back to the other "
                        "provider.",
                        api_name=PROVIDER_NAME,
                        details={"status": 503, "attempts": attempt},
                    ) from e
                self.logger.info(
                    "MusicBrainz 503 on %s (attempt %d/%d); backing off %.1fs",
                    path, attempt, self.throttle_retry_attempts, delay,
                )
                self._sleep(delay)
                delay = min(delay * 2, THROTTLE_BACKOFF_CAP_S)
        # Unreachable: the loop either returns or raises on its last attempt.
        raise ExternalAPIError("MusicBrainz retry loop exited", api_name=PROVIDER_NAME)

    def _request_once(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        """One paced, identified GET. Raises :class:`_Throttled` on a 503."""
        url = f"{MUSICBRAINZ_API_BASE}{path}"
        headers = {"User-Agent": self.user_agent, "Accept": "application/json"}
        self._limiter.wait()
        try:
            response = self.session.get(
                url, params=params, headers=headers, timeout=self.timeout_s
            )
            status = getattr(response, "status_code", None)
            if status == 403:
                # The single most common way this integration dies. Do not
                # retry — the request will be refused identically forever.
                raise ExternalAPIError(
                    "MusicBrainz refused the request (403). This almost always means the "
                    f"User-Agent was missing or rejected; sent {self.user_agent!r}. Set "
                    "KROBI_MUSICBRAINZ_CONTACT to a reachable URL or email.",
                    api_name=PROVIDER_NAME,
                    details={"status": 403, "user_agent": self.user_agent},
                )
            if status == 503:
                raise _Throttled()
            if status == 404:
                # A lookup of an id MusicBrainz does not know (or an ISRC it has
                # never seen). Tagged so callers can tell "absent" from "broken".
                raise ExternalAPIError(
                    f"MusicBrainz has no such entity: {path}",
                    api_name=PROVIDER_NAME,
                    details={"status": 404},
                )
            response.raise_for_status()
            payload = response.json()
        except requests.RequestException as e:
            raise ExternalAPIError(
                f"MusicBrainz request failed: {e}", api_name=PROVIDER_NAME, original_error=e
            )
        except ValueError as e:  # non-JSON body (an HTML error page, typically)
            raise ExternalAPIError(
                f"MusicBrainz returned a non-JSON response: {e}",
                api_name=PROVIDER_NAME,
                original_error=e,
            )

        if not isinstance(payload, dict):
            raise ExternalAPIError(
                "MusicBrainz returned an unexpected payload shape", api_name=PROVIDER_NAME
            )
        return payload
