"""Parse Spotify privacy exports into requested playlists and tracks.

Parsing performs no network or acquisition work; report unsupported layouts.
See docs/DEVELOPER_GUIDE.md#spotify-export-import.
"""
import json
import logging
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import unquote_plus

from app.exceptions import ValidationError

logger = logging.getLogger(__name__)

# An export is a user-supplied archive, so it is untrusted input. These bound
# the damage a maliciously-crafted or simply enormous zip can do; never
# extract to disk, so zip-slip isn't a concern, but decompression bombs are.
MAX_MEMBERS = 500
MAX_MEMBER_BYTES = 64 * 1024 * 1024        # 64 MB for any single JSON file
MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024  # 256 MB across the whole archive

# Field spellings seen across export variants, most likely first. The
# `master_metadata_*` trio belongs to the extended streaming history, which is
# not imported — it is listed only so a nested play event inside some
# future playlist shape would still yield a name rather than nothing.
_TITLE_KEYS = ("trackName", "track_name", "track", "title", "master_metadata_track_name")
_ARTIST_KEYS = ("artistName", "artist_name", "artist", "master_metadata_album_artist_name")
_ALBUM_KEYS = ("albumName", "album_name", "album", "master_metadata_album_album_name")
_URI_KEYS = ("trackUri", "track_uri", "uri", "spotify_uri", "spotify_track_uri")
_ADDED_KEYS = ("addedDate", "added_at", "added")

# A playlist item is one slot with several mutually exclusive fillers: exactly
# one of these is an object and the rest are null. Podcasts and audiobooks are
# not songs and never will be, so they are skipped on purpose rather than
# counted as damage.
_NON_MUSIC_ITEM_KEYS = ("episode", "audiobook")

DEFAULT_LIKED_NAME = "Liked Songs"

# Why an unread member is unread. Only UNRECOGNIZED is a problem worth a
# reader's attention; the rest are the archive being an archive.
IGNORED = "ignored"            # not JSON: the PDF readme, images, .DS_Store
KNOWN = "known"                # Recognized JSON, that simply holds no playlists
UNRECOGNIZED = "unrecognized"  # Unrecognized JSON — the interesting one
UNREADABLE = "unreadable"      # Undecodable or rejected JSON

# How much of a document's shape the report is allowed to quote. A shape, never
# a value: the report has to be safe to show on screen and paste into a bug,
# and an export is somebody's listening history.
_MAX_SHAPE_KEYS = 12
_MAX_KEY_CHARS = 40


@dataclass
class ExportedTrack:
    """A song named by an export. Not yet resolved, not yet acquired."""

    title: str
    artist: str | None = None
    album: str | None = None
    # Provenance only. A Spotify track URI is release- and market-scoped, so it
    # is NOT a recording identity and must never be used as a dedupe key; the
    # recording MBID is, with normalized key + close duration as the fallback.
    spotify_uri: str | None = None
    added_at: str | None = None

    @property
    def search_query(self) -> str:
        """Best-effort text for a downstream metadata lookup."""
        return f"{self.artist} {self.title}".strip() if self.artist else self.title

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "spotifyUri": self.spotify_uri,
            "addedAt": self.added_at,
        }


@dataclass
class ExportedPlaylist:
    """A playlist named by an export."""

    name: str
    tracks: list[ExportedTrack] = field(default_factory=list)
    description: str | None = None
    modified_at: str | None = None

    @property
    def track_count(self) -> int:
        return len(self.tracks)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "modifiedAt": self.modified_at,
            "trackCount": self.track_count,
            "tracks": [t.to_dict() for t in self.tracks],
        }


@dataclass
class UnreadMember:
    """Report archive members whose structure produces no playlists.

    Name, size, and shape details distinguish unfamiliar layouts from files that
    never contained playlists, without exposing listening history."""

    filename: str
    size_bytes: int
    category: str
    detail: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "filename": self.filename,
            "sizeBytes": self.size_bytes,
            "category": self.category,
            "detail": self.detail,
        }


