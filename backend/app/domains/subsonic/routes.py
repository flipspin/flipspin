"""``/rest/{method}``: the Subsonic API, one handler per method.

Not behind ``require_api_token``: credentials travel in the parameters
(``auth.py``). Credential failures use Subsonic error bodies with HTTP 200;
helper capability denials use HTTP 403. Media answers (``stream``, ``download``, ``getCoverArt``)
are files, with ``Range``, through the same helper as ``/api/media``.

Contract and scope: ``docs/features/opensubsonic.md``.
"""
from __future__ import annotations

import random
import re
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from starlette.datastructures import MultiDict

from app.infra.identity import Principal, authorize_credential
from app.infra.uploads import bounded_form
from app.domains.music.routes import AUDIO_CACHE_CONTROL, COVER_CACHE_CONTROL, _file_response
from app.domains.playlists.covers import _cover_albums
from app.domains.playlists.ownership import may_access, owner_id_for, visible_playlists
from app.domains.user_library.scope import LibraryScope, get_library_scope
from app.domains.user_library.plays import record_batch
from app.exceptions import PlaylistError, ValidationError
from app.utils.library_paths import rel_path_for, resolve_rel_path

from . import ids
from .auth import AUTH_PARAMETERS, authenticate
from .library import (
    CONTENT_TYPES,
    IGNORED_ARTICLES,
    INDEX,
    AlbumEntry,
    ArtistEntry,
    Library,
    SongEntry,
    disc_number,
    index_letter,
    iso,
    sort_name,
)
from .render import (
    GENERIC,
    MISSING_PARAMETER,
    NOT_AUTHORIZED,
    NOT_FOUND,
    SubsonicError,
    error,
    respond,
)

router = APIRouter(prefix="/rest", include_in_schema=False)

# ------------------------------------------------------------------ context


@dataclass
class Ctx:
    request: Request
    params: MultiDict
    principal: Principal
    container: Any

    def get(self, name: str, default: str | None = None) -> str | None:
        value = self.params.get(name)
        return value if value not in (None, "") else default

    def need(self, name: str) -> str:
        value = self.get(name)
        if value is None:
            raise SubsonicError(MISSING_PARAMETER, f"Falta el parámetro «{name}».")
        return value

    def many(self, name: str) -> list[str]:
        return [v for v in self.params.getlist(name) if v]

    def int(self, name: str, default: int, top: int | None = None) -> int:
        try:
            value = int(self.get(name, str(default)))
        except ValueError:
            value = default
        value = max(0, value)
        return min(value, top) if top is not None else value

    @property
    def music_repo(self):
        return self.container.get_music_repository()

    @property
    def scope(self) -> LibraryScope:
        if not hasattr(self, "_scope"):
            self._scope = get_library_scope(self.request)
        return self._scope

    @property
    def library(self) -> Library:
        if not hasattr(self, "_library"):
            self._library = INDEX.for_scope(self.music_repo, self.scope)
        return self._library

    @property
    def base(self) -> Path:
        return self.container.config.base_music_dir

    @property
    def rows(self) -> dict:
        """This account's library rows by relPath (liked, play counts)."""
        if not hasattr(self, "_rows"):
            store = self.container.get_user_track_store()
            self._rows = {r.rel_path: r for r in store.list_for_user(self.principal.user_id)}
        return self._rows

    @property
    def stars(self) -> dict[str, str]:
        if not hasattr(self, "_stars"):
            self._stars = self.container.get_star_store().starred(self.principal.user_id)
        return self._stars


# -------------------------------------------------------------- serializers


