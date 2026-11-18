"""Shared fixtures and builders for the subsonic behavior suites."""
import uuid

import pytest
from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TALB, TCON, TDRC, TIT2, TPE1, TPE2, TRCK

from app.domains.subsonic import auth as subsonic_auth
from app.main import app

FRAME = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40  # a silent MP3 mutagen can read


def _song(path, title, artist, album, number, year="2001", genre="Electronic"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(FRAME)
    tags = ID3()
    for frame in (TIT2(encoding=3, text=title), TPE1(encoding=3, text=artist), TPE2(encoding=3, text=artist),
                  TALB(encoding=3, text=album), TRCK(encoding=3, text=str(number)),
                  TDRC(encoding=3, text=year), TCON(encoding=3, text=genre)):
        tags.add(frame)
    tags.save(str(path))


@pytest.fixture
def nest(tmp_path, monkeypatch):
    music = tmp_path / "Music"
    _song(music / "Daft Punk" / "Discovery" / "01.mp3", "One More Time", "Daft Punk", "Discovery", 1)
    _song(music / "Daft Punk" / "Discovery" / "02.mp3", "Aerodynamic", "Daft Punk", "Discovery", 2)
    (music / "Daft Punk" / "Discovery" / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    _song(music / "Café Tacvba" / "Re" / "01.mp3", "El Aparato", "Café Tacvba", "Re", 1, "1994", "Rock")

    config = app.state.config
    monkeypatch.setattr(config, "base_music_dir", music)
    monkeypatch.setattr(config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(config, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(config, "jobs_file", tmp_path / "jobs.sqlite")
    monkeypatch.setattr(config, "credentials_dir", tmp_path / "credentials")
    monkeypatch.setattr(config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(config, "api_token", None)
    services = app.state.container._services
    for key in ("token_store", "user_track_store", "credentials_repository"):
        services.pop(key, None)
    repo = app.state.container.get_music_repository()
    repo.invalidate_scan()
    subsonic_auth.throttle.reset()

    store = app.state.container.get_token_store()
    _, owner_token = store.claim_first_owner("Ana", username="ana", password="una-contra-larga")
    client = TestClient(app)
    minted = client.post("/api/me/devices/app-password", json={"label": "Symfonium"},
                         headers={"Authorization": f"Bearer {owner_token}"})
    assert minted.status_code == 201, minted.text
    yield {"client": client, "owner_token": owner_token, "app_password": minted.json()["token"],
           "device": minted.json()["device"], "music": music}
    for key in ("token_store", "user_track_store", "credentials_repository"):
        services.pop(key, None)


def call(nest, method, fmt="json", auth=True, **params):
    if auth:
        params.setdefault("u", "ana")
        params.setdefault("p", nest["app_password"])
    if fmt:
        params["f"] = fmt
    params.update(v="1.16.1", c="test")
    return nest["client"].get(f"/rest/{method}", params=params)


def body(response):
    assert response.status_code == 200
    return response.json()["subsonic-response"]


def ok(response):
    data = body(response)
    assert data["status"] == "ok", data
    return data


def failed(response, code):
    data = body(response)
    assert data["status"] == "failed" and data["error"]["code"] == code, data
    return data




def mint_api_key(nest, token=None, **extra):
    response = nest["client"].post(
        "/api/me/devices/api-key", json={"label": "Crossonic", **extra},
        headers={"Authorization": f"Bearer {token or nest['owner_token']}"},
    )
    assert response.status_code == 201, response.text
    return response.json()




def _artists(nest):
    data = ok(call(nest, "getArtists"))
    return {a["name"]: a for index in data["artists"]["index"] for a in index["artist"]}






def _song_ids(nest):
    return [s["id"] for s in ok(call(nest, "search3", query="", songCount="10"))["searchResult3"]["song"]]






@pytest.fixture(params=["app-password", "apiKey"])
def scoped_nest(nest, request):
    """One visible song, a hidden sibling, album and artist; both auth paths."""
    from app.domains.subsonic.library import INDEX
    from app.utils.library_paths import rel_path_for

    music = nest["music"]
    _song(music / "Daft Punk" / "Homework" / "01.mp3", "Around the World", "Daft Punk", "Homework", 1,
          genre="House")
    (music / "Daft Punk" / "Homework" / "cover.jpg").write_bytes(b"homework-cover")
    (music / "Café Tacvba" / "Re" / "cover.jpg").write_bytes(b"re-cover")
    container = app.state.container
    repo = container.get_music_repository()
    repo.invalidate_scan()
    shared = INDEX.get(repo)
    member, token = container.get_token_store().mint("Bea", username="bea")
    minted = nest["client"].post("/api/me/devices/app-password", json={"label": "Subsonic"},
                                 headers={"Authorization": f"Bearer {token}"})
    assert minted.status_code == 201, minted.text
    allowed_path = rel_path_for(music, music / "Daft Punk" / "Discovery" / "01.mp3")
    container.get_user_track_store().add_many(member.user_id, [allowed_path])

    def request_as(method, owner=False, fmt="json", **params):
        if request.param == "apiKey":
            params["apiKey"] = nest["owner_token"] if owner else token
        else:
            params.update(u="ana" if owner else "bea",
                          p=nest["app_password"] if owner else minted.json()["token"])
        return call(nest, method, auth=False, fmt=fmt, **params)

    yield {**nest, "ask": request_as, "member": member, "shared": shared,
           "allowed": shared.by_rel_path[allowed_path],
           "hidden_song": next(s for s in shared.songs.values() if s.track.title == "Aerodynamic"),
           "hidden_album": next(a for a in shared.albums.values() if a.album.name == "Homework"),
           "hidden_artist": next(a for a in shared.artists.values() if a.name == "Café Tacvba")}




@pytest.fixture
def cover_playlists(nest, tmp_path, monkeypatch):
    from app.domains.music.covers import CoverCache
    from app.domains.playlists.models import PlaylistTrack
    from app.domains.subsonic import ids

    container = app.state.container
    cache = CoverCache(tmp_path / "cache" / "covers", 1024 * 1024)
    monkeypatch.setitem(container._services, "cover_cache", cache)
    service = container.get_playlist_service()
    paths = []
    colors = [(240, 20, 20), (20, 240, 20), (20, 20, 240), (240, 240, 20), (20, 240, 240)]
    for i, color in enumerate(colors):
        path = nest["music"] / "Artist" / f"Album {i}" / "CD1" / "01.mp3"
        _song(path, f"Song {i}", "Artist", f"Album {i}", 1)
        # A non-square image, recognizable by contents without an image library.
        (path.parent.parent / "cover.jpg").write_bytes(b"P6\n8 6\n255\n" + bytes(color) * 48)
        paths.append(path)
    uncovered = nest["music"] / "Artist" / "No cover" / "01.mp3"
    _song(uncovered, "Uncovered", "Artist", "No cover", 1)
    outside = tmp_path / "Outside" / "01.mp3"
    _song(outside, "Outside", "Artist", "Outside", 1)
    container.get_music_repository().invalidate_scan()
    playlists = {}
    suffix = uuid.uuid4().hex[:8]
    for name, tracks in {
        "Tile": [uncovered, paths[2], paths[2], paths[0], paths[3], paths[1], paths[4]],
        "Single": paths[:1], "Pair": paths[:2], "Triple": paths[:3],
        "Empty": [], "Uncovered": [uncovered], "Outside": [outside],
        "Mixed": [outside, nest["music"] / "Missing" / "01.mp3", paths[0]],
    }.items():
        playlist = service.create_playlist(f"{name} {suffix}")
        playlist.tracks = [PlaylistTrack(path=p, title=p.stem) for p in tracks]
        # Persist stale/external paths too, as old playlist files can contain them.
        service.playlist_repo.save_playlist(playlist)
        playlists[name] = ids.make(ids.PLAYLIST, playlist.name)
    return {**nest, "playlists": playlists, "paths": paths, "cache": cache}


def _jpeg_size(data):
    assert data[:2] == b"\xff\xd8"
    pos = 2
    while pos < len(data):
        assert data[pos] == 0xff
        marker = data[pos + 1]
        length = int.from_bytes(data[pos + 2:pos + 4], "big")
        if marker in (0xc0, 0xc1, 0xc2):
            return (int.from_bytes(data[pos + 7:pos + 9], "big"),
                    int.from_bytes(data[pos + 5:pos + 7], "big"))
        pos += 2 + length
    raise AssertionError("No JPEG size marker")
