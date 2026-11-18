"""Integration tests for the Spotify track-search download routes.

Covers POST /api/search-spotify-tracks (success + the missing-credentials 400 the
UI surfaces) and POST /api/download-spotify-playlist, which now starts the download
in the background and returns a progress_id immediately (so the SSE feed can show
live progress) while still forwarding ``album_images`` to the download service.
"""
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.domains.acquisition.sources.routes import require_source
from app.dependencies import (
    get_download_service,
    get_playlist_service,
    get_progress_tracker,
)
from app.infra.progress import ProgressTracker
from app.exceptions import DownloadError


@pytest.fixture
def client_and_service(monkeypatch):
    from app.infra import urls
    monkeypatch.setattr(urls, "_source_hosts", lambda: {"youtube.com", "www.youtube.com", "youtu.be"})
    app.dependency_overrides[require_source] = lambda: None
    """Inject a mock DownloadService through the real dependency boundary."""
    service = Mock()
    app.dependency_overrides[get_download_service] = lambda: service
    try:
        yield TestClient(app), service
    finally:
        app.dependency_overrides.pop(get_download_service, None)
        app.dependency_overrides.pop(require_source, None)


def test_search_spotify_tracks_returns_results(client_and_service):
    client, service = client_and_service
    service.search_spotify_tracks = Mock(return_value=[
        {
            "id": "abc", "name": "Song", "artist": "Artist", "album": "Album",
            "track_number": 1, "album_images": [{"url": "https://img"}],
            "spotify_url": "https://open.spotify.com/track/abc",
        },
    ])

    resp = client.post("/api/search-spotify-tracks", json={"query": "song"})

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["results"]) == 1
    assert body["results"][0]["album_images"][0]["url"] == "https://img"
    service.search_spotify_tracks.assert_called_once_with("song", 10)


def test_search_spotify_tracks_missing_credentials_returns_400(client_and_service):
    client, service = client_and_service
    service.search_spotify_tracks = Mock(
        side_effect=DownloadError("Spotify credentials not configured")
    )

    resp = client.post("/api/search-spotify-tracks", json={"query": "song"})

    assert resp.status_code == 400
    assert "credentials" in resp.json()["detail"].lower()


def test_download_spotify_playlist_returns_progress_id_without_blocking(client_and_service):
    """The endpoint registers progress + returns a ticket immediately (no full await)."""
    client, service = client_and_service
    service.config = Mock()
    service.config.base_music_dir = Path("/tmp/music")
    # If the endpoint awaited this, the request would hang; it must NOT await it.
    service.download_spotify_playlist = AsyncMock(return_value=[])

    tracker = ProgressTracker()
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    try:
        payload = {"tracks": [{
            "title": "Song", "artist": "Artist", "album": "Album",
            "track_number": 1, "album_images": [{"url": "https://img/640"}],
        }]}
        resp = client.post("/api/download-spotify-playlist", json=payload)
    finally:
        app.dependency_overrides.pop(get_progress_tracker, None)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "started"
    assert body["total"] == 1
    progress_id = body["progress_id"]
    # The progress entry exists synchronously, so an immediate SSE connect won't 404.
    assert tracker.get_progress(progress_id) is not None


@pytest.mark.asyncio
async def test_download_spotify_playlist_backgrounds_and_forwards_album_images():
    """The backgrounded download receives the forwarded tracks + the same progress_id."""
    service = Mock()
    service.config = Mock()
    service.config.base_music_dir = Path("/tmp/music")
    service.download_spotify_playlist = AsyncMock(return_value=[])
    tracker = ProgressTracker()

    app.dependency_overrides[get_download_service] = lambda: service
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    try:
        payload = {"tracks": [{
            "title": "Song", "artist": "Artist", "album": "Album",
            "track_number": 1, "album_images": [{"url": "https://img/640"}],
        }]}
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as ac:
            resp = await ac.post("/api/download-spotify-playlist", json=payload)
        assert resp.status_code == 200
        progress_id = resp.json()["progress_id"]

        # Let the background task run and forward to the service.
        for _ in range(100):
            if service.download_spotify_playlist.call_args is not None:
                break
            await asyncio.sleep(0.01)
    finally:
        app.dependency_overrides.pop(get_download_service, None)
        app.dependency_overrides.pop(require_source, None)
        app.dependency_overrides.pop(get_progress_tracker, None)

    kwargs = service.download_spotify_playlist.call_args.kwargs
    assert kwargs["tracks"][0]["name"] == "Song"
    assert kwargs["tracks"][0]["album_images"] == [{"url": "https://img/640"}]
    assert kwargs["progress_id"] == progress_id


def test_import_playlist_url_returns_progress_id_without_blocking(client_and_service):
    """Playlist mode now backgrounds like single-track: a ticket back immediately."""
    client, service = client_and_service
    service.config = Mock()
    service.config.base_music_dir = Path("/tmp/music")
    # Must NOT be awaited inline; the route hands back a progress_id and runs it later.
    service.import_playlist_from_url = AsyncMock(return_value=("My Playlist", []))

    tracker = ProgressTracker()
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    app.dependency_overrides[get_playlist_service] = lambda: Mock()
    try:
        resp = client.post(
            "/api/import-playlist-url",
            json={"playlist_url": "https://open.spotify.com/playlist/xyz"},
        )
    finally:
        app.dependency_overrides.pop(get_progress_tracker, None)
        app.dependency_overrides.pop(get_playlist_service, None)

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"
    assert body["progress_id"]
    # Registered synchronously (at total=0) so an immediate SSE connect won't 404.
    state = tracker.get_progress(body["progress_id"])
    assert state is not None
    assert state.total == 0


