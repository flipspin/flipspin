"""Request authentication, principals and account authorization ports.

Reject unresolved presented credentials, including on loopback.
Resolve accounts through injected ports; forwarded requests gain no local trust.
See docs/security.md#request-authentication.
"""
from __future__ import annotations

import hmac
import logging
from ipaddress import ip_address
from dataclasses import dataclass
from typing import Literal, Protocol
from collections.abc import Sequence

from fastapi import BackgroundTasks, Depends, HTTPException, Request, status

from app.config import ConfigManager
#: The two roles. One field, not an authorization system: ``owner`` may manage
#: the token table, ``member`` may use the app. Finer-grained permissions need
#: a separate authorization model.
ROLE_OWNER = "owner"
ROLE_MEMBER = "member"
ROLES = (ROLE_OWNER, ROLE_MEMBER)

@dataclass(frozen=True)
class Principal:
    """Represent the account and device authorized for this request.

    Compare user_id for account equality; dataclass equality also compares device
    identity. Synthetic principals have no device row. Helper authorization checks
    the particular device's enrollment, while library access follows the account.
    """

    user_id: str
    label: str
    role: str = ROLE_MEMBER
    device_id: str | None = None

    @property
    def is_owner(self) -> bool:
        return self.role == ROLE_OWNER

    def __str__(self) -> str:  # what lands in the log line
        return f"{self.label} [{self.user_id}/{self.role}]"


#: The legacy shared secret still works and resolves to this. It has to: the
#: token lives in ``~/Krobi/.env`` on real deployments and the desktop shell
#: reads it from there, so removing it would lock existing installs out on upgrade.
LEGACY_OWNER = Principal(user_id="shared-token", label="KROBI_API_TOKEN", role=ROLE_OWNER)

#: A loopback caller on a backend with no token configured — i.e. the desktop app
#: talking to its own backend. Owner, because that is literally the person who
#: installed it and they can already read the files directly.
LOCAL_OWNER = Principal(user_id="local", label="local client", role=ROLE_OWNER)

#: ``KROBI_ALLOW_UNAUTHENTICATED_REMOTE=true``. Deliberately *not* an owner: the
#: operator turned auth off for convenience, which must not also hand token
#: management to whoever finds the port. Minting still works from loopback.
ANONYMOUS = Principal(user_id="anonymous", label="unauthenticated remote", role=ROLE_MEMBER)

#: Fallback for ``current_principal`` when nothing resolved the request. Only
#: reachable if a router were ever included without ``require_api_token``; a
#: member-role placeholder means that mistake fails closed at the owner gate.
UNKNOWN = Principal(user_id="unknown", label="unidentified caller", role=ROLE_MEMBER)

#: The four principals above: everything ``require_api_token`` can *synthesize*
#: when no row in ``users.json`` answered. Declared here, beside the objects
#: themselves, because three unrelated features now have to ask the same question
#: ("is there a person behind this credential?") and a second copy of the set
#: would drift the day a fifth sentinel is added.
#:
#: Membership is by identity, not by ``user_id`` string: a minted row
#: labelled "local client" must not be able to impersonate :data:`LOCAL_OWNER`.
#: A sentinel carries no ``device_id``, so a real account's principal can never
#: compare equal to one even if every other field were forged.
SENTINEL_PRINCIPALS = frozenset({LEGACY_OWNER, LOCAL_OWNER, ANONYMOUS, UNKNOWN})


def is_real_user(principal: Principal | None) -> bool:
    """Require an account row before storing personal data.

    Synthetic principals can be shared across callers and cannot own manageable
    private rows. A missing principal is treated the same way."""
    return principal is not None and principal not in SENTINEL_PRINCIPALS


class DeviceIdentity(Protocol):
    """Read-only device view used by authentication and Subsonic."""

    @property
    def device_id(self) -> str: ...

    @property
    def label(self) -> str: ...

    @property
    def helper(self) -> bool: ...

    @property
    def credential_type(self) -> str | None: ...


class AccountIdentity(Protocol):
    """Read-only account identity; storage and account mutations stay in accounts."""

    @property
    def user_id(self) -> str: ...

    @property
    def role(self) -> str: ...

    @property
    def username(self) -> str | None: ...

    @property
    def devices(self) -> Sequence[DeviceIdentity]: ...

    def device(self, device_id: str) -> DeviceIdentity | None: ...


class TokenResolver(Protocol):
    """Port implemented by accounts and supplied per request by the composition root."""

    def resolve(self, token: str | None) -> Principal | None: ...

    def get_user(self, user_id: str) -> AccountIdentity | None: ...


