"""The actual file contains the response ID; repeated reads stay at debug."""
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse

from app.exceptions import MusicNotFoundError
from app.middleware import ErrorHandlingMiddleware, RequestLoggingMiddleware


@pytest.mark.parametrize("supplied", [None, "fixture-request-123", "fixture/segment"])
def test_request_id_is_in_the_human_readable_line(config, supplied):
    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)

    @app.get("/api/playlists")
    def playlists():
        return []

    client = TestClient(app)
    headers = {"X-Request-ID": supplied} if supplied else {}
    response = client.get("/api/playlists?token=fixture-secret", headers=headers)
    request_id = response.headers["X-Request-ID"]
    assert request_id
    if supplied:
        assert request_id == supplied
    lines = (config.log_dir / "krobi.log").read_text().splitlines()
    request_lines = [line for line in lines if "app.middleware:" in line]
    assert len(request_lines) == 1
    assert f"[request_id={request_id}]" in request_lines[0]
    assert "GET /api/playlists → 200" in request_lines[0]
    assert "token=" not in request_lines[0]


@pytest.mark.parametrize("path", ["/api/status", "/api/me", "/api/playlists", "/api/helpers/heartbeat"])
def test_status_and_poll_requests_do_not_log_at_info(config, path):
    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    app.add_api_route(path, lambda: {"ok": True}, methods=["GET", "POST"])
    client = TestClient(app)
    for _ in range(3):
        assert client.post(path).status_code == 200
    lines = (config.log_dir / "krobi.log").read_text().splitlines()
    requests = [line for line in lines if "app.middleware:" in line]
    assert len(requests) == 3
    assert all(" DEBUG " in line for line in requests)


@pytest.mark.parametrize("status, level", [(404, logging.WARNING), (500, logging.WARNING), (503, logging.WARNING)])
def test_failure_request_line_still_visible_at_info(config, status, level):
    from fastapi.responses import Response

    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    app.add_api_route("/api/status", lambda: Response(status_code=status))
    response = TestClient(app).get("/api/status")
    text = (config.log_dir / "krobi.log").read_text()
    assert logging.getLevelName(level) in text
    assert f"[request_id={response.headers['X-Request-ID']}]" in text


@pytest.mark.parametrize("route, path", [
    ("/api/lyrics/{album}/{file}", "/api/lyrics/A/song.mp3"),
    ("/api/stems/{album}/{file}", "/api/stems/A/song.mp3"),
    ("/api/media/{album}/cover.jpg", "/api/media/A/cover.jpg"),
])
@pytest.mark.parametrize("method", ["GET", "HEAD", "POST", "PUT", "DELETE"])
@pytest.mark.parametrize("status", [404, 403, 500])
def test_optional_read_absence_level_and_wire(config, route, path, method, status):
    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    body = {"detail": "fixture absence"}
    app.add_api_route(route, lambda: JSONResponse(body, status_code=status), methods=[method])
    response = TestClient(app).request(method, path + "?token=fixture-secret")
    assert response.status_code == status
    if method != "HEAD":
        assert response.json() == body
    lines = (config.log_dir / "krobi.log").read_text().splitlines()
    requests = [line for line in lines if "app.middleware:" in line]
    assert len(requests) == 1
    level = "DEBUG" if status == 404 and method in {"GET", "HEAD"} else "WARNING"
    assert f" {level} " in requests[0]
    assert "fixture-secret" not in requests[0]


@pytest.mark.parametrize("route, path", [
    ("/api/media/{album}/{filename}", "/api/media/A/song.mp3"),
    ("/api/stems/{album}/{file}/{stem}", "/api/stems/A/song.mp3/vocals"),
    ("/api/lyrics/{album}/{file}/offset", "/api/lyrics/A/song.mp3/offset"),
    ("/api/other/{album}/{file}", "/api/other/A/song.mp3"),
    # The concrete URL resembles lyrics, but this is a different template.
    ("/api/{feature}/{album}/{file}", "/api/lyrics/A/song.mp3"),
])
def test_other_not_found_reads_still_warn(config, route, path):
    app = FastAPI()
    app.add_middleware(RequestLoggingMiddleware)
    app.add_api_route(route, lambda: JSONResponse({"detail": "No lyrics for song"}, status_code=404))
    assert TestClient(app).get(path).status_code == 404
    lines = (config.log_dir / "krobi.log").read_text().splitlines()
    requests = [line for line in lines if "app.middleware:" in line]
    assert len(requests) == 1
    assert " WARNING " in requests[0]


@pytest.mark.parametrize("feature, level", [("lyrics", "DEBUG"), ("media", "WARNING")])
def test_typed_not_found_keeps_response_and_level(config, feature, level):
    app = FastAPI()
    app.add_middleware(ErrorHandlingMiddleware)
    app.add_middleware(RequestLoggingMiddleware)
    error = MusicNotFoundError("fixture missing", details={"file": "song.mp3"})

    def missing():
        raise error

    file_param = "file" if feature == "lyrics" else "filename"
    app.add_api_route(f"/api/{feature}/{{album}}/{{{file_param}}}", missing)
    response = TestClient(app).get(f"/api/{feature}/A/song.mp3")
    assert response.status_code == 404
    assert response.json() == error.to_dict()
    lines = (config.log_dir / "krobi.log").read_text().splitlines()
    records = [line for line in lines if "app.middleware:" in line]
    assert len(records) == 2
    assert all(f" {level} " in line for line in records)


def test_http_libraries_do_not_repeat_successful_requests_at_info(config):
    from app.infra.logging import LoggerConfig

    LoggerConfig.set_level("INFO")
    logging.getLogger("httpx").info("HTTP Request: GET /api/status 200 OK")
    logging.getLogger("uvicorn.access").info("GET /api/status 200 OK")
    assert "GET /api/status" not in (config.log_dir / "krobi.log").read_text()
    LoggerConfig.set_level("DEBUG")
    logging.getLogger("httpx").info("HTTP Request: GET /api/status 200 OK")
    assert "DEBUG" in (config.log_dir / "krobi.log").read_text()
