"""Integration tests for GET /api/dashboard.

Pins the wire contract the frontend reads — ``{"rows", "cachedAt", "stale"}``
— and the one rule that matters more than
the shape: a failing dashboard is still an HTTP 200 with four rows, because
the requirement is that a dead provider never blanks the page.

The service is mocked, so no Deezer request is made.
"""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_dashboard_service
from app.domains.dashboard.models import (
    NEW_RELEASES,
    ROW_ORDER,
    TOP_ALBUMS,
    Dashboard,
    DashboardItem,
    DashboardRow,
)
from app.domains.dashboard.services import DashboardService
from app.main import app


def _row(row_id, items=(), error=None, stale=False):
    return DashboardRow(
        id=row_id,
        title=row_id.replace("-", " ").title(),
        kind="album",
        provider="deezer",
        provider_name="Deezer",
        items=list(items),
        error=error,
        stale=stale,
    )


@pytest.fixture
def client_and_service():
    service = Mock(spec=DashboardService)
    app.dependency_overrides[get_dashboard_service] = lambda: service
    try:
        yield TestClient(app), service
    finally:
        app.dependency_overrides.pop(get_dashboard_service, None)


def test_returns_rows_cached_at_and_stale(client_and_service):
    client, service = client_and_service
    service.get_dashboard = Mock(
        return_value=Dashboard(
            rows=[
                _row(
                    TOP_ALBUMS,
                    [
                        DashboardItem(
                            id="302127",
                            title="Discovery",
                            subtitle="Daft Punk",
                            image_url="https://cdn/250.jpg",
                            provider_url="https://www.deezer.com/album/302127",
                        )
                    ],
                )
            ],
            cached_at="2026-08-20T12:00:00Z",
            stale=False,
        )
    )

    resp = client.get("/api/dashboard")

    assert resp.status_code == 200
    body = resp.json()
    assert body["cachedAt"] == "2026-08-20T12:00:00Z"
    assert body["stale"] is False
    item = body["rows"][0]["items"][0]
    assert item["imageUrl"] == "https://cdn/250.jpg"
    assert item["providerUrl"] == "https://www.deezer.com/album/302127"
    # The provider chip beside each row title.
    assert body["rows"][0]["providerName"] == "Deezer"


def test_stale_and_per_row_errors_are_surfaced_with_a_200(client_and_service):
    client, service = client_and_service
    service.get_dashboard = Mock(
        return_value=Dashboard(
            rows=[
                _row(TOP_ALBUMS, [DashboardItem(id="1", title="Discovery")]),
                _row(NEW_RELEASES, [DashboardItem(id="2", title="Old news")],
                     error="Deezer error: Quota limit exceeded", stale=True),
            ],
            cached_at="2026-08-20T06:00:00Z",
            stale=True,
        )
    )

    resp = client.get("/api/dashboard")

    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["rows"][0]["error"] is None
    assert body["rows"][1]["stale"] is True
    assert "Quota" in body["rows"][1]["error"]


def test_refresh_query_param_is_forwarded(client_and_service):
    client, service = client_and_service
    service.get_dashboard = Mock(return_value=Dashboard(rows=[_row(TOP_ALBUMS)], cached_at=None))

    client.get("/api/dashboard?refresh=true")
    service.get_dashboard.assert_called_once_with(force_refresh=True)


def test_an_exploding_service_still_returns_four_rows_not_a_500(client_and_service):
    """The last-resort path. A 500 here would blank the page."""
    client, service = client_and_service
    service.get_dashboard = Mock(side_effect=RuntimeError("nobody anticipated this"))
    service.empty_dashboard = Mock(
        return_value=Dashboard(
            rows=[_row(row_id, error="Dashboard temporarily unavailable") for row_id in ROW_ORDER],
            cached_at=None,
            stale=False,
        )
    )

    resp = client.get("/api/dashboard")

    assert resp.status_code == 200
    body = resp.json()
    assert [row["id"] for row in body["rows"]] == list(ROW_ORDER)
    assert all(row["error"] for row in body["rows"])
