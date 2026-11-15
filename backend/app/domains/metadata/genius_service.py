"""Clean, elegant Genius service for metadata and cover art extraction."""

import logging
from dataclasses import dataclass
import requests
from bs4 import BeautifulSoup
import json

from app.infra.http_fetch import safe_get
from app.utils.titles import clean_title
from app.config import APP_VERSION


@dataclass
class GeniusAlbumInfo:
    """Genius album information."""
    album: str
    artist: str
    tracks: list[str]
    cover_url: str | None = None
    genre: str | None = None
    error: str | None = None


@dataclass
class GeniusSongInfo:
    """Genius song information."""
    title: str
    artist: str
    album: str | None = None
    error: str | None = None


class GeniusService:
    """
    Clean service for extracting metadata from Genius.
    """
    
    HEADERS = {
        # Who is asking, honestly — never a browser disguise.
        "User-Agent": f"Flipspin/{APP_VERSION} ( https://github.com/flipspin/flipspin )",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection": "keep-alive",
    }
    
    COVER_SELECTORS = [
        "img.cover_art-image",
        "img[class*='cover']",
        "img[class*='album']",
        ".header_with_cover_art-cover_art img",
        ".cover_art img",
        "img[alt*='cover']",
        "img[alt*='album']"
    ]
    
    def __init__(self, logger: logging.Logger | None = None):
        """Initialize Genius service."""
        self.logger = logger or logging.getLogger(__name__)
    
    def get_album_info(self, album_url: str) -> GeniusAlbumInfo:
        """
        Extract album information from Genius URL.
        
        Args:
            album_url: Genius album URL
            
        Returns:
            GeniusAlbumInfo with album data
        """
        self.logger.info(f"Fetching album info from: {album_url}")
        
        try:
            response = self._fetch_page(album_url)
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Extract album and artist
            album = self._extract_album_name(soup)
            artist = self._extract_artist_name(soup)
            
            # Extract tracks
            tracks = self._extract_tracks(soup)
            
            # Extract cover URL
            cover_url = self._extract_cover_url(soup, album_url)
            
            # Extract genre (optional)
            genre = self._extract_genre(soup)
            
            if not tracks:
                return GeniusAlbumInfo(
                    album=album,
                    artist=artist,
                    tracks=[],
                    cover_url=cover_url,
                    genre=genre,
                    error="No tracks found"
                )
            
            self.logger.info(f"Found {len(tracks)} tracks for {artist} - {album}")
            
            return GeniusAlbumInfo(
                album=album,
                artist=artist,
                tracks=tracks,
                cover_url=cover_url,
                genre=genre
            )
            
        except requests.RequestException as e:
            self.logger.error(f"Request error: {e}")
            return GeniusAlbumInfo(
                album="Unknown",
                artist="Unknown",
                tracks=[],
                error=f"Request failed: {str(e)}"
            )
        except Exception as e:
            self.logger.error(f"Unexpected error: {e}")
            return GeniusAlbumInfo(
                album="Unknown",
                artist="Unknown",
                tracks=[],
                error=str(e)
            )
    
    def get_song_info(self, song_url: str) -> GeniusSongInfo:
        """
        Extract song information from Genius URL.
        
        Args:
            song_url: Genius song URL
            
        Returns:
            GeniusSongInfo with song data
        """
        self.logger.info(f"Fetching song info from: {song_url}")
        
        try:
            response = self._fetch_page(song_url)
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Extract title and artist from page title
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
            
            self.logger.info(f"Found song: {artist} - {title}")
            
            return GeniusSongInfo(
                title=title,
                artist=artist,
                album=album
            )
            
        except requests.RequestException as e:
            self.logger.error(f"Request error: {e}")
            return GeniusSongInfo(
                title="Unknown",
                artist="Unknown",
                error=f"Request failed: {str(e)}"
            )
        except Exception as e:
            self.logger.error(f"Unexpected error: {e}")
            return GeniusSongInfo(
                title="Unknown",
                artist="Unknown",
                error=str(e)
            )
    
    def get_cover_url(self, page_url: str) -> str | None:
        """
        Extract cover art URL from Genius page.
        
        Args:
            page_url: Genius album or song URL
            
        Returns:
            Cover art URL or None if not found
        """
        self.logger.info(f"Fetching cover URL from: {page_url}")
        
        try:
            response = self._fetch_page(page_url)
            soup = BeautifulSoup(response.text, 'html.parser')
            
            cover_url = self._extract_cover_url(soup, page_url)
            
            if cover_url:
                self.logger.info(f"Found cover URL: {cover_url}")
            else:
                self.logger.warning("Cover URL not found")
            
            return cover_url
            
        except Exception as e:
            self.logger.error(f"Error fetching cover URL: {e}")
            return None
    
    def _fetch_page(self, url: str) -> requests.Response:
        """Fetch page with proper headers and error handling."""
        response = safe_get(url, headers=self.HEADERS, timeout=10)
        response.raise_for_status()
        return response
    
    def _extract_album_name(self, soup: BeautifulSoup) -> str:
        """Extract album name from page."""
        album_tag = soup.find('h1')
        return album_tag.text.strip() if album_tag else "Unknown"
    
    def _extract_artist_name(self, soup: BeautifulSoup) -> str:
        """Extract artist name from page."""
        artist_tag = soup.find('h2')
        return artist_tag.text.strip() if artist_tag else "Unknown"
    
    def _extract_tracks(self, soup: BeautifulSoup) -> list[str]:
        track_tags = soup.select('h3.chart_row-content-title')
        out = []
        for tag in track_tags:
            raw = tag.text.strip()
            t = clean_title(raw) if raw else ""
            if t:
                out.append(t)
        return out
    
    def _extract_genre(self, soup: BeautifulSoup) -> str | None:
        """Extract genre from page."""
        genre_tag = soup.find("span", string="Genre")
        if genre_tag and genre_tag.parent:
            return genre_tag.parent.text.replace("Genre", "").strip()
        return None
    
    def _extract_cover_url(self, soup: BeautifulSoup, page_url: str) -> str | None:
        """
        Extract cover art URL from page using multiple strategies.
        
        Strategies:
        1. Try CSS selectors for cover images
        2. Try JSON-LD structured data
        3. Try Open Graph meta tags
        """
        # Strategy 1: CSS selectors
        for selector in self.COVER_SELECTORS:
            image_tag = soup.select_one(selector)
            if image_tag and image_tag.get("src"):
                cover_url = image_tag["src"]
                return self._normalize_url(cover_url)
        
        # Strategy 2: JSON-LD structured data
        json_ld_scripts = soup.find_all("script", type="application/ld+json")
        for script in json_ld_scripts:
            try:
                data = json.loads(script.string)
                if isinstance(data, dict) and "image" in data:
                    return self._normalize_url(data["image"])
            except (json.JSONDecodeError, AttributeError):
                continue
        
        # Strategy 3: Open Graph meta tags
        meta_image = soup.find("meta", property="og:image")
        if meta_image and meta_image.get("content"):
            return self._normalize_url(meta_image["content"])
        
        return None
    
    def _normalize_url(self, url: str) -> str:
        """Normalize URL (handle relative URLs)."""
        if url.startswith("//"):
            return "https:" + url
        elif url.startswith("/"):
            return "https://genius.com" + url
        return url
