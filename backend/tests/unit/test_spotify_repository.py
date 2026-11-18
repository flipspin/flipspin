"""Unit tests for SpotifyRepository.search_tracks.

Track search uses the Client Credentials flow (no user login) and shapes each
result for the download adapter — notably it carries ``album_images`` so a
picked song keeps its cover art through the download path. These pin the mapping
and the request shape (``type=track``, clamped ``limit``).
"""
from unittest.mock import Mock, patch

from app.config import ConfigManager
from app.domains.metadata.spotify_repository import SpotifyRepository


def _repo():
    """Stub token retrieval while exercising real search mapping."""
    repo = SpotifyRepository(config=Mock(spec=ConfigManager), logger=Mock())
    repo._get_access_token = Mock(return_value="tok")
    return repo


def _resp(payload):
    resp = Mock()
    resp.raise_for_status = Mock()
    resp.json = Mock(return_value=payload)
    return resp


SEARCH_PAYLOAD = {
    "tracks": {
        "items": [
            {
                "id": "abc",
                "name": "Tití Me Preguntó",
                "artists": [{"name": "Bad Bunny"}],
                "album": {
                    "name": "Un Verano Sin Ti",
                    "images": [
                        {"url": "https://img/640", "width": 640},
                        {"url": "https://img/64", "width": 64},
                    ],
                },
                "track_number": 5,
                "duration_ms": 243000,
                "external_urls": {"spotify": "https://open.spotify.com/track/abc"},
            },
            {"name": "no id — skipped"},  # filtered out: no Spotify id
        ]
    }
}


class TestSearchTracks:
    def test_maps_results_to_adapter_shape(self):
        repo = _repo()
        with patch(
            "app.domains.metadata.spotify_repository.requests.get",
            return_value=_resp(SEARCH_PAYLOAD),
        ) as mock_get:
            results = repo.search_tracks("titi me pregunto")

        # The id-less item is dropped.
        assert len(results) == 1
        track = results[0]
        assert track["id"] == "abc"
        assert track["name"] == "Tití Me Preguntó"
        assert track["artist"] == "Bad Bunny"
        assert track["album"] == "Un Verano Sin Ti"
        assert track["track_number"] == 5
        assert track["duration_ms"] == 243000
        assert track["spotify_url"] == "https://open.spotify.com/track/abc"
        # album_images is passed through verbatim for cover embedding downstream.
        assert track["album_images"][0]["url"] == "https://img/640"
        # Searches the track endpoint, not albums.
        assert mock_get.call_args.kwargs["params"]["type"] == "track"

    def test_joins_multiple_artists(self):
        repo = _repo()
        payload = {"tracks": {"items": [{
            "id": "x", "name": "Song",
            "artists": [{"name": "A"}, {"name": "B"}],
            "album": {"name": "Al", "images": []},
        }]}}
        with patch(
            "app.domains.metadata.spotify_repository.requests.get",
            return_value=_resp(payload),
        ):
            results = repo.search_tracks("q")
        assert results[0]["artist"] == "A, B"

    def test_limit_is_clamped_to_dev_mode_max(self):
        # Spotify dev-mode search caps `limit` at 10; 11+ would 400 "Invalid limit".
        repo = _repo()
        with patch(
            "app.domains.metadata.spotify_repository.requests.get",
            return_value=_resp({"tracks": {"items": []}}),
        ) as mock_get:
            repo.search_tracks("q", limit=999)
        assert mock_get.call_args.kwargs["params"]["limit"] == 10
