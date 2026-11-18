"""The helper lease mechanism, on the ledger's item record.

Every lease transition is a FULL SQLite transaction. A claim reserves the writer
before choosing work, so independent connections cannot hand out the same item.
Feature adapters supply wire views and result handlers, never lease policy.
"""
from __future__ import annotations

import json
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .kinds import Kinds

LEASE_STALE_S = 600.0
MAX_ATTEMPTS = 3
STATES = {'queued': 'queued', 'running': 'leased', 'done': 'done', 'failed': 'failed',
          'skipped': 'cancelled', 'interrupted': 'failed'}
CORE_FIELDS = {'status', 'lease', 'leased_by', 'leased_at', 'last_heartbeat', 'attempts',
               'phase', 'progress', 'error', 'offered_at', 'offeredAt', 'leasedBy'}
LANES = {'now': 0, 'new': 1, 'library': 2}


def lane(data):
    """Older foreground lyrics and background stems retain their meaning."""
    if data.get('lane'):
        return data['lane']
    if data.get('priority'):
        return 'library' if data['priority'] == 'background' else 'now'
    return 'library' if data.get('kind') == 'analysis' else 'now'


class Queue:
    def __init__(self, ledger, *, now=time.time):
        self.ledger, self.now = ledger, now
        self.kinds = Kinds()
        self.claim_guards = {}
        self.placement = None

    @classmethod
    def for_ledger(cls, ledger, *, now=time.time):
        if not hasattr(ledger, 'lease_queue'):
            ledger.lease_queue = cls(ledger, now=now)
        return ledger.lease_queue

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

    def _decode(self, row):
        if row is None:
            return None
        data = json.loads(row['queue_payload'])
        data.update(state='dead' if row['state'] == 'failed' else STATES[row['state']],
                    lease_until=row['lease_until'], max_attempts=row['max_attempts'],
                    id=row['queue_id'], kind=row['queue_kind'], status=STATES[row['state']],
                    lease=row['lease'], leased_by=row['holder'], leasedBy=row['holder'],
                    leased_at=row['leased_at'], last_heartbeat=row['heartbeat_at'],
                    attempts=row['attempts'], phase=row['phase'], progress=row['progress'],
                    error=row['error'], offered_at=row['offered_at'], offeredAt=row['offered_at'])
        return data

    def _select(self, where, args=()):
        return self.ledger.db.execute(f'''SELECT i.* FROM items i JOIN jobs j ON j.id=i.job_id
            WHERE i.queue_visible=1 AND i.attempt=j.attempt AND {where}''', args)

    def rows(self, kinds):
        with self.ledger.lock:
            marks = ','.join('?' for _ in kinds)
            return [self._decode(r) for r in self._select(f"i.queue_kind IN ({marks}) AND j.state NOT IN ('cancelled','interrupted')", tuple(kinds))]

    def get(self, id):
        with self.ledger.lock:
            return self._decode(self._select('i.queue_id=?', (id,)).fetchone())

    def enqueue(self, kind, key, payload, *, job_id=None, idx=0, attempt=None, max_attempts=MAX_ATTEMPTS, initial=None):
        """Idempotent per kind/key. Optional parent/index joins a lyrics batch."""
        definition = self.kinds[kind]
        if max_attempts < 1:
            raise ValueError('max_attempts must be positive')
        with self.transaction() as db:
            db.execute("""UPDATE items SET queue_visible=0,lease=NULL,lease_until=NULL
                WHERE queue_kind=? AND queue_key=? AND NOT EXISTS (
                    SELECT 1 FROM jobs j WHERE j.id=items.job_id AND j.attempt=items.attempt
                    AND j.state NOT IN ('cancelled','interrupted'))""", (kind, key))
            old = self._select('i.queue_kind=? AND i.queue_key=?', (kind, key)).fetchone()
            if old:
                return self._decode(old)
            if job_id is None:
                job_id = str(uuid.uuid4())
                db.execute("""INSERT INTO jobs (id,kind,label,state,attempt,total,created_at)
                    VALUES(?,?,?,'queued',1,1,?)""", (job_id, definition.ledger_kind, payload.get('item', key)[:120], self.now()))
                self.ledger._insert(job_id, 0, 1, {'item': payload.get('item', key)})
            attempt = attempt or self.ledger.get(job_id)['attempt']
            # A retry uses a new ledger item attempt, while retaining its wire id.
            id = payload.get('id') or uuid.uuid4().hex
            db.execute('UPDATE items SET queue_visible=0 WHERE queue_id=?', (id,))
            clean = {k: v for k, v in payload.items() if k not in CORE_FIELDS}
            initial = initial or {}
            attempts = initial.get('attempts', 0)
            exhausted = initial.get('status') == 'leased' and attempts >= max_attempts
            state = 'failed' if exhausted else {
                'done': 'done', 'failed': 'failed', 'cancelled': 'skipped'}.get(initial.get('status'), 'queued')
            error = f'el equipo dejó de responder {attempts} veces' if exhausted else initial.get('error')
            phase = payload.get('phase')
            if initial:
                phase = ((definition.failed_phase if state == 'failed' else definition.queued_phase) or phase)
            changed = db.execute('''UPDATE items SET queue_id=?,queue_kind=?,queue_key=?,queue_payload=?,
                queue_visible=1,failure_applied=0,offered_at=?,max_attempts=?,phase=?,
                state=?,attempts=?,error=?,reason=? WHERE job_id=? AND idx=? AND attempt=?''',
                (id, kind, key, json.dumps(clean), payload.get('offered_at', self.now()), max_attempts, phase,
                 state, attempts, error, 'error' if state == 'failed' else 'cancelled' if state == 'skipped' else None,
                 job_id, idx, attempt)).rowcount
            if not changed:
                raise ValueError('queue item is missing from ledger')
            self.ledger._bump()
            return self.get(id)

    def save_payload(self, data):
        """Persist feature metadata; lease fields can only change via queue methods."""
        clean = {k: v for k, v in data.items() if k not in CORE_FIELDS}
        payload = json.dumps(clean)
        with self.ledger.lock, self.ledger.db:
            changed = self.ledger.db.execute('''UPDATE items SET queue_payload=?
                WHERE queue_id=? AND queue_visible=1 AND queue_payload!=?''',
                                           (payload, data['id'], payload)).rowcount
            if changed:
                self.ledger._bump()

    def replace(self, id, payload):
        """Supersede an input in place, retaining its parent job and item index."""
        clean = {k: v for k, v in payload.items() if k not in CORE_FIELDS and k not in ('batchId', 'batchKeys')}
        with self.transaction() as db:
            row = self._select("i.queue_id=? AND i.state IN ('queued','running') AND j.state IN ('queued','running')", (id,)).fetchone()
            if row is None:
                return False
            db.execute('''UPDATE items SET queue_payload=?,state='queued',lease=NULL,lease_until=NULL,
                holder=NULL,leased_at=0,heartbeat_at=0,attempts=0,error=NULL,reason=NULL,
                progress=NULL,phase='queued',failure_applied=0 WHERE queue_id=? AND queue_visible=1''',
                       (json.dumps(clean), id))
            self.ledger._bump()
            return True

    def failure_pending(self, id):
        with self.ledger.lock:
            row = self._select("i.queue_id=? AND i.state='failed' AND i.failure_applied=0", (id,)).fetchone()
            return row is not None

    def failure_applied(self, id):
        with self.ledger.lock, self.ledger.db:
            self.ledger.db.execute('UPDATE items SET failure_applied=1 WHERE queue_id=?', (id,))

    def hide(self, id):
        with self.ledger.lock, self.ledger.db:
            changed = self.ledger.db.execute('UPDATE items SET queue_visible=0 WHERE queue_id=? AND queue_visible=1', (id,)).rowcount
            if changed:
                self.ledger._bump()

    def _live(self, id, lease):
        return self._select("i.queue_id=? AND i.lease=? AND i.state='running' AND i.lease_until>=? AND j.state IN ('queued','running')",
                            (id, lease, self.now())).fetchone()

    def owns(self, id, lease, holder=None):
        with self.ledger.lock:
            row = self._live(id, lease)
            return bool(row and (holder is None or row['holder'] == holder))

    def _recover(self, row):
        dead = row['attempts'] >= row['max_attempts']
        error = f"el equipo dejó de responder {row['attempts']} veces" if dead else row['error']
        definition = self.kinds[row['queue_kind']]
        phase = (definition.failed_phase if dead else definition.queued_phase) or row['phase']
        self.ledger.db.execute('''UPDATE items SET state=?,lease=NULL,lease_until=NULL,
            phase=?,progress=NULL,error=?,reason=? WHERE queue_id=? AND queue_visible=1''',
            ('failed' if dead else 'queued', phase, error,
             'error' if dead else None, row['queue_id']))
        self._outcome(row, error if dead else None)
        self.ledger._bump()
        return self.get(row['queue_id'])

    def _outcome(self, row, error=None):
        if error:
            detail = {**json.loads(row['detail']), 'reason': error}
            self.ledger.db.execute('UPDATE items SET detail=? WHERE job_id=? AND idx=? AND attempt=?',
                                   (json.dumps(detail), row['job_id'], row['idx'], row['attempt']))
        self.ledger._counts(row['job_id'])
        items = self.ledger.items(row['job_id'])
        if items and all(i['state'] not in ('queued', 'running') for i in items):
            job = self.ledger.get(row['job_id'])
            state = ('cancelled' if any(i['state'] == 'skipped' for i in items) and not job['succeeded']
                     else 'partial' if job['succeeded'] and (job['failed'] or job['skipped'])
                     else 'failed' if job['failed'] or job['skipped'] else 'succeeded')
            self.ledger.db.execute("UPDATE jobs SET state=?,ended_at=? WHERE id=? AND state IN ('queued','running')",
                                   (state, self.now(), row['job_id']))

    def recover(self, kinds, *, holder=None, restart=False):
        """Expiry, restart, and helper departure share the same attempt budget."""
        with self.transaction():
            marks = ','.join('?' for _ in kinds)
            rows = self._select(f"i.queue_kind IN ({marks}) AND i.state='running' AND j.state IN ('queued','running')", tuple(kinds)).fetchall()
            changed = []
            for row in rows:
                if restart or (holder is not None and row['holder'] == holder) or (holder is None and row['lease_until'] < self.now()):
                    changed.append(self._recover(row))
            return changed

    def defer_holder(self, holder):
        """A resource/window change is a deferral, not a failed attempt."""
        with self.transaction() as db:
            rows = self._select("i.holder=? AND i.state='running' AND j.state IN ('queued','running')", (holder,)).fetchall()
            for row in rows:
                db.execute('UPDATE items SET attempts=max(0,attempts-1) WHERE queue_id=? AND queue_visible=1',
                           (row['queue_id'],))
                self._recover(self._select('i.queue_id=?', (row['queue_id'],)).fetchone())

    def claim(self, kinds, holder, capabilities=None, *, eligible=lambda row: True):
        rows = self.claim_batch(kinds, holder, capabilities, eligible=eligible, limit=1)
        return rows[0] if rows else None

    def claim_batch(self, kinds, holder, capabilities=None, *, eligible=lambda row: True, limit=25):
        """Reserve up to ``limit`` items of one kind under a single lease."""
        if not 1 <= limit <= 25:
            raise ValueError('claim limit must be between 1 and 25')
        kinds = tuple(kinds)
        with self.transaction() as db:
            marks = ','.join('?' for _ in kinds)
            stale = self._select(f"i.queue_kind IN ({marks}) AND i.state='running' AND i.lease_until<? AND j.state IN ('queued','running')", (*kinds, self.now())).fetchall()
            for row in stale:
                self._recover(row)
            if self._select("i.holder=? AND i.state='running' AND j.state IN ('queued','running')", (holder,)).fetchone():
                return []
            # Compare all registered adapters, including legacy single-kind
            # endpoints. A caller cannot leapfrog another kind's eligible turn.
            candidates = tuple(set(kinds) | {k.name for k in self.kinds if k.can_claim})
            marks = ','.join('?' for _ in candidates)
            rows = self._select(f"i.queue_kind IN ({marks}) AND i.state='queued' AND j.state IN ('queued','running')", candidates).fetchall()
            available, counts = [], {}
            for row in sorted(rows, key=lambda r: r['offered_at']):
                data = self._decode(row)
                tier = lane(data)
                bucket = (tier, row['queue_kind'])
                # Only one eligible head is needed to compare another kind's
                # turn; avoid stat/feature probes for an entire library pass.
                if counts.get(bucket, 0) >= (limit if row['queue_kind'] in kinds else 1):
                    continue
                definition = self.kinds[row['queue_kind']]
                if capabilities is not None and not set(data.get('needs', definition.needs)).issubset(capabilities):
                    continue
                if self.placement and self.placement(data, holder):
                    continue
                if definition.can_claim and not definition.can_claim(data, holder):
                    continue
                if holder in self.claim_guards and not self.claim_guards[holder](data):
                    continue
                if row['queue_kind'] in kinds and not eligible(data):
                    continue
                if row['attempts'] >= row['max_attempts']:
                    self._recover(row)
                    continue
                available.append((row, tier))
                counts[bucket] = counts.get(bucket, 0) + 1
            if not available:
                return []
            selected_lane = min((v for _, v in available), key=LANES.__getitem__)
            turns = dict(db.execute('SELECT lane,kind FROM queue_turns'))
            order = sorted({r['queue_kind'] for r, v in available if v == selected_lane},
                           key=lambda k: (self.kinds[k].order, k))
            last = turns.get(selected_lane)
            if last in order:
                index = order.index(last) + 1
                order = order[index:] + order[:index]
            selected_kind = order[0]
            if selected_kind not in kinds:
                return []
            rows = sorted((r for r, v in available if v == selected_lane and r['queue_kind'] == selected_kind),
                          key=lambda r: r['offered_at'])
            handed, lease = [], uuid.uuid4().hex
            for row in rows:
                definition = self.kinds[selected_kind]
                if definition.provenance:
                    payload = json.loads(row['queue_payload'])
                    payload['provenance'] = definition.provenance(holder)
                    db.execute('UPDATE items SET queue_payload=? WHERE queue_id=? AND queue_visible=1',
                               (json.dumps(payload), row['queue_id']))
                claimed = db.execute('''UPDATE items SET state='running',lease=?,holder=?,leased_at=?,
                    heartbeat_at=?,lease_until=?,attempts=attempts+1,phase='claimed',progress=NULL,error=NULL
                    WHERE queue_id=? AND queue_visible=1 AND state='queued' RETURNING *''',
                    (lease, holder, self.now(), self.now(), self.now()+LEASE_STALE_S, row['queue_id'])).fetchone()
                db.execute("UPDATE jobs SET state='running',started_at=coalesce(started_at,?) WHERE id=?", (self.now(), row['job_id']))
                self.ledger._bump()
                handed.append(self._decode(claimed))
                if len(handed) == limit:
                    break
            if handed:
                db.execute('INSERT OR REPLACE INTO queue_turns VALUES (?,?)', (selected_lane, selected_kind))
            if handed and limit > 1:
                # Keep the batch address valid if its first item is superseded.
                # Queue keys are feature identities, opaque to the mechanism.
                keys = [self._select('i.queue_id=?', (r['id'],)).fetchone()['queue_key'] for r in handed]
                for data in handed:
                    data.update(batchId=handed[0]['id'], batchKeys=keys)
                    clean = {k: v for k, v in data.items() if k not in CORE_FIELDS}
                    db.execute('UPDATE items SET queue_payload=? WHERE queue_id=? AND queue_visible=1',
                               (json.dumps(clean), data['id']))
            return handed

    def heartbeat(self, id, lease, phase=None, progress=None):
        row = self.get(id)
        if row and self.owns(id, lease) and self.placement and self.placement(row, row['leased_by']):
            self.defer_holder(row['leased_by'])
            return {'stop': True, 'reason': 'lease-lost'}
        with self.transaction() as db:
            if not self._live(id, lease):
                return {'stop': True, 'reason': 'lease-lost'}
            db.execute('''UPDATE items SET heartbeat_at=?,lease_until=?,phase=coalesce(?,phase),
                progress=CASE WHEN ? IS NULL THEN progress ELSE ? END WHERE queue_id=? AND queue_visible=1''',
                (self.now(), self.now()+LEASE_STALE_S, phase, phase, progress, id))
            self.ledger._bump()
            return {'stop': False}

    def complete(self, id, lease, *args, execution=None, **kwargs):
        """Fence the result handler and transition together under the writer lock."""
        with self.transaction() as db:
            row = self._live(id, lease)
            if row is None:
                return False
            # Result application must not call ledger mutation methods: they commit.
            self.kinds[row['queue_kind']].apply_result(self._decode(row), *args, **kwargs)
            self._record_provenance(row, execution)
            db.execute("UPDATE items SET state='done',lease_until=NULL WHERE queue_id=? AND queue_visible=1", (id,))
            self._outcome(row)
            self.ledger._bump()
            return True

    def _record_provenance(self, row, execution=None):
        data = json.loads(row['queue_payload'])
        if provenance := data.get('provenance'):
            result = {**provenance, **(execution or {}), 'seconds': max(0, self.now() - row['leased_at'])}
            detail = {**json.loads(row['detail']), 'result': result}
            self.ledger.db.execute('UPDATE items SET detail=? WHERE job_id=? AND idx=? AND attempt=?',
                                   (json.dumps(detail), row['job_id'], row['idx'], row['attempt']))

    def fail(self, id, lease, reason, *, final=True):
        with self.transaction() as db:
            row = self._live(id, lease)
            if row is None:
                return None
            self._record_provenance(row)
            row = self._live(id, lease)
            retry = not final and row['attempts'] < row['max_attempts']
            definition = self.kinds[row['queue_kind']]
            phase = (definition.queued_phase if retry else definition.failed_phase) or row['phase']
            visible_error = reason[:200] if not retry or definition.show_retry_error else row['error']
            db.execute('''UPDATE items SET state=?,lease=NULL,lease_until=NULL,phase=?,progress=NULL,
                error=?,reason=? WHERE queue_id=? AND queue_visible=1''',
                ('queued' if retry else 'failed', phase, visible_error,
                 None if retry else 'error', id))
            self._outcome(row, None if retry else reason[:200])
            self.ledger._bump()
            return retry

    def cancel(self, id):
        with self.transaction() as db:
            row = self._select("i.queue_id=? AND i.state IN ('queued','running')", (id,)).fetchone()
            if row is None:
                return False
            db.execute("UPDATE items SET state='skipped',lease=NULL,lease_until=NULL,error='cancelado',reason='cancelled' WHERE queue_id=? AND queue_visible=1", (id,))
            self._outcome(row)
            self.ledger._bump()
            return True

    def receipts(self, kinds):
        with self.ledger.lock:
            marks = ','.join('?' for _ in kinds)
            return {r[0]: json.loads(r[1]) for r in self.ledger.db.execute(
                f'SELECT lease,receipt FROM queue_receipts WHERE kind IN ({marks})', tuple(kinds))}

    def receipt(self, kind, lease, data):
        with self.ledger.lock, self.ledger.db:
            self.ledger.db.execute('INSERT OR IGNORE INTO queue_receipts VALUES(?,?,?)', (lease, kind, json.dumps(data)))

    def migrate(self, path: Path, member, prepare, *, default_kind):
        """Crash-safe import: enqueue is idempotent; the marker precedes rename."""
        with self.ledger.lock:
            done = self.ledger.db.execute('SELECT 1 FROM queue_migrations WHERE path=?', (str(path),)).fetchone()
            if not path.exists():
                return
            if not done:
                raw = json.loads(path.read_text(encoding='utf-8'))
                imported = []
                for data in raw.get(member, []):
                    if isinstance(data, dict) and data.get('id'):
                        kind, key, payload, link = prepare(data)
                        existing = self.ledger.db.execute('SELECT queue_id FROM items WHERE queue_id=?', (payload['id'],)).fetchone()
                        if existing:
                            # A prior boot may have committed part of the import.
                            # Its work may since have been leased or completed.
                            imported.append(payload['id'])
                            continue
                        result = self.enqueue(kind, key, payload, initial=data, **link)
                        imported.append(result['id'])
                with self.transaction():
                    for id in imported:
                        row = self.ledger.db.execute('SELECT * FROM items WHERE queue_id=? ORDER BY attempt DESC LIMIT 1', (id,)).fetchone()
                        self._outcome(row, row['error'] if row['state'] == 'failed' else None)
                    if imported:
                        self.ledger._bump()
                for lease, receipt in raw.get('receipts', {}).items():
                    kind = receipt.get('row', {}).get('kind') or default_kind
                    self.receipt(kind, lease, receipt)
                with self.ledger.db:
                    self.ledger.db.execute('INSERT INTO queue_migrations VALUES(?)', (str(path),))
            path.rename(path.with_name(path.name + '.migrated'))
