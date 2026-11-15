"""Subsonic member visibility and account-scoped operations."""
import uuid

from app.main import app
from tests.integration import test_subsonic as fixtures
from tests.integration.test_subsonic import failed, ok

nest = fixtures.nest
scoped_nest = fixtures.scoped_nest


def test_member_listings_recompute_the_library_and_leave_owner_unchanged(scoped_nest):
    n = scoped_nest
    ask, song = n["ask"], n["allowed"]
    album, artist_id = song.album, song.album.artist_id
    methods = [
        ("getIndexes", {}), ("getArtists", {}),
        ("getArtist", {"id": artist_id}), ("getAlbum", {"id": album.id}),
        ("getMusicDirectory", {"id": artist_id}), ("getMusicDirectory", {"id": album.id}),
        ("getGenres", {}), ("getAlbumList", {"type": "alphabeticalByName"}),
        ("getAlbumList2", {"type": "alphabeticalByName"}), ("getRandomSongs", {}),
        ("getSongsByGenre", {"genre": "Electronic"}),
        ("search2", {"query": ""}), ("search3", {"query": ""}),
    ]
    owner_before = [ok(ask(method, owner=True, **params)) for method, params in methods if method != "getRandomSongs"]
    for method, key in [("getIndexes", "indexes"), ("getArtists", "artists")]:
        indexes = ok(ask(method))[key]["index"]
        artists = [a for index in indexes for a in index["artist"]]
        assert [(a["id"], a["albumCount"]) for a in artists] == [(artist_id, 1)]
    member_album = ok(ask("getAlbum", id=album.id))["album"]
    assert member_album["songCount"] == 1
    assert member_album["duration"] == int(song.track.duration or 0)
    assert member_album["duration"] < int(album.album.total_duration)
    assert [s["id"] for s in member_album["song"]] == [song.id]
    assert ok(ask("getSong", id=song.id))["song"]["id"] == song.id
    artist = ok(ask("getArtist", id=artist_id))["artist"]
    assert artist["albumCount"] == 1 and [a["id"] for a in artist["album"]] == [album.id]
    assert [a["id"] for a in ok(ask("getMusicDirectory", id=artist_id))["directory"]["child"]] == [album.id]
    assert [s["id"] for s in ok(ask("getMusicDirectory", id=album.id))["directory"]["child"]] == [song.id]
    assert ok(ask("getGenres"))["genres"]["genre"] == [
        {"value": "Electronic", "songCount": 1, "albumCount": 1}]
    for method, key in [("getAlbumList", "albumList"), ("getAlbumList2", "albumList2")]:
        listed = ok(ask(method, type="alphabeticalByName"))[key]["album"]
        assert [(a["id"], a["songCount"], a["duration"]) for a in listed] == [
            (album.id, 1, int(song.track.duration or 0))]
        assert ok(ask(method, type="byGenre", genre="House"))[key]["album"] == []
    for method, key in [("getRandomSongs", "randomSongs"), ("getSongsByGenre", "songsByGenre")]:
        assert [s["id"] for s in ok(ask(method, genre="Electronic"))[key]["song"]] == [song.id]
        assert ok(ask(method, genre="House"))[key]["song"] == []
    for method, key in [("search2", "searchResult2"), ("search3", "searchResult3")]:
        result = ok(ask(method, query=""))[key]
        assert [s["id"] for s in result["song"]] == [song.id]
        assert [a["id"] for a in result["album"]] == [album.id]
        assert [a["id"] for a in result["artist"]] == [artist_id]
        for query in ("Aerodynamic", "Homework", "Café Tacvba"):
            assert ok(ask(method, query=query))[key] == {"song": [], "album": [], "artist": []}
    assert [ok(ask(method, owner=True, **params)) for method, params in methods
            if method != "getRandomSongs"] == owner_before
    assert len(ok(ask("getRandomSongs", owner=True))["randomSongs"]["song"]) == 4
    assert len(n["shared"].songs) == 4 and len(album.songs) == 2
    assert ask("stream", id=song.id).content == song.track.path.read_bytes()
    assert ask("getCoverArt", id=artist_id).content == b"\xff\xd8\xff"


