"""Search Deezer for metadata candidates and recording identifiers.

Detect quota errors in HTTP 200 bodies; failed ISRC enrichment stays reviewable.
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

from app.config import ConfigManager
from app.domains.metadata.matching import Candidate
from app.exceptions import ExternalAPIError

DEEZER_API_BASE = "https://api.deezer.com"
PROVIDER_NAME = "deezer"

DEFAULT_TIMEOUT_S = 8.0
DEFAULT_ISRC_LOOKUPS = 3
MAX_SEARCH_LIMIT = 25

# Dashboard rows. `/chart` returns tracks, albums, artists AND playlists
# in a single response, so three of the dashboard's four rows cost one request,
# not three — which matters here because the quota below is measured, not
# published, and a dashboard is fetched on app open rather than during an import.
DEFAULT_CHART_LIMIT = 20
# Deezer silently clamps `limit` to 100 on /search (measured); assume the same ceiling here rather than sending a
# number the server will quietly ignore.
MAX_CHART_LIMIT = 100
# Editorial id 0 is "All" in GET /editorial (the others are genres: 132 Pop, ...).
ALL_EDITORIAL_ID = 0

# Deezer's typed search endpoints. Validated as a set membership rather than
# interpolated into the path, so `entity` can never carry a traversal segment.
SEARCHABLE_ENTITIES = frozenset({"artist", "album", "track", "playlist"})

# Deezer entity ids are decimal integers. Validated rather than int()-coerced:
# int() cheerfully accepts " +12 " and "-12", and a negative id would build a
# path segment beginning with "-". This is the single choke point where a
# caller-supplied id becomes part of a URL path.
_DEEZER_ID_RE = re.compile(r"^\d+$")
_ISRC_RE = re.compile(r"^[A-Z0-9]{12}$")

# Deezer's "no such object" error code (``{"error": {"type": "DataException",
# "message": "no data", "code": 800}}``, HTTP 200) — an unknown ISRC lands here.
NO_DATA_ERROR_CODE = 800

# Deezer reports quota exhaustion inside HTTP 200 rather than a status code.
# Pace below the observed 50 requests per five seconds to leave headroom for
# other clients sharing the IP. The limit is undocumented; retain backoff.
MIN_REQUEST_INTERVAL_S = 0.12

# Deezer's error code for an exhausted quota. Sent with HTTP 200, so the status
# code cannot be used to detect it. `type` is the useless "Exception" and the
# message is "Quota limit exceeded"; the code is the only stable part.
QUOTA_ERROR_CODE = 4

# Backoff for a quota error. Base 1 s doubling to an 8 s cap covers the ~3 s
# recovery measured above with room for a burst that overshot harder, and four
# attempts bound the worst case at 1+2+4 = 7 s of sleeping per request rather
# than an unbounded stall in the middle of a 2000-track import. There is no
# Retry-After header to obey, so the schedule supplies the retry budget.
QUOTA_RETRY_ATTEMPTS = 4
QUOTA_BACKOFF_BASE_S = 1.0
QUOTA_BACKOFF_CAP_S = 8.0



def _path_id(value: int | str) -> str:
    """Validate a Deezer entity id for use as a URL path segment.

    Raises:
        ValueError: anything that is not a run of decimal digits.
    """
    text = str(value).strip()
    if not _DEEZER_ID_RE.match(text):
        raise ValueError(f"invalid Deezer id {value!r}: expected decimal digits")
    return text


def _rows_of(payload: Any) -> list[dict[str, Any]]:
    """The ``data`` array of a list response, defensively.

    A missing or non-list ``data`` is an empty result, not an exception: Deezer
    answers some list endpoints with ``{"data": [], "total": 0}`` and HTTP 200
    (see :meth:`DeezerRepository.fetch_editorial_releases`), so "empty" is a
    shape this client has to survive rather than a failure to raise on.
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, dict)]


