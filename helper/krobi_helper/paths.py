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
    if platform == "darwin":
        return home / "Library/Application Support/Flipspin", "OS default"
    if platform == "win32":
        return Path(env.get("LOCALAPPDATA") or home / "AppData/Local") / "Flipspin", "OS default"
    return Path(env.get("XDG_DATA_HOME") or home / ".local/share") / "flipspin", "OS default"


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


def state_path(variable: str, name: str, root: Path | None = None) -> Path:
    return Path(os.environ[variable]).expanduser() if os.environ.get(variable) else (root or data_root()) / name
