"""Dashboard I/O: the on-disk snapshot cache, and the Deezer provider adapter.

Two collaborators live here because both are "the edge of the domain": one
talks to the filesystem, the other talks to a provider repository. Neither
makes a policy decision — when to refresh, what to do with a failed row, and
what "stale" means are the service's job.
"""
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any
from collections.abc import Callable

from app.config import KROBI_HOME
from app.infra.files import write_text_atomic
from app.domains.browse.repositories import DeezerBrowseProvider
from app.domains.dashboard.models import (
    PODCASTS,
    ROW_KINDS,
    ROW_ORDER,
    ROW_TITLES,
    TOP_ALBUMS,
    TOP_ARTISTS,
    TOP_PLAYLISTS,
    TOP_TRACKS,
    Dashboard,
    DashboardItem,
    DashboardRow,
)

DEEZER_PROVIDER_ID = "deezer"
DEEZER_PROVIDER_NAME = "Deezer"

# Twenty cards span roughly three desktop screens. More cards cost response
# bytes rather than requests because /chart returns all sections together.
DEFAULT_ROW_LIMIT = 20

# Where the snapshot lives. Sibling of the `~/Krobi/providers.json` the provider
# registry spec defines and of the `~/Krobi/.env` main.py already reads, because
# this is app state that must survive a restart. Deliberately NOT under
# `config.temp_dir`: that directory is named for disposable files,
# and a disposable cache is a cache that will be re-fetched on the
# next app open — the exact traffic shape Deezer's per-IP quota punishes.
DEFAULT_CACHE_FILENAME = "dashboard-cache.json"


def default_cache_path() -> Path:
    """Resolve the snapshot path: env override, else ``~/Krobi/<file>``."""
    override = os.getenv("KROBI_DASHBOARD_CACHE_FILE")
    if override and override.strip():
        return Path(override.strip()).expanduser()
    return KROBI_HOME / DEFAULT_CACHE_FILENAME


class DashboardCacheRepository:
    """Reads and writes one JSON snapshot of the dashboard.

    Every failure here is non-fatal by construction. A missing, unreadable,
    truncated or foreign-shaped file returns ``None`` (a cache miss), and a
    failed write is logged and swallowed — the dashboard the user asked for is
    already in memory, and a cache write failure must not suppress
    that usable result.
    """

    def __init__(
        self,
        config,
        logger: logging.Logger,
        cache_path: Path | None = None,
    ):
        self.config = config
        self.logger = logger
        # Injectable so tests never touch the real home directory. Resolved once
        # here rather than per-call: unlike the music root, this path has no
        # runtime-settable equivalent.
        self.cache_path = Path(cache_path) if cache_path is not None else default_cache_path()
        self._lock = threading.Lock()

    def load(self) -> Dashboard | None:
        """Return the persisted snapshot, or None if there isn't a usable one."""
        with self._lock:
            try:
                raw = self.cache_path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return None
            except OSError as e:
                self.logger.warning("Dashboard cache unreadable at %s: %s", self.cache_path, e)
                return None
        try:
            payload = json.loads(raw)
        except ValueError as e:
            # Half-written file from a kill -9, or an older format. Treat it as a
            # miss; the next successful save overwrites it.
            self.logger.warning("Dashboard cache is not valid JSON (%s); ignoring it", e)
            return None
        snapshot = Dashboard.from_dict(payload)
        if snapshot is None or not snapshot.rows:
            return None
        return snapshot

    def save(self, snapshot: Dashboard) -> bool:
        """Persist ``snapshot``. Returns whether it landed; never raises."""
        payload = json.dumps(snapshot.to_dict(), ensure_ascii=False, indent=2)
        with self._lock:
            try:
                # Write-then-rename, so a crash mid-write leaves the previous good
                # snapshot intact rather than a truncated file load() would discard.
                write_text_atomic(self.cache_path, payload)
                return True
            except OSError as e:
                self.logger.warning("Could not persist dashboard cache to %s: %s", self.cache_path, e)
                return False


