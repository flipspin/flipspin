"""Device listing, enrollment, renaming and revocation routes.

Never expose stored digests or accept an account id for self-enrollment.
Keep helper enrollment and credential-vault cleanup authorization intact.
See docs/security.md#device-tokens.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.dependencies import DependencyContainer, get_container, get_token_store
from app.domains.accounts.identity import (
    IdentityError,
    LastDeviceError,
    Principal,
    TokenStore,
    UnknownDeviceError,
    UnknownUserError,
)
from app.domains.accounts.requests import (
    AddDeviceRequest,
    RenameDeviceRequest,
)
from app.domains.accounts.routes_profile import _record_for
from app.domains.accounts.schemas import (
    CreateDeviceResponse,
    DeviceListResponse,
    DeviceListRow,
    RevokeDeviceResponse,
)
from app.infra.identity import require_account, require_owner

router = APIRouter()
logger = logging.getLogger("app.domains.accounts.routes")


@router.get("/me/devices", response_model=DeviceListResponse)
def list_my_devices(
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Every machine signed in to the calling account, oldest first.

    Metadata only: the store holds sha256 digests and no body on this surface
    may ever contain one. ``isCurrent`` marks the credential this request
    arrived with, so a settings panel can label it "this device" and warn the
    user before they sign out the phone they are holding.

    An account whose row vanished between the gate and this handler — revoked by
    an owner mid-request — answers an empty list rather than a 500. The
    credential is spent and the next request will be a 401, which is the honest
    place for that to surface.
    """
    record = _record_for(store, principal.user_id)
    devices = record.devices if record else ()
    return {
        "devices": [
            {**device.public(), "isCurrent": device.device_id == principal.device_id, "helper": device.helper}
            for device in devices
        ]
    }


