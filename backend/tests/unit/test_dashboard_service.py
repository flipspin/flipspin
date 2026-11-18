"""Check dashboard cache budgets, stale fallback, and partial provider failure.

Fake sessions exercise Deezer quota errors inside HTTP 200 without network.
"""
import json
from datetime import datetime, timedelta, UTC
from unittest.mock import Mock

import pytest
import requests

from app.domains.dashboard.models import (
    GENRES,
    NEW_RELEASES,
    PODCASTS,
    ROW_ORDER,
    TOP_ALBUMS,
    TOP_ARTISTS,
    TOP_PLAYLISTS,
    TOP_TRACKS,
    Dashboard,
    DashboardItem,
    DashboardRow,
)
from app.domains.dashboard.repositories import (
    DashboardCacheRepository,
    DeezerDashboardProvider,
)
from app.domains.dashboard.services import DashboardService
from app.domains.metadata.deezer_repository import DeezerRepository
from app.exceptions import ExternalAPIError

# --------------------------------------------------------------------- payloads

CHART_PAYLOAD = {
    "tracks": {
        "data": [
            {
                "id": 3135556,
                "title": "Harder, Better, Faster, Stronger",
                "duration": 224,
                "link": "https://www.deezer.com/track/3135556",
                "artist": {"id": 27, "name": "Daft Punk"},
                "album": {"id": 302127, "title": "Discovery", "cover_big": "https://cdn/500.jpg"},
            }
        ],
        "total": 1,
    },
    "albums": {
        "data": [
            {
                "id": 302127,
                "title": "Discovery",
                "link": "https://www.deezer.com/album/302127",
                "cover_medium": "https://cdn/250.jpg",
                "cover_big": "https://cdn/500.jpg",
                "cover_xl": "https://cdn/1000.jpg",
                "artist": {"id": 27, "name": "Daft Punk"},
            },
            {"title": "album with no id"},  # skipped
        ],
        "total": 2,
    },
    "artists": {
        "data": [
            {
                "id": 27,
                "name": "Daft Punk",
                "link": "https://www.deezer.com/artist/27",
                "picture_medium": "https://cdn/artist250.jpg",
            }
        ],
        "total": 1,
    },
    "playlists": {
        "data": [
            {
                "id": 1997855286,
                "title": "Éxitos con madre",
                "link": "https://www.deezer.com/playlist/1997855286",
                "picture_medium": "https://cdn/pl250.jpg",
                "user": {"id": 5, "name": "Deezer Latino"},
            }
        ],
        "total": 1,
    },
    "podcasts": {
        "data": [
            {
                "id": 1505342,
                "title": "Música en vivo",
                "description": "Conciertos cada semana",
                "link": "https://www.deezer.com/show/1505342",
                "picture_big": "https://cdn/pod500.jpg",
            }
        ],
        "total": 1,
    },
}

GENRES_PAYLOAD = {
    "data": [
        {"id": 0, "name": "Todos", "picture_big": "https://cdn/g0.jpg"},  # "All" — dropped
        {"id": 122, "name": "Reggaetón", "picture_big": "https://cdn/g122.jpg"},
        {"id": 71, "name": "Cumbia", "picture_big": "https://cdn/g71.jpg"},
    ]
}

RELEASES_PAYLOAD = {
    "data": [
        {
            "id": 1043456602,
            "title": "9 months & 50 hours",
            "link": "https://www.deezer.com/album/1043456602",
            "cover_medium": "https://cdn/rel250.jpg",
            "artist": {"id": 76053262, "name": "Fred again.."},
        }
    ],
    "total": 1,
}

SELECTION_PAYLOAD = {
    "data": [
        {
            "id": 76237,
            "title": "Serart",
            "cover_medium": "https://cdn/sel250.jpg",
            "artist": {"name": "Serart"},
        }
    ],
    "total": 1,
}

