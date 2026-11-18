"""Sign-in code creation, polling, inspection and account decisions.

Only a real account approves; only the polling secret redeems a token.
Retain network restrictions, expiry and attempt limits.
See docs/security.md#sign-in-codes.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.dependencies import DependencyContainer, conditional, get_container
from app.domains.accounts.identity import (
    Principal,
)
from app.domains.accounts.requests import (
    ApproveSignInCodeRequest,
    PollSignInCodeRequest,
    SignInCodeRequest,
)
from app.domains.accounts.schemas import (
    SignInCodePollResponse,
    SignInCodeResponse,
    SignInRequestResponse,
    SignInRequestsResponse,
    SuccessResponse,
)
from app.domains.accounts.sign_in_code import CodeRateLimit, DeclinedCode, InvalidCode
from app.infra import remote_access
from app.infra.identity import require_account

router = APIRouter()
logger = logging.getLogger("app.domains.accounts.routes")


def _code_limited() -> HTTPException:
    return HTTPException(
        status_code=429, detail="Too many code attempts. Try again in a minute.", headers={"Retry-After": "60"}
    )


@router.post("/sign-in-code", status_code=201, response_model=SignInCodeResponse)
def request_sign_in_code(
    body: SignInCodeRequest,
    request: Request,
    container: DependencyContainer = Depends(get_container),
) -> dict:
    networks, gateway = remote_access.local_topology()
    via = remote_access.outside_via(
        request.client.host if request.client else "",
        networks,
        gateway,
        any(header in request.headers for header in ("x-forwarded-for", "forwarded")),
    )
    if via not in ("local", "vpn", "tailscale"):
        raise HTTPException(status_code=403, detail="outside-network")
    try:
        return container.get_sign_in_codes().request(
            body.deviceLabel, body.username, "local" if via == "local" else "vpn"
        )
    except CodeRateLimit as error:
        raise _code_limited() from error


@router.post("/sign-in-code/poll", response_model=SignInCodePollResponse, response_model_exclude_unset=True)
def poll_sign_in_code(
    body: PollSignInCodeRequest,
    container: DependencyContainer = Depends(get_container),
) -> dict:
    try:
        return {"credential": container.get_sign_in_codes().poll(body.secret)}
    except DeclinedCode:
        return {"declined": True}
    except CodeRateLimit as error:
        raise _code_limited() from error


@router.post("/me/sign-in-code", response_model=SuccessResponse)
def approve_sign_in_code(
    body: ApproveSignInCodeRequest,
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    try:
        container.get_sign_in_codes().approve(body.code, principal.user_id)
    except CodeRateLimit as error:
        raise _code_limited() from error
    except InvalidCode as error:
        raise HTTPException(status_code=404, detail="Code not available.") from error
    return {"success": True}


@router.get("/me/sign-in-requests", response_model=SignInRequestsResponse)
@conditional(('signin',))
def list_sign_in_requests(
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    return {"requests": container.get_sign_in_codes().requests(principal.user_id)}


def _decide_sign_in_request(
    request_id: str, principal: Principal, container: DependencyContainer, decline: bool
) -> dict:
    try:
        container.get_sign_in_codes().decide(request_id, principal.user_id, decline=decline)
    except CodeRateLimit as error:
        raise _code_limited() from error
    except InvalidCode as error:
        raise HTTPException(status_code=404, detail="Code not available.") from error
    return {"success": True}


@router.post("/me/sign-in-requests/{request_id}/approve", response_model=SuccessResponse)
def approve_sign_in_request(
    request_id: str,
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    return _decide_sign_in_request(request_id, principal, container, False)


@router.post("/me/sign-in-requests/{request_id}/decline", response_model=SuccessResponse)
def decline_sign_in_request(
    request_id: str,
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    return _decide_sign_in_request(request_id, principal, container, True)


@router.get("/me/sign-in-code/{code}", response_model=SignInRequestResponse)
def inspect_sign_in_code(
    code: str,
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    """Possession of the typed code opens its facts, never approves it."""
    try:
        return container.get_sign_in_codes().inspect(code, principal.user_id)
    except CodeRateLimit as error:
        raise _code_limited() from error
    except InvalidCode as error:
        raise HTTPException(status_code=404, detail="Code not available.") from error


@router.post("/me/sign-in-code/{code}/decline", response_model=SuccessResponse)
def decline_typed_sign_in_code(
    code: str,
    principal: Principal = Depends(require_account),
    container: DependencyContainer = Depends(get_container),
) -> dict:
    try:
        container.get_sign_in_codes().decline_code(code, principal.user_id)
    except CodeRateLimit as error:
        raise _code_limited() from error
    except InvalidCode as error:
        raise HTTPException(status_code=404, detail="Code not available.") from error
    return {"success": True}
