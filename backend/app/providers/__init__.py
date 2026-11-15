"""Share provider contracts across domains without importing concrete clients.

Adapters import repositories; consumers needing only kinds and shapes should
not load them. Composition lives above infra because it depends on domains.
"""
from app.providers.registry import (  # noqa: F401
    DashboardProvider,
    InvalidOrderError,
    KindPreference,
    LastEnabledProviderError,
    LyricsProvider,
    MetadataProvider,
    ProviderDescriptor,
    ProviderError,
    ProviderKind,
    ProviderRegistry,
    ProviderStatus,
    ReportsAvailability,
    StreamingProvider,
    StructuredMetadataSearch,
    UnknownProviderError,
)

__all__ = [
    "DashboardProvider",
    "InvalidOrderError",
    "KindPreference",
    "LastEnabledProviderError",
    "LyricsProvider",
    "MetadataProvider",
    "ProviderDescriptor",
    "ProviderError",
    "ProviderKind",
    "ProviderRegistry",
    "ProviderStatus",
    "ReportsAvailability",
    "StreamingProvider",
    "StructuredMetadataSearch",
    "UnknownProviderError",
]
