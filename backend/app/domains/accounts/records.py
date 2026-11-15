"""Account records, token digests, validation and identity errors.

Device credentials belong to one account; public views exclude secrets.
Username matching stays ASCII-only and case-insensitive.
See docs/security.md#device-tokens.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from app.infra.identity import (
    ROLE_MEMBER,
    ROLE_OWNER,
    Principal,
)

#: Bytes of entropy behind a minted token. 32 bytes -> a 43-char urlsafe string.
TOKEN_BYTES = 32

#: Persist v3 rows; supported older shapes retain existing device credentials.
SCHEMA_VERSION = 3

#: Account-name bounds, measured in ASCII characters.
USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 32

#: Match only ASCII identifiers; see docs/security.md#usernames.
_USERNAME_RE = re.compile(rf"\A[a-z0-9][a-z0-9._-]{{{USERNAME_MIN_LENGTH - 1},{USERNAME_MAX_LENGTH - 1}}}\Z")

#: How often a device's ``last_seen_at`` is flushed to disk. Persisting it on
#: every request would turn a media scrub into a few hundred file writes; the
#: field is a convenience for the settings panel, not an audit trail.
LAST_SEEN_FLUSH_SECONDS = 300


class IdentityError(Exception):
    """Base for token-table problems the API turns into 4xx."""


class UnknownUserError(IdentityError):
    """No user with that id."""


class UnknownDeviceError(IdentityError):
    """No device with that id on this account."""


class InvalidUsernameError(IdentityError):
    """The proposed username is not in the allowed set. See docs/security.md#usernames."""


class UsernameTakenError(IdentityError):
    """An account already has that username, ignoring case."""


class UsernameRequiredError(IdentityError):
    """A password was set on an account that has no username yet."""


class WeakPasswordError(IdentityError):
    """The proposed password does not clear ``passwords.MIN_PASSWORD_LENGTH``."""


class InvalidCredentialsError(IdentityError):
    """The username, the password, or the current password did not match."""


class AlreadyInitializedError(IdentityError):
    """The first-run claim was attempted on a server that already has users."""


class LastOwnerError(IdentityError):
    """Revoking this user would leave nobody who can manage tokens."""


class LastDeviceError(IdentityError):
    """Revoking this device would leave its account with no way back in."""


@dataclass(frozen=True)
class DeviceRecord:
    """One credential of one account. ``token_sha256`` never leaves the backend."""

    device_id: str
    label: str
    token_sha256: str
    created_at: str
    last_seen_at: str | None = None
    helper: bool = False  # processing credential; never inferred from a claim body

    credential_type: Literal["app-password", "api-key"] | None = None
    first_subsonic_request_at: str | None = None
    last_subsonic_request_at: str | None = None
    subsonic_client_name: str | None = None
    last_subsonic_failure_at: str | None = None
    last_subsonic_failure: Literal["wrong-mechanism"] | None = None

    def public(self) -> dict:
        """The device as its owner sees it — metadata only, no digest."""
        return {
            "id": self.device_id,
            "label": self.label,
            "createdAt": self.created_at,
            "lastSeenAt": self.last_seen_at,
            "credentialType": self.credential_type,
            "firstSubsonicRequestAt": self.first_subsonic_request_at,
            "lastSubsonicRequestAt": self.last_subsonic_request_at,
            "subsonicClientName": self.subsonic_client_name,
            "lastSubsonicFailureAt": self.last_subsonic_failure_at,
            "lastSubsonicFailure": self.last_subsonic_failure,
        }


@dataclass(frozen=True)
class UserRecord:
    """One person. Holds no *token* digest of its own — its devices do."""

    user_id: str
    label: str
    role: str
    created_at: str
    devices: tuple[DeviceRecord, ...] = ()
    username: str | None = None
    password_hash: str | None = None
    onboarded: bool = False

    @property
    def can_sign_in_with_password(self) -> bool:
        """Whether ``POST /api/login`` could ever work for this account."""
        return bool(self.username) and bool(self.password_hash)

    @property
    def last_seen_at(self) -> str | None:
        """The most recent ``last_seen_at`` across this account's devices."""
        seen = [d.last_seen_at for d in self.devices if d.last_seen_at]
        return max(seen) if seen else None

    def device(self, device_id: str) -> DeviceRecord | None:
        return next((d for d in self.devices if d.device_id == device_id), None)

    def principal(self, device_id: str | None = None) -> Principal:
        return Principal(user_id=self.user_id, label=self.label, role=self.role, device_id=device_id)

    def public(self) -> dict:
        """The row as the settings panel sees it — metadata only, no digest."""
        return {
            "id": self.user_id,
            "label": self.label,
            "role": self.role,
            "createdAt": self.created_at,
            "lastSeenAt": self.last_seen_at,
        }


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_role(role: str | None) -> str:
    """Anything that is not ``owner`` is a member. Unknown roles must not widen."""
    value = (role or "").strip().lower()
    return ROLE_OWNER if value == ROLE_OWNER else ROLE_MEMBER


def normalize_username(username: str | None) -> str:
    """The matching key for a username: stripped and lower-cased."""
    return (username or "").strip().lower()


def clean_username(username: str | None) -> str:
    """The username as it will be stored, or raise :class:`InvalidUsernameError`."""
    typed = (username or "").strip()
    if not _USERNAME_RE.fullmatch(normalize_username(typed)):
        raise InvalidUsernameError(
            f"A username is {USERNAME_MIN_LENGTH}-{USERNAME_MAX_LENGTH} characters of "
            "letters, digits, dots, underscores or hyphens, starting with a letter or a "
            "digit. Upper and lower case are the same name."
        )
    return typed


#: The single sentence every failed sign-in gets, whatever went wrong. One
#: constant rather than three call sites so that nobody can "improve" one of them
#: into "no such user" without noticing that they are writing an oracle.
_BAD_CREDENTIALS = "That username and password do not match an account here."


def _clean_label(label: str, what: str) -> str:
    clean = (label or "").strip()
    if not clean:
        raise IdentityError(f"A {what} needs a label.")
    return clean


def clean_device_label(label: str) -> str:
    """Display-only rename: reject control characters even around the name."""
    if not isinstance(label, str) or any(unicodedata.category(c) == "Cc" for c in label):
        raise IdentityError("A device label cannot contain control characters.")
    clean = _clean_label(label, "device")
    if len(clean) > 80:
        raise IdentityError("A device label must be 1–80 characters.")
    return clean


def _utc_now_iso() -> str:
    """Honor clock overrides made through the original identity import path."""
    from app.domains.accounts import identity

    return identity.utc_now_iso()