def song_dict(ctx: Ctx, song: SongEntry) -> dict[str, Any]:
    track, album = song.track, song.album
    row = ctx.rows.get(song.rel_path)
    suffix = track.path.suffix.lower()
    duration = int(track.duration or 0)
    return {
        "id": song.id,
        "parent": album.id,
        "isDir": False,
        "title": track.title,
        "album": album.album.name,
        "artist": track.artist,
        "track": track.track_number,
        "year": album.album.year,
        "genre": track.genre or album.album.genre,
        "coverArt": album.id if album.album.cover_art else None,
        "size": track.file_size,
        "contentType": CONTENT_TYPES.get(suffix, "audio/mpeg"),
        "suffix": suffix.lstrip("."),
        "duration": duration,
        "bitRate": int(track.file_size * 8 / duration / 1000) if duration else None,
        "path": song.rel_path.replace("∕", "/"),
        "isVideo": False,
        "type": "music",
        "mediaType": "song",
        "albumId": album.id,
        "artistId": album.artist_id,
        "created": iso(track.date_added),
        "discNumber": track.disc_number or disc_number(album.album.path, track.path),
        "bpm": track.bpm,
        "replayGain": (track.analysis or {}).get("replayGain"),
        "playCount": row.play_count if row else 0,
        "played": row.last_played_at if row else None,
        "starred": row.added_at if row and row.liked else None,
    }


def album_dict(ctx: Ctx, album: AlbumEntry, with_songs: bool = False) -> dict[str, Any]:
    plays = [ctx.rows[s.rel_path] for s in album.songs if s.rel_path in ctx.rows]
    out: dict[str, Any] = {
        "id": album.id,
        "parent": album.artist_id,
        "isDir": True,
        "title": album.album.name,
        "name": album.album.name,
        "album": album.album.name,
        "artist": ctx.library.artists[album.artist_id].name if album.artist_id in ctx.library.artists else album.album.artist,
        "artistId": album.artist_id,
        "coverArt": album.id if album.album.cover_art else None,
        "songCount": len(album.songs),
        "duration": int(album.album.total_duration or 0),
        "created": iso(album.created),
        "year": album.album.year,
        "genre": album.album.genre,
        "playCount": sum(r.play_count for r in plays),
        "played": max((r.last_played_at for r in plays if r.last_played_at), default=None),
        "starred": ctx.stars.get(album.id),
        "mediaType": "album",
    }
    if with_songs:
        out["song"] = [song_dict(ctx, s) for s in album.songs]
    return out


def artist_dict(ctx: Ctx, artist: ArtistEntry, with_albums: bool = False) -> dict[str, Any]:
    cover = next((a.id for a in artist.albums if a.album.cover_art), None)
    out: dict[str, Any] = {
        "id": artist.id,
        "name": artist.name,
        "coverArt": cover,
        "albumCount": len(artist.albums),
        "starred": ctx.stars.get(artist.id),
        "sortName": sort_name(artist.name),
    }
    if with_albums:
        out["album"] = [album_dict(ctx, a) for a in artist.albums]
    return out


def _lookup(ctx: Ctx, value: str | None, *kinds: str):
    parsed = ids.parse(value)
    if parsed is None or parsed[0] not in kinds:
        raise SubsonicError(NOT_FOUND, "No encontrado.")
    kind, _ = parsed
    found = {
        ids.SONG: ctx.library.songs,
        ids.ALBUM: ctx.library.albums,
        ids.ARTIST: ctx.library.artists,
    }.get(kind, {}).get(value)
    if found is None:
        raise SubsonicError(NOT_FOUND, "No encontrado.")
    return kind, found


def _artist_indexes(ctx: Ctx) -> list[dict[str, Any]]:
    groups: dict[str, list[ArtistEntry]] = {}
    for artist in ctx.library.artists.values():
        groups.setdefault(index_letter(artist.name), []).append(artist)
    out = []
    for letter in sorted(groups, key=lambda k: (k == "#", k)):
        members = sorted(groups[letter], key=lambda a: ids.fold(sort_name(a.name)))
        out.append({"name": letter, "artist": [artist_dict(ctx, a) for a in members]})
    return out


def _page(items: list, ctx: Ctx, size_name: str, offset_name: str, default: int, top: int = 500) -> list:
    size = ctx.int(size_name, default, top)
    offset = ctx.int(offset_name, 0)
    return items[offset:offset + size]


# ----------------------------------------------------------------- handlers

Handler = Callable[[Ctx], Any]
HANDLERS: dict[str, Handler] = {}


def method(*names: str):
    def register(fn: Handler) -> Handler:
        for name in names:
            HANDLERS[name.lower()] = fn
        return fn
    return register


@method("ping")
def ping(ctx: Ctx):
    return {}


@method("tokenInfo")
def token_info(ctx: Ctx):
    account = ctx.container.get_token_store().get_user(ctx.principal.user_id)
    return {"tokenInfo": {"username": account.username or account.label}}


