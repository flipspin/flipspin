"""Persist the server data directory's stable identity, name and external address.

Preserve instanceId on updates; public names must not reveal account identity.
See docs/DEVELOPER_GUIDE.md#server-discovery-and-addresses.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime
import unicodedata
import uuid
from pathlib import Path
from app.infra.migrations import read_json_store, refuse, write_json_store

logger = logging.getLogger(__name__)

#: The persisted format version, so a future reader knows how to interpret it.
INSTANCE_FILE_VERSION = 1

#: Bounds of a nest name. 60 characters keeps it inside one line of any list
#: and, for most scripts, inside DNS-SD's 63-byte instance-name label.
NEST_NAME_MAX_LENGTH = 60

#: Serialises every write to an instance file, so a rename racing the first
#: id generation cannot interleave and drop one of the two keys.
_write_lock = threading.RLock()

#: The stored name per instance file (``None`` = unset), so ``/api/status`` —
#: polled in a loop — does not read the file on every call. Keyed by path like
#: the id cache in ``domains/system/routes.py``; :func:`set_name` invalidates.
_name_cache: dict[str, str | None] = {}

#: The stored external URL per instance file, same reasoning as the name: every
#: client reads ``/api/server/network`` on every successful connection.
_external_url_cache: dict[str, str | None] = {}


def read_secret_key(path: Path) -> dict:
    with _write_lock:
        value = _read_raw(path).get("secretKey", {})
        return value if isinstance(value, dict) else {}


def set_secret_key(path: Path, key_info: dict) -> None:
    with _write_lock:
        read_or_create_instance_id(path)
        payload = _read_raw(path)
        payload["secretKey"] = dict(key_info)
        _save(path, payload)


class InvalidNestNameError(ValueError):
    """The proposed nest name is empty, too long or carries control characters."""


def read_or_create_instance_id(path: Path, logger_: logging.Logger | None = None) -> str:
    """Read a stable identity, creating it only when the file never existed."""
    with _write_lock:
        raw = _read_raw(path)
        if Path(path).exists():
            existing = raw.get('instanceId')
            if not isinstance(existing, str) or not existing:
                refuse('instance', raw.get('version', 0), INSTANCE_FILE_VERSION, 'read',
                       'existing instance file has no usable instanceId')
            return existing
        generated = uuid.uuid4().hex
        _write(path, generated, logger_ or logger)
        return generated


def _read_raw(path: Path) -> dict:
    raw = read_json_store(path, INSTANCE_FILE_VERSION)
    if raw is not None and (not isinstance(raw.get('instanceId'), str) or not raw['instanceId']):
        refuse('instance', raw.get('version', 0), INSTANCE_FILE_VERSION, 'read',
               'existing instance file has no usable instanceId')
    return raw or {}


def _write(path: Path, instance_id: str, log: logging.Logger) -> bool:
    with _write_lock:
        payload = _read_raw(path)
        payload.update({'version': INSTANCE_FILE_VERSION, 'instanceId': instance_id})
        _save(path, payload)
        return True


def _save(path, payload):
    write_json_store(path, payload, INSTANCE_FILE_VERSION)


def clean_nest_name(value: object) -> str:
    """``value`` trimmed, or :class:`InvalidNestNameError` saying why not.

    1–60 characters after trimming, no control characters (a newline in a name
    would break every list it is drawn in, and the mDNS TXT record).
    """
    if not isinstance(value, str):
        raise InvalidNestNameError("The name must be text.")
    name = value.strip()
    if not name:
        raise InvalidNestNameError("The name cannot be empty.")
    if len(name) > NEST_NAME_MAX_LENGTH:
        raise InvalidNestNameError(
            f"The name can be at most {NEST_NAME_MAX_LENGTH} characters."
        )
    if any(unicodedata.category(ch) == "Cc" for ch in name):
        raise InvalidNestNameError("The name cannot contain control characters.")
    return name


def default_name() -> str:
    """Use a generic public label until an owner names the server.

    Never from an account (served to anyone who can reach the port) and not from
    the hostname, which inside a container is random hex. The owner renames it.
    """
    return "Flipspin"


def read_name(path: Path) -> str | None:
    """The stored nest name, or ``None`` when none is set (or it is unusable).

    Cached per path; never raises.
    """
    key = str(path)
    if key in _name_cache:
        return _name_cache[key]
    stored = _read_raw(path).get("name")
    try:
        name = clean_nest_name(stored) if stored is not None else None
    except InvalidNestNameError:
        logger.warning("Ignoring an unusable nest name in %s", path)
        name = None
    _name_cache[key] = name
    return name


def get_name(path: Path) -> str:
    """The name this server introduces itself with: stored, else the default."""
    return read_name(path) or default_name()


def set_name(path: Path, name: str, logger_: logging.Logger | None = None) -> str:
    """Validate and persist ``name`` beside the id. Returns the stored value.

    Raises :class:`InvalidNestNameError` for a bad name and ``OSError`` when the
    file cannot be written. Read-modify-write under the module lock: the id is
    created first if the file has none, so the rename can never leave a file
    whose id the next read would regenerate.
    """
    log = logger_ or logger
    cleaned = clean_nest_name(name)
    with _write_lock:
        instance_id = read_or_create_instance_id(path, log)
        payload = _read_raw(path)
        payload.update(
            {"version": INSTANCE_FILE_VERSION, "instanceId": instance_id, "name": cleaned}
        )
        try:
            _save(path, payload)
        finally:
            _name_cache.pop(str(path), None)
    return cleaned


def read_setup_done(path: Path) -> bool | None:
    """Whether the first-run wizard was finished, or ``None`` if never recorded.

    ``None`` is every server that predates the wizard; ``GET /api/status``
    reads that as done once the server is claimed, so an existing household
    never sees the wizard. ``POST /api/claim`` records ``False`` explicitly.
    """
    value = _read_raw(path).get("setupDone")
    return value if isinstance(value, bool) else None


def set_setup_done(path: Path, done: bool, logger_: logging.Logger | None = None) -> bool:
    """Record the wizard's state beside the id. Read-modify-write under the lock."""
    log = logger_ or logger
    with _write_lock:
        instance_id = read_or_create_instance_id(path, log)
        payload = _read_raw(path)
        payload.update(
            {"version": INSTANCE_FILE_VERSION, "instanceId": instance_id, "setupDone": bool(done)}
        )
        _save(path, payload)
    return bool(done)


