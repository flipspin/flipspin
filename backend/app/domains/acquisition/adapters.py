"""Adapter services for different download sources."""
import logging
from pathlib import Path

from app.infra.media_requests import (
    DownloadResult,
    DownloadOptions,
    TrackDownloadRequest,
    TrackMetadata
)
from app.domains.acquisition.engine import DownloadEngine
from app.domains.metadata.repositories import GeniusRepository
from app.utils.filenames import clean_filename, clean_title
from app.utils.images import full_size_image_url


def _widest_image_url(images) -> str | None:
    """The URL of the widest image in a Spotify-shaped ``[{url, width, ...}]``.

    Whatever this returns is embedded into the downloaded file and kept for as
    long as the user keeps their library, so the tie-break is always "bigger".
    Entries with no ``width`` sort last but are still usable, which is what lets
    a caller that only has one URL (catalog acquisition) pass it through.
    """
    if not isinstance(images, list):
        return None
    candidates = [img for img in images if isinstance(img, dict) and img.get('url')]
    if not candidates:
        return None
    widest = max(
        candidates,
        key=lambda img: img.get('width') if isinstance(img.get('width'), int) else -1,
    )
    return widest.get('url')


class SourceAdapter:
    """Adapter for source downloads."""
    
    def __init__(self, engine: DownloadEngine, logger: logging.Logger):
        """Initialize source adapter."""
        self.engine = engine
        self.logger = logger
    
    async def download(
        self,
        url: str,
        destination: Path,
        filename: str | None = None,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0
    ) -> DownloadResult:
        """Download a source URL with the requested post-processing options."""
        self.logger.info(f"Downloading from source: {url}")
        
        try:
            options = DownloadOptions(
                normalize=normalize,
                effect_type=effect_type,
                volume_boost=volume_boost
            )
            
            metadata = TrackMetadata()
            
            request = TrackDownloadRequest(
                youtube_url=url,
                metadata=metadata,
                destination=destination,
                filename=filename,
                options=options
            )
            
            result = await self.engine.download_single_track(request)
            
            if result.success:
                self.logger.info(f"Successfully downloaded: {result.file_path}")
            else:
                self.logger.error(f"Download failed: {result.error}")
            
            return result
            
        except Exception as e:
            self.logger.error(f"Error downloading from source: {e}")
            return DownloadResult(
                success=False,
                file_path=None,
                error=str(e)
            )


class SearchAdapter:
    """Adapter for search-based downloads."""
    
    def __init__(self, engine: DownloadEngine, logger: logging.Logger):
        """Initialize search adapter."""
        self.engine = engine
        self.logger = logger
    
    async def download(
        self,
        search_term: str,
        destination: Path,
        filename: str | None = None,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0,
        metadata: TrackMetadata | None = None
    ) -> DownloadResult:
        """Resolve and download a search query, then apply optional metadata."""
        self.logger.info(f"Downloading from search: {search_term}")
        
        try:
            options = DownloadOptions(
                normalize=normalize,
                effect_type=effect_type,
                volume_boost=volume_boost
            )
            
            if metadata is None:
                metadata = TrackMetadata()
            
            request = TrackDownloadRequest(
                search_query=search_term,
                metadata=metadata,
                destination=destination,
                filename=filename,
                options=options
            )
            
            result = await self.engine.download_single_track(request)
            
            if result.success:
                self.logger.info(f"Successfully downloaded from search: {result.file_path}")
            else:
                self.logger.error(f"Search download failed: {result.error}")
            
            return result
            
        except Exception as e:
            self.logger.error(f"Error downloading from search: {e}")
            return DownloadResult(
                success=False,
                file_path=None,
                error=str(e)
            )


