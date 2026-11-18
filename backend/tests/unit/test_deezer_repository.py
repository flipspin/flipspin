"""Pin Deezer duration units, inline/fallback ISRC, and quota-envelope handling.

Incorrect units disable recording checks; missing identifiers prevent strong
matches. Fake sessions measure request and retry budgets without network.
"""
from unittest.mock import Mock

import pytest
import requests

from app.domains.metadata.deezer_repository import DeezerRepository, _RateLimiter
from app.exceptions import ExternalAPIError

# Trimmed from a real api.deezer.com/search response.
SEARCH_PAYLOAD = {
    "data": [
        {
            "id": 3135556,
            "readable": True,
            "title": "Harder, Better, Faster, Stronger",
            "title_short": "Harder, Better, Faster, Stronger",
            "duration": 224,
            "rank": 900000,
            "explicit_lyrics": False,
            "artist": {"id": 27, "name": "Daft Punk", "type": "artist"},
            "album": {"id": 302127, "title": "Discovery", "type": "album"},
            "type": "track",
        },
        {
            "id": 3135557,
            "title": "One More Time",
            "duration": 320,
            "artist": {"id": 27, "name": "Daft Punk"},
            "album": {"id": 302127, "title": "Discovery"},
            "type": "track",
        },
        {"title": "row with no id"},  # skipped
    ],
    "total": 3,
}

TRACK_PAYLOAD = {"id": 3135556, "title": "Harder, Better, Faster, Stronger", "isrc": "gbduw0000059"}


def _resp(payload, status=200):
    resp = Mock()
    resp.status_code = status
    resp.json = Mock(return_value=payload)
    if status >= 400:
        resp.raise_for_status = Mock(side_effect=requests.HTTPError(f"{status}"))
    else:
        resp.raise_for_status = Mock()
    return resp


def _session(handler):
    session = Mock()
    session.get = Mock(side_effect=handler)
    return session


def _repo(handler, **kwargs):
    kwargs.setdefault("isrc_lookups", 0)
    kwargs.setdefault("min_interval_s", 0)
    # No test may sleep for real: quota backoff is measured in seconds and the
    # suite is measured in milliseconds. Tests that care pass their own.
    kwargs.setdefault("sleep", Mock())
    return DeezerRepository(
        config=Mock(), logger=Mock(), session=_session(handler), **kwargs
    )


def _routing_handler(search=SEARCH_PAYLOAD, track=TRACK_PAYLOAD):
    def handler(url, **kwargs):
        if "/search" in url:
            return _resp(search)
        if "/track/" in url:
            return _resp(track)
        raise AssertionError(f"unexpected url {url}")
    return handler


class TestSearchMapping:
    def test_maps_a_real_shaped_payload_to_sane_candidates(self):
        repo = _repo(_routing_handler())
        candidates = repo.search_candidates("daft punk discovery")

        assert len(candidates) == 2  # the id-less row is dropped
        first = candidates[0]
        assert first.title == "Harder, Better, Faster, Stronger"
        assert first.artist == "Daft Punk"
        assert first.album == "Discovery"
        assert first.provider == "deezer"
        assert first.provider_id == "3135556"
        assert first.recording_mbid is None

    def test_duration_is_seconds_and_is_not_divided(self):
        """Deezer's `duration` is already seconds — 224, not 0.224 and not 224000."""
        repo = _repo(_routing_handler())
        candidates = repo.search_candidates("daft punk")
        assert candidates[0].duration_s == 224.0
        assert candidates[1].duration_s == 320.0

    def test_missing_or_zero_duration_becomes_none_not_zero(self):
        payload = {"data": [{"id": 1, "title": "T", "duration": 0}]}
        repo = _repo(_routing_handler(search=payload))
        assert repo.search_candidates("x")[0].duration_s is None

    def test_blank_query_makes_no_request(self):
        repo = _repo(_routing_handler())
        assert repo.search_candidates("   ") == []
        repo.session.get.assert_not_called()

    def test_limit_is_clamped_and_passed_through(self):
        repo = _repo(_routing_handler())
        repo.search_candidates("x", limit=500)
        assert repo.session.get.call_args.kwargs["params"]["limit"] == 25

    def test_every_request_sets_a_timeout(self):
        repo = _repo(_routing_handler())
        repo.search_candidates("x")
        assert repo.session.get.call_args.kwargs["timeout"] > 0


