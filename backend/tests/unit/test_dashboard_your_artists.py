""""More from your artists": which artists, which catalog match, which albums.

The failure this row must never show is recommending an album the library
already holds, so most of these tests are about exclusion. The rest pin the
request budget (Deezer's per-IP quota is answered with an HTTP 200) and the
row's place in the dashboard: isolated, cached, honest when empty.
"""
import logging
import os
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.domains.dashboard.models import ROW_ORDER, DashboardItem
from app.domains.dashboard.repositories import DashboardCacheRepository
from app.domains.dashboard.services import DashboardService
from app.domains.dashboard.your_artists import (
    ALBUMS_PER_ARTIST,
    MAX_ARTISTS,
    MAX_REQUESTS,
    ROW_ID,
    LibraryArtist,
    YourArtistsSource,
    album_title_key,
    artist_key,
    pick_artists,
    primary_credit,
    read_library,
)
from app.domains.music.repositories import MusicRepository
from app.exceptions import ExternalAPIError

LOG = logging.getLogger("test.your_artists")


# ----------------------------------------------------------------------- fakes

def _album(name, artist, n_tracks=3, added=1000.0, track_artist=None):
    tracks = [
        SimpleNamespace(title=f"{name} {i}", artist=track_artist or artist, date_added=added)
        for i in range(n_tracks)
    ]
    return SimpleNamespace(name=name, artist=artist, tracks=tracks)


class FakeMusic:
    def __init__(self, albums):
        self.albums = albums

    def scan_albums(self):
        return list(self.albums)


class FakeDeezer:
    """Catalog keyed by artist name; counts every request."""

    def __init__(self, artists=None, discographies=None, fail_on=None):
        # name -> id, and id -> album rows
        self.artists = artists or {}
        self.discographies = discographies or {}
        self.fail_on = fail_on  # an artist query that raises
        self.calls: list[tuple] = []

    def search_entities(self, entity, query, limit=5):
        self.calls.append(("search", query))
        if self.fail_on is not None and query == self.fail_on:
            raise ExternalAPIError("Quota limit exceeded", "Deezer")
        # Deezer search is fuzzy: return the exact name plus a lookalike first.
        rows = [{"id": 999, "name": f"{query} Tribute Band"}]
        for name, artist_id in self.artists.items():
            if artist_key(name) == artist_key(query):
                rows.append({"id": artist_id, "name": name})
        return rows

    def fetch_artist_albums(self, artist_id, limit=50):
        self.calls.append(("albums", artist_id))
        return list(self.discographies.get(artist_id, []))


def _cat(album_id, title, date="2020-01-01", record_type="album"):
    return {
        "id": album_id,
        "title": title,
        "release_date": date,
        "record_type": record_type,
        "cover_big": f"https://cdn/{album_id}-500.jpg",
        "cover_medium": f"https://cdn/{album_id}-250.jpg",
        "link": f"https://www.deezer.com/album/{album_id}",
    }


def _source(albums, deezer):
    return YourArtistsSource(deezer=deezer, music_repository=FakeMusic(albums), logger=LOG)


# ------------------------------------------------------------- normalization

class TestKeys:
    def test_artist_spellings_collapse(self):
        assert artist_key("Beatles, The") == artist_key("The Beatles")
        assert artist_key("Beyoncé") == artist_key("Beyonce")
        assert artist_key("Bad Bunny feat. Jhay Cortez") == artist_key("Bad Bunny")

    def test_primary_credit_of_a_collaboration(self):
        assert primary_credit("Rosalía & J Balvin") == "Rosalía"
        assert primary_credit("Calvin Harris x Dua Lipa") == "Calvin Harris"
        assert primary_credit("Daft Punk") == "Daft Punk"

    @pytest.mark.parametrize(
        "variant",
        ["Discovery (Deluxe Edition)", "Discovery [Explicit]", "Discovery (Remastered 2021)", "DISCOVERY"],
    )
    def test_album_packaging_is_noise(self, variant):
        assert album_title_key(variant) == album_title_key("Discovery")

    def test_a_live_album_is_a_different_record(self):
        assert album_title_key("Alive (Live)") != album_title_key("Alive")


# ----------------------------------------------------------------- selection