class AccountDirectory(TokenResolver, Protocol):
    """Identity queries and attributed Subsonic activity."""

    def resolve(self, token: str | None, *, touch: bool = True) -> Principal | None: ...

    def record_subsonic(self, principal: Principal, client: str | None, *,
                        failure: Literal["wrong-mechanism"] | None = None) -> None: ...

    def find_by_username(self, username: str) -> AccountIdentity | None: ...

    def list_users(self) -> Sequence[AccountIdentity]: ...

    def has_users(self) -> bool: ...

    def has_password_sign_in(self) -> bool: ...


def get_config(request: Request) -> ConfigManager:
    return request.app.state.config


def get_token_resolver(request: Request) -> TokenResolver:
    # main.py registers the provider; infra never imports its implementation.
    return request.app.state.identity_resolver(request)


logger = logging.getLogger(__name__)

#: Non-standard header accepted in addition to ``Authorization: Bearer``.
TOKEN_HEADER = "X-Krobi-Token"

#: Query-parameter fallback. Only for browser APIs that cannot send headers —
#: ``EventSource`` and ``<audio>``/``<img>`` ``src``. See the module docstring of
#: ``renderer/src/lib/apiAuth.ts`` for the client side of this.
TOKEN_QUERY_PARAM = "access_token"

#: Public probes and bootstrap/sign-in flows cannot require a device token.
#: Claim, login and code handlers enforce their own credential and attempt gates.
#: Spotify browser callbacks use OAuth state. The app-level root health check
#: bypasses router dependencies. See docs/security.md#request-authentication.
PUBLIC_EXACT_PATHS = frozenset(
    {
        "/api/health",
        "/api/status",
        "/api/claim",
        "/api/login",
        # Device authorization: only creation and secret-based redemption.
        # Approval stays token-gated under /api/me, with require_account.
        "/api/sign-in-code",
        "/api/sign-in-code/poll",
        "/api/ping",
        "/api/spotify/callback",
    }
)

# Forwarded requests never receive the local-owner exception, even from a
# configured trusted proxy. Deployment defaults trust only loopback proxies.
_FORWARDING_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded")

# Loud one-time warnings; keyed so a busy server logs the banner once, not once
# per request.
_warned: set[str] = set()


def _warn_once(key: str, message: str) -> None:
    if key not in _warned:
        _warned.add(key)
        logger.warning(message)


def is_public_route(method: str, path: str) -> bool:
    """Whether this route answers without a token regardless of configuration."""
    return path in PUBLIC_EXACT_PATHS


def is_loopback_client(request: Request) -> bool:
    """Whether the request came from this machine, conservatively.

    Returns ``False`` for anything uncertain — no client in the scope, an
    unparseable host, or any sign the request was forwarded (see
    :data:`_FORWARDING_HEADERS`). Guessing "local" wrong is the failure mode that
    matters.
    """
    if any(header in request.headers for header in _FORWARDING_HEADERS):
        return False
    client = request.client
    host = client.host if client else None
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def presented_token(request: Request) -> str | None:
    """Pull the caller's token out of the request, header first."""
    authorization = request.headers.get("authorization", "")
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() == "bearer" and value.strip():
        return value.strip()
    header_value = (request.headers.get(TOKEN_HEADER) or "").strip()
    if header_value:
        return header_value
    query_value = (request.query_params.get(TOKEN_QUERY_PARAM) or "").strip()
    return query_value or None


def _unauthorized(detail: str) -> HTTPException:
    # WWW-Authenticate is what makes this a well-formed 401 rather than a 401
    # shaped like a 403; curl and every HTTP client key off it.
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _remember_visit(request: Request, config: ConfigManager, tasks: BackgroundTasks) -> None:
    try:
        if not request.client or ip_address(request.client.host).is_loopback:
            return
        from app.infra.remote_access import record_outside_visit, visit_time

        tasks.add_task(
            record_outside_visit, config.instance_file, request.client.host,
            any(header in request.headers for header in ("x-forwarded-for", "forwarded")), visit_time(),
        )
    except Exception:  # noqa: BLE001 — optional bookkeeping must never affect auth
        pass


