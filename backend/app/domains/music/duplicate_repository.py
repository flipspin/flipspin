"""Duplicate scan snapshots and pair preferences in the backed-up music store."""
import json


def duplicate_schema(db):
    db.execute('''CREATE TABLE duplicate_scan (
        root TEXT PRIMARY KEY, job_id TEXT NOT NULL, result TEXT NOT NULL
    )''')
    db.execute('''CREATE TABLE duplicate_pair (
        root TEXT NOT NULL, left_path TEXT NOT NULL, right_path TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0, keeper TEXT,
        PRIMARY KEY(root,left_path,right_path)
    )''')
    db.execute('''CREATE TABLE duplicate_fingerprint (
        root TEXT NOT NULL, rel_path TEXT NOT NULL, signature TEXT NOT NULL,
        fingerprint TEXT, PRIMARY KEY(root,rel_path)
    )''')


class DuplicateRepository:
    def __init__(self, music_store):
        self.music_store = music_store

    def scan(self, root):
        with self.music_store.connection() as db:
            row = db.execute('SELECT job_id,result FROM duplicate_scan WHERE root=?', (root,)).fetchone()
        return (row[0], json.loads(row[1])) if row else (None, {'candidates': [], 'audio': 'not-scanned', 'audioSkipped': 0})

    def store_scan(self, root, job_id, result):
        with self.music_store.connection() as db:
            db.execute('INSERT OR REPLACE INTO duplicate_scan VALUES (?,?,?)', (root, job_id, json.dumps(result)))

    def pairs(self, root):
        with self.music_store.connection() as db:
            return {(r['left_path'], r['right_path']): dict(r) for r in
                    db.execute('SELECT * FROM duplicate_pair WHERE root=?', (root,))}

    def prefer(self, root, left, right, *, dismissed=False, keeper=None):
        left, right = sorted((left, right))
        with self.music_store.connection() as db:
            db.execute('''INSERT INTO duplicate_pair VALUES (?,?,?,?,?)
                ON CONFLICT(root,left_path,right_path) DO UPDATE SET dismissed=excluded.dismissed,keeper=excluded.keeper''',
                (root, left, right, int(dismissed), keeper))

    def fingerprint(self, root, rel, signature):
        with self.music_store.connection() as db:
            row = db.execute('SELECT fingerprint FROM duplicate_fingerprint WHERE root=? AND rel_path=? AND signature=?',
                             (root, rel, signature)).fetchone()
        return (True, row[0]) if row else (False, None)

    def save_fingerprint(self, root, rel, signature, value):
        with self.music_store.connection() as db:
            db.execute('INSERT OR REPLACE INTO duplicate_fingerprint VALUES (?,?,?,?)', (root, rel, signature, value))
