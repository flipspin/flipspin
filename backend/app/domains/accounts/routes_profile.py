"""Current-account identity, attention, labels and onboarding.

Synthetic principals have no account row.
Self-service changes always use the authenticated account.
See docs/security.md#account-routes.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_container, get_token_store
from app.domains.accounts.attention import AttentionResponse, describe_attention
from app.domains.accounts.identity import (
    ANONYMOUS,
    LEGACY_OWNER,
    LOCAL_OWNER,
    UNKNOWN,
    IdentityError,
    Principal,
    TokenStore,
    UnknownUserError,
    UserRecord,
    is_real_user,
)
from app.domains.accounts.requests import (
    SetLabelRequest,
)
from app.domains.accounts.schemas import (
    LabelResponse,
    MeResponse,
    OnboardedResponse,
)
from app.infra.identity import current_principal, require_account

router = APIRouter()
logger = logging.getLogger("app.domains.accounts.routes")

SOURCE_TOKEN = "token"

SENTINEL_SOURCES = {
    LEGACY_OWNER: "shared-secret",
    LOCAL_OWNER: "local",
    ANONYMOUS: "anonymous",
    UNKNOWN: "unknown",
}


def _record_for(store: TokenStore, user_id: str) -> UserRecord | None:
    """The account this principal came from, or ``None`` if it is not one.

    One dict hit in the store. Nothing here can reach a token digest — the store
    holds only digests and they must never leave the backend anyway.
    """
    return store.get_user(user_id)


@router.get("/me", response_model=MeResponse)
def whoami(
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(current_principal),
) -> dict:
    """Who the caller is, as ``require_api_token`` already decided it.

    Keys mirror ``UserRecord.public()`` exactly (``id``/``label``/``role``/
    ``createdAt``/``lastSeenAt``) so a client can compare this body against the
    rows of ``GET /api/users`` field for field — marking its own row, and knowing
    before it asks whether a revoke would destroy the credential it is holding.
    ``isOwner`` saves every client from re-deriving the one rule that matters,
    and ``source`` says which *kind* of principal answered:

    ``token``          a real row in ``users.json``; ``id`` is revocable and the
                       two timestamps are that row's. They are ``null`` in the
                       one race where the row was revoked between the gate and
                       this handler — the credential is spent, but it was a real
                       one and saying otherwise would be a lie.
    ``shared-secret``  ``KROBI_API_TOKEN``, a synthetic owner with no row.
    ``local``          loopback on a backend with no token configured.
    ``anonymous``      ``KROBI_ALLOW_UNAUTHENTICATED_REMOTE``; member, never owner.
    ``unknown``        the ``current_principal`` fallback. Unreachable unless a
                       router is ever included without the gate, and returned
                       honestly rather than dressed up as a user.

    The sentinels carry ``null`` timestamps because they have none — inventing a
    ``createdAt`` would make a synthetic owner indistinguishable from a row that
    can actually be managed.

    Identity fields come from the principal, not from the row: the principal is
    what this request was *authorized* as, and the row is only consulted for the
    two things the principal does not carry. Nothing here reads
    a token digest — those live on ``DeviceRecord`` inside the store and no
    response body may ever contain one.
    """
    record = None if principal in SENTINEL_SOURCES else _record_for(store, principal.user_id)
    return {
        "id": principal.user_id,
        "label": principal.label,
        "role": principal.role,
        "isOwner": principal.is_owner,
        "onboarded": record.onboarded if record else False,
        "source": SENTINEL_SOURCES.get(principal, SOURCE_TOKEN),
        # From the row, not the principal: the principal carries what the
        # request was authorized as, and a username is a property of the account
        # behind it. Null for the sentinels (no row) and for accounts that
        # predate password sign-in — never invented.
        "username": record.username if record else None,
        "createdAt": record.created_at if record else None,
        # Coarse on purpose: the store flushes last_seen_at at most every
        # LAST_SEEN_FLUSH_SECONDS, so this is not a clock and will usually
        # predate the request that is reading it.
        "lastSeenAt": record.last_seen_at if record else None,
    }


@router.get("/me/attention", response_model=AttentionResponse, response_model_exclude_unset=True)
def read_attention(principal: Principal = Depends(current_principal), container=Depends(get_container)):
    if not principal.is_owner or not is_real_user(principal):
        return {}
    return describe_attention(container)


@router.post("/me/label", response_model=LabelResponse)
def set_my_label(
    body: SetLabelRequest,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Rename the caller's own account — what the household calls you.

    ⚠ Not the username and not a device. Three names live on an account and
    this is the middle one: ``username`` is what you type to sign in
    (``/me/username``), ``label`` is what every list shows for you, and each
    device has a label of its own. The first account on a server was claimed
    from a phone and ``create_user`` names the account after its first device,
    so without this route the owner of every household is called «Robin
    (iPhone)» forever, on every client.

    Account off the principal, never off the body. ``409`` for a principal with
    no row, like every ``/me`` route; ``422`` for a blank name.
    """
    try:
        account = store.set_label(principal.user_id, body.label)
    except UnknownUserError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account no longer exists; its access was revoked.",
        )
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    logger.info("Account %s renamed itself", principal.user_id)
    return {"user": account.public()}


@router.post("/me/onboarded", response_model=OnboardedResponse)
def complete_account_onboarding(
    principal: Principal = Depends(require_account),
    store: TokenStore = Depends(get_token_store),
) -> dict:
    try:
        store.complete_onboarding(principal.user_id)
    except UnknownUserError as error:
        raise HTTPException(status_code=409, detail="This account no longer exists.") from error
    return {"onboarded": True}