class TestPicking:
    def test_biggest_first_then_most_recent(self):
        artists = [
            LibraryArtist(key=f"a{i}", name=f"A{i}", album_count=10 - i, track_count=10, latest_added=float(i))
            for i in range(10)
        ]
        order = [a.key for a in pick_artists(artists)]
        # four biggest, then the two newest not already in, then the rest by size
        assert order[:4] == ["a0", "a1", "a2", "a3"]
        assert order[4:6] == ["a9", "a8"]
        assert order[6:] == ["a4", "a5", "a6", "a7"]

    def test_is_deterministic(self):
        artists = [LibraryArtist(key=k, name=k, album_count=1, track_count=1) for k in "dcba"]
        assert [a.key for a in pick_artists(artists)] == [a.key for a in pick_artists(list(reversed(artists)))]

    def test_placeholder_credits_are_not_artists(self):
        view = read_library([
            _album("Mix", "Unknown Artist"),
            _album("Comp", "Various Artists"),
            _album("Real", "Real Band"),
        ])
        assert [a.key for a in view.artists] == [artist_key("Real Band")]

    def test_counts_albums_and_tracks_per_artist(self):
        view = read_library([
            _album("One", "Daft Punk", n_tracks=2, added=5.0),
            _album("Two", "Daft Punk", n_tracks=3, added=9.0),
        ])
        (artist,) = view.artists
        assert (artist.album_count, artist.track_count, artist.latest_added) == (2, 5, 9.0)


# -------------------------------------------------------------- the row itself

class TestRecommendations:
    def test_recommends_only_what_the_library_lacks(self):
        deezer = FakeDeezer(
            artists={"Daft Punk": 27},
            discographies={27: [
                _cat(1, "Discovery (Deluxe Edition)", "2001-03-12"),  # owned, in other packaging
                _cat(2, "Homework", "1997-01-20"),
                _cat(3, "Random Access Memories", "2013-05-17"),
                _cat(4, "Random Access Memories", "2013-05-17"),  # Deezer's clean twin
                _cat(5, "Get Lucky", "2013-04-19", record_type="single"),
                _cat(6, "Alive 2007 (Live)", "2007-11-19"),
            ]},
        )
        source = _source([_album("Discovery", "Daft Punk")], deezer)

        items = source.fetch_items()

        assert [i.title for i in items] == ["Random Access Memories", "Alive 2007 (Live)", "Homework"]
        assert all(i.subtitle == "Daft Punk" for i in items)
        assert items[0].image_url.endswith("-500.jpg")  # the 500 px rung, like the charts
        assert items[0].provider_url.startswith("https://www.deezer.com/album/")

    def test_an_owned_album_under_a_featuring_credit_is_still_owned(self):
        deezer = FakeDeezer(artists={"Bad Bunny": 1}, discographies={1: [_cat(10, "YHLQMDLG"), _cat(11, "Oasis")]})
        source = _source([
            _album("YHLQMDLG", "Bad Bunny feat. Jhay Cortez"),
        ], deezer)

        assert [i.title for i in source.fetch_items()] == ["Oasis"]
        # searched by the credit without its "feat." tail
        assert deezer.calls[0] == ("search", "Bad Bunny")

    def test_a_featuring_lookalike_in_the_results_is_not_a_match(self):
        """``normalize_key`` would cut "X feat. Y Tribute" down to "X"."""
        deezer = FakeDeezer(artists={}, discographies={999: [_cat(1, "Covers")]})
        deezer.search_entities = lambda entity, query, limit=5: [
            {"id": 999, "name": f"{query} feat. Someone Tribute Band"}
        ]
        source = _source([_album("Album", "Real Band")], deezer)

        assert source.fetch_items() == []

    def test_only_an_exact_name_match_is_accepted(self):
        # The fake always offers "<name> Tribute Band" first; with no exact
        # artist in the catalog, nothing is recommended rather than a stranger.
        deezer = FakeDeezer(artists={}, discographies={999: [_cat(1, "Covers")]})
        source = _source([_album("Album", "Obscure Local Band")], deezer)

        assert source.fetch_items() == []
        assert ("albums", 999) not in deezer.calls

    def test_a_collaboration_falls_back_to_its_primary_credit(self):
        deezer = FakeDeezer(artists={"Rosalía": 7}, discographies={7: [_cat(70, "Motomami")]})
        source = _source([_album("El Mal Querer", "Rosalía & J Balvin")], deezer)

        items = source.fetch_items()

        assert [i.title for i in items] == ["Motomami"]
        assert [c[1] for c in deezer.calls if c[0] == "search"] == ["Rosalía & J Balvin", "Rosalía"]

    def test_interleaves_artists_and_caps_each(self):
        many = [_cat(100 + i, f"Record {i}", f"20{10 + i}-01-01") for i in range(8)]
        deezer = FakeDeezer(
            artists={"Alpha": 1, "Beta": 2},
            discographies={1: many, 2: [_cat(200, "Beta One"), _cat(201, "Beta Two", "2019-01-01")]},
        )
        source = _source([
            _album("A1", "Alpha"), _album("A2", "Alpha"),
            _album("B1", "Beta"),
        ], deezer)

        items = source.fetch_items()

        assert [i.subtitle for i in items[:4]] == ["Alpha", "Beta", "Alpha", "Beta"]
        assert sum(i.subtitle == "Alpha" for i in items) == ALBUMS_PER_ARTIST

    def test_an_empty_library_costs_no_requests(self):
        deezer = FakeDeezer()
        assert _source([], deezer).fetch_items() == []
        assert deezer.calls == []


