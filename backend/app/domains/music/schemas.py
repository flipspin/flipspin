"""Describe shipped music payloads for generated clients.

FastAPI drops fields omitted from a response model. Preserve existing key names
and nullable analysis values. AnalysisBlob stays free-form so cache fields from
newer analyzers survive older server reads. See docs/API_COMPATIBILITY.md.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class AlbumNamesResponse(BaseModel):
    """``GET /api/listar-albums`` — display names only, nothing else."""

    albums: list[str]


class TrackWithMetadata(BaseModel):
    """One track inside ``GET /api/listar-albums-con-metadata``.

    ⚠ ``url_path`` is built from the album's **directory** name, not from
    ``album`` above it: the two differ for a large share of a real library and
    the mismatch fails silently (a 404 on media, a working list). Clients must
    parse it rather than reconstruct it — and must strip the query string before
    parsing, since a token can ride along.
    """

    title: str
    artist: str
    duration: float | None = None
    path: str
    url_path: str
    # ``<mediaKey>/<file key>`` — the ``/api/me/library`` / lyrics identity.
    # Additive; a nested song's file key carries its disc folder (``CD2∕01.mp3``).
    relPath: str | None = None
    missingFromNest: bool = False
    missingSince: str | None = None
    track_number: int | None = None
    genre: str | None = None
    artists: list[str] = Field(default_factory=list)
    genres: list[str] = Field(default_factory=list)
    albumArtist: str | None = None
    albumArtists: list[str] = Field(default_factory=list)
    discNumber: int | None = None
    compilation: bool | None = None
    year: int | None = None
    titleSort: str | None = None
    artistSort: str | None = None
    albumSort: str | None = None
    albumArtistSort: str | None = None
    composerSort: str | None = None
    # snake_case everywhere else in this object; this one key is camelCase and
    # both shipped clients read it by that exact name.
    dateAdded: float | None = None
    keyConfidence: float | None = None
    bpmConfidence: float | None = None
    bpmEstimated: bool = False
    keyEstimated: bool = False
    analysisState: Literal['analyzed', 'queued', 'failed', 'none'] = 'none'
    bpmFixed: bool = False
    keyFixed: bool = False
    keySource: Literal['fixed', 'tag', 'computed'] | None = None
    bpmSource: Literal['fixed', 'tag', 'computed'] | None = None
    bpm: int | None = None
    key: str | None = None
    mood: str | None = None
    arousal: float | None = Field(None, ge=0, le=1)
    analysis: dict[str, Any] | None = None


class AlbumWithMetadata(BaseModel):
    """One album in ``GET /api/listar-albums-con-metadata``.

    ``cover`` is a ``data:`` URI when ``covers=true`` (the default, kept only for
    the desktop renderer) and ``null`` when ``covers=false`` or the album has no
    artwork. Same key either way — the flag changes the value, never the shape.
    ``coverVersion`` is the cover's mtime/size revision (or null if missing),
    usable as ``cover.jpg?size=96&v=<coverVersion>`` for immutable caching.
    """

    album: str
    artist: str
    path: str
    # The album segment of every ``/api/media`` URL: the folder name for a flat
    # library, ``Artist∕Album`` (U+2215) for a nested one — see
    # ``app/utils/library_paths.py``. Additive; older clients parse ``url_path``.
    mediaKey: str | None = None
    year: int | None = None
    genre: str | None = None
    albumArtist: str | None = None
    compilation: bool = False
    genres: list[str] = Field(default_factory=list)
    albumSort: str | None = None
    albumArtistSort: str | None = None
    cover: str | None = None
    coverVersion: str | None = None
    duration: float | None = None
    tracks: list[TrackWithMetadata]


class WaveformResponse(BaseModel):
    """``GET /api/waveform/{album}/{filename}``."""

    waveform: list[float]
    samples: int
    track: str


class WavesurferPeaksResponse(BaseModel):
    """``GET /api/wavesurfer-peaks/{album}/{filename}``.

    The field names are not ours: this is the peaks-file layout a waveform
    widget in the renderer consumes directly, so ``data`` is a list *of
    channels*, each a list of samples, even though this backend always emits one.
    """

    version: int
    channels: int
    sample_rate: int
    samples_per_pixel: int
    bits: int
    length: int
    data: list[list[float]]


class TrackMutationResponse(BaseModel):
    """``POST /api/delete-track`` and ``POST /api/update-tags``.

    ``path`` is the *resolved* path the server acted on, not the one the client
    sent — that is the point of echoing it back.
    """

    success: bool
    path: str


class OwnedTrackRef(BaseModel):
    """A library file that answers an ownership query."""

    title: str
    artist: str
    album: str
    path: str
    durationSeconds: float | None = None
    trackNumber: int | None = None


class OwnershipVerdictResponse(BaseModel):
    """One verdict. ``nearMatch`` is a same-key file that was *rejected*."""

    owned: bool
    match: OwnedTrackRef | None = None
    nearMatch: OwnedTrackRef | None = None
    reason: str | None = None


class OwnershipResponse(BaseModel):
    """``POST /api/library/ownership`` — **positional**, never filtered.

    ⚠ ``degraded`` is absent on the happy path and ``true`` when the library
    could not be read; the route is declared with
    ``response_model_exclude_unset=True`` precisely so a default of ``None``
    here does not start emitting ``"degraded": null`` on every successful call.
    A client that sees ``degraded`` draws no ownership markers at all, so the
    key appearing where it never used to would blank every marker in the app.
    """

    results: list[OwnershipVerdictResponse] = Field(default_factory=list)
    degraded: bool | None = None
