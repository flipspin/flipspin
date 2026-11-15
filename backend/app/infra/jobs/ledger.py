"""Durable jobs and per-item outcomes, shared with the helper lease queue.

All mutations are serialized on one connection; state and attempt fence late
completions. The tracker is a disposable cache, never the authority for actions.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path

LIVE = ('queued', 'running')
TERMINAL = ('succeeded', 'partial', 'failed', 'cancelled', 'interrupted')
RETRY = ('failed', 'skipped', 'interrupted')
logger = logging.getLogger(__name__)


class JobConflict(ValueError):
    pass


class Jobs:
    def __init__(self, path: Path, *, now=time.time, on_change: Callable[[], None] | None = None):
        self.path, self.now = Path(path), now
        self._on_change = on_change
        self.lock = threading.RLock()
        self._phase_dirty = False
        self._phase_at = float('-inf')
        from app.infra.jobs.schema import JOBS
        from app.infra.migrations import open_store

        self.db = open_store(self.path, JOBS)

    def close(self):
        with self.lock:
            self.db.close()

    def _bump(self):
        self.db.execute('UPDATE ledger_version SET version=version+1')
        if self._on_change:
            self._on_change()

    def touch(self):
        """Invalidate job projections when a composed external input changes."""
        with self.lock, self.db:
            self._bump()

    @property
    def version(self):
        with self.lock:
            version = self.db.execute('SELECT version FROM ledger_version').fetchone()[0]
            # A pending phase becomes visible after the coalescing window without
            # writing on a poll. Maintenance or the next writer persists it.
            return version + int(self._phase_dirty and self.now() - self._phase_at >= 1)

    def flush_phases(self):
        with self.lock, self.db:
            if self._phase_dirty and self.now() - self._phase_at >= 1:
                self._phase_at, self._phase_dirty = self.now(), False
                self._bump()

    def phase_changed(self):
        with self.lock, self.db:
            self._phase_dirty = True
            if self.now() - self._phase_at >= 1:
                self._phase_at, self._phase_dirty = self.now(), False
                self._bump()
            elif self._on_change:
                # Coalesce the durable version, but push live phase changes now.
                self._on_change()

    def get(self, job_id):
        with self.lock:
            row = self.db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            return dict(row) if row else None

    def list(self):
        with self.lock:
            return [dict(r) for r in self.db.execute('SELECT * FROM jobs WHERE cleared_at IS NULL ORDER BY created_at DESC')]

    def items(self, job_id, state=None):
        with self.lock:
            rows = self.db.execute('''SELECT i.* FROM items i WHERE job_id=? AND attempt=(
                SELECT max(j.attempt) FROM items j WHERE j.job_id=i.job_id AND j.idx=i.idx)
                ORDER BY idx''', (job_id,)).fetchall()
            return [{**dict(r), 'detail': json.loads(r['detail'])} for r in rows if state is None or r['state'] == state]

    def live_lyrics_paths(self):
        """Pure read for the per-song view; do not run list retention here."""
        with self.lock:
            return {r[0] for r in self.db.execute('''SELECT i.rel_path FROM items i
                JOIN jobs j ON j.id=i.job_id AND j.attempt=i.attempt
                WHERE j.kind IN ('lyrics-helper','lyrics-search')
                AND j.state IN ('queued','running') AND i.state IN ('queued','running')
                AND i.rel_path IS NOT NULL''')}

    def start(self, kind, label, items, starter=None, *, job_id=None, total=None):
        job_id = job_id or str(uuid.uuid4())
        with self.lock, self.db:
            if self.get(job_id):
                return job_id
            self.db.execute('''INSERT INTO jobs
                (id,kind,label,starter_user_id,state,attempt,total,created_at)
                VALUES(?,?,?,?,'queued',1,?,?)''',
                (job_id, kind, label[:120], getattr(starter, 'user_id', starter),
                 len(items) if total is None else total, self.now()))
            for idx, item in enumerate(items):
                self._insert(job_id, idx, 1, item)
            self._bump()
        return job_id

    def _insert(self, job_id, idx, attempt, data):
        if isinstance(data, str):
            data = {'item': data}
        self.db.execute('''INSERT INTO items(job_id,idx,attempt,item,rel_path,state,detail)
            VALUES(?,?,?,?,?,'queued',?)''', (job_id, idx, attempt, data['item'],
            data.get('rel_path'), json.dumps(data.get('detail', {}))))

    def configure(self, job_id, *, kind=None, label=None, items=None, total=None, attempt=None):
        """Fill a pre-registered request before the producer starts executing."""
        with self.lock, self.db:
            row = self.get(job_id)
            if not row or row['state'] not in LIVE or (attempt is not None and row['attempt'] != attempt):
                return
            if kind or label:
                self.db.execute('UPDATE jobs SET kind=?,label=? WHERE id=? AND attempt=? AND state IN (?,?)',
                                (kind or row['kind'], (label or row['label'])[:120], job_id, row['attempt'], *LIVE))
            if items is not None:
                existing = {i['idx']: i for i in self.items(job_id)}
                for position, item in enumerate(items):
                    idx = item.get("idx", position)
                    if idx not in existing:
                        self._insert(job_id, idx, row['attempt'], item)
                    elif existing[idx]['state'] in LIVE:
                        self.db.execute('UPDATE items SET item=?,rel_path=?,detail=? WHERE job_id=? AND idx=? AND attempt=?',
                            (item['item'], item.get('rel_path'), json.dumps({**existing[idx]['detail'], **item.get('detail', {})}), job_id, idx, existing[idx]['attempt']))
            self.db.execute('UPDATE jobs SET total=? WHERE id=? AND attempt=? AND state IN (?,?)',
                            (total if total is not None else max(row['total'], len(items or [])), job_id, row['attempt'], *LIVE))
            self._bump()

    def running(self, job_id, attempt):
        with self.lock, self.db:
            changed = self.db.execute("UPDATE jobs SET state='running',started_at=coalesce(started_at,?) WHERE id=? AND state='queued' AND attempt=?", (self.now(), job_id, attempt)).rowcount
            if changed:
                self._bump()
            row = self.get(job_id)
            return bool(row and row['state'] == 'running' and row['attempt'] == attempt)

    def item_transition(self, job_id, idx, attempt, state, *, reason=None, detail=None):
        with self.lock, self.db:
            row = self.get(job_id)
            if not row or row['state'] not in LIVE or row['attempt'] != attempt:
                return False
            old = next((i for i in self.items(job_id) if i['idx'] == idx), None)
            if old is None or old['attempt'] != attempt or old['state'] not in LIVE:
                return False
            merged = {**old['detail'], **(detail or {})}
            if old['state'] == state and old['reason'] == reason and old['detail'] == merged:
                return False
            changed = self.db.execute('''UPDATE items SET state=?,reason=?,detail=?
                WHERE job_id=? AND idx=? AND attempt=? AND state IN ('queued','running')''',
                (state, reason, json.dumps(merged), job_id, idx, attempt)).rowcount
            if changed:
                self._counts(job_id)
                self._bump()
            return bool(changed)

    def stage_transition(self, job_id, idx, attempt, stage, *, detail=None, reason=None):
        """Advance one staged item with constant work, fenced by job attempt.

        Same-stage retries are disposable. Counters use the old/new state delta;
        this path never reads the other items in the request.
        """
        with self.lock, self.db:
            job = self.get(job_id)
            if not job or job['state'] not in LIVE or job['attempt'] != attempt:
                return False
            old = self.db.execute('SELECT state,stage,detail FROM items WHERE job_id=? AND idx=? AND attempt=?',
                                  (job_id, idx, attempt)).fetchone()
            if not old or old['state'] not in LIVE or old['stage'] == stage:
                return False
            state = 'failed' if stage.startswith('failed:') else 'done' if stage == 'linked' else 'running'
            merged = {**json.loads(old['detail']), **(detail or {})}
            self.db.execute('''UPDATE items SET stage=?,stage_at=?,state=?,reason=?,detail=?
                WHERE job_id=? AND idx=? AND attempt=?''',
                (stage, self.now(), state, reason, json.dumps(merged), job_id, idx, attempt))
            self.db.execute('UPDATE jobs SET succeeded=succeeded+?,failed=failed+? WHERE id=? AND attempt=?',
                            (int(state == 'done') - int(old['state'] == 'done'),
                             int(state == 'failed') - int(old['state'] == 'failed'), job_id, attempt))
            self._bump()
            return True

    def outcome(self, job_id, item, *, success, detail=None, reason='error', idx=None, attempt=None):
        """Resolve by stable index when available, otherwise the next matching label."""
        with self.lock, self.db:
            row = self.get(job_id)
            if not row or row['state'] not in LIVE or (attempt is not None and row['attempt'] != attempt):
                return
            candidates = [i for i in self.items(job_id) if i['attempt'] == row['attempt'] and i['state'] in LIVE]
            chosen = next((i for i in candidates if i['idx'] == idx), None) if idx is not None else next((i for i in candidates if i['item'] == item), None)
            if chosen is None and idx is None and not self.items(job_id):
                self._insert(job_id, 0, row['attempt'], {'item': item})
                chosen = self.items(job_id)[0]
            if chosen:
                self.item_transition(job_id, chosen['idx'], row['attempt'], 'done' if success else 'failed', reason=None if success else reason, detail=detail)

    def _counts(self, job_id):
        items = self.items(job_id)
        self.db.execute('UPDATE jobs SET succeeded=?,failed=?,skipped=? WHERE id=?',
            (sum(i['state'] == 'done' for i in items), sum(i['state'] in ('failed','interrupted') for i in items), sum(i['state'] == 'skipped' for i in items), job_id))

    def finish(self, job_id, attempt, *, error=False, cancelled=False):
        with self.lock, self.db:
            row = self.get(job_id)
            if not row or row['state'] not in LIVE or row['attempt'] != attempt:
                return False
            current = self.items(job_id)
            for idx in range(len(current), row['total']):
                self._insert(job_id, idx, attempt, {'item': f'Canción {idx+1}'})
            # Unreported items are failures, never invented successes.
            self.db.execute("UPDATE items SET state=?,reason=? WHERE job_id=? AND attempt=? AND state IN ('queued','running')",
                            ('skipped' if cancelled else 'failed', 'cancelled' if cancelled else 'error', job_id, attempt))
            self._counts(job_id)
            row = self.get(job_id)
            state = 'cancelled' if cancelled else ('partial' if row['succeeded'] and (row['failed'] or row['skipped']) else 'failed' if row['failed'] or row['skipped'] or error else 'succeeded')
            changed = self.db.execute('UPDATE jobs SET state=?,ended_at=? WHERE id=? AND attempt=? AND state IN (?,?)', (state, self.now(), job_id, attempt, *LIVE)).rowcount
            if changed:
                self._bump()
            return bool(changed)

    def cancel(self, job_id, attempt):
        if not self.finish(job_id, attempt, cancelled=True):
            raise JobConflict('not-cancellable')

    def retryable(self, job_id):
        row = self.get(job_id)
        selected = [i for i in self.items(job_id) if i['state'] in RETRY]
        return bool(row and row['state'] in TERMINAL and row['attempt'] < 20 and selected and all(i['detail'].get('_retry', {}).get('producer') in ('download','download-call','lyrics-helper','lyrics-search','stems','source-install') for i in selected))

    def retry(self, job_id, attempt):
        with self.lock, self.db:
            row = self.get(job_id)
            # Duplicate requests observing the previous attempt converge.
            if row and row['attempt'] == attempt + 1:
                return row['attempt'], False
            if not row or row['attempt'] != attempt or not self.retryable(job_id):
                raise JobConflict('not-retryable')
            selected = [i for i in self.items(job_id) if i['state'] in RETRY]
            changed = self.db.execute('''UPDATE jobs SET state='queued',attempt=attempt+1,started_at=NULL,
                ended_at=NULL,cleared_at=NULL WHERE id=? AND attempt=? AND state IN (?,?,?,?,?)''', (job_id, attempt, *TERMINAL)).rowcount
            if not changed:
                raise JobConflict('not-retryable')
            for item in selected:
                self._insert(job_id, item['idx'], attempt + 1, item)
            self._counts(job_id)
            self._bump()
            return attempt + 1, True

    def failure_detail(self, job_id, idx, detail, attempt):
        with self.lock, self.db:
            item = next((i for i in self.items(job_id) if i['idx'] == idx and i['attempt'] == attempt), None)
            if item:
                merged = {**item['detail'], **detail}
                self.db.execute('UPDATE items SET detail=? WHERE job_id=? AND idx=? AND attempt=?',
                                (json.dumps(merged), job_id, idx, attempt))
                self._bump()

    def mark_retried(self, job_id, idx, retry_id):
        with self.lock, self.db:
            item = next((i for i in self.items(job_id) if i['idx'] == idx), None)
            if item:
                detail = {**item['detail'], 'retriedAs': retry_id}
                self.db.execute('UPDATE items SET detail=? WHERE job_id=? AND idx=? AND attempt=?', (json.dumps(detail), job_id, idx, item['attempt']))
                self._bump()

    def boot(self):
        """Recover non-helper producers once per startup; helper leases recover in Queue."""
        with self.lock, self.db:
            running = self.db.execute("""SELECT id,attempt FROM jobs WHERE
                (starter_user_id IS NULL AND state IN ('queued','running') AND kind!='source-install') OR
                (kind='library-edit' AND state IN ('queued','running')) OR
                (state='running' AND kind NOT LIKE 'acquisition-%' AND kind NOT IN ('upload','source-install')
                 AND NOT EXISTS (SELECT 1 FROM items WHERE items.job_id=jobs.id
                     AND items.attempt=jobs.attempt AND queue_visible=1))""").fetchall()
            for row in running:
                self.db.execute("UPDATE items SET state='interrupted',reason='interrupted' WHERE job_id=? AND attempt=? AND state IN ('queued','running')", tuple(row))
                self._counts(row['id'])
                self.db.execute("UPDATE jobs SET state='interrupted',ended_at=? WHERE id=? AND state IN ('queued','running') AND attempt=?", (self.now(), *tuple(row)))
                self._bump()
            return [r for r in self.list() if r['state'] == 'queued']

    def clear_one(self, job_id):
        with self.lock, self.db:
            row = self.get(job_id)
            if not row or row['state'] not in TERMINAL:
                raise JobConflict('not-finished')
            count = self.db.execute(
                'UPDATE jobs SET cleared_at=? WHERE id=? AND cleared_at IS NULL',
                (self.now(), job_id)).rowcount
            if count:
                self._bump()
            return count

    def clear(self, starter=None, *, all_users=False):
        with self.lock, self.db:
            sql = 'UPDATE jobs SET cleared_at=? WHERE cleared_at IS NULL AND state IN (?,?,?,?,?)'
            args = [self.now(), *TERMINAL]
            if not all_users:
                sql += ' AND starter_user_id=?'
                args.append(starter)
            count = self.db.execute(sql, args).rowcount
            if count:
                self._bump()
            return count

    def retention(self):
        with self.lock, self.db:
            changed = self.db.execute("UPDATE jobs SET cleared_at=? WHERE state='succeeded' AND cleared_at IS NULL AND ended_at<=?", (self.now(), self.now()-300)).rowcount
            changed += self.db.execute('DELETE FROM jobs WHERE cleared_at<=?', (self.now()-30*86400,)).rowcount
            changed += self.db.execute('''DELETE FROM jobs WHERE id IN (SELECT id FROM jobs
                WHERE state IN ('succeeded','partial','failed','cancelled','interrupted')
                ORDER BY (cleared_at IS NOT NULL) DESC, coalesce(cleared_at,ended_at), created_at
                LIMIT max(0,(SELECT count(*) FROM jobs WHERE state IN
                ('succeeded','partial','failed','cancelled','interrupted'))-500))''').rowcount
            if changed:
                self._bump()
