"""The stable host surface for backend plugins; import host names only here.

Names may be added freely. A removed or renamed name keeps an alias for one
release so installed plugins have time to migrate.
"""

from app.config import APP_VERSION, ConfigManager
from app.dependencies import DependencyContainer, get_library_scope, get_user_track_store
from app.domains.browse.acquisition import AcquireTrack
from app.domains.browse.models import BrowseTrack
from app.domains.helpers.mac_worker import AgentIdentity
from app.domains.metadata.matching import Confidence
from app.domains.metadata.musicbrainz_repository import (
    DEFAULT_CONTACT,
    RECORDING_LOOKUP_INC,
    WORK_LOOKUP_INC,
    artist_credit_text,
)
from app.domains.metadata.normalization import normalize_key, normalize_loose
from app.domains.metadata.resolution_service import ResolutionService
from app.domains.playlists.spotify_export import ExportedTrack
from app.domains.stems.services import file_signature
from app.domains.user_library.acquisition_links import link_acquired
from app.domains.user_library.scope import LibraryScope
from app.exceptions import (
    AudioEditorError,
    BurningError,
    ExternalAPIError,
    MusicNotFoundError,
    ValidationError,
)
from app.infra.errors import unexpected_errors_as_500
from app.infra.files import write_secret_lines
from app.infra.identity import (
    Principal,
    current_principal,
    get_config,
    require_local_client,
    require_owner,
)
from app.infra.jobs.kinds import JobKind, Kinds as _Kinds
from app.infra.logging import LoggerConfig
from app.plugins import PluginContext
from app.utils.library_paths import rel_path_for, resolve_track
from app.utils.path_safety import resolve_under, safe_open_path

# The registry belongs to the host's shared queue, not to this module.
# Call register_job_kind(queue.kinds, JobKind(...)).
register_job_kind = _Kinds.register

__all__ = [
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
