"""Dashboard domain routes."""
import logging

from fastapi import APIRouter, Depends

from app.dependencies import get_dashboard_service, get_library_scope
from app.domains.user_library.scope import LibraryScope
from app.domains.dashboard.services import DashboardService

router = APIRouter(prefix="/api", tags=["dashboard"])
logger = logging.getLogger(__name__)


@router.get("/dashboard")
def get_dashboard_endpoint(
    refresh: bool = False,
    service: DashboardService = Depends(get_dashboard_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """The browse page's four rows.

    ``{"rows": [...], "cachedAt": "...", "stale": bool}``. ``stale: true`` means at least one row is
    the last good copy because the provider failed — the UI is expected to say
    so rather than present day-old charts as fresh.

    ``?refresh=true`` bypasses the TTL. It exists for a manual "reload" affordance
    and for support; it is **not** something the page should call on mount, which
    would defeat the cache that Deezer's per-IP quota requires.

    There is no error status code here on purpose. A dashboard provider failing
    is a normal, expected condition, and the requirement is that it never blanks
    the page — so every path returns 200 with whatever rows exist and per-row
    ``error`` strings for the rest.
    """
    try:
        snapshot = service.get_dashboard(force_refresh=refresh)
    except Exception as e:
        # The service is written not to raise; this is the guarantee, not the
        # expectation. A 500 here would blank the page, which is the one outcome
        # this endpoint is not allowed to produce.
        logger.error("Unexpected dashboard error: %s", e)
        snapshot = service.empty_dashboard("Dashboard temporarily unavailable")
    return DashboardService.scope_dashboard(snapshot, scope).to_dict()