@method("getLicense")
def get_license(ctx: Ctx):
    return {"license": {"valid": True}}


def extensions() -> dict:
    return {
        "openSubsonicExtensions": [
            {"name": "formPost", "versions": [1]},
            # Includes tokenInfo; keys also work as plain p (never t+s).
            {"name": "apiKeyAuthentication", "versions": [1]},
            {"name": "songLyrics", "versions": [1]},
        ]
    }


@method("getScanStatus")
def get_scan_status(ctx: Ctx):
    return {"scanStatus": {"scanning": False, "count": len(ctx.library.songs)}}


@method("startScan")
def start_scan(ctx: Ctx):
    # Members can refresh their status without invalidating the household index.
    if ctx.scope.unrestricted:
        ctx.music_repo.invalidate_scan()
    return get_scan_status(ctx)


@method("getMusicFolders")
def get_music_folders(ctx: Ctx):
    return {"musicFolders": {"musicFolder": [{"id": 1, "name": "Música"}]}}


@method("getIndexes")
def get_indexes(ctx: Ctx):
    return {"indexes": {"ignoredArticles": IGNORED_ARTICLES, "lastModified": 0, "index": _artist_indexes(ctx)}}


@method("getArtists")
def get_artists(ctx: Ctx):
    return {"artists": {"ignoredArticles": IGNORED_ARTICLES, "index": _artist_indexes(ctx)}}


@method("getArtist")
def get_artist(ctx: Ctx):
    _, artist = _lookup(ctx, ctx.need("id"), ids.ARTIST)
    return {"artist": artist_dict(ctx, artist, with_albums=True)}


@method("getAlbum")
def get_album(ctx: Ctx):
    _, album = _lookup(ctx, ctx.need("id"), ids.ALBUM)
    return {"album": album_dict(ctx, album, with_songs=True)}


@method("getSong")
def get_song(ctx: Ctx):
    _, song = _lookup(ctx, ctx.need("id"), ids.SONG)
    return {"song": song_dict(ctx, song)}


@method("getMusicDirectory")
def get_music_directory(ctx: Ctx):
    kind, found = _lookup(ctx, ctx.need("id"), ids.ARTIST, ids.ALBUM)
    if kind == ids.ARTIST:
        return {"directory": {"id": found.id, "name": found.name,
                              "child": [album_dict(ctx, a) for a in found.albums]}}
    return {"directory": {"id": found.id, "name": found.album.name, "parent": found.artist_id,
                          "child": [song_dict(ctx, s) for s in found.songs]}}


@method("getGenres")
def get_genres(ctx: Ctx):
    counts: dict[str, list] = {}
    for album in ctx.library.albums.values():
        for song in album.songs:
            genre = song.track.genre or album.album.genre
            if not genre:
                continue
            entry = counts.setdefault(genre, [0, set()])
            entry[0] += 1
            entry[1].add(album.id)
    return {"genres": {"genre": [
        {"value": g, "songCount": c[0], "albumCount": len(c[1])}
        for g, c in sorted(counts.items(), key=lambda kv: ids.fold(kv[0]))
    ]}}


@method("getArtistInfo")
def get_artist_info(ctx: Ctx):
    if not ctx.scope.unrestricted:
        _lookup(ctx, ctx.need("id"), ids.ARTIST)
    return {"artistInfo": {}}


@method("getArtistInfo2")
def get_artist_info2(ctx: Ctx):
    if not ctx.scope.unrestricted:
        _lookup(ctx, ctx.need("id"), ids.ARTIST)
    return {"artistInfo2": {}}


@method("getAlbumInfo", "getAlbumInfo2")
def get_album_info(ctx: Ctx):
    if not ctx.scope.unrestricted:
        _lookup(ctx, ctx.need("id"), ids.ALBUM)
    return {"albumInfo": {}}