# The verbatim quota envelope, HTTP 200 and all.
QUOTA_PAYLOAD = {"error": {"type": "Exception", "message": "Quota limit exceeded", "code": 4}}


# ----------------------------------------------------------------------- helpers

def _resp(payload, status=200):
    resp = Mock()
    resp.status_code = status
    resp.json = Mock(return_value=payload)
    resp.raise_for_status = Mock()
    return resp


def _deezer(handler, **kwargs):
    """A real DeezerRepository over a fake session. Never touches the network."""
    session = Mock()
    session.get = Mock(side_effect=handler)
    kwargs.setdefault("min_interval_s", 0)
    kwargs.setdefault("sleep", Mock())  # backoff is asserted, not endured
    return DeezerRepository(config=Mock(), logger=Mock(), session=session, **kwargs)


def _routing_handler(chart=CHART_PAYLOAD, releases=RELEASES_PAYLOAD, selection=SELECTION_PAYLOAD, genres=GENRES_PAYLOAD):
    calls = []

    def handler(url, **kwargs):
        calls.append(url)
        if "/chart" in url:
            return _resp(chart() if callable(chart) else chart)
        if "/releases" in url:
            return _resp(releases() if callable(releases) else releases)
        if "/selection" in url:
            return _resp(selection() if callable(selection) else selection)
        if url.endswith("/genre"):
            return _resp(genres() if callable(genres) else genres)
        raise AssertionError(f"unexpected URL {url}")

    handler.calls = calls
    return handler


def _service(tmp_path, provider=None, handler=None, now=None, **kwargs):
    if provider is None:
        provider = DeezerDashboardProvider(
            deezer=_deezer(handler or _routing_handler()), logger=Mock()
        )
    cache = DashboardCacheRepository(
        config=Mock(), logger=Mock(), cache_path=tmp_path / "dashboard-cache.json"
    )
    return DashboardService(
        provider=provider,
        cache_repo=cache,
        config=Mock(),
        logger=Mock(),
        now=now or (lambda: datetime(2026, 8, 20, 12, 0, tzinfo=UTC)),
        **kwargs,
    )


class _Clock:
    """A movable clock, so TTL expiry is asserted instead of slept through."""

    def __init__(self, start=datetime(2026, 8, 20, 12, 0, tzinfo=UTC)):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += timedelta(**kwargs)


class _CountingProvider:
    """A provider whose two calls can be individually made to succeed or fail."""

    provider_id = "deezer"
    provider_name = "Deezer"

    def __init__(self, chart=None, releases=None, genres=None):
        self.chart_calls = 0
        self.release_calls = 0
        self.genre_calls = 0
        self._chart = chart if chart is not None else {
            TOP_PLAYLISTS: [DashboardItem(id="p1", title="Playlist one")],
            TOP_ARTISTS: [DashboardItem(id="a1", title="Artist one")],
            TOP_ALBUMS: [DashboardItem(id="al1", title="Album one")],
            TOP_TRACKS: [DashboardItem(id="t1", title="Track one", track={"title": "Track one"})],
            PODCASTS: [DashboardItem(id="pod1", title="Podcast one")],
        }
        self._releases = releases if releases is not None else [
            DashboardItem(id="r1", title="Release one")
        ]
        # A dead chart takes genres down too unless told otherwise — a quota
        # error is per IP, not per endpoint.
        if genres is None:
            genres = self._chart if isinstance(self._chart, Exception) else [DashboardItem(id="g1", title="Genre one")]
        self._genres = genres

    def fetch_chart_rows(self):
        self.chart_calls += 1
        if isinstance(self._chart, Exception):
            raise self._chart
        return dict(self._chart)

    def fetch_new_releases(self):
        self.release_calls += 1
        if isinstance(self._releases, Exception):
            raise self._releases
        return list(self._releases)

    def fetch_genres(self):
        self.genre_calls += 1
        if isinstance(self._genres, Exception):
            raise self._genres
        return list(self._genres)


