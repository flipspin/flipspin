"""Unit tests for ConfigManager."""
import pytest

from app.config import (
    REQUIRED_DIRS,
    STATE_PATHS,
    ConfigManager,
    env_paths,
    env_true,
    settings_from_env,
    spotify_redirect_uri,
)


def test_config_manager_initialization(tmp_path):
    """Test ConfigManager initializes with provided values."""
    config = ConfigManager(
        base_music_dir=tmp_path / "music",
        playlist_dir=tmp_path / "playlists",
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials"
    )
    
    assert config.base_music_dir == tmp_path / "music"
    assert config.playlist_dir == tmp_path / "playlists"
    assert config.temp_dir == tmp_path / "temp"
    assert config.log_level in ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
    assert config.max_concurrent_downloads > 0
    assert config.analysis_auto is True
    assert not hasattr(config, 'analysis_auto_library')
    assert not hasattr(config, 'analysis_auto_upgrade')


@pytest.mark.parametrize('key, attr', [
    ('KROBI_ANALYSIS_AUTO_UPGRADE', 'analysis_auto_upgrade'),
    ('KROBI_ANALYSIS_AUTO_LIBRARY', 'analysis_auto_library'),
    ('KROBI_NEST_LIBRARY_START_HOUR', 'nest_library_start_hour'),
    ('KROBI_NEST_LIBRARY_END_HOUR', 'nest_library_end_hour'),
])
@pytest.mark.parametrize('value', [None, 'false', 'true', 'invalid'])
def test_retired_settings_are_ignored(monkeypatch, key, attr, value):
    monkeypatch.delenv(key, raising=False)
    if value is not None:
        monkeypatch.setenv(key, value)
    assert attr not in settings_from_env()


def test_config_manager_custom_values(tmp_path, monkeypatch):
    """Test ConfigManager uses provided values."""
    test_music_dir = tmp_path / "music"
    test_playlist_dir = tmp_path / "playlists"
    
    config = ConfigManager(
        base_music_dir=test_music_dir,
        playlist_dir=test_playlist_dir,
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials",
        max_concurrent_downloads=5
    )
    
    assert config.base_music_dir == test_music_dir
    assert config.playlist_dir == test_playlist_dir
    assert config.max_concurrent_downloads == 4


def test_config_manager_from_env(tmp_path, monkeypatch):
    """Test ConfigManager loads from environment variables."""
    test_music_dir = tmp_path / "music"
    test_playlist_dir = tmp_path / "playlists"

    monkeypatch.setenv("KROBI_MUSIC_DIR", str(test_music_dir))
    monkeypatch.setenv("KROBI_PLAYLIST_DIR", str(test_playlist_dir))

    config = ConfigManager.from_env()

    assert config.base_music_dir == test_music_dir
    assert config.playlist_dir == test_playlist_dir
    # Directories should be created
    assert test_music_dir.exists()
    assert test_playlist_dir.exists()


def test_write_analysis_tags_defaults_off(tmp_path):
    """Tag write-back is opt-in: off unless explicitly enabled."""
    config = ConfigManager(
        base_music_dir=tmp_path / "music",
        playlist_dir=tmp_path / "playlists",
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials",
    )
    assert config.write_analysis_tags is False


def test_write_analysis_tags_from_env(tmp_path, monkeypatch):
    """KROBI_WRITE_ANALYSIS_TAGS=true flips the flag on via from_env."""
    monkeypatch.setenv("KROBI_MUSIC_DIR", str(tmp_path / "music"))
    monkeypatch.setenv("KROBI_WRITE_ANALYSIS_TAGS", "true")

    config = ConfigManager.from_env()

    assert config.write_analysis_tags is True


def test_instance_file_defaults_beside_the_other_state(tmp_path):
    """The id names the data directory, so it has to live inside it.

    Derived from ``playlist_dir`` rather than ``Path.home()`` for the same reason
    as ``users_file``: two libraries on one machine must not be able to introduce
    themselves as the same server.
    """
    config = ConfigManager(
        base_music_dir=tmp_path / "music",
        playlist_dir=tmp_path / "playlists",
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials",
    )
    assert config.instance_file == tmp_path / "instance.json"


def test_instance_file_from_env(tmp_path, monkeypatch):
    """``KROBI_INSTANCE_FILE`` must actually reach the constructor.

    ``user_tracks_file`` was read and then dropped, and nothing noticed because
    the constructor's fallback happened to be the same path. This asserts the
    value arrives, using a path the fallback would never produce.
    """
    elsewhere = tmp_path / "elsewhere" / "id.json"
    monkeypatch.setenv("KROBI_MUSIC_DIR", str(tmp_path / "music"))
    monkeypatch.setenv("KROBI_INSTANCE_FILE", str(elsewhere))

    config = ConfigManager.from_env()

    assert config.instance_file == elsewhere


