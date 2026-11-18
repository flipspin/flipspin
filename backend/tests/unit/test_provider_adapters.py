"""Check adapter units, structured search, availability, and sync/async bridging.

Stub repositories keep network and subprocesses out of the suite.
"""
import asyncio
import pytest
from unittest.mock import Mock

from app.domains.metadata.matching import Candidate, WantedTrack
from app.providers.adapters import (
    DEEZER,
    GENIUS,
    MUSICBRAINZ,
    SPOTIFY,
    DeezerMetadataProvider,
    GeniusLyricsProvider,
    MusicBrainzMetadataProvider,
    SpotifyMetadataProvider,
    SourceStreamingProvider,
    default_descriptors,
    _run_coroutine,
)
from app.providers.registry import ProviderKind


class TestDescriptors:
    def test_ids_are_the_ones_persisted_in_providers_json(self):
        """These strings are written to a user's settings file. Frozen forever."""
        assert set(default_descriptors()) == {
            "deezer", "musicbrainz", "deezer-dashboard", "spotify", "lrclib", "genius", "lyricsovh"
        }

    def test_default_descriptors_lists_everything_actually_registered(self, tmp_path):
        """A "every descriptor" helper that quietly misses one is worse than none.

        Asserted against what ``build_default_registry`` really registers rather
        than a second hand-written list, because the original bug was exactly a
        hand-written list drifting from reality — ``deezer-dashboard`` was
        registered but omitted here, and a hardcoded expectation agreed with the
        omission instead of catching it.
        """
        from unittest.mock import Mock

        from app.providers.adapters import build_default_registry
        from app.providers.persistence import ProviderPreferenceStore

        registry = build_default_registry(
            __import__("types").SimpleNamespace(data_root=tmp_path, playlist_dir=tmp_path / "playlists"),
            store=ProviderPreferenceStore(path=tmp_path / "providers.json"),
            deezer_repo=Mock(),
        )
        registered = {d.id for d in registry.list()}
        assert set(default_descriptors()) == registered

    def test_kinds_are_assigned_where_the_consumers_expect_them(self):
        assert DEEZER.kind is ProviderKind.METADATA
        assert MUSICBRAINZ.kind is ProviderKind.METADATA
        assert SPOTIFY.kind is ProviderKind.METADATA
        assert GENIUS.kind is ProviderKind.LYRICS

    def test_only_the_credentialled_providers_declare_it(self):
        needs = {d.id for d in default_descriptors().values() if d.requires_credentials}
        assert needs == {"spotify", "genius"}

    def test_deezer_declares_isrc_which_is_why_it_is_asked_first(self):
        """Prioritize recording identifiers because STRONG requires an ISRC or MBID."""
        assert "isrc" in DEEZER.capabilities


class TestDeezerAdapter:
    def test_it_delegates_and_adds_nothing(self):
        repository = Mock()
        repository.search_candidates.return_value = ["sentinel"]
        provider = DeezerMetadataProvider(repository)
        assert provider.search_candidates("q", 3) == ["sentinel"]
        repository.search_candidates.assert_called_once_with("q", 3)

    def test_it_offers_no_structured_search(self):
        """Deezer only takes free text; claiming otherwise would mislead the
        resolver into calling a method that does not exist."""
        assert not hasattr(DeezerMetadataProvider(Mock()), "search_wanted")


class TestMusicBrainzAdapter:
    def test_structured_search_uses_the_fielded_query(self):
        repository = Mock()
        repository.search_recordings.return_value = ["sentinel"]
        provider = MusicBrainzMetadataProvider(repository)

        result = provider.search_wanted(WantedTrack(title="Get Lucky", artist="Daft Punk"), 5)

        assert result == ["sentinel"]
        repository.search_recordings.assert_called_once_with("Get Lucky", "Daft Punk", 5)

    def test_free_text_search_is_still_available_as_a_fallback(self):
        repository = Mock()
        MusicBrainzMetadataProvider(repository).search_candidates("q", 2)
        repository.search_candidates.assert_called_once_with("q", 2)


