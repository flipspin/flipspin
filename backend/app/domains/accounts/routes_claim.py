"""The first-owner claim HTTP route and setup-token gate.

The store performs the atomic empty-table check and owner creation.
Cosmetic follow-ups must not hide a successfully minted credential.
See docs/security.md#claim-and-setup-code.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.config import ConfigManager
from app.dependencies import DependencyContainer, get_config, get_container, get_token_store
from app.domains.accounts import claim
from app.domains.accounts.identity import (
    AlreadyInitializedError,
    IdentityError,
    TokenStore,
)
from app.domains.accounts.requests import (
    ClaimRequest,
)
from app.domains.accounts.schemas import (
    CreateUserResponse,
)
from app.infra import instance as nest_instance

router = APIRouter()
logger = logging.getLogger("app.domains.accounts.routes")

ALREADY_CLAIMED_DETAIL = (
    "This server already has an owner. The first-run claim is closed; ask whoever set it up to mint you a token."
)


@router.post("/claim", status_code=201, response_model=CreateUserResponse)
def claim_server(
    body: ClaimRequest,
    config: ConfigManager = Depends(get_config),
    store: TokenStore = Depends(get_token_store),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    """Create the first owner of a server that has none. Once, ever.

    The response is a :class:`CreateUserResponse`, byte-identical in shape to
    ``POST /api/users`` — reused rather than reinvented so a client decodes the
    minted credential with the code it already has, and so ⚠ the rule that a
    token is shown exactly once and never recoverable applies here unchanged.

    ``username`` and ``password`` are optional and, when given, make the first
    account recoverable from the moment it exists — the household that has just
    claimed a server is precisely the one whose whole access is a single token on
    a single phone. ⚠ They are additive rather than required because a shipped
    desktop client posts ``{label}`` alone; see :class:`ClaimRequest`. The
    **response shape does not change either way**: ``{user, token}`` with the
    same five keys under ``user``, pinned by
    ``tests/integration/test_response_contracts.py`` and decoded by two clients.

    The answers, all of which a client is expected to branch on:

    ``201``  claimed. ``token`` is the owner credential and this is the only
             moment it exists anywhere.
    ``409``  already set up. The normal answer forever after the first success,
             and the reason this is not a 500: a second client racing the first,
             or a user re-running a setup screen, is not a server fault.
    ``401``  a setup token is required and the one presented was wrong or
             missing. Only reachable in strict mode.
    ``429``  too many rejected setup tokens lately; ``Retry-After`` says how long.
    ``422``  no usable label (pydantic, same as ``POST /api/users``), or a
             username/password pair that was half-given, malformed or too short.
             ⚠ Nothing is created in that case: the credentials are validated
             and hashed before the store's lock is taken, so a rejected pair
             cannot leave a half-claimed server behind.

    ⚠ The ``has_users`` check below is a **courtesy, not the guard**. It exists
    so an already-claimed server answers 409 without making the caller produce a
    setup token it has no way to obtain. The guarantee that exactly one caller
    wins lives in ``store.claim_first_owner``, which does the check and the mint
    under one lock; the ``AlreadyInitializedError`` branch here is the loser of
    that race, and it must stay even though the early check "already covers it".

    Order matters: the credential check runs before the write, so a wrong setup
    token cannot create anything, and the throttle runs before the credential
    check, so a brute force pays its cost before any comparison happens.
    """
    if store.has_users():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_CLAIMED_DETAIL)

    if config.require_setup_token:
        wait = claim.throttle.retry_after()
        if wait is not None:
            logger.warning("Throttled a first-run claim attempt; %ss to wait.", wait)
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many failed claim attempts. Wait and try again.",
                headers={"Retry-After": str(wait)},
            )
        expected = claim.read_or_create_setup_token(config.setup_token_file, logger)
        if not claim.setup_token_matches(body.setupToken, expected):
            claim.throttle.record_failure()
            # Never echo either token, not even a prefix: this line is the one
            # an attacker would most like to read out of a shared log file.
            logger.warning(
                "Refused a first-run claim: the setup token presented did not match. The correct one is in %s.",
                config.setup_token_file,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=(
                    "This server requires its setup token to be claimed. It was written "
                    "to the server's log and to a file in its data directory when the "
                    "server started."
                ),
                headers={"WWW-Authenticate": "Bearer"},
            )

    try:
        record, token = store.claim_first_owner(body.label, body.username, body.password)
    except AlreadyInitializedError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ALREADY_CLAIMED_DETAIL)
    except IdentityError as e:
        # Covers InvalidUsernameError and WeakPasswordError as well as a bad
        # label — all of them 422, all of them raised before anything is
        # written, and none of them ever quoting the password back.
        raise HTTPException(status_code=422, detail=str(e))

    # The window is shut; the secret that guarded it is now worthless and a
    # worthless credential lying in the data directory is only an invitation.
    claim.clear_setup_token(config.setup_token_file, logger)
    logger.warning(
        "FIRST RUN: this server was claimed by %r (%s). Further accounts come from "
        "POST /api/users, which needs this owner's token.",
        record.label,
        record.user_id,
    )
    # Cosmetic follow-ups: none may turn a successful claim into an error,
    # because the caller must still be told its token.
    try:
        # A fresh nest goes through the first-run wizard (GET /api/status setupDone).
        nest_instance.set_setup_done(config.instance_file, False, logger)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not record the first-run state at claim: %s", e)
    if body.nestName:
        try:
            nest_instance.set_name(config.instance_file, body.nestName, logger)
        except Exception as e:  # noqa: BLE001
            logger.warning("Could not store the nest name given at claim: %s", e)
    try:
        # Claimed now, so the nest may be announced on the LAN.
        container.get_nest_advertiser().refresh()
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not start the LAN advertisement after the claim: %s", e)
    return {"user": record.public(), "token": token}
