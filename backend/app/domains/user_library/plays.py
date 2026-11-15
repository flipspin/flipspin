"""Durable, account-scoped listening receipts. Listening never adds membership."""
from datetime import UTC, datetime
from uuid import uuid4

from app.infra.idempotency import database


def record_batch(path, store, account, plays, *, source='desktop', device_id=None):
    accepted = 0
    with database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        for play in plays:
            row = store.get(account, play.trackKey)
            if row is None:
                continue
            db.execute('INSERT OR IGNORE INTO plays_baselines VALUES(?,?,?)', (account, play.trackKey, row.play_count))
            at = play.listenedAt.astimezone(UTC).isoformat()
            inserted = db.execute('INSERT OR IGNORE INTO plays VALUES(?,?,?,?)', (account, play.trackKey, at, play.clientPlayId)).rowcount
            if inserted:
                started = getattr(play, 'startedAt', None) or play.listenedAt
                db.execute('''INSERT INTO play_events
                    (id,user_id,track_key,started_at,listened_at,duration_played_s,completed,source,device_id)
                    VALUES(?,?,?,?,?,?,?,?,?)''',
                    (uuid4().hex, account, play.trackKey, started.astimezone(UTC).isoformat(), at,
                     getattr(play, 'playedSeconds', None), getattr(play, 'completed', True),
                     getattr(play, 'source', None) or source, device_id))
            accepted += inserted
    # SQLite is the authority. Rebuild statistics, including after a crash
    # between committing the events and writing the JSON view. Baselines retain
    # counts recorded before receipts existed; no historical listens are invented.
    with database(path) as db:
        for key, count, last in db.execute('''
            SELECT b.track_key,b.count+count(e.id),max(e.listened_at)
            FROM plays_baselines b JOIN play_events e
                ON e.user_id=b.account_id AND e.track_key=b.track_key
            WHERE b.account_id=? GROUP BY b.track_key''', (account,)):
            store.set_play_stats(account, key, count, last)
    return {'accepted': accepted}


def repoint(path, store, old, new):
    """Move every person's history, including ghosts with no membership row.

    Receipt collisions still deduplicate retries. Events are never collapsed:
    two distinct recordings merged onto one key keep both listening histories.
    Seed any pre-receipt counters before the membership rows are merged.
    """
    if old == new:
        return
    with database(path) as db:
        db.execute('BEGIN IMMEDIATE')
        for key in (old, new):
            for row in store.references_for_path(key):
                db.execute('INSERT OR IGNORE INTO plays_baselines VALUES(?,?,?)',
                           (row.user_id, key, row.play_count))
        db.execute('''INSERT INTO plays_baselines(account_id,track_key,count)
            SELECT account_id,?,count FROM plays_baselines WHERE track_key=?
            ON CONFLICT(account_id,track_key) DO UPDATE SET count=count+excluded.count''', (new, old))
        db.execute('DELETE FROM plays_baselines WHERE track_key=?', (old,))
        db.execute('UPDATE play_events SET track_key=? WHERE track_key=?', (new, old))
        db.execute('''INSERT OR IGNORE INTO plays(account_id,track_key,listened_at,client_play_id)
            SELECT account_id,?,listened_at,client_play_id FROM plays WHERE track_key=?''', (new, old))
        db.execute('DELETE FROM plays WHERE track_key=?', (old,))


def history(path, account, *, start=None, end=None, after=None, limit=100):
    """Newest-first keyset pages; the cursor stays valid when paths are moved."""
    clauses, values = ['user_id=?'], [account]
    if start is not None:
        clauses.append('started_at>=?')
        values.append(start.astimezone(UTC).isoformat())
    if end is not None:
        clauses.append('started_at<?')
        values.append(end.astimezone(UTC).isoformat())
    with database(path) as db:
        if after is not None:
            cursor = db.execute('SELECT started_at,id FROM play_events WHERE user_id=? AND id=?',
                                (account, after)).fetchone()
            if cursor is None:
                raise ValueError('Unknown history cursor')
            clauses.append('(started_at,id)<(?,?)')
            values.extend(cursor)
        rows = db.execute('''SELECT id,track_key,started_at,duration_played_s,completed,source,device_id
            FROM play_events WHERE ''' + ' AND '.join(clauses) +
            ' ORDER BY started_at DESC,id DESC LIMIT ?', (*values, limit + 1)).fetchall()
    events = [dict(id=r[0], relPath=r[1], startedAt=r[2], playedSeconds=r[3],
                   completed=bool(r[4]), source=r[5], deviceId=r[6]) for r in rows[:limit]]
    return {'events': events, 'nextCursor': events[-1]['id'] if len(rows) > limit else None}


def valid_time(value):
    if value.tzinfo is None:
        raise ValueError('listenedAt must include a timezone')
    if (value - datetime.now(UTC)).total_seconds() > 3600:
        raise ValueError('listenedAt is more than one hour in the future')
    return value
