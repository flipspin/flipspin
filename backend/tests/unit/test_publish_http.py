"""Public HTTP identity and explicit consent for Genius page scraping."""
import json
import logging
from unittest.mock import Mock

import pytest

from app.config import APP_VERSION
from app.domains.lyrics.models import LyricsQuery
from app.domains.metadata.genius_service import GeniusService
from app.domains.metadata.repositories import GeniusRepository
from app.domains.transfers.repositories import TransferRepository
from app.providers.adapters import GeniusLyricsProvider, build_default_registry
from app.providers.registry import ProviderKind

UA = f"Flipspin/{APP_VERSION} ( https://github.com/flipspin/flipspin )"
LOGGER = logging.getLogger(__name__)
QUERY = LyricsQuery(artist="Fixture Artist", title="Fixture Song")


def mock_metadata_get(monkeypatch, get):
    # Fixed API requests still use requests; pages use the shared public fetcher.
    monkeypatch.setattr("requests.get", get)
    for target in ("app.domains.metadata.repositories.safe_get",
                   "app.domains.metadata.genius_service.safe_get",
                   "app.providers.adapters.safe_get"):
        monkeypatch.setattr(target, get)


def test_vlc_upload_identifies_krobi(config, tmp_path, monkeypatch):
    audio = tmp_path / "fixture.wav"
    audio.write_bytes(b"fixture")
    post = Mock(return_value=Mock())
    monkeypatch.setattr("requests.post", post)
    TransferRepository(config, LOGGER).send_to_vlc_http("localhost:8080", audio)
    assert post.call_args.kwargs["headers"]["User-Agent"] == UA


def test_genius_metadata_requests_identify_krobi(config, monkeypatch):
    get = Mock(return_value=Mock(text="<title>Fixture</title>", json=lambda: {"response": {"hits": []}}))
    mock_metadata_get(monkeypatch, get)
    config.genius_api_key = "fixture-key"
    repository = GeniusRepository(config, LOGGER)
    repository.search_songs("fixture")
    repository.get_song_info("https://genius.com/fixture")
    GeniusService(LOGGER)._fetch_page("https://genius.com/fixture")
    assert len(get.call_args_list) == 3
    assert all(call.kwargs["headers"]["User-Agent"] == UA for call in get.call_args_list)


@pytest.mark.parametrize("key,enabled", [(None, False), (None, True), ("fixture-key", False)])
def test_genius_cannot_search_or_scrape_without_both_opt_ins(config, monkeypatch, key, enabled):
    config.genius_api_key = key
    repository = Mock()
    get = Mock(side_effect=AssertionError("No page request is permitted"))
    mock_metadata_get(monkeypatch, get)
    provider = GeniusLyricsProvider(repository, config, scraping_enabled=lambda: enabled)
    assert provider.search_lyrics(QUERY) == []
    assert provider.fetch_lyrics(QUERY.artist, QUERY.title) is None
    assert provider._scrape_lyrics("https://genius.com/fixture") is None
    repository.search_songs.assert_not_called()
    get.assert_not_called()


def test_standalone_genius_provider_defaults_to_no_scraping(config):
    config.genius_api_key = "fixture-key"
    repo = Mock()
    assert GeniusLyricsProvider(repo, config).search_lyrics(QUERY) == []
    repo.search_songs.assert_not_called()


def test_genius_opt_in_persists_and_live_toggle_and_key_stop_requests(config, monkeypatch):
    config.genius_api_key = "fixture-key"
    get = Mock(side_effect=lambda url, **kwargs: Mock(
        text='<div data-lyrics-container="true">Invented words<br/>Another fixture line</div>',
        json=lambda: {"response": {"hits": [{"result": {
            "title": QUERY.title, "primary_artist": {"name": QUERY.artist},
            "url": "https://genius.com/fixture",
        }}]}},
    ))
    mock_metadata_get(monkeypatch, get)
    registry = build_default_registry(config)
    assert registry.order(ProviderKind.LYRICS)[0] == "lrclib"
    provider = registry.instance("genius")
    assert not registry.is_enabled("genius")
    assert provider.search_lyrics(QUERY) == []
    get.assert_not_called()
    registry.set_enabled("genius", True)
    registry = build_default_registry(config)
    provider = registry.instance("genius")
    assert registry.is_enabled("genius")
    assert provider.search_lyrics(QUERY)[0].plain_lyrics == "Invented words\nAnother fixture line"
    assert [call.kwargs["headers"]["User-Agent"] for call in get.call_args_list] == [UA, UA]
    assert "Authorization" not in get.call_args_list[1].kwargs["headers"]
    get.reset_mock()
    registry.set_enabled("genius", False)
    assert provider.search_lyrics(QUERY) == []
    registry.set_enabled("genius", True)
    config.genius_api_key = None
    assert provider.search_lyrics(QUERY) == []
    get.assert_not_called()


def test_legacy_implicit_enable_and_reorder_are_not_scraping_consent(config):
    config.genius_api_key = "fixture-key"
    config.providers_file.write_text(json.dumps({
        "lyrics": {"order": ["genius", "lrclib", "lyricsovh"], "disabled": []},
    }))
    registry = build_default_registry(config)
    assert not registry.is_enabled("genius")
    registry.set_order(ProviderKind.LYRICS, ["lrclib", "genius", "lyricsovh"])
    assert not build_default_registry(config).is_enabled("genius")
