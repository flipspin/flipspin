"""Security regression tests for app.utils.path_safety.

This module is the single chokepoint for every user-/API-supplied path in the
app, so its traversal-rejection branches are the most security-critical code in
the backend. These tests pin that behavior.
"""
import pytest

from app.utils.path_safety import resolve_under, safe_open_path, safe_music_subpath
from app.exceptions import ValidationError


def test_resolve_under_allows_valid_nested_segments(tmp_path):
    (tmp_path / "Album").mkdir()
    resolved = resolve_under(tmp_path, "Album", "track.mp3")
    assert resolved == (tmp_path.resolve() / "Album" / "track.mp3")
    assert resolved.is_relative_to(tmp_path.resolve())


@pytest.mark.parametrize("bad", [".", "..", "../escape", "a/b", "a\\b", "/etc/passwd"])
def test_resolve_under_rejects_traversal_and_separators(tmp_path, bad):
    with pytest.raises(ValidationError):
        resolve_under(tmp_path, bad)


@pytest.mark.parametrize("bad", ["", "\x00", "track\x00.mp3"])
def test_resolve_under_rejects_empty_or_nul_segments(tmp_path, bad):
    with pytest.raises(ValidationError):
        resolve_under(tmp_path, bad)


@pytest.mark.parametrize("name", [" ", " leading", "trailing ", " both "])
def test_resolve_under_preserves_spaces_in_real_names(tmp_path, name):
    album = tmp_path / name
    album.mkdir()
    track = album / f"{name}.mp3 "
    track.write_bytes(b"audio")
    assert resolve_under(tmp_path, name, track.name).read_bytes() == b"audio"


def test_resolve_under_requires_existing_base_dir(tmp_path):
    with pytest.raises(ValidationError):
        resolve_under(tmp_path / "does_not_exist", "x")


def test_resolve_under_blocks_symlink_escape(tmp_path):
    """A symlink inside base pointing outside has no separator in its segment,
    so it passes the segment check — but the *resolved* path escapes base and
    must be rejected by the containment check."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("top secret")
    base = tmp_path / "base"
    base.mkdir()
    link = base / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    with pytest.raises(ValidationError):
        resolve_under(base, "link", "secret.txt")


def test_safe_music_subpath_none_or_blank_returns_base(tmp_path):
    assert safe_music_subpath(tmp_path, None) == tmp_path.resolve()
    assert safe_music_subpath(tmp_path, "   ") == tmp_path.resolve()


def test_safe_music_subpath_rejects_traversal(tmp_path):
    with pytest.raises(ValidationError):
        safe_music_subpath(tmp_path, "../evil")


def test_safe_open_path_rejects_outside_base(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("x")
    with pytest.raises(ValidationError):
        safe_open_path(base, outside_file)


def test_safe_open_path_rejects_missing_file(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    with pytest.raises(ValidationError):
        safe_open_path(base, base / "missing.txt")


def test_safe_open_path_allows_existing_file_under_base(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    f = base / "ok.txt"
    f.write_text("ok")
    assert safe_open_path(base, f) == f.resolve()
