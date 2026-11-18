"""Pin MusicBrainz identification, pacing, retry, and duration conversion.

Fake sessions distinguish missing User-Agent failures from 503 throttling
and verify millisecond conversion without network requests.
"""
from unittest.mock import Mock

import pytest
import requests

from app.config import APP_VERSION
from app.domains.metadata.musicbrainz_repository import (
    MusicBrainzRepository,
    _RateLimiter,
    artist_credit_text,
)
from app.exceptions import ExternalAPIError

# Trimmed from a real musicbrainz.org/ws/2/recording?query=...&fmt=json response.
RECORDING_PAYLOAD = {
    "created": "2026-08-18T00:00:00.000Z",
    "count": 2,
    "offset": 0,
    "recordings": [
        {
            "id": "b1a9c0e9-d987-4042-ae91-78d6a3267d69",
            "score": 100,
            "title": "Get Lucky",
            "length": 369066,
            "artist-credit": [
                {
                    "name": "Daft Punk",
                    "joinphrase": " feat. ",
                    "artist": {"id": "056e4f3e-d505-4dad-8ec1-d04f521cbb56", "name": "Daft Punk"},
                },
                {
                    "name": "Pharrell Williams",
                    "artist": {"id": "bfd0f16d-4a08-4c8e-a3b8-33a6dbd8c1cc",
                               "name": "Pharrell Williams"},
                },
            ],
            "isrcs": ["USQX91300809"],
            "releases": [{"id": "c0f7f0f9-0000-0000-0000-000000000000", "title": "Random Access Memories"}],
        },
        {
            "id": "9d9a2f0e-1111-2222-3333-444455556666",
            "score": 88,
            "title": "Get Lucky (radio edit)",
            "length": 248000,
            "artist-credit": [{"name": "Daft Punk"}],
            "releases": [{"title": "Get Lucky"}],
        },
        {"score": 10, "title": "no id — skipped"},
    ],
}


def _resp(payload, status=200):
    resp = Mock()
    resp.status_code = status
    resp.json = Mock(return_value=payload)
    resp.raise_for_status = Mock(
        side_effect=requests.HTTPError(str(status)) if status >= 400 else None
    )
    return resp


def _repo(handler=None, **kwargs):
    session = Mock()
    session.get = Mock(side_effect=handler or (lambda url, **kw: _resp(RECORDING_PAYLOAD)))
    kwargs.setdefault("min_interval_s", 0)
    kwargs.setdefault("contact", "https://example.test/krobi")
    kwargs.setdefault("sleep", Mock())  # never sleep for real; see 503 backoff
    return MusicBrainzRepository(config=Mock(), logger=Mock(), session=session, **kwargs)


class TestUserAgent:
    def test_sends_a_descriptive_user_agent_with_contact_info(self):
        """MusicBrainz mandates 'Application/Version ( contact )'."""
        repo = _repo()
        repo.search_candidates("daft punk get lucky")
        headers = repo.session.get.call_args.kwargs["headers"]
        assert headers["User-Agent"] == f"Flipspin/{APP_VERSION} ( https://example.test/krobi )"

    def test_contact_falls_back_to_env_then_default(self, monkeypatch):
        monkeypatch.setenv("KROBI_MUSICBRAINZ_CONTACT", "mailto:someone@example.test")
        repo = MusicBrainzRepository(
            config=Mock(spec=[]), logger=Mock(), session=Mock(), min_interval_s=0
        )
        assert "mailto:someone@example.test" in repo.user_agent

        monkeypatch.delenv("KROBI_MUSICBRAINZ_CONTACT")
        repo = MusicBrainzRepository(
            config=Mock(spec=[]), logger=Mock(), session=Mock(), min_interval_s=0
        )
        assert "github.com" in repo.user_agent

    def test_403_says_it_is_the_user_agent_and_does_not_retry(self):
        calls = []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp("<html>forbidden</html>", status=403)

        with pytest.raises(ExternalAPIError) as excinfo:
            _repo(handler).search_candidates("x")
        assert "User-Agent" in excinfo.value.message
        assert excinfo.value.details["status"] == 403
        assert len(calls) == 1  # no retry: it would be refused identically