def _albums_for_list(ctx: Ctx) -> list[AlbumEntry]:
    kind = ctx.need("type")
    albums = list(ctx.library.albums.values())
    plays = lambda a: [ctx.rows[s.rel_path] for s in a.songs if s.rel_path in ctx.rows]  # noqa: E731
    if kind == "random":
        random.shuffle(albums)
    elif kind == "newest":
        albums.sort(key=lambda a: a.created, reverse=True)
    elif kind == "alphabeticalByName":
        albums.sort(key=lambda a: ids.fold(a.album.name))
    elif kind == "alphabeticalByArtist":
        albums.sort(key=lambda a: (ids.fold(sort_name(a.album.artist or "")), ids.fold(a.album.name)))
    elif kind == "byYear":
        start, end = ctx.int("fromYear", 0), ctx.int("toYear", 9999)
        low, high = min(start, end), max(start, end)
        albums = [a for a in albums if a.album.year and low <= a.album.year <= high]
        albums.sort(key=lambda a: a.album.year, reverse=start > end)
    elif kind == "byGenre":
        genre = ids.fold(ctx.need("genre"))
        albums = [a for a in albums if ids.fold(a.album.genre) == genre]
    elif kind == "frequent":
        albums = [a for a in albums if sum(r.play_count for r in plays(a))]
        albums.sort(key=lambda a: sum(r.play_count for r in plays(a)), reverse=True)
    elif kind == "recent":
        last = lambda a: max((r.last_played_at for r in plays(a) if r.last_played_at), default="")  # noqa: E731
        albums = [a for a in albums if last(a)]
        albums.sort(key=last, reverse=True)
    elif kind == "starred":
        albums = [a for a in albums if a.id in ctx.stars]
    elif kind == "highest":
        albums = []
    else:
        raise SubsonicError(GENERIC, f"Tipo de lista desconocido: {kind}")
    return _page(albums, ctx, "size", "offset", 10)


@method("getAlbumList")
def get_album_list(ctx: Ctx):
    return {"albumList": {"album": [album_dict(ctx, a) for a in _albums_for_list(ctx)]}}


@method("getAlbumList2")
def get_album_list2(ctx: Ctx):
    return {"albumList2": {"album": [album_dict(ctx, a) for a in _albums_for_list(ctx)]}}


@method("getRandomSongs")
def get_random_songs(ctx: Ctx):
    songs = list(ctx.library.songs.values())
    genre = ctx.get("genre")
    if genre:
        songs = [s for s in songs if ids.fold(s.track.genre or s.album.album.genre) == ids.fold(genre)]
    start, end = ctx.int("fromYear", 0), ctx.int("toYear", 9999)
    if ctx.get("fromYear") or ctx.get("toYear"):
        songs = [s for s in songs if s.album.album.year and start <= s.album.album.year <= end]
    random.shuffle(songs)
    return {"randomSongs": {"song": [song_dict(ctx, s) for s in songs[: ctx.int("size", 10, 500)]]}}


@method("getSongsByGenre")
def get_songs_by_genre(ctx: Ctx):
    genre = ids.fold(ctx.need("genre"))
    songs = [s for s in ctx.library.songs.values() if ids.fold(s.track.genre or s.album.album.genre) == genre]
    return {"songsByGenre": {"song": [song_dict(ctx, s) for s in _page(songs, ctx, "count", "offset", 10)]}}


def _starred(ctx: Ctx) -> dict[str, list]:
    songs = [ctx.library.by_rel_path[r] for r, row in ctx.rows.items() if row.liked and r in ctx.library.by_rel_path]
    return {
        "artist": [artist_dict(ctx, ctx.library.artists[i]) for i in ctx.stars if i in ctx.library.artists],
        "album": [album_dict(ctx, ctx.library.albums[i]) for i in ctx.stars if i in ctx.library.albums],
        "song": [song_dict(ctx, s) for s in songs],
    }


@method("getStarred")
def get_starred(ctx: Ctx):
    return {"starred": _starred(ctx)}


@method("getStarred2")
def get_starred2(ctx: Ctx):
    return {"starred2": _starred(ctx)}


@method("getNowPlaying")
def get_now_playing(ctx: Ctx):
    return {"nowPlaying": {}}


