"""Metadata repositories for Genius API and audio file operations."""

import logging
import requests
from bs4 import BeautifulSoup
from pathlib import Path
from typing import Any
from mutagen import File as MutagenFile
from mutagen.id3 import APIC
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover

from app.infra.http_fetch import safe_get
from app.config import ConfigManager
from app.exceptions import ExternalAPIError, MetadataError
from app.utils.titles import clean_title
from app.domains.music.models import AudioMetadata
from app.domains.metadata import tagreader, tagwriter
from app.config import APP_VERSION


class GeniusRepository:
    """Repository for Genius API operations."""
    
    def __init__(self, config: ConfigManager, logger: logging.Logger):
        """
        Initialize Genius repository.
        
        Args:
            config: Configuration manager
            logger: Logger instance
        """
        self.config = config
        self.logger = logger
        self.base_url = "https://api.genius.com"
        self.headers = {
            # Who is asking, honestly — never a browser disguise.
            "User-Agent": f"Flipspin/{APP_VERSION} ( https://github.com/flipspin/flipspin )"
        }

    @property
    def api_key(self) -> str | None:
        """Use credentials saved in Settings immediately, without rebuilding repositories."""
        return self.config.genius_api_key
    
    def search_songs(self, query: str, max_results: int = 5) -> list[dict[str, Any]]:
        """
        Search for songs on Genius.
        
        Args:
            query: Search query
            max_results: Maximum number of results
            
        Returns:
            List of song dictionaries
        """
        try:
            if self.api_key:
                # Use API if available
                url = f"{self.base_url}/search"
                headers = {**self.headers, "Authorization": f"Bearer {self.api_key}"}
                params = {"q": query}
                
                response = requests.get(url, headers=headers, params=params, timeout=10)
                response.raise_for_status()
                
                data = response.json()
                hits = data.get("response", {}).get("hits", [])
                
                results = []
                for hit in hits[:max_results]:
                    song = hit.get("result", {})
                    results.append({
                        "title": song.get("title"),
                        "artist": song.get("primary_artist", {}).get("name"),
                        "url": song.get("url"),
                        "album": song.get("album", {}).get("name") if song.get("album") else None
                    })
                
                return results
            else:
                # Fallback to web scraping
                self.logger.warning("No Genius API key, using web scraping")
                return []
                
        except requests.RequestException as e:
            self.logger.error(f"Genius API error: {e}")
            raise ExternalAPIError(
                f"Failed to search Genius: {str(e)}",
                api_name="Genius",
                original_error=e
            )
    
    def get_song_info(self, song_url: str) -> dict[str, Any]:
        """
        Get detailed song information from URL.
        
        Args:
            song_url: Genius song URL
            
        Returns:
            Dictionary with song information
        """
        try:
            response = safe_get(song_url, headers=self.headers, timeout=10)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            title_tag = soup.find("title")
            if title_tag:
                title_text = title_tag.text.replace(" Lyrics | Genius Lyrics", "").strip()
                if "–" in title_text:
                    artist, title = [part.strip() for part in title_text.split("–", 1)]
                else:
                    artist, title = "", title_text
                title = clean_title(title) if title else title
            else:
                artist, title = "Unknown", "Unknown"
            
            # Extract album
            album_tag = soup.find("a", {"href": "#primary-album"})
            album = album_tag.text.strip() if album_tag else None

            # Extract cover URL from the og:image meta tag
            cover_url = None
            og_image = soup.find("meta", property="og:image")
            if og_image and og_image.get("content"):
                cover_url = og_image.get("content")

            return {
                "title": title,
                "artist": artist,
                "album": album,
                "cover_url": cover_url,
                "url": song_url
            }
            
        except requests.RequestException as e:
            self.logger.error(f"Error fetching song info: {e}")
            raise ExternalAPIError(
                f"Failed to fetch song info: {str(e)}",
                api_name="Genius",
                original_error=e
            )
    
    def get_album_info(self, album_url: str) -> dict[str, Any]:
        """
        Get album information including tracks.
        
        Args:
            album_url: Genius album URL
            
        Returns:
            Dictionary with album information
        """
        try:
            response = safe_get(album_url, headers=self.headers, timeout=10)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Extract album and artist
            album_title_tag = soup.find('h1')
            artist_tag = soup.find('h2')
            
            album = album_title_tag.text.strip() if album_title_tag else "Unknown"
            artist = artist_tag.text.strip() if artist_tag else "Unknown"
            
            track_tags = soup.select('h3.chart_row-content-title')
            tracks = []
            for i, tag in enumerate(track_tags, start=1):
                raw = tag.text.strip()
                title = clean_title(raw) if raw else ""
                if title:
                    tracks.append({"title": title, "track_number": i})
            
            # Try to extract genre
            genre = None
            genre_tag = soup.find("span", string="Genre")
            if genre_tag and genre_tag.parent:
                genre = genre_tag.parent.text.replace("Genre", "").strip()
            
            # Try to extract cover URL
            cover_url = None
            # Look for meta og:image tag
            og_image = soup.find("meta", property="og:image")
            if og_image and og_image.get("content"):
                cover_url = og_image.get("content")
            else:
                # Fallback: look for album cover image
                cover_img = soup.find("img", class_="cover_art-image")
                if cover_img and cover_img.get("src"):
                    cover_url = cover_img.get("src")
            
            self.logger.info(f"Found {len(tracks)} tracks for album: {album}")
            
            return {
                "album": album,
                "artist": artist,
                "tracks": tracks,
                "genre": genre,
                "cover_url": cover_url,
                "url": album_url
            }
            
        except requests.RequestException as e:
            self.logger.error(f"Error fetching album info: {e}")
            raise ExternalAPIError(
                f"Failed to fetch album info: {str(e)}",
                api_name="Genius",
                original_error=e
            )
    
    def download_cover_art(self, cover_url: str, output_path: Path) -> Path:
        """
        Download album cover art.
        
        Args:
            cover_url: URL to cover image
            output_path: Output file path
            
        Returns:
            Path to downloaded cover
        """
        try:
            response = safe_get(cover_url, headers=self.headers, timeout=10, image=True)
            response.raise_for_status()
            
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            with open(output_path, 'wb') as f:
                f.write(response.content)
            
            self.logger.info(f"Downloaded cover art to {output_path}")
            return output_path
            
        except requests.RequestException as e:
            self.logger.error(f"Error downloading cover art: {e}")
            raise ExternalAPIError(
                f"Failed to download cover art: {str(e)}",
                api_name="Genius",
                original_error=e
            )

    def download_cover_bytes(self, cover_url: str) -> bytes:
        """Return cover bytes in memory for the cover-search response, without a file write."""
        try:
            response = safe_get(cover_url, headers=self.headers, timeout=10, image=True)
            response.raise_for_status()
            return response.content
        except requests.RequestException as e:
            self.logger.error(f"Error downloading cover art: {e}")
            raise ExternalAPIError(
                f"Failed to download cover art: {str(e)}",
                api_name="Genius",
                original_error=e
            )


