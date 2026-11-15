"""Playlist domain models."""
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class PlaylistTrack:
    """Track within a playlist."""
    path: Path
    title: str
    artist: str | None = None
    album: str | None = None
    track_number: int | None = None
    duration: float | None = None
    date_added: float | None = None
    album_cover: str | None = None
    genre: str | None = None
    
    def to_dict(self):
        """Convert to dictionary."""
        return {
            "path": str(self.path),
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "genre": self.genre,
            "track_number": self.track_number,
            "duration": self.duration,
            "dateAdded": self.date_added,
            "albumCover": self.album_cover
        }


@dataclass
class Playlist:
    """Represents a music playlist."""
    name: str
    tracks: list[PlaylistTrack] = field(default_factory=list)
    description: str | None = None
    created_at: float | None = None
    modified_at: float | None = None
    total_duration: float = 0.0
    source_url: str | None = None
    # Playlist-level cover (e.g. the Spotify playlist artwork). Distinct from the
    # per-track album_cover; when set it represents the whole playlist.
    cover: str | None = None
    # The user_id from the per-user token table (app/domains/accounts/identity.py) that owns
    # this playlist; see domains/playlists/ownership.py for what that means.
    # None is a playlist written before ownership existed, or one dropped into
    # the directory by hand: `may_access` reads it as owner-only.
    owner_id: str | None = None

    def to_dict(self):
        """Convert to dictionary."""
        return {
            "name": self.name,
            "description": self.description,
            "tracks": [track.to_dict() for track in self.tracks],
            "created": self.created_at,
            "modified": self.modified_at,
            "source_url": self.source_url,
            "cover": self.cover,
            # Written as "owner" rather than "owner_id": this dict *is* the file
            # on disk (repositories.save_playlist), and the key is the one the
            # migration in ownership.py looks for.
            "owner": self.owner_id
        }
    
    @property
    def track_count(self) -> int:
        """Number of tracks in playlist."""
        return len(self.tracks)