class TestBudget:
    def test_never_exceeds_the_request_ceiling(self):
        # Twenty artists, none matchable: every one would cost a search.
        albums = [_album(f"Album {i}", f"Band {i} & Friend") for i in range(20)]
        deezer = FakeDeezer()

        _source(albums, deezer).fetch_items()

        assert len(deezer.calls) <= MAX_REQUESTS

    def test_resolves_at_most_max_artists(self):
        albums = [_album(f"Album {i}", f"Band {i}") for i in range(12)]
        artists = {f"Band {i}": i + 1 for i in range(12)}
        deezer = FakeDeezer(artists=artists, discographies={i + 1: [_cat(1000 + i, f"New {i}")] for i in range(12)})

        items = _source(albums, deezer).fetch_items()

        assert len([c for c in deezer.calls if c[0] == "albums"]) == MAX_ARTISTS
        assert len(items) == MAX_ARTISTS

    def test_a_provider_error_stops_the_walk(self):
        albums = [_album("Big", "First", n_tracks=9), _album("Small", "Second", n_tracks=1)]
        deezer = FakeDeezer(artists={"First": 1, "Second": 2}, fail_on="Second",
                            discographies={1: [_cat(1, "Other")], 2: [_cat(2, "Else")]})

        items = _source(albums, deezer).fetch_items()

        assert [i.title for i in items] == ["Other"]  # what resolved before the error stays

    def test_an_error_before_anything_resolved_is_raised(self):
        deezer = FakeDeezer(artists={"First": 1}, fail_on="First")
        with pytest.raises(ExternalAPIError):
            _source([_album("Big", "First")], deezer).fetch_items()


# ------------------------------------------------- against a real library dir

def test_reads_a_real_library_directory(tmp_path):
    """The real ``MusicRepository`` over a temp dir, tags faked at mutagen."""
    music_dir = tmp_path / "music"
    tags = {
        "Discovery": ("Daft Punk", "Discovery"),
        "Homework_dir": ("Daft Punk", "Homework (Remastered)"),
    }
    for folder in tags:
        (music_dir / folder).mkdir(parents=True)
        (music_dir / folder / "01.mp3").write_text("fake")
    os.utime(music_dir / "Discovery" / "01.mp3", (2_000_000_000, 2_000_000_000))

    config = Mock(base_music_dir=music_dir, temp_dir=tmp_path / "temp", enable_waveform_cache=True, analysis_workers=2)
    config.analysis_db = tmp_path / "analysis.sqlite"
    config.jobs_file = tmp_path / "jobs.sqlite"
    config.cover_cache_dir = tmp_path / "cache" / "covers"
    config.cover_cache_mb = 200
    config.temp_dir.mkdir()
    repo = MusicRepository(config, Mock())
    repo.first_seen.get(music_dir / "Discovery" / "01.mp3", receipt=2_000_000_000)

    def fake_mutagen(path):
        artist, album = tags[os.path.basename(os.path.dirname(path))]
        audio = Mock()
        audio.info.length = 200.0
        audio.tags = {"TIT2": Mock(text=["Song"]), "TPE1": Mock(text=[artist]), "TALB": Mock(text=[album])}
        return audio

    deezer = FakeDeezer(
        artists={"Daft Punk": 27},
        discographies={27: [_cat(1, "Discovery"), _cat(2, "Homework"), _cat(3, "Human After All")]},
    )
    with patch("app.domains.music.repositories.MutagenFile", side_effect=fake_mutagen):
        source = YourArtistsSource(deezer=deezer, music_repository=repo, logger=LOG)
        view = source.library()
        items = source.fetch_items()

    (artist,) = view.artists
    assert (artist.name, artist.album_count, artist.latest_added) == ("Daft Punk", 2, 2_000_000_000)
    assert [i.title for i in items] == ["Human After All"]


