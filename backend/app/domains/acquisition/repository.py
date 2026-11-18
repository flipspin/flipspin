"""Acquisition records share the ledger connection, lock, and commit boundary."""
import hashlib
import json
import uuid
import unicodedata
from contextlib import contextmanager

from .models import AcquisitionError
from .request_job import RequestJob

from .sources.compat import LEGACY_SOURCE_ID

OPEN = ('pending', 'approved', 'fetching', 'importing')


class Requests:
    def __init__(self, ledger):
        self.ledger = ledger

    @staticmethod
    def search_key(query, source=LEGACY_SOURCE_ID):
        # Namespacing also expires pre-protocol extractor-shaped cache rows.
        query = ' '.join(unicodedata.normalize('NFKC', query).casefold().split())
        return json.dumps([source, query])

    def search_get(self, query, source=LEGACY_SOURCE_ID):
        with self.ledger.lock:
            row = self.ledger.db.execute(
                'SELECT results FROM acquisition_search WHERE query=? AND expires_at>?',
                (self.search_key(query, source), self.ledger.now())).fetchone()
            return json.loads(row[0]) if row else None

    def search_put(self, query, results, source=LEGACY_SOURCE_ID):
        with self.ledger.lock, self.ledger.db:
            self.ledger.db.execute('DELETE FROM acquisition_search WHERE expires_at<=?', (self.ledger.now(),))
            self.ledger.db.execute('INSERT OR REPLACE INTO acquisition_search VALUES(?,?,?)',
                                   (self.search_key(query, source), json.dumps(results), self.ledger.now() + 7 * 86400))
            # Bound the memo even when a busy server never leaves entries idle.
            self.ledger.db.execute('''DELETE FROM acquisition_search WHERE query IN (
                SELECT query FROM acquisition_search ORDER BY expires_at DESC LIMIT -1 OFFSET 10000)''')

    def search_forget(self, query, source=LEGACY_SOURCE_ID):
        if query:
            with self.ledger.lock, self.ledger.db:
                self.ledger.db.execute('DELETE FROM acquisition_search WHERE query=?', (self.search_key(query, source),))

    @contextmanager
    def transaction(self):
        with self.ledger.lock:
            self.ledger.db.execute('BEGIN IMMEDIATE')
            try:
                yield self.ledger.db
                self.ledger.db.commit()
            except BaseException:
                self.ledger.db.rollback()
                raise

    def get(self, id, account):
        with self.ledger.lock:
            row = self.ledger.db.execute('SELECT * FROM acquisition_requests WHERE id=? AND account_id=?',
                                         (id, account)).fetchone()
            if row is None:
                raise AcquisitionError('not-found', 404)
            return dict(row)

    def list(self, account):
        with self.ledger.lock:
            return [dict(r) for r in self.ledger.db.execute(
                'SELECT * FROM acquisition_requests WHERE account_id=? AND dismissed_at IS NULL ORDER BY created_at DESC', (account,))]

    def dismiss_finished(self, account) -> int:
        with self.transaction() as db:
            placeholders = ','.join('?' for _ in OPEN)
            count = db.execute(
                f'''UPDATE acquisition_requests SET dismissed_at=?
                    WHERE account_id=? AND dismissed_at IS NULL AND state NOT IN ({placeholders})''',
                (self.ledger.now(), account, *OPEN)).rowcount
            if count:
                self.ledger._bump()
            return count

    def dismiss_one(self, id, account) -> int:
        with self.transaction() as db:
            row = self.get(id, account)
            if row['state'] in OPEN:
                raise AcquisitionError('not-finished')
            count = db.execute(
                'UPDATE acquisition_requests SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL',
                (self.ledger.now(), id)).rowcount
            if count:
                self.ledger._bump()
            return count

    def create(self, body, principal, *, key=None, job_id=None, before_create=lambda: None, source_id=None):
        encoded = json.dumps(body, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        account = principal.user_id
        with self.transaction() as db:
            db.execute('DELETE FROM idempotency_keys WHERE created_at<?', (self.ledger.now()-86400,))
            if key:
                old = db.execute("SELECT * FROM idempotency_keys WHERE key=? AND account_id=? AND route='acquisition'",
                                 (key, account)).fetchone()
                if old:
                    if old['body_hash'] != digest:
                        raise AcquisitionError('idempotency-conflict', 422)
                    return json.loads(old['response']), False
            old = db.execute("SELECT * FROM acquisition_requests WHERE account_id=? AND provider=? AND provider_id=? AND state IN ('pending','approved','fetching','importing')",
                             (account, body['provider'], body['provider_id'])).fetchone()
            fresh = old is None
            if fresh:
                before_create()
                id = str(uuid.uuid4())
                now = self.ledger.now()
                db.execute("""INSERT INTO acquisition_requests
                           (id,account_id,kind,provider,provider_id,title,state,created_at,
                            decided_by,decided_at,expected_tracks,imported_tracks)
                           VALUES(?,?,?,?,?,?,'approved',?,?,?, ?,0)""",
                           (id, account, body['kind'], body['provider'], body['provider_id'], body['title'],
                            now, account, now, len(body['tracks'])))
                db.execute('INSERT INTO acquisition_work VALUES(?,?,?,?)',
                           (id, encoded, job_id or id, json.dumps(principal.__dict__)))
                RequestJob.create(self.ledger, id, {'job_id': job_id or id, 'body': body}, None,
                                  principal, None, transaction=True, **({"source_id": source_id} if source_id else {}))
                self.ledger._bump()
                response = dict(db.execute('SELECT * FROM acquisition_requests WHERE id=?', (id,)).fetchone())
            else:
                response = dict(old)
            if key:
                db.execute("INSERT INTO idempotency_keys VALUES(?,?,'acquisition',?,200,?,?)",
                           (key, account, digest, json.dumps(response), self.ledger.now()))
            return response, fresh

    def state(self, id, state, *, imported=None):
        with self.ledger.lock, self.ledger.db:
            row = self.ledger.db.execute('SELECT state FROM acquisition_requests WHERE id=?', (id,)).fetchone()
            allowed = {'pending': {'approved', 'rechazado'}, 'approved': {'fetching', 'rechazado', 'fallido'},
                       'fetching': {'importing', 'fallido'}, 'importing': {'completo', 'parcial', 'fallido'},
                       'fallido': {'approved'}, 'parcial': {'approved'}}
            if row is None or (state != row[0] and state not in allowed.get(row[0], set())):
                raise AcquisitionError('invalid-state')
            self.ledger.db.execute('UPDATE acquisition_requests SET state=?, imported_tracks=coalesce(?,imported_tracks) WHERE id=?',
                                   (state, imported, id))
            self.ledger._bump()

    def work(self, id):
        with self.ledger.lock:
            row = self.ledger.db.execute('SELECT * FROM acquisition_work WHERE request_id=?', (id,)).fetchone()
            return {**dict(row), 'body': json.loads(row['body']), 'principal': json.loads(row['principal'])}

    def stage(self, id, stage, tracks, principal, *, share=True):
        with self.ledger.lock:
            row = self.ledger.db.execute('SELECT job_id FROM acquisition_stages WHERE request_id=? AND stage=?', (id, stage)).fetchone()
            if row:
                return row[0]
            # Same catalog item, same expected list: a second account references
            # the first fetch job rather than creating a second download batch.
            if stage == 'fetch' and share:
                shared = self.ledger.db.execute('''SELECT s.job_id FROM acquisition_stages s
                    JOIN acquisition_requests r ON r.id=s.request_id
                    JOIN acquisition_requests mine ON mine.id=?
                    JOIN jobs j ON j.id=s.job_id
                    JOIN acquisition_work w ON w.request_id=r.id
                    WHERE s.stage='fetch' AND r.provider=mine.provider AND r.provider_id=mine.provider_id
                    AND json_extract(w.body, '$._source_urls') IS NULL
                    AND j.total=? AND j.state IN ('queued','running','succeeded')
                    ORDER BY j.created_at DESC LIMIT 1''', (id, len(tracks))).fetchone()
                if shared:
                    expected = [(t['item'], t['detail']['index']) for t in tracks]
                    actual = [(t['item'], t['detail']['index']) for t in self.ledger.items(shared[0])]
                    if expected != actual:
                        shared = None
                if shared:
                    with self.ledger.db:
                        self.ledger.db.execute('INSERT INTO acquisition_stages VALUES(?,?,?)', (id, stage, shared[0]))
                    return shared[0]
            job_id = str(uuid.uuid4())
            self.ledger.start(f'acquisition-{stage}', stage, tracks, principal, job_id=job_id)
            with self.ledger.db:
                self.ledger.db.execute('INSERT INTO acquisition_stages VALUES(?,?,?)', (id, stage, job_id))
                self.ledger.db.execute('UPDATE jobs SET parent_id=? WHERE id=?', (id, job_id))
            return job_id

    def mark_waiting(self, db, provider, until, kind):
        rows = db.execute("SELECT i.* FROM items i JOIN jobs j ON j.id=i.job_id WHERE j.kind IN ('acquisition-fetch','acquisition-match') AND j.state IN ('queued','running') AND i.state IN ('queued','running')").fetchall()
        for row in rows:
            detail = json.loads(row['detail'])
            if detail.get('provider') == provider:
                detail.update(until=until, kind=kind)
                db.execute("UPDATE items SET reason=?,detail=? WHERE job_id=? AND idx=? AND attempt=?",
                           ('en-pausa' if until else None, json.dumps(detail), row['job_id'], row['idx'], row['attempt']))
