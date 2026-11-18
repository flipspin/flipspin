"""First-run setup-token generation, comparison and throttling.

Never log setup-token plaintext to file logs or expose it in status.
The store owns atomic first-owner creation; this module only gates it.
See docs/security.md#claim-and-setup-code.
"""
from __future__ import annotations

import hmac
import logging
import secrets
import threading
from pathlib import Path

from app.infra.throttle import FailureThrottle
from app.infra.files import write_secret_lines

logger = logging.getLogger(__name__)

#: Bytes of entropy behind the setup token. Same size as a minted user token —
#: it guards the same thing (the first owner credential), so it gets the same
#: margin. 32 bytes -> a 43-char urlsafe string.
SETUP_TOKEN_BYTES = 32

#: How many *failed* setup-token attempts are tolerated before the endpoint
#: starts answering 429, and over what window. Five per minute against 256 bits
#: of entropy is not a brute-force budget by any measure; it is generous enough
#: that an operator fat-fingering a paste never notices the limiter exists.
CLAIM_FAILURE_BURST = 5
CLAIM_FAILURE_WINDOW_SECONDS = 60

#: The token, cached per path for the life of the process.
#:
#: Not merely an optimisation. When the file cannot be persisted (read-only
#: mount, missing directory) the generator degrades to an in-memory value, and
#: without this cache every read would hand out a *different* one — the token
#: printed in the boot log would then never match the token the claim route
#: checks against, which is a failure nobody could diagnose from the outside.
_cached: dict[str, str] = {}

#: Guards ``_cached`` and the generate-then-write sequence as one unit, so two
#: threads racing on first boot cannot each persist a different token.
_cache_lock = threading.RLock()


def read_or_create_setup_token(path: Path, logger_: logging.Logger | None = None) -> str:
    """Return a setup token, persisting it when storage is writable.

    Storage failure leaves a process-local token available in the boot log.
    A token exists in both modes; its presence does not establish strict mode.
    """
    log = logger_ or logger
    key = str(path)
    with _cache_lock:
        cached = _cached.get(key)
        if cached:
            return cached

        existing = _read(path, log)
        if existing:
            _cached[key] = existing
            return existing

        generated = secrets.token_urlsafe(SETUP_TOKEN_BYTES)
        if not _write(path, generated, log):
            # Explain why the console token can change after a restart.
            log.warning(
                "Could not persist the setup token to %s; it will change on restart. "
                "Read it from this log instead.",
                path,
            )
        _cached[key] = generated
        return generated


def clear_setup_token(path: Path, logger_: logging.Logger | None = None) -> None:
    """Destroy the setup token — the window it guarded has closed.

    Called after a successful claim. The secret is worthless from that moment
    (the route answers 409 forever after), so leaving a readable credential-
    shaped file lying in the data directory would only invite somebody to try
    it somewhere else. Best effort: failing to delete it must not turn a
    successful claim into a 500, because the account has already been created
    and the caller must be told its token.
    """
    log = logger_ or logger
    with _cache_lock:
        _cached.pop(str(path), None)
    try:
        Path(path).unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        log.warning("Could not remove the spent setup token at %s: %s", path, e)


def setup_token_matches(presented: str | None, expected: str | None) -> bool:
    """Constant-time comparison of a presented setup token against the expected value.

    ``compare_digest`` rather than ``==`` for the same reason ``auth.py`` uses it
    on the shared secret: a plain comparison short-circuits on the first
    differing byte and leaks the secret one character at a time to anyone who
    can time the response. (Per-user tokens need no such care — they are looked
    up by digest, so a miss costs exactly what a hit costs.)
    """
    if not presented or not expected:
        return False
    return hmac.compare_digest(presented.strip(), expected)


class ClaimThrottle(FailureThrottle):
    """Use claim-specific defaults for the shared global throttle.

    The global-bucket tradeoff is documented in app/infra/throttle.py.
    """

    def __init__(
        self,
        burst: int = CLAIM_FAILURE_BURST,
        window_seconds: float = CLAIM_FAILURE_WINDOW_SECONDS,
    ) -> None:
        super().__init__(burst=burst, window_seconds=window_seconds)


#: The one throttle for this process. A module-level singleton rather than a
#: dependency because it must outlive every request and there is exactly one
#: endpoint behind it; ``reset()`` exists so a test can start from zero.
throttle = ClaimThrottle()


def _read(path: Path, log: logging.Logger) -> str | None:
    """The token already on disk, or ``None``. Tolerant like every store here."""
    try:
        value = Path(path).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None  # First boot. The normal path.
    except OSError as e:
        log.warning("Could not read the setup token at %s (%s); regenerating", path, e)
        return None
    if not value:
        log.warning("Setup token file %s is empty; regenerating", path)
        return None
    return value


def _write(path: Path, token: str, log: logging.Logger) -> bool:
    """Persist the token 0600. Returns whether it landed.

    ``write_secret_lines`` creates the file through ``os.open(..., 0o600)`` so
    it never exists under the default umask, even briefly. No atomic rename here — unlike the token
    table, a half-written setup token is not a corrupted account table, it is a
    token that does not match, which the next boot regenerates.
    """
    try:
        write_secret_lines(Path(path), [token + "\n"])
        return True
    except OSError as e:
        log.warning("Failed writing the setup token to %s: %s", path, e)
        return False


__all__ = [
    "CLAIM_FAILURE_BURST",
    "CLAIM_FAILURE_WINDOW_SECONDS",
    "SETUP_TOKEN_BYTES",
    "ClaimThrottle",
    "clear_setup_token",
    "read_or_create_setup_token",
    "setup_token_matches",
    "throttle",
]
