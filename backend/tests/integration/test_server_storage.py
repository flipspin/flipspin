"""``GET /api/server/storage`` and the cached tree walk behind it.

* Owner-only: a member gets 403, no credential 401.
* ``music`` and ``stems`` are the bytes under the library and the stems dir,
  ``other`` is used − music − stems floored at 0, ``disk`` is the data disk.
* A sum is cached ~5 min, so a file added inside the window does not move it.
"""
from collections import namedtuple

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.domains.system import storage
from app.main import app

STORAGE = "/api/server/storage"
Usage = namedtuple("Usage", "total used free")


@pytest.fixture
def fresh(tmp_path, monkeypatch):
    music = tmp_path / "Krobi" / "Music"
    stems = tmp_path / "Krobi" / "stems"
    playlists = tmp_path / "Krobi" / "playlists"
    for d in (music / "Album", stems / "Album" / "song.mp3", playlists):
        d.mkdir(parents=True)
    (music / "Album" / "a.mp3").write_bytes(b"x" * 1000)
    (music / "Album" / "b.mp3").write_bytes(b"x" * 500)
    (stems / "Album" / "song.mp3" / "drums.ogg").write_bytes(b"x" * 200)
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    monkeypatch.setattr(app.state.config, "base_music_dir", music)
    monkeypatch.setattr(app.state.config, "playlist_dir", playlists)
    monkeypatch.setattr(app.state.config, "stems_dir", stems)
    seen = []

    def fake_usage(path):
        seen.append(path)
        return Usage(total=100_000, used=60_000, free=40_000)

    monkeypatch.setattr(storage.shutil, "disk_usage", fake_usage)
    app.state.container._services.pop("token_store", None)
    storage.clear_cache()
    yield {"music": music, "stems": stems, "data": tmp_path / "Krobi", "seen": seen}
    app.state.container._services.pop("token_store", None)
    storage.clear_cache()


def store():
    return app.state.container.get_token_store()


def remote() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestRoute:
    def test_the_body(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote().get(STORAGE, headers=bearer(token))
        assert response.status_code == 200
        assert response.json() == {
            "disk": {"total": 100_000, "free": 40_000},
            "music": 1500,
            "stems": 200,
            "other": 60_000 - 1500 - 200,
        }
        assert fresh["seen"] == [fresh["data"]]

    def test_other_is_floored_at_zero(self, fresh, monkeypatch):
        monkeypatch.setattr(storage.shutil, "disk_usage", lambda _p: Usage(total=1000, used=100, free=900))
        _, token = store().mint("Robin", ROLE_OWNER)
        assert remote().get(STORAGE, headers=bearer(token)).json()["other"] == 0

    def test_no_stems_yet_is_zero(self, fresh, monkeypatch, tmp_path):
        monkeypatch.setattr(app.state.config, "stems_dir", tmp_path / "nowhere")
        _, token = store().mint("Robin", ROLE_OWNER)
        assert remote().get(STORAGE, headers=bearer(token)).json()["stems"] == 0

    def test_a_member_is_refused(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        _, token = store().mint("Ana", ROLE_MEMBER)
        assert remote().get(STORAGE, headers=bearer(token)).status_code == 403

    def test_no_credential_is_refused(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        assert remote().get(STORAGE).status_code == 401

    def test_sums_are_cached(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        assert remote().get(STORAGE, headers=bearer(token)).json()["music"] == 1500
        (fresh["music"] / "Album" / "c.mp3").write_bytes(b"x" * 300)
        assert remote().get(STORAGE, headers=bearer(token)).json()["music"] == 1500
        storage.clear_cache()
        assert remote().get(STORAGE, headers=bearer(token)).json()["music"] == 1800


class TestCache:
    def test_expires_after_the_ttl(self, tmp_path):
        clock = [0.0]
        calls = []

        def measure(path):
            calls.append(path)
            return len(calls)

        storage.clear_cache()
        assert storage.cached_tree_size(tmp_path, now=lambda: clock[0], measure=measure) == 1
        clock[0] = storage.TTL_SECONDS - 1
        assert storage.cached_tree_size(tmp_path, now=lambda: clock[0], measure=measure) == 1
        clock[0] = storage.TTL_SECONDS + 1
        assert storage.cached_tree_size(tmp_path, now=lambda: clock[0], measure=measure) == 2
        storage.clear_cache()

    def test_symlinks_are_not_followed(self, tmp_path):
        (tmp_path / "real").mkdir()
        (tmp_path / "real" / "f").write_bytes(b"x" * 10)
        (tmp_path / "link").symlink_to(tmp_path / "real")
        assert storage.tree_size(tmp_path) == 10
