"""Password policy, scrypt hashing and failed-login throttling.

Perform one derivation even for absent or unusable stored credentials.
Keep secrets out of logs and preserve self-describing stored hashes.
See docs/security.md#password-hashing.
"""
from __future__ import annotations

import base64
import hmac
import hashlib
import logging
import secrets
import unicodedata

from app.infra.throttle import FailureThrottle

logger = logging.getLogger(__name__)

#: Names the algorithm inside the stored value, so a future move to something
#: else can live beside the scrypt hashes rather than requiring a flag day.
SCRYPT_LABEL = "scrypt"

#: Cost parameters. Raise :data:`SCRYPT_N` (and only it, in powers of two) when
#: the hardware everyone runs on has moved on; existing hashes keep verifying at
#: the cost recorded in them and are rewritten on the owner's next sign-in.
SCRYPT_N = 1 << 15
SCRYPT_R = 8
SCRYPT_P = 1

#: Bytes of salt, per account, from :mod:`secrets`.
SALT_BYTES = 16

#: Length of the derived key.
KEY_BYTES = 32

#: Character bounds after NFKC normalization; no composition rules.
#: Policy and offline-guessing rationale: docs/security.md#password-hashing.
MIN_PASSWORD_LENGTH = 8

#: Bound input work on the public login route.
MAX_PASSWORD_LENGTH = 256

#: Endpoint-wide guessing budget, independent of account and caller address.
LOGIN_FAILURE_BURST = 10
LOGIN_FAILURE_WINDOW_SECONDS = 60

#: Shared across requests; see docs/security.md#constant-time-failed-lookup.
login_throttle = FailureThrottle(
    burst=LOGIN_FAILURE_BURST, window_seconds=LOGIN_FAILURE_WINDOW_SECONDS
)


class PasswordPolicyError(ValueError):
    """The proposed password does not clear the floor.

    A plain ``ValueError`` rather than an ``IdentityError``: this module knows
    nothing about accounts and must not import ``identity.py`` (that direction
    is what keeps hashing changes out of the token table). ``TokenStore``
    re-raises it as ``WeakPasswordError`` so every route can keep catching one
    family of exception.

    Its message is shown to the user and must never quote the password back.
    """


def normalize_password(raw: str) -> str:
    """Normalize equivalent Unicode characters consistently at hash and verify time.

    NFKC preserves password whitespace and case; stripping either changes the secret.
    """
    return unicodedata.normalize("NFKC", raw or "")


def validate_password(raw: str) -> str:
    """The normalized password, or raise :class:`PasswordPolicyError`.

    Length is measured after normalization, on characters rather than bytes,
    because characters are what the person counted.
    """
    candidate = normalize_password(raw)
    if len(candidate) < MIN_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"A password needs at least {MIN_PASSWORD_LENGTH} characters. "
            "There are no other rules — a phrase you can remember beats a short "
            "one full of symbols."
        )
    if len(candidate) > MAX_PASSWORD_LENGTH:
        raise PasswordPolicyError(
            f"A password may be at most {MAX_PASSWORD_LENGTH} characters."
        )
    return candidate