@dataclass
class ExportParseResult:
    """Everything the parser found, plus what it could not make sense of."""

    playlists: list[ExportedPlaylist] = field(default_factory=list)
    # Surfaced to the user rather than logged and forgotten: a silently skipped
    # playlist looks identical to one that was never in the export.
    warnings: list[str] = field(default_factory=list)
    source_files: list[str] = field(default_factory=list)
    # Every member that did not become a playlist, categorised. Bounded by
    # MAX_MEMBERS, so it cannot grow without limit.
    unread: list[UnreadMember] = field(default_factory=list)

    @property
    def playlist_count(self) -> int:
        return len(self.playlists)

    @property
    def track_count(self) -> int:
        return sum(p.track_count for p in self.playlists)

    @property
    def unrecognized(self) -> list[UnreadMember]:
        """The unread members that are actually diagnostic."""
        return [m for m in self.unread if m.category == UNRECOGNIZED]

    def to_dict(self) -> dict[str, Any]:
        return {
            "playlistCount": self.playlist_count,
            "trackCount": self.track_count,
            "warnings": self.warnings,
            "sourceFiles": self.source_files,
            "unreadMembers": [m.to_dict() for m in self.unread],
            "unrecognizedCount": len(self.unrecognized),
            "playlists": [p.to_dict() for p in self.playlists],
        }


# --------------------------------------------------------------------------- shapes

def _clip(text: str) -> str:
    return text if len(text) <= _MAX_KEY_CHARS else text[:_MAX_KEY_CHARS] + "…"


def _key_list(mapping: dict[str, Any]) -> str:
    keys = [_clip(str(k)) for k in list(mapping)[:_MAX_SHAPE_KEYS]]
    hidden = len(mapping) - len(keys)
    joined = ", ".join(keys)
    return f"{joined} (+{hidden} more)" if hidden > 0 else joined


def _describe_shape(payload: Any) -> str:
    """One line of structure — keys and counts only, never values."""
    if isinstance(payload, dict):
        if not payload:
            return "empty object"
        return f"object with {len(payload)} keys: {_key_list(payload)}"
    if isinstance(payload, list):
        if not payload:
            return "empty array"
        first = payload[0]
        if isinstance(first, dict):
            return f"array of {len(payload)} items; first item keys: {_key_list(first)}"
        return f"array of {len(payload)} {type(first).__name__} values"
    return f"bare {type(payload).__name__} value"


# Sections of the export that are known to hold no playlists, matched on the
# keys they must have rather than on their filename — the same reason playlists
# are found by structure. Each entry is (required keys, what it is).
_KNOWN_OBJECT_SECTIONS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("username", "email"), "account details (Userdata.json)"),
    (("inferences",), "advertising inferences (Inferences.json)"),
    (("payment_method",), "payment details (Payments.json)"),
    (("followerCount", "followingUsersCount"), "follow counts (Follow.json)"),
    (("followingArtists",), "follow data (Follow.json)"),
    (("displayName",), "profile identity (Identity.json)"),
    # Reached only when the harvest found nothing in it, i.e. `tracks` was
    # empty — an account with no Liked Songs. Naming it keeps a legitimately
    # empty library out of the "unrecognized" pile.
    (("tracks", "albums", "shows"), "saved library, with no saved songs in it (YourLibrary.json)"),
    # Seen in the first real export this project held (account data, requested
    # September 2026). Spotify has added files and reshaped Follow.json since
    # the published exports the rest of this table was built from.
    (("userIsFollowing", "userIsFollowedBy"), "follow data (Follow.json)"),
    (("identifierType", "identifierValue"), "account identifiers (Identifiers.json)"),
    (("ids",), "advertising identifiers (AdsIdentitySecondPartyIdentifiers.json)"),
    (("conversations",), "assistant conversations (AgentGateway.json)"),
    (("filesMetadata",), "DJ voice audio (iDJAudio.json)"),
    (("topArtists", "topTracks"), "yearly Wrapped summary (Wrapped*.json)"),
    (("stats", "highlights"), "Sound Capsule stats (YourSoundCapsule.json)"),
)

# Chat threads are keyed by the conversation's own URI, so there is no fixed
# key to match — only the prefix every key shares.
_CHAT_KEY_PREFIX = "spotify:chat:"

_KNOWN_ARRAY_SECTIONS: tuple[tuple[tuple[str, ...], str], ...] = (
    (
        ("endTime", "msPlayed"),
        "streaming history — play events, not playlists (StreamingHistory*.json)",
    ),
    (
        ("ts", "ms_played"),
        "extended streaming history — play events, not playlists "
        "(Streaming_History_Audio_*.json)",
    ),
    (("searchQuery",), "search history (SearchQueries.json)"),
    (("artistName", "segment"), "artist listener segments (Marquee.json)"),
)

