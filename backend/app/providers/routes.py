"""Expose provider listing, toggles, and ordering through authenticated routes.

The composition root attaches authentication. Payload key names remain stable
for the Settings client; optional extensions use separate host contracts.
"""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, SecretStr

from app.dependencies import get_provider_registry, get_config, get_container
from app.config import ConfigManager
from app.exceptions import FailureKind
from app.domains.acquisition.sources.status import SourceStatus
from app.domains.acquisition.sources.compat import LEGACY_SOURCE_ID
from app.providers.secret_settings import change
from app.infra.secrets import is_mask
from app.infra.identity import current_principal, require_owner
from app.infra.identity import Principal
from app.providers.registry import (
    InvalidOrderError,
    LastEnabledProviderError,
    ProviderKind,
    ProviderRegistry,
    ProviderStatus,
    UnknownProviderError,
)

router = APIRouter(prefix="/api", tags=["providers"])
logger = logging.getLogger(__name__)


class GeniusCredentialsRequest(BaseModel):
    apiKey: SecretStr


class GeniusCredentialsStatus(BaseModel):
    configured: bool
    canManage: bool


@router.get("/config/genius", response_model=GeniusCredentialsStatus)
def genius_credentials_status(
    config: ConfigManager = Depends(get_config),
    principal: Principal = Depends(current_principal),
):
    return GeniusCredentialsStatus(configured=bool(config.genius_api_key), canManage=principal.is_owner)


@router.put("/config/genius", response_model=GeniusCredentialsStatus, dependencies=[Depends(require_owner)])
def set_genius_credentials(body: GeniusCredentialsRequest, config: ConfigManager = Depends(get_config),
                           principal: Principal = Depends(require_owner)):
    key = body.apiKey.get_secret_value().strip()
    if not is_mask(key) and (not key or len(key) > 4096 or any(ord(char) < 33 or ord(char) > 126 for char in key)):
        raise HTTPException(status_code=422, detail="Enter a valid Genius access token without spaces or line breaks.")
    return _save_genius(config, key, principal.user_id)


@router.delete("/config/genius", response_model=GeniusCredentialsStatus, dependencies=[Depends(require_owner)])
def delete_genius_credentials(config: ConfigManager = Depends(get_config), principal: Principal = Depends(require_owner)):
    return _save_genius(config, "", principal.user_id)


def _save_genius(config: ConfigManager, key: str, actor: str) -> GeniusCredentialsStatus:
    change(config, {"KROBI_GENIUS_API_KEY": key or None}, actor=actor)
    return GeniusCredentialsStatus(configured=bool(config.genius_api_key), canManage=True)


class ProviderToggleRequest(BaseModel):
    enabled: bool


class ProviderOrderRequest(BaseModel):
    order: list[str] = Field(default_factory=list)


class ProviderHealthResponse(BaseModel):
    state: Literal['ok', 'busy', 'broken']
    kind: FailureKind | None = None
    level: int | None = None
    until: float | None = None
    since: float | None = None
    firstFailureAt: float | None = None
    lastFailureAt: float | None = None


class ProviderFormatResponse(BaseModel):
    codec: str
    bitrateKbps: float | None
    container: str
    transcoded: bool | None


class YtdlpResponse(BaseModel):
    version: str | None
    channel: Literal['stable'] = 'stable'
    updatedAt: float | None
    lastCheckAt: float | None
    autoUpdate: bool
    ageDays: int | None
    stale: bool
    rolledBackFrom: str | None = None
    error: str | None = None


def source_status(container=Depends(get_container)):
    return container.get_source_status()


@router.post('/providers/youtube/ytdlp/update', response_model=YtdlpResponse,
             response_model_exclude_unset=True, dependencies=[Depends(require_owner)], operation_id='update_ytdlp_api_providers_youtube_ytdlp_update_post')
def update_source_tool(container=Depends(get_container), registry=Depends(get_provider_registry)):
    from app.domains.acquisition.sources.routes import installed, source_action, SourceActionRequest
    installed(LEGACY_SOURCE_ID, registry)
    status = source_action(LEGACY_SOURCE_ID, SourceActionRequest(id='update'), container, registry)
    # Retain the legacy route's response schema; tooling facts belong to status.
    return dict(version=status.revision, updatedAt=None, lastCheckAt=None,
                autoUpdate=next((toggle.value for toggle in status.toggles if toggle.id == 'auto-update'), False),
                ageDays=None, stale=bool(status.warning))