@router.post("/me/devices", status_code=201, response_model=CreateDeviceResponse)
def add_my_device(
    body: AddDeviceRequest,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Mint another token **for the caller's own account**. The feature.

    The Mac joins the phone's account: the new credential resolves to the same
    ``user_id``, so it sees the same per-user library, the same likes and the
    same playlists, and it is separately revocable.

    ⚠ Not ``POST /api/users``. That one is owner-only and creates a *person* —
    a second library, a second set of likes, a second identity in the log — and
    using it to pair a second machine is the defect this route exists to fix.
    The account here is read off the principal and can never come from the body.

    ``token`` in the response is the only time the secret exists; the store
    keeps a digest and cannot reproduce it.
    """
    try:
        helper = body.helper is True
        if helper and not principal.is_owner:
            raise HTTPException(status_code=403, detail="not-a-helper")
        _, device, token = store.add_device(principal.user_id, body.label, helper=helper)
    except UnknownUserError:
        # The account vanished after authorization; report revocation rather than
        # a missing caller-supplied id, since this request contains none.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account no longer exists; its access was revoked.",
        )
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    # The principal already carries the account id and role; no token, ever.
    logger.info("Device %r added to the account of %s", device.label, principal)
    return {"device": device.public(), "token": token}


@router.post("/me/devices/api-key", status_code=201, response_model=CreateDeviceResponse)
def add_my_api_key(
    body: AddDeviceRequest,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Mint an OpenSubsonic API key for the caller's own account.

    ``token`` is shown once. Only its SHA-256 verifier is stored in the account
    directory; no recoverable copy goes into the app-password vault. List and
    revoke it through ``GET /api/me/devices`` and ``DELETE /api/me/devices/{id}``,
    exactly like an app password. Owners and members mint only for themselves.
    """
    try:
        _, device, token = store.add_device(principal.user_id, body.label, credential_type="api-key")
    except UnknownUserError:
        raise HTTPException(status_code=409, detail="This account no longer exists; its access was revoked.")
    except IdentityError as error:
        raise HTTPException(status_code=422, detail=str(error))
    return {"device": device.public(), "token": token}


@router.post("/me/devices/app-password", status_code=201, response_model=CreateDeviceResponse)
def add_my_app_password(
    body: AddDeviceRequest,
    request: Request,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """A device for a Subsonic client: a typeable password instead of a token.

    Same as ``POST /api/me/devices`` (the caller's own account, listed and
    revoked like any device), except that ``token`` is short enough to type
    into a phone (``xxxx-xxxx-xxxx-xxxx``) and a copy is kept encrypted, because
    Subsonic's token auth needs the secret itself (``domains/subsonic/``).
    """
    from app.domains.subsonic.app_passwords import generate

    password = generate()
    try:
        _, device, token = store.add_device(
            principal.user_id, body.label, token=password, credential_type="app-password"
        )
    except UnknownUserError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account no longer exists; its access was revoked.",
        )
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    request.app.state.container.get_app_password_vault().remember(device.device_id, token)
    logger.info("App password %r added to the account of %s", device.label, principal)
    return {"device": device.public(), "token": token}


@router.patch("/me/devices/{device_id}", response_model=DeviceListRow)
def rename_my_device(
    device_id: str,
    body: RenameDeviceRequest,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
) -> dict:
    """Rename one of the caller's devices, including the current device."""
    try:
        device = store.rename_device(principal.user_id, device_id, body.label)
    except (UnknownUserError, UnknownDeviceError):
        raise HTTPException(status_code=404, detail=f"Unknown device '{device_id}'")
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {**device.public(), "isCurrent": device.device_id == principal.device_id, "helper": device.helper}


@router.delete("/me/devices/{device_id}", response_model=RevokeDeviceResponse)
def revoke_my_device(
    device_id: str,
    store: TokenStore = Depends(get_token_store),
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    """Sign one of the caller's own machines out. 404 if it is not theirs.

    The answers a client branches on:

    ``200``  gone. ⚠ ``signedOutThisDevice`` says whether the credential just
             destroyed is the one this request used — supported and normal ("log
             this phone out"), but every following request is a 401, and a
             client that did not expect it would render its own logout as a
             server fault.
    ``404``  no such device **on this account**. A device belonging to somebody
             else answers the same way on purpose: distinguishing "not yours"
             from "does not exist" would let any member enumerate the
             household's device ids one guess at a time.
    ``422``  it is the account's only device. See
             :class:`~app.domains.accounts.identity.LastDeviceError` — nothing could undo
             it, because adding a device requires a working credential *for that
             account*, so the account's library and playlists would be stranded
             under an id nobody can present. Removing the person is a separate,
             deliberate, owner-only act: ``DELETE /api/users/{id}``.
    ``409``  the caller is a sentinel and has no account at all.
    """
    try:
        _, device = store.revoke_device(principal.user_id, device_id)
    except (UnknownUserError, UnknownDeviceError):
        raise HTTPException(status_code=404, detail=f"Unknown device '{device_id}'")
    except LastDeviceError as e:
        raise HTTPException(status_code=422, detail=str(e))
    container.get_app_password_vault().forget({device.device_id})
    container.get_stems_service().queue.worker.revoke(device.device_id)
    signed_out = device.device_id == principal.device_id
    logger.info(
        "Device %r removed from the account of %s%s",
        device.label,
        principal,
        " (this was the calling device)" if signed_out else "",
    )
    return {
        "success": True,
        "device": device.public(),
        "signedOutThisDevice": signed_out,
    }


@router.delete("/users/{user_id}/devices/{device_id}", response_model=RevokeDeviceResponse)
def revoke_user_device(
    user_id: str,
    device_id: str,
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_owner),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    """An owner may revoke one device of another account."""
    try:
        _, device = store.revoke_device(user_id, device_id)
    except (UnknownUserError, UnknownDeviceError):
        raise HTTPException(status_code=404, detail=f"Unknown device '{device_id}'")
    except LastDeviceError as e:
        raise HTTPException(status_code=422, detail=str(e))
    container.get_app_password_vault().forget({device.device_id})
    container.get_stems_service().queue.worker.revoke(device.device_id)
    logger.info("Device %s revoked by %s", device.device_id, owner)
    return {"success": True, "device": device.public(), "signedOutThisDevice": device.device_id == owner.device_id}


@router.get("/users/{user_id}/devices", response_model=DeviceListResponse)
def list_user_devices(
    user_id: str,
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_owner),
) -> dict:
    """Every device of **one account**, oldest first — owner-only.

    The per-account counterpart of ``GET /api/me/devices``: an owner's settings
    panel lists the accounts on the server and unfolds each one into its
    machines. ⚠ ``/api/users`` itself stays five keys per row
    (``tests/integration/test_response_contracts.py`` pins it and two shipped
    clients decode it), which is why the devices live on a route of their own
    rather than nested in that list.

    Same body shape as ``GET /api/me/devices``, ``isCurrent`` included, so a
    client renders both with one decoder. It can only be true on the owner's
    own account — the credential this request arrived with belongs to exactly
    one device of exactly one account — and it is the marker that lets the
    panel say "this phone" inside the owner's own row.

    Metadata only: nothing here reaches a digest. Unknown account → 404.
    """
    record = _record_for(store, user_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown user '{user_id}'")
    return {
        "devices": [
            {
                **device.public(),
                "helper": device.helper,
                "isCurrent": record.user_id == owner.user_id and device.device_id == owner.device_id,
            }
            for device in record.devices
        ]
    }
