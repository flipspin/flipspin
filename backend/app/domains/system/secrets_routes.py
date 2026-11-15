"""Owner-only metadata API; secret values only travel into the nest."""
from typing import Literal
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, SecretStr

from app.config import ConfigManager
from app.dependencies import authorize_key_export, get_config
from app.infra.identity import Principal, require_owner
from app.infra.secrets import SecretUnreadableError
from app.providers.secret_settings import change

router = APIRouter(prefix="/api/server/secrets", tags=["secrets"])


class SecretStatus(BaseModel):
    name: str
    state: Literal["falta", "guardada", "rechazada", "ilegible"]
    source: Literal["app", "env", "file"]
    locked: bool
    verifiedAt: str | None
    reason: str | None


class SecretKeyStatus(BaseModel):
    fingerprint: str | None
    source: Literal["credentials-dir", "key-file", "generated"]


class SecretsStatus(BaseModel):
    secrets: list[SecretStatus]
    key: SecretKeyStatus
    counts: "SecretCounts"


class SecretCounts(BaseModel):
    sources: int
    appPasswords: int | None


class SecretRequest(BaseModel):
    value: SecretStr


@router.get("", response_model=SecretsStatus)
def status(config: ConfigManager = Depends(get_config), principal: Principal = Depends(require_owner)):
    return config.secrets.describe_all()


@router.post("/key/export", response_class=Response, responses={
    200: {"content": {"application/octet-stream": {"schema": {"type": "string", "format": "binary"}}}},
})
def export_key(config: ConfigManager = Depends(get_config),
               principal: Principal = Depends(authorize_key_export)):
    try:
        ring = config.secrets.export_key()
    except SecretUnreadableError:
        raise HTTPException(409, "llave-distinta") from None
    fingerprint = config.secrets.key_info["fingerprint"]
    logging.getLogger(__name__).info("Nest key exported by %s at %s", principal.user_id, datetime.now(UTC).isoformat())
    return Response(ring, media_type="application/octet-stream", headers={
        "Content-Disposition": f'attachment; filename="krobi-nido-{fingerprint}.key"',
        "Cache-Control": "no-store",
    })


@router.put("/{name}", response_model=SecretStatus)
def put(name: str, body: SecretRequest, config: ConfigManager = Depends(get_config),
        principal: Principal = Depends(require_owner)):
    value = body.value.get_secret_value().strip()
    if not value or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        # Masks use non-ASCII bullets; they are an explicit keep operation.
        from app.infra.secrets import is_mask
        if not is_mask(value):
            raise HTTPException(422, {"code": "invalid-secret"})
    change(config, {name: value}, actor=principal.user_id)
    return config.secrets.describe(name)


@router.delete("/{name}", response_model=SecretStatus)
def delete(name: str, config: ConfigManager = Depends(get_config), principal: Principal = Depends(require_owner)):
    change(config, {name: None}, actor=principal.user_id)
    return config.secrets.describe(name)