def hash_password(raw: str) -> str:
    """Derive a fresh salt and return the whole stored value as one string.

    Does not enforce the policy — :func:`validate_password` is a separate
    call so that the store can validate, then hash outside its lock. Callers
    that skip the validation are hashing something they were handed rather than
    something a user chose (there is currently no such caller).
    """
    salt = secrets.token_bytes(SALT_BYTES)
    key = _derive(normalize_password(raw), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return _encode(salt, key, SCRYPT_N, SCRYPT_R, SCRYPT_P)


def verify_password(raw: str | None, stored: str | None) -> bool:
    """Run one scrypt derivation even for missing or malformed stored credentials.

    Equal work prevents username enumeration through timing; compare_digest avoids
    short-circuit comparison. See docs/security.md#constant-time-failed-lookup.
    """
    parsed = _decode(stored)
    if parsed is None:
        # Burn the same work against a throwaway salt, then fail. The result is
        # discarded; only its cost is wanted.
        _derive(normalize_password(raw or ""), _DUMMY_SALT, SCRYPT_N, SCRYPT_R, SCRYPT_P)
        return False
    salt, expected, n, r, p = parsed
    candidate = _derive(normalize_password(raw or ""), salt, n, r, p)
    return hmac.compare_digest(candidate, expected)


def needs_rehash(stored: str | None) -> bool:
    """Whether this stored value uses older cost parameters.

    Never a reason to reject a sign-in — the whole point of recording the
    parameters is that an old hash stays valid. It is a reason to rewrite the
    value while the plaintext is briefly in hand, which is the only moment it
    can be rewritten at all.

    A value that will not parse answers ``True``: it cannot verify anything, so
    replacing it is strictly an improvement.
    """
    parsed = _decode(stored)
    if parsed is None:
        return True
    _salt, _key, n, r, p = parsed
    return (n, r, p) != (SCRYPT_N, SCRYPT_R, SCRYPT_P)


# --------------------------------------------------------------------- private

#: Salt for the derivation performed on behalf of accounts that do not exist.
#: Fixed and process-local: it is never compared against anything, so it only
#: has to make the work happen.
_DUMMY_SALT = secrets.token_bytes(SALT_BYTES)


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    """One scrypt derivation. The only place the KDF is called.

    ``maxmem`` is computed from the parameters rather than left at 0 — see the
    module docstring; the default cap and these parameters are the same number,
    so the call is otherwise a coin flip across OpenSSL builds.
    """
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=n,
        r=r,
        p=p,
        dklen=KEY_BYTES,
        maxmem=(128 * n * r * p) + (1 << 20),
    )


def _encode(salt: bytes, key: bytes, n: int, r: int, p: int) -> str:
    return "$".join(
        (
            SCRYPT_LABEL,
            f"n={n},r={r},p={p}",
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(key).decode("ascii"),
        )
    )


def _decode(stored: str | None) -> tuple[bytes, bytes, int, int, int] | None:
    """``(salt, key, n, r, p)``, or ``None`` for anything unusable.

    Tolerant like every loader in this package: a hand-edited or truncated value
    must read as "this account has no usable password" — which locks that person
    out of *password* sign-in and nothing else, because their device tokens live
    in a different field — rather than taking the process down. It is logged at
    debug and not at warning: the ``None`` path is also the ordinary
    no-password-set path, and a warning per sign-in attempt would be noise.
    """
    if not stored or not isinstance(stored, str):
        return None
    parts = stored.split("$")
    if len(parts) != 4 or parts[0] != SCRYPT_LABEL:
        return None
    try:
        params = dict(item.split("=", 1) for item in parts[1].split(","))
        n, r, p = int(params["n"]), int(params["r"]), int(params["p"])
        salt = base64.b64decode(parts[2], validate=True)
        key = base64.b64decode(parts[3], validate=True)
    except (KeyError, ValueError) as e:
        logger.debug("Unparseable stored password value (%s); treating as unset", e)
        return None
    # n must be a power of two greater than 1 or scrypt raises, and a parameter
    # set read off disk is exactly where an absurd one would arrive from.
    if n < 2 or (n & (n - 1)) or r < 1 or p < 1 or not salt or not key:
        return None
    # A hand-edited n of 2^30 would try to allocate a terabyte before failing.
    # Refuse anything costlier than what this build would write itself.
    if (128 * n * r * p) > (128 * SCRYPT_N * SCRYPT_R * SCRYPT_P) * 8:
        logger.warning("Refusing an implausibly expensive stored password parameter set")
        return None
    return salt, key, n, r, p


__all__ = [
    "LOGIN_FAILURE_BURST",
    "LOGIN_FAILURE_WINDOW_SECONDS",
    "MAX_PASSWORD_LENGTH",
    "MIN_PASSWORD_LENGTH",
    "PasswordPolicyError",
    "SCRYPT_N",
    "SCRYPT_P",
    "SCRYPT_R",
    "hash_password",
    "login_throttle",
    "needs_rehash",
    "normalize_password",
    "validate_password",
    "verify_password",
]
