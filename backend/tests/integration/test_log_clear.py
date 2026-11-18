"""Clear only current allowlisted logs, with owner and device attribution."""
import logging
from logging.handlers import RotatingFileHandler

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_config, get_token_store
from app.domains.accounts.store import TokenStore
from app.domains.system import routes
from app.main import app


@pytest.fixture
def logs(tmp_path, monkeypatch):
    config = app.state.config
    monkeypatch.setattr(config, "log_dir", tmp_path)
    store = TokenStore(tmp_path / "users.json")
    owner, token = store.mint("Owner", role="owner")
    store.rename_device(owner.user_id, owner.devices[0].device_id, "Test desktop")
    _, member_token = store.mint("Member")
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_token_store] = lambda: store
    monkeypatch.setattr(app.state.container, "get_token_store", lambda: store)
    path = tmp_path / "krobi.log"
    path.write_text("old diagnostic\n")
    try:
        yield TestClient(app), path, token, member_token
    finally:
        app.dependency_overrides.pop(get_config, None)
        app.dependency_overrides.pop(get_token_store, None)


def test_owner_clears_in_place_and_open_handler_keeps_writing(logs):
    client, path, token, _ = logs
    backup = path.with_suffix(".log.1")
    backup.write_text("rotated diagnostic\n")
    inode = path.stat().st_ino
    size = path.stat().st_size
    handler = RotatingFileHandler(path, encoding="utf-8")
    logger = routes.logger
    original_level = logger.level
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    try:
        response = client.post("/api/logs/clear", json={"file": "app"}, headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        assert response.json() == {"file": "app", "clearedBytes": size}
        assert path.stat().st_ino == inode
        assert path.read_text().splitlines() == ["Log cleared (app) by Test desktop"]
        assert path.stat().st_size == len(b"Log cleared (app) by Test desktop\n")
        logger.info("still writing")
        assert path.read_text().endswith("still writing\n")
        assert backup.read_text() == "rotated diagnostic\n"
    finally:
        logger.removeHandler(handler)
        handler.close()
        logger.setLevel(original_level)


def test_member_cannot_clear(logs):
    client, path, _, token = logs
    response = client.post("/api/logs/clear", json={"file": "app"}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 403
    assert path.read_text() == "old diagnostic\n"


@pytest.mark.parametrize("file", ["unknown", "../krobi.log", "/tmp/private", "krobi.log"])
def test_unknown_or_path_is_refused(logs, file):
    client, path, token, _ = logs
    response = client.post("/api/logs/clear", json={"file": file}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 422
    assert path.read_text() == "old diagnostic\n"


@pytest.mark.parametrize("outside", [False, True])
def test_symlink_is_refused(logs, tmp_path, outside):
    client, path, token, _ = logs
    target = tmp_path / "private.log" if not outside else tmp_path.parent / f"{tmp_path.name}-private.log"
    target.write_text("private diagnostic\n")
    path.unlink()
    path.symlink_to(target)
    response = client.post("/api/logs/clear", json={"file": "app"}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 404
    assert target.read_text() == "private diagnostic\n"


def test_errors_log_can_be_cleared_without_touching_app(logs):
    client, path, token, _ = logs
    errors = path.with_name("krobi_errors.log")
    errors.write_text("error\n")
    response = client.post("/api/logs/clear", json={"file": "errors"}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json() == {"file": "errors", "clearedBytes": 6}
    assert errors.read_bytes() == b""
    assert path.read_text() == "old diagnostic\n"
