"""Request models for the accounts HTTP surface.

Keep field names, validation and published model descriptions stable.
The authenticated principal supplies the account for self-service requests.
See docs/security.md#account-routes.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from app.domains.accounts import passwords
from app.domains.accounts.identity import (
    ROLE_MEMBER,
    IdentityError,
    clean_device_label,
)
from app.infra import instance as nest_instance


class CreateUserRequest(BaseModel):
    """``POST /api/users``. ``username`` and ``password`` are optional and must come together.

    With them the person can sign in by name from the start (and add app passwords for
    Subsonic clients); without them the account has only the one-time token.
    """

    label: str = Field(..., min_length=1, max_length=80)
    role: str = ROLE_MEMBER
    username: str | None = Field(default=None, max_length=256)
    password: str | None = Field(default=None, max_length=passwords.MAX_PASSWORD_LENGTH)


class AddDeviceRequest(BaseModel):
    """``POST /api/me/devices``.

    There is no ``userId``: the account always comes from the caller.
    ``helper`` optionally enrolls a processing device (owners only); an absent
    flag also recognizes the desktop's historical worker label. The account comes
    from the credential the request arrived with, so a body cannot aim a freshly
    minted token at somebody else's library. Same limits as
    :class:`CreateUserRequest` so a client reuses its validation.
    """

    label: str = Field(..., min_length=1, max_length=80)
    helper: bool | None = None


class RenameDeviceRequest(BaseModel):
    """A display name, scoped to the caller's device by the route."""

    label: str = Field(..., min_length=1, max_length=80)

    @field_validator("label", mode="before")
    @classmethod
    def _clean(cls, value: object) -> str:
        try:
            return clean_device_label(value)
        except IdentityError as e:
            raise ValueError(str(e)) from e


class LoginRequest(BaseModel):
    """``POST /api/login``.

    ⚠ **The validation here is length only, never shape.** A username that could
    not possibly exist — spaces, an ``@``, three hundred characters of nothing —
    must produce the same 401 as one that merely does not exist, and a pydantic
    ``422`` for "that is not a valid username" would tell an attacker which
    shapes are worth guessing before they spend a single attempt. So the field
    limits exist to bound the work (see ``passwords.MAX_PASSWORD_LENGTH``: the
    KDF runs on whatever arrives, on a public route) and nothing else; the store
    normalizes and looks up whatever it is handed.

    ``deviceLabel`` is optional and names the machine in the household's device
    list. It is the only cosmetic field on this body and it must stay cosmetic:
    ⚠ there is no ``userId`` and there must never be one, exactly as in
    :class:`AddDeviceRequest` — the account comes from the password, so a body
    that could also name an account would be a body that mints a token for
    somebody else.
    """

    username: str = Field(..., max_length=256)
    password: str = Field(..., max_length=passwords.MAX_PASSWORD_LENGTH)
    deviceLabel: str | None = Field(None, max_length=80)


class SetUsernameRequest(BaseModel):
    """``POST /api/me/username``. The name the caller's own account signs in with.

    No ``userId``, for the reason in :class:`AddDeviceRequest`: the account comes
    off the credential the request arrived with. The bound here is generous
    because the real rules live in ``identity.clean_username`` and produce a
    sentence the user can act on; a pydantic length error would only say "string
    too long".
    """

    username: str = Field(..., max_length=256)


class SetLabelRequest(BaseModel):
    """``POST /api/me/label`` and ``POST /api/users/{id}/label``.

    The name the household sees for an account — «Robin» — as opposed to
    ``username``, the name typed into a sign-in form. Same bound as
    :class:`CreateUserRequest`, because it is the same field.
    """

    label: str = Field(..., min_length=1, max_length=80)


class ChangePasswordRequest(BaseModel):
    """``POST /api/me/password``.

    ``currentPassword`` is optional **in the schema** and required by the store
    whenever there is one to check — see ``TokenStore.set_password`` for why an
    account that never had a password cannot be asked for it, and why that is
    not a bypass. A client should send it whenever it has it; sending one to an
    account that has none is ignored, not refused.
    """

    currentPassword: str | None = Field(None, max_length=passwords.MAX_PASSWORD_LENGTH)
    newPassword: str = Field(..., max_length=passwords.MAX_PASSWORD_LENGTH)


class ClaimRequest(BaseModel):
    """``POST /api/claim``.

    ``label`` is what the owner's row will be called, exactly as in
    ``CreateUserRequest`` — same field, same limits, so a client can reuse its
    validation. There is no ``role``: the first account is an owner or the claim
    achieved nothing (see ``TokenStore.claim_first_owner``).

    ``username`` and ``password`` create the first account already recoverable,
    which is the point: the household that has just claimed a server is the one
    with exactly one device holding exactly one token, and losing that phone
    before setting a password is how somebody ends up locked out of a library
    they own. ⚠ They are nevertheless **optional and additive**, because a
    desktop client shipped before this feature posts ``{label}`` and nothing
    else — a claim that started answering 422 to it would break the one flow
    this route exists for, on the deployments least able to notice. Passing one
    without the other is refused, since it can only be a client bug.

    ``setupToken`` is required only when the server says so — ``GET /api/status``
    publishes ``setupTokenRequired`` while the window is open precisely so the
    setup screen asks for it exactly when it is needed and never otherwise. It
    travels in the body rather than the query string on purpose: query strings
    land in access logs and browser history, and this one buys ownership of the
    library. camelCase to match the rest of this surface (see ``accounts/schemas.py``).

    ``nestName`` names the server itself (``GET /api/status``'s ``name``) — the
    desktop sends «Nido de <computer name>». ⚠ Purely cosmetic and therefore
    **never a reason to refuse the claim**: a value that is not a usable name
    (wrong type, empty, too long, control characters) is dropped here and the
    server keeps its default name.
    """

    label: str = Field(..., min_length=1, max_length=80)
    setupToken: str | None = None
    username: str | None = Field(None, max_length=256)
    password: str | None = Field(None, max_length=passwords.MAX_PASSWORD_LENGTH)
    nestName: str | None = None

    @field_validator("nestName", mode="before")
    @classmethod
    def _drop_unusable_nest_name(cls, value: object) -> str | None:
        try:
            return nest_instance.clean_nest_name(value) if value is not None else None
        except nest_instance.InvalidNestNameError:
            return None


class ResetPasswordRequest(BaseModel):
    """``POST /api/users/{id}/password``. ``username`` gives a token-only account the name it
    signs in with, in the same call; it is used only when the account has none yet."""

    newPassword: str = Field(..., max_length=passwords.MAX_PASSWORD_LENGTH)
    username: str | None = Field(default=None, max_length=256)


class SignInCodeRequest(BaseModel):
    username: str | None = Field(default=None, max_length=256)
    deviceLabel: str = Field(..., min_length=1, max_length=80)

    @field_validator("deviceLabel")
    @classmethod
    def _label(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A device name is required.")
        return value.strip()


class PollSignInCodeRequest(BaseModel):
    secret: str = Field(..., min_length=1, max_length=128)


class ApproveSignInCodeRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=32)
