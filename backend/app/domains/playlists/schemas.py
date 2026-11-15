"""Describe shipped playlist payloads without normalizing their wire differences.

List, create, and update routes use different envelopes, key spellings, and
timestamp formats. FastAPI filters through these models, so omissions remove
fields from shipped clients. See docs/API_COMPATIBILITY.md.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


# --------------------------------------------------------------------- CRUD

class PlaylistTrackResponse(BaseModel):
    """A track as ``GET /api/playlists/{name}`` renders it.

    ``track_number`` is the **position in the playlist** (1-based), not the
    track's number on its album — the handler overwrites it on purpose so a
    reordered playlist numbers correctly.

    ``artist`` and ``title`` are empty strings rather than ``null`` when unknown:
    the handler coerces them, and a client that renders ``track.artist`` would
    print "None" if that ever changed.
    """

    path: str
    title: str
    artist: str
    album: str | None = None
    genre: str | None = None
    track_number: int | None = None
    duration: float | None = None
    dateAdded: float | None = None


class PlaylistSummary(BaseModel):
    """One row of ``GET /api/playlists``.

    ``owner`` is additive — it was introduced with per-user tokens and both
    shipped clients ignore it — and it is ``null`` for a playlist written before
    ownership existed or dropped into the directory by hand.
    """

    name: str
    description: str | None = None
    trackCount: int
    created: float | None = None
    modified: float | None = None
    owner: str | None = None
    # Additive, for the tile a playlist is drawn as. ``cover`` is the
    # playlist-level artwork (a Spotify import's), and ``coverAlbums`` the
    # directory names of the first four *distinct* albums in track order — the
    # key ``/api/media/{album}/cover.jpg`` is routed on — so a client can draw a
    # 2×2 mosaic without fetching every playlist's tracks. Directory names, not
    # display names: they differ for a quarter of a real library.
    cover: str | None = None
    coverAlbums: list[str] = []
    # Index-aligned with coverAlbums; the album listing's mtime/size revision,
    # or null when artwork is missing. Safe to use as a media URL's ?v=.
    coverVersions: list[str | None] = []
    # Additive: the sum of the tracks' stored durations, in seconds — null
    # when any track has none, so a partial sum never reads as the total.
    totalDuration: float | None = None


class PlaylistDetail(BaseModel):
    """``GET /api/playlists/{name}`` — the flat, un-enveloped playlist."""

    name: str
    description: str | None = None
    tracks: list[PlaylistTrackResponse]
    created: float | None = None
    modified: float | None = None
    source_url: str | None = None
    cover: str | None = None
    owner: str | None = None


class CreatedPlaylist(BaseModel):
    """The playlist body nested in ``POST /api/playlists``.

    ⚠ ISO-8601 strings here, floats in :class:`PlaylistSummary`. Creation is the
    only endpoint that formats the timestamps, and the renderer parses them as
    dates; changing either side breaks exactly one screen and not the other.
    ``tracks`` is always empty — a new playlist has none — but the key is
    present so a client can render the fresh playlist without a second GET.
    """

    name: str
    description: str | None = None
    tracks: list[PlaylistTrackResponse] = Field(default_factory=list)
    created_at: str | None = None
    modified_at: str | None = None
    total_duration: float | None = None


class CreatePlaylistResponse(BaseModel):
    """``POST /api/playlists``."""

    success: bool
    playlist: CreatedPlaylist


class UpdatedPlaylistCounts(BaseModel):
    """The body nested in ``PUT /api/playlists/{name}/tracks``. snake_case."""

    name: str
    track_count: int
    total_duration: float | None = None


class UpdatePlaylistTracksResponse(BaseModel):
    """``PUT /api/playlists/{name}/tracks``."""

    success: bool
    playlist: UpdatedPlaylistCounts


class RefreshedPlaylistCounts(UpdatedPlaylistCounts):
    """``POST /api/playlists/{name}/refresh``'s nested body.

    Adds an ISO-8601 ``modified_at`` to the counts above. It is the *third*
    spelling of "when this changed" across this router; see the module docstring.
    """

    modified_at: str | None = None


class RefreshPlaylistResponse(BaseModel):
    """``POST /api/playlists/{name}/refresh`` — tags re-read, nothing fetched."""

    success: bool
    playlist: RefreshedPlaylistCounts


class RenamedPlaylist(BaseModel):
    """The body nested in ``PATCH /api/playlists/{name}``. camelCase + floats."""

    name: str
    description: str | None = None
    trackCount: int
    created: float | None = None
    modified: float | None = None


class RenamePlaylistResponse(BaseModel):
    """``PATCH /api/playlists/{name}``."""

    success: bool
    playlist: RenamedPlaylist


class DeletePlaylistResponse(BaseModel):
    """``DELETE /api/playlists/{name}``. ``message`` is user-facing prose."""

    success: bool
    message: str


class RefreshFromSourceResponse(BaseModel):
    """``POST /api/refresh-playlist/{name}`` — re-fetches the source URL.

    ⚠ ``status`` is the string ``"success"`` even when nothing was added, and
    ``message`` is Spanish prose meant for display. Branch on ``added``, never
    on either of the other two.
    """

    status: str
    message: str
    added: int


# ------------------------------------------------------- data-export import

class ExportedTrackResponse(BaseModel):
    """A song named by an export. Not resolved, not acquired, not on disk."""

    title: str
    artist: str | None = None
    album: str | None = None
    spotifyUri: str | None = None
    addedAt: str | None = None


class ExportedPlaylistResponse(BaseModel):
    """A playlist named by an export, with everything it listed."""

    name: str
    description: str | None = None
    modifiedAt: str | None = None
    trackCount: int
    tracks: list[ExportedTrackResponse]


class UnreadMemberResponse(BaseModel):
    """An archive member that produced no playlists, and what it looked like.

    ``category`` is one of ``ignored`` / ``known`` / ``unrecognized`` /
    ``unreadable``; only ``unrecognized`` means the layout changed under us.
    ``detail`` quotes a *shape* and never a value — an export is somebody's
    listening history and this report is meant to be pasteable into a bug.
    """

    filename: str
    sizeBytes: int
    category: str
    detail: str


class ExportParseResponse(BaseModel):
    """``POST /api/playlists/spotify-export/parse`` — pure, no side effects."""

    playlistCount: int
    trackCount: int
    warnings: list[str]
    sourceFiles: list[str]
    unreadMembers: list[UnreadMemberResponse]
    unrecognizedCount: int
    playlists: list[ExportedPlaylistResponse]


class ExportResolveStartedResponse(BaseModel):
    """``POST .../resolve`` — the job id, returned before any work happens.

    ⚠ ``progress_id`` is snake_case while ``playlistName`` beside it is camel.
    Both are read as-is by the renderer; the id also keys
    ``GET /api/download-progress-stream/{progress_id}``.
    """

    success: bool
    status: str
    progress_id: str
    playlistName: str
    total: int


class ExportResolutionResponse(BaseModel):
    """``GET .../resolve/{progress_id}`` — results grouped by confidence.

    ``counts`` and ``results`` are keyed by confidence bucket (``strong`` /
    ``review`` / ``rejected``), and a bucket the matcher invents later must show
    up rather than be dropped — hence the mappings rather than three fields.

    The match rows themselves stay free-form for the same reason
    ``AnalysisBlob`` does not exist next door: they are the matcher's own
    ``MatchResult`` dicts, they carry provider-specific keys, and a model that
    listed today's keys would quietly delete tomorrow's.

    ``status`` is one of ``in_progress`` / ``done`` / ``cancelled`` / ``failed``;
    ``error`` carries how far it got before it broke, which is the field clients
    actually show.
    """

    progressId: str
    playlistName: str
    status: str
    total: int
    resolved: int
    counts: dict[str, int]
    results: dict[str, list[dict[str, Any]]]
    error: str | None = None


class ExportResolveCancelResponse(BaseModel):
    """``POST .../resolve/{progress_id}/cancel``.

    ``status`` is read *before* the worker notices the flag, so it is usually
    still ``in_progress``. That is not a bug: cancellation is cooperative and
    whatever resolved so far is kept.
    """

    success: bool
    progressId: str
    status: str
    resolved: int


class ExportImportStartedResponse(BaseModel):
    """``POST .../import`` — the only step of the three that acquires anything.

    ``destination`` is the directory the files will land in, echoed so a client
    can say where the music went without guessing the naming rules.
    """

    success: bool
    status: str
    progress_id: str
    playlistName: str
    total: int
    destination: str
