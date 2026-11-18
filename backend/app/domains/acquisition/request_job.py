"""One durable song state machine, projected into the shipped five-stage view."""
import json
from dataclasses import dataclass
from contextlib import nullcontext
from .sources.compat import LEGACY_SOURCE_ID

STAGES = ('request', 'match', 'fetch', 'import', 'link')

STEPS = ('requested', 'matched', 'fetched', 'processed', 'imported', 'linked')
COMPLETES = {'request': 'requested', 'match': 'matched', 'fetch': 'processed', 'import': 'imported', 'link': 'linked'}


@dataclass(frozen=True)
class Stage:
    request: 'RequestJob'
    name: str

    @property
    def id(self):
        return self.request.id


class RequestJob:
    def __init__(self, ledger, job_id, tracker=None):
        self.ledger, self.id, self.tracker = ledger, job_id, tracker
        self.attempt = ledger.get(job_id)['attempt']

    @classmethod
    def find(cls, ledger, request_id, tracker=None):
        with ledger.lock:
            row = ledger.db.execute("SELECT id FROM jobs WHERE parent_id=? AND kind='acquisition-request' AND EXISTS (SELECT 1 FROM items WHERE job_id=jobs.id AND stage IS NOT NULL)", (request_id,)).fetchone()
        return cls(ledger, row[0], tracker) if row else None

    @classmethod
    def create(cls, ledger, request_id, work, requests, principal, tracker, *, transaction=False, source_id=LEGACY_SOURCE_ID):
        job_id = work['job_id']
        marks = work['body'].get('_source_retried', {})
        if requests is None:
            tracks = work['body'].get('_requests')
            tracks = [r['metadata'] for r in tracks] if tracks is not None else work['body']['tracks']
            labels = [t.get('title') or t.get('name') or 'Canción' for t in tracks]
        else:
            labels = [r.metadata.title or r.search_query or r.youtube_url or 'Canción' for r in requests]
        items = [{'item': label, 'detail': {'index': i, 'provider': source_id,
                  **({'sourceRetry': marks[str(i)]} if str(i) in marks else {})}} for i, label in enumerate(labels)]
        # Registration is one transaction, including adapters' pre-registered
        # progress jobs. Their retry recipes remain available on the item.
        with ledger.lock, nullcontext() if transaction else ledger.db:
            old = ledger.get(job_id)
            if old:
                ledger.db.execute('UPDATE jobs SET kind=?,parent_id=?,total=? WHERE id=?',
                                  ('acquisition-request', request_id, len(items), job_id))
                existing = {i['idx']: i for i in ledger.items(job_id)}
            else:
                ledger.db.execute("INSERT INTO jobs(id,kind,label,starter_user_id,state,attempt,total,created_at,parent_id) VALUES(?,'acquisition-request',?,?,'queued',1,?,?,?)",
                                  (job_id, work['body']['title'][:120], principal.user_id, len(items), ledger.now(), request_id))
                existing = {}
            attempt = old['attempt'] if old else 1
            for idx, item in enumerate(items):
                detail = {**existing.get(idx, {}).get('detail', {}), **item['detail'], '_stage_times': {'requested': ledger.now()}}
                ledger.db.execute("INSERT OR REPLACE INTO items(job_id,idx,attempt,item,state,detail,stage,stage_at) VALUES(?,?,?,?,'queued',?,'requested',?)",
                                  (job_id, idx, attempt, item['item'], json.dumps(detail), ledger.now()))
            if not transaction:
                ledger._bump()
        result = cls(ledger, job_id, tracker)
        return result

    def stage(self, name):
        return Stage(self, name)

    def item(self, idx):
        with self.ledger.lock:
            row = self.ledger.db.execute('SELECT * FROM items WHERE job_id=? AND idx=? ORDER BY attempt DESC LIMIT 1', (self.id, idx)).fetchone()
        return {**dict(row), 'detail': json.loads(row['detail'])} if row else None

    def advance(self, idx, stage, *, detail=None, reason=None):
        with self.ledger.lock:
            item = self.item(idx)
            if not item or item['attempt'] != self.attempt or item['state'] not in ('queued', 'running'):
                return False
            if not stage.startswith('failed:') and STEPS.index(stage) <= STEPS.index(item['stage']):
                return False
            times = {**item['detail'].get('_stage_times', {}), stage: self.ledger.now()}
            return self.ledger.stage_transition(self.id, idx, item['attempt'], stage,
                detail={**(detail or {}), '_stage_times': times}, reason=reason)

    def done(self, name, idx, *, error=None, reason=None, detail=None):
        detail = detail or {}
        item = self.item(idx)
        receipts = {**item['detail'].get('_stage_details', {}), name: detail}
        detail = {**detail, '_stage_details': receipts}
        if error is not None:
            detail = {**detail, '_failed_stage': name}
            return self.advance(idx, f"failed:{detail.get('kind') or reason or 'error'}", detail=detail, reason=reason)
        return self.advance(idx, COMPLETES[name], detail=detail)

    def items(self, name):
        return [self.project(item, name) for item in self.ledger.items(self.id)]

    def project(self, item, name):
        detail = item['detail']
        times = detail.get('_stage_times', {})
        reached = COMPLETES[name]
        failed = detail.get('_failed_stage')
        state, reason = 'queued', None
        at = times.get(reached)
        if at is not None:
            state = 'done'
        elif failed and STAGES.index(name) >= STAGES.index(failed):
            state, reason, at = 'failed', item['reason'], item['stage_at']
        else:
            active = self.tracker.track_phase(self.id, item['idx']) if self.tracker else {}
            phase = active.get('phase')
            if ((name == 'match' and phase == 'searching') or
                    (name == 'fetch' and 'matched' in times) or
                    (name == 'import' and 'processed' in times) or (name == 'link' and 'imported' in times)):
                state = 'running'
        receipts = detail.get('_stage_details', {})
        receipt = receipts.get(name, {})
        if state == 'failed':
            receipt = receipts.get(failed, receipt)
        public = {'provider': detail['provider'], 'index': detail['index'],
                  **({'sourceRetry': detail['sourceRetry']} if detail.get('sourceRetry') else {}),
                  **{k: v for k, v in receipt.items() if not k.startswith('_')}}
        active = self.tracker.track_phase(self.id, item['idx']) if self.tracker else {}
        if name == 'fetch' and active.get('percent') is not None:
            public['percent'] = active['percent']
        return {**item, 'state': state, 'reason': reason,
                'detail': {**{k: v for k, v in detail.items() if k.startswith('_')}, **public}, 'stageAt': at}
