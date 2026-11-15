"""Cache dashboard rows and coordinate provider refreshes.

Serialize refreshes and retain cached items independently for failed rows.
See docs/DEVELOPER_GUIDE.md#dashboard-caching.
"""
import logging
import threading
from dataclasses import replace
from datetime import datetime, timedelta, UTC
from collections.abc import Callable

from app.domains.user_library.scope import LibraryScope
from app.domains.dashboard.models import (
    GENRES,
    NEW_RELEASES,
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
from app.domains.dashboard.repositories import (
    DashboardCacheRepository,
    DeezerDashboardProvider,
)
from app.domains.dashboard.your_artists import (
    ROW_ID as YOUR_ARTISTS_ROW_ID,
    ROW_KIND as YOUR_ARTISTS_ROW_KIND,
    ROW_TITLE as YOUR_ARTISTS_ROW_TITLE,
)

# See docs/DEVELOPER_GUIDE.md#dashboard-caching for the TTL rationale.
DEFAULT_TTL_HOURS = 6.0

# Retry interval for a snapshot that came back incomplete. Short enough that a
# blip self-heals within one sitting, long enough that a provider which is down
# for an hour is asked at most four times an hour rather than once per app open.
DEGRADED_TTL_MINUTES = 15.0

_ISO_SUFFIX_Z = "Z"


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _to_iso(moment: datetime) -> str:
    """ISO-8601 with a literal Z, which is what JS ``new Date()`` expects."""
    return moment.astimezone(UTC).replace(microsecond=0).isoformat().replace(
        "+00:00", _ISO_SUFFIX_Z
    )


def _from_iso(text: str | None) -> datetime | None:
    """Parse a cached timestamp. None on anything unparseable (= expired)."""
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace(_ISO_SUFFIX_Z, "+00:00"))
    except ValueError:
        return None
    # A snapshot written by a build that forgot the offset is read as UTC rather
    # than as local time; guessing local would shift the TTL by the offset.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class DashboardService:
    """Serves ``GET /api/dashboard``: cached rows, stale on failure, never blank."""

    def __init__(
        self,
        provider: DeezerDashboardProvider,
        cache_repo: DashboardCacheRepository,
        config,
        logger: logging.Logger,
        ttl_hours: float = DEFAULT_TTL_HOURS,
        degraded_ttl_minutes: float = DEGRADED_TTL_MINUTES,
        now: Callable[[], datetime] = _utc_now,
        registry=None,
        your_artists=None,
    ):
        """Compose the provider, persisted cache, clock and refresh TTLs.

        A registry controls outbound requests; optional artist recommendations share
        this cache. See docs/DEVELOPER_GUIDE.md#dashboard-caching.
        """
        self.provider = provider
        self.registry = registry
        self.your_artists = your_artists
        self.cache = cache_repo
        self.config = config
        self.logger = logger
        self.ttl = timedelta(hours=max(0.0, float(ttl_hours)))
        self.degraded_ttl = timedelta(minutes=max(0.0, float(degraded_ttl_minutes)))
        self._now = now
        # Held across the whole refresh, not just the cache write. The point is
        # that N concurrent app opens on a cold cache issue ONE set of provider
        # requests: the losers block, then find the snapshot the winner just
        # stored and take the cache-hit path.
        self._refresh_lock = threading.Lock()

    # ------------------------------------------------------------------ public

    def _provider_enabled(self) -> bool:
        """Whether a dashboard provider is enabled in the registry.

        No registry (tests, older callers) means "yes". This gate exists to
        honour an explicit user choice, not to become a new way for the
        dashboard to go dark by accident.
        """
        if self.registry is None:
            return True
        try:
            from app.providers.registry import ProviderKind

            return bool(self.registry.order(ProviderKind.DASHBOARD))
        except Exception:  # pragma: no cover - registry trouble must not blank the page
            self.logger.warning("provider registry unavailable; serving dashboard anyway")
            return True

    @staticmethod
    def scope_dashboard(snapshot: Dashboard, scope: LibraryScope) -> Dashboard:
        """The shared cache's library-derived recommendations belong to owners."""
        if scope.unrestricted:
            return snapshot
        return Dashboard(
            rows=[row for row in snapshot.rows if row.id != YOUR_ARTISTS_ROW_ID],
            cached_at=snapshot.cached_at,
            stale=snapshot.stale,
        )

    def get_dashboard(self, force_refresh: bool = False) -> Dashboard:
        """Serve rows with per-row fallback; see docs/DEVELOPER_GUIDE.md#dashboard-caching."""
        if not self._provider_enabled():
            # Serves the cache when there is one rather than blanking the page:
            # the user turned the provider off, which should stop KROBI talking
            # to Deezer, not delete what it already fetched.
            disabled_cache = self._safe_load()
            if disabled_cache is not None:
                return self._as_served(disabled_cache)
            return self.empty_dashboard("No hay ninguna fuente de inicio activa.")

        cached = self._safe_load()
        if not force_refresh and self._is_fresh(cached):
            return self._as_served(cached)

        with self._refresh_lock:
            # Re-read under the lock: during the wait, another request may have
            # done exactly this refresh. Without this check a burst of cold-cache
            # requests serializes into N sequential refreshes instead of one.
            cached = self._safe_load()
            if not force_refresh and self._is_fresh(cached):
                return self._as_served(cached)
            # Through _as_served too: a stale "More from your artists" row reused
            # from the cache still has to drop what the library now holds.
            return self._as_served(self._refresh(cached))

    # ----------------------------------------------------------------- private

    def _safe_load(self) -> Dashboard | None:
        try:
            return self.cache.load()
        except Exception as e:
            # The repository already swallows the failures it anticipates; this
            # is the belt to that braces. A cache read must not be able to take
            # the page down.
            self.logger.warning("Dashboard cache load failed unexpectedly: %s", e)
            return None

    def _is_fresh(self, snapshot: Dashboard | None) -> bool:
        if snapshot is None or not snapshot.rows:
            return False
        cached_at = _from_iso(snapshot.cached_at)
        if cached_at is None:
            return False
        # A snapshot written before a row existed is not fresh, however young:
        # otherwise a new row stays invisible for a whole TTL after an upgrade.
        if not set(ROW_ORDER) <= {row.id for row in snapshot.rows}:
            return False
        if self.your_artists is not None and snapshot.row(YOUR_ARTISTS_ROW_ID) is None:
            return False
        degraded = snapshot.stale or any(row.error or row.stale for row in snapshot.rows)
        ttl = self.degraded_ttl if degraded else self.ttl
        if ttl <= timedelta(0):
            return False
        age = self._now() - cached_at
        # A snapshot dated in the future (clock skew, a restored backup) is not
        # trusted as fresh — negative age would otherwise pin it forever.
        if age < timedelta(0):
            return False
        return age < ttl

    def _as_served(self, snapshot: Dashboard) -> Dashboard:
        """Serve cached stale flags, but recheck artist recommendations against the library.

        New acquisitions must leave that row without waiting for cache expiry."""
        return self._without_owned(snapshot)

    def _refresh(self, cached: Dashboard | None) -> Dashboard:
        fresh_items, errors = self._fetch_rows()

        rows: list[DashboardRow] = []
        any_stale = False
        for row_id in ROW_ORDER:
            items = fresh_items.get(row_id)
            error = errors.get(row_id)
            if items:
                rows.append(self._row(row_id, items, error=None, stale=False))
                continue

            # This row has nothing fresh. Prefer last known good over an empty
            # shelf — that is the whole point of "served stale when the provider
            # fails" — but keep the error so the UI can explain the staleness.
            previous = cached.row(row_id) if cached else None
            if previous is not None and previous.items:
                any_stale = True
                rows.append(self._row(row_id, previous.items, error=error, stale=True))
            else:
                rows.append(self._row(row_id, [], error=error or "No data returned", stale=False))

        if self.your_artists is not None:
            row = self._your_artists_row(cached)
            any_stale = any_stale or row.stale
            rows.append(row)

        snapshot = Dashboard(rows=rows, cached_at=_to_iso(self._now()), stale=any_stale)

        if all(row.error for row in rows) and not any(row.items for row in rows):
            # Total failure with nothing cached to fall back on. Do NOT persist:
            # writing an all-empty snapshot would overwrite a good cache that
            # merely failed to load this once, and would hand the next caller a
            # "fresh" empty dashboard for a full TTL.
            self.logger.warning("Dashboard refresh produced no rows at all; not caching")
            return snapshot

        self.cache.save(snapshot)
        return snapshot

    def _fetch_rows(self):
        """Isolate failures by provider call while retaining unaffected rows.

        Return items and errors by row id: /chart backs three rows; New Releases
        uses a separate request."""
        items: dict[str, list[DashboardItem]] = {}
        errors: dict[str, str] = {}

        # The rows `/chart` backs — one request for all of them.
        chart_rows = (TOP_PLAYLISTS, TOP_ARTISTS, TOP_ALBUMS, TOP_TRACKS, PODCASTS)
        try:
            chart = self.provider.fetch_chart_rows()
        except Exception as e:
            message = self._describe(e)
            self.logger.warning("Dashboard chart fetch failed: %s", message)
            for row_id in chart_rows:
                errors[row_id] = message
        else:
            for row_id in chart_rows:
                row_items = chart.get(row_id) or []
                if row_items:
                    items[row_id] = row_items
                else:
                    # A 200 with an empty section. Not an exception, still not an
                    # answer — and on Deezer specifically, "empty" is also what a
                    # quota error looks like to anything reading the status code.
                    errors[row_id] = "Provider returned no items for this row"

        try:
            releases = self.provider.fetch_new_releases()
        except Exception as e:
            message = self._describe(e)
            self.logger.warning("Dashboard new-releases fetch failed: %s", message)
            errors[NEW_RELEASES] = message
        else:
            if releases:
                items[NEW_RELEASES] = releases
            else:
                errors[NEW_RELEASES] = "Provider returned no items for this row"

        # Genres: their own request, their own failure. A provider without the
        # method (an older adapter, a test double) simply has no genres row.
        fetch_genres = getattr(self.provider, "fetch_genres", None)
        if fetch_genres is None:
            errors[GENRES] = "This provider has no genres"
        else:
            try:
                genres = fetch_genres()
            except Exception as e:
                message = self._describe(e)
                self.logger.warning("Dashboard genres fetch failed: %s", message)
                errors[GENRES] = message
            else:
                if genres:
                    items[GENRES] = genres
                else:
                    errors[GENRES] = "Provider returned no items for this row"

        return items, errors

    def _your_artists_row(self, cached: Dashboard | None) -> DashboardRow:
        """"More from your artists", isolated like every other row.

        Unlike a chart, an empty answer here is honest — a new library, or an
        artist whose whole catalog is already on disk — so it renders as an
        empty row, not an error. Only a provider failure is an error, and then
        the previous copy is served stale like any other row.
        """
        try:
            items = self.your_artists.fetch_items()
        except Exception as e:
            message = self._describe(e)
            self.logger.warning("Dashboard «more from your artists» fetch failed: %s", message)
            previous = cached.row(YOUR_ARTISTS_ROW_ID) if cached else None
            if previous is not None and previous.items:
                return self._your_artists_shape(previous.items, error=message, stale=True)
            return self._your_artists_shape([], error=message, stale=False)
        return self._your_artists_shape(items, error=None, stale=False)

    def _your_artists_shape(
        self, items: list[DashboardItem], error: str | None, stale: bool
    ) -> DashboardRow:
        return DashboardRow(
            id=YOUR_ARTISTS_ROW_ID,
            title=YOUR_ARTISTS_ROW_TITLE,
            kind=YOUR_ARTISTS_ROW_KIND,
            provider=self.provider.provider_id,
            provider_name=self.provider.provider_name,
            items=list(items),
            error=error,
            stale=stale,
        )

    def _without_owned(self, snapshot: Dashboard) -> Dashboard:
        if self.your_artists is None:
            return snapshot
        row = snapshot.row(YOUR_ARTISTS_ROW_ID)
        if row is None or not row.items:
            return snapshot
        try:
            kept = self.your_artists.drop_owned(row.items)
        except Exception as e:  # a library read must not take the page down
            self.logger.warning("Could not re-check «more from your artists» against the library: %s", e)
            return snapshot
        if len(kept) == len(row.items):
            return snapshot
        rows = [replace(r, items=kept) if r.id == YOUR_ARTISTS_ROW_ID else r for r in snapshot.rows]
        return replace(snapshot, rows=rows)

    def _row(
        self,
        row_id: str,
        items: list[DashboardItem],
        error: str | None,
        stale: bool,
    ) -> DashboardRow:
        return DashboardRow(
            id=row_id,
            title=ROW_TITLES.get(row_id, row_id),
            kind=ROW_KINDS.get(row_id, "album"),
            provider=self.provider.provider_id,
            provider_name=self.provider.provider_name,
            items=list(items),
            error=error,
            stale=stale,
        )

    @staticmethod
    def _describe(error: BaseException) -> str:
        """A short, user-showable reason. ``ExternalAPIError`` carries a message."""
        message = getattr(error, "message", None)
        if isinstance(message, str) and message.strip():
            return message.strip()
        text = str(error).strip()
        return text or error.__class__.__name__

    def empty_dashboard(self, reason: str) -> Dashboard:
        """Four titled, empty, attributed rows — the last-resort payload.

        Used by the route when even the service fails, so that the very worst
        case is still a page with its four row headings and an explanation,
        never a blank screen or a 500.
        """
        rows = [self._row(row_id, [], error=reason, stale=False) for row_id in ROW_ORDER]
        if self.your_artists is not None:
            rows.append(self._your_artists_shape([], error=reason, stale=False))
        return Dashboard(
            rows=rows,
            cached_at=None,
            stale=False,
        )
