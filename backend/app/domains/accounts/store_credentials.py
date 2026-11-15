"""Account usernames, password changes and password authentication.

Always derive on failed lookup and keep derivation outside the store lock.
Re-read credentials before committing a change or minting a device.
See docs/security.md#password-hashing.
"""

from __future__ import annotations

import logging
from dataclasses import replace

from app.domains.accounts import passwords
from app.domains.accounts.records import (
    _BAD_CREDENTIALS,
    DeviceRecord,
    InvalidCredentialsError,
    UnknownUserError,
    UsernameRequiredError,
    UsernameTakenError,
    UserRecord,
    WeakPasswordError,
    clean_username,
    normalize_username,
)
from app.domains.accounts.store_devices import DeviceStore

logger = logging.getLogger("app.domains.accounts.identity")


class CredentialStore(DeviceStore):
    def set_username(self, user_id: str, username: str) -> UserRecord:
        """Give an account the name it signs in with, or change it."""
        clean = clean_username(username)
        key = normalize_username(clean)
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            holder = self._by_username.get(key)
            if holder is not None and holder != user_id:
                raise UsernameTakenError(f"The username '{clean}' is taken.")
            accounts[user_id] = replace(account, username=clean)
            self._commit(accounts)
            return accounts[user_id]

    def set_password(
        self,
        user_id: str,
        new_password: str,
        current_password: str | None = None,
    ) -> UserRecord:
        """Set or change the account's password. Returns the account after."""
        try:
            normalized = passwords.validate_password(new_password)
        except passwords.PasswordPolicyError as e:
            raise WeakPasswordError(str(e)) from e

        with self._lock:
            account = self._accounts().get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            if not account.username:
                raise UsernameRequiredError(
                    "Choose a username before setting a password; a password with no username has no way to sign in."
                )
            stored = account.password_hash

        if stored is not None and not passwords.verify_password(current_password, stored):
            raise InvalidCredentialsError("The current password is not correct.")

        fresh = passwords.hash_password(normalized)

        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            if account.password_hash != stored:
                # Another password change invalidated the value checked before hashing.
                raise InvalidCredentialsError("The current password is not correct.")
            accounts[user_id] = replace(account, password_hash=fresh)
            self._commit(accounts)
            return accounts[user_id]

    def reset_password(self, user_id: str, new_password: str) -> UserRecord:
        """Server/operator recovery. Authorization belongs to the CLI or owner route."""
        try:
            fresh = passwords.hash_password(passwords.validate_password(new_password))
        except passwords.PasswordPolicyError as e:
            raise WeakPasswordError(str(e)) from e
        with self._lock:
            accounts = self._accounts()
            account = accounts.get(user_id)
            if account is None:
                raise UnknownUserError(f"Unknown user '{user_id}'")
            if not account.username:
                raise UsernameRequiredError("Choose a username before resetting a password.")
            accounts[user_id] = replace(account, password_hash=fresh)
            self._commit(accounts)
            return accounts[user_id]

    def user_by_username(self, username: str) -> UserRecord:
        """Operator lookup; never exposed as a public username probe."""
        with self._lock:
            accounts = self._accounts()
            user_id = self._by_username.get(normalize_username(username))
            if user_id is None:
                raise UnknownUserError("Unknown username.")
            return accounts[user_id]

    def authenticate(
        self, username: str | None, password: str | None, device_label: str
    ) -> tuple[UserRecord, DeviceRecord, str]:
        """Sign in and mint a device token. ``POST /api/login``, in one method."""
        key = normalize_username(username)
        with self._lock:
            accounts = self._accounts()
            user_id = self._by_username.get(key) if key else None
            account = accounts.get(user_id) if user_id else None
            stored = account.password_hash if account else None

        # Unconditional, and unconditionally outside the lock. `stored` is
        # None for "no such username" — the derivation still happens, so the
        # miss and the hit take the same time on the wire.
        matched = passwords.verify_password(password, stored)
        if not matched or account is None or stored is None:
            raise InvalidCredentialsError(_BAD_CREDENTIALS)
        upgraded = passwords.hash_password(password) if passwords.needs_rehash(stored) else None

        with self._lock:
            accounts = self._accounts()
            current = accounts.get(account.user_id)
            if current is None or current.password_hash != stored:
                raise InvalidCredentialsError(_BAD_CREDENTIALS)
            if upgraded is not None:
                # Lands in the same file write as the new device below: the
                # dict returned by _accounts() is the live one add_device reads.
                accounts[account.user_id] = replace(current, password_hash=upgraded)
                logger.info(
                    "Rewrote the stored password of %s at the current cost parameters",
                    account.user_id,
                )
            return self.add_device(account.user_id, device_label)
