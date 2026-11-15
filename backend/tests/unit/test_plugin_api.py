"""Freeze the plugin surface and preserve host object/dependency identity."""

import importlib

import pytest

from app import plugin_api


def test_public_names():
    assert plugin_api.__all__ == [
        "APP_VERSION",
        "AcquireTrack",
        "AgentIdentity",
        "AudioEditorError",
        "BrowseTrack",
        "BurningError",
        "Confidence",
        "ConfigManager",
        "DEFAULT_CONTACT",
        "DependencyContainer",
        "ExportedTrack",
        "ExternalAPIError",
        "JobKind",
        "LibraryScope",
        "LoggerConfig",
        "MusicNotFoundError",
        "PluginContext",
        "Principal",
        "RECORDING_LOOKUP_INC",
        "ResolutionService",
        "ValidationError",
        "WORK_LOOKUP_INC",
        "artist_credit_text",
        "current_principal",
        "file_signature",
        "get_config",
        "get_library_scope",
        "get_user_track_store",
        "link_acquired",
        "normalize_key",
        "normalize_loose",
        "register_job_kind",
        "rel_path_for",
        "require_local_client",
        "require_owner",
        "resolve_track",
        "resolve_under",
        "safe_open_path",
        "unexpected_errors_as_500",
        "write_secret_lines",
    ]


# Independent source inventory: a moved implementation needs an explicit review.
SOURCES = {
    "app.config": ["APP_VERSION", "ConfigManager"],
    "app.dependencies": ["DependencyContainer", "get_library_scope", "get_user_track_store"],
    "app.domains.browse.acquisition": ["AcquireTrack"],
    "app.domains.browse.models": ["BrowseTrack"],
    "app.domains.helpers.mac_worker": ["AgentIdentity"],
    "app.domains.metadata.matching": ["Confidence"],
    "app.domains.metadata.musicbrainz_repository": [
        "DEFAULT_CONTACT", "RECORDING_LOOKUP_INC", "WORK_LOOKUP_INC", "artist_credit_text",
    ],
    "app.domains.metadata.normalization": ["normalize_key", "normalize_loose"],
    "app.domains.metadata.resolution_service": ["ResolutionService"],
    "app.domains.playlists.spotify_export": ["ExportedTrack"],
    "app.domains.stems.services": ["file_signature"],
    "app.domains.user_library.acquisition_links": ["link_acquired"],
    "app.domains.user_library.scope": ["LibraryScope"],
    "app.exceptions": [
        "AudioEditorError", "BurningError", "ExternalAPIError", "MusicNotFoundError", "ValidationError",
    ],
    "app.infra.errors": ["unexpected_errors_as_500"],
    "app.infra.files": ["write_secret_lines"],
    "app.infra.identity": ["Principal", "current_principal", "get_config", "require_local_client", "require_owner"],
    "app.infra.jobs.kinds": ["JobKind"],
    "app.infra.logging": ["LoggerConfig"],
    "app.plugins": ["PluginContext"],
    "app.utils.library_paths": ["rel_path_for", "resolve_track"],
    "app.utils.path_safety": ["resolve_under", "safe_open_path"],
}


def test_every_public_name_has_a_source():
    assert set(plugin_api.__all__) == {
        name for names in SOURCES.values() for name in names
    } | {"register_job_kind"}


@pytest.mark.parametrize(
    ("module", "name"),
    [(module, name) for module, names in SOURCES.items() for name in names],
)
def test_import_preserves_source_identity(module, name):
    imported = __import__("app.plugin_api", fromlist=[name])
    assert getattr(imported, name) is getattr(importlib.import_module(module), name)


def test_job_kind_registration_preserves_source_identity():
    from app.infra.jobs.kinds import Kinds
    from app.plugin_api import register_job_kind

    assert register_job_kind is Kinds.register
