"""Regression tests: a playlist name cannot escape the playlist directory.

Guards the path-traversal fix in PlaylistRepository — load/delete/save build the
JSON file path from the user-supplied playlist name (a route path param), so a
name like ``../../etc/passwd`` must never read or unlink a file outside the
playlist dir.
"""
import logging

import pytest

from app.domains.playlists.models import Playlist
from app.domains.playlists.repositories import PlaylistRepository
from app.exceptions import PlaylistError


@pytest.fixture
def repo(config):
    return PlaylistRepository(config, logging.getLogger("test"))


@pytest.mark.parametrize(
    "evil",
    ["../../etc/passwd", "a/b", "/abs/path", "..\\..\\win", "../secret"],
)
def test_playlist_path_rejects_traversal(repo, evil):
    with pytest.raises(PlaylistError):
        repo._playlist_path(evil)


def test_playlist_path_stays_contained(repo, config):
    p = repo._playlist_path("My Playlist")
    assert p.parent == config.playlist_dir.resolve()
    assert p.name == "My_Playlist.json"


def test_load_playlist_rejects_traversal(repo):
    with pytest.raises(PlaylistError):
        repo.load_playlist("../../../etc/hosts")


def test_delete_playlist_rejects_traversal(repo, tmp_path):
    # A file that exists outside the playlist dir must remain untouched.
    target = tmp_path / "important.txt"
    target.write_text("do not delete")
    with pytest.raises(PlaylistError):
        repo.delete_playlist("../../important.txt")
    assert target.exists()


def test_normal_save_load_roundtrip_still_works(repo):
    repo.save_playlist(Playlist(name="Road Trip", description="", tracks=[]))
    loaded = repo.load_playlist("Road Trip")
    assert loaded.name == "Road Trip"


def test_rename_playlist_moves_file(repo, config):
    """Renaming moves the JSON file and updates the embedded name."""
    repo.save_playlist(Playlist(name="Road Trip", description="", tracks=[]))

    repo.rename_playlist("Road Trip", "Beach Day")

    assert repo.load_playlist("Beach Day").name == "Beach Day"
    assert (config.playlist_dir / "Beach_Day.json").exists()
    assert not (config.playlist_dir / "Road_Trip.json").exists()
    with pytest.raises(PlaylistError):
        repo.load_playlist("Road Trip")


def test_rename_playlist_conflict_is_rejected(repo):
    """Renaming onto an existing playlist name raises and leaves both intact."""
    repo.save_playlist(Playlist(name="Keep", description="", tracks=[]))
    repo.save_playlist(Playlist(name="Taken", description="", tracks=[]))

    with pytest.raises(PlaylistError, match="already exists"):
        repo.rename_playlist("Keep", "Taken")

    assert repo.load_playlist("Keep").name == "Keep"
    assert repo.load_playlist("Taken").name == "Taken"


def test_rename_playlist_same_file_updates_in_place(repo, config):
    """A new name that maps to the same file (space vs underscore) updates in place."""
    repo.save_playlist(Playlist(name="My List", description="", tracks=[]))

    # "My List" and "My_List" both resolve to My_List.json.
    repo.rename_playlist("My List", "My_List")

    assert (config.playlist_dir / "My_List.json").exists()
    assert repo.load_playlist("My_List").name == "My_List"


def test_rename_missing_source_raises(repo):
    with pytest.raises(PlaylistError):
        repo.rename_playlist("Ghost", "Whatever")


def test_rename_playlist_rejects_traversal(repo, config):
    """A malicious new name cannot escape the playlist dir; the source survives."""
    repo.save_playlist(Playlist(name="Road Trip", description="", tracks=[]))

    with pytest.raises(PlaylistError):
        repo.rename_playlist("Road Trip", "../../evil")

    assert (config.playlist_dir / "Road_Trip.json").exists()


class TestAppleDoubleSidecars:
    """Resolve symlinks before containment checks so an in-tree link cannot escape.

    Use a temporary outside file to verify rejection without reading host data.
    """

    def _repo(self, tmp_path):
        from app.domains.playlists.repositories import PlaylistRepository
        from unittest.mock import Mock
        config = Mock()
        config.playlist_dir = tmp_path
        return PlaylistRepository(config, Mock())

    def test_sidecars_are_not_playlists(self, tmp_path):
        (tmp_path / "citation.json").write_text('{"tracks": []}')
        (tmp_path / "Konbini_Wars.json").write_text('{"tracks": []}')
        # Real bytes from the server: AppleDouble magic, not UTF-8.
        (tmp_path / "._citation.json").write_bytes(b"\x00\x05\x16\x07" + b"\xa3" * 40)
        (tmp_path / "._Konbini_Wars.json").write_bytes(b"\x00\x05\x16\x07" + b"\xa3" * 40)

        assert self._repo(tmp_path).list_playlists() == ["Konbini Wars", "citation"]

    def test_a_real_playlist_starting_with_a_dot_still_lists(self, tmp_path):
        """Only the `._` prefix is a sidecar. `.hidden` is a name someone chose."""
        (tmp_path / ".hidden.json").write_text('{"tracks": []}')
        assert self._repo(tmp_path).list_playlists() == [".hidden"]

    def test_the_fixture_would_fail_without_the_skip(self, tmp_path):
        """Mutation guard: prove the sidecars really do match the glob."""
        (tmp_path / "._citation.json").write_bytes(b"\x00\x05\x16\x07")
        assert list(tmp_path.glob("*.json")), "the sidecar must match *.json, or this suite proves nothing"
