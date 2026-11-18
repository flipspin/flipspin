"""One online SQLite snapshot primitive for backups and migrations."""
import os
import sqlite3
from time import monotonic
from contextlib import closing
from pathlib import Path


def check_integrity(path: Path) -> None:
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite integrity check failed')


def snapshot_database(source: sqlite3.Connection, target: Path) -> None:
    """Include committed WAL pages without copying a live database file."""
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    deadline = monotonic() + 120

    def progress(_status, _remaining, _total):
        if monotonic() > deadline:
            raise TimeoutError('SQLite backup exceeded two minutes')

    with closing(sqlite3.connect(target)) as destination:
        source.backup(destination, pages=256, progress=progress)
        # A self-contained copy, with no sidecar files needed for restore.
        destination.execute('PRAGMA journal_mode=DELETE')
    check_integrity(target)
    with target.open('r+b') as handle:
        os.fsync(handle.fileno())
