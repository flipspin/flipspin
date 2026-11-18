"""Disposable, music-owned disk discovery and tag cache (never user facts)."""
import json
import sqlite3
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from app.domains.music.models import Album, Track
from app.infra.migrations import SQLiteStore, open_store


def schema(db):
    db.execute('CREATE TABLE folders (root TEXT, path TEXT, signature TEXT, PRIMARY KEY(root,path))')
    db.execute('CREATE TABLE tags (path TEXT PRIMARY KEY, mtime_ns INTEGER, size INTEGER, value TEXT)')
    db.execute('CREATE TABLE snapshots (root TEXT PRIMARY KEY, value TEXT, completed_at TEXT, duration REAL)')


def requests_schema(db):
    db.execute('CREATE TABLE requests (root TEXT PRIMARY KEY, full INTEGER NOT NULL)')


def explicit_deletion(db):
    db.execute('ALTER TABLE requests ADD COLUMN allow_empty INTEGER NOT NULL DEFAULT 0')


def tag_reader_v2(db):
    # The memo stores the whole reader dict. Old first-value dictionaries and
    # folder signatures must both miss once, even when the files are unchanged.
    # Retain the last published snapshot for an offline/unmounted music root.
    db.execute('UPDATE tags SET mtime_ns=-1')
    db.execute("UPDATE folders SET signature=''")


def move_identity(db):
    # Populate raw tag hashes on the next scan; retain remembered ghost metadata.
    db.execute('UPDATE tags SET mtime_ns=-1')
    db.execute("UPDATE folders SET signature=''")


def loudness_tags(db):
    tag_reader_v2(db)


def health_schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS health (root TEXT PRIMARY KEY, value TEXT NOT NULL)')


def first_seen_schema(db):
    # Existing rows predate tracking. Never infer their arrival from file mtime.
    if 'first_seen' not in {row[1] for row in db.execute('PRAGMA table_info(tags)')}:
        db.execute('ALTER TABLE tags ADD COLUMN first_seen REAL')


