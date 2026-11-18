"""Read supported account and device row formats.

Legacy device ids and credentials survive migration.
An invalid optional username must not discard an account.
See docs/security.md#account-storage.
"""

from __future__ import annotations

import logging

from app.domains.accounts.records import (
    DeviceRecord,
    InvalidUsernameError,
    UserRecord,
    clean_username,
    normalize_role,
)
from app.domains.accounts.records import _utc_now_iso as utc_now_iso

logger = logging.getLogger("app.domains.accounts.identity")


def _parse_device(row: object, fallback_id: str) -> DeviceRecord | None:
    """One device, or ``None`` if it is unusable. Tolerant like the provider store."""
    if not isinstance(row, dict):
        return None
    digest = row.get("token_sha256")
    if not isinstance(digest, str) or not digest:
        return None  # a device without a credential authenticates nobody
    device_id = row.get("id")
    label = row.get("label")
    created = row.get("created_at")
    last_seen = row.get("last_seen_at")
    return DeviceRecord(
        device_id=device_id if isinstance(device_id, str) and device_id else fallback_id,
        label=label if isinstance(label, str) and label else "device",
        token_sha256=digest,
        created_at=created if isinstance(created, str) and created else utc_now_iso(),
        last_seen_at=last_seen if isinstance(last_seen, str) and last_seen else None,
        helper=row.get("helper") is True,
        credential_type=row.get("credential_type")
        if row.get("credential_type") in ("app-password", "api-key")
        else None,
        last_subsonic_failure="wrong-mechanism" if row.get("last_subsonic_failure") == "wrong-mechanism" else None,
        first_subsonic_request_at=row.get("first_subsonic_request_at")
        if isinstance(row.get("first_subsonic_request_at"), str)
        else None,
        last_subsonic_request_at=row.get("last_subsonic_request_at")
        if isinstance(row.get("last_subsonic_request_at"), str)
        else None,
        subsonic_client_name=row.get("subsonic_client_name")
        if isinstance(row.get("subsonic_client_name"), str)
        else None,
        last_subsonic_failure_at=row.get("last_subsonic_failure_at")
        if isinstance(row.get("last_subsonic_failure_at"), str)
        else None,
    )


def _parse_row(row: object) -> UserRecord | None:
    """One account, or ``None`` if it is unusable."""
    if not isinstance(row, dict):
        return None
    user_id = row.get("id")
    if not isinstance(user_id, str) or not user_id:
        return None
    label = row.get("label")
    created = row.get("created_at")

    raw_devices = row.get("devices")
    devices: list[DeviceRecord] = []
    if isinstance(raw_devices, list):
        for index, entry in enumerate(raw_devices):
            # The fallback id keeps a device that lost its own id addressable and
            # distinct from its siblings; ids are 12 hex chars, so "<user>-1"
            # cannot collide with a generated one.
            device = _parse_device(entry, f"{user_id}-{index}" if index else user_id)
            if device is not None:
                devices.append(device)
    elif isinstance(row.get("token_sha256"), str) and row.get("token_sha256"):
        # ---- version 1: the token was the person. One device, the account's id.
        devices.append(
            _parse_device(
                {
                    "id": user_id,
                    "label": label if isinstance(label, str) and label else user_id,
                    "token_sha256": row.get("token_sha256"),
                    "created_at": created,
                    "last_seen_at": row.get("last_seen_at"),
                },
                user_id,
            )
        )

    if not devices:
        return None

    # v2 -> v3: both keys are simply absent on every account written before
    # password sign-in existed, and absent has to keep meaning "never set". A
    # username that does not clear the current rules is dropped rather than
    # rejected — the account keeps its devices and its data and merely has no
    # name to sign in with, which is recoverable from the app; refusing to load
    # the row would take the account's library away over a cosmetic field.
    raw_username = row.get("username")
    username = None
    if isinstance(raw_username, str) and raw_username.strip():
        try:
            username = clean_username(raw_username)
        except InvalidUsernameError:
            logger.warning(
                "Dropping an unusable username on user %s; it can be set again from the app",
                user_id,
            )
    raw_hash = row.get("password_hash")

    return UserRecord(
        user_id=user_id,
        label=label if isinstance(label, str) and label else user_id,
        role=normalize_role(row.get("role")),
        created_at=created if isinstance(created, str) and created else utc_now_iso(),
        devices=tuple(devices),
        username=username,
        password_hash=raw_hash if isinstance(raw_hash, str) and raw_hash else None,
        onboarded=row.get("onboarded") is True,
    )
