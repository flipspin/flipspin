"""Cacheable dashboard values with tolerant readers for older snapshots.

Provider identity supports in-app navigation; URLs remain optional links.
"""
from dataclasses import dataclass, field
from typing import Any, Optional

# Row ids are persisted in the cache file and referenced by the frontend, so
# they are stable identifiers, not labels. Titles are display text and may move.
TOP_PLAYLISTS = "top-playlists"
TOP_ARTISTS = "top-artists"
TOP_ALBUMS = "top-albums"
NEW_RELEASES = "new-releases"
TOP_TRACKS = "top-tracks"
GENRES = "genres"
PODCASTS = "podcasts"

# Row order in the payload. The first four keep their places — two shipped
# clients have drawn them in this order since the dashboard existed — and the
# newer rows follow; the desktop places each row by its kind anyway.
ROW_ORDER = (TOP_PLAYLISTS, TOP_ARTISTS, TOP_ALBUMS, NEW_RELEASES, TOP_TRACKS, GENRES, PODCASTS)

ROW_TITLES: dict[str, str] = {
    TOP_PLAYLISTS: "Top Playlists",
    TOP_ARTISTS: "Top Artists",
    TOP_ALBUMS: "Top Albums",
    NEW_RELEASES: "New Releases",
    TOP_TRACKS: "Top Tracks",
    GENRES: "Genres",
    PODCASTS: "Podcasts",
}

# The "kind" of thing each row holds, per the spec's
# ``"playlist" | "artist" | "album" | "track"``. The frontend picks a card
# layout from this (a square artist avatar is not an album cover).
ROW_KINDS: dict[str, str] = {
    TOP_PLAYLISTS: "playlist",
    TOP_ARTISTS: "artist",
    TOP_ALBUMS: "album",
    NEW_RELEASES: "album",
    TOP_TRACKS: "track",
    GENRES: "genre",
    PODCASTS: "podcast",
}


def _as_str(value: Any) -> str | None:
    """Coerce a cached/provider value to a non-empty string, else None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@dataclass(frozen=True)
class DashboardItem:
    """One card in a row: an album, artist, playlist or track."""

    id: str
    title: str
    subtitle: str | None = None
    image_url: str | None = None
    provider_url: str | None = None
    #: A top-songs card only: the browse ``BrowseTrack`` dict, so the client
    #: can check ownership and save the song exactly as from an album page.
    #: Absent from every other row, which keeps their five keys.
    track: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        # camelCase on the wire to match the spec's `cachedAt` — the frontend
        # reads one convention across the whole payload, not two.
        out = {
            "id": self.id,
            "title": self.title,
            "subtitle": self.subtitle,
            "imageUrl": self.image_url,
            "providerUrl": self.provider_url,
        }
        if self.track is not None:
            out["track"] = dict(self.track)
        return out

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["DashboardItem"]:
        """Rebuild from a cached dict. Returns None for anything unusable."""
        if not isinstance(raw, dict):
            return None
        item_id = _as_str(raw.get("id"))
        title = _as_str(raw.get("title"))
        if not item_id or not title:
            return None
        return cls(
            id=item_id,
            title=title,
            subtitle=_as_str(raw.get("subtitle")),
            image_url=_as_str(raw.get("imageUrl")),
            provider_url=_as_str(raw.get("providerUrl")),
            track=raw.get("track") if isinstance(raw.get("track"), dict) else None,
        )


@dataclass(frozen=True)
class DashboardRow:
    """One horizontal row of the browse page.

    ``provider``/``provider_name`` are carried per row rather than once per
    response because the spec wants a provider chip *beside each row title* —
    it is honest about where the data came from, and it stops KROBI reading as
    though it curated a Deezer chart itself. It also leaves room for a second
    provider filling a row the first cannot.
    """

    id: str
    title: str
    kind: str
    provider: str
    provider_name: str
    items: list[DashboardItem] = field(default_factory=list)
    error: str | None = None
    stale: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "provider": self.provider,
            "providerName": self.provider_name,
            "items": [item.to_dict() for item in self.items],
            "error": self.error,
            "stale": self.stale,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["DashboardRow"]:
        if not isinstance(raw, dict):
            return None
        row_id = _as_str(raw.get("id"))
        if not row_id:
            return None
        items_raw = raw.get("items")
        items: list[DashboardItem] = []
        if isinstance(items_raw, list):
            for entry in items_raw:
                item = DashboardItem.from_dict(entry)
                if item is not None:
                    items.append(item)
        return cls(
            id=row_id,
            # Older snapshots may omit a row's current title or kind; recover them by id.
            title=_as_str(raw.get("title")) or ROW_TITLES.get(row_id, row_id),
            kind=_as_str(raw.get("kind")) or ROW_KINDS.get(row_id, "album"),
            provider=_as_str(raw.get("provider")) or "unknown",
            provider_name=_as_str(raw.get("providerName")) or "Unknown",
            items=items,
            error=_as_str(raw.get("error")),
            stale=bool(raw.get("stale")),
        )


@dataclass(frozen=True)
class Dashboard:
    """A full snapshot: the rows plus when they were fetched.

    ``cached_at`` is an ISO-8601 UTC instant and is the *snapshot's* age, not
    any individual row's — the TTL is applied to the snapshot as a whole.
    ``stale`` is true when at least one row is being served from an older copy
    because the provider failed; the spec's UI says so rather than presenting
    day-old charts as fresh.
    """

    rows: list[DashboardRow] = field(default_factory=list)
    cached_at: str | None = None
    stale: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "rows": [row.to_dict() for row in self.rows],
            "cachedAt": self.cached_at,
            "stale": self.stale,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> Optional["Dashboard"]:
        if not isinstance(raw, dict):
            return None
        rows_raw = raw.get("rows")
        if not isinstance(rows_raw, list):
            return None
        rows: list[DashboardRow] = []
        for entry in rows_raw:
            row = DashboardRow.from_dict(entry)
            if row is not None:
                rows.append(row)
        return cls(
            rows=rows,
            cached_at=_as_str(raw.get("cachedAt")),
            stale=bool(raw.get("stale")),
        )

    def row(self, row_id: str) -> DashboardRow | None:
        for row in self.rows:
            if row.id == row_id:
                return row
        return None
