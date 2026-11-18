"""Refactored download service using modular architecture."""
import json
import logging
import requests
from pathlib import Path

from app.infra.capacity import capacity_job
from app.infra.http_fetch import safe_get
from app.config import ConfigManager
from app.exceptions import DownloadError
from app.infra.progress import ProgressTracker
from app.infra.media_requests import DownloadResult, TrackMetadata
from app.domains.acquisition.provider import DownloadRepository
from app.domains.metadata.repositories import MetadataRepository, GeniusRepository
from app.domains.metadata.spotify_repository import SpotifyRepository
from app.domains.acquisition.engine import DownloadEngine
from app.domains.acquisition.adapters import (
    SourceAdapter,
    SearchAdapter,
    GeniusAdapter,
    SpotifyAdapter
)


class DownloadService:
    """
    Refactored download service with modular architecture.
    
    This service acts as a facade, delegating to specialized adapters
    for registered audio sources and metadata catalogs.
    """
    
    def __init__(
        self,
        download_repo: DownloadRepository,
        metadata_repo: MetadataRepository,
        progress_tracker: ProgressTracker,
        config: ConfigManager,
        logger: logging.Logger,
        spotify_auth=None,
        ownership=None,
    ):
        """Share Spotify auth with playlist reads and the OAuth callback."""
        self.progress_tracker = progress_tracker
        self.config = config
        self.logger = logger

        self.genius_repo = GeniusRepository(config, logger)
        self.spotify_repo = SpotifyRepository(config, logger, auth=spotify_auth)

        self.engine = DownloadEngine(
            download_repo=download_repo,
            metadata_repo=metadata_repo,
            genius_repo=self.genius_repo,
            progress_tracker=progress_tracker,
            config=config,
            logger=logger,
            ownership=ownership,
        )
        
        self.source_adapter = SourceAdapter(self.engine, logger)
        self.search_adapter = SearchAdapter(self.engine, logger)
        self.genius_adapter = GeniusAdapter(self.engine, self.genius_repo, logger)
        self.spotify_adapter = SpotifyAdapter(self.engine, logger)
    
    @capacity_job
    async def download_from_url(
        self,
        url: str,
        destination: Path,
        filename: str | None = None,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0
    ) -> DownloadResult:
        """Download a source URL with the requested post-processing options."""
        return await self.source_adapter.download(
            url=url,
            destination=destination,
            filename=filename,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost
        )
    
    @capacity_job
    async def download_from_search(
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
        return await self.search_adapter.download(
            search_term=search_term,
            destination=destination,
            filename=filename,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost,
            metadata=metadata
        )
    
    @capacity_job
    async def download_from_genius(
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
        """Download Genius tracks with their album metadata and cover."""
        return await self.genius_adapter.download_album(
            genius_url=genius_url,
            tracks=tracks,
            destination=destination,
            cover_url=cover_url,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost,
            album_name=album_name,
            artist_name=artist_name
        )
    
    @capacity_job
    async def download_spotify_playlist(
        self,
        tracks: list[dict],
        destination: Path,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0,
        progress_id: str | None = None,
    ) -> list[DownloadResult]:
        """Use a pre-registered progress id when the route schedules background work."""
        return await self.spotify_adapter.download_playlist(
            tracks=tracks,
            destination=destination,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost,
            progress_id=progress_id,
        )
    
    def fetch_spotify_playlist_info(self, playlist_url: str):
        """
        Fetch Spotify playlist metadata for display (name, cover, tracks).
        Does not download. For use by the frontend to show playlist before download.
        """
        playlist_url = playlist_url.strip()
        if not playlist_url or "open.spotify.com/playlist" not in playlist_url and not playlist_url.startswith("spotify:playlist:"):
            raise DownloadError("Not a Spotify playlist URL")
        try:
            return self.spotify_repo.get_playlist_info(playlist_url)
        except RuntimeError as e:
            raise DownloadError(str(e))
        except requests.RequestException as e:
            self.logger.warning(f"Spotify playlist fetch request failed: {e}")
            raise DownloadError(f"No se pudo conectar con Spotify: {e}")

    def search_spotify_tracks(self, query: str, limit: int = 10):
        """
        Search Spotify for individual tracks (client-credentials; no user login).
        Returns the adapter-ready track dicts; a picked result can be downloaded
        via download_spotify_playlist as a one-item list. Raises DownloadError
        on missing credentials or a Spotify request failure.
        """
        query = (query or "").strip()
        if not query:
            raise DownloadError("Search query is empty")
        try:
            return self.spotify_repo.search_tracks(query, limit)
        except RuntimeError as e:
            raise DownloadError(str(e))
        except requests.RequestException as e:
            self.logger.warning(f"Spotify track search request failed: {e}")
            raise DownloadError(f"No se pudo conectar con Spotify: {e}")

    def get_playlist_tracks_from_url(self, playlist_url: str) -> tuple[str, list[dict]]:
        """
        Fetch current track list from a playlist URL (Spotify or JSON). No download.
        Returns (playlist_name, list of track dicts with name, artist, album, ...).
        """
        playlist_url = playlist_url.strip()
        if not playlist_url:
            raise DownloadError("Playlist URL is empty")
        if "open.spotify.com/playlist" in playlist_url or playlist_url.startswith("spotify:playlist:"):
            tracks, playlist_name, _ = self.spotify_repo.get_playlist_tracks(playlist_url)
            return playlist_name, tracks
        resp = safe_get(playlist_url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        playlist_name = (data.get("name") or data.get("title")) if isinstance(data, dict) else None
        raw = []
        if isinstance(data, list):
            raw = data
        elif isinstance(data, dict):
            if isinstance(data.get("tracks"), list):
                raw = data["tracks"]
            elif isinstance(data.get("items"), list):
                raw = data["items"]
            else:
                for key in ("playlist", "data", "results"):
                    if isinstance(data.get(key), list):
                        raw = data[key]
                        break
        if not raw:
            raise DownloadError("No tracks found in playlist response")
        tracks = []
        for item in raw:
            track_obj = item.get("track") if isinstance(item, dict) else item
            title = None
            artist = None
            if isinstance(track_obj, dict):
                title = track_obj.get("title") or track_obj.get("name")
                a = track_obj.get("artist") or track_obj.get("artists")
                if isinstance(a, list):
                    artist = ", ".join(
                        x.get("name", x) if isinstance(x, dict) else str(x) for x in a
                    )
                else:
                    artist = str(a) if a else ""
            elif isinstance(track_obj, str):
                parts = track_obj.split(" - ", 1)
                title = parts[0].strip()
                artist = parts[1].strip() if len(parts) > 1 else ""
            if title:
                tracks.append({"name": title, "artist": artist or ""})
        if not tracks:
            raise DownloadError("Could not parse any tracks from playlist")
        return playlist_name or "ImportedPlaylists", tracks

    @capacity_job
    async def import_playlist_from_url(
        self,
        playlist_url: str,
        destination: Path,
        normalize: bool = False,
        effect_type: str = "none",
        volume_boost: float = 0.0,
        selected_indices: list[int] | None = None,
        progress_id: str | None = None,
    ) -> tuple[str, list[DownloadResult]]:
        """Import a playlist and return its name and per-track download results.

        Register an unknown playlist size at total zero, then resize the same progress
        entry after fetching tracks so subscribers keep their original id.
        Raises DownloadError when the playlist cannot be parsed.
        """
        self.logger.info(f"Importing playlist from URL: {playlist_url}")
        playlist_url = playlist_url.strip()
        if not playlist_url:
            raise DownloadError("Playlist URL is empty")

        if "open.spotify.com/playlist" in playlist_url or playlist_url.startswith("spotify:playlist:"):
            tracks, playlist_name, _ = self.spotify_repo.get_playlist_tracks(playlist_url)
            tracks = self._filter_selected_tracks(tracks, selected_indices)
            if progress_id:
                self.engine.progress_tracker.set_total(progress_id, len(tracks))
            if progress_id and self.progress_tracker.ledger:
                self.progress_tracker.ledger.configure(progress_id, label=playlist_name)
            return playlist_name, await self.spotify_adapter.download_playlist(
                tracks=tracks,
                destination=destination,
                normalize=normalize,
                effect_type=effect_type,
                volume_boost=volume_boost,
                progress_id=progress_id,
            )
        # Fallback: JSON URL (e.g. Playlisty export)
        try:
            resp = safe_get(playlist_url, timeout=10)
            resp.raise_for_status()
        except Exception as e:
            raise DownloadError(f"Cannot fetch playlist URL: {e}")
        try:
            data = resp.json()
        except json.JSONDecodeError:
            raise DownloadError("Playlist URL did not return valid JSON")
        playlist_name = None
        if isinstance(data, dict):
            playlist_name = data.get("name") or data.get("title")
        raw = []
        if isinstance(data, list):
            raw = data
        elif isinstance(data, dict):
            if isinstance(data.get("tracks"), list):
                raw = data["tracks"]
            elif isinstance(data.get("items"), list):
                raw = data["items"]
            else:
                for key in ("playlist", "data", "results"):
                    if isinstance(data.get(key), list):
                        raw = data[key]
                        break
        if not raw:
            raise DownloadError("No tracks found in playlist response")
        tracks = []
        for item in raw:
            track_obj = item.get("track") if isinstance(item, dict) else item
            title = None
            artist = None
            if isinstance(track_obj, dict):
                title = track_obj.get("title") or track_obj.get("name")
                a = track_obj.get("artist") or track_obj.get("artists")
                if isinstance(a, list):
                    artist = ", ".join(
                        x.get("name", x) if isinstance(x, dict) else str(x) for x in a
                    )
                else:
                    artist = str(a) if a else ""
            elif isinstance(track_obj, str):
                parts = track_obj.split(" - ", 1)
                title = parts[0].strip()
                artist = parts[1].strip() if len(parts) > 1 else ""
            if title:
                tracks.append({"name": title, "artist": artist or ""})
        if not tracks:
            raise DownloadError("Could not parse any tracks from playlist")
        tracks = self._filter_selected_tracks(tracks, selected_indices)
        if progress_id:
            self.engine.progress_tracker.set_total(progress_id, len(tracks))
        name = playlist_name or "ImportedPlaylists"
        if progress_id and self.progress_tracker.ledger:
            self.progress_tracker.ledger.configure(progress_id, label=name)
        return name, await self.spotify_adapter.download_playlist(
            tracks=tracks,
            destination=destination,
            normalize=normalize,
            effect_type=effect_type,
            volume_boost=volume_boost,
            progress_id=progress_id,
        )

    @staticmethod
    def _filter_selected_tracks(
        tracks: list[dict], selected_indices: list[int] | None
    ) -> list[dict]:
        """Keep only the tracks at the given 0-based positions (order preserved).

        None/omitted means "download everything" (legacy behavior). Out-of-range
        and duplicate indices are ignored so a stale frontend selection can't
        crash the import.
        """
        if selected_indices is None:
            return tracks
        seen = set()
        chosen = []
        for i in selected_indices:
            if isinstance(i, int) and 0 <= i < len(tracks) and i not in seen:
                seen.add(i)
                chosen.append(tracks[i])
        return chosen
