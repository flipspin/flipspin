"""Owner-only source lifecycle and protocol actions."""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator

from app.dependencies import get_container, get_provider_registry, get_download_service
from app.exceptions import SourceFailure, ValidationError as PathValidationError
from app.infra.identity import require_owner
from app.providers.registry import ProviderKind
from .compat import LEGACY_SOURCES
from .installer import InstallFailure
from .status import SourceStatus
from .known import KnownSourcesResponse, known_sources, resolve_source

router = APIRouter(prefix='/api/sources', tags=['sources'], dependencies=[Depends(require_owner)])


class InstallRequest(BaseModel):
    location: str | None = Field(default=None, min_length=1, max_length=4096)
    id: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode='after')
    def one_source(self):
        if (self.id is None) == (self.location is None):
            raise ValueError('Provide either id or location.')
        return self


class InstallResponse(BaseModel):
    progress_id: str


class SourceActionRequest(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    value: Any = None


class LegacySource(BaseModel):
    id: str
    name: str
    setting: str
    location: str


class LegacySourcesResponse(BaseModel):
    sources: list[LegacySource]


def require_source(container=Depends(get_container), service=Depends(get_download_service)):
    return container._selected_source()

@router.get('/missing', response_model=LegacySourcesResponse)
def missing_sources(container=Depends(get_container)):
    import os
    from app.infra import env_sources
    registry = container.get_provider_registry()
    preference = registry._preference(ProviderKind.STREAMING)
    saved = env_sources.read_values(container.config.credentials_dir.parent / '.env')
    return {'sources': [{'id': id, 'name': name, 'setting': setting,
                         'location': (os.environ.get(setting, '') if setting in env_sources.ENV_KEYS
                                      else saved.get(setting, os.environ.get(setting, '')))}
                        for id, (name, setting) in LEGACY_SOURCES.items()
                        if not registry.get(id) and id not in preference.disabled]}


@router.get('/known', response_model=KnownSourcesResponse)
def list_known_sources(container=Depends(get_container)):
    return {'sources': known_sources(container)}


@router.post('/install', response_model=InstallResponse)
def install_source(body: InstallRequest, container=Depends(get_container)):
    try:
        location = resolve_source(container, body.id if body.id is not None else body.location, by_id=body.id is not None)
        return {'progress_id': container.get_source_installer().submit(location)}
    except (InstallFailure, ValueError) as error:
        raise HTTPException(422, detail={'kind': getattr(error, 'kind', 'location'), 'message': str(error)}) from error


def installed(id, registry):
    found = registry.get(id)
    if not found or found[0].kind != ProviderKind.STREAMING:
        raise HTTPException(404, detail=f"Unknown provider '{id}'")
    return found[1].source


@router.post('/{id}/action', response_model=SourceStatus)
def source_action(id: str, body: SourceActionRequest, container=Depends(get_container), registry=Depends(get_provider_registry)):
    source = installed(id, registry)
    try:
        return container.get_source_status().action(source, body.id, body.value)
    except SourceFailure as error:
        raise HTTPException(409, detail={'kind': str(error.kind), 'message': str(error)}) from error


@router.post('/{id}/update', response_model=InstallResponse)
def update_source(id: str, container=Depends(get_container), registry=Depends(get_provider_registry)):
    try:
        installer = container.get_source_installer()
        return {'progress_id': installer.submit(installer.location(id))}
    except (FileNotFoundError, PathValidationError) as error:
        raise HTTPException(404, detail='Unknown source') from error
    except (OSError, ValueError, KeyError) as error:
        raise HTTPException(409, detail='Source installation metadata is unavailable.') from error


@router.delete('/{id}', response_model=dict[str, bool])
def remove_source(id: str, container=Depends(get_container)):
    try:
        container.get_source_installer().remove(id)
    except (OSError, ValueError, PathValidationError) as error:
        raise HTTPException(404, detail='Unknown source') from error
    return {'removed': True}