def require_api_token(
    request: Request,
    background_tasks: BackgroundTasks,
    config: ConfigManager = Depends(get_config),
    store: TokenResolver = Depends(get_token_resolver),
) -> None:
    """Router-level gate. See docs/security.md#request-authentication for its policy.

    On success it stashes the resolved :class:`Principal` on
    ``request.state.principal``. Handlers that need to attribute a destructive
    action read it back through :func:`current_principal` — deliberately a second
    dependency that only *reads*, so identity never gets resolved twice and the
    401-before-403 ordering (router dependency before endpoint dependency) is
    exactly what it was.
    """
    if is_public_route(request.method, request.url.path):
        return

    supplied = presented_token(request)

    # Per-user tokens are checked first and independently of KROBI_API_TOKEN: a
    # household member's phone must work on a backend that never had a shared
    # secret, and revoking that phone must not require touching the .env.
    if supplied:
        principal = store.resolve(supplied)
        if principal is not None:
            request.state.principal = principal
            _remember_visit(request, config, background_tasks)
            return

    expected = config.api_token
    if not expected:
        if supplied is not None:
            raise _unauthorized("Invalid API token.")
        if is_loopback_client(request):
            request.state.principal = LOCAL_OWNER
            return
        if config.allow_unauthenticated_remote:
            _warn_once(
                "unauthenticated_remote",
                "SECURITY: serving unauthenticated requests from non-loopback clients "
                "because KROBI_ALLOW_UNAUTHENTICATED_REMOTE is set. Anyone who can reach "
                "this port owns the music library. Set KROBI_API_TOKEN instead.",
            )
            request.state.principal = ANONYMOUS
            return
        _warn_once(
            "remote_without_token",
            "Refused a non-loopback request because no KROBI_API_TOKEN is configured. "
            "Set KROBI_API_TOKEN in ~/Krobi/.env (and in the client's environment), or "
            "set KROBI_ALLOW_UNAUTHENTICATED_REMOTE=true to restore the old open behaviour.",
        )
        raise _unauthorized(
            "This backend is reachable from the network but has no KROBI_API_TOKEN "
            "configured, so it only answers local requests. Configure a token."
        )

    if supplied is None:
        raise _unauthorized("Missing API token.")
    # compare_digest, not ==: a plain comparison short-circuits on the first
    # differing byte and leaks the shared secret one character at a time to
    # anyone who can time responses. (Per-user tokens above need no such care —
    # they are looked up by digest, so a miss costs the same as a hit.)
    if not hmac.compare_digest(supplied, expected):
        _warn_once(
            "bad_token",
            "Rejected a request carrying an incorrect API token (logged once per process).",
        )
        raise _unauthorized("Invalid API token.")
    request.state.principal = LEGACY_OWNER
    _remember_visit(request, config, background_tasks)


def require_local_client(
    request: Request,
    config: ConfigManager = Depends(get_config),
) -> None:
    """Extra gate for endpoints whose effect is meaningless or hostile off-box.

    A valid token proves the caller is *the user*; it does not make "open this
    file in a GUI app" sensible when the GUI is on a home server. These
    endpoints act on the machine running the backend, so they additionally
    require the caller to be that machine. ``KROBI_ALLOW_REMOTE_LOCAL_ACTIONS``
    unlocks them for anyone who really does want to drive them remotely.
    """
    if config.allow_remote_local_actions or is_loopback_client(request):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "This endpoint acts on the machine running the backend and only accepts "
            "local requests. Set KROBI_ALLOW_REMOTE_LOCAL_ACTIONS=true to override."
        ),
    )


def current_principal(request: Request) -> Principal:
    """Read the principal already established by the router's auth gate.

    Re-resolving duplicates the authorization decision. Missing state falls back
    to a member placeholder so owner-only operations fail closed.
    """
    return getattr(request.state, "principal", None) or UNKNOWN


def require_owner(principal: Principal = Depends(current_principal)) -> Principal:
    """Gate for managing the token table itself (``/api/users``).

    Owner-role, deliberately not :func:`require_local_client`: once the
    backend runs on the home server the desktop app is a remote caller too, and a
    loopback rule would lock the owner out of their own access management.
    """
    if not principal.is_owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Managing access requires an owner token.",
        )
    return principal


def require_helper(
    request: Request,
    principal: Principal = Depends(current_principal),
    store: TokenResolver = Depends(get_token_resolver),
) -> Principal:
    """Only an owner's enrolled device may pull household processing work."""
    account = store.get_user(principal.user_id) if principal.device_id and principal.is_owner else None
    device = account.device(principal.device_id) if account else None
    if not account or account.role != "owner" or not device or not device.helper:
        raise HTTPException(status_code=403, detail="not-a-helper")
    return principal


#: The 409 a sentinel principal gets from the device routes. Same shape and same
#: reasoning as ``user_library_routes._NO_LIBRARY_DETAIL`` — the shared part of
#: that decision (which principals are people) lives once in
#: ``identity.is_real_user``; only the sentence differs, because "you have no
#: library" and "you have no account to add a device to" are different problems
#: with the same fix.
_NO_ACCOUNT_DETAIL = (
    "This credential is not a per-user token, so it has no account and no devices "
    "of its own. Ask an owner for a token minted by POST /api/users and call again "
    "with it."
)


def require_account(principal: Principal = Depends(current_principal)) -> Principal:
    """Require an account row for device management, including member accounts.

    Synthetic principals return 409: even an owner needs an actual account for a
    new device to join. Additional privilege cannot supply a missing account.
    """
    if not is_real_user(principal):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_NO_ACCOUNT_DETAIL)
    return principal