# The phrase that distinguishes the wrong-tier download from a layout change.
_STREAMING_HISTORY_MARK = "play events, not playlists"


def _identify(payload: Any) -> str | None:
    """Name a known export section that carries no playlists, or None.

    Diagnostics only — nothing here decides what gets imported. It exists so
    the report can say "that is your streaming history" instead of describing a
    strange object and leaving the reader to guess.
    """
    if isinstance(payload, dict):
        for keys, description in _KNOWN_OBJECT_SECTIONS:
            if all(k in payload for k in keys):
                return description
        if payload and all(str(k).startswith(_CHAT_KEY_PREFIX) for k in payload):
            return "messages (MessageData.json)"
    elif isinstance(payload, list) and not payload:
        # An account with nothing of that kind — no payments on file ships
        # `Payments.json` as `[]`. Empty is not a misread layout.
        return "empty section, nothing in it"
    elif isinstance(payload, list) and isinstance(payload[0], dict):
        first = payload[0]
        for keys, description in _KNOWN_ARRAY_SECTIONS:
            if all(k in first for k in keys):
                return description
    return None


# --------------------------------------------------------------------------- tracks

def _first(mapping: dict[str, Any], keys: tuple) -> str | None:
    """Return the first present, non-empty, string-ish value among `keys`."""
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _split_local_uri(uri: str) -> tuple[str | None, str | None, str | None]:
    """Pull (artist, album, title) out of a ``spotify:local:`` URI.

    Local files carry no names in the export, only the URI Spotify synthesised
    from the file's tags:
    ``spotify:local:Daft+Punk:Discovery:One+More+Time:320`` — artist, album,
    title, seconds; percent-encoded with ``+`` for spaces. Untagged files give
    ``spotify:local:::Some+File+Name:153``, so the first two segments are
    routinely empty and only the title can be counted on.
    """
    parts = uri.split(":")
    if len(parts) < 6 or parts[0] != "spotify" or parts[1] != "local":
        return None, None, None
    # The last segment is the duration; anything between the album and it is
    # the title. Colons inside a field are percent-encoded, so this only ever
    # rejoins segments a malformed URI produced.
    artist = unquote_plus(parts[2]).strip() or None
    album = unquote_plus(parts[3]).strip() or None
    title = unquote_plus(":".join(parts[4:-1])).strip() or None
    return artist, album, title


def _parse_local_track(local: dict[str, Any]) -> ExportedTrack | None:
    """Build a track from a playlist's ``localTrack`` slot.

    A local track is still a song the user put in a playlist, so dropping it
    would silently shorten the list. Names are read from explicit fields when
    an export happens to carry them and recovered from the URI otherwise.
    """
    uri = _first(local, _URI_KEYS)
    title = _first(local, _TITLE_KEYS)
    artist = _first(local, _ARTIST_KEYS)
    album = _first(local, _ALBUM_KEYS)

    if uri and not (title and artist and album):
        uri_artist, uri_album, uri_title = _split_local_uri(uri)
        title = title or uri_title
        artist = artist or uri_artist
        album = album or uri_album

    if not title:
        return None
    return ExportedTrack(title=title, artist=artist, album=album, spotify_uri=uri)


def _parse_track(raw: Any) -> ExportedTrack | None:
    """Build a track from one export entry, or None if it carries no title.

    Handles the playlist shape (``{"track": {...}, "addedDate": ...}``), the
    flat library shape (``{"track": "...", "artist": "..."}``), and the local
    file shape (``{"track": null, "localTrack": {"uri": ...}}``). The overlap
    on the key ``track`` is why this checks the nested value's *type* rather
    than merely its presence — in a real playlist item ``track`` is null
    whenever one of its sibling slots is filled.
    """
    if not isinstance(raw, dict):
        return None

    local = raw.get("localTrack")
    if isinstance(local, dict):
        track = _parse_local_track(local)
        if track is not None:
            track.added_at = _first(raw, _ADDED_KEYS)
            return track

    nested = raw.get("track")
    inner: dict[str, Any] = nested if isinstance(nested, dict) else raw

    title = _first(inner, _TITLE_KEYS)
    if not title:
        return None

    return ExportedTrack(
        title=title,
        artist=_first(inner, _ARTIST_KEYS),
        album=_first(inner, _ALBUM_KEYS),
        spotify_uri=_first(inner, _URI_KEYS),
        added_at=_first(raw, _ADDED_KEYS),
    )


