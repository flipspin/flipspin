"""Response models for ``domains/user_library/routes.py``.

A route with no ``response_model`` reaches the generated client as ``unknown``,
and ``unknown`` is where a field rename stops being a compile error. Like the
account surface these bodies are camelCase throughout, and like it they never
carry a ``user_id``: every ``/api/me/library`` body is scoped to the caller.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PlayEventRow(BaseModel):
    id: str
    relPath: str
    startedAt: str
    playedSeconds: float | None
    completed: bool
    source: Literal['desktop', 'phone', 'subsonic']
    deviceId: str | None


class PlayHistoryResponse(BaseModel):
    events: list[PlayEventRow]
    nextCursor: str | None


# -------------------------------------------------------------- personal library

class UserTrackRow(BaseModel):
    """One row of the calling principal's library. Mirrors ``UserTrack.public()``.

    ``relPath`` is two clean segments — ``album/file`` — relative to the shared
    music root, never an absolute path and never a URL. It is the key for every
    other route on this surface.

    ⚠ Both timestamps are **ISO-8601 UTC strings**, matching the identity rows
    above and *not* the POSIX floats a playlist or a track carries. Typing them
    as floats is the one mistake this file has already made once.

    ``lastPlayedAt`` is coarse by design: the store batches play writes, so it
    will usually predate the request reading it. It is not a clock.
    """

    relPath: str
    addedAt: str
    liked: bool
    offline: bool
    playCount: int
    lastPlayedAt: str | None = None


class MyLibraryResponse(BaseModel):
    """``GET /api/me/library`` — oldest first.

    Absent files keep their rows. File presence lives at ``/library/missing``.
    """

    tracks: list[UserTrackRow]
    count: int


class MissingLibraryResponse(BaseModel):
    """``GET /api/me/library/missing`` — owned paths whose files are gone."""

    relPaths: list[str]


class AddToLibraryResponse(BaseModel):
    """``POST /api/me/library`` — 200 even when some paths are not on disk.

    Three disjoint buckets over the paths that were sent: ``added`` is new rows,
    ``already`` is rows the caller had (untouched — re-adding is not a reset),
    and ``missing`` is paths the shared catalog does not hold. ⚠ ``missing`` is
    not an error and must not be rendered as one; failing the batch because one
    of fifty tracks is absent would make the dedupe hit hostage to the miss.
    """

    added: list[str]
    already: list[str]
    missing: list[str]


class PlaylistRemovalUpdate(BaseModel):
    """A playlist changed automatically by a committed track removal."""

    name: str
    removed: int


class RemoveFromLibraryResponse(BaseModel):
    """``DELETE /api/me/library`` — **rows only. The files stay on disk.**

    ⚠ Not ``POST /api/delete-track``. That one unlinks the audio and every
    member loses it forever; this one forgets a reference that one POST brings
    straight back. ``removed`` lists only what the caller actually held, so a
    retried DELETE is harmless and answers a short list.
    """

    removed: list[str]
    playlistsUpdated: list[PlaylistRemovalUpdate] = Field(default_factory=list)


class MyOwnershipVerdict(BaseModel):
    """Whether the caller holds one specific ``relPath``.

    ``relPath`` is echoed so a positional misalignment is detectable rather than
    silent — see :class:`MyOwnershipResponse`.
    """

    relPath: str
    owned: bool


class MyOwnershipResponse(BaseModel):
    """``POST /api/me/library/ownership`` — **positional**, never filtered.

    ``results[i]`` answers ``relPaths[i]``, always. Repeats are answered in place
    rather than de-duplicated, because positional means positional, and a client
    drawing ownership markers by index would otherwise draw them on wrong rows.

    Distinct from ``POST /api/library/ownership`` in the music domain and both
    are needed: that one asks, fuzzily by title and artist, whether the *shared
    library* has a catalog track; this one asks, exactly by ``relPath``, whether
    *you* have a known file.
    """

    results: list[MyOwnershipVerdict]
