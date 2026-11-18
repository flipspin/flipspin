"""Password sign-in and account credential changes.

Public login failures share status, body, derivation cost and throttle.
Password changes retain existing device credentials.
See docs/security.md#password-hashing.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_token_store
from app.domains.accounts import passwords
from app.domains.accounts.identity import (
    IdentityError,
    InvalidCredentialsError,
    InvalidUsernameError,
    Principal,
    TokenStore,
    UnknownUserError,
    UsernameRequiredError,
    UsernameTakenError,
    WeakPasswordError,
)
from app.domains.accounts.requests import (
    ChangePasswordRequest,
    LoginRequest,
    ResetPasswordRequest,
    SetUsernameRequest,
)
from app.domains.accounts.routes_users import require_account_owner
from app.domains.accounts.schemas import (
    CreateDeviceResponse,
    PasswordChangeResponse,
    UsernameResponse,
)
from app.infra.identity import require_account

router = APIRouter()
logger = logging.getLogger("app.domains.accounts.routes")

DEFAULT_LOGIN_DEVICE_LABEL = "New device"

_BAD_LOGIN_DETAIL = "That username and password do not match an account here."


@router.post("/login", status_code=201, response_model=CreateDeviceResponse)
def login(
    body: LoginRequest,
    store: TokenStore = Depends(get_token_store),
) -> dict:
    # Keep the published OpenAPI description byte-stable, including legacy path references.
    """Sign in with a username and a password; get a device token back.

    The recovery path, and the second door into a server for a client holding
    nothing. ``POST /api/me/devices`` can only add a machine to an account that
    already has a signed-in one, so before this existed a household that lost
    every device lost the library — see ``app/domains/accounts/identity.py``.

    The response is a :class:`CreateDeviceResponse`, byte-identical to
    ``POST /api/me/devices``, so a client has exactly one code path for "I now
    hold a token" and one place that stores it. ⚠ The rule that comes with that
    shape comes with it here too: ``token`` exists in this response and nowhere
    else, ever.

    ``201`` and not ``200``: this creates a device. It is visible in
    ``GET /api/me/devices`` the moment it answers and revocable like any other,
    which is what makes a forgotten sign-in on somebody else's laptop
    recoverable.

    The answers:

    ``201``  signed in. ``device`` is the new row, ``token`` its credential.
    ``401``  ⚠ wrong username **or** wrong password, indistinguishably. Same
             status, same body, and the same ~75 ms of key derivation either way
             — ``passwords.verify_password`` runs a full scrypt derivation even
             when there is no account to check against, because a fast miss and
             a slow hit is a username oracle anybody on the LAN can read with a
             stopwatch. Never make this branch cheaper.
    ``429``  too many failed sign-ins lately, household-wide; ``Retry-After``
             says how long. Global rather than per-account on purpose — a
             per-account bucket answers "that name exists" all by itself, and
             lets one stranger lock one named person out. See
             ``app/core/throttle.py``.
    ``422``  the body was not a body (pydantic). Shape only, never content: a
             username that could not possibly be valid still gets the 401.

    Public (``PUBLIC_EXACT_PATHS``): a caller with no credential is the entire
    point, exactly as for ``POST /api/claim``. Unlike the claim, this one does
    not close — it is a permanent unauthenticated route that mints credentials,
    which is why the throttle above is not optional and why the failure says
    nothing.
    """
    wait = passwords.login_throttle.retry_after()
    if wait is not None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed sign-in attempts. Wait and try again.",
            headers={"Retry-After": str(wait)},
        )
    try:
        account, device, token = store.authenticate(
            body.username, body.password, body.deviceLabel or DEFAULT_LOGIN_DEVICE_LABEL
        )
    except InvalidCredentialsError:
        passwords.login_throttle.record_failure()
        # The username is not logged. It is half of a credential somebody is
        # currently typing, it may well be a *password* typed into the wrong
        # field, and a log line naming it turns a shared log into a word list.
        logger.warning("Refused a sign-in: the credentials presented did not match.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=_BAD_LOGIN_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )
    except IdentityError as e:
        # A label the store would not take. Nothing to do with the credentials,
        # which have already been accepted at this point.
        raise HTTPException(status_code=422, detail=str(e))
    logger.info(
        "Device %r signed in with a password on the account of %s",
        device.label,
        account.user_id,
    )
    return {"device": device.public(), "token": token}


@router.post("/me/username", response_model=UsernameResponse)
def set_my_username(
    body: SetUsernameRequest,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Choose the name this account signs in with, or change it.

    ⚠ **This is how an account that predates password sign-in becomes
    recoverable**, and it is why it takes no password: every account in an
    existing ``users.json`` has neither a username nor a password, and a route
    that asked for the current one would have nothing to ask. The credential
    that authorizes it is the device token the request arrived with, which is
    strictly stronger — it is what a password exists to mint.

    The account is the caller's, always, read off the principal and never off
    the body.

    ``200``  set. ``username`` is the name **as stored**, keeping the case typed.
    ``409``  somebody in this household already has it. That does reveal the
             name exists, and it is the right trade: the caller lives with these
             people, and the alternative is a rename that silently did not
             happen.
    ``422``  not a usable name; the message says what a name may contain.
    """
    try:
        account = store.set_username(principal.user_id, body.username)
    except UnknownUserError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account no longer exists; its access was revoked.",
        )
    except UsernameTakenError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except InvalidUsernameError as e:
        raise HTTPException(status_code=422, detail=str(e))
    logger.info("Account %s set its username", principal.user_id)
    return {"username": account.username}


