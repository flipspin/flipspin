"""Expose the calling account's library references and listening events.

Derive identity from the principal; removing references never removes audio.
See docs/DEVELOPER_GUIDE.md#personal-library-persistence.
"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from datetime import UTC, datetime
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field, field_validator, model_serializer

from app.config import ConfigManager
from app.infra.identity import current_principal
from app.infra.identity import Principal, is_real_user
from app.domains.user_library.schemas import (
    AddToLibraryResponse,
    MissingLibraryResponse,
    MyLibraryResponse,
    MyOwnershipResponse,
    RemoveFromLibraryResponse,
    UserTrackRow,
    PlayHistoryResponse,
)
from app.domains.user_library.store import (
    MAX_BATCH,
    InvalidRelPathError,
    UnknownUserTrackError,
    UserTrackStore,
    normalize_batch,
    normalize_rel_path,
)
from app.dependencies import conditional, get_config, get_playlist_service, get_user_track_store
from app.exceptions import ValidationError
from app.utils.library_paths import resolve_rel_path

from app.infra.idempotency import idempotent
from .plays import history, record_batch, valid_time

router = APIRouter(prefix="/api/me", tags=["user-library"])
logger = logging.getLogger(__name__)

# ``SENTINEL_PRINCIPALS`` / ``is_real_user`` live in ``identity`` beside the
# sentinel objects themselves: acquisition (``app/domains/user_library/acquisition_links.py``)
# now asks the same question, and two copies of that set would drift the day a
# fifth sentinel appears. Membership is by identity, not by ``user_id`` string —
# exactly as ``identity_routes.SENTINEL_SOURCES`` does — so a minted row labelled
# "local client" cannot impersonate one.

_NO_LIBRARY_DETAIL = (
    "This credential is not a per-user token, so it has no library of its own. "
    "Mint one with POST /api/users and call again with it."
)


class RelPathsRequest(BaseModel):
    relPaths: list[str] = Field(default_factory=list)


class PatchRequest(BaseModel):
    relPath: str
    liked: bool | None = None
    offline: bool | None = None


class PlayDetails(BaseModel):
    startedAt: datetime | None = None
    playedSeconds: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    completed: bool = True
    source: Literal['desktop', 'phone'] | None = None

    @model_serializer(mode='wrap')
    def serialize_details(self, handler):
        # Existing 24-hour idempotency receipts hash the old request models.
        # Omitted additions must not change that hash across a server upgrade.
        values = handler(self)
        for name in ('startedAt', 'playedSeconds', 'completed', 'source'):
            if name not in self.model_fields_set:
                values.pop(name, None)
        return values

    @field_validator('startedAt')
    @classmethod
    def started_time(cls, value):
        return valid_time(value) if value is not None else value


class PlayRequest(PlayDetails):
    relPath: str


def require_real_user(principal: Principal = Depends(current_principal)) -> Principal:
    """The caller must be a real row in ``users.json``. See "Sentinel principals"."""
    if not is_real_user(principal):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_NO_LIBRARY_DETAIL)
    return principal


def _clean(rel_path: object) -> str:
    """One path, or a 422 naming what was wrong with it."""
    try:
        return normalize_rel_path(rel_path)
    except InvalidRelPathError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _clean_batch(rel_paths: list[str]) -> list[str]:
    """A whole batch, or a 4xx.

    A malformed entry fails the *request* rather than being quietly filed under
    ``missing``: it cannot exist on disk, so calling it missing would report a
    client bug as a fact about the library and nobody would ever fix it.
    """
    if len(rel_paths) > MAX_BATCH:
        raise ValidationError(f"Too many paths in one request (max {MAX_BATCH})")
    try:
        return normalize_batch(rel_paths)
    except InvalidRelPathError as e:
        raise HTTPException(status_code=422, detail=str(e))


def _on_disk(config: ConfigManager, rel_path: str) -> bool:
    """Whether the shared catalog actually holds this file, right now.

    ``rel_path`` is already known to be two clean segments, so this cannot
    traverse; it is still joined under ``base_music_dir`` and re-checked, because
    the day someone relaxes :func:`normalize_rel_path` this is the line that has
    to still be true. Reads ``config.base_music_dir`` on every call rather than
    caching it — ``POST /api/set-basedir`` moves it at runtime.
    """
    try:
        return resolve_rel_path(Path(config.base_music_dir), rel_path).is_file()
    except ValidationError:
        return False


def library_account(accountId: str | None = None, principal: Principal = Depends(require_real_user)):
    return _library_account(accountId, principal)


@router.get("/library", response_model=MyLibraryResponse)
@conditional(('me:<account>', 'library', 'analysis'))
def my_library(
    accountId: str = Depends(library_account),
    store: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(require_real_user),
) -> dict:
    """Keep every ownership row on its pinned wire keys.

    Owners can inspect a person's library for the Biblioteca scope picker.
    Members can only read their own rows; a missing file never removes a row.
    """
    return library_snapshot(store, accountId)


def library_snapshot(store, account_id):
    rows = store.list_for_user(account_id)
    return {"tracks": [row.public() for row in rows], "count": len(rows)}


def _library_account(account_id: str | None, principal: Principal) -> str:
    if account_id and account_id != principal.user_id and not principal.is_owner:
        raise HTTPException(status_code=403, detail="Owner required")
    return account_id or principal.user_id


@router.get("/library/missing", response_model=MissingLibraryResponse)
def missing_library(
    request: Request,
    response: Response,
    accountId: str | None = None,
    store: UserTrackStore = Depends(get_user_track_store),
    config: ConfigManager = Depends(get_config),
    principal: Principal = Depends(require_real_user),
):
    """List the account's owned paths whose files are gone; owner or self only."""
    rows = store.list_for_user(_library_account(accountId, principal))
    body = {"relPaths": [row.rel_path for row in rows if not _on_disk(config, row.rel_path)]}
    etag = '"' + hashlib.sha256(json.dumps(body, ensure_ascii=False).encode()).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    tags = request.headers.get("if-none-match", "").split(",")
    if any(tag.strip().removeprefix("W/") in (etag, "*") for tag in tags):
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)
    return body


