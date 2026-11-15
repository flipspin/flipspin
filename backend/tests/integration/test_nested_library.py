"""A library somebody already has: ``Artist/Album/song``, with disc folders.

The wire keeps its two segments (``/api/media/{album}/{file}``, ``relPath``);
a nested folder is folded into one segment with ``∕`` (U+2215). These tests
drive the real app against a real tree, so they prove that what the listing
hands out is what the media, cover and library routes accept.
"""
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import ROLE_MEMBER
from app.exceptions import ValidationError
from app.main import app
from app.utils.library_paths import NEST, rel_path_for, resolve_track

FRAME = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40  # a silent MP3 mutagen can read


@pytest.fixture
def library(tmp_path, monkeypatch):
    music = tmp_path / "Music"
    nested = music / "Daft Punk" / "Discovery"
    nested.mkdir(parents=True)
    (nested / "01 - One More Time.mp3").write_bytes(FRAME)
    (nested / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    for disc in ("CD1", "CD2"):
        (music / "Pink Floyd" / "The Wall" / disc).mkdir(parents=True)
        (music / "Pink Floyd" / "The Wall" / disc / "01.mp3").write_bytes(FRAME)
    (music / "Flat").mkdir()
    (music / "Flat" / "a.mp3").write_bytes(FRAME)

    monkeypatch.setattr(app.state.config, "base_music_dir", music)
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    for key in ("token_store", "user_track_store"):
        app.state.container._services.pop(key, None)
    yield music
    for key in ("token_store", "user_track_store"):
        app.state.container._services.pop(key, None)


def client() -> TestClient:
    return TestClient(app)


def listing() -> dict:
    response = client().get("/api/listar-albums-con-metadata", params={"covers": "false"})
    assert response.status_code == 200
    return {a["mediaKey"]: a for a in response.json()}


def test_every_album_is_listed_with_its_key(library):
    albums = listing()
    assert set(albums) == {f"Daft Punk{NEST}Discovery", f"Pink Floyd{NEST}The Wall", "Flat"}
    assert len(albums[f"Pink Floyd{NEST}The Wall"]["tracks"]) == 2


def test_a_flat_album_keeps_the_key_and_url_it_always_had(library):
    track = listing()["Flat"]["tracks"][0]
    assert track["url_path"] == "/api/media/Flat/a.mp3"


def test_every_url_the_listing_hands_out_streams(library):
    for album in listing().values():
        for track in album["tracks"]:
            album_key, file_key = track["url_path"].removeprefix("/api/media/").split("/")
            assert NEST not in track["url_path"].split("/")[-1] or file_key.startswith("CD")
            url = f"/api/media/{quote(album_key, safe='')}/{quote(file_key, safe='')}"
            response = client().get(url)
            assert response.status_code == 200, url
            assert response.content == FRAME


def test_a_disc_track_is_named_with_its_folder(library):
    tracks = listing()[f"Pink Floyd{NEST}The Wall"]["tracks"]
    assert [t["url_path"].split("/")[-1] for t in tracks] == [f"CD1{NEST}01.mp3", f"CD2{NEST}01.mp3"]


def test_a_nested_cover_is_served(library):
    key = quote(f"Daft Punk{NEST}Discovery", safe="")
    assert client().get(f"/api/media/{key}/cover.jpg").status_code == 200


@pytest.mark.parametrize("path", [
    "unicode/Literal∕Album/CD1/01∕song.mp3",
    "unicode/ Leading Album / 01 - Space.mp3",
])
def test_literal_names_in_nested_albums_stream_from_listing_with_cover(library, path):
    source = library / path
    source.parent.mkdir(parents=True)
    source.write_bytes(FRAME)
    album_dir = source.parent.parent if source.parent.name == "CD1" else source.parent
    cover = album_dir / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xd9")
    tracks = [(a, t) for a in listing().values() for t in a["tracks"] if t["path"] == str(source)]
    assert len(tracks) == 1
    album, track = tracks[0]
    album_key, file_key = track["url_path"].removeprefix("/api/media/").split("/")
    response = client().get(f"/api/media/{quote(album_key, safe='')}/{quote(file_key, safe='')}")
    assert response.status_code == 200
    assert response.content == FRAME
    response = client().get(f"/api/media/{quote(album['mediaKey'], safe='')}/cover.jpg")
    assert response.status_code == 200
    assert response.content == cover.read_bytes()


def test_a_key_cannot_climb_out_of_the_library(library):
    for album in (f"..{NEST}..", f"Daft Punk{NEST}..{NEST}.."):
        response = client().get(f"/api/media/{quote(album, safe='')}/{quote('x.mp3', safe='')}")
        assert response.status_code == 404
    with pytest.raises(ValidationError):
        resolve_track(library, f"..{NEST}..", "passwd")


def test_a_nested_song_can_be_in_my_library(library):
    _, token = app.state.container.get_token_store().mint("Ana", ROLE_MEMBER)
    remote = TestClient(app, client=("192.0.2.42", 51000))
    rel = rel_path_for(library, library / "Pink Floyd" / "The Wall" / "CD2" / "01.mp3")
    assert rel == f"Pink Floyd{NEST}The Wall/CD2{NEST}01.mp3"

    response = remote.post(
        "/api/me/library", json={"relPaths": [rel]}, headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code in (200, 201)
    assert response.json().get("missing") in ([], None)


@pytest.mark.parametrize("tagged", [False, True])
def test_root_songs_list_stream_with_range_and_survive_rescan(library, tagged):
    from mutagen.mp3 import MP3
    from mutagen.id3 import TALB, TIT2
    from app.utils.library_paths import ROOT_ALBUM_KEY

    # Warm the scan before files arrive, as on an empty first start.
    previous = listing()
    paths = [library / "Loose Song.mp3", library / "Another Song.mp3"]
    for source in paths:
        source.write_bytes(FRAME)
        if tagged:
            audio = MP3(source)
            audio.add_tags()
            audio.tags.add(TALB(encoding=3, text="Tagged Album"))
            audio.tags.add(TIT2(encoding=3, text=source.stem))
            audio.save()

    albums = listing()
    assert set(albums) == set(previous) | {ROOT_ALBUM_KEY}
    # Existing flat and nested album identities, including disc files, stay exact.
    for key in previous:
        assert [(t["relPath"], t["url_path"]) for t in albums[key]["tracks"]] == [
            (t["relPath"], t["url_path"]) for t in previous[key]["tracks"]
        ]
    root = albums[ROOT_ALBUM_KEY]
    assert root["album"] == ("Tagged Album" if tagged else "Loose songs")
    assert root["path"] == str(library)
    assert {t["path"] for t in root["tracks"]} == {str(p) for p in paths}
    for track in root["tracks"]:
        assert track["relPath"] == f"{ROOT_ALBUM_KEY}/{Path(track['path']).name}"
        assert track["url_path"].split("/")[-2:] == track["relPath"].split("/")
        data = Path(track["path"]).read_bytes()
        response = client().get(track["url_path"], headers={"Range": "bytes=0-99"})
        assert response.status_code == 206
        assert response.content == data[:100]
        assert response.headers["content-range"] == f"bytes 0-99/{len(data)}"

    repository = app.state.container.get_music_repository()
    repository.invalidate_scan()
    assert listing()[ROOT_ALBUM_KEY] == root
    service = app.state.container.get_music_service()
    root_album = service.get_album(ROOT_ALBUM_KEY)
    assert root_album.name == root["album"]
    assert {t.path for t in root_album.tracks} == set(paths)


def test_root_cover_waveform_and_personal_library_routes(library):
    from app.utils.library_paths import ROOT_ALBUM_KEY

    source = library / "Loose Song.mp3"
    source.write_bytes(FRAME)
    cover = library / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xd9")
    assert client().get(f"/api/media/{ROOT_ALBUM_KEY}/cover.jpg").content == cover.read_bytes()
    response = client().get(f"/api/waveform/{ROOT_ALBUM_KEY}/Loose%20Song.mp3?samples=100")
    assert response.status_code == 200
    assert len(response.json()["waveform"]) == 100
    assert response.json()["track"] == source.name

    _, token = app.state.container.get_token_store().mint("Library test", ROLE_MEMBER)
    response = client().post(
        "/api/me/library", json={"relPaths": [f"{ROOT_ALBUM_KEY}/{source.name}"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code in (200, 201)
    assert response.json().get("missing") in ([], None)


def test_root_album_does_not_absorb_disc_named_root_folders(library):
    from app.utils.library_paths import ROOT_ALBUM_KEY

    (library / "Loose Song.mp3").write_bytes(FRAME)
    (library / "CD1").mkdir()
    (library / "CD1" / "disc.mp3").write_bytes(FRAME)
    albums = listing()
    assert [t["relPath"] for t in albums["CD1"]["tracks"]] == ["CD1/disc.mp3"]
    service = app.state.container.get_music_service()
    assert [t.path.name for t in service.get_album(ROOT_ALBUM_KEY).tracks] == ["Loose Song.mp3"]
