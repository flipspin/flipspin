"""Playlist service for business logic operations."""
import logging
import threading
from functools import wraps
import re
import time
from pathlib import Path
from typing import Optional, Any, TYPE_CHECKING
from datetime import datetime

from app.config import ConfigManager
from app.exceptions import PlaylistError, ValidationError
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.domains.playlists.repositories import PlaylistRepository
from app.domains.playlists.ownership import require_access, visible_playlists
from app.domains.music.repositories import MusicRepository

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.infra.identity import Principal

logger = logging.getLogger(__name__)

# The route's If-Match comparison and every background playlist write share
# this lock; a refresh/import cannot slip between comparison and replacement.
WRITE_LOCK = threading.RLock()


def serialized(function):
    @wraps(function)
    def write(*args, **kwargs):
        with WRITE_LOCK:
            return function(*args, **kwargs)
    return write


def track_number_from_path(path: Path) -> int | None:
    """Parse track number from filename stem, e.g. '01 - Title' or '02. Title' -> 1 or 2."""
    stem = (path.stem if isinstance(path, Path) else Path(path).stem).strip()
    m = re.match(r"^(\d{1,3})\s*[.\-]\s*", stem)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return None


def playlist_detail_tracks(playlist: Playlist, music_repo: MusicRepository) -> list[dict[str, Any]]:
    """The track rows ``GET /api/playlists/{name}`` answers (legacy shape).

    A row stored without artist, duration, genre or dateAdded is filled from the file:
    tags through the music repository's own reader (the same one the library
    listing uses, memoized on mtime + size), dateAdded from the durable catalog arrival record.
    ``track_number`` is the position in the playlist (1-based), not the album
    track from the file.
    """
    rows: list[dict[str, Any]] = []
    for idx, t in enumerate(playlist.tracks):
        artist = t.artist if (t.artist is not None and str(t.artist).strip()) else None
        row = {
            "path": str(t.path),
            "title": t.title or "",
            "artist": artist or "",
            "album": t.album,
            "genre": t.genre,
            "track_number": idx + 1,
            "duration": t.duration,
            "dateAdded": t.date_added,
        }
        if (not row["artist"] or not row["duration"] or row["genre"] is None) and t.path.exists():
            try:
                tags = music_repo.read_tags(t.path)
            except Exception as e:  # noqa: BLE001 — an unreadable file keeps its stored row
                logger.debug("Could not read tags from %s: %s", t.path, e)
                tags = {}
            if not row["artist"] and tags.get("artist"):
                row["artist"] = str(tags["artist"])
            if not row["duration"] and tags.get("duration"):
                row["duration"] = float(tags["duration"])
            if row["genre"] is None:
                row["genre"] = tags.get("genre")
        try:
            row["dateAdded"] = music_repo.first_seen.get(t.path, fallback=t.date_added)
        except Exception as e:  # noqa: BLE001
            logger.debug("Could not get arrival date for %s: %s", t.path, e)
        rows.append(row)
    return rows


