"""``app/infra/files.py``: whole-file replacement, and who may read the result."""
import json
import os
import stat
import sys

import pytest

from app.infra.files import PRIVATE, SHARED, write_json_atomic, write_secret_lines, write_text_atomic

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")


def _mode(path):
    return stat.S_IMODE(os.stat(path).st_mode)


def test_replaces_the_whole_file_and_leaves_no_temporary_behind(tmp_path):
    target = tmp_path / "nested" / "data.json"
    write_json_atomic(target, {"a": 1})
    write_json_atomic(target, {"b": 2})

    assert json.loads(target.read_text()) == {"b": 2}
    assert target.read_text().endswith("\n")
    assert [p.name for p in target.parent.iterdir()] == ["data.json"]


def test_a_failed_write_keeps_the_previous_version(tmp_path):
    target = tmp_path / "data.json"
    write_json_atomic(target, {"good": True})

    with pytest.raises(TypeError):
        write_json_atomic(target, {"bad": object()})

    assert json.loads(target.read_text()) == {"good": True}
    assert [p.name for p in tmp_path.iterdir()] == ["data.json"]


@posix_only
def test_shared_files_are_readable_by_other_tools(tmp_path):
    # A lyric sidecar is read by VLC and by the phone app over a file share.
    target = tmp_path / "Song.lrc"
    write_text_atomic(target, "[00:01.00] hola\n")
    assert _mode(target) == SHARED


@posix_only
def test_private_files_are_owner_only_even_when_replacing_a_readable_one(tmp_path):
    target = tmp_path / ".env"
    target.write_text("OLD=1\n")
    os.chmod(target, 0o644)

    write_secret_lines(target, ["TOKEN=secret\n"])

    assert target.read_text() == "TOKEN=secret\n"
    assert _mode(target) == PRIVATE
