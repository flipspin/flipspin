"""Integration tests for playlist routes."""
import pytest
import logging
import wave
from pathlib import Path
from fastapi.testclient import TestClient
from unittest.mock import Mock
from mutagen.id3 import TCON, TPE1
from mutagen.wave import WAVE
from app.main import app
from app.dependencies import get_playlist_service
from app.domains.music.repositories import MusicRepository
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.domains.playlists.repositories import PlaylistRepository


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_playlist_service(config):
    """Override the FastAPI PlaylistService dependency with a mock.

    The routes resolve the service via `Depends(get_playlist_service)`, so the
    mock must be injected through `app.dependency_overrides` — patching the
    imported name has no effect on an already-wired dependency.
    """
    service = Mock()
    service.music_repo = MusicRepository(config, logging.getLogger(__name__))
    app.dependency_overrides[get_playlist_service] = lambda: service
    try:
        yield service
    finally:
        app.dependency_overrides.pop(get_playlist_service, None)


def test_list_playlists_empty(client, mock_playlist_service):
    """Test listing playlists when none exist."""
    mock_playlist_service.list_playlists.return_value = []
    
    response = client.get("/api/playlists")
    
    assert response.status_code == 200
    assert response.json() == []


def test_list_playlists_with_data(client, mock_playlist_service):
    """Test listing playlists with data - verify response format compatibility."""
    mock_playlist = Playlist(
        name="Test Playlist",
        tracks=[],
        created_at=1234567890,
        modified_at=1234567890
    )
    mock_playlist_service.list_playlists.return_value = [mock_playlist]
    
    response = client.get("/api/playlists")
    
    assert response.status_code == 200
    data = response.json()
    
    # Verify flat array format (not wrapped in object)
    assert isinstance(data, list), "Response should be a flat array"
    assert len(data) == 1
    
    playlist_data = data[0]
    
    # Verify required fields are present
    assert "name" in playlist_data, "Missing 'name' field"
    assert "trackCount" in playlist_data, "Missing 'trackCount' field (camelCase)"
    assert "created" in playlist_data, "Missing 'created' field"
    assert "modified" in playlist_data, "Missing 'modified' field"
    
    # Verify field values
    assert playlist_data["name"] == "Test Playlist"
    assert playlist_data["trackCount"] == 0  # Empty playlist
    assert playlist_data["created"] == 1234567890
    assert playlist_data["modified"] == 1234567890
    assert playlist_data["coverAlbums"] == playlist_data["coverVersions"] == []


def test_playlist_cover_versions_follow_album_keys_and_cover_changes(
    client, mock_playlist_service, tmp_path, monkeypatch,
):
    from app.domains.music.covers import cover_version

    monkeypatch.setattr(app.state.config, "base_music_dir", tmp_path)
    nested = tmp_path / "mindthegap" / "The Low End Theory"
    nested.mkdir(parents=True)
    other = tmp_path / "Other"
    other.mkdir()
    (other / "cover.jpg").write_bytes(b"other cover")
    playlist = Playlist(name="Imported", tracks=[
        PlaylistTrack(path=nested / "CD1" / "01.mp3", title="First"),
        PlaylistTrack(path=nested / "02.mp3", title="Duplicate album"),
        PlaylistTrack(path=other / "01.mp3", title="Other"),
    ])
    mock_playlist_service.list_playlists.return_value = [playlist]

    def summary():
        response = client.get("/api/playlists")
        assert response.status_code == 200
        return response.json()[0]

    first = summary()
    assert first["cover"] is None
    assert first["coverAlbums"] == ["mindthegap∕The Low End Theory", "Other"]
    assert first["coverVersions"] == [None, cover_version(other / "cover.jpg")]
    cover = nested / "cover.jpg"
    cover.write_bytes(b"new cover")
    appeared = summary()["coverVersions"][0]
    assert appeared == cover_version(cover)
    assert appeared is not None
    cover.write_bytes(b"replacement cover, different size")
    assert summary()["coverVersions"][0] != appeared

    # Import completion relocates the album; the summary must use the new key.
    flat = tmp_path / nested.name
    nested.rename(flat)
    playlist.tracks = [PlaylistTrack(path=flat / "01.mp3", title="First")]
    assert summary()["coverAlbums"] == ["The Low End Theory"]
    assert summary()["coverVersions"] == [cover_version(flat / "cover.jpg")]
    (flat / "cover.jpg").unlink()
    assert summary()["coverVersions"] == [None]