class MetadataRepository:
    """Repository for audio file metadata operations."""
    
    def __init__(self, config: ConfigManager, logger: logging.Logger, tag_writer=None):
        """
        Initialize metadata repository.
        
        Args:
            config: Configuration manager
            logger: Logger instance
        """
        self.tag_writer = tag_writer
        self.config = config
        self.logger = logger
    
    def read_id3_tags(self, file_path: Path) -> AudioMetadata:
        """
        Read ID3 tags from audio file.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            AudioMetadata object
        """
        try:
            audio = MutagenFile(str(file_path))
            
            if not audio:
                raise MetadataError(f"Could not read audio file: {file_path}")
            
            metadata = AudioMetadata()
            metadata.duration = audio.info.length if audio.info else None
            
            if audio.tags:
                mode = tagwriter.FORMATS.get(file_path.suffix.lower(), 0)
                tags = tagreader.read(audio.tags, mode)
                for name in AudioMetadata.__dataclass_fields__:
                    if name in tags:
                        setattr(metadata, name, tags[name])
                if metadata.bpm is not None:
                    metadata.bpm = int(round(metadata.bpm))

                # Cover art
                if isinstance(audio, MP4):
                    metadata.cover_art = bytes(audio.tags['covr'][0]) if audio.tags.get('covr') else None
                elif isinstance(audio, MP3):
                    for tag in audio.tags.values():
                        if isinstance(tag, APIC):
                            metadata.cover_art = tag.data
                            break
            
            return metadata
            
        except Exception as e:
            self.logger.error(f"Error reading metadata: {e}")
            raise MetadataError(f"Failed to read metadata: {str(e)}")
    
    def write_id3_tags(self, file_path: Path, metadata: AudioMetadata, *, overwrite: bool = False) -> None:
        """Compatibility port: fill gaps or overwrite through the sole safe writer."""
        from app.domains.metadata import tagwriter

        fields = tagwriter.metadata_fields(metadata)
        transform = lambda tags, mode: tagwriter.fill_gaps(tags, mode, fields, overwrite=overwrite)
        if self.tag_writer:
            self.tag_writer(file_path, fields, transform=transform)
        else:
            # Private acquisition staging has no shared file to journal yet.
            tagwriter.write(file_path, expected=tagwriter.identity(file_path), transform=transform)


    def extract_cover_art(self, file_path: Path) -> bytes | None:
        """
        Extract embedded cover art from audio file.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            Cover art bytes or None
        """
        try:
            audio = MutagenFile(str(file_path))
            
            if audio and audio.tags:
                if isinstance(audio, MP4):
                    return bytes(audio.tags['covr'][0]) if audio.tags.get('covr') else None
                for tag in audio.tags.values():
                    if isinstance(tag, APIC):
                        return tag.data
            
            return None
            
        except Exception as e:
            self.logger.warning(f"Could not extract cover art: {e}")
            return None
    
    def embed_cover_art(self, file_path: Path, cover_data: bytes, mime_type: str = "image/jpeg") -> None:
        """Retain the acquisition cover behavior through the safe write boundary."""
        from app.domains.metadata import tagwriter

        def mutation(tags, mode):
            if mode == 2:
                image_format = MP4Cover.FORMAT_PNG if cover_data.startswith(b'\x89PNG') else MP4Cover.FORMAT_JPEG
                tags['covr'] = [MP4Cover(cover_data, imageformat=image_format)]
                return {'covr'}
            if mode != 0:
                raise MetadataError('Cover embedding requires MP3 or MP4')
            keys = list(tags.keys())
            changed = {key for key in keys if key.startswith('APIC:')}
            tags.delall('APIC')
            frame = APIC(encoding=3, mime=mime_type, type=3, desc='Cover', data=cover_data)
            tags.add(frame)
            return changed | {frame.HashKey}
        if self.tag_writer:
            self.tag_writer(file_path, {}, mutation=mutation)
        else:
            tagwriter.write(file_path, expected=tagwriter.identity(file_path), mutation=mutation)

    def get_audio_duration(self, file_path: Path) -> float:
        """
        Get audio file duration in seconds.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            Duration in seconds
        """
        try:
            audio = MutagenFile(str(file_path))
            if audio and audio.info:
                return audio.info.length
            return 0.0
        except Exception as e:
            self.logger.warning(f"Could not get duration: {e}")
            return 0.0