def _search(ctx: Ctx) -> dict[str, list]:
    raw = (ctx.get("query") or "").strip().strip('"')
    needle = ids.fold(raw)
    words = needle.split()

    def hit(*fields: str | None) -> bool:
        if not words:
            return True
        hay = " ".join(ids.fold(f) for f in fields if f)
        return all(w in hay for w in words)

    artists = [a for a in ctx.library.artists.values() if hit(a.name)]
    albums = [a for a in ctx.library.albums.values() if hit(a.album.name, a.album.artist)]
    songs = [s for s in ctx.library.songs.values() if hit(s.track.title, s.track.artist, s.album.album.name)]
    return {
        "artist": [artist_dict(ctx, a) for a in _page(artists, ctx, "artistCount", "artistOffset", 20)],
        "album": [album_dict(ctx, a) for a in _page(albums, ctx, "albumCount", "albumOffset", 20)],
        "song": [song_dict(ctx, s) for s in _page(songs, ctx, "songCount", "songOffset", 20)],
    }


@method("search2")
def search2(ctx: Ctx):
    return {"searchResult2": _search(ctx)}


@method("search3")
def search3(ctx: Ctx):
    return {"searchResult3": _search(ctx)}


# ---------------------------------------------------------------- playlists


def _playlist_songs(ctx: Ctx, playlist) -> list[SongEntry]:
    songs = []
    for track in playlist.tracks:
        try:
            key = rel_path_for(ctx.base, Path(track.path)) if track.path else None
        except (OSError, ValueError, RuntimeError):
            continue
        entry = ctx.library.by_rel_path.get(key) if key else None
        if entry is not None:
            songs.append(entry)
    return songs


def _playlist_covers(ctx: Ctx, songs: list[SongEntry]) -> list[Path]:
    covered = [s for s in songs if s.album.album.cover_art and Path(s.album.album.cover_art).is_file()]
    keys = _cover_albums([s.track for s in covered], base=ctx.base)
    by_key = {s.album.key: Path(s.album.album.cover_art) for s in covered}
    return [by_key[key] for key in keys if key in by_key]


def _playlist_dict(ctx: Ctx, playlist, with_songs: bool = False) -> dict[str, Any]:
    songs = _playlist_songs(ctx, playlist)
    playlist_id = ids.make(ids.PLAYLIST, playlist.name)
    owner = None
    if playlist.owner_id:
        account = ctx.container.get_token_store().get_user(playlist.owner_id)
        owner = (account.username or account.label) if account else None
    out: dict[str, Any] = {
        "id": playlist_id,
        "name": playlist.name,
        "comment": playlist.description,
        "owner": owner,
        "public": False,
        "songCount": len(songs),
        "duration": int(sum(s.track.duration or 0 for s in songs)),
        "created": iso(playlist.created_at),
        "changed": iso(playlist.modified_at or playlist.created_at),
        "coverArt": playlist_id if _playlist_covers(ctx, songs) else None,
    }
    if with_songs:
        out["entry"] = [song_dict(ctx, s) for s in songs]
    return out


def _playlist_service(ctx: Ctx):
    return ctx.container.get_playlist_service()


def _own_playlist(ctx: Ctx, playlist_id: str):
    parsed = ids.parse(playlist_id)
    if parsed is None or parsed[0] != ids.PLAYLIST:
        raise SubsonicError(NOT_FOUND, "Lista no encontrada.")
    try:
        playlist = _playlist_service(ctx).get_playlist(parsed[1])
    except (PlaylistError, ValidationError):
        raise SubsonicError(NOT_FOUND, "Lista no encontrada.")
    if not may_access(ctx.principal, playlist.owner_id):
        raise SubsonicError(NOT_AUTHORIZED, "Esa lista es de otra cuenta.")
    return playlist


def _song_paths(ctx: Ctx, song_ids: list[str]) -> list[Path]:
    paths = []
    for song_id in song_ids:
        _, song = _lookup(ctx, song_id, ids.SONG)
        paths.append(resolve_rel_path(ctx.base, song.rel_path))
    return paths


@method("getPlaylists")
def get_playlists(ctx: Ctx):
    playlists = visible_playlists(ctx.principal, _playlist_service(ctx).list_playlists(ctx.principal))
    return {"playlists": {"playlist": [_playlist_dict(ctx, p) for p in playlists]}}


@method("getPlaylist")
def get_playlist(ctx: Ctx):
    return {"playlist": _playlist_dict(ctx, _own_playlist(ctx, ctx.need("id")), with_songs=True)}


