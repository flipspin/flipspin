from unittest.mock import Mock

import pytest

from app.domains.music.covers import cover_version
from app.domains.music.repositories import MusicRepository
from app.domains.playlists.routes import _cover_versions
from app.utils.library_paths import ROOT_ALBUM_KEY


@pytest.fixture
def find_cover(config):
    return MusicRepository(config, Mock(), analysis=Mock())._find_cover_art


def test_playlist_cover_versions_resolve_literal_nested_and_root_keys(tmp_path, find_cover):
    for folder in (tmp_path, tmp_path / "Artist" / "Album", tmp_path / "Literal∕Name"):
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "cover.jpg").write_bytes(str(folder).encode())
    albums = [ROOT_ALBUM_KEY, "Artist∕Album", "Literal∕Name", "Missing"]
    assert _cover_versions(albums, tmp_path, find_cover) == [
        cover_version(tmp_path / "cover.jpg"),
        cover_version(tmp_path / "Artist" / "Album" / "cover.jpg"),
        cover_version(tmp_path / "Literal∕Name" / "cover.jpg"),
        None,
    ]


def test_playlist_cover_versions_do_not_stat_outside_the_library(tmp_path, find_cover):
    base = tmp_path / "Music"
    base.mkdir()
    (tmp_path / "cover.jpg").write_bytes(b"outside")
    (base / "escape").symlink_to(tmp_path, target_is_directory=True)
    assert _cover_versions(["..", "escape"], base, find_cover) == [None, None]
