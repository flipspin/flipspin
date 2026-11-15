"""Pytest configuration and common fixtures."""
import os
import sys
import pytest
import tempfile
import shutil
from pathlib import Path
from unittest.mock import Mock
import json
import io
import subprocess
import wave

import starlette.testclient

import app.config as config_module
from app.config import ConfigManager
from app.infra.logging import LoggerConfig


@pytest.fixture
def write_audio(config):
    """Create real audio fixtures using PCM WAV and the configured ffmpeg."""
    def write(path, samples, sample_rate):
        import numpy as np

        samples = np.asarray(samples)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as audio:
            audio.setnchannels(1 if samples.ndim == 1 else samples.shape[1])
            audio.setsampwidth(2)
            audio.setframerate(sample_rate)
            audio.writeframes((np.clip(samples, -1, 32767 / 32768) * 32768).astype('<i2').tobytes())
        if path.suffix == '.wav':
            path.write_bytes(buffer.getvalue())
        else:
            subprocess.run([config.ffmpeg_path, '-v', 'error', '-nostdin', '-y',
                            '-i', 'pipe:0', str(path)], input=buffer.getvalue(),
                           capture_output=True, check=True, timeout=30)
    return write


def _make_test_client_look_local() -> None:
    """Model local TestClient requests as loopback before any client is created.

    Starlette's default testclient address is not an IP and fails local auth.
    Tests for remote callers supply their own explicit client address.
    """
    original_init = starlette.testclient.TestClient.__init__

    def init_with_loopback_client(self, *args, **kwargs):
        kwargs.setdefault("client", ("127.0.0.1", 50000))
        original_init(self, *args, **kwargs)

    starlette.testclient.TestClient.__init__ = init_with_loopback_client


def _isolate_user_state_files() -> None:
    """Isolate persisted settings and caches before app import constructs services.

    Fixtures run too late for import-time reads. Redirect playlist ownership
    migration too, so integration tests cannot modify a real collection.
    """
    sandbox = Path(tempfile.mkdtemp(prefix="krobi-test-state-"))
    config_module.KROBI_HOME = sandbox
    for var, name in (
        ("KROBI_PROVIDERS_FILE", "providers.json"),
        ("KROBI_DASHBOARD_CACHE_FILE", "dashboard-cache.json"),
        ("KROBI_BROWSE_CACHE_FILE", "browse-cache.json"),
        ("KROBI_PLAYLIST_DIR", "playlists"),
        # Reading server identity can create it; redirect the path before any status
        # request so tests never mint identity into a real data directory.
        ("KROBI_INSTANCE_FILE", "instance.json"),
        # The first-run setup token (app/domains/accounts/claim.py). ``app.main`` generates
        # it at import time on a server with no users, and the developer's real
        # ~/Krobi may well be one — so without this, importing the app during a
        # test run would drop a live claim credential into the data directory of
        # the app they are actually using, and print it to that app's log.
        ("KROBI_SETUP_TOKEN_FILE", "setup-token"),
        # Installed plugins must not leak into the public API contract tests.
        ("KROBI_PLUGINS_DIR", "plugins"),
        ("KROBI_USERS_FILE", "users.json"),
        ("KROBI_USER_TRACKS_FILE", "user_tracks.json"),
        ("KROBI_LYRICS_FILE", "lyrics.json"),
        ("KROBI_STEMS_DIR", "stems"),
        ("KROBI_TOOLS_DIR", "tools"),
        ("KROBI_MODELS_DIR", "models"),
        # ``ConfigManager.from_env`` creates these four at import and the logger
        # opens its files under the third, so without them a test run builds a
        # ``~/Krobi`` of its own — or appends to the log of the app in use.
        ("KROBI_MUSIC_DIR", "Music"),
        ("KROBI_TEMP_DIR", "temp"),
        ("KROBI_LOG_DIR", "logs"),
        ("KROBI_CREDENTIALS_DIR", "credentials"),
    ):
        # Never override a value the test runner set deliberately.
        os.environ.setdefault(var, str(sandbox / name))
    # Public tests must stay plugin-free even in a linked development shell.
    os.environ["KROBI_PLUGINS_DIR"] = str(sandbox / "plugins")
    # The LAN advertiser (app/infra/discovery.py) must never announce a test
    # server on the developer's network. Tests that exercise it inject a fake
    # zeroconf and a config of their own.
    os.environ.setdefault("KROBI_ADVERTISE", "false")


_isolate_user_state_files()
_make_test_client_look_local()


@pytest.fixture
def temp_dir():
    """Create a temporary directory for tests."""
    temp_path = Path(tempfile.mkdtemp())
    yield temp_path
    shutil.rmtree(temp_path, ignore_errors=True)


@pytest.fixture
def config(temp_dir):
    """Create a test configuration."""
    return _make_config(temp_dir)


def _make_config(temp_dir):
    music_dir = temp_dir / "music"
    playlist_dir = temp_dir / "playlists"
    temp_test_dir = temp_dir / "temp"
    log_dir = temp_dir / "logs"
    credentials_dir = temp_dir / "credentials"
    
    # Create directories
    for directory in [music_dir, playlist_dir, temp_test_dir, log_dir, credentials_dir]:
        directory.mkdir(parents=True, exist_ok=True)
    
    return ConfigManager(
        base_music_dir=music_dir,
        playlist_dir=playlist_dir,
        temp_dir=temp_test_dir,
        log_dir=log_dir,
        credentials_dir=credentials_dir,
        genius_api_key="test_genius_key",
        max_concurrent_downloads=2,
        download_timeout=60,
        log_level="DEBUG",
        enable_waveform_cache=True,
    )