@method("createPlaylist")
def create_playlist(ctx: Ctx):
    service = _playlist_service(ctx)
    paths = _song_paths(ctx, ctx.many("songId"))
    existing = ctx.get("playlistId")
    if existing:
        playlist = _own_playlist(ctx, existing)
        service.replace_tracks(playlist.name, paths)
        name = playlist.name
    else:
        name = ctx.need("name").strip()
        try:
            service.create_playlist(name, owner_id=owner_id_for(ctx.principal))
        except (PlaylistError, ValidationError) as e:
            raise SubsonicError(GENERIC, str(e))
        if paths:
            service.add_tracks(name, paths)
    return {"playlist": _playlist_dict(ctx, service.get_playlist(name), with_songs=True)}


@method("updatePlaylist")
def update_playlist(ctx: Ctx):
    service = _playlist_service(ctx)
    playlist = _own_playlist(ctx, ctx.need("playlistId"))
    name = playlist.name
    additions = _song_paths(ctx, ctx.many("songIdToAdd")) if not ctx.scope.unrestricted else None
    removals = sorted({int(i) for i in ctx.many("songIndexToRemove") if i.isdigit()}, reverse=True)
    if removals:
        visible = [i for i, t in enumerate(playlist.tracks)
                   if ctx.scope.unrestricted or rel_path_for(ctx.base, Path(t.path)) in ctx.library.by_rel_path]
        removed = {visible[i] for i in removals if i < len(visible)}
        kept = [Path(t.path) for i, t in enumerate(playlist.tracks) if i not in removed]
        service.replace_tracks(name, kept)
    if additions is None:
        additions = _song_paths(ctx, ctx.many("songIdToAdd"))
    if additions:
        service.add_tracks(name, additions)
    new_name = (ctx.get("name") or "").strip()
    if new_name and new_name != name:
        try:
            service.rename_playlist(name, new_name)
        except (PlaylistError, ValidationError) as e:
            raise SubsonicError(GENERIC, str(e))
    return {}


@method("deletePlaylist")
def delete_playlist(ctx: Ctx):
    playlist = _own_playlist(ctx, ctx.need("id"))
    _playlist_service(ctx).delete_playlist(playlist.name)
    return {}


# -------------------------------------------------------------- annotation


def _star(ctx: Ctx, starred: bool):
    store = ctx.container.get_user_track_store()
    user = ctx.principal.user_id
    other: list[str] = []
    for value in ctx.many("id") + ctx.many("albumId") + ctx.many("artistId"):
        kind, found = _lookup(ctx, value, ids.SONG, ids.ALBUM, ids.ARTIST)
        if kind == ids.SONG:
            if starred:
                store.add_many(user, [found.rel_path])
                store.update_flags(user, found.rel_path, liked=True)
            elif store.get(user, found.rel_path) is not None:
                store.update_flags(user, found.rel_path, liked=False)
        else:
            other.append(value)
    ctx.container.get_star_store().set(user, other, starred)
    return {}


@method("star")
def star(ctx: Ctx):
    return _star(ctx, True)


@method("unstar")
def unstar(ctx: Ctx):
    return _star(ctx, False)


@method("scrobble")
def scrobble(ctx: Ctx):
    """A submitted play counts only for a song already in the account's library:
    listening must never behave like "Save" (the desktop's ``recordPlay`` rule)."""
    if not ctx.scope.unrestricted:
        for value in ctx.many("id"):
            _lookup(ctx, value, ids.SONG)
    if (ctx.get("submission") or "true").lower() == "false":
        return {}
    store = ctx.container.get_user_track_store()
    values, times = ctx.many('id'), ctx.many('time')
    if times and len(times) != len(values):
        raise SubsonicError(MISSING_PARAMETER, 'Expected one time per song.')
    try:
        stamps = [datetime.fromtimestamp(int(value) / 1000, UTC) for value in times]
    except (ValueError, OverflowError, OSError):
        raise SubsonicError(MISSING_PARAMETER, 'Invalid scrobble time.')
    plays = []
    for index, value in enumerate(values):
        parsed = ids.parse(value)
        song = ctx.library.songs.get(value) if parsed and parsed[0] == ids.SONG else None
        if song is not None and store.get(ctx.principal.user_id, song.rel_path) is not None:
            at = stamps[index] if stamps else datetime.now(UTC)
            plays.append(SimpleNamespace(trackKey=song.rel_path, listenedAt=at, clientPlayId=uuid4().hex))
    record_batch(ctx.container.config.jobs_file, store, ctx.principal.user_id, plays,
                 source='subsonic', device_id=ctx.principal.device_id)
    return {}