@pytest.mark.parametrize("size", [96, 300])
def test_playlist_cover_version_matches_the_served_artwork(
    client, mock_playlist_service, tmp_path, monkeypatch, size,
):
    from app.domains.music.covers import cover_version

    monkeypatch.setattr(app.state.config, "base_music_dir", tmp_path)
    artwork = tmp_path / "Album" / "cover" / "art.png"
    artwork.parent.mkdir(parents=True)
    # A real image in a cover subdirectory, rather than a root cover.jpg.
    fixture = Path(__file__).parents[1] / "fixtures" / "covers" / "small.jpg"
    artwork.write_bytes(fixture.read_bytes())
    mock_playlist_service.list_playlists.return_value = [Playlist(
        name="Imported", tracks=[PlaylistTrack(path=tmp_path / "Album" / "01.mp3", title="First")],
    )]
    summary = client.get("/api/playlists").json()[0]
    version = summary["coverVersions"][0]
    assert version == cover_version(artwork)
    assert version is not None
    response = client.get("/api/media/Album/cover.jpg", params={"size": size, "v": version})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert "immutable" in response.headers["cache-control"]


def test_create_playlist_success(client, mock_playlist_service):
    """Test creating a playlist."""
    mock_playlist = Playlist(
        name="New Playlist",
        tracks=[],
        created_at=1234567890,
        modified_at=1234567890
    )
    mock_playlist_service.create_playlist.return_value = mock_playlist
    
    response = client.post(
        "/api/playlists",
        json={"name": "New Playlist", "tracks": []}
    )

    assert response.status_code == 200
    data = response.json()
    # Route returns a nested {success, playlist} envelope.
    assert data["success"] is True
    assert data["playlist"]["name"] == "New Playlist"


def test_create_playlist_invalid_data(client, mock_playlist_service):
    """Test creating playlist with invalid data."""
    from app.exceptions import ValidationError

    # An empty name passes schema validation (name: str), so the service raises
    # ValidationError, which the route maps to 400 Bad Request.
    mock_playlist_service.create_playlist.side_effect = ValidationError(
        "Playlist name cannot be empty"
    )

    response = client.post(
        "/api/playlists",
        json={"name": ""}  # Empty name
    )

    assert response.status_code == 400


def test_get_playlist_not_found(client, mock_playlist_service):
    """Test getting non-existent playlist."""
    from app.exceptions import PlaylistError
    mock_playlist_service.get_playlist.side_effect = PlaylistError("Playlist not found")
    
    response = client.get("/api/playlists/NonExistent")
    
    assert response.status_code == 404


def test_delete_playlist_success(client, mock_playlist_service):
    """Test deleting a playlist."""
    mock_playlist_service.delete_playlist.return_value = None
    
    response = client.delete("/api/playlists/Test%20Playlist")

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["message"] == "Playlist 'Test Playlist' deleted"


def test_delete_playlist_not_found(client, mock_playlist_service):
    """Test deleting non-existent playlist."""
    from app.exceptions import PlaylistError
    mock_playlist_service.delete_playlist.side_effect = PlaylistError("Playlist not found")

    response = client.delete("/api/playlists/NonExistent")

    assert response.status_code == 404