@router.post("/me/password", response_model=PasswordChangeResponse)
def change_my_password(
    body: ChangePasswordRequest,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Set or change the password on the caller's own account.

    ⚠ **This does not sign any other device out, and that is a decision rather
    than an omission.** The two answers pull opposite ways and both are
    reasonable, so the reasoning is written down:

    *The security-obvious answer is to revoke.* On most systems a password is
    the session: changing it because you fear compromise should end every
    session it created, or the change accomplished nothing.

    *The user-obvious answer is not to.* Here the password is **not** the
    session. Device tokens are, they were minted individually, and each one is
    listed and revocable by itself in ``GET /api/me/devices``. Somebody raising
    a weak password — the routine, desirable act — has no reason to expect that
    the family's other phone, the laptop and the tablet all stop working, and
    every one of them would then have to be signed in again by hand.

    The deciding argument is that revoking here would make the *routine* action
    destructive while adding nothing the household did not already have: the
    action for "a device is stolen" exists, is precise, and is one call away.
    Bundling the two makes the precise tool feel redundant and the routine one
    frightening, and a frightening password change is a password that never gets
    changed.

    ⚠ The honest cost, stated in the response as well as here: if the *password
    itself* leaked and somebody already spent it on ``POST /api/login``, changing
    it does **not** evict them — they hold a device token now, and tokens do not
    care about passwords. ``otherDevicesSignedOut: false`` and ``deviceCount``
    exist so a client can say exactly that and send the user to the device list,
    which is where evicting somebody actually happens.

    Not throttled, unlike ``POST /api/login``: guessing the current password
    here requires already holding a working device token for this account, and a
    caller who has that has everything the password could get them. There is
    nothing to escalate to, so a limiter would only give one member a way to
    interfere with another.

    ``200``  changed.
    ``401``  the current password is wrong. Same wording as a failed sign-in.
    ``409``  no username yet — a password with no username can never sign in, so
             it is refused rather than stored as a credential that does nothing.
    ``422``  the new password is shorter than the floor
             (``passwords.MIN_PASSWORD_LENGTH``); the message says the floor and
             nothing about composition, because there are no composition rules.
    """
    try:
        account = store.set_password(principal.user_id, body.newPassword, body.currentPassword)
    except UnknownUserError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account no longer exists; its access was revoked.",
        )
    except InvalidCredentialsError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(e),
            headers={"WWW-Authenticate": "Bearer"},
        )
    except UsernameRequiredError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except WeakPasswordError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    # Never the password, never a prefix of it, never its length.
    logger.info("Account %s changed its password", principal.user_id)
    return {
        "success": True,
        "otherDevicesSignedOut": False,
        "deviceCount": len(account.devices),
    }


@router.post("/users/{user_id}/password", response_model=PasswordChangeResponse)
def reset_account_password(
    user_id: str,
    body: ResetPasswordRequest,
    principal: Principal = Depends(require_account_owner),
    store: TokenStore = Depends(get_token_store),
) -> dict:
    if user_id == principal.user_id:
        raise HTTPException(status_code=409, detail="Use /api/me/password to change your own password.")
    try:
        account = store.reset_password(user_id, body.newPassword)
    except UnknownUserError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except UsernameRequiredError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except IdentityError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    logger.info("Account %s reset password for account %s", principal.user_id, user_id)
    return {"success": True, "otherDevicesSignedOut": False, "deviceCount": len(account.devices)}
