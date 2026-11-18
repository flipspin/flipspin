"""Password recheck for privileged credential exports.

Apply the shared login throttle and require a real owner password.
Verification authorizes the export without minting another device.
See docs/security.md#password-hashing.
"""
from fastapi import Depends, HTTPException
from pydantic import BaseModel, Field, SecretStr

from app.domains.accounts import passwords
from app.domains.accounts.identity import TokenStore
from app.infra.identity import Principal, get_token_resolver, is_real_user, require_owner


class KeyExportRequest(BaseModel):
    password: SecretStr = Field(max_length=passwords.MAX_PASSWORD_LENGTH)


def authorize_key_export(
    body: KeyExportRequest,
    principal: Principal = Depends(require_owner),
    store: TokenStore = Depends(get_token_resolver),
) -> Principal:
    wait = passwords.login_throttle.retry_after()
    if wait is not None:
        raise HTTPException(429, {"code": "password-rate-limited"}, headers={"Retry-After": str(wait)})
    account = store.get_user(principal.user_id) if is_real_user(principal) else None
    stored = account.password_hash if account else None
    matched = passwords.verify_password(body.password.get_secret_value(), stored)
    if not stored:
        raise HTTPException(409, "account-password-required")
    if not matched:
        passwords.login_throttle.record_failure()
        raise HTTPException(401, {"code": "incorrect-password"})
    return principal
