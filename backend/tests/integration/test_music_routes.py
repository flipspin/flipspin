"""Integration tests for music routes."""
import pytest
from fastapi.testclient import TestClient
from pathlib import Path
from unittest.mock import Mock
from app.main import app
from app.dependencies import get_music_service
from app.domains.music.models import Album, Track
from app.domains.music.analysis_repository import AnalysisRepository
from app.infra.changes import Changes


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_music_service(tmp_path):
    """Override the FastAPI MusicService dependency with a mock.

    The routes resolve the service via `Depends(get_music_service)`, so the mock
    must be injected through `app.dependency_overrides` — patching the imported
    name has no effect on an already-wired dependency.
    """
    service = Mock()
    service.music_repo.config = service.config
    service.music_repo.analysis = AnalysisRepository(tmp_path / 'analysis.sqlite')
    service.music_repo._tag_cache = {}
    service.music_repo.tag_revision = 0
    service.music_repo.changes = Changes({
        'library': lambda: service.music_repo.tag_revision,
        'analysis': lambda: service.music_repo.analysis.revision,
    })
    service.music_repo._owner_ghosts = None
    app.dependency_overrides[get_music_service] = lambda: service
    try:
        yield service
    finally:
        app.dependency_overrides.pop(get_music_service, None)


def test_list_album_names_empty(client, mock_music_service):
    """Test listing albums when none exist."""
    mock_music_service.list_albums.return_value = []
    
    response = client.get("/api/listar-albums")
    
    assert response.status_code == 200
    assert response.json() == {"albums": []}


def test_list_album_names_with_data(client, mock_music_service):
    """Test listing albums with data."""
    mock_album = Album(
        name="Test Album",
        artist="Test Artist",
        path=Path("/music/Test Album"),
        tracks=[],
        cover_art=None,
        year=2024,
        genre="Rock",
        total_duration=0
    )
    mock_music_service.list_albums.return_value = [mock_album]
    
    response = client.get("/api/listar-albums")
    
    assert response.status_code == 200
    data = response.json()
    assert "albums" in data
    assert len(data["albums"]) == 1
    assert data["albums"][0] == "Test Album"


def test_list_albums_with_metadata(client, mock_music_service):
    """Test listing albums with metadata - verify response format compatibility."""
    mock_track = Track(
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        path=Path("/music/Test Album/test.mp3"),
        track_number=1,
        duration=180.0,
        file_size=3000000,
        date_added=1234567890,
        genre="Rock"
    )
    mock_album = Album(
        name="Test Album",
        artist="Test Artist",
        path=Path("/music/Test Album"),
        tracks=[mock_track],
        cover_art=None,
        year=2024,
        genre="Rock",
        total_duration=180.0
    )
    mock_music_service.list_albums.return_value = [mock_album]
    
    response = client.get("/api/listar-albums-con-metadata")
    
    assert response.status_code == 200
    data = response.json()
    
    # Verify flat array format (not wrapped in object)
    assert isinstance(data, list), "Response should be a flat array"
    assert len(data) == 1
    
    album_data = data[0]
    
    # Verify all required metadata fields are present
    assert "album" in album_data, "Missing 'album' field"
    assert "artist" in album_data, "Missing 'artist' field"
    assert "cover" in album_data, "Missing 'cover' field"
    assert "duration" in album_data, "Missing 'duration' field"
    assert "tracks" in album_data, "Missing 'tracks' field"
    
    # Verify field values
    assert album_data["album"] == "Test Album"
    assert album_data["artist"] == "Test Artist"
    assert album_data["duration"] == 180.0
    assert album_data["cover"] is None  # No cover art in this test
    
    # Verify tracks array
    assert isinstance(album_data["tracks"], list)
    assert len(album_data["tracks"]) == 1
    
    track_data = album_data["tracks"][0]
    
    # Verify track has required fields
    assert "title" in track_data
    assert "artist" in track_data
    assert "duration" in track_data
    assert "url_path" in track_data
    assert "genre" in track_data
    assert "dateAdded" in track_data
    
    # Verify url_path format
    assert track_data["url_path"].startswith("/api/media/"), "url_path should start with /api/media/"
    assert "Test Album" in track_data["url_path"]
    assert "test.mp3" in track_data["url_path"]


def test_serve_audio_not_found(client, mock_music_service, tmp_path):
    """A missing file is a 404 — and the route never asks the service for tags."""
    mock_music_service.config.base_music_dir = tmp_path
    (tmp_path / "Album").mkdir()

    response = client.get("/api/media/Album/nonexistent.mp3")

    assert response.status_code == 404
    mock_music_service.get_track.assert_not_called()


