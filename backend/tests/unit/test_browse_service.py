"""Check complete album tracklists, duration units, and capability dispatch.

Disabled providers make no outbound calls; a counting fake measures the budget.
"""
import logging
from typing import Any

import pytest

from app.domains.browse.repositories import DeezerBrowseProvider, full_size_image_url
from app.domains.browse.services import BrowseService, ProviderUnavailable
from app.exceptions import ExternalAPIError, ValidationError
from app.providers.registry import Capability, ProviderDescriptor, ProviderKind

LOG = logging.getLogger("test.browse")


# ----------------------------------------------------------------- fake Deezer

def _track_row(track_id: int, title: str, position: int, isrc: str = "GBDUW0000053", disc: int = 1):
    return {
        "id": track_id,
        "title": title,
        "duration": 320,
        "track_position": position,
        "disk_number": disc,
        "isrc": isrc,
        "preview": f"https://cdn.deezer.test/{track_id}.mp3",
        "link": f"https://www.deezer.com/track/{track_id}",
        "artist": {"id": 27, "name": "Daft Punk"},
    }


ALBUM_HEADER = {
    "id": 302127,
    "title": "Discovery",
    "link": "https://www.deezer.com/album/302127",
    "cover_medium": "https://cdn.deezer.test/cover_medium.jpg",
    "cover_big": "https://cdn.deezer.test/cover_big.jpg",
    "cover_xl": "https://cdn.deezer.test/cover_xl.jpg",
    "release_date": "2001-03-07",
    "record_type": "album",
    "nb_tracks": 2,
    "label": "Daft Life Ltd.",
    "artist": {"id": 27, "name": "Daft Punk", "link": "https://www.deezer.com/artist/27"},
    "genres": {"data": [{"id": 106, "name": "Electro"}]},
    # The trap: the header inlines a tracklist that omits isrc, track_position
    # and disk_number. Nothing may read this.
    "tracks": {
        "data": [
            {"id": 1, "title": "WRONG SOURCE", "duration": 1, "artist": {"name": "Daft Punk"}},
        ]
    },
}


class FakeDeezer:
    """Counts calls so "did it actually stop / did it call twice" is observable."""

    def __init__(self, fail: str = ""):
        self.calls: list[str] = []
        self.fail = fail

    def _note(self, name: str):
        self.calls.append(name)
        if self.fail == name:
            raise ExternalAPIError("boom", api_name="deezer", details={"deezer_error": {"code": 4}})

    def fetch_album(self, album_id):
        self._note("fetch_album")
        return dict(ALBUM_HEADER)

    def fetch_album_tracks(self, album_id, limit=100):
        self._note("fetch_album_tracks")
        # Deliberately out of order: the service must sort.
        return [_track_row(302, "Aerodynamic", 2), _track_row(301, "One More Time", 1)]

    def fetch_artist(self, artist_id):
        self._note("fetch_artist")
        return {"id": 27, "name": "Daft Punk", "nb_fan": 5, "nb_album": 36, "picture_medium": "p.jpg"}

    def fetch_artist_top(self, artist_id, limit=20):
        self._note("fetch_artist_top")
        return [_track_row(1, "Top", 1)]

    def fetch_artist_albums(self, artist_id, limit=100):
        self._note("fetch_artist_albums")
        return [dict(ALBUM_HEADER)]

    def fetch_artist_related(self, artist_id, limit=20):
        self._note("fetch_artist_related")
        return [{"id": 99, "name": "Justice", "picture_medium": "j.jpg"}]

    def fetch_artist_playlists(self, artist_id, limit=20):
        self._note("fetch_artist_playlists")
        return [{"id": 7, "title": "Mix", "nb_tracks": 3, "creator": {"name": "Alex"}}]

    def fetch_playlist(self, playlist_id):
        self._note("fetch_playlist")
        return {
            "id": 908,
            "title": "En mode 60",
            "nb_tracks": 1,
            "creator": {"name": "Alex"},
            "picture_medium": "pl.jpg",
            "tracks": {"data": [_track_row(11, "Song", 1)]},
        }

    def fetch_genre(self, genre_id):
        self._note("fetch_genre")
        return {"id": int(genre_id), "name": "Cumbia", "picture_big": "g.jpg"}

    def fetch_chart(self, limit=20, genre_id=0):
        self._note(f"fetch_chart:{genre_id}")
        return {
            "tracks": {"data": [_track_row(5, "La pollera colorá", 1)]},
            "albums": {"data": [dict(ALBUM_HEADER)]},
            "artists": {"data": [{"id": 99, "name": "Los Ángeles Azules"}]},
            "playlists": {"data": [{"id": 7, "title": "Cumbia sonidera", "creator": {"name": "Deezer"}}]},
        }

    def search_entities(self, entity, query, limit=20):
        self._note(f"search:{entity}")
        if entity == "album":
            return [dict(ALBUM_HEADER)]
        if entity == "artist":
            return [{"id": 27, "name": "Daft Punk"}]
        if entity == "track":
            return [_track_row(1, "One More Time", 1)]
        return [{"id": 7, "title": "Mix", "creator": {"name": "Alex"}}]


