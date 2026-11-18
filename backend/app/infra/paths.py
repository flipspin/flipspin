"""Own default data paths. Resolving never creates, copies or moves files."""
import os
import sys
from functools import lru_cache
from pathlib import Path
from collections.abc import Mapping

_FLAG: str | None = None


def set_data_dir(value: str | None) -> None:
    """Set the entry point's explicit override before importing configuration."""
    global _FLAG
    _FLAG = value


def resolve_data_root(flag: str | None = None, *, env: Mapping[str, str] | None = None,
                      home: Path | None = None, platform: str | None = None) -> tuple[Path, str]:
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    platform = sys.platform if platform is None else platform

    def absolute(value: str) -> Path:
        # Expand against the supplied home too, so contract tests need no global patches.
        if value == "~" or value.startswith("~/") or value.startswith("~\\"):
            value = str(home) + value[1:]
        return Path(value).absolute()

    if flag is not None:
        return absolute(flag), "--data-dir"
    primary, alias = env.get("FLIPSPIN_DATA_DIR"), env.get("KROBI_DATA_DIR")
    if primary and alias and absolute(primary) != absolute(alias):
        raise ValueError("FLIPSPIN_DATA_DIR and KROBI_DATA_DIR differ; set one root or matching values")
    if primary:
        return absolute(primary), "FLIPSPIN_DATA_DIR"
    if alias:
        return absolute(alias), "KROBI_DATA_DIR"
    legacy = home / "Krobi"
    # A helper-only computer holds just its engine (tools, models) and settings.
    if any((legacy / name).is_file() for name in ("users.json", "instance.json", "jobs.sqlite", ".env")) \
            or any((legacy / name).is_dir() for name in ("playlists", "tools", "models")):
        return legacy, "legacy data"
    return os_default_root(env=env, home=home, platform=platform), "OS default"


def os_default_root(*, env: Mapping[str, str], home: Path, platform: str) -> Path:
    """This platform's own data folder, the root a new install uses."""
    if platform == "darwin":
        return home / "Library/Application Support/Flipspin"
    if platform == "win32":
        return Path(env.get("LOCALAPPDATA") or home / "AppData/Local") / "Flipspin"
    return Path(env.get("XDG_DATA_HOME") or home / ".local/share") / "flipspin"


@lru_cache(maxsize=32)
def _selected(flag, primary, alias, home, platform, local, xdg):
    # Hold a startup decision even if creating an overridden playlist folder
    # makes a previously empty legacy directory eligible later in this process.
    env = {key: value for key, value in (("FLIPSPIN_DATA_DIR", primary), ("KROBI_DATA_DIR", alias),
           ("LOCALAPPDATA", local), ("XDG_DATA_HOME", xdg)) if value is not None}
    return resolve_data_root(flag, env=env, home=home, platform=platform)


def _selection() -> tuple[Path, str]:
    return _selected(_FLAG, os.getenv("FLIPSPIN_DATA_DIR"), os.getenv("KROBI_DATA_DIR"),
                     Path.home(), sys.platform, os.getenv("LOCALAPPDATA"), os.getenv("XDG_DATA_HOME"))


def data_root() -> Path:
    return _selection()[0]


def root_source() -> str:
    return _selection()[1]


def default_music_dir() -> Path:
    """Where the library lives when nobody chose one."""
    if os.environ.get("KROBI_MUSIC_DIR"):
        return Path(os.environ["KROBI_MUSIC_DIR"]).expanduser()
    root, source = _selection()
    return music_dir_for(root, source, env=os.environ, home=Path.home(), platform=sys.platform)


def music_dir_for(root: Path, source: str, *, env: Mapping[str, str], home: Path, platform: str) -> Path:
    """A new install keeps music in the OS music folder, where people look for it.

    The desktop app names its root explicitly, but when that root is this
    platform's own data folder and holds no library yet, it is still a new
    install. A library already at <root>/Music stays there, and every other
    explicit root (a server's /data, a legacy ~/Krobi) keeps <root>/Music even
    before it exists. Resolving never creates or moves anything.
    """
    own = root / "Music"
    if source != "OS default":
        if own.is_dir() or not _same_path(root, os_default_root(env=env, home=home, platform=platform)):
            return own
    music = env.get("XDG_MUSIC_DIR") if platform not in ("darwin", "win32") else None
    return (Path(music).expanduser() if music else home / "Music") / "Flipspin"


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def state_path(variable: str, name: str, root: Path | None = None) -> Path:
    return Path(os.environ[variable]).expanduser() if os.environ.get(variable) else (root or data_root()) / name


# The five directories every install needs, as constructor kwarg → (env var,
# name under the resolved root). ``from_env`` creates them; ``validate`` refuses to
# start without them.
REQUIRED_DIRS: dict[str, tuple[str, str]] = {
    "base_music_dir": ("KROBI_MUSIC_DIR", "Music"),
    "playlist_dir": ("KROBI_PLAYLIST_DIR", "playlists"),
    "temp_dir": ("KROBI_TEMP_DIR", "temp"),
    "log_dir": ("KROBI_LOG_DIR", "logs"),
    "credentials_dir": ("KROBI_CREDENTIALS_DIR", "credentials"),
}

# State files and folders, same shape. The constructor defaults each one under
# its injected root (see ``_init_state_paths``); ``from_env`` reads them here.
# Every entry must reach the constructor: ``KROBI_USER_TRACKS_FILE`` was once
# read and then dropped, and nothing noticed because the constructor's fallback
# happened to be the same path. An ignored ``KROBI_INSTANCE_FILE`` would be
# quieter still — a relocated data directory would keep introducing itself with
# the default one's id — and a setup token written to the default path would
# guard a household it is not beside. One table feeding both sides is what
# keeps them in step.
STATE_PATHS: dict[str, tuple[str, str]] = {
    "providers_file": ("KROBI_PROVIDERS_FILE", "providers.json"),
    "users_file": ("KROBI_USERS_FILE", "users.json"),
    "user_tracks_file": ("KROBI_USER_TRACKS_FILE", "user_tracks.json"),
    "update_check_file": ("KROBI_UPDATE_CHECK_FILE", "update-check.json"),
    "instance_file": ("KROBI_INSTANCE_FILE", "instance.json"),
    "setup_token_file": ("KROBI_SETUP_TOKEN_FILE", "setup-token"),
    "lyrics_file": ("KROBI_LYRICS_FILE", "lyrics.json"),
    "jobs_file": ("KROBI_JOBS_FILE", "jobs.sqlite"),
    "analysis_db": ("KROBI_ANALYSIS_DB", "analysis.sqlite"),
    "tools_dir": ("KROBI_TOOLS_DIR", "tools"),
    "models_dir": ("KROBI_MODELS_DIR", "models"),
    "stems_dir": ("KROBI_STEMS_DIR", "stems"),
}