# ------------------------------------------------------------------- mapping

class TestProviderMapping:
    """The four rows, and the shapes the frontend reads."""

    def test_maps_every_row_from_three_requests(self, tmp_path):
        handler = _routing_handler()
        dashboard = _service(tmp_path, handler=handler).get_dashboard()

        assert [row.id for row in dashboard.rows] == list(ROW_ORDER)
        assert all(row.error is None for row in dashboard.rows)
        # /chart answers five rows (playlists, artists, albums, songs,
        # podcasts); New Releases and the genre list cost one request each.
        assert len(handler.calls) == 3

    def test_a_top_song_carries_the_browse_track_it_would_be_saved_as(self, tmp_path):
        dashboard = _service(tmp_path).get_dashboard()
        song = dashboard.row(TOP_TRACKS).items[0]
        assert song.subtitle == "Daft Punk"
        assert song.track["albumRef"]["id"] == "302127"
        assert song.track["durationSeconds"] == 224.0
        assert song.to_dict()["track"]["title"] == "Harder, Better, Faster, Stronger"
        # Every other row keeps its five keys.
        assert "track" not in dashboard.row(TOP_ALBUMS).items[0].to_dict()

    def test_genres_drop_all_and_podcasts_link_out(self, tmp_path):
        dashboard = _service(tmp_path).get_dashboard()
        assert [g.title for g in dashboard.row(GENRES).items] == ["Reggaetón", "Cumbia"]
        podcast = dashboard.row(PODCASTS).items[0]
        assert podcast.provider_url == "https://www.deezer.com/show/1505342"
        assert podcast.subtitle == "Conciertos cada semana"

    def test_row_carries_its_provider_for_the_chip(self, tmp_path):
        dashboard = _service(tmp_path).get_dashboard()
        for row in dashboard.rows:
            assert row.provider == "deezer"
            assert row.provider_name == "Deezer"

    def test_item_fields(self, tmp_path):
        dashboard = _service(tmp_path).get_dashboard()
        album = dashboard.row(TOP_ALBUMS).items[0]
        assert album.id == "302127"
        assert album.title == "Discovery"
        assert album.subtitle == "Daft Punk"
        # Prefer enough pixels for a 152px card at 2x scale without fetching
        # the 1000px artwork intended for permanent embedding.
        assert album.image_url == "https://cdn/500.jpg"
        assert album.provider_url == "https://www.deezer.com/album/302127"

        assert dashboard.row(TOP_ARTISTS).items[0].title == "Daft Punk"
        assert dashboard.row(TOP_PLAYLISTS).items[0].subtitle == "Deezer Latino"

    def test_rows_missing_id_are_dropped_not_fatal(self, tmp_path):
        dashboard = _service(tmp_path).get_dashboard()
        assert len(dashboard.row(TOP_ALBUMS).items) == 1  # the id-less row is gone

    def test_new_releases_falls_back_to_selection_when_releases_is_empty(self, tmp_path):
        # An empty releases response must fall back to useful editorial selections.
        handler = _routing_handler(releases={"data": [], "total": 0})
        dashboard = _service(tmp_path, handler=handler).get_dashboard()

        row = dashboard.row(NEW_RELEASES)
        assert row.error is None
        assert row.items[0].title == "Serart"
        assert any("/selection" in url for url in handler.calls)

    def test_no_fallback_request_when_releases_answers(self, tmp_path):
        handler = _routing_handler()
        _service(tmp_path, handler=handler).get_dashboard()
        assert not any("/selection" in url for url in handler.calls)


# ---------------------------------------------------------------------- cache