class MemoryCache:
    """The cache contract the service uses, in memory."""

    def __init__(self):
        self.entries: dict[str, Any] = {}
        self.saves = 0

    @staticmethod
    def key(kind, provider, entity_id):
        return f"{kind}:{provider}:{entity_id}"

    def load(self, key, max_age_s):
        return self.entries.get(key)

    def save(self, key, payload):
        self.entries[key] = payload
        self.saves += 1
        return True


DEEZER_LIKE = ProviderDescriptor(
    id="deezer",
    kind=ProviderKind.METADATA,
    name="Deezer",
    description="test",
    capabilities=(
        Capability.ISRC,
        Capability.SEARCH_ARTISTS,
        Capability.SEARCH_ALBUMS,
        Capability.SEARCH_TRACKS,
        Capability.SEARCH_PLAYLISTS,
        Capability.ARTIST_DETAILS,
        Capability.ARTIST_TOP,
        Capability.ARTIST_ALBUMS,
        Capability.ARTIST_RELATED,
        Capability.ARTIST_PLAYLISTS,
        Capability.ALBUM_DETAILS,
        Capability.PLAYLIST_DETAILS,
        Capability.GENRE_DETAILS,
    ),
)

#: Declares artist details but only one section, and cannot do albums at all.
NARROW = ProviderDescriptor(
    id="narrow",
    kind=ProviderKind.METADATA,
    name="Narrow",
    description="test",
    capabilities=(Capability.ARTIST_DETAILS, Capability.ARTIST_TOP, Capability.SEARCH_ARTISTS),
)


class FakeRegistry:
    def __init__(self, entries, enabled=None, available=None):
        self._entries = entries
        self._enabled = enabled if enabled is not None else {k: True for k in entries}
        self._available = available or {}

    def get(self, provider_id):
        return self._entries.get(provider_id)

    def is_enabled(self, provider_id):
        return self._enabled.get(provider_id, True)

    def availability(self, provider_id):
        return self._available.get(provider_id, (True, None))

    def order(self, kind, include_unavailable=False):
        return [k for k in self._entries if self._enabled.get(k, True)]


@pytest.fixture
def wiring():
    def build(descriptor=DEEZER_LIKE, enabled=True, fail="", extra=None):
        deezer = FakeDeezer(fail=fail)
        instance = DeezerBrowseProvider(deezer=deezer, logger=LOG)
        entries = {descriptor.id: (descriptor, instance)}
        if extra:
            entries.update(extra)
        registry = FakeRegistry(entries, enabled={descriptor.id: enabled})
        cache = MemoryCache()
        service = BrowseService(
            registry=registry, cache_repo=cache, config=None, logger=LOG
        )
        return service, deezer, cache, registry

    return build