@pytest.mark.asyncio
async def test_import_playlist_url_backgrounds_and_forwards_progress_id():
    """The backgrounded import receives the same progress_id + the selected indices."""
    service = Mock()
    service.config = Mock()
    service.config.base_music_dir = Path("/tmp/music")
    service.import_playlist_from_url = AsyncMock(return_value=("My Playlist", []))
    tracker = ProgressTracker()

    app.dependency_overrides[get_download_service] = lambda: service
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    app.dependency_overrides[get_playlist_service] = lambda: Mock()
    try:
        payload = {
            "playlist_url": "https://open.spotify.com/playlist/xyz",
            "selected_indices": [0, 2, 5],
        }
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as ac:
            resp = await ac.post("/api/import-playlist-url", json=payload)
        assert resp.status_code == 200
        progress_id = resp.json()["progress_id"]

        for _ in range(100):
            if service.import_playlist_from_url.call_args is not None:
                break
            await asyncio.sleep(0.01)
    finally:
        app.dependency_overrides.pop(get_download_service, None)
        app.dependency_overrides.pop(require_source, None)
        app.dependency_overrides.pop(get_progress_tracker, None)
        app.dependency_overrides.pop(get_playlist_service, None)

    kwargs = service.import_playlist_from_url.call_args.kwargs
    assert kwargs["progress_id"] == progress_id
    assert kwargs["selected_indices"] == [0, 2, 5]


# ─── Person-driven retry of a failed song ────────────────────────────────────


def test_youtube_search_returns_raw_results(client_and_service):
    client, service = client_and_service
    service.engine.download_repo.search_source = AsyncMock(return_value=[
        {"id": "WjNssEVlB6M", "url": "https://www.youtube.com/watch?v=WjNssEVlB6M",
         "title": "Jamie xx - Gosh (Official Music Video)", "duration": 293, "artist": "Jamie xx"},
        {"id": None, "url": None, "title": "no url", "duration": None, "artist": None},
    ])

    resp = client.post("/api/downloads/youtube-search", json={"query": "  Gosh JAMIE XX "})

    assert resp.status_code == 200
    body = resp.json()
    assert body["query"] == "Gosh JAMIE XX"
    assert [r["id"] for r in body["results"]] == ["WjNssEVlB6M"]
    service.engine.download_repo.search_source.assert_awaited_once_with("Gosh JAMIE XX", max_results=10)


def test_retry_refuses_a_url_that_is_not_youtube(client_and_service):
    client, _ = client_and_service
    resp = client.post("/api/downloads/retry", json={
        "progress_id": "job", "index": 0, "youtube_url": "https://evil.example/watch?v=x",
    })
    assert resp.status_code == 422


def test_retry_of_a_forgotten_job_is_404(client_and_service):
    client, service = client_and_service
    service.engine.retry_request = Mock(return_value=None)
    resp = client.post("/api/downloads/retry", json={
        "progress_id": "job", "index": 0, "youtube_url": "https://youtu.be/WjNssEVlB6M",
    })
    assert resp.status_code == 404


def test_retry_starts_a_new_job_and_marks_the_old_failure(client_and_service):
    client, service = client_and_service
    request = Mock()
    request.metadata.title = "Gosh"
    service.engine.retry_request = Mock(return_value=request)
    service.engine.download_multiple_tracks = AsyncMock(return_value=[])
    service.config = Mock()
    service.config.base_music_dir = Path("/tmp/music")

    tracker = ProgressTracker()
    tracker.create_progress("job", 1)
    tracker.add_failure("job", {"index": 0, "retriedAs": None})
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    try:
        resp = client.post("/api/downloads/retry", json={
            "progress_id": "job", "index": 0, "youtube_url": "https://www.youtube.com/watch?v=WjNssEVlB6M",
        })
    finally:
        app.dependency_overrides.pop(get_progress_tracker, None)

    assert resp.status_code == 200
    body = resp.json()
    assert body["label"] == "Gosh"
    assert body["total"] == 1
    assert tracker.get_progress(body["progress_id"]) is not None
    assert tracker.get_progress("job").failures[0]["retriedAs"] == body["progress_id"]
    service.engine.retry_request.assert_called_once_with(
        "job", 0, "https://www.youtube.com/watch?v=WjNssEVlB6M"
    )


@pytest.mark.parametrize('legacy', [False, True])
def test_album_cover_resolution_supports_sidecar_and_legacy_layout(tmp_path, legacy):
    from app.domains.downloads.routes import _resolve_album_cover_path

    album = tmp_path / 'Album'
    album.mkdir()
    cover = album / 'cover' / 'cover.jpg' if legacy else album / 'cover.jpg'
    cover.parent.mkdir(exist_ok=True)
    cover.write_bytes(b'artwork')
    assert _resolve_album_cover_path(album / 'song.mp3') == str(cover)