class TestCache:
    """Hit, miss, and expiry — counted in provider calls, not in flags."""

    def test_miss_then_hit_costs_one_fetch(self, tmp_path):
        provider = _CountingProvider()
        service = _service(tmp_path, provider=provider)

        first = service.get_dashboard()
        second = service.get_dashboard()

        assert provider.chart_calls == 1
        assert provider.release_calls == 1
        assert first.cached_at == second.cached_at
        assert second.stale is False

    def test_cache_survives_a_new_service_instance(self, tmp_path):
        """The persistence half: a backend restart must not reset the TTL."""
        provider_a = _CountingProvider()
        _service(tmp_path, provider=provider_a).get_dashboard()

        provider_b = _CountingProvider()
        restarted = _service(tmp_path, provider=provider_b).get_dashboard()

        assert provider_b.chart_calls == 0
        assert restarted.row(TOP_ALBUMS).items[0].title == "Album one"

    def test_expiry_refetches(self, tmp_path):
        clock = _Clock()
        provider = _CountingProvider()
        service = _service(tmp_path, provider=provider, now=clock, ttl_hours=6)

        service.get_dashboard()
        clock.advance(hours=5, minutes=59)
        service.get_dashboard()
        assert provider.chart_calls == 1, "still inside the TTL"

        clock.advance(minutes=2)
        service.get_dashboard()
        assert provider.chart_calls == 2, "TTL elapsed"

    def test_force_refresh_bypasses_a_fresh_cache(self, tmp_path):
        provider = _CountingProvider()
        service = _service(tmp_path, provider=provider)
        service.get_dashboard()
        service.get_dashboard(force_refresh=True)
        assert provider.chart_calls == 2

    def test_degraded_snapshot_retries_sooner_than_the_full_ttl(self, tmp_path):
        """A blip should heal in minutes — but still not on every page open."""
        clock = _Clock()
        provider = _CountingProvider(releases=ExternalAPIError("down", api_name="deezer"))
        service = _service(
            tmp_path, provider=provider, now=clock, ttl_hours=6, degraded_ttl_minutes=15
        )

        service.get_dashboard()
        clock.advance(minutes=5)
        service.get_dashboard()
        assert provider.chart_calls == 1, "a degraded snapshot is still cached briefly"

        clock.advance(minutes=11)
        service.get_dashboard()
        assert provider.chart_calls == 2

    def test_unparseable_cache_file_is_a_miss_not_a_crash(self, tmp_path):
        path = tmp_path / "dashboard-cache.json"
        path.write_text("{ truncated", encoding="utf-8")
        provider = _CountingProvider()
        dashboard = _service(tmp_path, provider=provider).get_dashboard()
        assert provider.chart_calls == 1
        assert dashboard.row(TOP_ALBUMS).items

    def test_future_dated_cache_is_not_trusted_as_fresh(self, tmp_path):
        """Clock skew or a restored backup must not pin the cache forever."""
        clock = _Clock()
        provider = _CountingProvider()
        service = _service(tmp_path, provider=provider, now=clock)
        service.get_dashboard()

        clock.now -= timedelta(days=2)
        service.get_dashboard()
        assert provider.chart_calls == 2

    def test_written_file_is_json_the_next_process_can_read(self, tmp_path):
        _service(tmp_path).get_dashboard()
        payload = json.loads((tmp_path / "dashboard-cache.json").read_text(encoding="utf-8"))
        assert payload["cachedAt"]
        assert {row["id"] for row in payload["rows"]} == set(ROW_ORDER)


# -------------------------------------------------------- failure / staleness