class TestAlbumTracklistSource:
    """The inline array in /album/{id} is not the tracklist. This is the point."""

    def test_uses_the_dedicated_tracks_endpoint(self, wiring):
        service, deezer, _cache, _r = wiring()

        page = service.get_album("deezer", "302127")

        assert "fetch_album_tracks" in deezer.calls, "must call /album/{id}/tracks"
        titles = [t.title for t in page.tracks]
        assert "WRONG SOURCE" not in titles, "read the inline tracks array from the header"
        assert titles == ["One More Time", "Aerodynamic"]

    def test_every_track_keeps_its_isrc(self, wiring):
        """No ISRC means match_track can never return STRONG for these tracks."""
        service, _d, _c, _r = wiring()

        page = service.get_album("deezer", "302127")

        assert all(t.isrc for t in page.tracks)
        assert page.tracks[0].isrc == "GBDUW0000053"

    def test_tracks_are_ordered_by_disc_then_position(self, wiring):
        service, _d, _c, _r = wiring()

        page = service.get_album("deezer", "302127")

        assert [t.track_position for t in page.tracks] == [1, 2]

    def test_duration_is_seconds_not_milliseconds(self, wiring):
        """A ms/s mix-up disarms DURATION_VETO_S silently, by accepting more."""
        service, _d, _c, _r = wiring()

        page = service.get_album("deezer", "302127")

        assert page.tracks[0].duration_s == 320.0

    def test_tracks_inherit_the_album_they_belong_to(self, wiring):
        """/album/{id}/tracks rows carry no album object of their own."""
        service, _d, _c, _r = wiring()

        page = service.get_album("deezer", "302127")

        assert page.tracks[0].album_title == "Discovery"
        assert page.tracks[0].album_ref.id == "302127"
        assert page.tracks[0].cover_url, "needed to embed a cover on download"

    def test_album_header_is_mapped(self, wiring):
        service, _d, _c, _r = wiring()

        album = service.get_album("deezer", "302127").album

        assert album.ref.provider == "deezer"
        assert album.ref.id == "302127"
        assert album.ref.url == "https://www.deezer.com/album/302127"
        assert album.artist_name == "Daft Punk"
        assert album.artist_ref.id == "27"
        assert album.genres == ["Electro"]
        # cover_big, not cover_medium: the smallest surface that draws this is
        # a 152 CSS px card (304 device px), the largest is the phone's 150 pt
        # catalog card (450 px at @3x), and 250 px was below both. Not cover_xl
        # either — 1000 px is for the file an acquisition keeps, not for a grid.
        assert album.cover_url.endswith("cover_big.jpg")


class TestProviderRefIsTheIdentity:
    """Navigate by provider identity while retaining the URL as an optional link."""

    def test_ref_carries_provider_and_id_with_url_as_an_extra(self, wiring):
        service, _d, _c, _r = wiring()

        payload = service.get_album("deezer", "302127").to_dict()

        ref = payload["album"]["ref"]
        assert ref["provider"] == "deezer"
        assert ref["id"] == "302127"
        # Present, but an attribute rather than the identity.
        assert ref["url"].startswith("https://www.deezer.com/")


class TestCapabilityGating:
    def test_provider_without_the_capability_is_refused(self, wiring):
        service, deezer, _c, _r = wiring(descriptor=NARROW)

        with pytest.raises(ProviderUnavailable, match="no puede mostrar esto"):
            service.get_album("narrow", "302127")

        assert deezer.calls == [], "must not call a provider it is not allowed to ask"

    def test_artist_sections_follow_the_declared_capabilities(self, wiring):
        """A provider declaring only artist:top is asked only for top tracks."""
        service, deezer, _c, _r = wiring(descriptor=NARROW)

        page = service.get_artist("narrow", "27")

        assert "fetch_artist_top" in deezer.calls
        assert "fetch_artist_albums" not in deezer.calls
        assert "fetch_artist_related" not in deezer.calls
        assert page.albums == []
        assert page.related == []

    def test_full_provider_gets_every_section(self, wiring):
        service, deezer, _c, _r = wiring()

        page = service.get_artist("deezer", "27")

        assert page.top_tracks and page.albums and page.related and page.playlists
        assert page.partial == []

    def test_search_narrows_to_the_categories_the_provider_declares(self, wiring):
        service, deezer, _c, _r = wiring(descriptor=NARROW)

        results = service.search("daft punk", categories=["artists", "albums"])

        assert "search:artist" in deezer.calls
        assert "search:album" not in deezer.calls
        assert results.artists and results.albums == []

    def test_unknown_provider_is_refused(self, wiring):
        service, _d, _c, _r = wiring()

        with pytest.raises(ProviderUnavailable, match="no existe"):
            service.get_album("nope", "1")


