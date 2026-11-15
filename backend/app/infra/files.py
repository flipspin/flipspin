"""Replace whole files atomically so failed writes preserve the previous version.

Create temporary files beside the target to keep renames on one filesystem.
Set permissions before writing bytes; PRIVATE protects credentials and account
data throughout the write, including before publication.
"""
from __future__ import annotations

import contextlib
import json
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

#: Owner read/write only: credentials, token digests, per-account rows.
PRIVATE = 0o600
#: The usual mode for a file other tools may read (a lyric sidecar, a playlist).
SHARED = 0o644


def write_bytes_atomic(path: Path, data: bytes, *, mode: int = SHARED) -> None:
    """Replace ``path`` with bytes in one rename."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        # os.fchmod does not exist on Windows, where POSIX modes mean nothing.
        if hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def write_text_atomic(path: Path, text: str, *, mode: int = SHARED) -> None:
    """Replace ``path`` with ``text`` (UTF-8) in one rename."""
    write_bytes_atomic(path, text.encode("utf-8"), mode=mode)


def write_json_atomic(
    path: Path,
    data: Any,
    *,
    mode: int = SHARED,
    indent: int | None = 2,
    sort_keys: bool = False,
    ensure_ascii: bool = False,
) -> None:
    """Replace ``path`` with ``data`` as JSON, ending in a newline."""
    text = json.dumps(data, indent=indent, sort_keys=sort_keys, ensure_ascii=ensure_ascii)
    write_text_atomic(path, text + "\n", mode=mode)


def write_secret_lines(path: Path, lines: Iterable[str]) -> None:
    """Replace a secret-bearing text file (``~/Krobi/.env``) with ``lines``, owner-only."""
    write_text_atomic(path, "".join(lines), mode=PRIVATE)
