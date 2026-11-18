"""Genres for acquired songs: Spanish in the tag, never a guess, never a failed download."""
from unittest.mock import Mock

import requests

from app.domains.metadata.deezer_repository import DeezerRepository
from app.domains.metadata.genres import AlbumGenres, fill_tracks, tag_value


class FakeDeezer:
    def __init__(self, albums=None, tracks=None, by_isrc=None, genres=None, year=2019, boom=False):
        self.albums, self.tracks, self.by_isrc = albums or [], tracks or [], by_isrc or {}
        self.genres = genres if genres is not None else [("Latino", "Latin Music"), ("Pop", "Pop")]
        self.year, self.boom = year, boom
        self.calls = 0

    def fetch_track_by_isrc(self, isrc):
        self.calls += 1
        return self.by_isrc.get(isrc)

    def search_albums(self, q):
        self.calls += 1
        if self.boom:
            raise RuntimeError("deezer down")
        return self.albums

    def search_tracks_raw(self, q):
        self.calls += 1
        return self.tracks

    def fetch_album_tags(self, album_id):
        self.calls += 1
        return self.genres, self.year


def test_tag_is_spanish_deduped_and_capped():
    pairs = [("Alternativo", "Alternative"), ("Pop", "Pop"), ("Pop", "Pop"), ("Indie Pop", "Indie Pop"), ("Latino", "Latin Music")]
    assert tag_value(pairs) == "Alternativo, Pop, Indie Pop"
    assert tag_value([]) is None


def test_album_search_needs_title_and_artist_to_match():
    wrong = [{"id": 1, "title": "Cuarto Azul (Live)", "artist": {"name": "Aitana"}},
             {"id": 2, "title": "CUARTO AZUL", "artist": {"name": "Otra Persona"}}]
    lookup = AlbumGenres(FakeDeezer(albums=wrong))
    assert lookup.lookup("Aitana", "CUARTO AZUL", "SUPERESTRELLA") == (None, None, [])

    right = wrong + [{"id": 3, "title": "cuarto azul", "artist": {"name": "Aitana"}}]
    genre, year, _ = AlbumGenres(FakeDeezer(albums=right)).lookup("Aitana", "CUARTO AZUL")
    assert (genre, year) == ("Latino, Pop", 2019)


def test_isrc_wins_and_track_search_is_the_fallback():
    deezer = FakeDeezer(by_isrc={"USUM71900001": {"album": {"id": 9}}})
    assert AlbumGenres(deezer).lookup("X", "Y", "Z", "USUM71900001")[0] == "Latino, Pop"
    deezer = FakeDeezer(tracks=[{"title": "Una Velita", "artist": {"name": "Bad Bunny"}, "album": {"id": 5}}])
    assert AlbumGenres(deezer).lookup("Bad Bunny", "Una Velita (Single)", "Una Velita")[0] == "Latino, Pop"


def test_one_lookup_per_album_and_failures_are_silent():
    deezer = FakeDeezer(albums=[{"id": 3, "title": "B", "artist": {"name": "A"}}])
    lookup = AlbumGenres(deezer)
    tracks = [{"name": "t1", "artist": "A", "album": "B"}, {"name": "t2", "artist": "A", "album": "B"},
              {"name": "t3", "artist": "A", "album": "B", "genre": "Rock"}]
    assert fill_tracks(tracks, [None, None, None], lookup) == 2
    assert [t["genre"] for t in tracks] == ["Latino, Pop", "Latino, Pop", "Rock"]
    assert tracks[0]["year"] == 2019
    assert tracks[2]["year"] == 2019  # Existing genre still permits year enrichment.
    assert deezer.calls == 2  # one search, one genre fetch — not per track

    broken = [{"name": "t", "artist": "A", "album": "B"}]
    assert fill_tracks(broken, [None], AlbumGenres(FakeDeezer(boom=True))) == 0
    assert "genre" not in broken[0]


def test_fill_preserves_each_existing_tag_and_skips_complete_metadata():
    lookup = Mock(spec=AlbumGenres)
    lookup.lookup.return_value = ('Pop', 2019, [])
    tracks = [{'name': 'Song', 'artist': 'Artist', 'genre': 'Rock'},
              {'name': 'Song', 'artist': 'Artist', 'year': 1999},
              {'name': 'Song', 'artist': 'Artist', 'genre': 'Jazz', 'year': 2000}]
    assert fill_tracks(tracks, [None] * 3, lookup) == 1
    assert [(t['genre'], t['year']) for t in tracks] == [('Rock', 2019), ('Pop', 1999), ('Jazz', 2000)]
    assert lookup.lookup.call_count == 2


def test_repository_pairs_genres_by_id_across_languages():
    answers = {
        "es": {"genres": {"data": [{"id": 65, "name": "Música tradicional mexicana"}, {"id": 197, "name": "Latino"}]}},
        "en": {"genres": {"data": [{"id": 65, "name": "Traditional Mexicano"}]}},
    }
    seen = []

    def get(url, params=None, headers=None, timeout=None):
        lang = (headers or {}).get("Accept-Language")
        seen.append(lang)
        resp = Mock(status_code=200)
        resp.json = Mock(return_value=answers[lang])
        resp.raise_for_status = Mock()
        return resp

    session = Mock(spec=requests.Session)
    session.get = Mock(side_effect=get)
    repo = DeezerRepository(config=Mock(), logger=Mock(), session=session, min_interval_s=0, isrc_lookups=0, sleep=lambda s: None)
    assert repo.fetch_album_genres(123) == [("Música tradicional mexicana", "Traditional Mexicano"), ("Latino", "Latino")]
    assert seen == ["es", "en"]


class FieldedSearchBroken(FakeDeezer):
    """Fall back when Deezer's fielded artist queries return no rows."""

    def search_albums(self, q):
        self.calls += 1
        return [] if ':"' in q else self.albums

    def search_tracks_raw(self, q):
        self.calls += 1
        return [] if ':"' in q else self.tracks


def test_plain_text_search_finds_the_album_when_fielded_search_answers_nothing():
    deezer = FieldedSearchBroken(albums=[{"id": 7, "title": "The Low End Theory", "artist": {"name": "A Tribe Called Quest"}}])
    value, _year, _pairs = AlbumGenres(deezer).lookup("A Tribe Called Quest", "The Low End Theory")
    assert value == "Latino, Pop"


def test_plain_text_fallback_still_needs_the_exact_title_and_artist():
    deezer = FieldedSearchBroken(albums=[{"id": 7, "title": "The Low End Theory (Remix)", "artist": {"name": "Someone Else"}}])
    assert AlbumGenres(deezer).lookup("A Tribe Called Quest", "The Low End Theory")[0] is None