def _is_quota_error(error: Any) -> bool:
    """Is this ``error`` envelope Deezer saying "you are going too fast"?

    Deezer reports *every* error inside an HTTP 200 body — quota, invalid id,
    deprecated endpoint — so the envelope is the only place to look, and the
    only thing separating "wait and it will work" from "this will never work"
    is the code. Matched on ``code`` rather than on the message because the
    message is prose and prose gets reworded; the message is only a fallback
    for the synthetic envelope in :meth:`DeezerRepository._request_once`.
    """
    if not isinstance(error, dict):
        return False
    if error.get("code") == QUOTA_ERROR_CODE:
        return True
    message = error.get("message")
    return isinstance(message, str) and "quota" in message.lower()


class _RateLimiter:
    """Serialize requests, holding the lock across sleep to pace all worker threads.

    Keep provider pacing local: Deezer and MusicBrainz have different retry rules.
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


class DeezerRepository:
    """Read-only client for Deezer's public API. No auth, no tokens, no OAuth."""

    def __init__(
        self,
        config: ConfigManager,
        logger: logging.Logger,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        isrc_lookups: int | None = None,
        min_interval_s: float = MIN_REQUEST_INTERVAL_S,
        session: requests.Session | None = None,
        sleep: Callable[[float], None] = time.sleep,
        quota_retry_attempts: int = QUOTA_RETRY_ATTEMPTS,
    ):
        """Configure request pacing and explicit-quota retries.

        isrc_lookups controls extra track reads; zero disables enrichment. Injected
        session and sleep make quota schedules testable without network or delays.
        See docs/DEVELOPER_GUIDE.md#provider-request-budgets.
        """
        self.config = config
        self.logger = logger
        self.timeout_s = timeout_s
        self.isrc_lookups = self._resolve_isrc_lookups(isrc_lookups)
        self.session = session or requests.Session()
        self._sleep = sleep
        self.quota_retry_attempts = max(1, int(quota_retry_attempts))
        self._limiter = _RateLimiter(min_interval_s, sleep=sleep)

    @staticmethod
    def _resolve_isrc_lookups(explicit: int | None) -> int:
        if explicit is not None:
            return max(0, int(explicit))
        raw = os.getenv("KROBI_DEEZER_ISRC_LOOKUPS")
        if raw is None or not raw.strip():
            return DEFAULT_ISRC_LOOKUPS
        try:
            return max(0, int(raw.strip()))
        except ValueError:
            return DEFAULT_ISRC_LOOKUPS

    # ------------------------------------------------------------------ public

    def search_candidates(self, query: str, limit: int = 5) -> list[Candidate]:
        """Return candidates in Deezer relevance order, clamping limit to 1..25.

        Search failure raises ExternalAPIError; ISRC enrichment failure only reduces
        identity evidence and does not discard usable results.
        """
        if not query or not query.strip():
            return []

        capped = max(1, min(int(limit), MAX_SEARCH_LIMIT))
        payload = self._get("/search", {"q": query.strip(), "limit": capped})

        candidates: list[Candidate] = []
        for raw in payload.get("data") or []:
            candidate = self._to_candidate(raw)
            if candidate is not None:
                candidates.append(candidate)
            if len(candidates) >= capped:
                break

        self._enrich_with_isrcs(candidates)
        self.logger.debug("Deezer search %r -> %d candidates", query, len(candidates))
        return candidates

    def fetch_isrc(self, track_id: str) -> str | None:
        """Look up one track's ISRC via ``/track/{id}``.

        Returns None (never raises) when the lookup fails — an unidentifiable
        candidate is a review row, not a broken import.
        """
        if not track_id:
            return None
        try:
            payload = self._get(f"/track/{track_id}", None)
        except ExternalAPIError as e:
            self.logger.warning("Deezer ISRC lookup failed for track %s: %s", track_id, e.message)
            return None
        isrc = payload.get("isrc")
        return isrc.strip().upper() if isinstance(isrc, str) and isrc.strip() else None

    def fetch_track(self, track_id: int | str) -> dict[str, Any]:
        """``GET /track/{id}`` — one full track object (``preview``, ``isrc``, ``album``)."""
        return self._get(f"/track/{_path_id(track_id)}", None)

    def fetch_track_by_isrc(self, isrc: str) -> dict[str, Any] | None:
        """``GET /track/isrc:{ISRC}`` — the Deezer track for an ISRC, or None if Deezer has none.

        Raises:
            ValueError: not a 12-character ISRC (it is a URL path segment).
            ExternalAPIError: any other failure.
        """
        code = str(isrc or "").strip().upper().replace("-", "")
        if not _ISRC_RE.match(code):
            raise ValueError(f"invalid ISRC {isrc!r}: expected 12 letters/digits")
        try:
            payload = self._get(f"/track/isrc:{code}", None)
        except ExternalAPIError as e:
            error = e.details.get("deezer_error")
            if isinstance(error, dict) and error.get("code") == NO_DATA_ERROR_CODE:
                return None
            raise
        return payload if payload.get("id") is not None else None

    def fetch_chart(self, limit: int = DEFAULT_CHART_LIMIT, genre_id: int | str = 0) -> dict[str, Any]:
        """Return the raw chart envelope; the dashboard owns its presentation models.

        Genre zero selects all charts. Error envelopes, including quota errors inside
        HTTP 200, raise ExternalAPIError as for other repository calls.
        """
        capped = max(1, min(int(limit), MAX_CHART_LIMIT))
        path = "/chart" if str(genre_id) in ("0", "") else f"/chart/{_path_id(genre_id)}"
        return self._get(path, {"limit": capped})

    def fetch_genres(self) -> list[dict[str, Any]]:
        """``GET /genre`` — Deezer's genre list (id, name, picture_*).

        Includes id 0, "All", which is not a genre anyone browses into; callers
        drop it.
        """
        return _rows_of(self._get("/genre", None))

    def fetch_genre(self, genre_id: int | str) -> dict[str, Any]:
        """``GET /genre/{id}`` — one genre's name and picture."""
        return self._get(f"/genre/{_path_id(genre_id)}", None)

    def fetch_editorial_releases(
        self, editorial_id: int = ALL_EDITORIAL_ID, limit: int = DEFAULT_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """``GET /editorial/{id}/releases`` — new releases, as a list of albums."""
        return self._editorial_rows(editorial_id, "releases", limit)

    def fetch_editorial_selection(
        self, editorial_id: int = ALL_EDITORIAL_ID, limit: int = DEFAULT_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """Return editorial selections as an alternative to an empty releases endpoint.

        Both return album rows; callers choose when to fall back between them.
        """
        return self._editorial_rows(editorial_id, "selection", limit)

    # ------------------------------------------------------------------ browse
    #
    # Catalog navigation: fetch one entity by its Deezer id. Same contract as
    # everything above — raw envelopes, no mapping, ExternalAPIError on failure.
    # The browse domain owns the view shapes.

    def fetch_artist(self, artist_id: int | str) -> dict[str, Any]:
        """``GET /artist/{id}`` — one artist object."""
        return self._get(f"/artist/{_path_id(artist_id)}", None)

    def fetch_artist_top(
        self, artist_id: int | str, limit: int = DEFAULT_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """``GET /artist/{id}/top`` — the artist's most-played tracks."""
        return self._list_rows(f"/artist/{_path_id(artist_id)}/top", limit)

    def fetch_artist_albums(
        self, artist_id: int | str, limit: int = MAX_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """``GET /artist/{id}/albums`` — discography.

        Rows carry ``record_type`` (album/single/ep) and ``release_date``, which
        is what lets the artist page group and sort them rather than dumping one
        undifferentiated grid.
        """
        return self._list_rows(f"/artist/{_path_id(artist_id)}/albums", limit)

    def fetch_artist_related(
        self, artist_id: int | str, limit: int = DEFAULT_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """``GET /artist/{id}/related`` — similar artists."""
        return self._list_rows(f"/artist/{_path_id(artist_id)}/related", limit)

    def fetch_artist_playlists(
        self, artist_id: int | str, limit: int = DEFAULT_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """``GET /artist/{id}/playlists`` — playlists featuring the artist."""
        return self._list_rows(f"/artist/{_path_id(artist_id)}/playlists", limit)

    def fetch_album(self, album_id: int | str) -> dict[str, Any]:
        """``GET /album/{id}`` — album header: title, artist, cover, label, date.

        This response *also* carries an inline ``tracks.data`` array, and that
        array is not the tracklist to use. See :meth:`fetch_album_tracks`.
        """
        return self._get(f"/album/{_path_id(album_id)}", None)

    def fetch_album_tags(self, album_id: int | str) -> tuple[list[tuple[str, str]], int | None]:
        """Read Spanish genres and release year together from one album page.

        Acquisition only writes Spanish tags. Display translations belong to
        clients and do not require a second, English album request.
        """
        raw = self._get(f"/album/{_path_id(album_id)}", None, {"Accept-Language": "es"})
        rows = (raw.get("genres") or {}).get("data") or []
        pairs = [(g["name"].strip(), g["name"].strip()) for g in rows
                 if isinstance(g, dict) and isinstance(g.get("name"), str) and g["name"].strip()]
        date = str(raw.get("release_date") or "")
        year = int(date[:4]) if date[:4].isdigit() and date[:4] != "0000" else None
        return pairs, year

    def fetch_album_genres(self, album_id: int | str) -> list[tuple[str, str]]:
        """Pair Spanish and English album genres by id, preserving Deezer's order.

        Genre names depend on Accept-Language. A missing English name falls back to
        the Spanish name rather than dropping the genre.
        """
        path = f"/album/{_path_id(album_id)}"
        def names(lang: str) -> list[tuple[Any, str]]:
            data = self._get(path, None, {"Accept-Language": lang}).get("genres") or {}
            rows = data.get("data") if isinstance(data, dict) else None
            return [
                (g.get("id"), str(g.get("name")).strip())
                for g in rows or []
                if isinstance(g, dict) and str(g.get("name") or "").strip()
            ]
        es = names("es")
        if not es:
            return []
        en = dict(names("en"))
        return [(name, en.get(gid) or name) for gid, name in es]

    def fetch_album_release_year(self, album_id: int | str) -> int | None:
        """``release_date``'s year, or None. Served from the same album object."""
        date = str(self.fetch_album(album_id).get("release_date") or "")
        return int(date[:4]) if date[:4].isdigit() and date[:4] != "0000" else None

    def search_albums(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """``GET /search/album`` rows, raw."""
        return _rows_of(self._get("/search/album", {"q": query, "limit": limit}))

    def search_tracks_raw(self, query: str, limit: int = 10) -> list[dict[str, Any]]:
        """``GET /search/track`` rows, raw (``search_candidates`` maps them)."""
        return _rows_of(self._get("/search/track", {"q": query, "limit": limit}))

    def fetch_album_tracks(
        self, album_id: int | str, limit: int = MAX_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """Fetch /album/{id}/tracks with recording ids and track/disc positions.

        Do not substitute inline album tracks, which can omit these fields.
        See docs/DEVELOPER_GUIDE.md#provider-request-budgets.
        """
        return self._list_rows(f"/album/{_path_id(album_id)}/tracks", limit)

    def fetch_playlist(self, playlist_id: int | str) -> dict[str, Any]:
        """``GET /playlist/{id}`` — playlist header *and* its tracks.

        Unlike an album, the inline ``tracks.data`` here does carry ``isrc``
        (same probe), so a playlist costs one request rather than two. The
        asymmetry comes from Deezer.
        """
        return self._get(f"/playlist/{_path_id(playlist_id)}", None)

    def search_autocomplete(self, query: str, limit: int = DEFAULT_CHART_LIMIT) -> dict[str, Any]:
        """Undocumented combined endpoint; always uses the shared paced client."""
        return self._get("/search/autocomplete", {
            "q": query.strip(), "limit": max(1, min(int(limit), MAX_SEARCH_LIMIT)),
        })

    def search_entities(
        self, entity: str, query: str, limit: int = DEFAULT_CHART_LIMIT
    ) -> list[dict[str, Any]]:
        """``GET /search/{entity}`` — typed catalog search.

        ``entity`` is one of ``SEARCHABLE_ENTITIES`` and is validated against
        that set rather than interpolated blind, keeping the no-path-injection
        property that ``_editorial_rows`` documents for its own ``section``.

        Raises:
            ValueError: unknown entity. A caller typo is a bug, not a 502.
        """
        if entity not in SEARCHABLE_ENTITIES:
            raise ValueError(
                f"unknown Deezer search entity {entity!r}; "
                f"expected one of {sorted(SEARCHABLE_ENTITIES)}"
            )
        if not query or not query.strip():
            return []
        capped = max(1, min(int(limit), MAX_SEARCH_LIMIT))
        payload = self._get(f"/search/{entity}", {"q": query.strip(), "limit": capped})
        return _rows_of(payload)

    # ----------------------------------------------------------------- private

    def _list_rows(self, path: str, limit: int) -> list[dict[str, Any]]:
        """One list endpoint call, normalized to a list of dicts.

        The browse counterpart of :meth:`_editorial_rows`. ``path`` is always
        built by a caller above from an ``_path_id``-coerced id and a literal
        segment, never from caller-supplied text.
        """
        capped = max(1, min(int(limit), MAX_CHART_LIMIT))
        return _rows_of(self._get(path, {"limit": capped}))

    def _editorial_rows(
        self, editorial_id: int, section: str, limit: int
    ) -> list[dict[str, Any]]:
        """One ``/editorial/{id}/{section}`` call, normalized to a list of dicts.

        ``section`` is never caller-supplied text — the two public wrappers above
        are its only callers and each passes a literal, so no path injection
        surface is opened here.
        """
        capped = max(1, min(int(limit), MAX_CHART_LIMIT))
        payload = self._get(f"/editorial/{int(editorial_id)}/{section}", {"limit": capped})
        data = payload.get("data")
        if not isinstance(data, list):
            return []
        return [row for row in data if isinstance(row, dict)]

    def _enrich_with_isrcs(self, candidates: list[Candidate]) -> None:
        """Fill in ISRCs for the top N candidates that still lack one.

        Now usually a no-op: ``/search`` began returning ``isrc`` inline, so
        ``_to_candidate`` fills it and the loop below skips every candidate.
        Kept as the fallback rather than deleted — the field is undocumented
        (Deezer's API reference is behind a login wall) and appeared without
        announcement, so it can disappear the same way. If it does, this
        silently starts paying for lookups again instead of dropping every
        Deezer-only resolution to REVIEW.
        """
        if self.isrc_lookups <= 0:
            return
        for candidate in candidates[: self.isrc_lookups]:
            if candidate.isrc:
                continue
            candidate.isrc = self.fetch_isrc(candidate.provider_id)

    @staticmethod
    def _to_candidate(raw: Any) -> Candidate | None:
        """Map one Deezer search row. ``duration`` is SECONDS on this API."""
        if not isinstance(raw, dict):
            return None
        track_id = raw.get("id")
        title = raw.get("title")
        if track_id is None or not isinstance(title, str) or not title.strip():
            return None

        artist = raw.get("artist")
        album = raw.get("album")

        # Deezer's `duration` is already in seconds — unlike Spotify's
        # `duration_ms` and MusicBrainz's `length`. Dividing here would put
        # every candidate 1000x under the duration veto in matching.py and
        # silently disarm it.
        duration = raw.get("duration")
        duration_s = float(duration) if isinstance(duration, (int, float)) and duration > 0 else None

        # Use inline ISRCs to avoid enrichment requests. Keep the track-lookup fallback
        # for responses that omit them.
        isrc = raw.get("isrc")
        isrc = isrc.strip().upper() if isinstance(isrc, str) and isrc.strip() else None

        return Candidate(
            title=title.strip(),
            provider=PROVIDER_NAME,
            provider_id=str(track_id),
            artist=(artist or {}).get("name") if isinstance(artist, dict) else None,
            album=(album or {}).get("title") if isinstance(album, dict) else None,
            duration_s=duration_s,
            isrc=isrc,
            recording_mbid=None,
            cover_url=next((album.get(k) for k in ("cover_xl", "cover_big", "cover_medium", "cover") if album.get(k)), None) if isinstance(album, dict) else None,
        )

    def _get(
        self, path: str, params: dict[str, Any] | None, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        """One GET, retried only while Deezer says the quota is exhausted.

        The retry is narrow on purpose. A quota error is the one failure that is
        *known to be temporary* and *known to clear on its own* — the window is
        five seconds wide and this client is the thing filling it. Everything
        else (timeout, DNS, 500, a malformed body, an invalid track id) is
        retried by nobody here: the caller either degrades to the other provider
        or sends the track to review, both of which are cheaper than hammering a
        provider that is already unhappy.
        """
        url = f"{DEEZER_API_BASE}{path}"
        delay = QUOTA_BACKOFF_BASE_S
        for attempt in range(1, self.quota_retry_attempts + 1):
            payload = self._request_once(url, params, headers)
            error = payload.get("error")
            if not error:
                return payload
            if not _is_quota_error(error) or attempt == self.quota_retry_attempts:
                message = error.get("message") if isinstance(error, dict) else str(error)
                raise ExternalAPIError(
                    f"Deezer error: {message}",
                    api_name=PROVIDER_NAME,
                    details={"deezer_error": error, "attempts": attempt},
                )
            self.logger.info(
                "Deezer quota exhausted on %s (attempt %d/%d); backing off %.1fs",
                path, attempt, self.quota_retry_attempts, delay,
            )
            self._sleep(delay)
            delay = min(delay * 2, QUOTA_BACKOFF_CAP_S)
        # Unreachable: the loop either returns or raises on its last attempt.
        raise ExternalAPIError("Deezer quota retry loop exited", api_name=PROVIDER_NAME)

    def _request_once(
        self, url: str, params: dict[str, Any] | None, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        """One paced GET normalized to a dict. Never inspects ``error``."""
        self._limiter.wait()
        try:
            if headers:
                response = self.session.get(url, params=params, headers=headers, timeout=self.timeout_s)
            else:
                response = self.session.get(url, params=params, timeout=self.timeout_s)
            # Treat HTTP 429 as throttling too, alongside Deezer's HTTP 200 quota envelope.
            if getattr(response, "status_code", None) == 429:
                return {"error": {"code": QUOTA_ERROR_CODE, "message": "HTTP 429 Too Many Requests"}}
            response.raise_for_status()
            payload = response.json()
        except requests.RequestException as e:
            raise ExternalAPIError(
                f"Deezer request failed: {e}", api_name=PROVIDER_NAME, original_error=e
            )
        except ValueError as e:  # non-JSON body
            raise ExternalAPIError(
                f"Deezer returned a non-JSON response: {e}",
                api_name=PROVIDER_NAME,
                original_error=e,
            )

        if not isinstance(payload, dict):
            raise ExternalAPIError(
                "Deezer returned an unexpected payload shape", api_name=PROVIDER_NAME
            )
        return payload
