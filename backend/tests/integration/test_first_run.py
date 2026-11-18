"""The first-run wizard's server side: ``setupDone``, ``PUT /api/server/setup``,
``GET /api/library/summary`` (docs/features/first-run.md)."""
import json

import pytest
from fastapi.testclient import TestClient

from app.infra import instance as nest_instance
from app.main import app

FRAME = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40


@pytest.fixture
def fresh(tmp_path, monkeypatch):
    config = app.state.config
    music = tmp_path / "Music"
    (music / "Daft Punk" / "Discovery").mkdir(parents=True)
    (music / "Daft Punk" / "Discovery" / "01.mp3").write_bytes(FRAME)
    (music / "Daft Punk" / "Homework").mkdir(parents=True)
    (music / "Daft Punk" / "Homework" / "01.mp3").write_bytes(FRAME)
    monkeypatch.setattr(config, "base_music_dir", music)
    monkeypatch.setattr(config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(config, "require_setup_token", False)
    monkeypatch.setattr(config, "api_token", None)
    app.state.container._services.pop("token_store", None)
    app.state.container.get_music_repository().invalidate_scan()
    nest_instance._name_cache.clear()
    yield tmp_path
    app.state.container._services.pop("token_store", None)


def status() -> dict:
    return TestClient(app).get("/api/status").json()


def claim() -> str:
    response = TestClient(app).post("/api/claim", json={"label": "Ana", "username": "ana",
                                                         "password": "una-contra-larga"})
    assert response.status_code in (200, 201), response.text
    return response.json()["token"]


def test_a_fresh_nest_is_not_set_up_and_a_claim_keeps_it_that_way(fresh):
    assert status()["setupDone"] is False
    claim()
    assert status()["isInit"] is True and status()["setupDone"] is False


def test_the_owner_finishes_the_wizard(fresh):
    token = claim()
    response = TestClient(app).put("/api/server/setup", json={"done": True},
                                   headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200 and response.json() == {"setupDone": True}
    assert status()["setupDone"] is True


def test_a_member_cannot_mark_it(fresh):
    claim()
    _, member = app.state.container.get_token_store().mint("Luz", username="luz")
    response = TestClient(app).put("/api/server/setup", json={"done": True},
                                   headers={"Authorization": f"Bearer {member}"})
    assert response.status_code == 403


def test_a_server_from_before_the_wizard_counts_as_set_up(fresh):
    claim()
    path = app.state.config.instance_file
    data = json.loads(path.read_text())
    data.pop("setupDone")
    path.write_text(json.dumps(data))
    assert status()["setupDone"] is True


def test_the_library_summary_counts_songs_albums_and_artists(fresh):
    token = claim()
    response = TestClient(app).get("/api/library/summary", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    body = response.json()
    assert body["songs"] == 2 and body["albums"] == 2 and body["folder"].endswith("Music")