@method("setRating")
def set_rating(ctx: Ctx):
    return {}


@method("getPlayQueue")
def get_play_queue(ctx: Ctx):
    return {}


@method("savePlayQueue")
def save_play_queue(ctx: Ctx):
    return {}


@method("getUser")
def get_user(ctx: Ctx):
    store = ctx.container.get_token_store()
    me = store.get_user(ctx.principal.user_id)
    asked = (ctx.get("username") or (me.username if me else "") or "").strip()
    target = me if me is None or not asked or (me.username or "").casefold() == asked.casefold() else None
    if target is None:
        if not ctx.principal.is_owner:
            raise SubsonicError(NOT_AUTHORIZED, "Solo una cuenta admin puede ver otras cuentas.")
        target = store.find_by_username(asked)
        if target is None:
            raise SubsonicError(NOT_FOUND, "Cuenta no encontrada.")
    admin = target.role == "owner"
    return {"user": {
        "username": target.username or target.label,
        "email": "",
        "scrobblingEnabled": True,
        "adminRole": admin, "settingsRole": True, "downloadRole": True, "uploadRole": False,
        "playlistRole": True, "coverArtRole": False, "commentRole": False, "podcastRole": False,
        "streamRole": True, "jukeboxRole": False, "shareRole": False, "videoConversionRole": False,
        "folder": [1],
    }}


# ------------------------------------------------------------------ lyrics

_STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


def _structured(text: str, synced: bool) -> list[dict[str, Any]]:
    lines = []
    for raw in text.splitlines():
        if not synced:
            lines.append({"value": raw})
            continue
        stamps = list(_STAMP.finditer(raw))
        if not stamps:
            continue
        body = _STAMP.sub("", raw).strip()
        for stamp in stamps:
            minutes, seconds, fraction = stamp.group(1), stamp.group(2), stamp.group(3) or "0"
            ms = int(minutes) * 60000 + int(seconds) * 1000 + int(fraction.ljust(3, "0")[:3])
            lines.append({"start": ms, "value": body})
    lines.sort(key=lambda line: line.get("start", 0))
    return lines


def _lyric_for(ctx: Ctx, song: SongEntry):
    from app.dependencies import get_lyrics_service
    try:
        return get_lyrics_service(ctx.request).get(song.rel_path)
    except Exception:
        return None


@method("getLyricsBySongId")
def get_lyrics_by_song_id(ctx: Ctx):
    _, song = _lookup(ctx, ctx.need("id"), ids.SONG)
    doc = _lyric_for(ctx, song)
    if doc is None or not doc.text.strip():
        return {"lyricsList": {}}
    from app.domains.lyrics.offset import read_offset

    synced = doc.record.kind == "synced"
    return {"lyricsList": {"structuredLyrics": [{
        "displayArtist": song.track.artist,
        "displayTitle": song.track.title,
        "lang": "xxx",
        "synced": synced,
        "offset": read_offset(doc.text),
        "line": _structured(doc.text, synced),
    }]}}


@method("getLyrics")
def get_lyrics(ctx: Ctx):
    artist, title = ids.fold(ctx.get("artist")), ids.fold(ctx.get("title"))
    song = next((s for s in ctx.library.songs.values()
                 if ids.fold(s.track.title) == title and (not artist or ids.fold(s.track.artist) == artist)), None)
    doc = _lyric_for(ctx, song) if song else None
    if doc is None:
        return {"lyrics": {}}
    text = _STAMP.sub("", doc.text) if doc.record.kind == "synced" else doc.text
    return {"lyrics": {"artist": song.track.artist, "title": song.track.title, "value": text.strip()}}


# -------------------------------------------------------------------- media


