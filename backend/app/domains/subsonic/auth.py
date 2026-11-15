"""Authenticate Subsonic parameters through the shared device directory.

Accept apiKey, salted app-password MD5, or plain/hex app passwords. Every path
uses the same revocation and device-touch behavior as other device tokens.
"""
from __future__ import annotations

import hashlib
import hmac

from app.infra.identity import Principal, AccountDirectory, is_real_user

from .app_passwords import AppPasswordVault
from .failure_throttle import CredentialThrottle
from .render import (
    AUTH_MECHANISM_UNSUPPORTED,
    CONFLICTING_AUTH,
    INVALID_API_KEY,
    MISSING_PARAMETER,
    WRONG_CREDENTIALS,
    GENERIC,
    TOKEN_AUTH_UNSUPPORTED,
    SubsonicError,
)

throttle = CredentialThrottle()

_WRONG = "Usuario o contraseña de app incorrectos."
AUTH_PARAMETERS = frozenset({"apiKey", "u", "p", "t", "s", "jwt"})


def _plain(p: str) -> str:
    if p.startswith("enc:"):
        try:
            return bytes.fromhex(p[4:]).decode("utf-8")
        except ValueError:
            return ""
    return p


def _fail(bucket: tuple[str, str], code: int, message: str) -> SubsonicError:
    if throttle.reject(bucket):
        # Subsonic has no rate-limit code: generic error, distinct from 40/44.
        return SubsonicError(GENERIC, "Demasiados intentos fallidos. Espera un minuto.")
    return SubsonicError(code, message)


def authenticate(params, store: AccountDirectory, vault: AppPasswordVault, client_ip: str = "unknown") -> Principal:
    # Test presence, including empty values: apiKey=&u= must not silently
    # switch mechanisms. Query and form parameters share this same gate.
    for name in AUTH_PARAMETERS:
        if len(set(params.getlist(name))) > 1:
            raise SubsonicError(CONFLICTING_AUTH, "Multiple conflicting authentication mechanisms provided")
    has_key = "apiKey" in params
    has_password = "p" in params
    has_token = "t" in params or "s" in params
    has_jwt = "jwt" in params
    if (
        (has_key and any(name in params for name in ("u", "p", "t", "s", "jwt")))
        or (has_password and has_token)
        or (has_jwt and any(name in params for name in ("u", "p", "t", "s")))
    ):
        # Only an explicit, valid key can attribute a rejected mechanism to a
        # device. u+t+s alone cannot identify a SHA-256-only key.
        if has_key and has_token:
            identified = store.resolve(params.get("apiKey"), touch=False)
            if is_real_user(identified):
                store.record_subsonic(identified, params.get("c"), failure="wrong-mechanism")
        raise SubsonicError(CONFLICTING_AUTH, "Multiple conflicting authentication mechanisms provided")
    # Navidrome's jwt mechanism is not implemented. Do not mistake it for a
    # missing username or silently fall back to a supported mechanism.
    if has_jwt:
        raise SubsonicError(AUTH_MECHANISM_UNSUPPORTED, "Provided authentication mechanism not supported")

    api_key = params.get("apiKey") or ""
    username = (params.get("u") or "").strip()
    # Every failed guess shares its peer's bucket, independently of credential.
    # A supplied username also shares a bucket across peers; the global window
    # bounds distributed guesses and churn in the bounded per-identity map.
    bucket = (client_ip, username)
    if has_key:
        principal = store.resolve(api_key, touch=False)
        if not is_real_user(principal):
            raise _fail(bucket, INVALID_API_KEY, "apiKey no válida.")
        return principal

    if not username:
        raise SubsonicError(MISSING_PARAMETER, "Falta el parámetro «u».")
    token, salt, password = params.get("t"), params.get("s"), params.get("p")
    if not ((token and salt) or password):
        raise SubsonicError(MISSING_PARAMETER, "Faltan credenciales: t y s, o p.")

    account = store.find_by_username(username)
    if account is None:
        raise _fail(bucket, WRONG_CREDENTIALS, _WRONG)

    candidate: str | None = None
    if token and salt:
        for secret in vault.for_devices([d.device_id for d in account.devices]):
            digest = hashlib.md5((secret + salt).encode("utf-8")).hexdigest()
            if hmac.compare_digest(digest, token.strip().lower()):
                candidate = secret
                break
    else:
        candidate = _plain(password or "")

    principal = store.resolve(candidate, touch=False) if candidate else None
    if principal is None or principal.user_id != account.user_id:
        if token and salt and any(d.credential_type == "api-key" for d in account.devices):
            # A key's MD5 cannot be verified using its SHA-256 verifier. Do not
            # describe this as a wrong password or guess which row sent it.
            raise _fail(bucket, TOKEN_AUTH_UNSUPPORTED, "La autenticación por token no admite claves de API.")
        raise _fail(bucket, WRONG_CREDENTIALS, _WRONG)
    return principal
