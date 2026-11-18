"""Subsonic streaming, covers, annotations, and scrobble history."""
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest
from mutagen.id3 import ID3

from app.main import app
from tests.integration import test_subsonic as fixtures
from tests.integration.test_subsonic import _song_ids, call, failed, ok

nest = fixtures.nest


@pytest.mark.parametrize("fixture", ["uslt.mp3", "picture.flac", "covr.m4a", "vorbis.ogg"])
def test_get_cover_art_uses_embedded_fallback(nest, monkeypatch, tmp_path, fixture):
    fixtures = Path(__file__).resolve().parents[1] / "fixtures" / "embedded"
    folder = nest["music"] / "Embedded"
    folder.mkdir()
    shutil.copyfile(fixtures / fixture, folder / fixture)
    monkeypatch.setattr(app.state.config, "cover_cache_dir", tmp_path / "covers")
    app.state.container.get_music_repository().invalidate_scan()
    albums = ok(call(nest, "getAlbumList2", type="alphabeticalByName"))["albumList2"]["album"]
    album = next(row for row in albums if row["name"] == "Fixture Album")
    songs = ok(call(nest, "getAlbum", id=album["id"]))["album"]["song"]
    for identifier in (album["id"], songs[0]["id"]):
        # The album index is still warm when the raw cache entry is evicted.
        for cached in (tmp_path / "covers").rglob("*.png"):
            cached.unlink()
        response = call(nest, "getCoverArt", id=identifier)
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        assert response.content == (fixtures / "front.png").read_bytes()


def test_stream_honours_range(nest):
    album = ok(call(nest, "getAlbumList2", type="alphabeticalByName"))["albumList2"]["album"][0]
    song_id = ok(call(nest, "getAlbum", id=album["id"]))["album"]["song"][0]["id"]
    response = nest["client"].get("/rest/stream", params={"u": "ana", "p": nest["app_password"], "id": song_id},
                                  headers={"Range": "bytes=0-99"})
    assert response.status_code == 206 and len(response.content) == 100


def test_cover_art_by_album_and_by_song(nest):
    album = ok(call(nest, "getAlbumList2", type="alphabeticalByName"))["albumList2"]["album"][0]
    assert album["coverArt"] == album["id"]
    response = call(nest, "getCoverArt", fmt=None, id=album["id"])
    assert response.status_code == 200 and response.content == b"\xff\xd8\xff"
    other = ok(call(nest, "getAlbumList2", type="alphabeticalByName"))["albumList2"]["album"][1]
    assert "coverArt" not in other
    failed(call(nest, "getCoverArt", id=other["id"]), 70)


def test_starring_a_song_likes_it_in_the_account_library(nest):
    song = _song_ids(nest)[0]
    ok(call(nest, "star", id=song))
    starred = ok(call(nest, "getStarred2"))["starred2"]
    assert [s["id"] for s in starred["song"]] == [song] and starred["song"][0]["starred"]
    rows = app.state.container.get_user_track_store().list_for_user(
        app.state.container.get_token_store().find_by_username("ana").user_id)
    assert [r.liked for r in rows] == [True]
    ok(call(nest, "unstar", id=song))
    assert ok(call(nest, "getStarred2"))["starred2"]["song"] == []


def test_starring_an_album(nest):
    album = ok(call(nest, "getAlbumList2", type="alphabeticalByName"))["albumList2"]["album"][0]
    ok(call(nest, "star", albumId=album["id"]))
    assert [a["id"] for a in ok(call(nest, "getAlbumList2", type="starred"))["albumList2"]["album"]] == [album["id"]]


def test_a_scrobble_counts_only_songs_already_in_the_library(nest):
    first, second = _song_ids(nest)[:2]
    ok(call(nest, "star", id=first))
    ok(call(nest, "scrobble", id=[first, second]))
    played = {s["id"]: s["playCount"] for s in ok(call(nest, "search3", query="", songCount="10"))["searchResult3"]["song"]}
    assert played[first] == 1 and played[second] == 0


def test_get_user_describes_the_caller(nest):
    user = ok(call(nest, "getUser", username="ana"))["user"]
    assert user["username"] == "ana" and user["adminRole"] is True and user["streamRole"] is True


