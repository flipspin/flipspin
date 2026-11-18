"""The acquisition wire contract. Catalog identity is distinct from audio source."""
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.infra.urls import UserURL, SourceURL


class RetrySelection(BaseModel):
    index: int = Field(ge=0)
    youtube_url: SourceURL | None = Field(default=None, min_length=1, max_length=500)


class Track(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    artist: str = Field(default='', max_length=500)
    album: str | None = Field(default=None, max_length=500)
    provider_id: str | None = Field(default=None, max_length=500)
    duration_s: float | None = Field(default=None, ge=0, le=86400)
    track_number: int | None = Field(default=None, ge=1, le=1000)
    cover_url: UserURL | None = Field(default=None, max_length=2000)
    youtube_url: SourceURL | None = Field(default=None, max_length=2000)
    isrc: str | None = Field(default=None, max_length=32)
    replaces: str | None = Field(default=None, max_length=4096)
    album_artist: str | None = Field(default=None, max_length=500)
    track_total: int | None = Field(default=None, ge=1, le=1000)
    disc_number: int | None = Field(default=None, ge=1, le=1000)
    disc_total: int | None = Field(default=None, ge=1, le=1000)
    compilation: bool | None = None
    genre: str | None = Field(default=None, max_length=500)
    year: int | None = Field(default=None, ge=1, le=9999)
    recording_mbid: str | None = Field(default=None, max_length=64)
    release_mbid: str | None = Field(default=None, max_length=64)
    release_group_mbid: str | None = Field(default=None, max_length=64)
    artist_mbid: str | list[str] | None = None

    @field_validator('replaces')
    @classmethod
    def library_rel_path(cls, value):
        if value is not None:
            parts = value.replace('∕', '/').split('/')
            if (len(value.split('/')) != 2 or '\\' in value or '\x00' in value
                    or any(part in ('', '.', '..') for part in parts)
                    or (len(value) > 1 and value[1] == ':')):
                raise ValueError('invalid-library-rel-path')
        return value


class Request(BaseModel):
    kind: Literal['song', 'album', 'playlist'] = 'song'
    provider: str = Field(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_-]+$')
    provider_id: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=500)
    tracks: list[Track] = Field(min_length=1, max_length=5000)
    folder: str | None = Field(default=None, max_length=255)


class AcquisitionError(ValueError):
    def __init__(self, reason, status=409):
        self.reason, self.status = reason, status
        super().__init__(reason)