# ------------------------------------------------------- inside the dashboard

class _Provider:
    provider_id = "deezer"
    provider_name = "Deezer"

    def fetch_chart_rows(self):
        from app.domains.dashboard.models import PODCASTS, TOP_ALBUMS, TOP_ARTISTS, TOP_PLAYLISTS, TOP_TRACKS
        item = DashboardItem(id="1", title="x")
        return {TOP_PLAYLISTS: [item], TOP_ARTISTS: [item], TOP_ALBUMS: [item], TOP_TRACKS: [item], PODCASTS: [item]}

    def fetch_new_releases(self):
        return [DashboardItem(id="2", title="y")]

    def fetch_genres(self):
        return [DashboardItem(id="3", title="z")]


class _Source:
    def __init__(self, items=None, error=None):
        self.items = items or []
        self.error = error
        self.owned_titles: set[str] = set()
        self.fetches = 0

    def fetch_items(self):
        self.fetches += 1
        if self.error:
            raise self.error
        return list(self.items)

    def drop_owned(self, items):
        return [i for i in items if i.title not in self.owned_titles]


def _service(tmp_path, source):
    cache = DashboardCacheRepository(config=None, logger=LOG, cache_path=tmp_path / "cache.json")
    return DashboardService(provider=_Provider(), cache_repo=cache, config=None, logger=LOG, your_artists=source)


class TestInsideTheDashboard:
    def test_the_row_follows_the_chart_rows(self, tmp_path):
        source = _Source(items=[DashboardItem(id="9", title="Homework", subtitle="Daft Punk")])
        dashboard = _service(tmp_path, source).get_dashboard()

        assert [r.id for r in dashboard.rows] == [*ROW_ORDER, ROW_ID]
        row = dashboard.row(ROW_ID)
        assert (row.kind, row.provider, row.error) == ("album", "deezer", None)
        assert row.items[0].subtitle == "Daft Punk"

    def test_empty_is_honest_not_an_error(self, tmp_path):
        dashboard = _service(tmp_path, _Source(items=[])).get_dashboard()

        row = dashboard.row(ROW_ID)
        assert row.items == [] and row.error is None
        assert dashboard.stale is False

    def test_is_cached_with_the_rest(self, tmp_path):
        source = _Source(items=[DashboardItem(id="9", title="Homework")])
        service = _service(tmp_path, source)
        service.get_dashboard()
        service.get_dashboard()

        assert source.fetches == 1

    def test_a_failure_serves_the_previous_copy_stale(self, tmp_path):
        source = _Source(items=[DashboardItem(id="9", title="Homework")])
        service = _service(tmp_path, source)
        service.get_dashboard()

        source.error = ExternalAPIError("Quota limit exceeded", "Deezer")
        dashboard = service.get_dashboard(force_refresh=True)

        row = dashboard.row(ROW_ID)
        assert row.stale is True and row.error and [i.title for i in row.items] == ["Homework"]
        # the chart rows are untouched by this row's failure
        assert all(not dashboard.row(r).error for r in ROW_ORDER)

    def test_a_cached_album_you_since_acquired_is_dropped_when_served(self, tmp_path):
        source = _Source(items=[DashboardItem(id="9", title="Homework"), DashboardItem(id="8", title="Alive")])
        service = _service(tmp_path, source)
        service.get_dashboard()

        source.owned_titles = {"Homework"}
        dashboard = service.get_dashboard()

        assert source.fetches == 1  # still the cached copy
        assert [i.title for i in dashboard.row(ROW_ID).items] == ["Alive"]

    def test_a_snapshot_from_before_the_row_existed_is_refreshed(self, tmp_path):
        _service(tmp_path, None).get_dashboard()  # cache written without the row
        source = _Source(items=[DashboardItem(id="9", title="Homework")])

        dashboard = _service(tmp_path, source).get_dashboard()

        assert source.fetches == 1 and dashboard.row(ROW_ID) is not None

    def test_the_last_resort_payload_includes_the_row(self, tmp_path):
        dashboard = _service(tmp_path, _Source()).empty_dashboard("down")
        assert dashboard.row(ROW_ID).error == "down"
