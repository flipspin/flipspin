"""Music domain models."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class AudioMetadata:
    """ID3 metadata for audio files."""
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    track_number: int | None = None
    year: int | None = None
    genre: str | None = None
    cover_art: bytes | None = None
    duration: float | None = None
    bpm: int | None = None
    album_artist: str | None = None
    composer: str | None = None
    disc_number: int | None = None
    isrc: str | None = None
    track_total: int | None = None
    disc_total: int | None = None
    compilation: bool | None = None
    recording_mbid: str | None = None
    release_mbid: str | None = None
    release_group_mbid: str | None = None
    artist_mbid: str | list[str] | None = None
    artists: list[str] = field(default_factory=list)
    album_artists: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    title_sort: str | None = None
    artist_sort: str | None = None
    album_sort: str | None = None
    album_artist_sort: str | None = None
    composer_sort: str | None = None


@dataclass
class Track:
    """Represents a music track."""
    title: str
    artist: str
    album: str
    path: Path
    track_number: int | None = None
    duration: float | None = None
    file_size: int = 0
    date_added: float | None = None
    genre: str | None = None
    bpm: int | None = None
    key: str | None = None
    mood: str | None = None
    analysis: dict[str, Any] | None = None
    isrc: str | None = None
    artists: list[str] = field(default_factory=list)
    genres: list[str] = field(default_factory=list)
    album_artist: str | None = None
    album_artists: list[str] = field(default_factory=list)
    disc_number: int | None = None
    compilation: bool | None = None
    year: int | None = None
    title_sort: str | None = None
    artist_sort: str | None = None
    album_sort: str | None = None
    album_artist_sort: str | None = None
    composer_sort: str | None = None
    missing: bool = False
    missing_since: str | None = None

    def tag_dict(self):
        """Additive tag fields shared by listing and track serializers."""
        return {
            'artists': self.artists, 'genres': self.genres,
            'albumArtist': self.album_artist, 'albumArtists': self.album_artists,
            'discNumber': self.disc_number, 'compilation': self.compilation, 'year': self.year,
            'titleSort': self.title_sort, 'artistSort': self.artist_sort,
            'albumSort': self.album_sort, 'albumArtistSort': self.album_artist_sort,
            'composerSort': self.composer_sort,
        }

    def to_dict(self):
        """Convert to dictionary."""
        return {
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "path": str(self.path),
            "track_number": self.track_number,
            "duration": self.duration,
            "file_size": self.file_size,
            "date_added": self.date_added,
            "genre": self.genre,
            "bpm": self.bpm,
            "key": self.key,
            "mood": self.mood,
            "analysis": self.analysis,
            **self.tag_dict(),
        }


@dataclass
class Album:
    """Represents a music album."""
    name: str
    artist: str
    path: Path
    tracks: list[Track]
    cover_art: Path | None = None
    year: int | None = None
    genre: str | None = None
    total_duration: float = 0.0
    album_artist: str | None = None
    compilation: bool = False
    genres: list[str] = field(default_factory=list)
    album_sort: str | None = None
    album_artist_sort: str | None = None

    def tag_dict(self):
        return {
            'albumArtist': self.album_artist, 'compilation': self.compilation,
            'genres': self.genres, 'albumSort': self.album_sort,
            'albumArtistSort': self.album_artist_sort,
        }
    
    def to_dict(self):
        """Convert to dictionary."""
        return {
            "name": self.name,
            "artist": self.artist,
            "path": str(self.path),
            "tracks": [track.to_dict() for track in self.tracks],
            "cover_art": str(self.cover_art) if self.cover_art else None,
            "year": self.year,
            "genre": self.genre,
            "total_duration": self.total_duration,
            **self.tag_dict(),
        }
