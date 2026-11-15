"""Real isolated household used by account-deletion and wire checks."""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def deletion_house(tmp_path, monkeypatch):
    config = app.state.config
    for attr, name in (
        ("base_music_dir", "Music"), ("playlist_dir", "playlists"),
        ("users_file", "users.json"), ("user_tracks_file", "user_tracks.json"),
        ("lyrics_file", "lyrics.json"), ("stems_dir", "stems"), ("temp_dir", "temp"),
    ):
        monkeypatch.setattr(config, attr, tmp_path / name)
    for path in (config.base_music_dir, config.playlist_dir, config.temp_dir):
        path.mkdir()
    monkeypatch.setattr(config, "api_token", None)
    monkeypatch.setattr(config, "allow_unauthenticated_remote", False)
    container = app.state.container
    monkeypatch.setattr(container, "_services", {})
    monkeypatch.setattr(container, "_repositories", {})
    accounts = container.get_token_store()
    owner, owner_token = accounts.mint("Robin", "owner")
    member, member_token = accounts.mint("Ana", "member")
    accounts.add_device(member.user_id, "Phone")
    owner_client = TestClient(app, client=("192.0.2.42", 51000))
    owner_client.headers["Authorization"] = f"Bearer {owner_token}"
    member_client = TestClient(app, client=("192.0.2.43", 51000))
    member_client.headers["Authorization"] = f"Bearer {member_token}"
    # Authentication's normal first-use lastSeenAt write precedes read-only
    # assertions; preview/refusal must not otherwise mutate household data.
    assert owner_client.get("/api/me").status_code == 200
    assert member_client.get("/api/me").status_code == 200
    tracks = container.get_user_track_store()
    album = config.base_music_dir / "Album"
    album.mkdir()
    for name, content in (("exclusive", b"1234567"), ("shared", b"12345"),
                          ("hit", b"123"), ("manual", b"12")):
        (album / f"{name}.mp3").write_bytes(content)
    tracks.add_many(member.user_id, [f"Album/{n}.mp3" for n in ("exclusive", "shared", "missing")], acquired=True)
    tracks.add_many(member.user_id, ["Album/hit.mp3", "Album/manual.mp3"])
    tracks.add_many(owner.user_id, ["Album/shared.mp3"])
    # Orphan/sentinel references cannot keep a file on behalf of a real person.
    tracks.add_many("deleted-account", ["Album/exclusive.mp3"])
    tracks.add_many("local", ["Album/exclusive.mp3"])
    playlist = config.playlist_dir / "Ana.json"
    playlist.write_text(json.dumps({"name": "Ana", "owner": member.user_id, "tracks": [],
                                    "created": 123.0, "modified": 456.0}))
    other_playlist = config.playlist_dir / "Robin.json"
    other_playlist.write_text(json.dumps({"name": "Robin", "owner": owner.user_id, "tracks": []}))
    yield SimpleNamespace(
        root=tmp_path, config=config, container=container, accounts=accounts,
        owner=owner, member=member, admin=owner_client, client=member_client,
        tracks=tracks, album=album, playlist=playlist, other_playlist=other_playlist,
        url=f"/api/users/{member.user_id}",
    )
