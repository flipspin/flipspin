"""A Spotify-export playlist row carries artist and album, so every client can draw it and find its cover."""
from types import SimpleNamespace
from unittest.mock import patch

from app.domains.playlists.export_import import _playlist_entry


def _result(path, title="Excursions", artist=None):
    return SimpleNamespace(file_path=path, title=title, artist=artist, success=True)


def test_row_takes_artist_and_album_from_the_file_tags(tmp_path):
    song = tmp_path / "The Low End Theory" / "Excursions.mp3"
    song.parent.mkdir()
    song.write_bytes(b"")
    audio = SimpleNamespace(tags={"title": ["Excursions"], "artist": ["A Tribe Called Quest"], "album": ["The Low End Theory"]})
    with patch("mutagen.File", return_value=audio):
        row = _playlist_entry(_result(song))
    assert row == {"title": "Excursions", "artist": "A Tribe Called Quest", "album": "The Low End Theory", "path": str(song)}


def test_untagged_file_falls_back_to_the_result_and_its_album_folder(tmp_path):
    song = tmp_path / "Come On Pilgrim" / "Vamos.mp3"
    song.parent.mkdir()
    song.write_bytes(b"not audio")
    row = _playlist_entry(_result(song, title="Vamos (Pilgrim)", artist="Pixies"))
    assert row["artist"] == "Pixies" and row["album"] == "Come On Pilgrim" and row["title"] == "Vamos (Pilgrim)"