def test_member_outside_ids_are_exactly_unknown_ids(scoped_nest):
    from app.domains.subsonic import ids

    n = scoped_nest
    ask = n["ask"]
    hidden = {ids.SONG: n["hidden_song"].id, ids.ALBUM: n["hidden_album"].id,
              ids.ARTIST: n["hidden_artist"].id}
    cases = [(m, ids.SONG) for m in ("getSong", "stream", "download", "getLyricsBySongId", "scrobble")]
    cases += [(m, ids.ALBUM) for m in ("getAlbum", "getMusicDirectory", "getAlbumInfo", "getAlbumInfo2")]
    cases += [(m, ids.ARTIST) for m in ("getArtist", "getMusicDirectory", "getArtistInfo", "getArtistInfo2")]
    cases += [(m, kind) for m in ("getCoverArt", "star", "unstar") for kind in hidden]
    for method, kind in cases:
        outside = ask(method, id=hidden[kind])
        missing = ask(method, id=ids.make(kind, "missing"))
        failed(outside, 70)
        assert (outside.status_code, outside.content) == (missing.status_code, missing.content), method
    assert ok(ask("getLyrics", title="Aerodynamic", artist="Daft Punk")) == ok(
        ask("getLyrics", title="missing", artist="missing"))
    assert ask("stream", owner=True, id=hidden[ids.SONG]).content == n["hidden_song"].track.path.read_bytes()
    for value in hidden.values():
        assert ask("getCoverArt", owner=True, id=value).status_code == 200
    assert app.state.container.get_user_track_store().get(n["member"].user_id, n["hidden_song"].rel_path) is None


def test_member_stars_and_scrobbles_stay_in_scope(scoped_nest):
    n = scoped_nest
    ask, song = n["ask"], n["allowed"]
    stars = app.state.container.get_star_store()
    stars.set(n["member"].user_id, [n["hidden_album"].id, n["hidden_artist"].id], True)
    ok(ask("star", id=song.id, albumId=song.album.id, artistId=song.album.artist_id))
    ok(ask("scrobble", id=song.id))
    for method, key in [("getStarred", "starred"), ("getStarred2", "starred2")]:
        result = ok(ask(method))[key]
        assert [s["id"] for s in result["song"]] == [song.id]
        assert result["song"][0]["playCount"] == 1
        assert [a["id"] for a in result["album"]] == [song.album.id]
        assert [a["id"] for a in result["artist"]] == [song.album.artist_id]
    ok(ask("unstar", id=song.id))
    assert ok(ask("getStarred2"))["starred2"]["song"] == []