def analysis_baseline_schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS analysis_baselines (root TEXT PRIMARY KEY, completed_at REAL NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS analysis_scan_root (id INTEGER PRIMARY KEY CHECK(id=1), root TEXT NOT NULL)')


def album_snapshots_schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS album_snapshots (root TEXT, path TEXT, value TEXT NOT NULL, PRIMARY KEY(root,path))')
    for root, value in db.execute('SELECT root,value FROM snapshots').fetchall():
        db.executemany('INSERT OR REPLACE INTO album_snapshots VALUES (?,?,?)',
                       [(root, album['path'], json.dumps(album)) for album in json.loads(value)])
    db.execute("UPDATE snapshots SET value='[]'")


SCAN_CACHE = SQLiteStore('music-scan', (schema, requests_schema, explicit_deletion, tag_reader_v2, move_identity, loudness_tags, health_schema, first_seen_schema, analysis_baseline_schema, album_snapshots_schema))


class ScanStore:
    def __init__(self, path):
        self.path = Path(path)
        open_store(self.path, SCAN_CACHE).close()

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def load(self, root):
        with self.connection() as db:
            folders = dict(db.execute('SELECT path,signature FROM folders WHERE root=?', (str(root),)))
            tags = {path: ((mtime, size), json.loads(value)) for path, mtime, size, value in
                    db.execute('SELECT path,mtime_ns,size,value FROM tags')}
            row = db.execute('SELECT value,completed_at,duration FROM snapshots WHERE root=?', (str(root),)).fetchone()
            values = [json.loads(value) for (value,) in db.execute(
                'SELECT value FROM album_snapshots WHERE root=? ORDER BY path', (str(root),))]
        albums = []
        if row:
            for album in values:
                album['path'] = Path(album['path'])
                album['cover_art'] = Path(album['cover_art']) if album['cover_art'] else None
                album['tracks'] = [Track(**{**t, 'path': Path(t['path'])}) for t in album['tracks']]
                albums.append(Album(**album))
        return folders, tags, albums, row[1:] if row else (None, None)

    def save(self, root, folders, tags, albums, completed_at, duration, *, full=False, allow_empty=False,
             incremental=False, removed_folders=(), removed_albums=()):
        # Serialize before taking SQLite's write lock; commands can enqueue meanwhile.
        snapshots = [(str(root), str(a.path), json.dumps(asdict(a), default=str)) for a in albums]
        first_seen = datetime.fromisoformat(completed_at).timestamp()
        tag_rows = [(path, *stamp, json.dumps(value), first_seen) for path, (stamp, value) in tags.items()]
        with self.connection() as db:
            if not incremental:
                db.execute('DELETE FROM folders WHERE root=?', (str(root),))
                db.execute('DELETE FROM album_snapshots WHERE root=?', (str(root),))
            db.executemany('DELETE FROM folders WHERE root=? AND path=?', [(str(root), str(p)) for p in removed_folders])
            db.executemany('DELETE FROM album_snapshots WHERE root=? AND path=?', [(str(root), str(p)) for p in removed_albums])
            db.executemany('INSERT OR REPLACE INTO folders VALUES (?,?,?)', [(str(root), path, sig) for path, sig in folders.items()])
            db.executemany('INSERT OR REPLACE INTO album_snapshots VALUES (?,?,?)', snapshots)
            db.executemany('INSERT INTO tags (path,mtime_ns,size,value,first_seen) VALUES (?,?,?,?,?) '
                           'ON CONFLICT(path) DO UPDATE SET mtime_ns=excluded.mtime_ns,size=excluded.size,value=excluded.value', tag_rows)
            db.execute('INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?)',
                       (str(root), '[]', completed_at, duration))
            # Publish the baseline atomically with the first complete discovery.
            # A root switch (including switching back) starts a new baseline.
            active = db.execute('SELECT root FROM analysis_scan_root WHERE id=1').fetchone()
            if active and active[0] != str(root):
                db.execute('DELETE FROM analysis_baselines WHERE root=?', (str(root),))
            db.execute('INSERT OR IGNORE INTO analysis_baselines VALUES (?,?)', (str(root), first_seen))
            db.execute('INSERT OR REPLACE INTO analysis_scan_root VALUES (1,?)', (str(root),))
            if full:
                db.execute('UPDATE requests SET full=0 WHERE root=?', (str(root),))
            if allow_empty:
                db.execute('UPDATE requests SET allow_empty=0 WHERE root=?', (str(root),))
            db.execute('DELETE FROM requests WHERE root=? AND full=0 AND allow_empty=0', (str(root),))

    def completed(self, root, completed_at, duration):
        with self.connection() as db:
            db.execute('UPDATE snapshots SET completed_at=?,duration=? WHERE root=?',
                       (completed_at, duration, str(root)))

    def request_full(self, root):
        with self.connection() as db:
            db.execute('INSERT INTO requests (root,full) VALUES (?,1) '
                       'ON CONFLICT(root) DO UPDATE SET full=1', (str(root),))

    def full_pending(self, root):
        return self.pending(root)[0]

    def pending(self, root):
        with self.connection() as db:
            row = db.execute('SELECT full,allow_empty FROM requests WHERE root=?', (str(root),)).fetchone()
        return (bool(row[0]), bool(row[1])) if row else (False, False)

    def forget_file(self, root, path):
        with self.connection() as db:
            db.execute('DELETE FROM tags WHERE path IN (?,?)', (str(path), str(path.resolve())))
            db.execute('INSERT INTO requests (root,full,allow_empty) VALUES (?,0,1) '
                       'ON CONFLICT(root) DO UPDATE SET allow_empty=1', (str(root),))

    def save_health(self, root, snapshot):
        with self.connection() as db:
            db.execute('INSERT OR REPLACE INTO health VALUES (?,?)', (str(root), json.dumps(snapshot)))

    def first_seen(self, paths):
        paths = {str(path) for path in paths}
        with self.connection() as db:
            return [stamp for path, stamp in db.execute('SELECT path,first_seen FROM tags WHERE first_seen IS NOT NULL')
                    if path in paths]

    def analysis_arrivals(self, root):
        """NULL/pre-baseline first_seen values belong to the existing library."""
        with self.connection() as db:
            return {path for (path,) in db.execute(
                'SELECT path FROM tags WHERE first_seen > '
                '(SELECT completed_at FROM analysis_baselines WHERE root=?)', (str(root),))}

    def repoint(self, root, old, new):
        """A linked move inherits arrival time, including pre-tracking NULLs."""
        # Recovery uses resolved paths; discovery retains the configured root's
        # spelling (for example a symlink to the library).
        old = root / old.resolve().relative_to(root.resolve())
        new = root / new.resolve().relative_to(root.resolve())
        with self.connection() as db:
            db.execute('INSERT INTO tags (path,mtime_ns,size,value,first_seen) '
                       'SELECT ?,-1,size,value,first_seen FROM tags WHERE path=? '
                       'ON CONFLICT(path) DO UPDATE SET first_seen=excluded.first_seen', (str(new), str(old)))

    def health(self, root):
        with self.connection() as db:
            row = db.execute('SELECT value FROM health WHERE root=?', (str(root),)).fetchone()
        return json.loads(row[0]) if row else None
