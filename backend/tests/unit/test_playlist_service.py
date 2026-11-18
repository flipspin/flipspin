"""Unit tests for PlaylistService."""
import pytest
from unittest.mock import Mock
from app.domains.playlists.services import PlaylistService, playlist_detail_tracks
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.exceptions import PlaylistError, ValidationError


@pytest.fixture
def mock_playlist_repo():
    """Create mock playlist repository."""
    return Mock()


@pytest.fixture
def mock_music_repo():
    """Create mock music repository."""
    return Mock()


@pytest.fixture
def mock_config(tmp_path):
    """Create mock config."""
    config = Mock()
    config.playlist_dir = tmp_path / "playlists"
    config.playlist_dir.mkdir(parents=True, exist_ok=True)
    config.base_music_dir = tmp_path / "music"
    config.base_music_dir.mkdir(parents=True, exist_ok=True)
    return config


@pytest.fixture
def mock_logger():
    """Create mock logger."""
    return Mock()


@pytest.fixture
def playlist_service(mock_playlist_repo, mock_music_repo, mock_config, mock_logger):
    """Create PlaylistService instance."""
    return PlaylistService(
        mock_playlist_repo,
        mock_music_repo,
        mock_config,
        mock_logger
    )


def test_create_playlist_empty_name(playlist_service):
    """Test creating playlist with empty name."""
    with pytest.raises(ValidationError):
        playlist_service.create_playlist("", [])


def test_create_playlist_success(playlist_service, mock_playlist_repo, mock_music_repo):
    """Test successful playlist creation."""
    # Setup mocks
    mock_playlist_repo.playlist_exists.return_value = False
    
    # Execute
    playlist = playlist_service.create_playlist("Test Playlist", "Test description")
    
    # Assert
    assert playlist.name == "Test Playlist"
    assert playlist.description == "Test description"
    assert len(playlist.tracks) == 0
    mock_playlist_repo.save_playlist.assert_called_once()


def test_list_playlists(playlist_service, mock_playlist_repo):
    """Test listing playlists."""
    # Setup mock
    mock_playlist = Playlist(
        name="Test Playlist",
        tracks=[],
        created_at=1234567890,
        modified_at=1234567890
    )
    mock_playlist_repo.list_playlists.return_value = ["Test Playlist"]
    mock_playlist_repo.load_playlist.return_value = mock_playlist
    
    # Execute
    playlists = playlist_service.list_playlists()
    
    # Assert
    assert len(playlists) == 1
    assert playlists[0].name == "Test Playlist"


def test_get_playlist_not_found(playlist_service, mock_playlist_repo):
    """Test getting non-existent playlist."""
    mock_playlist_repo.playlist_exists.return_value = False
    
    with pytest.raises(PlaylistError):
        playlist_service.get_playlist("NonExistent")


def test_delete_playlist_success(playlist_service, mock_playlist_repo):
    """Test successful playlist deletion."""
    mock_playlist_repo.playlist_exists.return_value = True
    
    playlist_service.delete_playlist("Test Playlist")
    
    mock_playlist_repo.delete_playlist.assert_called_once_with("Test Playlist")


def test_delete_playlist_not_found(playlist_service, mock_playlist_repo):
    """Test deleting non-existent playlist."""
    mock_playlist_repo.playlist_exists.return_value = False

    with pytest.raises(PlaylistError):
        playlist_service.delete_playlist("NonExistent")


def test_rename_playlist_success(playlist_service, mock_playlist_repo):
    """Renaming delegates to the repo and returns the reloaded playlist."""
    mock_playlist_repo.playlist_exists.return_value = True
    mock_playlist_repo.load_playlist.return_value = Playlist(name="Renamed", tracks=[])

    result = playlist_service.rename_playlist("Old", "Renamed")

    mock_playlist_repo.rename_playlist.assert_called_once_with("Old", "Renamed")
    assert result.name == "Renamed"


def test_rename_playlist_trims_name(playlist_service, mock_playlist_repo):
    """Surrounding whitespace in the new name is trimmed before renaming."""
    mock_playlist_repo.playlist_exists.return_value = True
    mock_playlist_repo.load_playlist.return_value = Playlist(name="Clean", tracks=[])

    playlist_service.rename_playlist("Old", "  Clean  ")

    mock_playlist_repo.rename_playlist.assert_called_once_with("Old", "Clean")


def test_rename_playlist_empty_name(playlist_service):
    """An empty new name is rejected before touching the repo."""
    with pytest.raises(ValidationError):
        playlist_service.rename_playlist("Old", "   ")


def test_rename_playlist_not_found(playlist_service, mock_playlist_repo):
    """Renaming a missing playlist raises PlaylistError."""
    mock_playlist_repo.playlist_exists.return_value = False

    with pytest.raises(PlaylistError):
        playlist_service.rename_playlist("Ghost", "Whatever")


@pytest.mark.parametrize("file_exists", [False, True])
@pytest.mark.parametrize("stored_genre", [None, "Jazz"])
def test_playlist_row_genre_when_file_is_missing_or_unreadable(tmp_path, file_exists, stored_genre):
    path = tmp_path / "song.mp3"
    if file_exists:
        path.touch()
    music_repo = Mock()
    music_repo.read_tags.side_effect = OSError("Unreadable tags")
    playlist = Playlist(name="Genres", tracks=[PlaylistTrack(path=path, title="Song", genre=stored_genre)])

    row = playlist_detail_tracks(playlist, music_repo)[0]

    assert row["genre"] == stored_genre
    assert row["artist"] == ""
    assert row["duration"] is None
    if file_exists:
        music_repo.read_tags.assert_called_once_with(path)
    else:
        music_repo.read_tags.assert_not_called()