class TestSpotifyAdapter:
    def _provider(self, results, client_id="id", client_secret="secret"):
        repository = Mock()
        repository.search_tracks.return_value = results
        config = Mock(spotify_client_id=client_id, spotify_client_secret=client_secret)
        return SpotifyMetadataProvider(repository, config)

    def test_duration_is_converted_from_milliseconds(self):
        """Deezer's is seconds and Spotify's is not; a missed /1000 would put
        every candidate under the duration veto and silently disarm it."""
        provider = self._provider([
            {"id": "abc", "name": "Get Lucky", "artist": "Daft Punk",
             "album": "RAM", "duration_ms": 369000, "isrc": "USQX91300809"},
        ])
        candidate = provider.search_candidates("get lucky", 5)[0]
        assert candidate.duration_s == 369.0

    def test_the_isrc_is_carried_through_so_a_hit_can_be_auto_accepted(self):
        provider = self._provider([
            {"id": "abc", "name": "Get Lucky", "artist": "Daft Punk",
             "duration_ms": 369000, "isrc": "usqx91300809"},
        ])
        candidate = provider.search_candidates("q", 5)[0]
        assert candidate.isrc == "USQX91300809"
        assert candidate.is_identifiable is True

    def test_rows_without_an_id_are_dropped(self):
        provider = self._provider([{"name": "No id"}, {"id": "ok", "name": "Fine"}])
        assert [c.provider_id for c in provider.search_candidates("q", 5)] == ["ok"]

    def test_a_missing_duration_stays_unknown_rather_than_becoming_zero(self):
        provider = self._provider([{"id": "abc", "name": "T", "duration_ms": None}])
        assert provider.search_candidates("q", 5)[0].duration_s is None

    def test_a_blank_query_never_reaches_the_api(self):
        provider = self._provider([])
        assert provider.search_candidates("   ", 5) == []
        provider.repository.search_tracks.assert_not_called()

    def test_missing_credentials_make_it_unavailable_with_an_actionable_reason(self):
        provider = self._provider([], client_id=None)
        reason = provider.unavailable_reason()
        assert reason is not None and "Spotify client ID" in reason

    def test_credentials_are_read_live_not_captured_at_construction(self):
        """They are entered at runtime in Settings; a cached flag would keep
        reporting "not configured" until the backend restarted."""
        provider = self._provider([], client_id=None)
        assert provider.unavailable_reason() is not None
        provider.config.spotify_client_id = "id"
        assert provider.unavailable_reason() is None


class TestGeniusAdapter:
    def _provider(self, api_key="key"):
        repository = Mock()
        repository.headers = {}
        return GeniusLyricsProvider(repository, Mock(genius_api_key=api_key), Mock(), scraping_enabled=lambda: True)

    def test_no_api_key_makes_it_unavailable(self):
        assert self._provider(api_key=None).unavailable_reason() is not None
        assert self._provider().unavailable_reason() is None

    def test_a_search_with_no_hits_yields_no_lyrics(self):
        provider = self._provider()
        provider.repository.search_songs.return_value = []
        assert provider.fetch_lyrics("Daft Punk", "Get Lucky") is None

    def test_a_failing_search_reports_unavailable(self):
        """An unavailable source must not look like an empty search."""
        provider = self._provider()
        provider.repository.search_songs.side_effect = RuntimeError("genius is down")
        with pytest.raises(RuntimeError, match="genius is down"):
            provider.fetch_lyrics("Daft Punk", "Get Lucky")

    def test_album_version_retries_base_title_when_exact_search_is_empty(self):
        provider = self._provider()
        provider.repository.search_songs.side_effect = [[], [{
            "title": "No Basta Con Querernos Más", "artist": "Nsqk",
            "url": "https://genius.com/Nsqk-no-basta-con-querernos-mas-lyrics",
        }]]
        provider._scrape_lyrics = Mock(return_value="test lyric")
        assert provider.fetch_lyrics("NSQK", "No Basta Con Querernos Más (Album Version)") == "test lyric"
        assert [c.args[0] for c in provider.repository.search_songs.call_args_list] == [
            "NSQK No Basta Con Querernos Más (Album Version)", "NSQK No Basta Con Querernos Más",
        ]

    @pytest.mark.parametrize("title", ["Song (Live)", "Song (Remix)", "Song (Acoustic)"])
    def test_meaningful_versions_are_not_removed(self, title):
        provider = self._provider()
        provider.repository.search_songs.return_value = []
        assert provider.fetch_lyrics("Artist", title) is None
        provider.repository.search_songs.assert_called_once_with(f"Artist {title}", max_results=1)

    def test_lyrics_are_extracted_from_the_data_attribute_with_line_breaks(self, monkeypatch):
        provider = self._provider()
        provider.repository.search_songs.return_value = [
            {"url": "https://genius.com/daft-punk-get-lucky-lyrics"}
        ]
        html = (
            '<div data-lyrics-container="true">Like the legend of the phoenix'
            "<br/>All ends with beginnings</div>"
        )
        monkeypatch.setattr(
            "app.providers.adapters.safe_get", Mock(return_value=Mock(text=html, raise_for_status=Mock()))
        )
        lyrics = provider.fetch_lyrics("Daft Punk", "Get Lucky")
        assert lyrics.splitlines() == [
            "Like the legend of the phoenix",
            "All ends with beginnings",
        ]

    def test_a_page_without_the_container_yields_none_not_page_chrome(self, monkeypatch):
        """Genius's class names are content-hashed and change every deploy, so
        a layout change must fail closed rather than return navigation text."""
        provider = self._provider()
        provider.repository.search_songs.return_value = [{"url": "https://genius.com/x"}]
        monkeypatch.setattr(
            "app.providers.adapters.safe_get",
            Mock(return_value=Mock(text="<html><nav>Sign in</nav></html>",
                                   raise_for_status=Mock())),
        )
        assert provider.fetch_lyrics("A", "B") is None

    def test_genius_header_and_bio_are_excluded_but_annotated_lyrics_remain(self, monkeypatch):
        provider = self._provider()
        html = '''<div data-lyrics-container="true">
          <div data-exclude-from-selection="true"><button>6 Contributors</button>
          <h2>Song Lyrics</h2><a href="#about">Song description Read More</a></div>
          [Verse 1]<br/><a href="/annotation">First <b>line</b></a><br/>Second line
          </div><div data-lyrics-container="true"></div>
          <div data-lyrics-container="true">[Chorus]<br/>Last line</div>'''
        monkeypatch.setattr("app.providers.adapters.safe_get", Mock(return_value=Mock(text=html, raise_for_status=Mock())))
        assert provider._scrape_lyrics("https://genius.com/example") == (
            "[Verse 1]\nFirst line\nSecond line\n\n[Chorus]\nLast line"
        )