def test_every_state_path_env_var_reaches_the_config(tmp_path, monkeypatch):
    """Each STATE_PATHS variable lands on its attribute, at a path no fallback makes."""
    monkeypatch.setenv("KROBI_MUSIC_DIR", str(tmp_path / "music"))
    for kwarg, (var, _name) in STATE_PATHS.items():
        monkeypatch.setenv(var, str(tmp_path / "elsewhere" / kwarg))

    config = ConfigManager.from_env()

    for kwarg in STATE_PATHS:
        assert getattr(config, kwarg) == tmp_path / "elsewhere" / kwarg


def test_state_paths_default_beside_the_playlists(tmp_path):
    config = ConfigManager(
        base_music_dir=tmp_path / "music",
        playlist_dir=tmp_path / "data" / "playlists",
        temp_dir=tmp_path / "temp",
        log_dir=tmp_path / "logs",
        credentials_dir=tmp_path / "credentials",
    )
    for kwarg, (_var, name) in STATE_PATHS.items():
        assert getattr(config, kwarg) == tmp_path / "data" / name


def test_from_env_creates_every_required_dir(tmp_path, monkeypatch):
    for kwarg, (var, _name) in REQUIRED_DIRS.items():
        monkeypatch.setenv(var, str(tmp_path / kwarg))

    config = ConfigManager.from_env()

    for kwarg in REQUIRED_DIRS:
        assert (tmp_path / kwarg).is_dir()
        assert getattr(config, kwarg) == tmp_path / kwarg


def test_env_paths_reads_the_variable_else_the_home_default(tmp_path, monkeypatch):
    table = {"a": ("KROBI_TEST_A", "a.json"), "b": ("KROBI_TEST_B", "b")}
    monkeypatch.setenv("KROBI_TEST_A", str(tmp_path / "x.json"))
    monkeypatch.delenv("KROBI_TEST_B", raising=False)

    assert env_paths(tmp_path / "home", table) == {
        "a": tmp_path / "x.json",
        "b": tmp_path / "home" / "b",
    }


@pytest.mark.parametrize("value, expected", [
    ("true", True), ("TRUE", True), ("false", False), ("1", False), ("yes", False),
])
def test_env_true_accepts_only_the_word_true(monkeypatch, value, expected):
    monkeypatch.setenv("KROBI_TEST_FLAG", value)
    assert env_true("KROBI_TEST_FLAG") is expected


def test_env_true_default_applies_when_unset(monkeypatch):
    monkeypatch.delenv("KROBI_TEST_FLAG", raising=False)
    assert env_true("KROBI_TEST_FLAG") is False
    assert env_true("KROBI_TEST_FLAG", "true") is True


@pytest.mark.parametrize("value, expected", [
    ("false", False), ("0", False), ("No", False), (" off ", False),
    ("true", True), ("anything", True),
])
def test_advertise_is_on_unless_switched_off(monkeypatch, value, expected):
    monkeypatch.setenv("KROBI_ADVERTISE", value)
    assert settings_from_env()["advertise"] is expected


def test_editor_timeout_falls_back_to_the_download_timeout(monkeypatch):
    monkeypatch.delenv("KROBI_EDITOR_RENDER_TIMEOUT", raising=False)
    monkeypatch.setenv("KROBI_DOWNLOAD_TIMEOUT", "77")
    settings = settings_from_env()
    assert settings["download_timeout"] == 77
    assert settings["editor_render_timeout"] == 77


def test_spotify_redirect_uri_follows_the_backend_port(monkeypatch):
    monkeypatch.delenv("SPOTIFY_REDIRECT_URI", raising=False)
    monkeypatch.setenv("KROBI_BACKEND_PORT", "8003")
    assert spotify_redirect_uri() == "http://127.0.0.1:8003/api/spotify/callback"
    monkeypatch.setenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:9/cb")
    assert spotify_redirect_uri() == "http://127.0.0.1:9/cb"


def test_music_folder_reload_reads_latest_app_value(tmp_path, monkeypatch):
    from app.infra import env_sources

    for _, (key, name) in REQUIRED_DIRS.items():
        monkeypatch.setenv(key, str(tmp_path / name))
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", {"KROBI_MUSIC_DIR"})
    env_sources.persist(tmp_path / ".env", {"KROBI_MUSIC_DIR": str(tmp_path / "chosen music")})
    assert ConfigManager.from_env().base_music_dir == tmp_path / "chosen music"


def test_retired_environment_logs_each_set_key_once(monkeypatch, caplog):
    import logging
    from app.config import RETIRED_SETTINGS, log_retired_settings
    for key in RETIRED_SETTINGS:
        monkeypatch.delenv(key, raising=False)
    log_retired_settings(logging.getLogger('test'))
    assert not caplog.messages
    for key in RETIRED_SETTINGS:
        monkeypatch.setenv(key, 'invalid')
    log_retired_settings(logging.getLogger('test'))
    assert caplog.messages == [f'{key} is no longer used; ignored' for key in RETIRED_SETTINGS]
    assert not set(settings_from_env()).intersection({
        'analysis_auto_library', 'analysis_auto_upgrade', 'nest_library_start_hour', 'nest_library_end_hour'})