@router.post("/library", response_model=AddToLibraryResponse)
@idempotent
def add_to_my_library(
    request: Request,
    body: RelPathsRequest,
    store: UserTrackStore = Depends(get_user_track_store),
    config: ConfigManager = Depends(get_config),
    principal: Principal = Depends(require_real_user),
) -> dict:
    """Claim tracks that already exist in the shared catalog.

    **The dedupe hit, and the point of the whole feature.** The bytes are on the
    server already, so becoming this user's costs one row: no download, no
    yt-dlp, no queue, no wait. Anything not on disk comes back in ``missing``
    with a 200 — see the module docstring.

    Idempotent: a path the caller already holds lands in ``already`` and its
    existing row (``addedAt``, ``liked``, ``playCount``) is left exactly as it
    was. Re-adding is not a reset.
    """
    rel_paths = _clean_batch(body.relPaths)
    present, missing = [], []
    for rel_path in rel_paths:
        (present if _on_disk(config, rel_path) else missing).append(rel_path)
    added, already = store.add_many(principal.user_id, present)
    return {"added": added, "already": already, "missing": missing}


@router.delete("/library", response_model=RemoveFromLibraryResponse)
@idempotent
def remove_from_my_library(
    request: Request,
    body: RelPathsRequest,
    store: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(require_real_user),
    config: ConfigManager = Depends(get_config),
    playlists=Depends(get_playlist_service),
) -> dict:
    """Drop this caller's references. **The files stay on disk.**

    ⚠ Not ``POST /api/delete-track``. That endpoint unlinks the audio and every
    member loses it; this one forgets a row and the same ``POST /api/me/library``
    call brings it straight back. Only playlist JSON is rewritten; shared
    audio is never removed by this operation.

    Paths the caller does not hold are simply absent from ``removed``, so a
    retried DELETE is harmless.
    """
    rel_paths = _clean_batch(body.relPaths)
    removed = store.remove_many(principal.user_id, rel_paths)
    updated = playlists.remove_library_tracks(
        [resolve_rel_path(config.base_music_dir, rel) for rel in rel_paths], owner_id=principal.user_id,
    )
    return {"removed": removed, "playlistsUpdated": updated}


@router.patch("/library", response_model=UserTrackRow)
@idempotent
def patch_my_row(
    request: Request,
    body: PatchRequest,
    store: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(require_real_user),
    config: ConfigManager = Depends(get_config),
) -> dict:
    """Set ``liked`` / ``offline`` on one row. Absent or null leaves it alone.

    404 when the caller holds no such row: liking a track you have not added is
    meaningless, and upserting here would be a second add verb — one that skips
    the on-disk check ``POST /api/me/library`` exists to do.
    """
    rel_path = _clean(body.relPath)
    try:
        row = store.update_flags(
            principal.user_id, rel_path, liked=body.liked, offline=body.offline
        )
    except UnknownUserTrackError:
        raise HTTPException(status_code=404, detail=f"Not in your library: {rel_path}")
    return row.public()


