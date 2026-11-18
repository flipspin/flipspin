"""Compose persisted compute policy with the existing helper ranking."""
from datetime import datetime, timedelta, timezone

from app.infra.changes import Changes
from app.infra.machine import machine_facts
from app.infra.jobs.compute import ComputeSettings
from app.infra.jobs.queue import lane
from . import helper_ranking as ranking

SUMMARY_KINDS = (('align', 'transcribe'), ('stems',), ('analysis',))


def local_time(worker):
    offset = worker.get('utcOffsetMinutes')
    return datetime.now(timezone(timedelta(minutes=offset))) if offset is not None else datetime.now()


class Compute:
    def __init__(self, queue, worker, config, *, changes=None):
        self.changes = changes or Changes({'jobs': lambda: queue.ledger.version})
        self.queue, self.worker = queue, worker
        self.settings = ComputeSettings(queue.ledger, config, nest_memory_bytes=machine_facts()['memoryBytes'] // 2, changes=self.changes)
        worker.compute = self
        queue.placement = self.reason
        self._summary_version = None
        self._summary_rows = {}

    def reason(self, row, identity):
        worker = next((h for h in self.worker.scheduling_helpers() if h['id'] == identity), None)
        if worker is None:
            return 'no-helper'
        return self.settings.reason(worker, {**row, 'lane': lane(row)}, local_time(worker))

    def can_claim(self, row, identity):
        row = {**row, 'needs': row.get('needs', self.queue.kinds[row['kind']].needs)}
        if self.reason(row, identity):
            return False
        policy = self.settings.policy(row['kind'])
        helpers = [h for h in self.worker.scheduling_helpers()
                   if not self.settings.reason(h, {**row, 'lane': lane(row)}, local_time(h))]
        candidate = next((h for h in helpers if h['id'] == identity), None)
        if not candidate:
            return False
        if candidate.get('nest') and policy['placement'] == 'anywhere':
            if not ranking.capable(candidate, row['kind'], row.get('needs', [])) or candidate.get('job'):
                return False
            # Give an idle faster worker the existing slow-worker grace period.
            return self.queue.now() - row['offered_at'] >= ranking.SLOW_DELAY_S or not any(
                ranking.online(h) and not h.get('nest') and not h.get('job') and
                ranking.capable(h, row['kind'], row.get('needs', [])) for h in helpers)
        return ranking.can_claim(helpers, identity, row['kind'], row.get('needs', []),
                                 row['offered_at'], now=self.queue.now())

    def defer_blocked(self):
        for row in self.queue.rows(tuple(k.name for k in self.queue.kinds)):
            if row['status'] == 'leased' and self.reason(row, row['leased_by']):
                self.queue.defer_holder(row['leased_by'])
                self.worker.finished(row['id'])

    def summary(self, nest):
        helpers = [h for h in self.worker.helpers() if not h.get('nest') and self.worker.accepts(h['id'])]
        computers = [{**nest, 'name': 'The nest'}, *helpers]
        for h in computers:
            h['limits'] = self.settings.limits(h)
        # Only this read model owns these decoded dicts. Queue.rows() callers
        # still receive fresh, mutable data; live policy and helper state stay
        # outside the memo. Read the revision and rows under the writer lock.
        with self.queue.ledger.lock:
            version = self.changes.revision('jobs')
            if version != self._summary_version:
                self._summary_rows = {names: self.queue.rows(names) for names in SUMMARY_KINDS}
                self._summary_version = version
            summary_rows = self._summary_rows
        kinds = []
        for names in SUMMARY_KINDS:
            kind = names[0]
            rows = summary_rows[names]
            waiting = [r for r in rows if r['status'] == 'queued']
            running = [r for r in rows if r['status'] == 'leased']
            policy = self.settings.policy(kind)
            workers = [h for h in computers if ranking.capable(h, kind,
                       list(self.queue.kinds[kind].needs)) and (not h.get('nest') or policy['placement'] != 'helpers')]
            reason, waiting_for = None, None
            if self.settings.paused or policy['paused']:
                reason = 'paused'
            elif waiting and not running:
                exemplar = waiting[0]
                real = [h for h in workers if not h.get('nest')]
                waiting_for = max(real, key=lambda h: h['lastSeenAt'], default={}).get('name')
                live = [h for h in workers if ranking.online(h) and not h.get('disabledReason')]
                if live:
                    reasons = [self.settings.reason(h, {**exemplar, 'lane': lane(exemplar)}, local_time(h)) for h in live]
                    reason = 'helpers-busy' if any(r is None for r in reasons) else reasons[0]
                elif workers:
                    reason = 'helpers-offline'
                else:
                    reason = 'no-helper' if not helpers else 'no-capable-helper'
                if not real and policy['placement'] != 'helpers' and nest.get('pausedReason'):
                    reason = nest['pausedReason']
                elif not real and policy['placement'] != 'helpers' and nest.get('disabledReason'):
                    reason = nest['disabledReason']
            kinds.append({'kind': kind, 'policy': policy, 'waiting': len(waiting),
                          'oldestAt': min((r['offered_at'] for r in waiting), default=None),
                          'failed': sum(r['status'] == 'failed' for r in rows),
                          'running': [{'workerId': r['leased_by'], 'title': r.get('item') or r.get('file', ''),
                                       'progress': r.get('progress')} for r in running],
                          'reason': reason, 'waitingFor': waiting_for,
                          'nestMemoryBytes': nest.get('memoryBytes') or 0})
        return {'paused': self.settings.paused, 'waiting': sum(k['waiting'] for k in kinds),
                'kinds': kinds, 'computers': computers}
