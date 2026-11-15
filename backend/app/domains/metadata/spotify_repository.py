"""Spotify API repository for metadata enrichment."""

import logging
import re
import requests

from app.infra.http_fetch import safe_get
from app.config import ConfigManager
from app.domains.metadata.spotify_auth import SpotifyAuth
from app.exceptions import SpotifyAuthRequiredError, SpotifyPlaylistAccessError


class SpotifyRepository:
    """Repository for Spotify API operations."""

    def __init__(
        self,
        config: ConfigManager,
        logger: logging.Logger,
        auth: SpotifyAuth | None = None,
    ):
        """Share Spotify auth so playlist reads and the OAuth callback use one token cache."""
        self.config = config
        self.logger = logger
        self.access_token: str | None = None
        # User-login auth for playlist reads (Client Credentials can no longer
        # read playlist items as of Spotify's Feb/Mar 2026 API changes).
        self.auth = auth or SpotifyAuth(config, logger)
    
    def _get_access_token(self) -> str:
        """
        Get Spotify API access token.
        
        Returns:
            Access token string
            
        Raises:
            RuntimeError: If unable to get token
        """
        if self.access_token:
            return self.access_token
        
        client_id = self.config.spotify_client_id
        client_secret = self.config.spotify_client_secret
        
        if not client_id or not client_secret:
            raise RuntimeError("Spotify credentials not configured")
        
        try:
            response = requests.post(
                "https://accounts.spotify.com/api/token",
                data={"grant_type": "client_credentials"},
                auth=(client_id, client_secret),
                timeout=10
            )
            response.raise_for_status()
            self.access_token = response.json().get("access_token")
            self.logger.info("Spotify access token obtained")
            return self.access_token
        except Exception as e:
            raise RuntimeError(f"Failed to get Spotify access token: {e}")
    
    def search_album(self, artist: str, album: str) -> dict | None:
        """
        Search for an album on Spotify.
        
        Args:
            artist: Artist name
            album: Album name
            
        Returns:
            Album data dict or None if not found
        """
        try:
            token = self._get_access_token()
            headers = {"Authorization": f"Bearer {token}"}
            
            # Search for album
            query = f"artist:{artist} album:{album}"
            params = {
                "q": query,
                "type": "album",
                "limit": 1
            }
            
            response = requests.get(
                "https://api.spotify.com/v1/search",
                headers=headers,
                params=params,
                timeout=10
            )
            response.raise_for_status()
            
            data = response.json()
            albums = data.get("albums", {}).get("items", [])
            
            if not albums:
                self.logger.warning(f"No Spotify album found for: {artist} - {album}")
                return None
            
            album_data = albums[0]
            self.logger.info(f"Found Spotify album: {album_data.get('name')}")
            
            return album_data
            
        except Exception as e:
            self.logger.error(f"Error searching Spotify album: {e}")
            return None
    
    # Spotify caps /v1/search `limit` at 10 for development-mode apps (no
    # extended quota); 11+ returns 400 "Invalid limit". Stay at/under it.
    SEARCH_LIMIT_MAX = 10

    def search_tracks(self, query: str, limit: int = 10) -> list[dict]:
        """Search tracks using Client Credentials, without a user sign-in.

        Results use the download adapter's shape, including album_images, so a selected
        result can follow the playlist acquisition path. Missing credentials raise
        RuntimeError. Search is separate from restricted playlist reads.
        """
        token = self._get_access_token()
        headers = {"Authorization": f"Bearer {token}"}
        params = {"q": query, "type": "track", "limit": max(1, min(limit, self.SEARCH_LIMIT_MAX))}

        response = requests.get(
            "https://api.spotify.com/v1/search",
            headers=headers,
            params=params,
            timeout=10,
        )
        response.raise_for_status()

        items = response.json().get("tracks", {}).get("items", [])
        results: list[dict] = []
        for track in items:
            if not isinstance(track, dict) or not track.get("id"):
                continue
            artists = track.get("artists") or []
            artist_name = ", ".join(
                a.get("name", "") for a in artists if isinstance(a, dict)
            )
            album = track.get("album") or {}
            results.append({
                "id": track.get("id"),
                "name": track.get("name") or "Unknown",
                "artist": artist_name,
                "album": album.get("name") if isinstance(album, dict) else None,
                "track_number": track.get("track_number"),
                "duration_ms": track.get("duration_ms"),
                # Search returns full track objects, so the ISRC is already in
                # hand. Carried through because Candidate.is_identifiable — and
                # therefore matching.py's whole auto-accept path — needs it; an
                # ISRC-less Spotify candidate can only ever land in review.
                "isrc": (track.get("external_ids") or {}).get("isrc"),
                "album_images": album.get("images") if isinstance(album, dict) else [],
                "spotify_url": (track.get("external_urls") or {}).get("spotify"),
            })

        self.logger.info(f"Spotify track search '{query}' returned {len(results)} results")
        return results

    def get_album_tracks(self, album_id: str) -> list[dict]:
        """
        Get tracks for an album.
        
        Args:
            album_id: Spotify album ID
            
        Returns:
            List of track data dicts
        """
        try:
            token = self._get_access_token()
            headers = {"Authorization": f"Bearer {token}"}
            
            response = requests.get(
                f"https://api.spotify.com/v1/albums/{album_id}/tracks",
                headers=headers,
                params={"limit": 50},
                timeout=10
            )
            response.raise_for_status()
            
            data = response.json()
            tracks = data.get("items", [])
            
            self.logger.info(f"Retrieved {len(tracks)} tracks from Spotify album")
            
            return tracks
            
        except Exception as e:
            self.logger.error(f"Error getting Spotify album tracks: {e}")
            return []
    
    def get_playlist_info(self, playlist_url: str) -> dict:
        """
        Get playlist name, cover URL and track list for display (no download).
        Returns dict: name, cover_url (or None), tracks (list of name, artist, album, track_number).
        """
        tracks, playlist_name, cover_url = self.get_playlist_tracks(playlist_url)
        return {
            "name": playlist_name,
            "cover_url": cover_url,
            "tracks": [
                {
                    "name": t.get("name") or "Unknown",
                    "artist": t.get("artist") or "",
                    "album": t.get("album"),
                    "track_number": t.get("track_number"),
                }
                for t in tracks
            ],
        }

    def get_playlist_tracks(self, playlist_url: str) -> tuple[list[dict], str, str | None]:
        """Return tracks, playlist name, and cover URL from a playlist URL or URI.

        Track dictionaries use the legacy download shape; invalid URLs and API
        failures raise RuntimeError.
        """
        playlist_id = None
        match = re.search(r"playlist/([a-zA-Z0-9]+)", playlist_url)
        if match:
            playlist_id = match.group(1)
        elif playlist_url.startswith("spotify:playlist:"):
            playlist_id = playlist_url.split(":")[-1].strip()
        if not playlist_id:
            raise RuntimeError("Could not extract playlist ID from Spotify URL")

        # Playlist reads now require a user token (Authorization Code flow). A
        # missing/expired account surfaces as RuntimeError from the auth layer;
        # translate it into a typed 401 so the UI can prompt "connect Spotify".
        try:
            token = self.auth.get_access_token()
        except RuntimeError as e:
            raise SpotifyAuthRequiredError(str(e)) from e
        headers = {"Authorization": f"Bearer {token}"}

        playlist_name = "SpotifyPlaylist"
        cover_url: str | None = None
        # `tracks.total` is the playlist's real track count, returned as metadata
        # even for playlists this user can't read the contents of. It is used
        # below to tell "you don't own this playlist" apart from "empty playlist".
        declared_total: int | None = None
        try:
            meta = requests.get(
                f"https://api.spotify.com/v1/playlists/{playlist_id}",
                headers=headers,
                params={"fields": "name,images,tracks.total"},
                timeout=10,
            )
            if meta.ok:
                data = meta.json()
                playlist_name = data.get("name") or playlist_name
                images = data.get("images") or []
                if images and isinstance(images[0], dict):
                    cover_url = images[0].get("url")
                total = (data.get("tracks") or {}).get("total")
                if isinstance(total, int):
                    declared_total = total
                self.logger.info(f"Spotify playlist name: {playlist_name}")
        except Exception as e:
            self.logger.warning(f"Could not get playlist name: {e}")

        tracks: list[dict] = []
        # Spotify removed /tracks for dev-mode apps (Feb/Mar 2026 migration);
        # the replacement is /items and it requires a user token.
        url = f"https://api.spotify.com/v1/playlists/{playlist_id}/items"
        params = {"limit": 100}
        while url:
            resp = safe_get(url, headers=headers, params=params, timeout=10, allowed_hosts={'api.spotify.com'})
            resp.raise_for_status()
            payload = resp.json()
            items = payload.get("items", [])
            self.logger.info(f"Spotify playlist page: {len(items)} items")
            for item in items:
                # /items keeps the per-entry `track` object; stay tolerant of
                # renamed fields by falling back to the item itself.
                track = item.get("track") or item.get("item") or {}
                if not isinstance(track, dict) or not track.get("id"):
                    continue
                artists = track.get("artists") or []
                artist_name = ", ".join(
                    a.get("name", "") for a in artists if isinstance(a, dict)
                )
                album = track.get("album") or {}
                images = album.get("images") if isinstance(album, dict) else []
                tracks.append({
                    "name": track.get("name") or "Unknown",
                    "artist": artist_name,
                    "album": album.get("name") if isinstance(album, dict) else None,
                    "track_number": track.get("track_number"),
                    # Carried so the downloader can veto a source result whose
                    # length says it is a different recording (extended mix, live
                    # take) even when the title reads right.
                    "duration_ms": track.get("duration_ms"),
                    "album_images": images,
                })
            url = payload.get("next")
            params = {}

        if not tracks:
            # Spotify says the playlist has tracks but returned none to the caller → the
            # Feb-2026 ownership restriction (only owned/collaborative playlists
            # expose their items). Distinguish that from a genuinely empty one.
            if declared_total and declared_total > 0:
                raise SpotifyPlaylistAccessError()
            raise RuntimeError("No tracks found in Spotify playlist")
        return tracks, playlist_name, cover_url

    def download_cover_art(self, cover_url: str) -> bytes | None:
        """
        Download cover art from Spotify URL.
        """
        try:
            response = safe_get(cover_url, timeout=10, image=True)
            response.raise_for_status()
            self.logger.info("Downloaded cover art from Spotify")
            return response.content
        except Exception as e:
            self.logger.error(f"Error downloading Spotify cover art: {e}")
            return None
