"""Owner account administration and deletion routes.

Preserve the real-owner gates and last-owner protection.
Deletion preview and execution share file eligibility rules.
See docs/security.md#owner-and-member-roles.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import DependencyContainer, get_container, get_token_store
from app.domains.accounts.deletion import removable_files
from app.domains.accounts.identity import (
    ROLES,
    IdentityError,
    LastOwnerError,
    Principal,
    TokenStore,
    UnknownUserError,
    normalize_role,
)
from app.domains.accounts.requests import (
    CreateUserRequest,
    SetLabelRequest,
)
from app.domains.accounts.routes_profile import _record_for
from app.domains.accounts.schemas import (
    CreateUserResponse,
    DeletionPreviewResponse,
    LabelResponse,
    RevokeUserResponse,
    UserListResponse,
)
from app.domains.playlists.ownership import account_playlists, settle_account_playlists
from app.infra.identity import require_account, require_owner

router = APIRouter()
logger = logging.getLogger("app.domains.accounts.routes")


@router.get("/users", response_model=UserListResponse)
def list_users(
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_owner),
) -> dict:
    """Everyone who holds a token — metadata only, never the tokens."""
    return {"users": [record.public() for record in store.list_users()]}


def require_account_owner(principal: Principal = Depends(require_account)) -> Principal:
    return require_owner(principal)


@router.post("/users/{user_id}/label", response_model=LabelResponse)
def set_user_label(
    user_id: str,
    body: SetLabelRequest,
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_account_owner),
) -> dict:
    """Rename one account, as its owner sees it in the household list.

    The owner-side twin of ``POST /api/me/label``, for the same reason
    ``/users/{id}/devices`` exists beside ``/me/devices``: the accounts an owner
    minted for other people were also named after a device, and the person
    holding that phone may never open their own settings. Metadata only.
    Unknown account → 404.
    """
    if _record_for(store, user_id) is None:
        raise HTTPException(status_code=404, detail=f"Unknown user '{user_id}'")
    try:
        account = store.set_label(user_id, body.label)
    except UnknownUserError:
        raise HTTPException(status_code=404, detail=f"Unknown user '{user_id}'")
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    logger.info("Owner %s renamed account %s", owner.user_id, user_id)
    return {"user": account.public()}


@router.post("/users", status_code=201, response_model=CreateUserResponse)
def create_user(
    body: CreateUserRequest,
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_account_owner),
) -> dict:
    """Mint a token. ``token`` in the response is the only time it exists."""
    if body.role and normalize_role(body.role) != body.role.strip().lower():
        raise HTTPException(status_code=422, detail=f"role must be one of {', '.join(ROLES)}")
    try:
        record, token = store.mint(body.label, body.role)
    except IdentityError as e:
        raise HTTPException(status_code=422, detail=str(e))
    logger.info("Access token minted for %r (%s) by %s", record.label, record.role, owner)
    return {"user": record.public(), "token": token}


@router.get("/users/{user_id}/deletion-preview", response_model=DeletionPreviewResponse)
def deletion_preview(
    user_id: str,
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_owner),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    record = store.get_user(user_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Unknown user '{user_id}'")
    tracks = container.get_user_track_store()
    rows = tracks.list_for_user(user_id)
    files = removable_files(user_id, store, tracks, container.config.base_music_dir)
    return {
        "devices": len(record.devices),
        "songs": len(rows),
        "playlists": len(account_playlists(container.get_playlist_repository(), user_id)),
        "removable": {"count": len(files), "bytes": sum(size for _, size in files)},
        "kept": len(rows) - len(files),
    }


@router.delete("/users/{user_id}", response_model=RevokeUserResponse)
def revoke_user(
    user_id: str,
    songs: bool = False,
    store: TokenStore = Depends(get_token_store),
    owner: Principal = Depends(require_account_owner),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    """Revoke a token. 422 rather than a silent no-op on the last owner."""
    try:
        record = store.revoke(user_id)
    except UnknownUserError:
        raise HTTPException(status_code=404, detail=f"Unknown user '{user_id}'")
    except LastOwnerError as e:
        raise HTTPException(status_code=422, detail=str(e))
    container.get_app_password_vault().forget({device.device_id for device in record.devices})
    for device in record.devices:
        container.get_stems_service().queue.worker.revoke(device.device_id)
    logger.info("Access token for %r revoked by %s", record.label, owner)
    removed = freed = 0
    # Revocation (including the last-owner refusal) precedes every cleanup write.
    # Cleanup is best effort once credentials are gone: never turn that success
    # into a 500 because a file or a playlist could not be removed.
    tracks = container.get_user_track_store()
    files = []
    if songs:
        try:
            files = removable_files(user_id, store, tracks, container.config.base_music_dir)
        except Exception:
            logger.exception("Could not compute songs for revoked account %s", user_id)
    try:
        tracks.remove_user(user_id)
    except Exception:
        logger.exception("Could not remove library rows of revoked account %s", user_id)
    try:
        settle_account_playlists(container.get_playlist_repository(), user_id, owner.user_id, delete=songs)
    except Exception:
        logger.exception("Could not settle playlists of revoked account %s", user_id)
    for path, _ in files:
        try:
            size = path.stat().st_size
            music = container.get_music_service()
            music.delete_track(path)
        except Exception:
            logger.exception("Could not delete song %s of revoked account %s", path, user_id)
            continue
        removed += 1
        freed += size
        try:
            music.music_repo.invalidate_scan()
        except Exception:
            logger.exception("Could not invalidate scan after deleting %s", path)
    return {
        "success": True,
        "user": record.public(),
        "removedSongs": removed,
        "freedBytes": freed,
        "playlists": "deleted" if songs else "transferred",
    }