class TestDisabledProviderMakesNoRequests:
    """Turning a provider off must stop traffic, not just hide a page."""

    def test_explicit_provider_that_is_disabled(self, wiring):
        service, deezer, _c, _r = wiring(enabled=False)

        with pytest.raises(ProviderUnavailable, match="está desactivada"):
            service.get_album("deezer", "302127")

        assert deezer.calls == []

    def test_search_with_no_provider_left_enabled(self, wiring):
        service, deezer, _c, _r = wiring(enabled=False)

        with pytest.raises(ProviderUnavailable, match="Ninguna fuente activa"):
            service.search("daft punk")

        assert deezer.calls == []

    def test_capability_is_reported_before_a_missing_credential(self, wiring):
        """"Genius cannot serve albums" is true whether or not it has a key."""
        service, _d, _c, _r = wiring(
            descriptor=NARROW,
        )
        service.registry._available["narrow"] = (False, "Add an API key")

        with pytest.raises(ProviderUnavailable, match="no puede mostrar esto"):
            service.get_album("narrow", "1")


class TestCaching:
    def test_second_read_makes_no_request(self, wiring):
        service, deezer, _cache, _r = wiring()

        service.get_album("deezer", "302127")
        first = list(deezer.calls)
        service.get_album("deezer", "302127")

        assert deezer.calls == first, "a cached album must not touch the provider"

    def test_refresh_bypasses_the_cache(self, wiring):
        service, deezer, _cache, _r = wiring()

        service.get_album("deezer", "302127")
        service.get_album("deezer", "302127", force_refresh=True)

        assert deezer.calls.count("fetch_album") == 2

    def test_cached_album_round_trips_through_serialization(self, wiring):
        """The cache stores dicts; what comes back must still be a usable page."""
        service, _d, _c, _r = wiring()

        first = service.get_album("deezer", "302127")
        second = service.get_album("deezer", "302127")

        assert [t.isrc for t in second.tracks] == [t.isrc for t in first.tracks]
        assert [t.track_position for t in second.tracks] == [t.track_position for t in first.tracks]
        assert second.tracks[0].duration_s == first.tracks[0].duration_s
        assert second.album.genres == first.album.genres

    def test_a_partial_artist_page_is_not_cached_at_full_ttl(self, wiring):
        """A missing section should heal, not persist for a day."""
        service, _d, cache, _r = wiring(fail="fetch_artist_related")

        page = service.get_artist("deezer", "27")

        assert page.partial == ["related"]
        assert cache.saves == 0

    def test_a_failed_search_is_not_cached(self, wiring):
        service, _d, cache, _r = wiring(fail="search:album")

        results = service.search("daft punk", categories=["albums"])

        assert results.failed == ["albums"]
        assert cache.saves == 0


class TestDegradation:
    def test_one_failed_artist_section_leaves_the_others_intact(self, wiring):
        service, _d, _c, _r = wiring(fail="fetch_artist_related")

        page = service.get_artist("deezer", "27")

        assert page.partial == ["related"]
        assert page.top_tracks and page.albums, "other sections must survive"

    def test_a_failed_album_header_propagates(self, wiring):
        """An album with no header is not a page; degrading would be a lie."""
        service, _d, _c, _r = wiring(fail="fetch_album")

        with pytest.raises(ExternalAPIError):
            service.get_album("deezer", "302127")


