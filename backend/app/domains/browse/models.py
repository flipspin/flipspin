"""Identify browse entities by provider and id so navigation stays in the app.

Cache readers tolerate missing and unknown fields across upgrades. Durations
are seconds, matching WantedTrack; incorrect units disable the recording veto.
"""
from dataclasses import dataclass, field
from typing import Any, Optional

# Entity kinds. Persisted in the cache and read by the frontend to pick a card
# shape (a round artist avatar is not a square album cover), so these are
# stable identifiers rather than labels.
KIND_ARTIST = "artist"
KIND_ALBUM = "album"
KIND_TRACK = "track"
KIND_PLAYLIST = "playlist"
KIND_GENRE = "genre"


def _as_str(value: Any) -> str | None:
    """Coerce to a non-empty trimmed string, else None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class ProviderRef:
    """Where an entity came from, and how to ask for it again.

    ``provider`` is a registry descriptor id (``"deezer"``), never a display
    name — it is half of a route and is persisted, so it must not be renamed.
    ``url`` is the provider's own web page for this entity: useful as a
    secondary "open on Deezer" affordance, and deliberately *not* the identity.
    """

    provider: str
    id: str
    url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"provider": self.provider, "id": self.id, "url": self.url}

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["ProviderRef"]:
        if not isinstance(raw, dict):
            return None
        provider = _as_str(raw.get("provider"))
        entity_id = _as_str(raw.get("id"))
        if not provider or not entity_id:
            return None
        return cls(provider=provider, id=entity_id, url=_as_str(raw.get("url")))


@dataclass(frozen=True)
class BrowseArtist:
    ref: ProviderRef
    name: str
    image_url: str | None = None
    fan_count: int | None = None
    album_count: int | None = None

    kind: str = field(default=KIND_ARTIST, init=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": KIND_ARTIST,
            "ref": self.ref.to_dict(),
            "name": self.name,
            "imageUrl": self.image_url,
            "fanCount": self.fan_count,
            "albumCount": self.album_count,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["BrowseArtist"]:
        if not isinstance(raw, dict):
            return None
        ref = ProviderRef.from_dict(raw.get("ref"))
        name = _as_str(raw.get("name"))
        if ref is None or not name:
            return None
        return cls(
            ref=ref,
            name=name,
            image_url=_as_str(raw.get("imageUrl")),
            fan_count=_as_int(raw.get("fanCount")),
            album_count=_as_int(raw.get("albumCount")),
        )


@dataclass(frozen=True)
class BrowseAlbum:
    ref: ProviderRef
    title: str
    artist_name: str | None = None
    artist_ref: ProviderRef | None = None
    cover_url: str | None = None
    release_date: str | None = None
    record_type: str | None = None
    track_count: int | None = None
    label: str | None = None
    genres: list[str] = field(default_factory=list)

    kind: str = field(default=KIND_ALBUM, init=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": KIND_ALBUM,
            "ref": self.ref.to_dict(),
            "title": self.title,
            "artistName": self.artist_name,
            "artistRef": self.artist_ref.to_dict() if self.artist_ref else None,
            "coverUrl": self.cover_url,
            "releaseDate": self.release_date,
            "recordType": self.record_type,
            "trackCount": self.track_count,
            "label": self.label,
            "genres": list(self.genres),
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["BrowseAlbum"]:
        if not isinstance(raw, dict):
            return None
        ref = ProviderRef.from_dict(raw.get("ref"))
        title = _as_str(raw.get("title"))
        if ref is None or not title:
            return None
        genres_raw = raw.get("genres")
        genres = [g for g in (_as_str(x) for x in genres_raw) if g] if isinstance(genres_raw, list) else []
        return cls(
            ref=ref,
            title=title,
            artist_name=_as_str(raw.get("artistName")),
            artist_ref=ProviderRef.from_dict(raw.get("artistRef")),
            cover_url=_as_str(raw.get("coverUrl")),
            release_date=_as_str(raw.get("releaseDate")),
            record_type=_as_str(raw.get("recordType")),
            track_count=_as_int(raw.get("trackCount")),
            label=_as_str(raw.get("label")),
            genres=genres,
        )


@dataclass(frozen=True)
class BrowseTrack:
    """One row of a tracklist.

    ``isrc`` is the field that decides whether acquiring this track can be
    auto-accepted: ``matching.match_track`` refuses to return STRONG for a
    candidate carrying neither an ISRC nor an MBID. It is populated for album
    and playlist tracklists and absent from search results, which is a property
    of Deezer's endpoints rather than a choice made here — see
    ``DeezerRepository.fetch_album_tracks``.
    """

    ref: ProviderRef
    title: str
    artist_name: str | None = None
    artist_ref: ProviderRef | None = None
    album_title: str | None = None
    album_ref: ProviderRef | None = None
    cover_url: str | None = None
    duration_s: float | None = None
    track_position: int | None = None
    disc_number: int | None = None
    isrc: str | None = None
    preview_url: str | None = None
    explicit: bool = False

    kind: str = field(default=KIND_TRACK, init=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": KIND_TRACK,
            "ref": self.ref.to_dict(),
            "title": self.title,
            "artistName": self.artist_name,
            "artistRef": self.artist_ref.to_dict() if self.artist_ref else None,
            "albumTitle": self.album_title,
            "albumRef": self.album_ref.to_dict() if self.album_ref else None,
            "coverUrl": self.cover_url,
            # Seconds. See the module docstring — never milliseconds.
            "durationSeconds": self.duration_s,
            "trackPosition": self.track_position,
            "discNumber": self.disc_number,
            "isrc": self.isrc,
            "previewUrl": self.preview_url,
            "explicit": self.explicit,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["BrowseTrack"]:
        if not isinstance(raw, dict):
            return None
        ref = ProviderRef.from_dict(raw.get("ref"))
        title = _as_str(raw.get("title"))
        if ref is None or not title:
            return None
        return cls(
            ref=ref,
            title=title,
            artist_name=_as_str(raw.get("artistName")),
            artist_ref=ProviderRef.from_dict(raw.get("artistRef")),
            album_title=_as_str(raw.get("albumTitle")),
            album_ref=ProviderRef.from_dict(raw.get("albumRef")),
            cover_url=_as_str(raw.get("coverUrl")),
            duration_s=_as_float(raw.get("durationSeconds")),
            track_position=_as_int(raw.get("trackPosition")),
            disc_number=_as_int(raw.get("discNumber")),
            isrc=_as_str(raw.get("isrc")),
            preview_url=_as_str(raw.get("previewUrl")),
            explicit=bool(raw.get("explicit")),
        )


@dataclass(frozen=True)
class BrowsePlaylist:
    ref: ProviderRef
    title: str
    owner: str | None = None
    picture_url: str | None = None
    track_count: int | None = None
    description: str | None = None

    kind: str = field(default=KIND_PLAYLIST, init=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": KIND_PLAYLIST,
            "ref": self.ref.to_dict(),
            "title": self.title,
            "owner": self.owner,
            "pictureUrl": self.picture_url,
            "trackCount": self.track_count,
            "description": self.description,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["BrowsePlaylist"]:
        if not isinstance(raw, dict):
            return None
        ref = ProviderRef.from_dict(raw.get("ref"))
        title = _as_str(raw.get("title"))
        if ref is None or not title:
            return None
        return cls(
            ref=ref,
            title=title,
            owner=_as_str(raw.get("owner")),
            picture_url=_as_str(raw.get("pictureUrl")),
            track_count=_as_int(raw.get("trackCount")),
            description=_as_str(raw.get("description")),
        )


@dataclass(frozen=True)
class BrowseGenre:
    ref: ProviderRef
    name: str
    image_url: str | None = None

    kind: str = field(default=KIND_GENRE, init=False)

    def to_dict(self) -> dict[str, Any]:
        return {"kind": KIND_GENRE, "ref": self.ref.to_dict(), "name": self.name, "imageUrl": self.image_url}

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["BrowseGenre"]:
        if not isinstance(raw, dict):
            return None
        ref = ProviderRef.from_dict(raw.get("ref"))
        name = _as_str(raw.get("name"))
        if ref is None or not name:
            return None
        return cls(ref=ref, name=name, image_url=_as_str(raw.get("imageUrl")))


def _list_from(raw: Any, factory) -> list[Any]:
    """Rebuild a list of entities, dropping anything unusable."""
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        built = factory(entry)
        if built is not None:
            out.append(built)
    return out


@dataclass(frozen=True)
class ArtistPage:
    """Everything an artist page shows.

    Sections are independently optional because they are capability-gated: a
    provider that never declared ``artist:related`` simply has none, and the UI
    renders the sections it was given rather than an empty heading.
    """

    artist: BrowseArtist
    top_tracks: list[BrowseTrack] = field(default_factory=list)
    albums: list[BrowseAlbum] = field(default_factory=list)
    related: list[BrowseArtist] = field(default_factory=list)
    playlists: list[BrowsePlaylist] = field(default_factory=list)
    partial: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "artist": self.artist.to_dict(),
            "topTracks": [t.to_dict() for t in self.top_tracks],
            "albums": [a.to_dict() for a in self.albums],
            "related": [a.to_dict() for a in self.related],
            "playlists": [p.to_dict() for p in self.playlists],
            # Sections that were requested and failed, so the UI can say "this
            # part is missing" instead of implying the artist has no albums.
            "partial": list(self.partial),
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["ArtistPage"]:
        if not isinstance(raw, dict):
            return None
        artist = BrowseArtist.from_dict(raw.get("artist"))
        if artist is None:
            return None
        partial = raw.get("partial")
        return cls(
            artist=artist,
            top_tracks=_list_from(raw.get("topTracks"), BrowseTrack.from_dict),
            albums=_list_from(raw.get("albums"), BrowseAlbum.from_dict),
            related=_list_from(raw.get("related"), BrowseArtist.from_dict),
            playlists=_list_from(raw.get("playlists"), BrowsePlaylist.from_dict),
            partial=[p for p in (_as_str(x) for x in partial) if p] if isinstance(partial, list) else [],
        )


@dataclass(frozen=True)
class AlbumPage:
    album: BrowseAlbum
    tracks: list[BrowseTrack] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"album": self.album.to_dict(), "tracks": [t.to_dict() for t in self.tracks]}

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["AlbumPage"]:
        if not isinstance(raw, dict):
            return None
        album = BrowseAlbum.from_dict(raw.get("album"))
        if album is None:
            return None
        return cls(album=album, tracks=_list_from(raw.get("tracks"), BrowseTrack.from_dict))


@dataclass(frozen=True)
class GenrePage:
    """A genre's own chart: its top songs, albums, artists and lists.

    One ``/chart/{id}`` answers all four, plus ``/genre/{id}`` for the name and
    picture — two requests for the whole page.
    """

    genre: BrowseGenre
    tracks: list[BrowseTrack] = field(default_factory=list)
    albums: list[BrowseAlbum] = field(default_factory=list)
    artists: list[BrowseArtist] = field(default_factory=list)
    playlists: list[BrowsePlaylist] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "genre": self.genre.to_dict(),
            "tracks": [t.to_dict() for t in self.tracks],
            "albums": [a.to_dict() for a in self.albums],
            "artists": [a.to_dict() for a in self.artists],
            "playlists": [p.to_dict() for p in self.playlists],
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["GenrePage"]:
        if not isinstance(raw, dict):
            return None
        genre = BrowseGenre.from_dict(raw.get("genre"))
        if genre is None:
            return None
        return cls(
            genre=genre,
            tracks=_list_from(raw.get("tracks"), BrowseTrack.from_dict),
            albums=_list_from(raw.get("albums"), BrowseAlbum.from_dict),
            artists=_list_from(raw.get("artists"), BrowseArtist.from_dict),
            playlists=_list_from(raw.get("playlists"), BrowsePlaylist.from_dict),
        )


@dataclass(frozen=True)
class PlaylistPage:
    playlist: BrowsePlaylist
    tracks: list[BrowseTrack] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"playlist": self.playlist.to_dict(), "tracks": [t.to_dict() for t in self.tracks]}

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["PlaylistPage"]:
        if not isinstance(raw, dict):
            return None
        playlist = BrowsePlaylist.from_dict(raw.get("playlist"))
        if playlist is None:
            return None
        return cls(playlist=playlist, tracks=_list_from(raw.get("tracks"), BrowseTrack.from_dict))


@dataclass(frozen=True)
class SearchResults:
    """Catalog search, split by kind.

    Categories are separate rather than one ranked list because they are what
    the UI tabs on, and because a provider may support some and not others —
    ``requested`` records what was asked for so "no albums found" can be told
    apart from "this provider cannot search albums".
    """

    query: str
    artists: list[BrowseArtist] = field(default_factory=list)
    albums: list[BrowseAlbum] = field(default_factory=list)
    tracks: list[BrowseTrack] = field(default_factory=list)
    playlists: list[BrowsePlaylist] = field(default_factory=list)
    requested: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "artists": [a.to_dict() for a in self.artists],
            "albums": [a.to_dict() for a in self.albums],
            "tracks": [t.to_dict() for t in self.tracks],
            "playlists": [p.to_dict() for p in self.playlists],
            "requested": list(self.requested),
            "failed": list(self.failed),
        }


__all__ = [
    "KIND_ALBUM",
    "KIND_ARTIST",
    "KIND_PLAYLIST",
    "KIND_TRACK",
    "AlbumPage",
    "ArtistPage",
    "BrowseAlbum",
    "BrowseArtist",
    "BrowsePlaylist",
    "BrowseTrack",
    "PlaylistPage",
    "ProviderRef",
    "SearchResults",
]