def _song_file(ctx: Ctx) -> Path:
    _, song = _lookup(ctx, ctx.need("id"), ids.SONG)
    path = resolve_rel_path(ctx.base, song.rel_path)
    if not path.is_file():
        raise SubsonicError(NOT_FOUND, "Archivo no encontrado.")
    return path


@method("stream", "download")
def stream(ctx: Ctx):
    path = _song_file(ctx)
    media_type = CONTENT_TYPES.get(path.suffix.lower(), "audio/mpeg")
    return _file_response(ctx.request, path, media_type, path.name, AUDIO_CACHE_CONTROL)


@method("getCoverArt")
def get_cover_art(ctx: Ctx):
    value = ctx.need("id")
    parsed = ids.parse(value)
    album: AlbumEntry | None = None
    cover_path = None
    if parsed and parsed[0] == ids.ALBUM:
        album = ctx.library.albums.get(value)
    elif parsed and parsed[0] == ids.SONG and value in ctx.library.songs:
        album = ctx.library.songs[value].album
    elif parsed and parsed[0] == ids.ARTIST and value in ctx.library.artists:
        album = next((a for a in ctx.library.artists[value].albums if a.album.cover_art), None)
    elif parsed and parsed[0] == ids.PLAYLIST:
        try:
            playlist = _own_playlist(ctx, value)
        except SubsonicError:
            raise SubsonicError(NOT_FOUND, "Portada no encontrada.")
        covers = _playlist_covers(ctx, _playlist_songs(ctx, playlist))
        if not covers:
            raise SubsonicError(NOT_FOUND, "Portada no encontrada.")
        if len(covers) == 4:
            size = max(1, ctx.int("size", 600))
            with ExitStack() as lease:
                tile = lease.enter_context(ctx.container.get_cover_cache().mosaic(covers, size))
                if tile is not None:
                    path, etag = tile
                    return _file_response(
                        ctx.request, path, "image/jpeg", "cover.jpg", COVER_CACHE_CONTROL,
                        etag=etag, on_complete=lease.pop_all().close,
                    )
        cover_path = covers[0]
    if album is not None:
        # A memoized listing can outlive eviction of an extracted picture.
        cover_path = ctx.music_repo._find_cover_art(album.album.path)
    if not cover_path or not Path(cover_path).is_file():
        raise SubsonicError(NOT_FOUND, "Portada no encontrada.")
    mime = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(
        Path(cover_path).suffix.lower(), "image/jpeg"
    )
    return _file_response(ctx.request, Path(cover_path), mime, Path(cover_path).name, COVER_CACHE_CONTROL)


# ---------------------------------------------------------------- dispatch

#: Answered without credentials: a client asks before it has any.
PUBLIC = {"getopensubsonicextensions"}


@router.api_route("/{method}", methods=["GET", "POST"])
async def dispatch(method: str, request: Request) -> Response:
    params = MultiDict(request.query_params.multi_items())
    if request.method == "POST":
        content_type = request.headers.get("content-type", "")
        if "form" in content_type:
            async with bounded_form(request, 64 << 10, max_files=1, max_fields=1000) as form:
                params = MultiDict(list(params.multi_items()) + [(k, str(v)) for k, v in form.multi_items()])
    fmt = params.get("f")
    name = method.removesuffix(".view").lower()
    return await run_in_threadpool(_run, name, request, params, fmt)


def _run(name: str, request: Request, params: MultiDict, fmt: str | None) -> Response:
    container = request.app.state.container
    try:
        if name in PUBLIC and not AUTH_PARAMETERS.intersection(params):
            return respond(extensions(), fmt)
        store = container.get_token_store()
        principal = authenticate(params, store, container.get_app_password_vault(),
                                 request.client.host if request.client else "unknown")
        authorize_credential(request, principal)
        request.state.principal = principal
        if name in PUBLIC:
            store.record_subsonic(principal, params.get("c"))
            return respond(extensions(), fmt)
        handler = HANDLERS.get(name)
        if handler is None:
            raise SubsonicError(GENERIC, f"Method not implemented: {name}")
        result = handler(Ctx(request=request, params=params, principal=principal, container=container))
        store.record_subsonic(principal, params.get("c"))
        if isinstance(result, Response):
            return result
        return respond(result, fmt)
    except SubsonicError as e:
        return error(e, fmt)