class TestSearchValidation:
    def test_empty_query_is_refused(self, wiring):
        service, _d, _c, _r = wiring()

        with pytest.raises(ValidationError):
            service.search("   ")

    def test_unknown_category_is_refused(self, wiring):
        service, _d, _c, _r = wiring()

        with pytest.raises(ValidationError, match="songs"):
            service.search("x", categories=["albums", "songs"])

    def test_results_report_what_was_requested(self, wiring):
        service, _d, _c, _r = wiring()

        results = service.search("daft punk", categories=["albums", "tracks"])

        assert results.requested == ["albums", "tracks"]
        assert results.failed == []
        assert results.tracks[0].isrc


class TestFullSizeImageUrl:
    """The display size and the embedded size are different sizes.

    A browse card wants 500 px; the artwork burned into a downloaded MP3 wants
    the largest variant the provider has, because that one is permanent. Deezer
    puts the size in the URL path, so the second is derivable from the first
    with no extra request against a per-IP quota.
    """

    def test_a_deezer_cover_is_upgraded_to_the_full_size_variant(self):
        url = (
            "https://cdn-images.dzcdn.net/images/cover/"
            "5718f7c81c27e0b2417e2a4c45224f8a/500x500-000000-80-0-0.jpg"
        )

        assert full_size_image_url(url) == (
            "https://cdn-images.dzcdn.net/images/cover/"
            "5718f7c81c27e0b2417e2a4c45224f8a/1000x1000-000000-80-0-0.jpg"
        )

    def test_a_stale_250px_url_is_repaired_too(self):
        """The browse cache keeps assembled pages for 24 h.

        A client acquiring from a page cached before the ladder was widened is
        still holding a 250 px URL, and rewriting here is what stops that from
        becoming 250 px of permanent album art.
        """
        url = (
            "https://e-cdns-images.dzcdn.net/images/artist/"
            "638e69b9caaf9f9f3f8826febea7b543/250x250-000000-80-0-0.jpg"
        )

        assert "/1000x1000-" in full_size_image_url(url)

    @pytest.mark.parametrize(
        "url",
        [
            "https://i.scdn.co/image/ab67616d0000b273abc",  # another provider
            "https://cdn-images.dzcdn.net.evil.test/images/cover/x/250x250-0.jpg",
            "https://api.deezer.com/album/302127/image",  # the redirect form
            None,
            "",
        ],
    )
    def test_anything_that_is_not_a_sized_deezer_url_is_left_alone(self, url):
        """Never guess. A URL this does not recognise is returned verbatim —
        including one on a lookalike host, so a rewrite can never move a fetch
        to a different origin."""
        assert full_size_image_url(url) == url


class TestGenrePage:
    """A genre opens its own chart: two requests, cached like any entity page."""

    def test_the_genre_chart_fills_four_sections(self, wiring):
        service, deezer, cache, _r = wiring()

        page = service.get_genre("deezer", "71")

        assert page.genre.name == "Cumbia"
        assert [t.title for t in page.tracks] == ["La pollera colorá"]
        assert page.albums[0].title == "Discovery"
        assert page.artists[0].name == "Los Ángeles Azules"
        assert page.playlists[0].title == "Cumbia sonidera"
        assert deezer.calls == ["fetch_genre", "fetch_chart:71"]

        service.get_genre("deezer", "71")
        assert deezer.calls == ["fetch_genre", "fetch_chart:71"], "the second visit is served from the cache"

    def test_a_provider_without_the_capability_is_never_asked(self, wiring):
        service, deezer, _c, _r = wiring(descriptor=NARROW)
        with pytest.raises(ProviderUnavailable):
            service.get_genre("narrow", "71")
        assert deezer.calls == []