def _parse_item(raw: Any) -> tuple[ExportedTrack | None, str]:
    """Classify one playlist entry: a track, deliberate non-music, or damage.

    The distinction earns its keep in the warnings. A playlist with forty
    podcast episodes in it is not forty broken rows, and reporting it that way
    would teach the reader to ignore the warnings that do mean something.
    """
    if not isinstance(raw, dict):
        return None, "damaged"

    track = _parse_track(raw)
    if track is not None:
        return track, "track"

    if any(isinstance(raw.get(key), dict) for key in _NON_MUSIC_ITEM_KEYS):
        return None, "non-music"
    return None, "damaged"


def _parse_playlist(raw: Any, warnings: list[str]) -> ExportedPlaylist | None:
    if not isinstance(raw, dict):
        return None

    name = _first(raw, ("name", "playlistName", "title"))
    items = raw.get("items")
    if items is None:
        items = raw.get("tracks")
    if not isinstance(items, list):
        if name:
            warnings.append(f"Playlist {name!r} has no readable track list; skipped.")
        return None

    tracks: list[ExportedTrack] = []
    non_music = 0
    unreadable = 0
    for item in items:
        track, kind = _parse_item(item)
        if track is not None:
            tracks.append(track)
        elif kind == "non-music":
            non_music += 1
        else:
            unreadable += 1

    label = name or "(unnamed)"
    if unreadable:
        warnings.append(f"Playlist {label!r}: skipped {unreadable} entries with no title.")
    if non_music:
        warnings.append(
            f"Playlist {label!r}: skipped {non_music} podcast or audiobook entries."
        )

    return ExportedPlaylist(
        name=name or "(unnamed playlist)",
        tracks=tracks,
        description=_first(raw, ("description",)),
        modified_at=_first(raw, ("lastModifiedDate", "modified", "modifiedAt")),
    )


def _harvest(payload: Any, warnings: list[str], liked_name: str) -> list[ExportedPlaylist]:
    """Pull playlists out of one decoded JSON document, by shape not filename."""
    found: list[ExportedPlaylist] = []

    if isinstance(payload, dict):
        raw_playlists = payload.get("playlists")
        if isinstance(raw_playlists, list):
            for raw in raw_playlists:
                parsed = _parse_playlist(raw, warnings)
                if parsed:
                    found.append(parsed)

        # The saved-tracks export ("Liked Songs") is a bare list of tracks with
        # no playlist wrapper. People think of it as a playlist, so present it
        # as one rather than dropping it.
        if not found:
            raw_tracks = payload.get("tracks")
            if isinstance(raw_tracks, list):
                tracks = [t for t in (_parse_track(i) for i in raw_tracks) if t is not None]
                if tracks:
                    found.append(ExportedPlaylist(name=liked_name, tracks=tracks))

    # Some variants put the array at the top level.
    elif isinstance(payload, list):
        for raw in payload:
            parsed = _parse_playlist(raw, warnings)
            if parsed:
                found.append(parsed)

    return found


def _decode(data: bytes, label: str, warnings: list[str]) -> Any | None:
    try:
        # utf-8-sig tolerates a BOM, which Windows-authored exports can carry.
        return json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        warnings.append(f"{label}: not valid UTF-8 JSON ({type(e).__name__}); skipped.")
        return None


# --------------------------------------------------------------------------- entry

def _is_archive_noise(filename: str) -> bool:
    """AppleDouble sidecars and friends, which a re-zipped export carries.

    ``__MACOSX/._Playlist1.json`` ends in ``.json`` but is a binary resource
    fork. Reading it produces a decode warning about a file the user cannot
    see, which reads as corruption when nothing is wrong.
    """
    name = filename.rsplit("/", 1)[-1]
    return filename.startswith("__MACOSX/") or "/__MACOSX/" in filename or name.startswith("._")


def _consume(result: "ExportParseResult", filename: str, size: int,
             payload: Any, liked_name: str) -> None:
    """Take the playlists out of one decoded document, or record why there were none."""
    found = _harvest(payload, result.warnings, liked_name)
    if found:
        result.playlists.extend(found)
        result.source_files.append(filename)
        return
    known = _identify(payload)
    result.unread.append(UnreadMember(
        filename, size,
        KNOWN if known else UNRECOGNIZED,
        known or f"no playlists recognised in it — {_describe_shape(payload)}",
    ))