class TestRecordingMapping:
    def test_maps_a_real_shaped_payload_to_sane_candidates(self):
        candidates = _repo().search_candidates("daft punk get lucky")

        assert len(candidates) == 2  # the id-less row is dropped
        first = candidates[0]
        assert first.title == "Get Lucky"
        assert first.artist == "Daft Punk feat. Pharrell Williams"  # joinphrase honoured
        assert first.album == "Random Access Memories"
        assert first.provider == "musicbrainz"
        assert first.isrc == "USQX91300809"

    def test_recording_mbid_is_the_identity_and_the_provider_id(self):
        first = _repo().search_candidates("x")[0]
        assert first.recording_mbid == "b1a9c0e9-d987-4042-ae91-78d6a3267d69"
        assert first.provider_id == first.recording_mbid
        assert first.is_identifiable is True

    def test_length_is_milliseconds_and_is_converted_to_seconds(self):
        """369066 ms is a 6-minute song, not a 4-day one."""
        candidates = _repo().search_candidates("x")
        assert candidates[0].duration_s == pytest.approx(369.066)
        assert candidates[1].duration_s == pytest.approx(248.0)

    def test_missing_length_becomes_none(self):
        payload = {"recordings": [{"id": "abc", "title": "T"}]}
        candidate = _repo(lambda url, **kw: _resp(payload)).search_candidates("x")[0]
        assert candidate.duration_s is None
        assert candidate.artist is None


class TestQueryBuilding:
    def test_search_candidates_uses_free_text(self):
        repo = _repo()
        repo.search_candidates("daft punk get lucky", limit=3)
        params = repo.session.get.call_args.kwargs["params"]
        assert params["fmt"] == "json"
        assert params["limit"] == 3
        assert "daft punk get lucky" in params["query"]

    def test_search_recordings_builds_a_fielded_query(self):
        repo = _repo()
        repo.search_recordings("Get Lucky", "Daft Punk")
        query = repo.session.get.call_args.kwargs["params"]["query"]
        assert query == 'recording:"Get Lucky" AND artist:"Daft Punk"'

    def test_featuring_noise_is_stripped_from_the_query(self):
        repo = _repo()
        repo.search_recordings("Get Lucky (feat. Pharrell Williams)", "Daft Punk")
        query = repo.session.get.call_args.kwargs["params"]["query"]
        assert "Pharrell" not in query

    def test_lucene_specials_are_escaped_rather_than_400ing(self):
        repo = _repo()
        repo.search_candidates("AC/DC T.N.T. (live?)")
        query = repo.session.get.call_args.kwargs["params"]["query"]
        assert "\\/" in query and "\\?" in query

    def test_quotes_are_escaped_inside_a_phrase(self):
        repo = _repo()
        repo.search_recordings('The "Real" Thing', None)
        query = repo.session.get.call_args.kwargs["params"]["query"]
        assert query == 'recording:"The \\"Real\\" Thing"'

    def test_blank_inputs_make_no_request(self):
        repo = _repo()
        assert repo.search_candidates("") == []
        assert repo.search_recordings("  ") == []
        repo.session.get.assert_not_called()