def test_rename_playlist_success(client, mock_playlist_service):
    """Renaming returns the nested {success, playlist} envelope with the new name."""
    mock_playlist_service.rename_playlist.return_value = Playlist(
        name="Renamed",
        tracks=[],
        created_at=1234567890,
        modified_at=1234567899,
    )

    response = client.patch(
        "/api/playlists/Old%20Name",
        json={"new_name": "Renamed"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["playlist"]["name"] == "Renamed"
    mock_playlist_service.rename_playlist.assert_called_once_with("Old Name", "Renamed")


def test_rename_playlist_empty_name(client, mock_playlist_service):
    """An empty new name is a ValidationError -> 400."""
    from app.exceptions import ValidationError
    mock_playlist_service.rename_playlist.side_effect = ValidationError(
        "Playlist name cannot be empty"
    )

    response = client.patch("/api/playlists/Old%20Name", json={"new_name": ""})

    assert response.status_code == 400


def test_rename_playlist_conflict(client, mock_playlist_service):
    """Renaming onto an existing name is a collision -> 409."""
    from app.exceptions import PlaylistError
    mock_playlist_service.rename_playlist.side_effect = PlaylistError(
        "Playlist already exists: Taken"
    )

    response = client.patch("/api/playlists/Old%20Name", json={"new_name": "Taken"})

    assert response.status_code == 409


def test_rename_playlist_not_found(client, mock_playlist_service):
    """Renaming a missing playlist -> 404."""
    from app.exceptions import PlaylistError
    mock_playlist_service.rename_playlist.side_effect = PlaylistError(
        "Playlist not found: Ghost"
    )

    response = client.patch("/api/playlists/Ghost", json={"new_name": "Whatever"})

    assert response.status_code == 404


def test_get_playlist_detail_format(client, mock_playlist_service):
    """Test getting playlist detail - verify response format compatibility."""
    from pathlib import Path
    from app.domains.playlists.models import PlaylistTrack
    
    mock_track = PlaylistTrack(
        path=Path("/music/Test Album/test.mp3"),
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        track_number=1,
        duration=180.0,
        date_added=1234567890
    )
    mock_playlist = Playlist(
        name="Test Playlist",
        tracks=[mock_track],
        created_at=1234567890,
        modified_at=1234567890,
        description="Test description"
    )
    mock_playlist_service.get_playlist.return_value = mock_playlist
    
    response = client.get("/api/playlists/Test%20Playlist")
    
    assert response.status_code == 200
    data = response.json()
    
    # Verify flat object format (not wrapped)
    assert isinstance(data, dict), "Response should be a flat object"
    
    # Verify required fields
    assert "name" in data, "Missing 'name' field"
    assert "tracks" in data, "Missing 'tracks' field"
    assert "created" in data, "Missing 'created' field"
    assert "modified" in data, "Missing 'modified' field"
    assert "description" in data, "Missing 'description' field"
    
    # Verify field values
    assert data["name"] == "Test Playlist"
    assert data["description"] == "Test description"
    assert isinstance(data["tracks"], list)
    assert len(data["tracks"]) == 1
    
    # Verify track enrichment (duration, dateAdded)
    track_data = data["tracks"][0]
    assert "duration" in track_data, "Track missing 'duration' field"
    assert "dateAdded" in track_data, "Track missing 'dateAdded' field (camelCase)"
    assert track_data["duration"] == 180.0
    assert track_data["dateAdded"] == 1234567890
    assert track_data["title"] == "Test Song"
    assert track_data["artist"] == "Test Artist"



def test_track_data_structure_in_playlists(client, mock_playlist_service):
    """Test track data structure in playlist detail endpoint."""
    from pathlib import Path
    from app.domains.playlists.models import PlaylistTrack
    
    mock_track = PlaylistTrack(
        path=Path("/music/Test Album/test.mp3"),
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        track_number=1,
        duration=180.5,
        date_added=1234567890.5
    )
    mock_playlist = Playlist(
        name="Test Playlist",
        tracks=[mock_track],
        created_at=1234567890,
        modified_at=1234567890
    )
    mock_playlist_service.get_playlist.return_value = mock_playlist
    
    response = client.get("/api/playlists/Test%20Playlist")
    
    assert response.status_code == 200
    data = response.json()
    
    track_data = data["tracks"][0]
    
    # Verify all required track fields
    assert "title" in track_data, "Track missing 'title' field"
    assert "artist" in track_data, "Track missing 'artist' field"
    assert "album" in track_data, "Track missing 'album' field"
    assert "duration" in track_data, "Track missing 'duration' field"
    assert "dateAdded" in track_data, "Track missing 'dateAdded' field (camelCase)"
    assert "path" in track_data, "Track missing 'path' field"
    
    # Verify field values
    assert track_data["title"] == "Test Song"
    assert track_data["artist"] == "Test Artist"
    assert track_data["album"] == "Test Album"
    assert track_data["duration"] == 180.5
    assert track_data["dateAdded"] == 1234567890.5
    assert str(track_data["path"]) == "/music/Test Album/test.mp3"


@pytest.mark.parametrize(
    ("file_genre", "stored_genre", "stored_metadata"),
    [("Rock", None, True), ("Rock", None, False), (None, None, True), ("Rock", "Jazz", True)],
)
def test_playlist_row_genre_from_tags_or_storage(
    client, mock_playlist_service, config, tmp_path, file_genre, stored_genre, stored_metadata,
):
    """Real file tags survive the playlist loader and response-model filtering."""
    path = tmp_path / "song.wav"
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 8000)
    audio = WAVE(path)
    audio.add_tags()
    audio.tags.add(TPE1(encoding=3, text=["File Artist"]))
    if file_genre is not None:
        audio.tags.add(TCON(encoding=3, text=[file_genre]))
    audio.save()

    logger = logging.getLogger(__name__)
    repo = PlaylistRepository(config, logger)
    repo.save_playlist(Playlist(name="Genres", tracks=[PlaylistTrack(
        path=path, title="Song", artist="Stored Artist" if stored_metadata else None,
        duration=180.0 if stored_metadata else None, genre=stored_genre, date_added=1234567890.0,
    )]))
    mock_playlist_service.get_playlist.return_value = repo.load_playlist("Genres")
    music_repo = MusicRepository(config, logger, analysis=Mock())
    music_repo.read_tags = Mock(wraps=music_repo.read_tags)
    mock_playlist_service.music_repo = music_repo

    response = client.get("/api/playlists/Genres")

    assert response.status_code == 200
    row = response.json()["tracks"][0]
    assert row["genre"] == (stored_genre if stored_genre is not None else file_genre)
    assert row["artist"] == ("Stored Artist" if stored_metadata else "File Artist")
    assert row["duration"] == (180.0 if stored_metadata else 1.0)
    if stored_genre is not None:
        music_repo.read_tags.assert_not_called()
    else:
        music_repo.read_tags.assert_called_once_with(path)


def test_check_12_changed_playlist_returns_412_with_both_versions(client, mock_playlist_service, config, tmp_path):
    config.jobs_file = tmp_path / 'jobs.sqlite'
    mock_playlist_service.config = config
    original = Playlist(name='Queued', tracks=[], created_at=1, modified_at=1)
    mock_playlist_service.get_playlist.return_value = original
    first = client.get('/api/playlists/Queued')
    assert first.status_code == 200
    assert client.get('/api/playlists/Queued', headers={'If-None-Match': first.headers['etag']}).status_code == 304
    mock_playlist_service.get_playlist.return_value = Playlist(name='Queued', description='Changed in nest', tracks=[], created_at=1, modified_at=2)
    app.state.container.changes.bump('playlists')
    local = []
    headers = {'If-Match': first.headers['etag'], 'Idempotency-Key': 'queued-edit'}
    conflict = client.put('/api/playlists/Queued/tracks', json=local, headers=headers)
    assert conflict.status_code == 412
    assert conflict.json()['detail']['current']['description'] == 'Changed in nest'
    assert conflict.json()['detail']['etag'] != first.headers['etag']
    assert first.json()['description'] != conflict.json()['detail']['current']['description']
    assert client.put('/api/playlists/Queued/tracks', json=local, headers=headers).json() == conflict.json()
    mock_playlist_service.replace_tracks.assert_not_called()