class TestIsrcEnrichment:
    def test_fetches_isrc_for_the_top_n_only(self):
        repo = _repo(_routing_handler(), isrc_lookups=1)
        candidates = repo.search_candidates("daft punk")

        assert candidates[0].isrc == "GBDUW0000059"  # normalized to upper
        assert candidates[1].isrc is None
        track_calls = [c for c in repo.session.get.call_args_list if "/track/" in c.args[0]]
        assert len(track_calls) == 1
        assert track_calls[0].args[0].endswith("/track/3135556")

    def test_enrichment_can_be_switched_off(self):
        repo = _repo(_routing_handler(), isrc_lookups=0)
        candidates = repo.search_candidates("daft punk")
        assert all(c.isrc is None for c in candidates)
        assert not any("/track/" in c.args[0] for c in repo.session.get.call_args_list)

    def test_isrc_makes_the_candidate_identifiable(self):
        """The whole point: identifiable candidates can be auto-accepted."""
        repo = _repo(_routing_handler(), isrc_lookups=1)
        candidates = repo.search_candidates("daft punk")
        assert candidates[0].is_identifiable is True
        assert candidates[1].is_identifiable is False

    def test_failed_isrc_lookup_degrades_but_does_not_raise(self):
        def handler(url, **kwargs):
            if "/search" in url:
                return _resp(SEARCH_PAYLOAD)
            raise requests.ConnectionError("boom")

        repo = _repo(handler, isrc_lookups=2)
        candidates = repo.search_candidates("daft punk")
        assert len(candidates) == 2
        assert all(c.isrc is None for c in candidates)

    @pytest.mark.parametrize("raw,expected", [("0", 0), ("2", 2), ("nonsense", 3), ("", 3)])
    def test_depth_is_configurable_by_env(self, monkeypatch, raw, expected):
        monkeypatch.setenv("KROBI_DEEZER_ISRC_LOOKUPS", raw)
        repo = DeezerRepository(config=Mock(), logger=Mock(), session=Mock(), min_interval_s=0)
        assert repo.isrc_lookups == expected


class TestFailureHandling:
    def test_network_error_raises_external_api_error(self):
        def handler(url, **kwargs):
            raise requests.Timeout("timed out")

        with pytest.raises(ExternalAPIError) as excinfo:
            _repo(handler).search_candidates("x")
        assert excinfo.value.details["api_name"] == "deezer"

    def test_error_envelope_inside_a_200_is_detected(self):
        """Deezer reports *every* error with HTTP 200 and an `error` object."""
        payload = {"error": {"type": "DataException", "message": "no data", "code": 800}}
        with pytest.raises(ExternalAPIError) as excinfo:
            _repo(_routing_handler(search=payload)).search_candidates("x")
        assert "no data" in excinfo.value.message

    def test_a_non_quota_error_is_not_retried(self):
        """Permanent missing-track errors must not consume retry attempts."""
        calls = []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp({"error": {"type": "DataException", "message": "no data", "code": 800}})

        with pytest.raises(ExternalAPIError):
            _repo(handler).search_candidates("x")
        assert len(calls) == 1

    def test_http_error_status_raises(self):
        def handler(url, **kwargs):
            return _resp({}, status=500)

        with pytest.raises(ExternalAPIError):
            _repo(handler).search_candidates("x")

    def test_non_json_body_raises(self):
        def handler(url, **kwargs):
            resp = Mock(status_code=200)
            resp.raise_for_status = Mock()
            resp.json = Mock(side_effect=ValueError("not json"))
            return resp

        with pytest.raises(ExternalAPIError):
            _repo(handler).search_candidates("x")


QUOTA_PAYLOAD = {"error": {"type": "Exception", "message": "Quota limit exceeded", "code": 4}}