def read_external_url(path: Path) -> str | None:
    """The stored external URL, or ``None`` when unset or no longer valid.

    Re-normalised on read, so a hand-edited file cannot hand clients an
    ``http://`` address. Cached per path; never raises.
    """
    from app.infra.remote_access import ExternalUrlError, normalise_external_url

    key = str(path)
    if key in _external_url_cache:
        return _external_url_cache[key]
    stored = _read_raw(path).get("externalUrl")
    try:
        url = normalise_external_url(stored) if stored is not None else None
    except ExternalUrlError:
        logger.warning("Ignoring an unusable externalUrl in %s", path)
        url = None
    _external_url_cache[key] = url
    return url


def set_external_url(
    path: Path, value: str | None, logger_: logging.Logger | None = None
) -> str | None:
    """Normalise and persist ``value`` beside the id; ``None``/blank clears it.

    Raises ``remote_access.ExternalUrlError`` (its ``code`` is the contract's
    reason) and ``OSError`` when the file cannot be written. Read-modify-write
    under the module lock, like :func:`set_name`: the id and the name survive.
    """
    from app.infra.remote_access import normalise_external_url

    log = logger_ or logger
    url = normalise_external_url(value)
    with _write_lock:
        instance_id = read_or_create_instance_id(path, log)
        payload = _read_raw(path)
        payload.update({"version": INSTANCE_FILE_VERSION, "instanceId": instance_id})
        if url is None:
            payload.pop("externalUrl", None)
        else:
            payload["externalUrl"] = url
        try:
            _save(path, payload)
        finally:
            _external_url_cache.pop(str(path), None)
    return url


REMOTE_ROUTES = ("tailscale", "wireguard", "domain", "local")
_route_cache: dict[str, str | None] = {}
_outside_cache: dict[str, dict | None] = {}
_outside_flushed: dict[str, float] = {}


def read_remote_route(path: Path) -> str | None:
    key = str(path)
    with _write_lock:
        if key not in _route_cache:
            value = _read_raw(path).get("route")
            _route_cache[key] = value if value in REMOTE_ROUTES else None
        return _route_cache[key]


def set_remote_route(path: Path, route: str) -> str:
    if route not in REMOTE_ROUTES:
        raise ValueError("unknown-route")
    with _write_lock:
        read_or_create_instance_id(path)
        payload = _read_raw(path)
        payload["route"] = route
        _save(path, payload)
        _route_cache[str(path)] = route
    return route


def _outside_time(value: dict) -> datetime:
    at = datetime.fromisoformat(value["at"].replace("Z", "+00:00"))
    if at.tzinfo is None:
        raise ValueError("outside time needs timezone")
    return at.astimezone(UTC)


def read_outside(path: Path) -> dict | None:
    key = str(path)
    with _write_lock:
        if key not in _outside_cache:
            value = _read_raw(path).get("outside")
            try:
                at = _outside_time(value)
                value = {"at": at.isoformat().replace("+00:00", "Z"), "via": value["via"]}
                if value["via"] not in ("vpn", "tailscale", "proxy"):
                    value = None
            except (ValueError, TypeError, KeyError, AttributeError):
                value = None
            _outside_cache[key] = value
        value = _outside_cache[key]
        return dict(value) if value else None


def record_outside(path: Path, visit: dict) -> None:
    """Update memory monotonically; flush at most every 5 min, preserving other keys."""
    key = str(path)
    with _write_lock:
        previous = read_outside(path)
        if previous and _outside_time(previous) >= _outside_time(visit):
            return
        _outside_cache[key] = dict(visit)
        now = time.monotonic()
        if key in _outside_flushed and now - _outside_flushed[key] < 300:
            return
        # Throttle failures too. Memory remains useful on a read-only filesystem.
        _outside_flushed[key] = now
        read_or_create_instance_id(path)
        payload = _read_raw(path)
        persisted = payload.get("outside")
        if persisted and _outside_time(persisted) >= _outside_time(visit):
            _outside_cache[key] = persisted
            return
        payload["outside"] = dict(visit)
        _save(path, payload)


__all__ = [
    "INSTANCE_FILE_VERSION",
    "NEST_NAME_MAX_LENGTH",
    "InvalidNestNameError",
    "clean_nest_name",
    "default_name",
    "get_name",
    "read_name",
    "read_remote_route",
    "read_outside",
    "record_outside",
    "read_external_url",
    "read_or_create_instance_id",
    "read_setup_done",
    "set_external_url",
    "set_name",
    "set_remote_route",
    "set_setup_done",
]
