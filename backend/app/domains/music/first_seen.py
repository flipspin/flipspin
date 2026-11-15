"""Durable catalog arrival dates, independent of disposable scan snapshots."""
import logging
import threading
from pathlib import Path

from app.domains.music.library_files import AUDIO_EXTENSIONS, walk_library
from app.infra.jobs.receipts import library_receipts
from app.utils.library_paths import rel_path_for

logger = logging.getLogger(__name__)


def first_seen_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS library_first_seen (
        root TEXT NOT NULL, rel_path TEXT NOT NULL, first_seen REAL NOT NULL,
        PRIMARY KEY(root,rel_path))''')
    db.execute('''CREATE TABLE IF NOT EXISTS library_first_seen_hash (
        root TEXT NOT NULL, sha256 TEXT NOT NULL, first_seen REAL NOT NULL,
        PRIMARY KEY(root,sha256))''')
    db.execute('CREATE TABLE IF NOT EXISTS library_first_seen_backfill (root TEXT PRIMARY KEY)')


class FirstSeen:
    def __init__(self, repository, config):
        self.repository, self.config = repository, config
        self._cache = {}
        self._lock = threading.RLock()

    def get(self, path, *, receipt=None, sha=None, fallback=None):
        # A concurrent scan must not cache a pre-move row after repoint commits.
        with self._lock:
            return self._get(path, receipt=receipt, sha=sha, fallback=fallback)

    def _get(self, path, *, receipt=None, sha=None, fallback=None):
        root = self.config.base_music_dir
        rel = rel_path_for(root, path)
        if rel is None:
            return fallback
        key = str(root.resolve())
        cached = self._cache.get((key, rel))
        if cached is not None and not sha:
            return cached
        with self.repository.connection() as db:
            row = db.execute('SELECT first_seen FROM library_first_seen WHERE root=? AND rel_path=?', (key, rel)).fetchone()
        if row:
            if sha:
                with self.repository.connection() as db:
                    db.execute('INSERT OR IGNORE INTO library_first_seen_hash VALUES (?,?,?)', (key, sha, row[0]))
            self._cache[key, rel] = float(row[0])
            return float(row[0])
        if receipt is None:
            receipts = library_receipts(getattr(self.config, 'jobs_file', None), root)
            receipt, recorded_sha = receipts.for_path(root, path)
            sha = sha or recorded_sha
        if receipt is None:
            if path.is_file():
                stat = path.stat()
                receipt = getattr(stat, 'st_birthtime', None) or stat.st_mtime
            else:
                receipt = fallback
        if receipt is None:
            return None
        with self.repository.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if sha:
                db.execute('INSERT OR IGNORE INTO library_first_seen_hash VALUES (?,?,?)', (key, sha, receipt))
                receipt = db.execute('SELECT first_seen FROM library_first_seen_hash WHERE root=? AND sha256=?', (key, sha)).fetchone()[0]
            db.execute('INSERT OR IGNORE INTO library_first_seen VALUES (?,?,?)', (key, rel, receipt))
            value = float(db.execute('SELECT first_seen FROM library_first_seen WHERE root=? AND rel_path=?', (key, rel)).fetchone()[0])
        self._cache[key, rel] = value
        return value

    def published(self, path, *, receipt, sha=None):
        receipts = library_receipts(getattr(self.config, 'jobs_file', None), self.config.base_music_dir)
        recorded, recorded_sha = receipts.for_path(self.config.base_music_dir, path)
        return self.get(path, receipt=min(receipt, recorded) if recorded is not None else receipt, sha=sha or recorded_sha)

    def repoint(self, root, old, new):
        with self._lock:
            self._repoint(root, old, new)

    def _repoint(self, root, old, new):
        if rel_path_for(root, old) is None or rel_path_for(root, new) is None:
            return
        key = str(root.resolve())
        with self.repository.connection() as db:
            db.execute('''INSERT INTO library_first_seen SELECT root,?,first_seen FROM library_first_seen
                WHERE root=? AND rel_path=? ON CONFLICT(root,rel_path)
                DO UPDATE SET first_seen=excluded.first_seen''',
                (rel_path_for(root, new), key, rel_path_for(root, old)))
            row = db.execute('SELECT first_seen FROM library_first_seen WHERE root=? AND rel_path=?', (key, rel_path_for(root, new))).fetchone()
        if row:
            self._cache[key, rel_path_for(root, new)] = float(row[0])
        # Retain the old key too: recovery and missing-file records may use it.

    def backfill(self):
        root = self.config.base_music_dir
        key = str(root.resolve())
        with self.repository.connection() as db:
            if db.execute('SELECT 1 FROM library_first_seen_backfill WHERE root=?', (key,)).fetchone():
                return False
        if not root.is_dir():
            return False  # An unavailable mount is not a completed migration.
        receipts = library_receipts(getattr(self.config, 'jobs_file', None), root)
        counts = {'receipt': 0, 'birthtime': 0, 'mtime': 0}
        def fail(error):
            raise error
        for folder, _, names in walk_library(root, onerror=fail):
            for name in names:
                path = Path(folder) / name
                if name.startswith('.') or path.suffix.lower() not in AUDIO_EXTENSIONS:
                    continue
                receipt, sha = receipts.for_path(root, path)
                stat = path.stat()
                source = 'receipt' if receipt is not None else 'birthtime' if getattr(stat, 'st_birthtime', None) else 'mtime'
                self.get(path, receipt=receipt if receipt is not None else getattr(stat, 'st_birthtime', None) or stat.st_mtime, sha=sha)
                counts[source] += 1
        with self.repository.connection() as db:
            inserted = db.execute('INSERT OR IGNORE INTO library_first_seen_backfill VALUES (?)', (key,)).rowcount
        if inserted:
            logger.info('Library first-seen backfill receipt=%d birthtime=%d mtime=%d', *counts.values())
        return bool(inserted)
