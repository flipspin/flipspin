"""Short-lived, process-local device authorization.

Store only the polling-secret digest and mint at most once on redemption.
Approval requires an account; restart cancels pending codes.
See docs/security.md#sign-in-codes.
"""
from __future__ import annotations

import secrets
import time
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import RLock

from app.infra.changes import Changes
from app.domains.accounts.identity import TokenStore, UnknownUserError, hash_token, normalize_username

ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_LENGTH = 6
EXPIRES_SECONDS = 600
POLL_SECONDS = 2


class CodeRateLimit(Exception):
    pass


class InvalidCode(Exception):
    pass


class DeclinedCode(Exception):
    pass


def normalize_code(code: str) -> str:
    return code.strip().upper().replace("-", "").replace(" ", "")


@dataclass
class PendingCode:
    code: str
    label: str
    deadline: float
    id: str
    username: str
    target_id: str | None
    network: str
    created_at: float
    account_id: str | None = None
    declined: bool = False
    last_poll: float = float("-inf")

    @property
    def waiting(self) -> bool:
        return self.account_id is None and not self.declined

    def public(self) -> dict:
        def iso(at: float) -> str:
            return datetime.fromtimestamp(at, UTC).isoformat().replace("+00:00", "Z")

        return {"id": self.id, "deviceLabel": self.label, "network": self.network,
                "createdAt": iso(self.created_at), "expiresAt": iso(self.created_at + EXPIRES_SECONDS),
                "code": self.code}


class SignInCodes:
    def __init__(self, store: TokenStore, clock: Callable[[], float] = time.monotonic, *, changes: Changes | None = None):
        self.changes = changes or Changes()
        self.store = store
        self.clock = clock
        self._lock = RLock()
        self._pending: dict[str, PendingCode] = {}
        self._attempts: dict[str, deque[float]] = defaultdict(deque)

    def expiry_revision(self):
        with self._lock:
            return tuple(row.id for row in self._pending.values() if row.deadline > self.clock() and row.waiting)

    def _limit(self, action: str, count: int) -> None:
        now = self.clock()
        attempts = self._attempts[action]
        while attempts and attempts[0] <= now - 60:
            attempts.popleft()
        if len(attempts) >= count:
            raise CodeRateLimit
        attempts.append(now)

    def _prune(self) -> None:
        now = self.clock()
        live = {key: row for key, row in self._pending.items() if row.deadline > now}
        if len(live) != len(self._pending):
            self._pending = live
            self.changes.bump('signin')

    def request(self, label: str, username: str | None = None, network: str = "local") -> dict:
        with self._lock:
            self._limit("request", 20)
            self._prune()
            username = normalize_username(username)
            siblings = [(key, row) for key, row in self._pending.items()
                        if username and row.username == username and row.waiting]
            if len(siblings) >= 3:
                # Dict insertion order also breaks ties when clocks are equal.
                del self._pending[siblings[0][0]]
            # Bound memory even if someone requests codes for the whole TTL.
            if len(self._pending) >= 100:
                raise CodeRateLimit
            taken = {row.code for row in self._pending.values()}
            while True:
                code = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))
                if code not in taken:
                    break
            secret = secrets.token_urlsafe(32)
            target = self.store.find_by_username(username) if username else None
            self._pending[hash_token(secret)] = PendingCode(
                code, label, self.clock() + EXPIRES_SECONDS, secrets.token_urlsafe(18), username,
                target.user_id if target else None, network, time.time(),
            )
            self.changes.bump('signin')
            return {"code": code, "secret": secret, "expiresIn": EXPIRES_SECONDS, "pollInterval": POLL_SECONDS}

    @staticmethod
    def _matches_target(row: PendingCode, account_id: str) -> bool:
        # A named but unknown username must never become an untargeted request.
        return not row.username or row.target_id == account_id

    def approve(self, code: str, account_id: str) -> None:
        with self._lock:
            self._limit("approve", 10)
            self._prune()
            code = normalize_code(code)
            row = next((row for row in self._pending.values() if row.code == code), None)
            if (row is None or not row.waiting or not self._matches_target(row, account_id)
                    or self.store.get_user(account_id) is None):
                raise InvalidCode
            row.account_id = account_id
            self.changes.bump('signin')

    def requests(self, account_id: str) -> list[dict]:
        with self._lock:
            now = self.clock()
            return [row.public() for row in self._pending.values()
                    if row.target_id == account_id and row.waiting and row.deadline > now]

    def inspect(self, code: str, account_id: str) -> dict:
        with self._lock:
            self._limit("inspect", 20)
            self._prune()
            row = next((r for r in self._pending.values() if r.code == normalize_code(code) and r.waiting), None)
            if row is None or not self._matches_target(row, account_id):
                raise InvalidCode
            return row.public()

    def decide(self, request_id: str, account_id: str, *, decline: bool = False) -> None:
        with self._lock:
            self._limit("approve", 10)
            self._prune()
            row = next((r for r in self._pending.values()
                        if r.id == request_id and r.target_id == account_id and r.waiting), None)
            if row is None or self.store.get_user(account_id) is None:
                raise InvalidCode
            if decline:
                row.declined = True
            else:
                row.account_id = account_id
            self.changes.bump('signin')

    def decline_code(self, code: str, account_id: str) -> None:
        with self._lock:
            self._limit("approve", 10)
            self._prune()
            row = next((r for r in self._pending.values() if r.code == normalize_code(code) and r.waiting), None)
            if row is None or not self._matches_target(row, account_id):
                raise InvalidCode
            row.declined = True
            self.changes.bump('signin')

    def poll(self, secret: str) -> dict | None:
        with self._lock:
            self._limit("poll", 120)
            self._prune()
            key = hash_token(secret)
            row = self._pending.get(key)
            if row is None:
                return None
            if self.clock() - row.last_poll < POLL_SECONDS:
                raise CodeRateLimit
            row.last_poll = self.clock()
            if row.declined:
                del self._pending[key]
                raise DeclinedCode
            if row.account_id is None:
                return None
            # Both the removal and mint are serialized with approval/poll. The
            # store rechecks that the account still exists; a revoked account
            # must never get a new credential through an earlier approval.
            del self._pending[key]
            try:
                _, device, token = self.store.add_device(row.account_id, row.label)
            except UnknownUserError:
                return None
            return {"device": device.public(), "token": token}
