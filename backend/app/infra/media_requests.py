"""Download domain models."""
from dataclasses import dataclass, field
from pathlib import Path
import re

# These callers disable normalization, so their effect/boost settings do not
# alter audio. Keep named defaults to make their differing requests explicit.
#
#: Catalog acquisition (Browse, POST /api/browse/acquire) uses clean loudnorm
#: and the normalizer's default +4 dB boost.
CATALOG_EFFECT_TYPE = "clean"
CATALOG_VOLUME_BOOST_DB = 4.0
#: Spotify data-export import and playlist refresh: no effect, no boost — the
#: file as the source served it.
PLAIN_EFFECT_TYPE = "none"
PLAIN_VOLUME_BOOST_DB = 0.0


@dataclass
class DownloadResult:
    """Result of a download operation."""
    success: bool
    file_path: Path | None = None
    error: str | None = None
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    # Why it failed, as a code a client can branch on: "no-results" (source
    # answered an empty page), "rejected" (every result was vetoed), "download"
    # (a video was chosen and could not be fetched), "auth" (the bot wall) or
    # "error". None on success.
    failure_kind: str | None = None
    # Internal provenance only; found-on-nest successes did not download bytes.
    already_present: bool = False
    
    audio_format: dict | None = None

    def to_dict(self):
        """Convert to dictionary."""
        return {
            "success": self.success,
            "file_path": str(self.file_path) if self.file_path else None,
            "error": self.error,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            **({"audio_format": self.audio_format} if self.audio_format is not None else {}),
        }


@dataclass
class TrackMetadata:
    """Metadata for a music track (ID3 tags)."""
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    track_number: int | None = None
    genre: str | None = None
    year: int | None = None
    album_artist: str | None = None
    composer: str | None = None
    disc_number: int | None = None
    isrc: str | None = None
    track_total: int | None = None
    disc_total: int | None = None
    compilation: bool | None = None
    recording_mbid: str | None = None
    release_mbid: str | None = None
    release_group_mbid: str | None = None
    artist_mbid: str | list[str] | None = None
    
    def validate(self) -> tuple[bool, str | None]:
        """
        Validate metadata fields.
        
        Returns:
            Tuple of (is_valid, error_message)
        """
        # Track number validation
        if self.track_number is not None and self.track_number < 1:
            return False, "Track number must be positive"
        
        # Year validation
        if self.year is not None and (self.year < 1900 or self.year > 2100):
            return False, "Year must be between 1900 and 2100"
        
        # Disc number validation
        if self.disc_number is not None and self.disc_number < 1:
            return False, "Disc number must be positive"
        
        return True, None
    
    def has_required_fields(self) -> bool:
        """Check if at least title or artist is present."""
        return bool(self.title or self.artist)


@dataclass
class DownloadOptions:
    """Processing options for downloads."""
    normalize: bool = False
    effect_type: str = "clean"
    volume_boost: float = 4.0
    
    def validate(self) -> tuple[bool, str | None]:
        """
        Validate download options.
        
        Returns:
            Tuple of (is_valid, error_message)
        """
        # Effect type validation ("none" = no effect when normalize is False)
        valid_effects = ["none", "clean", "bass", "treble", "vocal"]
        if self.effect_type not in valid_effects:
            return False, f"Effect type must be one of {valid_effects}"
        
        # Volume boost validation
        if self.volume_boost < 0 or self.volume_boost > 20:
            return False, "Volume boost must be between 0 and 20"
        
        return True, None


@dataclass
class TrackDownloadRequest:
    """Unified track download request for all download modes."""
    
    # Search/identification (one of these should be provided)
    search_query: str | None = None  # For search-based downloads
    youtube_url: str | None = None   # For direct URL downloads
    
    # Metadata
    metadata: TrackMetadata = field(default_factory=TrackMetadata)

    # Length of the recording the caller actually wants, in seconds. Not an ID3
    # tag (it describes the *wanted* track, not the acquired file), which
    # is why it sits here rather than on TrackMetadata. Feeds the duration veto
    # when picking a source result; when it is None the matcher says so instead
    # of guessing, so leave it unset rather than inventing a value.
    duration_s: float | None = None

    # Output configuration
    destination: Path = field(default_factory=lambda: Path("."))
    filename: str | None = None  # If None, auto-generate
    
    # Processing options
    options: DownloadOptions = field(default_factory=DownloadOptions)
    
    # Cover art
    cover_data: bytes | None = None
    cover_url: str | None = None
    
    def validate(self) -> tuple[bool, str | None]:
        """
        Validate the download request.
        
        Returns:
            Tuple of (is_valid, error_message)
        """
        # Must have either search query or source URL
        if not self.search_query and not self.youtube_url:
            return False, "Either search_query or youtube_url must be provided"
        
        # Cannot have both
        if self.search_query and self.youtube_url:
            return False, "Cannot provide both search_query and youtube_url"
        
        # Validate destination
        if not self.destination:
            return False, "Destination path is required"
        
        # Validate metadata
        is_valid, error = self.metadata.validate()
        if not is_valid:
            return False, f"Invalid metadata: {error}"
        
        # Validate options
        is_valid, error = self.options.validate()
        if not is_valid:
            return False, f"Invalid options: {error}"
        
        return True, None
    
    def generate_filename(self) -> str:
        """
        Generate a filename from metadata.
        
        Returns:
            Generated filename (without extension)
        """
        parts = []
        
        # Add track number if available
        if self.metadata.track_number:
            parts.append(f"{self.metadata.track_number:02d}")
        
        # Add title or use default
        if self.metadata.title:
            parts.append(self.metadata.title)
        elif self.metadata.artist:
            parts.append(self.metadata.artist)
        else:
            parts.append("Unknown Track")
        
        # Join parts
        filename = " - ".join(parts) if len(parts) > 1 else parts[0]
        
        # Clean filename for filesystem
        return self._clean_filename(filename)
    
    def get_filename(self) -> str:
        """
        Get the filename to use (custom or auto-generated).
        
        Returns:
            Filename (without extension)
        """
        if self.filename:
            return self._clean_filename(self.filename)
        return self.generate_filename()
    
    @staticmethod
    def _clean_filename(filename: str) -> str:
        """
        Clean filename for filesystem compatibility.
        
        Args:
            filename: Original filename
            
        Returns:
            Cleaned filename
        """
        # Remove invalid characters
        filename = re.sub(r'[<>:"/\\|?*]', '', filename)
        
        # Replace multiple spaces with single space
        filename = re.sub(r'\s+', ' ', filename)
        
        # Trim whitespace
        filename = filename.strip()
        
        # Limit length (leave room for extension)
        max_length = 200
        if len(filename) > max_length:
            filename = filename[:max_length].strip()
        
        return filename
