"""Subsonic playlist writes, artwork, and cache invalidation."""
import uuid

import pytest

from app.main import app
from tests.integration import test_subsonic as fixtures
from tests.integration.test_subsonic import _jpeg_size, _song_ids, call, failed, ok

nest = fixtures.nest
scoped_nest = fixtures.scoped_nest
cover_playlists = fixtures.cover_playlists


def test_playlist_round_trip(nest):
    name = f"Viaje {uuid.uuid4().hex[:6]}"
    songs = _song_ids(nest)
    created = ok(call(nest, "createPlaylist", name=name, songId=songs[:2]))["playlist"]
    assert created["songCount"] == 2 and created["owner"] == "ana"
    listed = [p["name"] for p in ok(call(nest, "getPlaylists"))["playlists"]["playlist"]]
    assert name in listed
    ok(call(nest, "updatePlaylist", playlistId=created["id"], songIdToAdd=songs[2], songIndexToRemove="0"))
    entries = ok(call(nest, "getPlaylist", id=created["id"]))["playlist"]["entry"]
    assert [e["id"] for e in entries] == [songs[1], songs[2]]
    ok(call(nest, "deletePlaylist", id=created["id"]))
    failed(call(nest, "getPlaylist", id=created["id"]), 70)


def test_a_normal_account_cannot_open_anothers_playlist(nest):
    name = f"Mía {uuid.uuid4().hex[:6]}"
    playlist = ok(call(nest, "createPlaylist", name=name))["playlist"]
    store = app.state.container.get_token_store()
    _, member_token = store.mint("Luz", username="luz")
    response = nest["client"].get("/rest/getPlaylist", params={"apiKey": member_token, "id": playlist["id"], "f": "json"})
    failed(response, 50)


def test_every_nested_playlist_advertises_its_own_cover_and_skips_unresolved_songs(cover_playlists):
    n = cover_playlists
    listed = {p["id"]: p for p in ok(call(n, "getPlaylists"))["playlists"]["playlist"]}
    for name, playlist_id in n["playlists"].items():
        detail = ok(call(n, "getPlaylist", id=playlist_id))["playlist"]
        for playlist in (listed[playlist_id], detail):
            if name in ("Empty", "Uncovered", "Outside"):
                assert "coverArt" not in playlist
            else:
                assert playlist["coverArt"] == playlist["id"] == playlist_id
    assert listed[n["playlists"]["Outside"]]["songCount"] == 0
    assert listed[n["playlists"]["Mixed"]]["songCount"] == 1


@pytest.mark.parametrize("name", ["Single", "Pair", "Triple", "Mixed"])
def test_small_playlists_serve_the_first_cover_unchanged(cover_playlists, name):
    n = cover_playlists
    response = call(n, "getCoverArt", id=n["playlists"][name], size="120")
    assert response.content == (n["paths"][0].parent.parent / "cover.jpg").read_bytes()


@pytest.mark.parametrize("name", ["Empty", "Uncovered", "Outside"])
def test_playlists_without_resolved_covers_return_not_found(cover_playlists, name):
    failed(call(cover_playlists, "getCoverArt", id=cover_playlists["playlists"][name]), 70)


@pytest.mark.parametrize("size", [120, 121, None])
def test_playlist_tile_dimensions_order_and_disk_cache(cover_playlists, monkeypatch, size):
    import subprocess
    from unittest.mock import Mock

    from app.domains.music.covers import CoverCache
    from app.infra.ffmpeg import resolve_ffmpeg

    n = cover_playlists
    render = Mock(wraps=CoverCache._mosaic)
    monkeypatch.setattr(n["cache"], "_mosaic", render)
    params = {"size": str(size)} if size else {}
    response = call(n, "getCoverArt", id=n["playlists"]["Tile"], **params)
    expected = size or 600
    assert response.headers["content-type"] == "image/jpeg"
    assert _jpeg_size(response.content) == (expected, expected)
    again = call(n, "getCoverArt", id=n["playlists"]["Tile"], **params)
    assert again.content == response.content
    assert render.call_count == 1
    assert not n["cache"]._active
    # A fresh cache instance must also hit disk without invoking ffmpeg.
    fresh = CoverCache(n["cache"].directory, n["cache"].max_bytes)
    monkeypatch.setitem(app.state.container._services, "cover_cache", fresh)
    monkeypatch.setattr(fresh, "_mosaic", Mock(side_effect=AssertionError("disk cache missed")))
    assert call(n, "getCoverArt", id=n["playlists"]["Tile"], **params).content == response.content
    rgb = subprocess.run(
        [resolve_ffmpeg(), "-v", "error", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        input=response.content, capture_output=True, check=True, timeout=15,
    ).stdout
    # Track order selects blue, red, yellow, green, skipping duplicate/coverless albums.
    for (x, y), color in zip([(1, 1), (3, 1), (1, 3), (3, 3)],
                             [(20, 20, 240), (240, 20, 20), (240, 240, 20), (20, 240, 20)], strict=True):
        offset = ((y * expected // 4) * expected + x * expected // 4) * 3
        assert all(abs(a - b) < 12 for a, b in zip(rgb[offset:offset + 3], color, strict=True))


def test_playlist_edit_cover_revision_and_size_invalidate_the_tile(cover_playlists, monkeypatch):
    from unittest.mock import Mock

    from app.domains.music.covers import CoverCache
    from app.domains.subsonic import ids

    n = cover_playlists
    render = Mock(wraps=CoverCache._mosaic)
    monkeypatch.setattr(n["cache"], "_mosaic", render)
    playlist_id = n["playlists"]["Tile"]
    first = call(n, "getCoverArt", id=playlist_id, size="120")
    other_size = call(n, "getCoverArt", id=playlist_id, size="122")
    assert _jpeg_size(other_size.content) == (122, 122)
    service = app.state.container.get_playlist_service()
    service.replace_tracks(ids.parse(playlist_id)[1], n["paths"][1:])
    edited = call(n, "getCoverArt", id=playlist_id, size="120")
    cover = n["paths"][1].parent.parent / "cover.jpg"
    cover.write_bytes(b"P6\n8 6\n255\n" + bytes((80, 80, 80)) * 48)
    updated = call(n, "getCoverArt", id=playlist_id, size="120")
    assert len({r.headers["etag"] for r in (first, other_size, edited, updated)}) == 4
    assert render.call_count == 4


def test_ffmpeg_failure_returns_first_cover_and_logs_once(cover_playlists, monkeypatch, caplog):
    import subprocess
    from unittest.mock import Mock

    n = cover_playlists
    render = Mock(side_effect=subprocess.CalledProcessError(1, "ffmpeg"))
    monkeypatch.setattr(n["cache"], "_mosaic", render)
    for size in (120, 120, 122):
        response = call(n, "getCoverArt", id=n["playlists"]["Tile"], size=str(size))
        assert response.content == (n["paths"][2].parent.parent / "cover.jpg").read_bytes()
    assert render.call_count == 1
    assert len([r for r in caplog.records if "serving original" in r.message]) == 1