def _no_playlists_message(result: ExportParseResult) -> str:
    """The rejection message, pointed at the likeliest cause."""
    base = (
        "No playlists found in this export. Expected a Spotify 'Account data' "
        "download containing a playlist JSON file."
    )
    # Requesting the wrong tier is a specifically identifiable failure: the
    # extended streaming history is a legitimate export that simply has no
    # playlists in it, and it takes up to 30 days to arrive, so guessing wrong
    # twice is expensive.
    if any(_STREAMING_HISTORY_MARK in m.detail for m in result.unread):
        return (
            base + " This file looks like the 'Extended streaming history' "
            "download instead, which lists what you played but contains no playlists."
        )
    return base


def parse_spotify_export(
    source: bytes | str | Path,
    liked_name: str = DEFAULT_LIKED_NAME,
) -> ExportParseResult:
    """Parse ZIP or JSON export bytes, or a path, and report skipped members.

    liked_name names the saved-tracks list that Spotify leaves unnamed. Empty,
    unreadable, or playlist-free inputs raise ValidationError.
    """
    if isinstance(source, (str, Path)):
        path = Path(source)
        if not path.is_file():
            raise ValidationError(f"Export file not found: {path}")
        data = path.read_bytes()
    else:
        data = source

    if not data:
        raise ValidationError("Export file is empty")

    result = ExportParseResult()

    if zipfile.is_zipfile(BytesIO(data)):
        with zipfile.ZipFile(BytesIO(data)) as archive:
            members = [m for m in archive.infolist() if not m.is_dir()]
            if len(members) > MAX_MEMBERS:
                raise ValidationError(
                    f"Archive has {len(members)} files, over the {MAX_MEMBERS} limit"
                )
            total = sum(m.file_size for m in members)
            if total > MAX_TOTAL_UNCOMPRESSED:
                raise ValidationError(
                    f"Archive expands to {total // 1024 // 1024} MB, over the "
                    f"{MAX_TOTAL_UNCOMPRESSED // 1024 // 1024} MB limit"
                )

            for member in members:
                if _is_archive_noise(member.filename):
                    result.unread.append(UnreadMember(
                        member.filename, member.file_size, IGNORED,
                        "archive metadata, not part of the export.",
                    ))
                    continue
                if not member.filename.lower().endswith(".json"):
                    result.unread.append(UnreadMember(
                        member.filename, member.file_size, IGNORED,
                        "not a JSON file; the export's readme and images live here.",
                    ))
                    continue
                if member.file_size > MAX_MEMBER_BYTES:
                    result.warnings.append(
                        f"{member.filename}: {member.file_size // 1024 // 1024} MB "
                        f"exceeds the per-file limit; skipped."
                    )
                    result.unread.append(UnreadMember(
                        member.filename, member.file_size, UNREADABLE,
                        f"{member.file_size // 1024 // 1024} MB, over the per-file limit.",
                    ))
                    continue
                payload = _decode(archive.read(member), member.filename, result.warnings)
                if payload is None:
                    result.unread.append(UnreadMember(
                        member.filename, member.file_size, UNREADABLE,
                        "not valid UTF-8 JSON.",
                    ))
                    continue
                _consume(result, member.filename, member.file_size, payload, liked_name)
    else:
        payload = _decode(data, "export", result.warnings)
        if payload is None:
            result.unread.append(UnreadMember("export", len(data), UNREADABLE,
                                              "not valid UTF-8 JSON."))
        else:
            _consume(result, "export", len(data), payload, liked_name)

    if not result.playlists:
        raise ValidationError(
            _no_playlists_message(result),
            details={
                "warnings": result.warnings,
                "unreadMembers": [m.to_dict() for m in result.unread],
            },
        )

    if result.unrecognized:
        # Loud on purpose: this is the signal that the export layout moved, and
        # the only copy of it that survives once the response is gone.
        logger.warning(
            "Spotify export had %d unrecognised JSON member(s): %s",
            len(result.unrecognized),
            "; ".join(f"{m.filename} ({m.detail})" for m in result.unrecognized),
        )

    logger.info(
        "Parsed Spotify export: %d playlists, %d tracks, from %s",
        result.playlist_count, result.track_count, result.source_files or "(unknown)",
    )
    return result