class GeniusAdapter:
    """Adapter for Genius album downloads."""
    
    def __init__(
        self,
        engine: DownloadEngine,
        genius_repo: GeniusRepository,
        logger: logging.Logger
    ):
        """Initialize Genius adapter."""
        self.engine = engine
        self.genius_repo = genius_repo
        self.logger = logger
    
    async def download_album(
        self,
        genius_url: str,
        tracks: list[dict],
        destination: Path,
        cover_url: str | None = None,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0,
        album_name: str | None = None,
        artist_name: str | None = None
    ) -> list[DownloadResult]:
        """Download Genius track metadata through audio search, preserving album order."""
        self.logger.info(f"Downloading from Genius: {genius_url}")
        
        if album_name:
            album_clean = clean_filename(album_name)
            destination = destination / album_clean
            self.logger.info(f"Creating album folder: {destination}")
        
        
        # Download cover art from Genius if provided
        cover_data = None
        
        requests = self._build_track_requests(
            tracks=tracks,
            destination=destination,
            artist_name=artist_name,
            album_name=album_name,
            cover_data=cover_data,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost
        )
        
        for request in requests:
            request.cover_url = cover_url
        # Use unified batch download
        results = await self.engine.download_multiple_tracks(requests)
        
        self.logger.info(f"Completed Genius download: {sum(1 for r in results if r.success)}/{len(tracks)} successful")
        return results
    
    def _build_track_requests(
        self,
        tracks: list[dict],
        destination: Path,
        artist_name: str | None,
        album_name: str | None,
        cover_data: bytes | None,
        normalize: bool,
        effect_type: str,
        volume_boost: float
    ) -> list[TrackDownloadRequest]:
        """Build track download requests from Genius track data."""
        options = DownloadOptions(
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost
        )
        
        requests = []
        for track_data in tracks:
            # Extract track info
            track_name = track_data.get("title") if isinstance(track_data, dict) else track_data
            track_number = track_data.get("track_number") if isinstance(track_data, dict) else None
            
            # Build search query with artist if provided
            search_query = f"{track_name} {artist_name}" if artist_name else track_name
            
            metadata = TrackMetadata(
                title=track_name,
                artist=artist_name,
                album=album_name,
                track_number=track_number
            )
            
            # Generate filename WITHOUT track number (legacy behavior)
            track_clean = clean_title(metadata.title)
            filename = clean_filename(f"{track_clean}")
            
            request = TrackDownloadRequest(
                search_query=search_query,
                metadata=metadata,
                destination=destination,
                filename=filename,
                options=options,
                cover_data=cover_data
            )
            
            requests.append(request)
        
        return requests


class SpotifyAdapter:
    """Adapter for Spotify playlist downloads."""
    
    def __init__(self, engine: DownloadEngine, logger: logging.Logger):
        """Initialize Spotify adapter."""
        self.engine = engine
        self.logger = logger
    
    async def download_playlist(
        self,
        tracks: list[dict],
        destination: Path,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0,
        progress_id: str | None = None,
    ) -> list[DownloadResult]:
        """Download Spotify tracks into an optional pre-registered progress entry.

        The route can register the entry before scheduling background work to avoid
        a progress-stream race.
        """
        self.logger.info(f"Downloading Spotify playlist with {len(tracks)} tracks")


        requests = self._build_track_requests(
            tracks=tracks,
            destination=destination,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost
        )

        # Use unified batch download
        results = await self.engine.download_multiple_tracks(requests, progress_id=progress_id)
        
        self.logger.info(f"Completed Spotify download: {sum(1 for r in results if r.success)}/{len(tracks)} successful")
        return results
    
    def _build_track_requests(
        self,
        tracks: list[dict],
        destination: Path,
        normalize: bool,
        effect_type: str,
        volume_boost: float
    ) -> list[TrackDownloadRequest]:
        """Build track download requests from Spotify track data."""
        options = DownloadOptions(
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost
        )
        
        requests = []
        for track_info in tracks:
            # Build search query from Spotify metadata
            track_name = track_info.get('name', '')
            artist_name = track_info.get('artist', '')
            search_query = f"{track_name} {artist_name}"
            
            metadata = TrackMetadata(
                title=track_name,
                artist=artist_name,
                album=track_info.get('album'),
                track_number=track_info.get('track_number'),
                year=track_info.get('year'),
                genre=track_info.get('genre'),
                **{key: track_info.get(key) for key in ('isrc', 'album_artist', 'track_total', 'disc_number',
                                                      'disc_total', 'compilation', 'recording_mbid', 'release_mbid', 'release_group_mbid', 'artist_mbid')}
            )
            
            # The cover that gets embedded in the file, so it is the *largest*
            # image offered, chosen by width rather than by position. Spotify
            # happens to order its album images widest-first (640/300/64), and
            # taking [0] relied on that ordering silently; measured against the
            # library, every cover this path has ever written is 640x640, which
            # is that API's ceiling and not something this code imposes. Callers
            # that supply a single image with no width (browse acquisition) fall
            # through to that entry; Deezer display URLs are upgraded for tags.
            cover_url = full_size_image_url(_widest_image_url(track_info.get('album_images')))
            
            # Determine destination folder (organize by album if available)
            track_destination = destination
            album_name = track_info.get('album')
            if album_name:
                album_clean = clean_filename(album_name)
                track_destination = destination / album_clean
            
            # Spotify is the one source that knows how long the track should be,
            # so this is where the source duration veto gets its reference. Left
            # as None when Spotify didn't return it — a guessed length would veto
            # correct results.
            duration_ms = track_info.get('duration_ms')
            duration_s = duration_ms / 1000.0 if isinstance(duration_ms, (int, float)) else None

            request = TrackDownloadRequest(
                search_query=search_query,
                metadata=metadata,
                duration_s=duration_s,
                destination=track_destination,
                filename=None,  # Auto-generate from metadata
                options=options,
                cover_url=cover_url
            )
            
            requests.append(request)
        
        return requests
