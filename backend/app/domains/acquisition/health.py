"""Durable source health, separate from admission and metadata API pacing."""
import asyncio
import json
import random

from app.exceptions import FailureKind
from .failures import POLICIES
from .repository import Requests

LADDER = (60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400)
STARTUP_GRACE = 15 * 60
GRACE_CAP = 5 * 60


class SourceHealth:
    def __init__(self, ledger, *, started_at=None, jitter=lambda: random.uniform(0.9, 1.1), on_failure=lambda provider, failure: None):
        self.ledger = ledger
        self.store = Requests(ledger)
        self.started_at = ledger.now() if started_at is None else started_at
        self.jitter = jitter
        self.on_failure = on_failure
        self.waiters = {}

    def status(self, provider):
        with self.ledger.lock:
            row = self.ledger.db.execute('SELECT * FROM acquisition_providers WHERE provider=?', (provider,)).fetchone()
            if row is None:
                return {'state': 'ok'}
            waiting = row['until_at'] > self.ledger.now() or row['kind'] == FailureKind.AUTH_REQUIRED
            return {'state': ('busy' if row['kind'] == FailureKind.RATE_LIMITED else 'broken') if waiting else 'ok',
                    'kind': row['kind'], 'level': row['level'], 'until': row['until_at'] or None, 'since': row['since'],
                    'firstFailureAt': row['first_failure_at'], 'lastFailureAt': row['last_failure_at']}

    def retry(self, provider):
        with self.store.transaction() as db:
            db.execute('UPDATE acquisition_providers SET until_at=0 WHERE provider=?', (provider,))
            self.store.mark_waiting(db, provider, None, None)
            self.ledger._bump()
            for loop, event in self.waiters.get(provider, set()):
                loop.call_soon_threadsafe(event.set)
        return self.status(provider)

    async def pause(self, provider, seconds, sleep):
        """A manual retry interrupts the gate, including a retry just before sleep."""
        waiter = (asyncio.get_running_loop(), asyncio.Event())
        tasks = []
        with self.ledger.lock:
            self.waiters.setdefault(provider, set()).add(waiter)
        try:
            if self.wait(provider) <= 0:
                return
            async def still_waiting():
                if self.wait(provider) > 0:
                    await sleep(seconds)
            tasks = [asyncio.create_task(still_waiting()), asyncio.create_task(waiter[1].wait())]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            with self.ledger.lock:
                self.waiters[provider].discard(waiter)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def last_format(self, provider):
        """Read published measurements, including downloads from before this API."""
        with self.ledger.lock:
            saved = self.ledger.db.execute('SELECT published_format FROM acquisition_providers WHERE provider=?', (provider,)).fetchone()
            if saved and saved[0]:
                return json.loads(saved[0])
            row = self.ledger.db.execute('''SELECT i.detail FROM items i JOIN jobs j ON j.id=i.job_id
                JOIN acquisition_requests r ON r.id=j.parent_id
                WHERE j.kind IN ('acquisition-import','acquisition-request') AND (i.state='done' OR i.stage='imported' OR json_extract(i.detail, '$._stage_times.imported') IS NOT NULL)
                AND json_extract(i.detail,'$.provider')=? AND r.provider!='upload'
                AND json_extract(i.detail,'$.audio_format.codec') IS NOT NULL
                ORDER BY coalesce(j.ended_at,j.created_at) DESC, i.idx DESC LIMIT 1''', (provider,)).fetchone()
        if row is None:
            return None
        report = json.loads(row['detail'])['audio_format']
        return self.format_fact(report)

    @staticmethod
    def format_fact(report):
        return {'codec': report['codec'], 'bitrateKbps': report['bitrate_bps'] / 1000 if report.get('bitrate_bps') else None,
                'container': report['container'], 'transcoded': report.get('transcoded')}

    def published(self, provider, report):
        if not report.get('codec'):
            return
        with self.store.transaction() as db:
            db.execute('INSERT OR IGNORE INTO acquisition_providers(provider) VALUES(?)', (provider,))
            db.execute('UPDATE acquisition_providers SET published_format=? WHERE provider=?',
                       (json.dumps(self.format_fact(report)), provider))
            self.ledger._bump()

    def wait(self, provider):
        return max(0, (self.status(provider).get('until') or 0) - self.ledger.now())

    def failure(self, provider, failure):
        failure.failed_at = self.ledger.now()
        self.on_failure(provider, failure)
        if not POLICIES[failure.kind].penalize and failure.kind != FailureKind.AUTH_REQUIRED:
            return
        with self.store.transaction() as db:
            now = self.ledger.now()
            db.execute('INSERT OR IGNORE INTO acquisition_providers(provider) VALUES(?)', (provider,))
            row = db.execute('SELECT * FROM acquisition_providers WHERE provider=?', (provider,)).fetchone()
            level = min(len(LADDER), row['level'] + 1) if POLICIES[failure.kind].penalize else row['level']
            delay = LADDER[level - 1] * self.jitter()
            if now < self.started_at + STARTUP_GRACE:
                delay = min(delay, GRACE_CAP)
            delay = max(delay, failure.retry_after or 0)
            until = max(row['until_at'], now + delay) if POLICIES[failure.kind].penalize else 0
            db.execute('''UPDATE acquisition_providers SET level=?,kind=?,since=coalesce(since,?),until_at=?,
                       first_failure_at=CASE WHEN since IS NULL THEN ? ELSE coalesce(first_failure_at,?) END,
                       last_failure_at=? WHERE provider=?''',
                       (level, failure.kind, now, until, now, now, now, provider))
            self.store.mark_waiting(db, provider, until, failure.kind)
            self.ledger._bump()

    def success(self, provider):
        with self.store.transaction() as db:
            # Do not erase a concurrent failure's cooldown when an earlier
            # in-flight fetch succeeds. Recovery is measured by a later probe.
            row = db.execute('SELECT * FROM acquisition_providers WHERE provider=?', (provider,)).fetchone()
            if row is None:
                return
            level = max(0, row['level'] - 1)
            if row['until_at'] > self.ledger.now():
                db.execute('UPDATE acquisition_providers SET level=? WHERE provider=?', (level, provider))
            else:
                db.execute('UPDATE acquisition_providers SET level=?,until_at=0,kind=NULL,since=CASE WHEN ?=0 THEN NULL ELSE since END WHERE provider=?',
                           (level, level, provider))
            self.ledger._bump()