@pytest.fixture
def temp_audio_file(temp_dir):
    """Create a temporary audio file for testing."""
    audio_file = temp_dir / "test_audio.mp3"
    audio_file.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")
    return audio_file


@pytest.fixture
def sample_playlist(temp_dir):
    """Create a sample playlist file."""
    playlist_dir = temp_dir / "playlists"
    playlist_dir.mkdir(parents=True, exist_ok=True)
    
    playlist_file = playlist_dir / "test_playlist.json"
    playlist_data = {
        "name": "Test Playlist",
        "description": "A test playlist",
        "tracks": [
            {
                "path": str(temp_dir / "music" / "track1.mp3"),
                "title": "Track 1",
                "artist": "Artist 1",
                "album": "Album 1",
                "track_number": 1,
                "duration": 180.0,
                "dateAdded": 1234567890.0
            },
            {
                "path": str(temp_dir / "music" / "track2.mp3"),
                "title": "Track 2",
                "artist": "Artist 2",
                "album": "Album 2",
                "track_number": 2,
                "duration": 200.0,
                "dateAdded": 1234567900.0
            }
        ],
        "created": 1234567890.0,
        "modified": 1234567890.0
    }
    
    with open(playlist_file, "w") as f:
        json.dump(playlist_data, f, indent=2)
    
    return playlist_file


@pytest.fixture
def mock_genius_api():
    """Mock Genius API responses."""
    mock = Mock()
    mock.search_songs.return_value = [
        {
            "title": "Test Song",
            "artist": "Test Artist",
            "album": "Test Album",
            "url": "https://genius.com/test-song"
        }
    ]
    mock.get_song_info.return_value = {
        "title": "Test Song",
        "artist": "Test Artist",
        "album": "Test Album",
        "year": 2024,
        "genre": "Test Genre"
    }
    mock.get_album_info.return_value = {
        "album": "Test Album",
        "artist": "Test Artist",
        "tracks": ["Track 1", "Track 2", "Track 3"],
        "year": 2024,
        "genre": "Test Genre"
    }
    return mock


@pytest.fixture
def sample_album_structure(temp_dir):
    """Create a sample album directory structure."""
    music_dir = temp_dir / "music"
    album_dir = music_dir / "Test_Album"
    album_dir.mkdir(parents=True, exist_ok=True)
    
    # Create sample tracks
    for i in range(1, 4):
        track_file = album_dir / f"track{i}.mp3"
        track_file.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")
    
    # Create cover art
    cover_dir = album_dir / "cover"
    cover_dir.mkdir(exist_ok=True)
    cover_file = cover_dir / "cover.jpg"
    cover_file.write_bytes(b"\xff\xd8\xff\xe0")  # JPEG header
    
    return album_dir


@pytest.fixture(autouse=True)
def setup_logging(config):
    """Setup logging for tests."""
    LoggerConfig.setup_logging(
        log_dir=config.log_dir,
        log_level="DEBUG",
        use_json=False
    )


@pytest.fixture
def mock_download_repo():
    """Mock download repository."""
    mock = Mock()
    mock.download_source_audio.return_value = Path("/fake/path/audio.mp3")
    mock.search_source.return_value = [
        {"title": "Test Video", "url": "https://youtube.com/watch?v=test"}
    ]
    return mock


@pytest.fixture
def mock_metadata_repo():
    """Mock metadata repository."""
    mock = Mock()
    mock.read_id3_tags.return_value = {
        "title": "Test Track",
        "artist": "Test Artist",
        "album": "Test Album",
        "track_number": 1,
        "year": 2024,
        "genre": "Test Genre"
    }
    return mock


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    """Isolated account services, including pending-code state."""
    from app.main import app
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    for key in ("token_store", "sign_in_codes"):
        app.state.container._services.pop(key, None)
    yield app.state.container.get_token_store()
    for key in ("token_store", "sign_in_codes"):
        app.state.container._services.pop(key, None)


@pytest.fixture(autouse=True)
def isolate_app_container(temp_dir, tmp_path, monkeypatch):
    import sys
    main = sys.modules.get('app.main')
    if main is None:
        yield
        return
    from app.dependencies import DependencyContainer

    # Services retain each other's repositories and revision providers. Dropping
    # selected cache entries leaves old scans and stores reachable, so isolate
    # the whole object graph and its persisted state together for every test.
    # Keep the app tree outside tmp_path, which some tests enumerate directly.
    config = _make_config(temp_dir / 'app')
    config.jobs_file = tmp_path / 'jobs.sqlite'
    config.instance_file = tmp_path / 'instance.json'
    container = DependencyContainer(config)
    monkeypatch.setattr(main.app.state, 'config', config)
    monkeypatch.setattr(main.app.state, 'container', container)
    yield
    container.stop_sources()
    analysis = container._services.get('analysis_service')
    if analysis is not None:
        analysis.stop()
    music = container._repositories.get('music_repository')
    if music is not None:
        music.stop_scanner()
    ledger = container._services.get('jobs')
    if ledger is not None:
        ledger.close()


# Built-in source tests exercise its package outside app, as an installed plugin would.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sources' / 'youtube'))
