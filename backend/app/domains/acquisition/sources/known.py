"""Small discovery catalog; installing remains an explicit owner action."""
import os

from pydantic import BaseModel

from app.infra import env_sources
from .compat import LEGACY_SOURCE_ID, LEGACY_SOURCES

# Metadata only: no provider implementation or plugin code ships in the host.
CATALOG = {
    LEGACY_SOURCE_ID: (['Songs', 'AAC', 'm4a', 'official'], 'https://github.com/flipspin/flipspin-source-youtube'),
}


class KnownSource(BaseModel):
    id: str
    name: str
    facts: list[str]
    location: str
    installed: bool


class KnownSourcesResponse(BaseModel):
    sources: list[KnownSource]


def known_sources(container):
    registry = container.get_provider_registry()
    saved = env_sources.read_values(container.config.credentials_dir.parent / '.env')
    rows = []
    for id, (facts, default) in CATALOG.items():
        name, setting = LEGACY_SOURCES[id]
        override = (os.environ.get(setting, '') if setting in env_sources.ENV_KEYS
                    else saved.get(setting, os.environ.get(setting, '')))
        rows.append(KnownSource(id=id, name=name, facts=facts, location=override or default,
                                installed=registry.get(id) is not None))
    return rows


def resolve_source(container, value, *, by_id=False):
    value = value.strip()
    for source in known_sources(container):
        if value.casefold() in (source.id.casefold(), source.name.casefold()):
            return source.location
    if by_id:
        raise ValueError('Unknown source id.')
    return value