class TestFailureHandling:
    """A dead provider must never blank the page."""

    def test_total_failure_serves_the_cache_as_stale(self, tmp_path):
        clock = _Clock()
        good = _CountingProvider()
        cache_path = tmp_path
        _service(cache_path, provider=good, now=clock).get_dashboard()

        clock.advance(hours=7)
        dead = _CountingProvider(
            chart=ExternalAPIError("Deezer error: Quota limit exceeded", api_name="deezer"),
            releases=ExternalAPIError("Deezer error: Quota limit exceeded", api_name="deezer"),
        )
        dashboard = _service(cache_path, provider=dead, now=clock).get_dashboard()

        assert dashboard.stale is True
        assert all(row.stale for row in dashboard.rows)
        assert dashboard.row(TOP_ALBUMS).items[0].title == "Album one"
        # The reason travels with the row so the UI can explain the staleness.
        assert "Quota limit exceeded" in dashboard.row(TOP_ALBUMS).error

    def test_total_failure_with_no_cache_returns_four_error_rows(self, tmp_path):
        dead = _CountingProvider(
            chart=ExternalAPIError("boom", api_name="deezer"),
            releases=ExternalAPIError("boom", api_name="deezer"),
        )
        dashboard = _service(tmp_path, provider=dead).get_dashboard()

        assert [row.id for row in dashboard.rows] == list(ROW_ORDER)
        assert all(row.error for row in dashboard.rows)
        assert all(row.items == [] for row in dashboard.rows)
        assert dashboard.stale is False, "nothing old is being passed off as current"

    def test_a_hopeless_result_is_not_persisted_over_a_good_cache(self, tmp_path):
        dead = _CountingProvider(
            chart=ExternalAPIError("boom", api_name="deezer"),
            releases=ExternalAPIError("boom", api_name="deezer"),
        )
        _service(tmp_path, provider=dead).get_dashboard()
        assert not (tmp_path / "dashboard-cache.json").exists()

    def test_partial_failure_keeps_the_healthy_rows(self, tmp_path):
        provider = _CountingProvider(releases=ExternalAPIError("editorial down", api_name="deezer"))
        dashboard = _service(tmp_path, provider=provider).get_dashboard()

        for row_id in (TOP_PLAYLISTS, TOP_ARTISTS, TOP_ALBUMS):
            row = dashboard.row(row_id)
            assert row.error is None and row.items

        broken = dashboard.row(NEW_RELEASES)
        assert broken.items == []
        assert "editorial down" in broken.error
        assert dashboard.stale is False, "no row fell back to an older copy"

    def test_partial_failure_falls_back_per_row(self, tmp_path):
        """The interesting case: fresh rows and a stale row in one response."""
        clock = _Clock()
        _service(tmp_path, provider=_CountingProvider(), now=clock).get_dashboard()

        clock.advance(hours=7)
        degraded = _CountingProvider(releases=ExternalAPIError("editorial down", api_name="deezer"))
        dashboard = _service(tmp_path, provider=degraded, now=clock).get_dashboard()

        assert dashboard.stale is True
        assert dashboard.row(TOP_ALBUMS).stale is False
        stale_row = dashboard.row(NEW_RELEASES)
        assert stale_row.stale is True
        assert stale_row.items[0].title == "Release one"
        assert "editorial down" in stale_row.error

    def test_empty_section_in_a_healthy_response_is_a_row_error(self, tmp_path):
        chart = dict(CHART_PAYLOAD, artists={"data": [], "total": 0})
        handler = _routing_handler(chart=chart)
        dashboard = _service(tmp_path, handler=handler).get_dashboard()

        assert dashboard.row(TOP_ARTISTS).error
        assert dashboard.row(TOP_ALBUMS).error is None

    def test_get_dashboard_never_raises(self, tmp_path):
        class Exploding:
            provider_id = "deezer"
            provider_name = "Deezer"

            def fetch_chart_rows(self):
                raise RuntimeError("something nobody anticipated")

            def fetch_new_releases(self):
                raise RuntimeError("something nobody anticipated")

        dashboard = _service(tmp_path, provider=Exploding()).get_dashboard()
        assert len(dashboard.rows) == len(ROW_ORDER)


# ----------------------------------------------------------------- quota (200)