def _first_url(raw: dict[str, Any], *keys: str) -> str | None:
    """First non-empty string among ``keys``. Used to walk an image-size ladder."""
    for key in keys:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _artist_name(raw: dict[str, Any]) -> str | None:
    artist = raw.get("artist")
    if isinstance(artist, dict):
        name = artist.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    return None


class DeezerDashboardProvider:
    """Adapt Deezer chart and editorial responses into dashboard rows.

    Share one chart call; fall back to selection for empty releases. Propagate
    errors for service-level recovery.
    See docs/DEVELOPER_GUIDE.md#dashboard-caching.
    """

    provider_id = DEEZER_PROVIDER_ID
    provider_name = DEEZER_PROVIDER_NAME

    def __init__(
        self,
        deezer,
        logger: logging.Logger,
        row_limit: int = DEFAULT_ROW_LIMIT,
        editorial_id: int = 0,
    ):
        """Share Deezer's repository and limiter across dashboard and resolution calls.

        Separate clients would each consume the same per-IP quota independently.
        """
        self.deezer = deezer
        self.logger = logger
        self.row_limit = max(1, int(row_limit))
        self.editorial_id = int(editorial_id)

    # ------------------------------------------------------------------ public

    def fetch_chart_rows(self) -> dict[str, list[DashboardItem]]:
        """One ``/chart`` call -> the three chart-backed rows, keyed by row id.

        A section Deezer omits or returns empty simply maps to an empty list;
        the service turns that into a per-row error. Raises whatever
        ``DeezerRepository`` raises (``ExternalAPIError``) — see the class
        docstring for why it does not swallow.
        """
        payload = self.deezer.fetch_chart(limit=self.row_limit)
        return {
            TOP_PLAYLISTS: self._map(payload, "playlists", self._playlist_item),
            TOP_ARTISTS: self._map(payload, "artists", self._artist_item),
            TOP_ALBUMS: self._map(payload, "albums", self._album_item),
            # Reuse the chart response for these sections without spending another request.
            TOP_TRACKS: self._map(payload, "tracks", self._track_item),
            PODCASTS: self._map(payload, "podcasts", self._podcast_item),
        }

    def fetch_genres(self) -> list[DashboardItem]:
        """Deezer's genres, minus "All" (id 0). One request, cached with the rest."""
        return self._map_rows(self.deezer.fetch_genres(), self._genre_item)

    def fetch_new_releases(self) -> list[DashboardItem]:
        """New Releases, with the ``/selection`` fallback described above."""
        rows = self.deezer.fetch_editorial_releases(self.editorial_id, limit=self.row_limit)
        if not rows:
            self.logger.info(
                "Deezer /editorial/%s/releases returned nothing; falling back to /selection",
                self.editorial_id,
            )
            rows = self.deezer.fetch_editorial_selection(self.editorial_id, limit=self.row_limit)
        return self._map_rows(rows, self._album_item)

    def blank_row(self, row_id: str, error: str | None = None) -> DashboardRow:
        """An empty, attributed row — the shape a failure still has to produce."""
        return DashboardRow(
            id=row_id,
            title=ROW_TITLES.get(row_id, row_id),
            kind=ROW_KINDS.get(row_id, "album"),
            provider=self.provider_id,
            provider_name=self.provider_name,
            items=[],
            error=error,
        )

    def row_ids(self) -> list[str]:
        return list(ROW_ORDER)

    # ----------------------------------------------------------------- private

    def _map(
        self,
        payload: dict[str, Any],
        section: str,
        mapper: Callable[[dict[str, Any]], DashboardItem | None],
    ) -> list[DashboardItem]:
        block = payload.get(section)
        rows = block.get("data") if isinstance(block, dict) else None
        return self._map_rows(rows if isinstance(rows, list) else [], mapper)

    def _map_rows(
        self,
        rows: list[Any],
        mapper: Callable[[dict[str, Any]], DashboardItem | None],
    ) -> list[DashboardItem]:
        items: list[DashboardItem] = []
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            item = mapper(raw)
            if item is not None:
                items.append(item)
            if len(items) >= self.row_limit:
                break
        return items

    @staticmethod
    def _base(raw: dict[str, Any], title_key: str) -> dict[str, Any] | None:
        """Shared id/title extraction. None when either is missing."""
        entry_id = raw.get("id")
        title = raw.get(title_key)
        if entry_id is None or not isinstance(title, str) or not title.strip():
            return None
        return {"id": str(entry_id), "title": title.strip()}

    @classmethod
    def _album_item(cls, raw: dict[str, Any]) -> DashboardItem | None:
        base = cls._base(raw, "title")
        if base is None:
            return None
        return DashboardItem(
            id=base["id"],
            title=base["title"],
            subtitle=_artist_name(raw),
            # A 152 CSS px card needs 304 pixels at 2x scale. Prefer 500px covers to
            # avoid upscaling 250px art without paying for full embedding-size images.
            image_url=_first_url(raw, "cover_big", "cover_xl", "cover_medium", "cover", "cover_small"),
            provider_url=_first_url(raw, "link"),
        )

    @classmethod
    def _artist_item(cls, raw: dict[str, Any]) -> DashboardItem | None:
        base = cls._base(raw, "name")
        if base is None:
            return None
        return DashboardItem(
            id=base["id"],
            title=base["title"],
            # No subtitle: Deezer's chart artist rows carry no fan count or
            # genre, and inventing prose here would put UI copy in the backend.
            subtitle=None,
            image_url=_first_url(raw, "picture_big", "picture_xl", "picture_medium", "picture", "picture_small"),
            provider_url=_first_url(raw, "link"),
        )

    @classmethod
    def _track_item(cls, raw: dict[str, Any]) -> DashboardItem | None:
        # The browse mapper, not a second one: the card has to carry exactly the
        # track an album page would, or saving it from here matches differently.
        track = DeezerBrowseProvider.track_from(raw)
        if track is None:
            return None
        return DashboardItem(
            id=track.ref.id,
            title=track.title,
            subtitle=track.artist_name,
            image_url=track.cover_url,
            provider_url=_first_url(raw, "link"),
            track=track.to_dict(),
        )

    @classmethod
    def _genre_item(cls, raw: dict[str, Any]) -> DashboardItem | None:
        genre = DeezerBrowseProvider.genre_from(raw)
        if genre is None:
            return None
        return DashboardItem(id=genre.ref.id, title=genre.name, image_url=genre.image_url)

    @classmethod
    def _podcast_item(cls, raw: dict[str, Any]) -> DashboardItem | None:
        base = cls._base(raw, "title")
        if base is None:
            return None
        description = raw.get("description")
        return DashboardItem(
            id=base["id"],
            title=base["title"],
            subtitle=description.strip() if isinstance(description, str) and description.strip() else None,
            image_url=_first_url(raw, "picture_big", "picture_xl", "picture_medium", "picture", "picture_small"),
            # A podcast has no page here and nothing to save; Deezer's own page
            # is where it plays.
            provider_url=_first_url(raw, "link"),
        )

    @classmethod
    def _playlist_item(cls, raw: dict[str, Any]) -> DashboardItem | None:
        base = cls._base(raw, "title")
        if base is None:
            return None
        user = raw.get("user")
        owner = user.get("name") if isinstance(user, dict) else None
        return DashboardItem(
            id=base["id"],
            title=base["title"],
            subtitle=owner.strip() if isinstance(owner, str) and owner.strip() else None,
            image_url=_first_url(raw, "picture_big", "picture_xl", "picture_medium", "picture", "picture_small"),
            provider_url=_first_url(raw, "link"),
        )


__all__ = [
    "DEEZER_PROVIDER_ID",
    "DEEZER_PROVIDER_NAME",
    "DEFAULT_ROW_LIMIT",
    "DashboardCacheRepository",
    "DeezerDashboardProvider",
    "default_cache_path",
]