class TestSearchMechanics:
    def test_cache_key_folds_accents_case_and_whitespace(self, wiring):
        from unittest.mock import Mock
        service, deezer, cache, _ = wiring()
        deezer.search_autocomplete = Mock(return_value={"data": []})
        service.search("  CANCIÓN   NIÑO ")
        first = list(deezer.calls)
        service.search("cancion nino")
        assert deezer.calls == first
        assert len(cache.entries) == 1
        service.search("cancion nino", mode="typing")
        assert len(cache.entries) == 2

    def test_identical_searches_share_one_flight_even_when_the_cache_cannot_save(self, wiring):
        from concurrent.futures import Future, ThreadPoolExecutor
        from threading import Event
        from unittest.mock import Mock, patch
        from app.domains.browse.models import SearchResults

        service, _, cache, registry = wiring()
        entered, release, joined = Event(), Event(), Event()

        class ObservedFuture(Future):
            def result(self, timeout=None):
                joined.set()
                return super().result(timeout)

        def fetch(*args, **kwargs):
            entered.set()
            assert release.wait(3)
            return SearchResults(query="cancion", failed=["artists"])

        provider = registry.get("deezer")[1]
        provider.search_catalog = Mock(side_effect=fetch)
        with patch("app.domains.browse.services.Future", ObservedFuture), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(service.search, "Canción")
            assert entered.wait(3)
            second = pool.submit(service.search, "CANCION")
            try:
                assert joined.wait(3)
            finally:
                release.set()
            assert first.result() is second.result()
        assert provider.search_catalog.call_count == 1
        assert cache.entries == {}
        assert service._search_flights == {}

    def test_failed_flight_is_removed_and_next_attempt_can_retry(self, wiring):
        from unittest.mock import Mock
        service, _, _, registry = wiring()
        provider = registry.get("deezer")[1]
        provider.search_catalog = Mock(side_effect=RuntimeError("offline"))
        for _ in range(2):
            with pytest.raises(RuntimeError, match="offline"):
                service.search("dua")
            assert service._search_flights == {}
        assert provider.search_catalog.call_count == 2

    def test_typing_maps_all_categories_from_one_call_and_full_keeps_four_calls(self, wiring):
        import json
        from pathlib import Path
        from unittest.mock import Mock
        service, deezer, _, _ = wiring()
        fixture = json.loads((Path(__file__).parents[1] / "fixtures/browse/deezer-autocomplete.contract.json").read_text())
        deezer.search_autocomplete = Mock(return_value=fixture)
        results = service.search("dua", mode="typing")
        assert results.artists[0].name == "Dua Lipa"
        assert results.albums[0].title == "Future Nostalgia"
        assert results.tracks[0].title == "Levitating"
        assert results.playlists[0].title == "Pop Mix"
        deezer.search_autocomplete.assert_called_once_with("dua", limit=20)
        assert deezer.calls == []
        service.search("dua")
        assert len(deezer.calls) == 4

    def test_autocomplete_unknown_shape_and_failure_fall_back(self, wiring):
        from unittest.mock import Mock
        service, deezer, _, _ = wiring()
        deezer.search_autocomplete = Mock(return_value={"unexpected": []})
        assert service.search("dua", mode="typing").tracks
        assert len(deezer.calls) == 4
        deezer.calls.clear()
        deezer.search_autocomplete.side_effect = ExternalAPIError("offline", api_name="deezer")
        assert service.search("lipa", mode="typing").artists
        assert len(deezer.calls) == 4

    def test_flat_typed_rows_and_category_subset(self, wiring):
        from unittest.mock import Mock
        service, deezer, _, _ = wiring()
        deezer.search_autocomplete = Mock(return_value={"data": [
            {"id": 1, "type": "artist", "name": "Dua Lipa"},
            {"id": 2, "type": "track", "title": "Future", "artist": {"name": "Dua Lipa"}},
        ]})
        result = service.search("dua", categories=["artists"], mode="typing")
        assert result.artists[0].name == "Dua Lipa"
        assert result.tracks == []
        assert result.requested == ["artists"]
        assert result.failed == []