def test_member_lyrics_only_read_visible_songs(scoped_nest, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from app.domains.subsonic import routes

    lyrics = Mock(return_value=SimpleNamespace(text="[00:01.00]Visible words", record=SimpleNamespace(kind="synced")))
    monkeypatch.setattr(routes, "_lyric_for", lyrics)
    n = scoped_nest
    ask, song = n["ask"], n["allowed"]
    assert ok(ask("getLyrics", title=song.track.title, artist=song.track.artist))["lyrics"]["value"] == "Visible words"
    lyrics.return_value.text = "[offset:+500]\n[00:01.00]Visible words"
    structured = ok(ask("getLyricsBySongId", id=song.id))["lyricsList"]["structuredLyrics"]
    assert structured[0]["offset"] == 500
    assert structured[0]["line"] == [{"start": 1000, "value": "Visible words"}]
    lyrics.return_value.text = "[00:01.00]Visible words"
    lyrics.reset_mock()
    assert ok(ask("getLyrics", title=n["hidden_song"].track.title))["lyrics"] == {}
    failed(ask("getLyricsBySongId", id=n["hidden_song"].id), 70)
    lyrics.assert_not_called()
    assert ok(ask("getLyrics", owner=True, title=n["hidden_song"].track.title))["lyrics"]["value"] == "Visible words"


def test_member_playlists_skip_hidden_songs_and_reject_outside_additions(scoped_nest):
    from app.domains.subsonic import ids

    n = scoped_nest
    ask, song = n["ask"], n["allowed"]
    service = app.state.container.get_playlist_service()
    name = f"Scoped {uuid.uuid4().hex[:8]}"
    service.create_playlist(name, owner_id=n["member"].user_id)
    paths = [n["hidden_song"].track.path, song.track.path, n["hidden_album"].songs[0].track.path]
    service.add_tracks(name, paths)
    playlist_id = ids.make(ids.PLAYLIST, name)
    detail = ok(ask("getPlaylist", id=playlist_id))["playlist"]
    assert detail["songCount"] == 1 and detail["duration"] == int(song.track.duration or 0)
    assert [s["id"] for s in detail["entry"]] == [song.id]
    assert next(p for p in ok(ask("getPlaylists"))["playlists"]["playlist"]
                if p["id"] == playlist_id)["songCount"] == 1
    assert ok(ask("getPlaylist", owner=True, id=playlist_id))["playlist"]["songCount"] == 3
    for method, params in [("createPlaylist", {"name": name + " new", "songId": n["hidden_song"].id}),
                           ("createPlaylist", {"playlistId": playlist_id, "songId": n["hidden_song"].id}),
                           ("updatePlaylist", {"playlistId": playlist_id, "songIdToAdd": n["hidden_song"].id,
                                               "songIndexToRemove": "0"})]:
        outside = ask(method, **params)
        missing_params = {k: ids.make(ids.SONG, "missing") if k in ("songId", "songIdToAdd") else v
                          for k, v in params.items()}
        failed(outside, 70)
        assert outside.content == ask(method, **missing_params).content
        assert [t.path for t in service.get_playlist(name).tracks] == paths
    assert ask("getCoverArt", id=playlist_id).content == b"\xff\xd8\xff"
    ok(ask("updatePlaylist", playlistId=playlist_id, songIndexToRemove="0"))
    assert [t.path for t in service.get_playlist(name).tracks] == [paths[0], paths[2]]
    assert ok(ask("getPlaylist", id=playlist_id))["playlist"]["entry"] == []
    assert ask("getCoverArt", owner=True, id=playlist_id).content == b"\xff\xd8\xff"
    outside = ask("getCoverArt", id=playlist_id)
    failed(outside, 70)
    assert outside.content == ask("getCoverArt", id=ids.make(ids.PLAYLIST, "missing")).content
    ok(ask("updatePlaylist", playlistId=playlist_id, songIdToAdd=song.id))
    assert ok(ask("getPlaylist", id=playlist_id))["playlist"]["songCount"] == 1
    created = ok(ask("createPlaylist", name=name + " new", songId=song.id))["playlist"]
    assert [s["id"] for s in created["entry"]] == [song.id]
    ok(ask("deletePlaylist", id=created["id"]))
    ok(ask("deletePlaylist", id=playlist_id))


def test_member_view_is_cached_between_requests_and_refreshed_on_membership(scoped_nest, monkeypatch):
    from unittest.mock import Mock

    from app.domains.subsonic import library

    n = scoped_nest
    view = Mock(wraps=library.filtered_library)
    get_index = Mock(wraps=library.INDEX.get)
    monkeypatch.setattr(library, "filtered_library", view)
    monkeypatch.setattr(library.INDEX, "get", get_index)
    monkeypatch.setattr(library, "build", Mock(side_effect=AssertionError("index was rebuilt")))
    # Hold the memoized scan stable: unrelated background audio analysis may
    # invalidate the repository's cache while these endpoint assertions run.
    scan = Mock(return_value=library.INDEX._albums)
    monkeypatch.setattr(app.state.container.get_music_repository(), "scan_albums", scan)
    album_id = n["allowed"].album.id
    assert ok(n["ask"]("getAlbum", id=album_id))["album"]["songCount"] == 1
    assert view.call_count == get_index.call_count == scan.call_count == 1
    for _ in range(10):
        assert ok(n["ask"]("getAlbum", id=album_id))["album"]["songCount"] == 1
    assert view.call_count == 1
    assert get_index.call_count == scan.call_count == 11
    store = app.state.container.get_user_track_store()
    store.add_many(n["member"].user_id, [n["hidden_song"].rel_path])
    assert ok(n["ask"]("getAlbum", id=album_id))["album"]["songCount"] == 2
    assert view.call_count == 2
    assert get_index.call_count == scan.call_count == 12
    assert len(n["shared"].songs) == 4
    store.remove_many(n["member"].user_id, [n["allowed"].rel_path, n["hidden_song"].rel_path])
    assert ok(n["ask"]("search3", query=""))["searchResult3"] == {"artist": [], "album": [], "song": []}


def test_member_scan_methods_are_harmless_and_only_count_visible_songs(scoped_nest, monkeypatch):
    from unittest.mock import Mock

    invalidate = Mock()
    monkeypatch.setattr(app.state.container.get_music_repository(), "invalidate_scan", invalidate)
    ask = scoped_nest["ask"]
    for method in ("getScanStatus", "startScan"):
        assert ok(ask(method))["scanStatus"] == {"scanning": False, "count": 1}
    invalidate.assert_not_called()
    assert ok(ask("startScan", owner=True))["scanStatus"] == {"scanning": False, "count": 4}
    invalidate.assert_called_once_with()


def test_member_cannot_fetch_another_members_playlist_cover(scoped_nest):
    from app.domains.subsonic import ids

    n = scoped_nest
    store = app.state.container.get_token_store()
    other, _ = store.mint("Other member", username="other-member")
    service = app.state.container.get_playlist_service()
    name = f"Other cover {uuid.uuid4().hex[:8]}"
    service.create_playlist(name, owner_id=other.user_id)
    service.add_tracks(name, [n["allowed"].track.path])
    playlist_id = ids.make(ids.PLAYLIST, name)
    # Even an album in the caller's own library cannot bypass playlist ownership.
    failed(n["ask"]("getCoverArt", id=playlist_id), 70)
    assert n["ask"]("getCoverArt", owner=True, id=playlist_id).content == b"\xff\xd8\xff"