class TestFailureHandling:
    def test_a_transient_503_is_retried_and_succeeds(self):
        """Retry 503 for both throttling and temporary server saturation."""
        calls, slept = [], []

        def handler(url, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                return _resp({}, status=503)
            return _resp(RECORDING_PAYLOAD)

        repo = _repo(handler, sleep=slept.append)
        candidates = repo.search_candidates("daft punk")

        assert len(candidates) == 2
        assert len(calls) == 2
        assert slept == [pytest.approx(2.0)]

    def test_a_persistent_503_gives_up_and_says_how_hard_it_tried(self):
        calls, slept = [], []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp({}, status=503)

        with pytest.raises(ExternalAPIError) as excinfo:
            _repo(handler, sleep=slept.append).search_candidates("x")

        assert excinfo.value.details["status"] == 503
        assert excinfo.value.details["attempts"] == 3
        assert len(calls) == 3
        # Doubling, and it stops sleeping once it has decided to give up.
        assert slept == [pytest.approx(2.0), pytest.approx(4.0)]

    def test_retries_can_be_switched_off(self):
        calls = []

        def handler(url, **kwargs):
            calls.append(url)
            return _resp({}, status=503)

        with pytest.raises(ExternalAPIError):
            _repo(handler, sleep=Mock(), throttle_retry_attempts=1).search_candidates("x")
        assert len(calls) == 1

    def test_timeout_raises_external_api_error(self):
        def handler(url, **kwargs):
            raise requests.Timeout("nope")

        with pytest.raises(ExternalAPIError) as excinfo:
            _repo(handler).search_candidates("x")
        assert excinfo.value.details["api_name"] == "musicbrainz"

    def test_html_error_page_raises_rather_than_returning_nothing(self):
        def handler(url, **kwargs):
            resp = Mock(status_code=200)
            resp.raise_for_status = Mock()
            resp.json = Mock(side_effect=ValueError("Expecting value"))
            return resp

        with pytest.raises(ExternalAPIError):
            _repo(handler).search_candidates("x")

    def test_every_request_sets_a_timeout(self):
        repo = _repo()
        repo.search_candidates("x")
        assert repo.session.get.call_args.kwargs["timeout"] > 0


class TestRateLimitEnforcement:
    def test_the_repository_paces_itself_at_one_request_per_second(self):
        """Enforced client-side, not left to the caller's good behaviour."""
        slept, now = [], [0.0]

        def sleep(seconds):
            slept.append(seconds)
            now[0] += seconds

        repo = _repo(min_interval_s=1.1)
        repo._limiter = _RateLimiter(1.1, sleep=sleep, clock=lambda: now[0])

        repo.search_candidates("a")
        repo.search_candidates("b")
        repo.search_candidates("c")

        assert slept == [pytest.approx(1.1), pytest.approx(1.1)]
        assert repo.session.get.call_count == 3

    def test_default_interval_is_at_least_one_second(self):
        repo = MusicBrainzRepository(config=Mock(spec=[]), logger=Mock(), session=Mock())
        assert repo._limiter.min_interval_s >= 1.0

    def test_a_slow_request_does_not_add_extra_delay(self):
        """The gate is on arrival spacing, so real latency counts toward it."""
        slept, now = [], [0.0]
        limiter = _RateLimiter(1.1, sleep=slept.append, clock=lambda: now[0])
        limiter.wait()
        now[0] = 2.0  # the request itself took 2 s
        limiter.wait()
        assert slept == []


class TestLookups:
    """Raw recording/work lookups: paced, identified, ids validated."""

    MBID = "a171fdda-8146-43be-aea9-95370448f1be"

    def test_lookup_recording_builds_the_inc_and_returns_the_raw_body(self):
        body = {"id": self.MBID, "title": "Right Here, Right Now", "relations": []}
        repo = _repo(lambda url, **kw: _resp(body))
        assert repo.lookup_recording(self.MBID.upper(), inc=("recording-rels", "isrcs")) == body
        call = repo.session.get.call_args
        assert call.args[0] == f"https://musicbrainz.org/ws/2/recording/{self.MBID}"
        assert call.kwargs["params"] == {"fmt": "json", "inc": "recording-rels+isrcs"}
        assert call.kwargs["headers"]["User-Agent"].startswith("Flipspin/")

    def test_default_recording_inc_covers_what_the_enricher_reads(self):
        repo = _repo(lambda url, **kw: _resp({"id": self.MBID}))
        repo.lookup_recording(self.MBID)
        inc = repo.session.get.call_args.kwargs["params"]["inc"].split("+")
        assert {"recording-rels", "work-rels", "url-rels", "isrcs", "artist-credits"} <= set(inc)

    def test_lookup_work(self):
        repo = _repo(lambda url, **kw: _resp({"id": self.MBID, "relations": []}))
        repo.lookup_work(self.MBID)
        call = repo.session.get.call_args
        assert call.args[0].endswith(f"/work/{self.MBID}")
        # artist-credits: without it a work's performance targets come back artist-less.
        assert call.kwargs["params"]["inc"] == "recording-rels+artist-credits"

    def test_artist_credit_text_joins_names_and_join_phrases(self):
        credits = [
            {"name": "Marvin Gaye", "joinphrase": " & ", "artist": {"id": "x", "name": "Marvin Gaye"}},
            {"joinphrase": "", "artist": {"id": "y", "name": "Tammi Terrell"}},
        ]
        assert artist_credit_text(credits) == "Marvin Gaye & Tammi Terrell"
        assert artist_credit_text([]) is None and artist_credit_text(None) is None

    def test_invalid_ids_never_reach_the_network(self):
        repo = _repo()
        with pytest.raises(ValueError):
            repo.lookup_recording("../artist/x")
        with pytest.raises(ValueError):
            repo.lookup_work("")
        with pytest.raises(ValueError):
            repo.lookup_isrc("not-an-isrc!")
        repo.session.get.assert_not_called()

    def test_lookup_isrc_normalises_and_404_means_none(self):
        repo = _repo(lambda url, **kw: _resp({"isrc": "GBBMQ9900047", "recordings": [{"id": self.MBID}]}))
        assert repo.lookup_isrc("gb-bmq-99-00047")["recordings"][0]["id"] == self.MBID
        assert repo.session.get.call_args.args[0].endswith("/isrc/GBBMQ9900047")

        missing = _repo(lambda url, **kw: _resp({"error": "Not Found"}, status=404))
        assert missing.lookup_isrc("GBBMQ9900047") is None

    def test_a_404_on_a_lookup_is_tagged_and_not_retried(self):
        repo = _repo(lambda url, **kw: _resp({"error": "Not Found"}, status=404))
        with pytest.raises(ExternalAPIError) as info:
            repo.lookup_recording(self.MBID)
        assert info.value.details["status"] == 404
        assert repo.session.get.call_count == 1

    def test_lookups_are_retried_on_503(self):
        answers = iter([_resp({}, status=503), _resp({"id": self.MBID})])
        repo = _repo(lambda url, **kw: next(answers))
        assert repo.lookup_recording(self.MBID) == {"id": self.MBID}
        assert repo.session.get.call_count == 2


def test_release_search_lookup_share_recording_limiter_and_user_agent():
    repo = _repo(lambda *args, **kwargs: _resp({'releases': [{'id': '11111111-1111-1111-1111-111111111111'}]}))
    repo._limiter.wait = Mock()
    assert repo.search_releases('Title "special"', 'Artist', limit=99)
    search = repo.session.get.call_args
    assert search.args[0].endswith('/release')
    assert search.kwargs['params']['limit'] == 5
    assert 'artist:"Artist"' in search.kwargs['params']['query']
    repo.lookup_release('11111111-1111-1111-1111-111111111111')
    lookup = repo.session.get.call_args
    assert {'recordings', 'artist-credits', 'isrcs', 'release-groups'} <= set(lookup.kwargs['params']['inc'].split('+'))
    repo.search_recordings('Song')
    assert repo._limiter.wait.call_count == 3
    assert all(call.kwargs['headers']['User-Agent'] == repo.user_agent for call in repo.session.get.call_args_list)
    repo.search_releases('Free text + punctuation', free_text=True)
    assert repo.session.get.call_args.kwargs['params']['query'] == r'Free text \+ punctuation'
    with pytest.raises(ValueError):
        repo.lookup_release('../other')
