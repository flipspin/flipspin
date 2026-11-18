"""The server exposes a JSON healthcheck, with no renderer or static fallback."""
import pytest
from fastapi.testclient import TestClient

from app.config import APP_VERSION
from app.main import app


@pytest.mark.parametrize("accept", ["*/*", "application/json", "text/html", "text/html,application/xhtml+xml"])
def test_root_keeps_the_healthcheck_json_for_every_accept_header(accept):
    response = TestClient(app).get("/", headers={"Accept": accept})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {"message": "Flipspin API", "version": APP_VERSION, "status": "running"}


@pytest.mark.parametrize("path", ["/library", "/assets/index.js", "/icons/favicon.ico"])
def test_server_has_no_renderer_fallback(path):
    response = TestClient(app).get(path, headers={"Accept": "text/html"})
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/json"