def test_serve_audio_streams_with_cache_headers_and_answers_304(client, mock_music_service, tmp_path):
    """The media route is path validation plus a FileResponse: no tag parsing per
    Range request, a cache lifetime, and a 304 when the client's ETag matches."""
    mock_music_service.config.base_music_dir = tmp_path
    album = tmp_path / "Album"
    album.mkdir()
    (album / "song.mp3").write_bytes(b"\xff\xfb" + b"\x00" * 4094)

    response = client.get("/api/media/Album/song.mp3")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/mpeg")
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["cache-control"] == "private, max-age=3600"
    etag = response.headers["etag"]
    assert etag
    mock_music_service.get_track.assert_not_called()

    partial = client.get("/api/media/Album/song.mp3", headers={"Range": "bytes=0-9"})
    assert partial.status_code == 206
    assert len(partial.content) == 10

    revalidated = client.get("/api/media/Album/song.mp3", headers={"If-None-Match": etag})
    assert revalidated.status_code == 304
    assert revalidated.content == b""
    assert revalidated.headers["etag"] == etag

    weak = client.get("/api/media/Album/song.mp3", headers={"If-None-Match": f"W/{etag}"})
    assert weak.status_code == 304


def test_serve_cover_is_cacheable(client, mock_music_service, tmp_path):
    """Covers are public and long-lived; the lookup goes through the repository's memo."""
    mock_music_service.config.base_music_dir = tmp_path
    album = tmp_path / "Album"
    album.mkdir()
    cover = album / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xe0")
    mock_music_service.music_repo._find_cover_art.return_value = cover

    response = client.get("/api/media/Album/cover.jpg")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=86400"
    etag = response.headers["etag"]

    again = client.get("/api/media/Album/cover.jpg", headers={"If-None-Match": etag})
    assert again.status_code == 304


def test_get_waveform_invalid_samples(client, mock_music_service):
    """Test getting waveform with invalid sample count."""
    response = client.get("/api/waveform/Album/track.mp3?samples=50")
    
    # Should fail validation (minimum is 100)
    assert response.status_code == 422



def test_list_albums_with_metadata_and_cover(client, mock_music_service, tmp_path):
    """Test albums endpoint with base64-encoded cover art."""
    cover_path = tmp_path / "cover.jpg"
    cover_path.write_bytes(b'\xff\xd8\xff\xe0')  # Minimal JPEG header
    
    mock_track = Track(
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        path=Path("/music/Test Album/test.mp3"),
        track_number=1,
        duration=180.0,
        file_size=3000000,
        date_added=1234567890,
        genre="Rock"
    )
    mock_album = Album(
        name="Test Album",
        artist="Test Artist",
        path=Path("/music/Test Album"),
        tracks=[mock_track],
        cover_art=str(cover_path),
        year=2024,
        genre="Rock",
        total_duration=180.0
    )
    mock_music_service.list_albums.return_value = [mock_album]
    
    response = client.get("/api/listar-albums-con-metadata")
    
    assert response.status_code == 200
    data = response.json()
    
    album_data = data[0]
    
    # Verify cover art is base64-encoded with data URI scheme
    assert album_data["cover"] is not None, "Cover should not be None when cover_art exists"
    assert album_data["cover"].startswith("data:image/"), "Cover should be a data URI"
    assert ";base64," in album_data["cover"], "Cover should contain base64 encoding"
    
    # Verify it's a valid base64 string after the prefix
    import base64
    try:
        base64_part = album_data["cover"].split(";base64,")[1]
        decoded = base64.b64decode(base64_part)
        assert len(decoded) > 0, "Decoded cover should have content"
    except Exception as e:
        pytest.fail(f"Cover art is not valid base64: {e}")



