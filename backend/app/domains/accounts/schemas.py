"""Response models for the account HTTP surface.

Keep the published camelCase fields and response descriptions stable.
Only mint responses carry plaintext credentials; no response carries digests.
See docs/security.md#account-routes.
"""
from __future__ import annotations


from typing import Literal

from pydantic import BaseModel


# ------------------------------------------------------------------ identity

class UserPublic(BaseModel):
    """A token holder, metadata only. Mirrors ``UserRecord.public()`` exactly.

    ⚠ The timestamps are **ISO-8601 UTC strings** (``2026-08-20T11:02:31Z``),
    not the POSIX floats the music and playlist payloads use. They are typed
    ``str`` rather than ``datetime`` on purpose: a ``datetime`` would round-trip
    through Pydantic and come back spelled ``+00:00``, changing bytes on the
    wire for no gain.
    """

    id: str
    label: str
    role: str
    createdAt: str | None = None
    lastSeenAt: str | None = None


class MeResponse(BaseModel):
    """``GET /api/me`` — who the auth gate decided the caller is.

    The five identity keys mirror :class:`UserPublic` field for field so a
    client can compare this body against a row of ``GET /api/users`` and mark
    its own — and know, before it asks, whether a revoke would destroy the
    credential it is holding.

    ``source`` says which *kind* of principal answered: ``token`` (a real row),
    ``shared-secret``, ``local``, ``anonymous`` or ``unknown``. The four
    sentinels have no row, so ``createdAt`` / ``lastSeenAt`` are ``null`` for
    them — inventing a ``createdAt`` would make a synthetic owner
    indistinguishable from a row that can actually be managed. They are also
    ``null`` in the one race where a real row was revoked between the gate and
    the handler.

    ``isOwner`` is derived from ``role`` and duplicated on purpose: it saves
    every client re-deriving the one rule that matters.
    """

    id: str
    label: str
    role: str
    isOwner: bool
    onboarded: bool = False
    source: str
    # The name this account signs in with, when it has one.
    #
    # Not the same string as ``label``, and clients kept showing the wrong
    # one. ``label`` names the *person or device* the credential belongs to
    # ("Robin (iPhone)", "MacBook Pro"); ``username`` is what you type into a
    # sign-in form. An account that predates password sign-in has none, and the
    # four sentinel principals have no row at all, so this is ``None`` for both.
    username: str | None = None
    createdAt: str | None = None
    lastSeenAt: str | None = None


class UserListResponse(BaseModel):
    """``GET /api/users`` — everyone who holds a token. Never the tokens."""

    users: list[UserPublic]


class CreateUserResponse(BaseModel):
    """``POST /api/users`` — 201.

    ⚠ ``token`` is the plaintext secret and this is the **only** moment it
    exists anywhere: the store keeps a SHA-256 digest and cannot reproduce it.
    A client that does not show it here has lost it.
    """

    user: UserPublic
    token: str


class RevokeUserResponse(BaseModel):
    """``DELETE /api/users/{user_id}`` — the row as it was when revoked."""

    success: bool
    user: UserPublic
    removedSongs: int
    freedBytes: int
    playlists: Literal["transferred", "deleted"]


class RemovableSongs(BaseModel):
    count: int
    bytes: int


class DeletionPreviewResponse(BaseModel):
    devices: int
    songs: int
    playlists: int
    removable: RemovableSongs
    kept: int


# --------------------------------------------------------------- my devices

class DevicePublic(BaseModel):
    """One credential of the calling account. Mirrors ``DeviceRecord.public()``.

    Shaped like :class:`UserPublic` minus ``role`` — a device does not have one,
    the account does — so a settings panel renders "people" and "my devices"
    with the same row component. Timestamps are ISO-8601 UTC strings for the
    same reason as above.

    ⚠ ``id`` is the one id on this surface a client is expected to send back
    (``DELETE /api/me/devices/{id}``). It names a device of the **caller's own
    account** and nothing else: the store looks a device up scoped to the
    principal, so an id from somebody else's account reads as absent rather than
    as forbidden.
    """

    id: str
    label: str
    createdAt: str | None = None
    lastSeenAt: str | None = None


    credentialType: Literal["app-password", "api-key"] | None = None
    firstSubsonicRequestAt: str | None = None
    lastSubsonicRequestAt: str | None = None
    subsonicClientName: str | None = None
    lastSubsonicFailureAt: str | None = None
    lastSubsonicFailure: Literal["wrong-mechanism"] | None = None


