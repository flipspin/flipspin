"""Durable run membership and audit, independent of the short-lived job ledger."""
import json
from datetime import UTC, datetime, timedelta

from app.domains.music.analysis_precedence import precedence


def timestamp():
    return datetime.now(UTC).isoformat()


def record_outcome(db, rel, before=None, after=None, *, failed=False):
    """Called inside the analysis write transaction; joined runs observe it too."""
    rows = db.execute('''SELECT r.* FROM analysis_run r JOIN analysis_run_track t ON t.run_id=r.id
        WHERE t.rel_path=? AND t.state='pending' AND r.state='live' ''', (rel,)).fetchall()
    changed = before != after
    for run in rows:
        counts = json.loads(run['counts'])
        if failed:
            counts['failed'] += 1
        else:
            counts['changed' if changed else 'same'] += 1
            old, new = precedence(before), precedence(after)
            for field in ('key', 'bpm'):
                if old[field]['value'] is not None and new[field]['value'] is not None:
                    counts['toEstimated'] += int(not old[field]['estimated'] and new[field]['estimated'])
                    counts['toConfident'] += int(old[field]['estimated'] and not new[field]['estimated'])
            if changed:
                db.execute('INSERT OR IGNORE INTO analysis_history VALUES (?,?,?,?)',
                           (run['id'], rel, json.dumps(before), timestamp()))
        db.execute('UPDATE analysis_run_track SET state=? WHERE run_id=? AND rel_path=?',
                   ('failed' if failed else 'done', run['id'], rel))
        db.execute('UPDATE analysis_run SET counts=? WHERE id=?', (json.dumps(counts), run['id']))


class RunRepository:
    def __init__(self, repository):
        self.repository = repository

    def response(self, request_id):
        with self.repository.connection() as db:
            row = db.execute('SELECT response FROM analysis_request WHERE request_id=?', (request_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def remember(self, request_id, response):
        with self.repository.connection() as db:
            db.execute('INSERT INTO analysis_request VALUES (?,?)', (request_id, json.dumps(response)))
        return response

    def live(self):
        with self.repository.connection() as db:
            return [dict(r) for r in db.execute("SELECT * FROM analysis_run WHERE state='live' ORDER BY requested_at")]

    def tracks(self, run_id):
        with self.repository.connection() as db:
            return [{**dict(r), 'payload': json.loads(r['payload'])} for r in db.execute(
                'SELECT * FROM analysis_run_track WHERE run_id=? ORDER BY idx', (run_id,))]

    def create(self, run, tracks, response):
        with self.repository.connection() as db:
            db.execute('''INSERT INTO analysis_run
                (id,request_id,mode,scope,size,job_id,requested_by,requested_at,nest_allowed,state,counts,response)
                VALUES (?,?,?,?,?,?,?,?,?,'live',?,?)''',
                tuple(run[k] for k in ('id', 'request_id', 'mode', 'scope', 'size', 'job_id',
                                      'requested_by', 'requested_at', 'nest_allowed')) +
                (json.dumps(run['counts']), json.dumps(response)))
            db.executemany('''INSERT INTO analysis_run_track (run_id,rel_path,idx,payload,owned)
                VALUES (?,?,?,?,?)''', [(run['id'], t['relPath'], idx, json.dumps(t), t['owned'])
                                      for idx, t in enumerate(tracks)])
            db.execute('INSERT INTO analysis_request VALUES (?,?)', (run['request_id'], json.dumps(response)))

    def end(self, run_id, state):
        with self.repository.connection() as db:
            changed = db.execute("UPDATE analysis_run SET state=?,ended_at=? WHERE id=? AND state='live'",
                                 (state, timestamp(), run_id)).rowcount
            # Keep changed-value history for at most three runs and thirty days.
            db.execute('''DELETE FROM analysis_history WHERE created_at < ? OR run_id NOT IN (
                SELECT id FROM analysis_run ORDER BY requested_at DESC LIMIT 3)''',
                       ((datetime.now(UTC) - timedelta(days=30)).isoformat(),))
            return bool(changed)

    def replace(self, rel, payload):
        with self.repository.connection() as db:
            for row in db.execute('''SELECT t.* FROM analysis_run_track t JOIN analysis_run r ON r.id=t.run_id
                WHERE t.rel_path=? AND t.state='pending' AND r.state='live' ''', (rel,)).fetchall():
                saved = json.loads(row['payload'])
                saved.update({k: payload[k] for k in ('size', 'mtimeNs')})
                db.execute('UPDATE analysis_run_track SET payload=? WHERE run_id=? AND rel_path=?',
                           (json.dumps(saved), row['run_id'], rel))

    def cancelled(self):
        with self.repository.connection() as db:
            return {r['rel_path']: json.loads(r['payload']) for r in db.execute('''
                SELECT t.* FROM analysis_run_track t JOIN analysis_run r ON r.id=t.run_id
                WHERE r.state='cancelled' AND t.state='pending' ORDER BY r.requested_at''')}