class TestSourceAdapter:
    def _provider(self, results):
        repository = Mock()

        async def search(query, *, limit, options=None):
            repository.last_query = (query, limit)
            return results

        repository.search = search
        repository.id = 'youtube'
        return SourceStreamingProvider(repository)

    def test_results_become_candidates_through_the_shared_matcher(self):
        """The mapping is `youtube_matching`'s, not the adapter's.

        Reimplementing it here would fork the title cleaning that keeps
        "Official Video" and "[4K]" out of the score, so the adapter only hands
        over a ``WantedTrack`` and lets that module do the work.
        """
        provider = self._provider([
            {"title": "Daft Punk - Get Lucky (Official Video)",
             "url": "https://youtube.com/watch?v=vid1", "id": "vid1",
             "duration": 369, "artist": "Daft Punk"},
        ])
        candidates = provider.search_wanted(
            WantedTrack(title="Get Lucky", artist="Daft Punk"), 5
        )
        assert len(candidates) == 1
        assert isinstance(candidates[0], Candidate)
        # "(Official Video)" is furniture and youtube_matching strips it.
        assert candidates[0].title == "Get Lucky"
        assert candidates[0].artist == "Daft Punk"
        assert candidates[0].duration_s == 369.0

    def test_a_free_text_query_is_split_the_way_upload_titles_are(self):
        """``search_candidates`` has only a string, so it reconstructs the
        structured fields with ``split_query`` — the same "Artist - Title"
        convention uploaders use — rather than comparing one long string."""
        provider = self._provider([
            {"title": "Daft Punk - Get Lucky", "url": "https://youtube.com/watch?v=v",
             "id": "v", "duration": 369, "artist": "Daft Punk"},
        ])
        candidate = provider.search_candidates("Daft Punk - Get Lucky", 5)[0]
        assert candidate.title == "Get Lucky"
        assert candidate.artist == "Daft Punk"

    def test_a_source_candidate_is_never_identifiable(self):
        """Load-bearing: it is why `match_track` can never return STRONG here,
        and therefore why `select_video` accepts REVIEW."""
        provider = self._provider([
            {"title": "Get Lucky", "url": "https://youtube.com/watch?v=v", "id": "v",
             "duration": 369},
        ])
        assert provider.search_candidates("Get Lucky", 5)[0].is_identifiable is False

    def test_a_blank_query_never_shells_out(self):
        provider = self._provider([])
        assert provider.search_candidates("  ", 5) == []

    def test_resolve_stream_builds_a_watch_url_from_a_video_id(self):
        provider = self._provider([])
        assert provider.resolve_stream("dQw4w9WgXcQ") == (
            "dQw4w9WgXcQ"
        )

    def test_resolve_stream_passes_a_url_through_untouched(self):
        """``source_candidate`` falls back to the URL when yt-dlp gave no id."""
        provider = self._provider([])
        url = "https://youtube.com/watch?v=abc"
        assert provider.resolve_stream(url) == url


class TestAsyncBridge:
    def test_it_works_from_plain_synchronous_code(self):
        async def answer():
            return 42

        assert _run_coroutine(answer()) == 42

    def test_it_works_from_inside_a_running_event_loop(self):
        """The failure this guards is invisible in tests and fatal in prod:
        ``asyncio.run`` raises if a loop is already running on this thread, so a
        request handler would blow up where every unit test passed."""

        async def answer():
            return 42

        async def caller():
            return _run_coroutine(answer())

        assert asyncio.run(caller()) == 42