class BatchPlay(PlayDetails):
    trackKey: str
    listenedAt: datetime
    clientPlayId: str = Field(min_length=1, max_length=200)

    _time = field_validator('listenedAt')(valid_time)


class PlaysBatch(BaseModel):
    plays: list[BatchPlay] = Field(min_length=1, max_length=50)


class PlaysAccepted(BaseModel):
    accepted: int


@router.post("/plays", response_model=UserTrackRow | PlaysAccepted)
@idempotent
def record_play(
    body: PlayRequest | PlaysBatch | list[BatchPlay],
    request: Request,
    store: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(require_real_user),
    config: ConfigManager = Depends(get_config),
) -> dict:
    agent = request.headers.get('user-agent', '').lower()
    source = 'phone' if any(name in agent for name in ('iphone', 'ipad', 'android', 'cfnetwork', 'okhttp')) else 'desktop'
    if isinstance(body, PlayRequest):
        rel_path = _clean(body.relPath)
        if store.get(principal.user_id, rel_path) is None:
            raise HTTPException(404, 'Not in your library')
        play = BatchPlay(trackKey=rel_path, listenedAt=datetime.now(UTC), clientPlayId=str(uuid.uuid4()),
                         **body.model_dump(exclude={'relPath'}))
        record_batch(config.jobs_file, store, principal.user_id, [play], source=source, device_id=principal.device_id)
        return store.get(principal.user_id, rel_path).public()
    plays = body.plays if isinstance(body, PlaysBatch) else body
    if not 1 <= len(plays) <= 50:
        raise HTTPException(422, 'Expected 1 to 50 plays')
    for play in plays:
        _clean(play.trackKey)
    return record_batch(config.jobs_file, store, principal.user_id, plays, source=source, device_id=principal.device_id)


@router.get('/plays/history', response_model=PlayHistoryResponse)
def play_history(
    start: datetime | None = Query(None, alias='from'),
    end: datetime | None = Query(None, alias='to'),
    after: str | None = Query(None, min_length=1, max_length=64),
    limit: int = Query(100, ge=1, le=500),
    principal: Principal = Depends(require_real_user),
    config: ConfigManager = Depends(get_config),
) -> dict:
    """Export the calling owner's history, including missing and removed songs.

    Bounds are timezone-aware instants: inclusive from, exclusive to.
    Follow nextCursor as after for the next page, retaining the same bounds.
    """
    if not principal.is_owner:
        raise HTTPException(403, 'Owner required')
    if any(value is not None and value.tzinfo is None for value in (start, end)):
        raise HTTPException(422, 'History bounds must include a timezone')
    if start is not None and end is not None and start >= end:
        raise HTTPException(422, 'from must precede to')
    try:
        return history(config.jobs_file, principal.user_id, start=start, end=end, after=after, limit=limit)
    except ValueError as error:
        raise HTTPException(422, str(error))


@router.post("/library/ownership", response_model=MyOwnershipResponse)
def check_my_ownership(
    body: RelPathsRequest,
    store: UserTrackStore = Depends(get_user_track_store),
    principal: Principal = Depends(require_real_user),
) -> dict:
    """Which of these does the caller already hold?

    **Answers positionally**, the same convention as ``POST /api/library/ownership``
    in ``domains/music/routes.py``: ``results[i]`` is the verdict for
    ``relPaths[i]``, always, and the list is never filtered or reordered — a
    client drawing ownership markers by index would draw them on the wrong rows.
    ``relPath`` is echoed on each result so a misalignment is detectable rather
    than silent.

    Note the two ownership endpoints answer different questions and both are
    needed: the one in ``music`` asks whether the *library* has a catalog track
    (fuzzy, by title/artist), this one asks whether *you* have a known file
    (exact, by ``relPath``).

    Repeats are answered in place rather than de-duplicated — positional means
    positional.
    """
    if not body.relPaths:
        return {"results": []}
    if len(body.relPaths) > MAX_BATCH:
        raise ValidationError(f"Too many paths in one request (max {MAX_BATCH})")
    rel_paths = [_clean(p) for p in body.relPaths]
    verdicts = store.owns_many(principal.user_id, rel_paths)
    return {
        "results": [
            {"relPath": rel_path, "owned": owned}
            for rel_path, owned in zip(rel_paths, verdicts, strict=True)
        ]
    }
