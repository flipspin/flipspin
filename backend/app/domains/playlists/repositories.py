"""Playlist repository for file operations."""
import logging
import json
import time
from pathlib import Path

from app.infra.changes import Changes
from app.infra.files import SHARED, write_json_atomic
from app.config import ConfigManager
from app.exceptions import PlaylistError, FileSystemError, ValidationError
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.domains.playlists.ownership import OWNER_KEY
from app.utils.path_safety import resolve_under


def _is_sidecar(path) -> bool:
    """Recognize binary AppleDouble companions that also match JSON globs.

    Skip them without deleting: listing must not remove files it did not create.
    See docs/DEVELOPER_GUIDE.md#playlist-authorization.
    """
    return path.name.startswith("._")


class PlaylistRepository:
    """Repository for playlist file operations."""
    
    def __init__(self, config: ConfigManager, logger: logging.Logger, *, changes: Changes | None = None):
        """
        Initialize playlist repository.
        
        Args:
            config: Configuration manager
            logger: Logger instance
        """
        self.changes = changes or Changes()
        self.config = config
        self.logger = logger
        self.playlist_dir = config.playlist_dir

    def _playlist_path(self, name: str) -> Path:
        """Resolve a playlist's JSON file safely under the playlist directory.

        Rejects names that try to escape via path separators or '..' (traversal),
        so a request like ``/api/playlists/..%2f..%2fsecret`` can't read or delete
        files outside the playlist dir. Reads the dir from config live so a runtime
        change is honored.
        """
        base = self.config.playlist_dir
        base.mkdir(parents=True, exist_ok=True)
        try:
            return resolve_under(base, f"{name.replace(' ', '_')}.json")
        except ValidationError as exc:
            raise PlaylistError(f"Invalid playlist name: {name}") from exc

    def save_playlist(self, playlist: Playlist) -> None:
        """
        Save playlist to JSON file.
        
        Args:
            playlist: Playlist to save
        """
        try:
            self.playlist_dir.mkdir(parents=True, exist_ok=True)
            
            playlist_file = self._playlist_path(playlist.name)
            previous_owner = self._owner(playlist_file)
            playlist.modified_at = time.time()
            
            playlist_data = playlist.to_dict()
            
            # Replaced whole, so a reader never sees half a playlist. SHARED:
            # a playlist file is read by other tools (it is just JSON beside the
            # library), unlike the per-account stores.
            write_json_atomic(playlist_file, playlist_data, mode=SHARED, indent=2, ensure_ascii=False)
            self.changes.bump('playlists')
            self._membership_changed(previous_owner, playlist.owner_id)
            
            self.logger.info(f"Saved playlist: {playlist.name}")
            
        except Exception as e:
            self.logger.error(f"Error saving playlist: {e}")
            raise PlaylistError(f"Failed to save playlist: {str(e)}")
    
    @staticmethod
    def _owner(path):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            return data.get(OWNER_KEY) if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def _membership_changed(self, previous, current):
        if previous != current:
            for account in {previous, current} - {None}:
                self.changes.bump(f'me:{account}')

    def load_playlist(self, name: str) -> Playlist:
        """
        Load playlist from JSON file.
        
        Args:
            name: Playlist name
            
        Returns:
            Playlist object
        """
        try:
            playlist_file = self._playlist_path(name)
            
            if not playlist_file.exists():
                raise PlaylistError(f"Playlist not found: {name}")
            
            with open(playlist_file, encoding='utf-8') as f:
                data = json.load(f)
            
            tracks = []
            for track_data in data.get('tracks', []):
                track = PlaylistTrack(
                    path=Path(track_data['path']),
                    title=track_data['title'],
                    artist=track_data.get('artist'),
                    album=track_data.get('album'),
                    track_number=track_data.get('track_number'),
                    duration=track_data.get('duration'),
                    date_added=track_data.get('dateAdded'),
                    album_cover=track_data.get('albumCover'),
                    genre=track_data.get('genre'),
                )
                tracks.append(track)
            
            playlist = Playlist(
                name=data['name'],
                description=data.get('description'),
                tracks=tracks,
                created_at=data.get('created'),
                modified_at=data.get('modified'),
                source_url=data.get('source_url'),
                cover=data.get('cover'),
                owner_id=data.get(OWNER_KEY)
            )
            
            playlist.total_duration = sum(t.duration or 0 for t in tracks)
            
            self.logger.debug(f"Loaded playlist: {name}")
            return playlist
            
        except json.JSONDecodeError as e:
            self.logger.error(f"Invalid playlist JSON: {e}")
            raise PlaylistError(f"Corrupted playlist file: {name}")
        except Exception as e:
            if isinstance(e, PlaylistError):
                raise
            self.logger.error(f"Error loading playlist: {e}")
            raise PlaylistError(f"Failed to load playlist: {str(e)}")
    
    def list_playlists(self) -> list[str]:
        """
        List all playlist names.
        
        Returns:
            List of playlist names
        """
        try:
            if not self.playlist_dir.exists():
                return []
            
            playlists = []
            for file in self.playlist_dir.glob("*.json"):
                if _is_sidecar(file):
                    continue
                # Extract name from filename
                name = file.stem.replace('_', ' ')
                playlists.append(name)
            
            return sorted(playlists)
            
        except Exception as e:
            self.logger.error(f"Error listing playlists: {e}")
            raise FileSystemError(f"Failed to list playlists: {str(e)}")
    
    def delete_playlist(self, name: str) -> None:
        """
        Delete a playlist file.
        
        Args:
            name: Playlist name
        """
        try:
            playlist_file = self._playlist_path(name)
            
            if not playlist_file.exists():
                raise PlaylistError(f"Playlist not found: {name}")
            
            previous_owner = self._owner(playlist_file)
            playlist_file.unlink()
            self.changes.bump('playlists')
            self._membership_changed(previous_owner, None)
            self.logger.info(f"Deleted playlist: {name}")
            
        except Exception as e:
            if isinstance(e, PlaylistError):
                raise
            self.logger.error(f"Error deleting playlist: {e}")
            raise PlaylistError(f"Failed to delete playlist: {str(e)}")
    
    def rename_playlist(self, old_name: str, new_name: str) -> None:
        """Rename a playlist: rewrite its embedded name and move its JSON file.

        Handles the case where the old and new names map to the same file
        (e.g. "My List" and "My_List" both resolve to My_List.json) by updating
        in place instead of deleting the newly written file.

        Raises:
            PlaylistError: if the source is missing or the target name is taken.
        """
        try:
            src = self._playlist_path(old_name)
            dst = self._playlist_path(new_name)

            if not src.exists():
                raise PlaylistError(f"Playlist not found: {old_name}")
            if dst != src and dst.exists():
                raise PlaylistError(f"Playlist already exists: {new_name}")

            playlist = self.load_playlist(old_name)
            playlist.name = new_name
            self.save_playlist(playlist)  # writes to dst (resolved from new name)

            if dst != src:
                src.unlink()
                self.changes.bump('playlists')

            self.logger.info(f"Renamed playlist: {old_name} -> {new_name}")

        except Exception as e:
            if isinstance(e, PlaylistError):
                raise
            self.logger.error(f"Error renaming playlist: {e}")
            raise PlaylistError(f"Failed to rename playlist: {str(e)}")

    def playlist_exists(self, name: str) -> bool:
        """
        Check if a playlist exists.
        
        Args:
            name: Playlist name
            
        Returns:
            True if playlist exists
        """
        playlist_file = self._playlist_path(name)
        return playlist_file.exists()

    def set_owner(self, name: str, owner_id: str, *, previous_owner: str | None = None) -> bool:
        """Atomically set an absent owner or transfer from the expected previous owner.

        Edit JSON without the general save path so modified_at and recent ordering
        survive migration. See docs/DEVELOPER_GUIDE.md#playlist-authorization.
        """
        playlist_file = self._playlist_path(name)
        if not playlist_file.exists():
            return False
        with open(playlist_file, encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise PlaylistError(f"Corrupted playlist file: {name}")
        current_owner = data.get(OWNER_KEY)
        if previous_owner is None and current_owner:
            return False
        if previous_owner is not None and current_owner != previous_owner:
            return False
        data[OWNER_KEY] = owner_id

        write_json_atomic(playlist_file, data)
        self.changes.bump('playlists')
        self._membership_changed(current_owner, owner_id)
        self.logger.info("Assigned playlist %r to owner %s", name, owner_id)
        return True
    
    def get_playlist_metadata(self, name: str) -> dict:
        """
        Get playlist metadata without loading all tracks.
        
        Args:
            name: Playlist name
            
        Returns:
            Dictionary with metadata
        """
        try:
            playlist_file = self._playlist_path(name)
            
            if not playlist_file.exists():
                raise PlaylistError(f"Playlist not found: {name}")
            
            with open(playlist_file, encoding='utf-8') as f:
                data = json.load(f)
            
            return {
                "name": data.get('name'),
                "description": data.get('description'),
                "trackCount": len(data.get('tracks', [])),
                "created": data.get('created'),
                "modified": data.get('modified'),
                "source_url": data.get('source_url'),
                "owner": data.get(OWNER_KEY)
            }
            
        except Exception as e:
            if isinstance(e, PlaylistError):
                raise
            self.logger.error(f"Error getting playlist metadata: {e}")
            raise PlaylistError(f"Failed to get playlist metadata: {str(e)}")
