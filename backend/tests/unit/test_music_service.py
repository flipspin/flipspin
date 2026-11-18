"""Unit tests for MusicService."""
import pytest
from pathlib import Path
from unittest.mock import Mock
from app.domains.music.services import MusicService
from app.domains.music.models import Album, Track
from app.exceptions import MusicNotFoundError, ValidationError


@pytest.fixture
def mock_music_repo():
    """Create mock music repository."""
    return Mock()


@pytest.fixture
def mock_metadata_repo():
    """Create mock metadata repository."""
    return Mock()


@pytest.fixture
def mock_config(tmp_path):
    """Create mock config."""
    config = Mock()
    config.base_music_dir = tmp_path / "music"
    config.base_music_dir.mkdir(parents=True, exist_ok=True)
    return config


@pytest.fixture
def mock_logger():
    """Create mock logger."""
    return Mock()


@pytest.fixture
def music_service(mock_music_repo, mock_metadata_repo, mock_config, mock_logger):
    """Create MusicService instance."""
    return MusicService(
        mock_music_repo,
        mock_metadata_repo,
        mock_config,
        mock_logger
    )


def test_list_albums(music_service, mock_music_repo):
    """Test listing albums."""
    # Setup mock
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
    mock_music_repo.scan_albums.return_value = [mock_album]
    
    # Execute
    albums = music_service.list_albums()
    
    # Assert
    assert len(albums) == 1
    assert albums[0].name == "Test Album"
    assert albums[0].artist == "Test Artist"
    mock_music_repo.scan_albums.assert_called_once()


def test_get_album_not_found(music_service, mock_config):
    """Test getting non-existent album."""
    with pytest.raises(MusicNotFoundError):
        music_service.get_album("NonExistent Album")


def test_get_track_not_found(music_service, mock_config):
    """Test getting non-existent track."""
    with pytest.raises(MusicNotFoundError):
        music_service.get_track("Album", "nonexistent.mp3")


def test_search_tracks_empty_query(music_service):
    """Test searching with empty query."""
    with pytest.raises(ValidationError):
        music_service.search_tracks("")


def test_search_tracks_short_query(music_service):
    """Test searching with too short query."""
    with pytest.raises(ValidationError):
        music_service.search_tracks("a")


def test_search_tracks_success(music_service, mock_music_repo):
    """Test successful track search."""
    # Setup mock
    mock_track = Track(
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        path=Path("/music/test.mp3"),
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
    mock_music_repo.scan_albums.return_value = [mock_album]
    
    # Execute
    results = music_service.search_tracks("test")
    
    # Assert
    assert len(results) == 1
    assert results[0].title == "Test Song"


def test_update_metadata_file_not_found(music_service, mock_music_repo):
    """Test updating metadata for non-existent file."""
    mock_music_repo.file_exists.return_value = False
    
    with pytest.raises(MusicNotFoundError):
        music_service.update_metadata(Path("/nonexistent.mp3"), Mock())
