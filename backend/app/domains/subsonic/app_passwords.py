"""Keep a recoverable encrypted app password for Subsonic salted-token checks.

Each password is also a revocable account device. Recoverable storage is needed
for md5(secret + salt); ordinary device tokens retain only digests. Account
passwords are refused on /rest/ because their KDF is too costly per media request.
"""
from __future__ import annotations

import secrets
import threading

from app.infra.security import CredentialsRepository

#: Lowercase without look-alikes (no 0/o, 1/l/i), 16 characters: 80 random bits,
#: typeable on a phone keyboard.
ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_KEY = "subsonic-app-passwords"


def generate() -> str:
    raw = "".join(secrets.choice(ALPHABET) for _ in range(16))
    return "-".join(raw[i:i + 4] for i in range(0, 16, 4))


class AppPasswordVault:
    """``device_id → plaintext``, encrypted at rest, cached in memory."""

    def __init__(self, credentials: CredentialsRepository):
        self._credentials = credentials
        self._lock = threading.Lock()
        self._cache: dict[str, str] | None = None

    def uses(self, credentials: CredentialsRepository) -> bool:
        """Whether this vault reads and writes through ``credentials``."""
        return self._credentials is credentials

    def _all(self) -> dict[str, str]:
        if self._cache is None:
            self._cache = dict(self._credentials.load_credentials(_KEY) or {})
        return self._cache

    def remember(self, device_id: str, password: str) -> None:
        with self._lock:
            secrets_by_device = self._all()
            secrets_by_device[device_id] = password
            self._credentials.save_credentials(_KEY, secrets_by_device)

    def for_devices(self, device_ids: list[str]) -> list[str]:
        """The app passwords of these devices; devices without one are skipped."""
        with self._lock:
            stored = self._all()
            return [stored[d] for d in device_ids if d in stored]

    def forget(self, device_ids: set[str]) -> None:
        """Delete revoked devices' copies without touching concurrent new devices."""
        with self._lock:
            stored = self._all()
            if device_ids.intersection(stored):
                for device_id in device_ids:
                    stored.pop(device_id, None)
                self._credentials.save_credentials(_KEY, stored)

    def forget_missing(self, live_device_ids: set[str]) -> None:
        """Drop copies whose device was revoked. Called at startup."""
        with self._lock:
            stored = self._all()
            stale = [d for d in stored if d not in live_device_ids]
            if stale:
                for d in stale:
                    del stored[d]
                self._credentials.save_credentials(_KEY, stored)
