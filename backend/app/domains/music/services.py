import logging
from collections.abc import Callable
from pathlib import Path

from app.config import ConfigManager
from app.infra.ffmpeg import decode_mono_pcm
from app.exceptions import MusicNotFoundError, ValidationError
from app.domains.music.models import Album, Track, AudioMetadata
from app.domains.music.repositories import MusicRepository
from app.domains.metadata.repositories import MetadataRepository
from app.utils.library_paths import ROOT_ALBUM_KEY, ROOT_ALBUM_NAME, require_unique_path, resolve_album, resolve_track


class MusicService:
    def __init__(self, music_repo: MusicRepository, metadata_repo: MetadataRepository, config: ConfigManager, logger: logging.Logger):
        self.music_repo = music_repo
        self.metadata_repo = metadata_repo
        self.config = config
        self.logger = logger
        # Called with the audio path after a file leaves the disk, so what
        # other domains keep beside a song (the lyric sidecar) goes with it
        # without this domain importing theirs. Wired in dependencies.py.
        self.deletion_listeners: list[Callable[[Path], object]] = []

    def list_albums(self) -> list[Album]:
        self.logger.debug("Listing all albums")
        albums = self.music_repo.scan_albums()
        self.logger.debug("Found %d albums", len(albums))
        return albums

    def get_album(self, album_name: str) -> Album:
        self.logger.debug("Getting album: %s", album_name)
        album_path = resolve_album(self.config.base_music_dir, album_name)
        if not album_path.exists() or not album_path.is_dir():
            raise MusicNotFoundError(f"Album not found: {album_name}")
        
        tracks = self.music_repo.get_album_tracks(album_path)
        
        if not tracks:
            raise MusicNotFoundError(f"No tracks found in album: {album_name}")
        first_track = tracks[0]
        compilation = any(t.compilation is True for t in tracks)
        album_artist = next((t.album_artist for t in tracks if t.album_artist), None)
        artist = album_artist or ('Various Artists' if compilation else first_track.artist)
        album_title = first_track.album or album_name
        if album_name == ROOT_ALBUM_KEY and (not first_track.album or first_track.album == "Unknown Album"):
            album_title = ROOT_ALBUM_NAME
        cover_art = self.music_repo._find_cover_art(album_path)
        total_duration = sum(t.duration or 0 for t in tracks)
        year = None
        genre = None
        try:
            metadata = self.metadata_repo.read_id3_tags(tracks[0].path)
            year = metadata.year
            genre = metadata.genre
        except Exception as e:
            self.logger.debug(f"Could not extract metadata: {e}")
        
        album = Album(
            name=album_title,
            artist=artist,
            path=album_path,
            tracks=tracks,
            cover_art=cover_art,
            year=year,
            genre=genre,
            total_duration=total_duration,
            album_artist=album_artist, compilation=compilation,
            genres=list(dict.fromkeys(g for t in tracks for g in t.genres)),
            album_sort=first_track.album_sort,
            album_artist_sort=next((t.album_artist_sort for t in tracks if t.album_artist_sort), None),
        )
        
        self.logger.debug(f"Retrieved album: {album_name} with {len(tracks)} tracks")
        return album
    
    def get_track(self, album_name: str, track_name: str) -> Track:
        self.logger.debug("Getting track: %s/%s", album_name, track_name)
        track_path = resolve_track(self.config.base_music_dir, album_name, track_name)
        if not track_path.exists():
            raise MusicNotFoundError(f"Track not found: {album_name}/{track_name}")
        
        track = self.music_repo.get_track_info(track_path)
        self.logger.debug(f"Retrieved track: {track.title}")
        return track
    
    def search_tracks(self, query: str) -> list[Track]:
        self.logger.debug("Searching tracks: %s", query)
        
        if not query or len(query.strip()) < 2:
            raise ValidationError("Search query must be at least 2 characters")
        
        query_lower = query.lower()
        matching_tracks = []
        
        # Scan all albums
        albums = self.music_repo.scan_albums()
        
        for album in albums:
            for track in album.tracks:
                # Search in title, artist, and album
                if (query_lower in track.title.lower() or
                    query_lower in track.artist.lower() or
                    query_lower in track.album.lower()):
                    matching_tracks.append(track)
        
        self.logger.debug("Found %d matching tracks", len(matching_tracks))
        return matching_tracks

    def delete_track(self, track_path: Path) -> None:
        require_unique_path(self.config.base_music_dir, track_path)
        self.logger.debug("Deleting track: %s", track_path)
        self.music_repo.delete_file(track_path)
        try:
            self.music_repo.forget_file(track_path)
        except Exception:
            self.logger.exception("cache cleanup failed for %s", track_path)
        self.logger.info("Deleted track: %s", track_path)
        for listener in list(self.deletion_listeners):
            try:
                listener(track_path)
            except Exception:  # the file is gone either way; a listener never fails the delete
                self.logger.exception("deletion listener failed for %s", track_path)

    def update_metadata(self, track_path: Path, metadata: AudioMetadata) -> None:
        require_unique_path(self.config.base_music_dir, track_path)
        self.logger.debug("Updating metadata for: %s", track_path)
        
        if not self.music_repo.file_exists(track_path):
            raise MusicNotFoundError(f"Track not found: {track_path}")
        
        self.metadata_repo.write_id3_tags(track_path, metadata, overwrite=True)
        self.logger.info("Updated metadata for: %s", track_path)

    def generate_waveform(self, track_path: Path, samples: int = 1000) -> list[float]:
        if not self.music_repo.file_exists(track_path):
            raise MusicNotFoundError(f"Track not found: {track_path}")
        try:
            import numpy as np

            y = decode_mono_pcm(track_path, self.config.ffmpeg_path)
            chunk_size = max(len(y) // samples, 1)
            waveform = []
            for i in range(0, len(y), chunk_size):
                chunk = y[i:i + chunk_size]
                if len(chunk) > 0:
                    max_amplitude = float(np.max(np.abs(chunk)))
                    waveform.append(max_amplitude)
            
            # Ensure the output contains exactly the requested number of samples
            if len(waveform) > samples:
                waveform = waveform[:samples]
            elif len(waveform) < samples:
                # Pad with zeros if needed
                waveform.extend([0.0] * (samples - len(waveform)))
            
            self.logger.debug(f"Generated waveform with {len(waveform)} samples")
            return waveform
            
        except Exception as e:
            self.logger.error(f"Error generating waveform: {e}")
            raise ValidationError(f"Failed to generate waveform: {str(e)}")
