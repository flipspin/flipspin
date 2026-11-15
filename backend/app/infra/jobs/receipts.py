"""Read publication receipts without opening or mutating the job ledger."""
import hashlib
import json
import sqlite3
from pathlib import Path

from app.utils.library_paths import rel_path_for


class LibraryReceipts(dict):
    def __init__(self):
        super().__init__()
        self.by_sha = {}

    def for_path(self, root, path):
        rel = rel_path_for(root, path)
        if rel is None:
            return None, None
        if rel in self:
            stamp, sha = self[rel]
            return min(stamp, self.by_sha.get(sha, stamp)), sha
        if self.by_sha and path.is_file():
            with path.open('rb') as source:
                sha = hashlib.file_digest(source, 'sha256').hexdigest()
            if sha in self.by_sha:
                return self.by_sha[sha], sha
        return None, None


def library_receipts(path, root):
    receipts = LibraryReceipts()
    if path is None or not Path(path).is_file():
        return receipts
    def remember(path, stamp, sha=None):
        if not path or stamp is None:
            return
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = root / candidate
        rel = rel_path_for(root, candidate)
        if rel:
            previous = receipts.get(rel)
            stamp = min(float(stamp), previous[0]) if previous else float(stamp)
            sha = sha or (previous[1] if previous else None)
            receipts[rel] = (stamp, sha)
            if sha:
                receipts.by_sha[sha] = min(stamp, receipts.by_sha.get(sha, stamp))

    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {'jobs', 'items'} <= tables:
            for row in db.execute('''SELECT i.detail,i.rel_path,j.created_at,j.kind FROM items i
                    JOIN jobs j ON j.id=i.job_id WHERE i.state='done'
                    AND j.kind IN ('download','import','acquisition-import')'''):
                detail = json.loads(row['detail'])
                remember(detail.get('_path') or row['rel_path'], row['created_at'], detail.get('sha256'))
        if {'upload_items', 'jobs', 'acquisition_requests'} <= tables:
            columns = {r[1] for r in db.execute('PRAGMA table_info(upload_items)')}
            published = 'u.published_path' if 'published_path' in columns else 'NULL'
            received = 'u.received_at,' if 'received_at' in columns else ''
            for row in db.execute(f'''SELECT u.hit,{published} AS published,u.sha256,
                    coalesce({received}j.created_at,r.created_at,u.updated) AS received
                    FROM upload_items u LEFT JOIN jobs j ON j.id=u.batch
                    LEFT JOIN acquisition_requests r ON r.id=u.request_id'''):
                remember(row['published'] or row['hit'], row['received'], row['sha256'])
    finally:
        db.close()
    return receipts