class DeviceListRow(DevicePublic):
    """A device as ``GET /api/me/devices`` lists it.

    ``isCurrent`` marks the credential this very request arrived with, so the UI
    can say "this one" and warn before the user signs the machine in their hand
    out. Exactly one row carries it — or none, in the race where the calling
    device was revoked between the gate and the handler.
    """

    isCurrent: bool = False
    helper: bool = False


class DeviceListResponse(BaseModel):
    """``GET /api/me/devices`` — the caller's own devices, oldest first."""

    devices: list[DeviceListRow]


class CreateDeviceResponse(BaseModel):
    """``POST /api/me/devices`` **and** ``POST /api/login`` — 201.

    ⚠ ``token`` is the plaintext secret and this is the **only** moment it
    exists anywhere, exactly as in :class:`CreateUserResponse`. It authenticates
    as the *same account* the caller is using — same library, same likes, same
    playlists — which is the entire point and also why it must be shown once and
    never logged.

    ⚠ **Deliberately shared with the login route**, not copied. The two differ
    only in what they made the caller prove — a token it already held, or a
    username and password — and both end in "this client now has a device
    token". One model means one decoder, one place a field can be renamed, and
    no chance of the two drifting into subtly different shapes for the same
    event. It also means nothing password-specific may be added here: a field
    that only login fills would be a field ``POST /api/me/devices`` has to
    explain.
    """

    device: DevicePublic
    token: str


class SignInResponse(BaseModel):
    """``GET /api/users/{id}/sign-in``: the name another account signs in with, for its owner.

    ``null`` when the account was made with only a token, so a reset has to give it a
    username in the same call. Kept off the account listing, whose rows shipped clients
    decode strictly.
    """

    username: str | None
    #: Whether the account has a password, so a client never shows one that isn't there.
    hasPassword: bool


class UsernameResponse(BaseModel):
    """``POST /api/me/username`` — the name as it was stored.

    Echoed back **as typed**, not as matched: the store keeps the case the
    person chose and compares ignoring it, so a client that assumed its own
    input was what got saved would show ``Robin`` where the server holds ``robin``.
    One key, and it stays one key — this is the only place on the whole surface a
    username appears, deliberately: ``UserPublic`` is pinned by
    ``tests/integration/test_response_contracts.py`` and decoded by two shipped
    clients, so the field could not be added there without breaking them.
    """

    username: str


class LabelResponse(BaseModel):
    """``POST /api/me/label`` and ``POST /api/users/{id}/label`` — the row after.

    The whole ``UserPublic`` rather than one key: a rename changes what every
    list on every client shows for this account, and the caller is about to
    redraw that row.
    """

    user: UserPublic


class PasswordChangeResponse(BaseModel):
    """``POST /api/me/password`` — it worked, and what it did *not* do.

    ⚠ ``otherDevicesSignedOut`` is always ``false`` and exists to say so out
    loud. Changing a password here does not revoke anything — the reasoning is
    on the route — and the one thing a user is entitled to assume after changing
    a password is that they have just evicted whoever they were worried about.
    They have not. A client that shows this field, and ``deviceCount`` beside it,
    can send them to the device list, which is where evicting somebody actually
    happens.

    ``deviceCount`` is every device on the account, including the one making the
    request, so "3 devices are still signed in" is literally true.
    """

    success: bool
    otherDevicesSignedOut: bool
    deviceCount: int


class RevokeDeviceResponse(BaseModel):
    """``DELETE /api/me/devices/{id}`` — the device as it was when revoked.

    ⚠ ``signedOutThisDevice`` is ``true`` when the caller revoked the credential
    it is holding. That is a supported thing to do — it is how "sign this phone
    out" works — but every subsequent request from this client will be a 401,
    and a client that rendered that as a server fault would be showing a bug
    where it should be showing a login screen.
    """

    success: bool
    device: DevicePublic
    signedOutThisDevice: bool


class SignInCodeResponse(BaseModel):
    code: str
    secret: str
    expiresIn: int
    pollInterval: int


class SignInCodePollResponse(BaseModel):
    credential: CreateDeviceResponse | None = None
    declined: bool | None = None


class SignInRequestResponse(BaseModel):
    id: str
    deviceLabel: str
    network: Literal["local", "vpn"]
    createdAt: str
    expiresAt: str
    code: str


class SignInRequestsResponse(BaseModel):
    requests: list[SignInRequestResponse]


class SuccessResponse(BaseModel):
    success: bool


class OnboardedResponse(BaseModel):
    onboarded: bool
