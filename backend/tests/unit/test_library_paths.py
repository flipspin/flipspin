"""Folded keys must find literal division slashes without changing old keys."""
import json
from pathlib import Path

import pytest

from app.exceptions import ValidationError
from app.utils.library_paths import ROOT_ALBUM_KEY, keys_for, resolve_album, resolve_rel_path, resolve_track


@pytest.mark.parametrize(("path", "album", "file"), [
    ("Flat/01.mp3", "Flat", "01.mp3"),
    ("Artist/Album/CD2/01.mp3", "Artist∕Album", "CD2∕01.mp3"),
    ("unicode/Literal∕Album/01.mp3", "unicode∕Literal∕Album", "01.mp3"),
    ("Artist∕Name/Album∕Name/CD1/01∕song.mp3", "Artist∕Name∕Album∕Name", "CD1∕01∕song.mp3"),
    ("Flat/01∕song.mp3", "Flat", "01∕song.mp3"),
    ("Artist/∕Album∕/CD1/∕01∕.mp3", "Artist∕∕Album∕", "CD1∕∕01∕.mp3"),
    (" Leading Album/ 01 - Space.mp3 ", " Leading Album", " 01 - Space.mp3 "),
])
def test_existing_paths_round_trip_with_unchanged_keys(tmp_path, path, album, file):
    source = tmp_path / path
    source.parent.mkdir(parents=True)
    source.write_bytes(path.encode())
    assert keys_for(tmp_path, source) == (album, file)
    expected_album = source.parent.parent if source.parent.name in {"CD1", "CD2"} else source.parent
    assert resolve_album(tmp_path, album) == expected_album
    assert resolve_track(tmp_path, album, file).read_bytes() == path.encode()
    assert resolve_rel_path(tmp_path, f"{album}/{file}") == source


@pytest.mark.parametrize("literal", ["Literal∕Album", "Literal∕∕Album"])
def test_resolution_backtracks_past_a_directory_with_no_matching_suffix(tmp_path, literal):
    (tmp_path / "Artist∕Literal").mkdir()
    source = tmp_path / "Artist" / literal / "01.mp3"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"song")
    assert resolve_track(tmp_path, f"Artist∕{literal}", "01.mp3") == source


def test_literal_name_keeps_precedence_over_an_equally_named_folded_path(tmp_path):
    for path, data in [("Artist∕Album/01.mp3", b"literal"), ("Artist/Album/01.mp3", b"nested")]:
        source = tmp_path / path
        source.parent.mkdir(parents=True)
        source.write_bytes(data)
    assert resolve_track(tmp_path, "Artist∕Album", "01.mp3").read_bytes() == b"literal"


def test_missing_keys_still_return_a_path_under_the_library(tmp_path):
    expected = tmp_path / "Artist" / "Missing" / "CD1" / "01.mp3"
    assert resolve_track(tmp_path, "Artist∕Missing", "CD1∕01.mp3") == expected


@pytest.mark.parametrize(("album", "file"), [
    ("Artist∕..∕..", "01.mp3"),
    ("Artist∕.", "01.mp3"),
    ("Artist∕", "01.mp3"),
    ("Artist", "CD1∕..∕..∕01.mp3"),
    ("Artist", "CD1∕\x00.mp3"),
    ("Artist", "CD1∕/absolute.mp3"),
    ("Artist", "CD1∕back\\slash.mp3"),
])
def test_folded_keys_cannot_bypass_segment_validation(tmp_path, album, file):
    (tmp_path / "Artist").mkdir()
    with pytest.raises(ValidationError):
        resolve_track(tmp_path, album, file)


@pytest.mark.parametrize("key", ["Artist∕escape∕Album", "Artist∕escape∕01.mp3"])
def test_candidate_resolution_blocks_symlink_escape(tmp_path, key):
    base = tmp_path / "Music"
    (base / "Artist").mkdir(parents=True)
    outside = tmp_path / "outside"
    (outside / "Album").mkdir(parents=True)
    (outside / "01.mp3").write_bytes(b"secret")
    (base / "Artist" / "escape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValidationError):
        resolve_album(base, key)


def test_disc_symlink_may_stay_within_the_music_root(tmp_path):
    (tmp_path / "Album").mkdir()
    (tmp_path / "Other").mkdir()
    target = tmp_path / "Other" / "01.mp3"
    target.write_bytes(b"song")
    (tmp_path / "Album" / "CD1").symlink_to(tmp_path / "Other", target_is_directory=True)
    assert resolve_track(tmp_path, "Album", "CD1∕01.mp3") == target


CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "contracts/library-keys.json").read_text())


@pytest.mark.parametrize("case", CONTRACT["cases"], ids=lambda case: case["path"])
def test_shared_library_key_contract(tmp_path, case):
    source = tmp_path / case["path"]
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"song")
    assert ROOT_ALBUM_KEY == CONTRACT["rootAlbumKey"]
    assert keys_for(tmp_path, source) == (case["album"], case["file"])
    assert resolve_rel_path(tmp_path, f"{case['album']}/{case['file']}") == source


def test_root_key_has_no_physical_or_folded_folder_collision(tmp_path):
    assert len(ROOT_ALBUM_KEY.encode("ascii")) == 256
    assert "∕" not in ROOT_ALBUM_KEY
    assert resolve_album(tmp_path, ROOT_ALBUM_KEY) == tmp_path
    assert keys_for(tmp_path, tmp_path.parent / "outside.mp3") is None


@pytest.mark.parametrize("file", ["..", "../secret", "\\secret", "CD1∕..∕..∕secret", "\x00.mp3"])
def test_root_album_keeps_track_containment_checks(tmp_path, file):
    with pytest.raises(ValidationError):
        resolve_track(tmp_path, ROOT_ALBUM_KEY, file)
