"""Metadata service for business logic operations."""
import logging
from pathlib import Path
from typing import Any
from datetime import datetime, timedelta

from app.config import ConfigManager
from app.exceptions import MetadataError, ValidationError
from app.domains.music.models import AudioMetadata
from app.domains.metadata.repositories import MetadataRepository, GeniusRepository


class MetadataService:
    """Service for music metadata operations."""
    
    def __init__(
        self,
        metadata_repo: MetadataRepository,
        genius_repo: GeniusRepository,
        config: ConfigManager,
        logger: logging.Logger
    ):
        """
        Initialize metadata service.
        
        Args:
            metadata_repo: Metadata repository instance
            genius_repo: Genius repository instance
            config: Configuration manager
            logger: Logger instance
        """
        self.metadata_repo = metadata_repo
        self.genius_repo = genius_repo
        self.config = config
        self.logger = logger
        self._search_cache: dict[str, tuple] = {}  # query -> (results, timestamp)
        self._cache_ttl = timedelta(hours=1)
    
    def read_metadata(self, file_path: Path) -> AudioMetadata:
        """Read audio tags, raising MetadataError when they cannot be read."""
        self.logger.info(f"Reading metadata from: {file_path}")
        
        if not file_path.exists():
            raise MetadataError(f"File not found: {file_path}")
        
        metadata = self.metadata_repo.read_id3_tags(file_path)
        self.logger.info(f"Successfully read metadata from: {file_path}")
        return metadata
    
    def write_metadata(self, file_path: Path, metadata: AudioMetadata) -> None:
        """
        Write metadata to an audio file.
        
        Args:
            file_path: Path to audio file
            metadata: AudioMetadata object with new metadata
            
        Raises:
            MetadataError: If unable to write metadata
        """
        self.logger.info(f"Writing metadata to: {file_path}")
        
        if not file_path.exists():
            raise MetadataError(f"File not found: {file_path}")
        
        self.metadata_repo.write_id3_tags(file_path, metadata, overwrite=True)
        self.logger.info(f"Successfully wrote metadata to: {file_path}")
    
    def fetch_metadata_from_genius(self, query: str) -> AudioMetadata | None:
        """Return Genius metadata or None when no match exists; API failure raises MetadataError."""
        self.logger.info(f"Fetching metadata from Genius: {query}")
        
        try:
            results = self.genius_repo.search_songs(query)
            
            if not results:
                self.logger.warning(f"No results found for: {query}")
                return None
            
            first_result = results[0]
            song_url = first_result.get("url")
            
            if not song_url:
                self.logger.warning("No song URL in result")
                return None
            
            song_info = self.genius_repo.get_song_info(song_url)
            
            # Extract metadata. The Genius song page doesn't expose year or
            # genre, so those stay None rather than reading keys that never exist.
            metadata = AudioMetadata(
                title=song_info.get("title"),
                artist=song_info.get("artist"),
                album=song_info.get("album"),
                track_number=None,
                year=None,
                genre=None,
                cover_art=None
            )
            
            self.logger.info(f"Successfully fetched metadata for: {query}")
            return metadata
            
        except Exception as e:
            self.logger.error(f"Error fetching metadata from Genius: {e}")
            raise MetadataError(f"Failed to fetch metadata: {str(e)}")
    
    def fetch_album_cover(self, genius_url: str) -> bytes:
        """Return Genius cover bytes, raising MetadataError when retrieval fails."""
        self.logger.info(f"Fetching album cover from: {genius_url}")
        
        try:
            if "/albums/" in genius_url:
                info = self.genius_repo.get_album_info(genius_url)
            else:
                info = self.genius_repo.get_song_info(genius_url)
            
            cover_url = info.get("cover_url")

            if not cover_url:
                raise MetadataError("No cover art URL found")

            # Download cover art as raw bytes (the route base64-encodes it)
            cover_data = self.genius_repo.download_cover_bytes(cover_url)

            self.logger.info("Successfully fetched album cover")
            return cover_data
            
        except Exception as e:
            self.logger.error(f"Error fetching album cover: {e}")
            raise MetadataError(f"Failed to fetch album cover: {str(e)}")
    
    def embed_cover_art(self, file_path: Path, cover_data: bytes) -> None:
        """
        Embed cover art in audio file.
        
        Args:
            file_path: Path to audio file
            cover_data: Cover art image data as bytes
            
        Raises:
            MetadataError: If unable to embed cover art
        """
        self.logger.info(f"Embedding cover art in: {file_path}")
        
        if not file_path.exists():
            raise MetadataError(f"File not found: {file_path}")
        
        if not cover_data:
            raise ValidationError("Cover data is empty")
        
        self.metadata_repo.embed_cover_art(file_path, cover_data)
        self.logger.info(f"Successfully embedded cover art in: {file_path}")
    
    def search_songs(self, query: str) -> list[dict[str, Any]]:
        """
        Search for songs on Genius with caching.
        
        Args:
            query: Search query string
            
        Returns:
            List of song dictionaries with metadata
        """
        self.logger.info(f"Searching songs: {query}")
        
        if not query or len(query.strip()) < 2:
            raise ValidationError("Search query must be at least 2 characters")
        
        if query in self._search_cache:
            results, timestamp = self._search_cache[query]
            if datetime.now() - timestamp < self._cache_ttl:
                self.logger.info(f"Returning cached results for: {query}")
                return results
        
        try:
            results = self.genius_repo.search_songs(query)
            
            self._search_cache[query] = (results, datetime.now())
            
            self._clean_cache()
            
            self.logger.info(f"Found {len(results)} results for: {query}")
            return results
            
        except Exception as e:
            self.logger.error(f"Error searching songs: {e}")
            return []
    
    def _clean_cache(self) -> None:
        """Remove expired cache entries."""
        now = datetime.now()
        expired_keys = [
            key for key, (_, timestamp) in self._search_cache.items()
            if now - timestamp >= self._cache_ttl
        ]
        for key in expired_keys:
            del self._search_cache[key]
