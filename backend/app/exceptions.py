"""Custom exception classes for the KROBI application."""
from typing import Any
from enum import StrEnum


# Error codes
class ErrorCode:
    """Error code constants."""
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR"
    MUSIC_NOT_FOUND = "MUSIC_NOT_FOUND"
    DOWNLOAD_ERROR = "DOWNLOAD_ERROR"
    METADATA_ERROR = "METADATA_ERROR"
    PLAYLIST_ERROR = "PLAYLIST_ERROR"
    TRANSFER_ERROR = "TRANSFER_ERROR"
    BURNING_ERROR = "BURNING_ERROR"
    AUDIO_EDITOR_ERROR = "AUDIO_EDITOR_ERROR"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    EXTERNAL_API_ERROR = "EXTERNAL_API_ERROR"
    FILE_SYSTEM_ERROR = "FILE_SYSTEM_ERROR"
    SPOTIFY_AUTH_REQUIRED = "SPOTIFY_AUTH_REQUIRED"
    SPOTIFY_PLAYLIST_ACCESS = "SPOTIFY_PLAYLIST_ACCESS"


class KrobiException(Exception):
    """Base exception for all KROBI errors."""
    
    def __init__(
        self,
        message: str,
        error_code: str,
        details: dict[str, Any] | None = None
    ):
        super().__init__(message)
        self.message = message
        self.error_code = error_code
        self.details = details or {}
    
    def to_dict(self) -> dict[str, Any]:
        """Convert exception to dictionary for API responses."""
        return {
            "error_code": self.error_code,
            "message": self.message,
            "details": self.details
        }


class ConfigurationError(KrobiException):
    """Configuration is invalid or missing."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.CONFIGURATION_ERROR,
            details=details
        )


class MusicNotFoundError(KrobiException):
    """Requested music file or album not found."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.MUSIC_NOT_FOUND,
            details=details
        )


class DownloadError(KrobiException):
    """Error during download operation."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.DOWNLOAD_ERROR,
            details=details
        )


class FailureKind(StrEnum):
    NOT_FOUND = 'not-found'
    AUTH_REQUIRED = 'auth-required'
    RATE_LIMITED = 'rate-limited'
    BLOCKED = 'blocked'
    NETWORK = 'network'
    BROKEN = 'broken'
    BUG = 'bug'


class SourceFailure(DownloadError):
    """A classified source failure; policy never depends on its message."""

    kind = FailureKind.BROKEN
    retry_after: float | None = None


class SourceAuthRequiredError(SourceFailure):
    """A source needs sign-in; cookies remain at the host secrets boundary."""
    kind = FailureKind.AUTH_REQUIRED

    def __init__(self, message=None, details=None):
        super().__init__(message or "The source needs sign-in. Configure its cookies in Settings.", details)


class SpotifyAuthRequiredError(KrobiException):
    """Reading a Spotify playlist needs a connected user account.

    Since the Feb 2026 Web API change, playlist items can't be read with
    app-only (Client Credentials) auth — the user must connect their Spotify
    account (Authorization Code flow). Maps to 401 so the frontend can prompt
    "connect Spotify in Settings" instead of showing a generic 500.
    """

    def __init__(self, message: str | None = None, details: dict[str, Any] | None = None):
        super().__init__(
            message=message or (
                "Conectá tu cuenta de Spotify en Ajustes para importar playlists."
            ),
            error_code=ErrorCode.SPOTIFY_AUTH_REQUIRED,
            details=details,
        )


class SpotifyPlaylistAccessError(KrobiException):
    """The playlist exists but Spotify won't return its tracks to this user.

    Since Feb 2026, Get Playlist Items only returns contents for playlists the
    user owns or collaborates on; other (incl. public) playlists return metadata
    only. Maps to 422 so the frontend can explain the real limitation rather
    than reporting an empty/failed import.
    """

    def __init__(self, message: str | None = None, details: dict[str, Any] | None = None):
        super().__init__(
            message=message or (
                "Spotify ahora solo permite importar playlists que creaste vos o "
                "en las que colaborás. Esta playlist es de otra cuenta, así que no "
                "se pueden leer sus canciones."
            ),
            error_code=ErrorCode.SPOTIFY_PLAYLIST_ACCESS,
            details=details,
        )


class MetadataError(KrobiException):
    """Error processing metadata."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.METADATA_ERROR,
            details=details
        )


class PlaylistError(KrobiException):
    """Error in playlist operations."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.PLAYLIST_ERROR,
            details=details
        )


class TransferError(KrobiException):
    """Error during file transfer."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.TRANSFER_ERROR,
            details=details
        )


class BurningError(KrobiException):
    """Error during CD burning operation."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.BURNING_ERROR,
            details=details
        )


class AudioEditorError(KrobiException):
    """Error during an audio editing/render operation."""

    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.AUDIO_EDITOR_ERROR,
            details=details
        )


class ValidationError(KrobiException):
    """Input validation failed."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.VALIDATION_ERROR,
            details=details
        )


class ExternalAPIError(KrobiException):
    """Error calling external API."""
    
    def __init__(
        self,
        message: str,
        api_name: str,
        original_error: Exception | None = None,
        details: dict[str, Any] | None = None
    ):
        error_details = details or {}
        error_details["api_name"] = api_name
        if original_error:
            error_details["original_error"] = str(original_error)
        
        super().__init__(
            message=message,
            error_code=ErrorCode.EXTERNAL_API_ERROR,
            details=error_details
        )


class FileSystemError(KrobiException):
    """Error during file system operation."""
    
    def __init__(self, message: str, details: dict[str, Any] | None = None):
        super().__init__(
            message=message,
            error_code=ErrorCode.FILE_SYSTEM_ERROR,
            details=details
        )


class ProviderRateLimitedError(SourceFailure):
    """The provider session needs a cooldown; no item failed."""

    kind = FailureKind.RATE_LIMITED

    def __init__(self, message: str, details: dict[str, Any] | None = None, *, retry_after: float | None = None):
        super().__init__(message, details)
        self.retry_after = retry_after