class PlaylistService:
    """Service for playlist management."""
    
    def __init__(
        self,
        playlist_repo: PlaylistRepository,
        music_repo: MusicRepository,
        config: ConfigManager,
        logger: logging.Logger
    ):
        """
        Initialize playlist service.
        
        Args:
            playlist_repo: Playlist repository instance
            music_repo: Music repository instance
            config: Configuration manager
            logger: Logger instance
        """
        self.playlist_repo = playlist_repo
        self.music_repo = music_repo
        self.config = config
        self.logger = logger
    
    @serialized
    def save_imported_playlist(
        self,
        name: str,
        source_url: str | None,
        tracks: list[dict[str, Any]],
        description: str | None = None,
        cover: str | None = None,
        principal: Optional["Principal"] = None,
    ) -> Playlist:
        """Save an imported playlist while enforcing ownership inside the service.

        Background imports bypass route guards, so a matching name must never overwrite
        another account's playlist. Access conflicts raise PlaylistAccessError.
        """
        now = time.time()
        existing = None
        if self.playlist_repo.playlist_exists(name):
            try:
                existing = self.playlist_repo.load_playlist(name)
            except PlaylistError:
                existing = None  # corrupt file: treat the import as a fresh write
        if existing is not None:
            require_access(principal, existing)
        existing_owner = existing.owner_id if existing is not None else None
        playlist_tracks = []
        for t in tracks:
            path = t.get("path")
            if not path:
                continue
            p = Path(path) if isinstance(path, str) else path
            playlist_tracks.append(
                PlaylistTrack(
                    path=p,
                    title=t.get("title") or (p.stem if hasattr(p, "stem") else "Unknown"),
                    artist=t.get("artist"),
                    album=t.get("album"),
                    track_number=t.get("track_number") or track_number_from_path(p),
                    duration=t.get("duration"),
                    date_added=t.get("date_added", now),
                    album_cover=t.get("albumCover"),
                )
            )
        # Re-import replaces the whole playlist, so a None cover would otherwise
        # wipe existing artwork (e.g. when a transient Spotify fetch fails).
        # Keep the existing cover unless this import brings a new one.
        if cover is None and existing is not None:
            cover = existing.cover
        playlist = Playlist(
            name=name,
            description=description or "",
            tracks=playlist_tracks,
            created_at=now,
            modified_at=now,
            total_duration=sum(pt.duration or 0 for pt in playlist_tracks),
            source_url=source_url,
            cover=cover,
            # An import that *replaces* a playlist keeps its owner. Re-importing
            # somebody else's list is refused above, so this only ever carries
            # the owner forward when the caller is that owner (or the household
            # owner refreshing a member's import).
            owner_id=(
                existing_owner
                if existing_owner is not None
                else (principal.user_id if principal is not None else None)
            ),
        )
        self.playlist_repo.save_playlist(playlist)
        self.logger.info(f"Saved imported playlist: {name} with {len(playlist_tracks)} tracks")
        return playlist

    @serialized
    def create_playlist(
        self,
        name: str,
        description: str | None = None,
        owner_id: str | None = None,
    ) -> Playlist:
        """Create an empty playlist owned by owner_id; reject invalid or existing names."""
        self.logger.debug(f"Creating playlist: {name}")
        
        if not name or len(name.strip()) == 0:
            raise ValidationError("Playlist name cannot be empty")
        
        # Playlist names are one household-wide
        # namespace (ownership.py, rule 2), so this collides against everybody's
        # playlists, not just the caller's — and the message must not say whose.
        if self.playlist_repo.playlist_exists(name):
            raise PlaylistError(f"Playlist already exists: {name}")
        
        now = datetime.now().timestamp()
        playlist = Playlist(
            name=name,
            description=description,
            tracks=[],
            created_at=now,
            modified_at=now,
            total_duration=0.0,
            owner_id=owner_id,
        )
        
        self.playlist_repo.save_playlist(playlist)
        
        self.logger.info(f"Successfully created playlist: {name}")
        return playlist
    
    def list_playlists(self, principal: Optional["Principal"] = None) -> list[Playlist]:
        """
        List the playlists ``principal`` is allowed to see.
        
        Args:
            principal: the calling user. ``None`` disables filtering and is for
                internal callers only — every route passes one.
        
        Returns:
            List of Playlist objects
        """
        self.logger.debug("Listing all playlists")
        
        playlist_names = self.playlist_repo.list_playlists()
        playlists = []
        
        for name in playlist_names:
            try:
                playlist = self.playlist_repo.load_playlist(name)
                playlists.append(playlist)
            except Exception as e:
                self.logger.warning(f"Could not load playlist {name}: {e}")
                continue
        
        playlists = visible_playlists(principal, playlists)
        self.logger.debug(f"Found {len(playlists)} playlists")
        return playlists
    
    def get_playlist(self, name: str) -> Playlist:
        """Read a named playlist, raising PlaylistError when absent."""
        self.logger.debug(f"Getting playlist: {name}")
        
        if not self.playlist_repo.playlist_exists(name):
            raise PlaylistError(f"Playlist not found: {name}")
        
        playlist = self.playlist_repo.load_playlist(name)
        self.logger.debug(f"Retrieved playlist: {name} with {len(playlist.tracks)} tracks")
        return playlist
    
    @serialized
    def update_cover(self, playlist_name: str, cover: str | None) -> Playlist:
        """
        Set the playlist-level cover (e.g. refreshed Spotify artwork) and save.

        Args:
            playlist_name: Playlist name
            cover: Cover URL/path, or None to clear

        Returns:
            Updated Playlist object
        """
        playlist = self.get_playlist(playlist_name)
        if playlist.cover == cover:
            return playlist
        playlist.cover = cover
        playlist.modified_at = time.time()
        self.playlist_repo.save_playlist(playlist)
        self.logger.info(f"Updated cover for playlist: {playlist_name}")
        return playlist

    @serialized
    def add_tracks(self, playlist_name: str, track_paths: list[Path]) -> Playlist:
        """Append valid track paths, raising PlaylistError for an absent playlist."""
        self.logger.debug(f"Adding {len(track_paths)} tracks to playlist: {playlist_name}")
        
        playlist = self.get_playlist(playlist_name)
        
        added_count = 0
        for track_path in track_paths:
            if not self.music_repo.file_exists(track_path):
                self.logger.warning(f"Track not found, skipping: {track_path}")
                continue
            
            if any(t.path == track_path for t in playlist.tracks):
                self.logger.warning(f"Track already in playlist, skipping: {track_path}")
                continue
            
            try:
                track_info = self.music_repo.get_track_info(track_path)
                
                # Create playlist track (fallback track_number from filename e.g. "01 - Title.mp3")
                playlist_track = PlaylistTrack(
                    path=track_path,
                    title=track_info.title,
                    artist=track_info.artist,
                    album=track_info.album,
                    track_number=track_info.track_number or track_number_from_path(track_path),
                    duration=track_info.duration,
                    date_added=time.time()
                )
                
                playlist.tracks.append(playlist_track)
                added_count += 1
                
            except Exception as e:
                self.logger.warning(f"Could not add track {track_path}: {e}")
                continue
        
        playlist.modified_at = time.time()
        playlist.total_duration = sum(t.duration or 0 for t in playlist.tracks)
        
        self.playlist_repo.save_playlist(playlist)
        
        self.logger.info(f"Added {added_count} tracks to playlist: {playlist_name}")
        return playlist
    
    @serialized
    def replace_tracks(self, playlist_name: str, track_paths: list[Path]) -> tuple[Playlist, int, list[Path]]:
        """Replace the list in one save, preserving existing rows even if files moved.

        Clients submit the list they read; dropping missing files would silently delete
        entries during relocation. Preserve existing date_added values and skip only
        new paths without files. Return playlist, kept_without_file, and skipped_new.
        """
        playlist = self.get_playlist(playlist_name)
        existing = {t.path: t for t in playlist.tracks}
        tracks: list[PlaylistTrack] = []
        seen: set[Path] = set()
        kept_missing = 0
        skipped: list[Path] = []
        for path in track_paths:
            if path in seen:
                continue
            seen.add(path)
            if path in existing:
                tracks.append(existing[path])
                if not self.music_repo.file_exists(path):
                    kept_missing += 1
                continue
            if not self.music_repo.file_exists(path):
                skipped.append(path)
                continue
            try:
                info = self.music_repo.get_track_info(path)
            except Exception as e:
                # The file is there; unreadable tags are no reason to lose the song.
                self.logger.warning(f"Could not read tags of {path}, adding it by file name: {e}")
                info = None
            tracks.append(PlaylistTrack(
                path=path,
                title=(info.title if info else None) or path.stem,
                artist=info.artist if info else None,
                album=info.album if info else None,
                track_number=(info.track_number if info else None) or track_number_from_path(path),
                duration=info.duration if info else None,
                date_added=time.time(),
            ))
        playlist.tracks = tracks
        playlist.modified_at = time.time()
        playlist.total_duration = sum(t.duration or 0 for t in playlist.tracks)
        self.playlist_repo.save_playlist(playlist)
        if kept_missing or skipped:
            self.logger.warning(
                f"Replaced tracks of {playlist_name}: kept {kept_missing} rows whose file is missing, "
                f"skipped {len(skipped)} new paths with no file"
            )
        return playlist, kept_missing, skipped

    @serialized
    def remove_library_tracks(self, track_paths: list[Path], *, owner_id: str | None = None) -> list[dict]:
        """Prune all occurrences after a delete commits, atomically per playlist.

        An account filter means ownership, not the caller's access privileges.
        Unchanged playlists are never rewritten.
        """
        def identity(path: Path) -> Path:
            return (path if path.is_absolute() else self.config.base_music_dir / path).resolve()

        paths = {identity(path) for path in track_paths}
        updated = []
        if not paths:
            return updated
        for name in self.playlist_repo.list_playlists():
            playlist = self.playlist_repo.load_playlist(name)
            if owner_id is not None and playlist.owner_id != owner_id:
                continue
            matching = [track.path for track in playlist.tracks if identity(track.path) in paths]
            if not matching:
                continue
            self.remove_tracks(name, matching)
            updated.append({"name": playlist.name, "removed": len(matching)})
        return updated

    @serialized
    def remove_tracks(self, playlist_name: str, track_paths: list[Path]) -> Playlist:
        """Remove the requested paths, raising PlaylistError for an absent playlist."""
        self.logger.debug(f"Removing {len(track_paths)} tracks from playlist: {playlist_name}")
        
        playlist = self.get_playlist(playlist_name)
        
        track_paths_set = set(track_paths)
        original_count = len(playlist.tracks)
        playlist.tracks = [t for t in playlist.tracks if t.path not in track_paths_set]
        removed_count = original_count - len(playlist.tracks)
        
        playlist.modified_at = time.time()
        playlist.total_duration = sum(t.duration or 0 for t in playlist.tracks)
        
        self.playlist_repo.save_playlist(playlist)
        
        self.logger.info(f"Removed {removed_count} tracks from playlist: {playlist_name}")
        return playlist
    
    @serialized
    def reorder_tracks(self, playlist_name: str, track_order: list[Path]) -> Playlist:
        """Apply the requested path order, rejecting invalid orders or absent playlists."""
        self.logger.debug(f"Reordering tracks in playlist: {playlist_name}")
        
        playlist = self.get_playlist(playlist_name)
        
        if len(track_order) != len(playlist.tracks):
            raise ValidationError("Track order must include all tracks in playlist")
        
        track_lookup = {t.path: t for t in playlist.tracks}
        
        new_tracks = []
        for path in track_order:
            if path not in track_lookup:
                raise ValidationError(f"Track not in playlist: {path}")
            new_tracks.append(track_lookup[path])
        
        playlist.tracks = new_tracks
        
        playlist.modified_at = time.time()

        self.playlist_repo.save_playlist(playlist)
        
        self.logger.info(f"Successfully reordered tracks in playlist: {playlist_name}")
        return playlist
    
    @serialized
    def delete_playlist(self, name: str) -> None:
        """
        Delete a playlist.
        
        Args:
            name: Playlist name
            
        Raises:
            PlaylistError: If playlist not found
        """
        self.logger.debug(f"Deleting playlist: {name}")
        
        if not self.playlist_repo.playlist_exists(name):
            raise PlaylistError(f"Playlist not found: {name}")
        
        self.playlist_repo.delete_playlist(name)
        self.logger.info(f"Successfully deleted playlist: {name}")
    
    @serialized
    def rename_playlist(self, name: str, new_name: str) -> Playlist:
        """Rename a playlist, rejecting empty names, missing sources, or occupied names."""
        self.logger.debug(f"Renaming playlist: {name} -> {new_name}")

        if not new_name or len(new_name.strip()) == 0:
            raise ValidationError("Playlist name cannot be empty")
        new_name = new_name.strip()

        if not self.playlist_repo.playlist_exists(name):
            raise PlaylistError(f"Playlist not found: {name}")

        self.playlist_repo.rename_playlist(name, new_name)
        return self.playlist_repo.load_playlist(new_name)

    @serialized
    def refresh_playlist(self, name: str) -> Playlist:
        """Refresh track metadata and validity, raising PlaylistError for an absent playlist."""
        self.logger.debug(f"Refreshing playlist: {name}")
        
        playlist = self.get_playlist(name)
        
        valid_tracks = []
        removed_count = 0
        
        for track in playlist.tracks:
            if not self.music_repo.file_exists(track.path):
                self.logger.warning(f"Track no longer exists, removing: {track.path}")
                removed_count += 1
                continue
            
            # Update track metadata (fallback track_number from filename when missing in tags)
            try:
                track_info = self.music_repo.get_track_info(track.path)
                track.title = track_info.title
                track.artist = track_info.artist
                track.album = track_info.album
                track.track_number = track_info.track_number or track_number_from_path(track.path)
                track.duration = track_info.duration
                valid_tracks.append(track)
            except Exception as e:
                self.logger.warning(f"Could not update track metadata: {e}")
                valid_tracks.append(track)
        
        playlist.tracks = valid_tracks
        
        playlist.modified_at = time.time()
        playlist.total_duration = sum(t.duration or 0 for t in playlist.tracks)
        
        self.playlist_repo.save_playlist(playlist)
        
        self.logger.info(f"Refreshed playlist: {name}, removed {removed_count} invalid tracks")
        return playlist