def test_track_data_structure_in_albums(client, mock_music_service):
    """Test track data structure in albums endpoint - verify all required fields."""
    mock_track = Track(
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        path=Path("/music/Test Album/test.mp3"),
        track_number=1,
        duration=180.5,
        file_size=3000000,
        date_added=1234567890.5,
        genre="Rock"
    )
    mock_album = Album(
        name="Test Album",
        artist="Test Artist",
        path=Path("/music/Test Album"),
        tracks=[mock_track],
        cover_art=None,
        year=2024,
        genre="Rock",
        total_duration=180.5
    )
    mock_music_service.list_albums.return_value = [mock_album]
    
    response = client.get("/api/listar-albums-con-metadata")
    
    assert response.status_code == 200
    data = response.json()
    
    track_data = data[0]["tracks"][0]
    
    # Verify url_path field is correct format
    assert "url_path" in track_data, "Track missing 'url_path' field"
    assert track_data["url_path"] == "/api/media/Test Album/test.mp3", \
        f"url_path should be '/api/media/Test Album/test.mp3', got '{track_data['url_path']}'"
    
    # Verify genre field
    assert "genre" in track_data, "Track missing 'genre' field"
    assert track_data["genre"] == "Rock"
    
    # Verify dateAdded field (camelCase)
    assert "dateAdded" in track_data, "Track missing 'dateAdded' field (camelCase)"
    assert track_data["dateAdded"] == 1234567890.5
    
    # Verify duration field
    assert "duration" in track_data, "Track missing 'duration' field"
    assert track_data["duration"] == 180.5
    
    # Verify other essential fields
    assert track_data["title"] == "Test Song"
    assert track_data["artist"] == "Test Artist"
    assert track_data["track_number"] == 1


def test_track_url_path_format_variations(client, mock_music_service):
    """Test url_path format with various album and filename combinations."""
    test_cases = [
        ("Simple Album", "song.mp3", "/api/media/Simple Album/song.mp3"),
        ("Album With Spaces", "track name.mp3", "/api/media/Album With Spaces/track name.mp3"),
        ("Artist - Album", "01 - Song.mp3", "/api/media/Artist - Album/01 - Song.mp3"),
    ]
    
    for album_name, filename, expected_url_path in test_cases:
        mock_track = Track(
            title="Test",
            artist="Test",
            album=album_name,
            path=Path(f"/music/{album_name}/{filename}"),
            track_number=1,
            duration=180.0,
            file_size=3000000,
            date_added=1234567890,
            genre="Rock"
        )
        mock_album = Album(
            name=album_name,
            artist="Test",
            path=Path(f"/music/{album_name}"),
            tracks=[mock_track],
            cover_art=None,
            year=2024,
            genre="Rock",
            total_duration=180.0
        )
        mock_music_service.list_albums.return_value = [mock_album]
        mock_music_service.music_repo.tag_revision += 1
        
        response = client.get("/api/listar-albums-con-metadata")
        
        assert response.status_code == 200
        data = response.json()
        track_data = data[0]["tracks"][0]
        
        assert track_data["url_path"] == expected_url_path, \
            f"Expected url_path '{expected_url_path}', got '{track_data['url_path']}'"


class TestCoversFlag:
    """`covers=false` is the difference between a 30 MB response and a 4 KB one.

    The inlined base64 covers are ~30 MB of the 32 MB this endpoint returns on
    a 178-album library. On a LAN that is a 1-second request; over a phone
    tunnel it is a long enough window that an ordinary tab switch cancels the
    load, which is how it was found. These pin that the flag actually removes
    the payload and changes nothing else, and that the default is unchanged —
    the Electron renderer still reads the inlined field.
    """

    def _album(self, tmp_path, mock_music_service):
        cover = tmp_path / "cover.jpg"
        cover.write_bytes(b"\xff\xd8\xff" + b"padding" * 500)
        album = Album(
            name="Test Album",
            artist="Test Artist",
            path=tmp_path,
            tracks=[],
            cover_art=str(cover),
            year=2024,
            genre="Rock",
            total_duration=180.0,
        )
        mock_music_service.list_albums.return_value = [album]
        return album

    def test_default_still_inlines_the_cover(self, client, mock_music_service, tmp_path):
        self._album(tmp_path, mock_music_service)
        data = client.get("/api/listar-albums-con-metadata").json()
        assert data[0]["cover"].startswith("data:image/jpeg;base64,")

    def test_covers_false_omits_it(self, client, mock_music_service, tmp_path):
        self._album(tmp_path, mock_music_service)
        data = client.get("/api/listar-albums-con-metadata?covers=false").json()
        assert data[0]["cover"] is None

    def test_covers_false_changes_nothing_else(self, client, mock_music_service, tmp_path):
        self._album(tmp_path, mock_music_service)
        con = client.get("/api/listar-albums-con-metadata").json()[0]
        sin = client.get("/api/listar-albums-con-metadata?covers=false").json()[0]
        del con["cover"], sin["cover"]
        assert con == sin

    def test_covers_false_is_dramatically_smaller(self, client, mock_music_service, tmp_path):
        self._album(tmp_path, mock_music_service)
        con = len(client.get("/api/listar-albums-con-metadata").content)
        sin = len(client.get("/api/listar-albums-con-metadata?covers=false").content)
        # The whole point. A cover that does not shrink the response means the
        # flag is wired to nothing.
        assert sin < con / 2
