"""The library as Subsonic sees it: artists → albums → songs, with ids.

Built from ``MusicRepository.scan_albums()``, which is already memoized against
the library's shape, and rebuilt only when that returns a different list. An
artist is an album's artist (the album-artist tag when the files carry one); a
song keeps its own artist name but points at its album's artist.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime, UTC
from pathlib import Path

from app.domains.music.models import Album, Track
from app.domains.user_library.scope import LibraryScope
from app.utils.library_paths import album_key, disc_number as folder_disc_number, rel_path_for

from . import ids

_ARTICLES = ("The ", "El ", "La ", "Los ", "Las ", "Les ", "Le ", "Die ")
IGNORED_ARTICLES = " ".join(a.strip() for a in _ARTICLES)

CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".opus": "audio/ogg",
}


@dataclass
class SongEntry:
    id: str
    rel_path: str
    track: Track
    album: AlbumEntry


@dataclass
class AlbumEntry:
    id: str
    key: str
    album: Album
    artist_id: str
    songs: list[SongEntry] = field(default_factory=list)

    @property
    def created(self) -> float:
        stamps = [s.track.date_added for s in self.songs if s.track.date_added]
        return min(stamps) if stamps else 0.0


@dataclass
class ArtistEntry:
    id: str
    name: str
    albums: list[AlbumEntry] = field(default_factory=list)


@dataclass
class Library:
    artists: dict[str, ArtistEntry]
    albums: dict[str, AlbumEntry]
    songs: dict[str, SongEntry]
    by_rel_path: dict[str, SongEntry]


def filtered_library(library: Library, scope: LibraryScope) -> Library:
    """An isolated view of the cached index; never scans or mutates shared entries."""
    if scope.unrestricted:
        return library
    artists: dict[str, ArtistEntry] = {}
    albums: dict[str, AlbumEntry] = {}
    songs: dict[str, SongEntry] = {}
    by_rel: dict[str, SongEntry] = {}
    for original in library.albums.values():
        allowed = [s for s in original.songs if scope.allows(s.rel_path)]
        if not allowed:
            continue
        tracks = [s.track for s in allowed]
        album = replace(original.album, tracks=tracks,
                        total_duration=sum(t.duration or 0 for t in tracks),
                        genres=list(dict.fromkeys(g for t in tracks for g in t.genres)),
                        genre=next((t.genre for t in tracks if t.genre), None))
        entry = AlbumEntry(original.id, original.key, album, original.artist_id)
        for old_song in allowed:
            song = replace(old_song, album=entry)
            entry.songs.append(song)
            songs[song.id] = song
            by_rel[song.rel_path] = song
        albums[entry.id] = entry
        artist = library.artists[entry.artist_id]
        artists.setdefault(artist.id, ArtistEntry(artist.id, artist.name)).albums.append(entry)
    return Library(artists, albums, songs, by_rel)


def iso(timestamp: float | None) -> str | None:
    if not timestamp:
        return None
    return datetime.fromtimestamp(timestamp, tz=UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def sort_name(name: str) -> str:
    for article in _ARTICLES:
        if name.startswith(article):
            return name[len(article):]
    return name


def index_letter(name: str) -> str:
    first = ids.fold(sort_name(name))[:1].upper()
    return first if first.isalpha() else "#"


def disc_number(album_dir: Path, track_path: Path) -> int | None:
    if track_path.parent == album_dir:
        return None
    return folder_disc_number(track_path.parent.name)


def build(base: Path, albums: list[Album]) -> Library:
    artists: dict[str, ArtistEntry] = {}
    by_album: dict[str, AlbumEntry] = {}
    songs: dict[str, SongEntry] = {}
    by_rel: dict[str, SongEntry] = {}
    for album in albums:
        key = album_key(base, album.path)
        if key is None:
            continue
        name = (album.artist or "Unknown Artist").strip() or "Unknown Artist"
        artist_id = ids.make(ids.ARTIST, ids.fold(name))
        artist = artists.setdefault(artist_id, ArtistEntry(id=artist_id, name=name))
        entry = AlbumEntry(id=ids.make(ids.ALBUM, key), key=key, album=album, artist_id=artist_id)
        for track in album.tracks:
            rel = rel_path_for(base, track.path)
            if rel is None:
                continue
            song = SongEntry(id=ids.make(ids.SONG, rel), rel_path=rel, track=track, album=entry)
            entry.songs.append(song)
            songs[song.id] = song
            by_rel[rel] = song
        if entry.songs:
            artist.albums.append(entry)
            by_album[entry.id] = entry
    return Library(
        artists={k: a for k, a in artists.items() if a.albums},
        albums=by_album,
        songs=songs,
        by_rel_path=by_rel,
    )


class LibraryIndex:
    """One built :class:`Library`, reused while the scan it came from is."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # The scan list itself, held so its identity can't be reused by a new one.
        self._albums: list[Album] | None = None
        self._base: Path | None = None
        self._library: Library | None = None
        self._scoped = OrderedDict()

    def get(self, music_repo) -> Library:
        base = music_repo.config.base_music_dir
        albums = music_repo.scan_albums()
        with self._lock:
            if self._library is None or albums is not self._albums or base != self._base:
                self._library = build(base, albums)
                self._albums, self._base = albums, base
                self._scoped.clear()
            return self._library

    def for_scope(self, music_repo, scope):
        library = self.get(music_repo)
        if scope.unrestricted:
            return library
        with self._lock:
            # Hold the scope itself, so an evicted snapshot's id cannot be reused.
            key = id(scope)
            cached = self._scoped.get(key)
            if cached is None or cached[1] is not library:
                cached = (scope, library, filtered_library(library, scope))
                self._scoped[key] = cached
            self._scoped.move_to_end(key)
            if len(self._scoped) > 256:
                self._scoped.popitem(last=False)
            return cached[2]


INDEX = LibraryIndex()