class TestQuotaBackoff:
    """Retry Deezer's transient quota envelope even though HTTP status is 200.

    No Retry-After header describes the quota window, so the client owns pacing
    and bounded backoff.
    """

    def test_a_quota_error_is_retried_and_then_succeeds(self):
        calls, slept = [], []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp(QUOTA_PAYLOAD if len(calls) < 3 else SEARCH_PAYLOAD)

        candidates = _repo(handler, sleep=slept.append).search_candidates("daft punk")

        assert len(candidates) == 2  # the import keeps going
        assert len(calls) == 3
        assert slept == [pytest.approx(1.0), pytest.approx(2.0)]  # exponential

    def test_backoff_is_capped_and_gives_up_saying_how_hard_it_tried(self):
        calls, slept = [], []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp(QUOTA_PAYLOAD)

        with pytest.raises(ExternalAPIError) as excinfo:
            _repo(handler, sleep=slept.append, quota_retry_attempts=6).search_candidates("x")

        assert "Quota limit exceeded" in excinfo.value.message
        assert excinfo.value.details["attempts"] == 6
        assert len(calls) == 6
        # 1, 2, 4, 8, then capped at 8 — never an unbounded stall mid-import.
        assert slept == [pytest.approx(v) for v in (1.0, 2.0, 4.0, 8.0, 8.0)]

    def test_retries_can_be_switched_off(self):
        calls = []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp(QUOTA_PAYLOAD)

        with pytest.raises(ExternalAPIError):
            _repo(handler, quota_retry_attempts=1).search_candidates("x")
        assert len(calls) == 1

    def test_an_http_429_is_treated_as_the_same_throttle(self):
        """Not observed in the wild, but free to handle and fatal to ignore."""
        calls, slept = [], []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp({}, status=429) if len(calls) == 1 else _resp(SEARCH_PAYLOAD)

        candidates = _repo(handler, sleep=slept.append).search_candidates("daft punk")

        assert len(candidates) == 2
        assert slept == [pytest.approx(1.0)]

    def test_a_throttled_isrc_lookup_still_degrades_quietly(self):
        """Backoff must not turn a survivable enrichment miss into a failure."""
        def handler(url, **kwargs):
            if "/search" in url:
                return _resp(SEARCH_PAYLOAD)
            return _resp(QUOTA_PAYLOAD)

        candidates = _repo(handler, isrc_lookups=1).search_candidates("daft punk")
        assert len(candidates) == 2
        assert candidates[0].isrc is None


class TestRateLimiter:
    def test_paces_requests_without_real_sleeping(self):
        slept, now = [], [0.0]

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        limiter = _RateLimiter(0.12, sleep=sleep, clock=lambda: now[0])
        limiter.wait()  # first call is free
        limiter.wait()
        assert slept == [pytest.approx(0.12)]

    def test_no_sleep_when_enough_time_already_passed(self):
        slept, now = [], [0.0]
        limiter = _RateLimiter(0.12, sleep=slept.append, clock=lambda: now[0])
        limiter.wait()
        now[0] = 5.0
        limiter.wait()
        assert slept == []

    def test_the_default_pace_stays_under_the_measured_ceiling(self):
        """~50 requests / 5 s is the measured ceiling; the default must undershoot.

        Pinned as arithmetic rather than as a magic number so that changing
        MIN_REQUEST_INTERVAL_S to something optimistic fails here instead of in
        production, where the symptom is other people's Deezer traffic breaking
        too — the quota is per IP, not per process.
        """
        repo = DeezerRepository(config=Mock(), logger=Mock(), session=Mock())
        per_five_seconds = 5.0 / repo._limiter.min_interval_s
        assert per_five_seconds < 50