def test_an_unknown_method_says_so(nest):
    data = failed(call(nest, "getPodcasts"), 0)
    assert "getpodcasts" in data["error"]["message"]


def test_submitted_scrobbles_record_device_times_and_deduplicate_retries(nest):
    from app.infra.idempotency import database

    first, second = _song_ids(nest)[:2]
    ok(call(nest, 'star', id=[first, second]))
    config = app.state.config
    ok(call(nest, 'scrobble', id=first, submission='false'))
    with database(config.jobs_file) as db:
        assert db.execute('SELECT count(*) FROM play_events').fetchone()[0] == 0
    for _ in range(2):
        ok(call(nest, 'scrobble', id=[first, second], time=['978307200000', '978393600000'], submission='true'))
    with database(config.jobs_file) as db:
        rows = db.execute('SELECT * FROM play_events ORDER BY started_at').fetchall()
        assert len(rows) == 2
        assert [row['started_at'] for row in rows] == ['2001-01-01T00:00:00+00:00', '2001-01-02T00:00:00+00:00']
        assert all(row['source'] == 'subsonic' and row['completed'] == 1 for row in rows)
        assert all(row['device_id'] == nest['device']['id'] for row in rows)
        assert all(row['duration_played_s'] is None for row in rows)
    listed = ok(call(nest, 'search3', query='', songCount='10'))['searchResult3']['song']
    assert all(song['playCount'] == 1 for song in listed if song['id'] in (first, second))
    assert nest['client'].post('/api/me/plays', json={'relPath': rows[0]['track_key']},
                                headers={'Authorization': f"Bearer {nest['owner_token']}"}).json()['playCount'] == 2


@pytest.mark.parametrize('times', [['bad'], ['978307200000', '978393600000'], ['99999999999999999999999']])
def test_invalid_scrobble_times_never_append_partial_history(nest, times):
    from app.infra.idempotency import database

    first = _song_ids(nest)[0]
    ok(call(nest, 'star', id=first))
    failed(call(nest, 'scrobble', id=first, time=times), 10)
    with database(app.state.config.jobs_file) as db:
        assert db.execute('SELECT count(*) FROM play_events').fetchone()[0] == 0


def test_replaygain_json_xml_and_scoped_desktop_lookup(nest):
    from mutagen.id3 import TXXX
    path = nest['music'] / 'Daft Punk/Discovery/01.mp3'
    tags = ID3(path)
    for field, value in [('REPLAYGAIN_TRACK_GAIN', '-7.25 dB'), ('REPLAYGAIN_ALBUM_GAIN', '-5 dB'),
                         ('REPLAYGAIN_TRACK_PEAK', '0.9'), ('REPLAYGAIN_ALBUM_PEAK', '0.95')]:
        tags.add(TXXX(encoding=3, desc=field, text=[value]))
    tags.save(path)
    app.state.container.get_music_repository().invalidate_scan()
    albums = ok(call(nest, 'getAlbumList2', type='alphabeticalByName'))['albumList2']['album']
    album = next(a for a in albums if a['name'] == 'Discovery')
    song = ok(call(nest, 'getAlbum', id=album['id']))['album']['song'][0]
    expected = {'trackGain': -7.25, 'albumGain': -5., 'trackPeak': .9, 'albumPeak': .95, 'baseGain': 0.}
    assert song['replayGain'] == expected
    root = ET.fromstring(call(nest, 'getSong', fmt='xml', id=song['id']).text)
    gain = root.find('.//{*}replayGain')
    assert gain is not None and {k: float(v) for k, v in gain.attrib.items()} == expected
    url = '/api/analysis/Daft Punk∕Discovery/01.mp3/replaygain'
    owner = {'Authorization': f"Bearer {nest['owner_token']}"}
    assert nest['client'].get(url, headers=owner).json() == expected
    store = app.state.container.get_token_store()
    member, token = store.mint('Member', 'member')
    headers = {'Authorization': f'Bearer {token}'}
    assert nest['client'].get(url, headers=headers).status_code == 404
    app.state.container.get_user_track_store().add_many(member.user_id, ['Daft Punk∕Discovery/01.mp3'])
    assert nest['client'].get(url, headers=headers).json() == expected