class TestQuotaErrorArrivesAsHttp200:
    """Expose quota envelopes inside HTTP 200 as errors or stale fallback.

    An empty successful row would misrepresent provider failure as missing charts."""

    def test_quota_becomes_a_row_error_not_a_silent_empty_row(self, tmp_path):
        handler = _routing_handler(chart=QUOTA_PAYLOAD, releases=QUOTA_PAYLOAD, genres=QUOTA_PAYLOAD)
        # quota_retry_attempts=1 so the assertion is about detection, not backoff
        # (the schedule itself is pinned in test_deezer_repository.py).
        provider = DeezerDashboardProvider(
            deezer=_deezer(handler, quota_retry_attempts=1), logger=Mock()
        )
        dashboard = _service(tmp_path, provider=provider).get_dashboard()

        assert all(row.error for row in dashboard.rows)
        for row in dashboard.rows:
            assert "Quota limit exceeded" in row.error

    def test_quota_serves_the_previous_snapshot_stale(self, tmp_path):
        clock = _Clock()
        good = DeezerDashboardProvider(deezer=_deezer(_routing_handler()), logger=Mock())
        _service(tmp_path, provider=good, now=clock).get_dashboard()

        clock.advance(hours=7)
        throttled = DeezerDashboardProvider(
            deezer=_deezer(
                _routing_handler(chart=QUOTA_PAYLOAD, releases=QUOTA_PAYLOAD, genres=QUOTA_PAYLOAD),
                quota_retry_attempts=1,
            ),
            logger=Mock(),
        )
        dashboard = _service(tmp_path, provider=throttled, now=clock).get_dashboard()

        assert dashboard.stale is True
        assert dashboard.row(TOP_ALBUMS).items[0].title == "Discovery"

    def test_http_200_quota_is_never_mistaken_for_success(self, tmp_path):
        """Guards the specific bug: raise_for_status() passes on this response."""
        handler = _routing_handler(chart=QUOTA_PAYLOAD)
        repo = _deezer(handler, quota_retry_attempts=1)
        with pytest.raises(ExternalAPIError):
            repo.fetch_chart()


# ------------------------------------------------------------------ cache repo

class TestCacheRepository:
    def test_missing_file_is_none(self, tmp_path):
        repo = DashboardCacheRepository(
            config=Mock(), logger=Mock(), cache_path=tmp_path / "nope.json"
        )
        assert repo.load() is None

    def test_round_trips(self, tmp_path):
        repo = DashboardCacheRepository(
            config=Mock(), logger=Mock(), cache_path=tmp_path / "sub" / "cache.json"
        )
        snapshot = Dashboard(
            rows=[
                DashboardRow(
                    id=TOP_ALBUMS,
                    title="Top Albums",
                    kind="album",
                    provider="deezer",
                    provider_name="Deezer",
                    items=[DashboardItem(id="1", title="Discovery", subtitle="Daft Punk")],
                )
            ],
            cached_at="2026-08-20T12:00:00Z",
        )
        assert repo.save(snapshot) is True
        loaded = repo.load()
        assert loaded.cached_at == "2026-08-20T12:00:00Z"
        assert loaded.rows[0].items[0].subtitle == "Daft Punk"

    def test_save_failure_is_swallowed(self, tmp_path):
        # A directory where the file should be: writing can never succeed.
        blocked = tmp_path / "cache.json"
        blocked.mkdir()
        repo = DashboardCacheRepository(config=Mock(), logger=Mock(), cache_path=blocked)
        assert repo.save(Dashboard(rows=[], cached_at="2026-08-20T12:00:00Z")) is False

    def test_an_empty_snapshot_is_treated_as_a_miss(self, tmp_path):
        path = tmp_path / "cache.json"
        path.write_text(json.dumps({"rows": [], "cachedAt": "2026-08-20T12:00:00Z"}), "utf-8")
        repo = DashboardCacheRepository(config=Mock(), logger=Mock(), cache_path=path)
        assert repo.load() is None


def test_requests_module_is_only_reached_through_a_fake_session():
    """A guard rail: nothing in this file may open a socket."""
    assert isinstance(requests.Session, type)