class TestInlineIsrcFromSearch:
    """Prefer inline ISRC to avoid extra quota use while retaining enrichment fallback.

    SEARCH_PAYLOAD omits ISRC so other tests continue to exercise track lookups.
    """

    INLINE = {
        "data": [
            {
                "id": 3135553,
                "title": "One More Time",
                "duration": 320,
                "isrc": "gbduw0000053",
                "artist": {"id": 27, "name": "Daft Punk"},
                "album": {"id": 302127, "title": "Discovery"},
            }
        ],
        "total": 1,
    }

    def test_inline_isrc_is_read_and_needs_no_extra_request(self):
        seen = []

        def handler(url, **kwargs):
            seen.append(url)
            if "/search" in url:
                return _resp(self.INLINE)
            raise AssertionError(f"should not have called {url}")

        # isrc_lookups=3 is the production default: enrichment is armed and
        # must simply find nothing left to do.
        repo = _repo(handler, isrc_lookups=3)
        candidates = repo.search_candidates("daft punk one more time", limit=1)

        assert candidates[0].isrc == "GBDUW0000053", "normalized to upper case"
        assert candidates[0].is_identifiable, "an ISRC is what makes STRONG reachable"
        assert not any("/track/" in url for url in seen)

    def test_enrichment_still_runs_when_the_field_is_absent(self):
        """The fallback must survive Deezer withdrawing the field again."""
        seen = []

        def handler(url, **kwargs):
            seen.append(url)
            if "/search" in url:
                return _resp(SEARCH_PAYLOAD)
            if "/track/" in url:
                return _resp(TRACK_PAYLOAD)
            raise AssertionError(f"unexpected url {url}")

        repo = _repo(handler, isrc_lookups=1)
        candidates = repo.search_candidates("daft punk")

        assert candidates[0].isrc == "GBDUW0000059"
        assert any("/track/" in url for url in seen)


class TestTrackLookups:
    ISRC_TRACK = {"id": 3129801, "title": "Ashes the Rain and I", "isrc": "USMC10201513",
                  "preview": "https://cdnt-preview.dzcdn.net/x.mp3", "duration": 299}

    def test_fetch_track_by_isrc_hits_the_isrc_path(self):
        repo = _repo(lambda url, **kw: _resp(self.ISRC_TRACK))
        assert repo.fetch_track_by_isrc(" usmc1-0201513 ") == self.ISRC_TRACK
        assert repo.session.get.call_args.args[0] == "https://api.deezer.com/track/isrc:USMC10201513"

    def test_unknown_isrc_is_none_not_an_error(self):
        no_data = {"error": {"type": "DataException", "message": "no data", "code": 800}}
        repo = _repo(lambda url, **kw: _resp(no_data))
        assert repo.fetch_track_by_isrc("USMC10201513") is None

    def test_other_deezer_errors_still_raise(self):
        bad = {"error": {"type": "OAuthException", "message": "nope", "code": 300}}
        repo = _repo(lambda url, **kw: _resp(bad))
        with pytest.raises(ExternalAPIError):
            repo.fetch_track_by_isrc("USMC10201513")

    def test_invalid_isrc_never_reaches_the_network(self):
        repo = _repo(lambda url, **kw: _resp(self.ISRC_TRACK))
        for bad in ("", "123", "USMC1020151/", "../track/1"):
            with pytest.raises(ValueError):
                repo.fetch_track_by_isrc(bad)
        repo.session.get.assert_not_called()

    def test_fetch_track(self):
        repo = _repo(lambda url, **kw: _resp(self.ISRC_TRACK))
        assert repo.fetch_track(3129801)["id"] == 3129801
        assert repo.session.get.call_args.args[0] == "https://api.deezer.com/track/3129801"
        with pytest.raises(ValueError):
            repo.fetch_track("isrc:USMC10201513")


class TestBrowseAutocompleteTransport:
    def test_combined_endpoint_uses_existing_paced_get_once(self):
        payload = {"artists": {"data": []}, "albums": {"data": []},
                   "tracks": {"data": []}, "playlists": {"data": []}}
        repo = _repo(lambda url, **kwargs: _resp(payload))
        from unittest.mock import Mock
        repo._limiter.wait = Mock()
        assert repo.search_autocomplete(" dua ", limit=3) == payload
        repo._limiter.wait.assert_called_once()
        repo.session.get.assert_called_once()
        assert repo.session.get.call_args.args[0] == "https://api.deezer.com/search/autocomplete"
        assert repo.session.get.call_args.kwargs["params"] == {"q": "dua", "limit": 3}
