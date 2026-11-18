"""Account creation, profile changes, first claim and account revocation.

Claim checks and creation share one lock; the last owner remains protected.
Device operations and credential changes use the same persisted directory.
See docs/security.md#owner-and-member-roles.
"""

from __future__ import annotations

import secrets
from dataclasses import replace

from app.domains.accounts import passwords
from app.domains.accounts.records import (
    TOKEN_BYTES,
    AlreadyInitializedError,
    DeviceRecord,
    IdentityError,
    LastOwnerError,
    UnknownUserError,
    UsernameTakenError,
    UserRecord,
    WeakPasswordError,
    _clean_label,
    clean_username,
    hash_token,
    normalize_role,
    normalize_username,
)
from app.domains.accounts.records import _utc_now_iso as utc_now_iso
from app.domains.accounts.store_credentials import CredentialStore
from app.infra.identity import (
    ROLE_MEMBER,
    ROLE_OWNER,
)


class TokenStore(CredentialStore):
    def mint(
        self,
        label: str,
        role: str = ROLE_MEMBER,
        username: str | None = None,
        password_hash: str | None = None,
    ) -> tuple[UserRecord, str]:
        """Create an account with its first device; return ``(account, token)``."""
        clean_label = _clean_label(label, "user")
        token = secrets.token_urlsafe(TOKEN_BYTES)
        now = utc_now_iso()
        with self._lock:
            accounts = self._accounts()
            user_id = self._fresh_id(accounts)
            account = UserRecord(
                user_id=user_id,
                label=clean_label,
                role=normalize_role(role),
                created_at=now,
                devices=(
                    DeviceRecord(
                        device_id=self._fresh_id(accounts),
                        label=clean_label,
                        token_sha256=hash_token(token),
                        created_at=now,
                        last_seen_at=None,
                    ),
                ),
                username=clean_username(username) if username else None,
                password_hash=password_hash or None,
            )
            if account.username and normalize_username(account.username) in self._by_username:
                raise UsernameTakenError(f"The username '{account.username}' is taken.")
            accounts[user_id] = account
            self._commit(accounts)
        return account, token

    def set_label(self, user_id: str, label: str) -> UserRecord:
        """Rename the account display label without changing its sign-in name."""
        clean_label = _clean_label(label, "user")
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            accounts[user_id] = replace(account, label=clean_label)
            self._commit(accounts)
            return accounts[user_id]

    def complete_onboarding(self, user_id: str) -> None:
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            accounts[user_id] = replace(account, onboarded=True)
            self._commit(accounts)

    def claim_first_owner(
        self,
        label: str,
        username: str | None = None,
        password: str | None = None,
    ) -> tuple[UserRecord, str]:
        """Create the first owner, or refuse because an account exists."""
        password_hash = None
        if username or password:
            if not (username and password):
                raise IdentityError("A username and a password have to be set together, or neither.")
            clean_username(username)  # fail before hashing, not after
            try:
                password_hash = passwords.hash_password(passwords.validate_password(password))
            except passwords.PasswordPolicyError as e:
                raise WeakPasswordError(str(e)) from e
        with self._lock:
            if self._accounts():
                raise AlreadyInitializedError(
                    "This server already has at least one user; the first-run claim is closed."
                )
            return self.mint(label, ROLE_OWNER, username=username, password_hash=password_hash)

    def revoke(self, user_id: str) -> UserRecord:
        """Delete a person and every device they hold. Refuses the last owner."""
        with self._lock:
            accounts = self._accounts()
            match = accounts.get(user_id)
            if match is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            if match.role == ROLE_OWNER:
                owners = [r for r in accounts.values() if r.role == ROLE_OWNER]
                if len(owners) <= 1:
                    raise LastOwnerError(
                        "This is the last owner token; revoking it would leave nobody "
                        "who can manage access. Mint another owner first."
                    )
            del accounts[user_id]
            for device in match.devices:
                self._last_flush.pop(device.device_id, None)
            self._commit(accounts)
            return match
