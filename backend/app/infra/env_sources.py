"""Boot provenance and the shared, atomic app-settings file.

Capture before main loads any dotenv file. Runtime writes never change which
keys the operator pinned, including keys pinned to an empty string.
"""
import os
import inspect
import threading
from pathlib import Path
from functools import wraps

from fastapi import HTTPException

from app.infra.files import write_secret_lines

ENV_KEYS: frozenset[str] = frozenset()
APP_KEYS: set[str] = set()
SETTINGS_LOCK = threading.RLock()


def capture_environment() -> None:
    global ENV_KEYS
    ENV_KEYS = frozenset(k for k in os.environ if k.startswith(("KROBI_", "SPOTIFY_")))


def read_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            values[key.strip().removeprefix("export ")] = value.strip().strip("'\"")
    return values


def load_environment(home: Path) -> None:
    """Same dotenv precedence for the API process and operator commands."""
    persistent = Path(os.getenv("KROBI_CREDENTIALS_DIR", str(home / "credentials"))).parent / ".env"
    # The credentials boundary migrates these itself. Loading them into the
    # process would turn app-owned values into locked operator values.
    secret_keys = {"KROBI_GENIUS_API_KEY", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET",
                   "SPOTIFY_REFRESH_TOKEN"}
    for path in (persistent, Path(__file__).resolve().parents[2] / ".env", Path.cwd() / ".env"):
        for key, value in read_values(path).items():
            if path == persistent and key in secret_keys:
                continue
            os.environ.setdefault(key, value)
    record_app_keys(persistent)


def record_app_keys(path: Path) -> None:
    APP_KEYS.update(read_values(path))


def source(key: str, path: Path) -> str:
    if key in ENV_KEYS:
        return "env"
    return "app" if key in APP_KEYS or key in read_values(path) else "default"


def require_unlocked(*keys: str) -> None:
    for key in keys:
        if key in ENV_KEYS:
            raise HTTPException(409, {"code": "env-locked", "key": key})


def persist(path: Path, changes: dict[str, str]) -> None:
    """Merge under one lock shared by the new API and the older switches."""
    require_unlocked(*changes)
    for key, value in changes.items():
        if any(c in value for c in "\r\n\x00"):
            raise HTTPException(422, {"code": "bad-type", "key": key})
    with SETTINGS_LOCK:
        try:
            lines = path.read_text(encoding="utf-8").splitlines(keepends=True) if path.exists() else []
            lines = [line for line in lines if line.strip().partition("=")[0].strip() not in changes]
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.extend(f"{key}={value}\n" for key, value in changes.items())
            write_secret_lines(path, lines)
        except OSError as e:
            raise HTTPException(500, {"code": "write-failed"}) from e
        APP_KEYS.update(changes)


def settings_write(method):
    """Serialize the older switches' persist-and-apply with batch saves."""
    @wraps(method)
    def run(*args, **kwargs):
        with SETTINGS_LOCK:
            return method(*args, **kwargs)
    # FastAPI resolves postponed annotations in the wrapper's module otherwise.
    run.__signature__ = inspect.signature(method, eval_str=True)
    return run
