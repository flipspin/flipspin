"""Device credentials, token resolution and attributed activity.

Resolve by one digest-index probe and revoke only the named account device.
Activity timestamps must not invalidate authentication on a write failure.
See docs/security.md#device-tokens.
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import replace
from typing import Literal

from app.domains.accounts.records import (
    LAST_SEEN_FLUSH_SECONDS,
    TOKEN_BYTES,
    DeviceRecord,
    LastDeviceError,
    UnknownDeviceError,
    UnknownUserError,
    UserRecord,
    _clean_label,
    clean_device_label,
    hash_token,
)
from app.domains.accounts.records import _utc_now_iso as utc_now_iso
from app.domains.accounts.store_persistence import AccountPersistence
from app.infra.identity import (
    Principal,
)

logger = logging.getLogger("app.domains.accounts.identity")


class DeviceStore(AccountPersistence):
    def resolve(self, token: str | None, *, touch: bool = True) -> Principal | None:
        """Resolve a recognized device token to its principal; return None for unknown tokens."""
        if not token:
            return None
        digest = hash_token(token)
        with self._lock:
            accounts = self._accounts()
            located = self._by_digest.get(digest)
            if located is None:
                return None
            user_id, device_id = located
            account = accounts.get(user_id)
            if account is None:  # index and table disagree; treat as a miss
                return None
            device = account.device(device_id)
            if device is None:
                return None
            if touch:
                self._touch(account, device)
            return account.principal(device_id)

    def record_subsonic(
        self, principal: Principal, client: str | None, *, failure: Literal["wrong-mechanism"] | None = None
    ) -> None:
        """Only attributed requests update a row. Failures never count as use."""
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(principal.user_id)
            device = account.device(principal.device_id) if account else None
            if device is None:
                return  # revoked between authentication and dispatch
            stamp = utc_now_iso()
            now = time.monotonic()
            due = now - self._last_flush.get(device.device_id, -LAST_SEEN_FLUSH_SECONDS) >= LAST_SEEN_FLUSH_SECONDS
            if failure:
                seen = replace(device, last_subsonic_failure=failure, last_subsonic_failure_at=stamp)
                persist = device.last_subsonic_failure != failure or due
            else:
                name = (client or "").strip()[:200] or None
                seen = replace(
                    device,
                    first_subsonic_request_at=device.first_subsonic_request_at or stamp,
                    last_subsonic_request_at=stamp,
                    last_seen_at=stamp,
                    subsonic_client_name=name or device.subsonic_client_name,
                )
                persist = (
                    due
                    or not device.first_subsonic_request_at
                    or seen.subsonic_client_name != device.subsonic_client_name
                )
            accounts[account.user_id] = replace(
                account, devices=tuple(seen if d.device_id == device.device_id else d for d in account.devices)
            )
            if persist:
                self._last_flush[device.device_id] = now
                try:
                    self._save(accounts)
                except OSError as error:
                    self.logger.warning("Could not persist Subsonic activity for %s: %s", device.device_id, error)

    def add_device(
        self,
        user_id: str,
        label: str,
        token: str | None = None,
        *,
        helper: bool | None = None,
        credential_type: Literal["app-password", "api-key"] | None = None,
    ) -> tuple[UserRecord, DeviceRecord, str]:
        """Give an existing account another credential. The feature, in one method."""
        clean_label = _clean_label(label, "device")
        token = token or secrets.token_urlsafe(TOKEN_BYTES)
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            device = DeviceRecord(
                device_id=self._fresh_id(accounts),
                label=clean_label,
                token_sha256=hash_token(token),
                created_at=utc_now_iso(),
                last_seen_at=None,
                helper=helper is True,
                credential_type=credential_type,
            )
            updated = replace(account, devices=account.devices + (device,))
            accounts[user_id] = updated
            self._commit(accounts)
        return updated, device, token

    def rename_device(self, user_id: str, device_id: str, label: str) -> DeviceRecord:
        """Rename only a device of this account, preserving its credential."""
        clean = clean_device_label(label)
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            device = account.device(device_id)
            if device is None:
                raise UnknownDeviceError(f"Unknown device '{device_id}'")
            renamed = replace(device, label=clean)
            accounts[user_id] = replace(
                account,
                devices=tuple(renamed if d.device_id == device_id else d for d in account.devices),
            )
            self._commit(accounts)
            return renamed

    def revoke_device(self, user_id: str, device_id: str) -> tuple[UserRecord, DeviceRecord]:
        """Sign one machine out of one account. Refuses to remove the last one."""
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            device = account.device(device_id)
            if device is None:
                raise UnknownDeviceError(f"Unknown device '{device_id}'")
            if len(account.devices) <= 1:
                raise LastDeviceError(
                    "This is the only device on this account; removing it would leave "
                    "no way to sign in again. Add another device first, or ask an owner "
                    "to remove the account entirely."
                )
            remaining = tuple(d for d in account.devices if d.device_id != device_id)
            updated = replace(account, devices=remaining)
            accounts[user_id] = updated
            self._last_flush.pop(device_id, None)
            self._commit(accounts)
            return updated, device

    def _touch(self, account: UserRecord, device: DeviceRecord) -> None:
        """Record that this device was just used. Caller holds the lock."""
        now = time.monotonic()
        last = self._last_flush.get(device.device_id)
        if last is not None and (now - last) < LAST_SEEN_FLUSH_SECONDS:
            return
        self._last_flush[device.device_id] = now
        accounts = self._accounts()
        seen = replace(device, last_seen_at=utc_now_iso())
        accounts[account.user_id] = replace(
            account,
            devices=tuple(seen if d.device_id == device.device_id else d for d in account.devices),
        )
        try:
            # No _commit: the digests did not move, so re-indexing would be work
            # for nothing on the hottest path in this file.
            self._save(accounts)
        except OSError as e:
            # A read-only disk must not turn every authenticated request into a
            # 500; last_seen_at is cosmetic.
            self.logger.warning("Could not persist last_seen_at for %s: %s", account.user_id, e)