class ProviderResponse(BaseModel):
    id: str
    kind: ProviderKind
    name: str
    description: str
    enabled: bool
    position: int
    available: bool
    requiresCredentials: bool
    capabilities: list[str]
    unavailableReason: str | None
    health: ProviderHealthResponse
    format: ProviderFormatResponse | None = None
    ytdlp: YtdlpResponse | None = None
    status: SourceStatus | None = None


class ProvidersResponse(BaseModel):
    providers: list[ProviderResponse]


def source_health(container=Depends(get_container)):
    return container.get_source_health()


@router.post('/providers/{provider_id}/retry', response_model=ProviderHealthResponse,
             response_model_exclude_unset=True, dependencies=[Depends(require_owner)])
def retry_provider(provider_id: str, registry: ProviderRegistry = Depends(get_provider_registry),
                   health=Depends(source_health)):
    try:
        registry.status_of(provider_id)
    except UnknownProviderError:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider_id}'")
    return health.retry(provider_id)


def _status(cache, source):
    if source is None:
        return SourceStatus().model_dump()
    try:
        return cache.refresh(source).model_dump()
    except Exception:
        logger.warning('Source %s status unavailable', source.id)
        return SourceStatus().model_dump()


def _row(status: ProviderStatus, health, cache, registry) -> dict:
    """One provider, in the shape the settings panel renders.

    ``enabled`` and ``available`` are separate on purpose: "off because you
    turned it off" and "off because it cannot work" need different UI, and
    conflating them is the first thing that confuses a user.
    """
    descriptor = status.descriptor
    health_fields = health.status(descriptor.id)
    if descriptor.kind == ProviderKind.STREAMING:
        health_fields = {"kind": None, "level": None, "until": None, "since": None,
                         "firstFailureAt": None, "lastFailureAt": None, **health_fields}
    return {
        "id": descriptor.id,
        "kind": descriptor.kind.value,
        "name": descriptor.name,
        "description": descriptor.description,
        "enabled": status.enabled,
        "position": status.position,
        "available": status.available,
        "requiresCredentials": descriptor.requires_credentials,
        "capabilities": list(descriptor.capabilities),
        "unavailableReason": status.unavailable_reason,
        "health": health_fields,
        **({"format": health.last_format(descriptor.id)} if descriptor.kind == ProviderKind.STREAMING else {}),
        **({"status": _status(cache, getattr(registry.instance(descriptor.id), 'source', None))} if descriptor.kind == ProviderKind.STREAMING else {}),
    }


@router.get("/providers", response_model=ProvidersResponse, response_model_exclude_unset=True)
def list_providers(
    kind: ProviderKind | None = None,
    registry: ProviderRegistry = Depends(get_provider_registry),
    health=Depends(source_health),
    cache=Depends(source_status),
) -> dict:
    """Every registered provider, in effective order, disabled ones included.

    The panel has to render what you switched off, so this is not
    ``registry.order()`` — that is the consumer-facing list and it filters.
    """
    return {"providers": [_row(status, health, cache, registry) for status in registry.status(kind)]}


@router.put("/providers/{provider_id}", response_model=ProviderResponse, response_model_exclude_unset=True, dependencies=[Depends(require_owner)])
def set_provider_enabled(
    provider_id: str,
    body: ProviderToggleRequest,
    registry: ProviderRegistry = Depends(get_provider_registry),
    health=Depends(source_health),
    cache=Depends(source_status),
) -> dict:
    """Toggle one provider and return its updated row.

    422 rather than a silent no-op when this would disable the last enabled
    provider of a kind: an empty metadata kind means every import rejects every
    track, and a settings toggle must not be able to break resolution invisibly.
    """
    try:
        registry.set_enabled(provider_id, body.enabled)
    except UnknownProviderError:
        raise HTTPException(status_code=404, detail=f"Unknown provider '{provider_id}'")
    except LastEnabledProviderError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _row(registry.status_of(provider_id), health, cache, registry)


@router.put("/providers/{kind}/order", response_model=ProvidersResponse, response_model_exclude_unset=True, dependencies=[Depends(require_owner)])
def set_provider_order(
    kind: ProviderKind,
    body: ProviderOrderRequest,
    registry: ProviderRegistry = Depends(get_provider_registry),
    health=Depends(source_health),
    cache=Depends(source_status),
) -> dict:
    """Replace a kind's priority order with a full permutation of its ids.

    422 on an unknown or missing id. A partial order is ambiguous — do the
    omitted providers go first, last, or keep their old slots? — and guessing is
    worse than refusing.
    """
    try:
        registry.set_order(kind, body.order)
    except InvalidOrderError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"providers": [_row(status, health, cache, registry) for status in registry.status(kind)]}
