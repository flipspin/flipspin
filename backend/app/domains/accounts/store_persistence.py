"""Account-file persistence, indexes and read-only directory queries.

Rebuild both indexes before persisting mutations.
Keep account-file locking reentrant across nested operations.
See docs/security.md#account-storage.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

from app.domains.accounts.file_lock import AccountFileLock
from app.domains.accounts.records import (
    SCHEMA_VERSION,
    UserRecord,
    normalize_username,
)
from app.domains.accounts.store_format import _parse_row
from app.infra.files import PRIVATE
from app.infra.migrations import read_json_store, refuse, validate_claim, write_json_store

logger = logging.getLogger("app.domains.accounts.identity")


class AccountPersistence:
    def __init__(self, path: Path, logger_: logging.Logger | None = None, *, instance_path: Path | None = None):
        self.path = Path(path)
        self.instance_path = Path(instance_path) if instance_path is not None else self.path.parent / "instance.json"
        self._ever_existed = self.path.exists()
        self.logger = logger_ or logger
        self._lock = AccountFileLock(self.path)
        self._file_signature: tuple[int, int, int] | None = None
        # user_id -> account, in file order (dicts preserve insertion order).
        self._accounts_by_id: dict[str, UserRecord] | None = None
        # token digest -> (user_id, device_id). Flat over every device in the
        # table so resolution stays one dict probe; see
        # docs/security.md#device-tokens.
        self._by_digest: dict[str, tuple[str, str]] = {}
        # normalized username -> user_id. Flat and case-insensitive, for the
        # same reason as the digest index: a sign-in is one dict probe, so it
        # costs the same whether the name exists or not.
        self._by_username: dict[str, str] = {}
        # device_id -> monotonic timestamp of the last last_seen_at flush.
        self._last_flush: dict[str, float] = {}

    def _accounts(self) -> dict[str, UserRecord]:
        """The table, loaded on first use. Callers must hold the lock."""
        signature = self._signature()
        if self._accounts_by_id is None or signature != self._file_signature:
            self._accounts_by_id = self._load()
            self._file_signature = signature
            self._last_flush.clear()
            self._reindex()
        return self._accounts_by_id

    def _signature(self) -> tuple[int, int, int] | None:
        try:
            stat = self.path.stat()
            return stat.st_ino, stat.st_mtime_ns, stat.st_size
        except FileNotFoundError:
            return None

    def reload(self) -> None:
        """Drop the in-memory copy so the next call re-reads the file."""
        with self._lock:
            self._accounts_by_id = None
            self._by_digest = {}
            self._by_username = {}
            self._last_flush.clear()

    def list_users(self) -> list[UserRecord]:
        """Every account in creation order. Never includes plaintext tokens."""
        with self._lock:
            return list(self._accounts().values())

    def get_user(self, user_id: str) -> UserRecord | None:
        """One account by id, or ``None``. The read behind every ``/api/me`` route."""
        with self._lock:
            return self._accounts().get(user_id)

    def has_users(self) -> bool:
        with self._lock:
            return bool(self._accounts())

    def has_password_sign_in(self) -> bool:
        """Whether *anybody* here could sign in with a password."""
        with self._lock:
            return any(a.can_sign_in_with_password for a in self._accounts().values())

    def find_by_username(self, username: str) -> UserRecord | None:
        """One account by username, case-insensitively, or ``None``."""
        with self._lock:
            accounts = self._accounts()
            user_id = self._by_username.get(normalize_username(username))
            return accounts.get(user_id) if user_id else None

    def _fresh_id(self, accounts: dict[str, UserRecord]) -> str:
        """A 12-hex id no account or device in the table is already using."""
        taken = set(accounts)
        for account in accounts.values():
            taken.update(d.device_id for d in account.devices)
        while True:
            candidate = uuid.uuid4().hex[:12]
            if candidate not in taken:
                return candidate

    def _commit(self, accounts: dict[str, UserRecord]) -> None:
        """Rebuild the digest index and persist. Caller holds the lock."""
        self._reindex()
        self._save(accounts)

    def _reindex(self) -> None:
        """digest -> (user_id, device_id), and username -> user_id. Lock held."""
        index: dict[str, tuple[str, str]] = {}
        by_username: dict[str, str] = {}
        for account in (self._accounts_by_id or {}).values():
            if account.username:
                key = normalize_username(account.username)
                if key in by_username:
                    # Only reachable from a hand-edited file. First one wins so
                    # the answer is stable across restarts, and it is said out
                    # loud because the other account silently loses the ability
                    # to sign in under a name it appears to hold.
                    self.logger.warning(
                        "Duplicate username %r in %s; ignoring the copy on user %s",
                        account.username,
                        self.path,
                        account.user_id,
                    )
                else:
                    by_username[key] = account.user_id
            for device in account.devices:
                if device.token_sha256 in index:
                    # Two rows carrying the same digest can only come from a
                    # hand-edited or duplicated file. First one wins so the
                    # answer is at least stable across restarts, and it is said
                    # out loud because the other account silently loses a
                    # credential it appears to still have.
                    self.logger.warning(
                        "Duplicate token digest in %s; ignoring the copy on user %s",
                        self.path,
                        account.user_id,
                    )
                    continue
                index[device.token_sha256] = (account.user_id, device.device_id)
        self._by_digest = index
        self._by_username = by_username

    def _load(self) -> dict[str, UserRecord]:
        validate_claim(self.path, self.instance_path)
        raw = read_json_store(self.path, SCHEMA_VERSION, rows="users")
        if raw is None:
            if self._ever_existed:
                refuse("users", 0, SCHEMA_VERSION, "read", "previously existing users.json is missing")
            return {}
        self._ever_existed = True
        rows = raw["users"]
        out: dict[str, UserRecord] = {}
        for row in rows:
            record = _parse_row(row)
            if record is None:
                refuse("users", raw.get("version", 0), SCHEMA_VERSION, "read", "malformed user row")
            if record.user_id in out:
                refuse("users", raw.get("version", 0), SCHEMA_VERSION, "read", "duplicate user id")
            out[record.user_id] = record
        return out

    def _save(self, accounts: dict[str, UserRecord]) -> None:
        """Atomic, owner-only write. Caller holds the lock."""
        # Omit unset credentials so device-only account files retain their shape.
        payload = {
            "version": SCHEMA_VERSION,
            "users": [
                {
                    "id": r.user_id,
                    "label": r.label,
                    "role": r.role,
                    "created_at": r.created_at,
                    "onboarded": r.onboarded,
                    **({"username": r.username} if r.username else {}),
                    **({"password_hash": r.password_hash} if r.password_hash else {}),
                    "devices": [
                        {
                            "id": d.device_id,
                            "label": d.label,
                            "token_sha256": d.token_sha256,
                            "created_at": d.created_at,
                            "last_seen_at": d.last_seen_at,
                            "helper": d.helper,
                            "credential_type": d.credential_type,
                            "first_subsonic_request_at": d.first_subsonic_request_at,
                            "last_subsonic_request_at": d.last_subsonic_request_at,
                            "subsonic_client_name": d.subsonic_client_name,
                            "last_subsonic_failure_at": d.last_subsonic_failure_at,
                            "last_subsonic_failure": d.last_subsonic_failure,
                        }
                        for d in r.devices
                    ],
                }
                for r in accounts.values()
            ],
        }
        write_json_store(self.path, payload, SCHEMA_VERSION, mode=PRIVATE, sort_keys=True)
        self._ever_existed = True
        if self.instance_path.exists():
            validate_claim(self.path, self.instance_path, record=True)
        self._file_signature = self._signature()
