"""Subsonic catalog navigation, search, and metadata."""
from app.main import app
from tests.integration import test_subsonic as fixtures
from tests.integration.test_subsonic import _artists, call, failed, ok

nest = fixtures.nest


def test_artists_albums_and_songs_resolve_by_id(nest):
    artists = _artists(nest)
    assert artists["Daft Punk"]["albumCount"] == 1
    artist = ok(call(nest, "getArtist", id=artists["Daft Punk"]["id"]))["artist"]
    album = ok(call(nest, "getAlbum", id=artist["album"][0]["id"]))["album"]
    assert album["name"] == "Discovery" and album["songCount"] == 2 and album["year"] == 2001
    assert [s["title"] for s in album["song"]] == ["One More Time", "Aerodynamic"]
    song = ok(call(nest, "getSong", id=album["song"][0]["id"]))["song"]
    assert song["albumId"] == album["id"] and song["artistId"] == artist["id"]
    assert song["suffix"] == "mp3" and song["path"] == "Daft Punk/Discovery/01.mp3"


def test_an_unknown_id_is_not_found(nest):
    failed(call(nest, "getAlbum", id="al-bm9wZQ"), 70)
    failed(call(nest, "getAlbum", id="garbage"), 70)


def test_folder_browsing_for_older_clients(nest):
    artist_id = _artists(nest)["Daft Punk"]["id"]
    directory = ok(call(nest, "getMusicDirectory", id=artist_id))["directory"]
    album = directory["child"][0]
    assert album["isDir"] is True
    songs = ok(call(nest, "getMusicDirectory", id=album["id"]))["directory"]["child"]
    assert [s["isDir"] for s in songs] == [False, False]


def test_album_lists(nest):
    by_name = ok(call(nest, "getAlbumList2", type="alphabeticalByName"))["albumList2"]["album"]
    assert [a["name"] for a in by_name] == ["Discovery", "Re"]
    by_year = ok(call(nest, "getAlbumList2", type="byYear", fromYear="1990", toYear="1999"))
    assert [a["name"] for a in by_year["albumList2"]["album"]] == ["Re"]
    by_genre = ok(call(nest, "getAlbumList2", type="byGenre", genre="rock"))
    assert [a["name"] for a in by_genre["albumList2"]["album"]] == ["Re"]
    failed(call(nest, "getAlbumList2"), 10)


def test_genres_count_songs_and_albums(nest):
    genres = {g["value"]: g for g in ok(call(nest, "getGenres"))["genres"]["genre"]}
    assert genres["Electronic"]["songCount"] == 2 and genres["Electronic"]["albumCount"] == 1


def test_search_folds_accents_and_an_empty_query_lists_everything(nest):
    found = ok(call(nest, "search3", query="cafe aparato"))["searchResult3"]
    assert [s["title"] for s in found["song"]] == ["El Aparato"]
    everything = ok(call(nest, "search3", query='""', songCount="500"))["searchResult3"]
    assert len(everything["song"]) == 3


def test_subsonic_bpm_follows_listing_precedence(nest):
    from app.domains.subsonic import ids
    from app.utils.library_paths import rel_path_for
    repo = app.state.container.get_music_repository()
    track = repo.scan_albums()[0].tracks[0]
    rel_path = rel_path_for(repo.config.base_music_dir, track.path)
    with repo.analysis.connection() as db:
        db.execute('INSERT OR REPLACE INTO track_analysis (rel_path, bpm, fixed_bpm) VALUES (?, 120, 126)', (rel_path,))
    listing = nest['client'].get('/api/listar-albums-con-metadata?covers=false',
                                 headers={'Authorization': f"Bearer {nest['owner_token']}"})
    assert listing.status_code == 200
    listed = next(t for a in listing.json() for t in a['tracks'] if t['relPath'] == rel_path)
    song = ok(call(nest, 'getSong', id=ids.make(ids.SONG, rel_path)))['song']
    assert listed['bpm'] == song['bpm'] == 126
