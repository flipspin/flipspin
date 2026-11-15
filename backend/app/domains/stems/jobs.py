"""Stems track requests and legacy wire views over the shared lease queue."""
from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from typing import Any

from app.domains.helpers import helper_ranking as ranking
from app.infra.jobs import Jobs
from app.infra.jobs.queue import Queue
from app.infra.jobs.kinds import JobKind
from app.domains.helpers.mac_worker import REPLACED, WorkerRecord, worker_id
from app.domains.stems.models import (
    DEFAULT_MODEL,
    PHASE_QUEUED,
    STATUS_FAILED,
    STATUS_DONE,
    STATUS_LEASED,
    STATUS_QUEUED,
    StemJob,
    StemPriority,
    iso,
    wire_phase,
)
from app.domains.stems.repositories import StemsRepository

class StemsQueue:
    def __init__(
        self,
        repository: StemsRepository,
        logger: logging.Logger,
        *,
        now: Callable[[], float] = time.time,
        worker: WorkerRecord | None = None,
        ledger=None,
        progress_tracker=None,
        duration: Callable[[str, str], float | None] = lambda album, file: None,
        background_enabled: Callable[[], bool] = lambda: True,
    ):
        self.progress_tracker = progress_tracker
        self.ledger = ledger or Jobs(repository.queue_file.with_name('jobs.sqlite'), now=now)
        self.queue = Queue.for_ledger(self.ledger, now=now)
        self.kinds = ('stems',)
        self.queue.kinds.register(JobKind('stems', tuple(ranking.default_needs('stems')),
                                         self._apply_result, 'stems', queued_phase='queued', failed_phase='failed', order=1,
                                         can_claim=self._can_claim,
                                         provenance=lambda identity: self.worker.result_metadata(identity, 0)))
        self.repository = repository
        self.logger = logger
        self.now = now
        self.duration = duration
        self.background_enabled = background_enabled
        self._receipts: dict[str, dict[str, Any]] = {}
        self._rows: dict[str, StemJob] = {}
        self.worker = worker or WorkerRecord(now=now)
        self._lock = self.worker.lock
        self.worker.register_release(self.release_helper)
        self._loaded = False
        self.worker.register_reap(self._reap)

    @property
    def now(self):
        return self.queue.now

    @now.setter
    def now(self, value):
        self.queue.now = value

    # ------------------------------------------------------------ persist

    def _sync(self):
        current = {}
        for data in self.queue.rows(self.kinds):
            row = StemJob.from_dict(data)
            if row.id in self._rows:
                old = self._rows[row.id]
                if old.status == 'leased' and (row.status != 'leased' or row.lease != old.lease):
                    self.worker.finished(row.id)
                self._rows[row.id].__dict__.update(row.__dict__)
                row = self._rows[row.id]
            current[row.id] = row
        for id in self._rows.keys() - current.keys():
            self.worker.finished(id)
        self._rows = current

    def _migrate_row(self, data):
        row = StemJob.from_dict(data)
        if not self.ledger.get(row.job_id):
            self.ledger.start('stems', row.file.rsplit('.', 1)[0], [{'item': row.file,
                'rel_path': f'{row.album}/{row.file}', 'detail': {'_retry': {
                    'producer': 'stems', 'album': row.album, 'file': row.file, 'model': row.model}}}], row.requested_by, job_id=row.job_id)
            row.job_attempt = 1
        return 'stems', f'{row.album}/{row.file}', row.to_dict(), dict(
            job_id=row.job_id, idx=0, attempt=row.job_attempt)

    def _ensure_loaded(self) -> None:
        if self._loaded:
            self._sync()
            return
        self._loaded = True
        self.repository.queue_degraded = False
        try:
            self.queue.migrate(self.repository.queue_file, 'jobs', self._migrate_row, default_kind='stems')
        except (OSError, ValueError, TypeError) as e:
            self.repository.queue_degraded = True
            self.logger.warning('stems queue migration %s unreadable (%s)', self.repository.queue_file, e)
        self._receipts = self.queue.receipts(self.kinds)
        self._sync()
        self._handle_recovered(self.queue.recover(self.kinds, restart=True))
        self._save()

    def _apply_result(self, data, manifest=None, files=None):
        row = self._rows[data['id']]
        row.result = {**(row.provenance or self.worker.result_metadata(row.leased_by, 0)),
                      'seconds': max(0, self.now() - row.leased_at),
                      **{key: value for key, value in (manifest or {}).get('worker', {}).items()
                         if key in {'accel', 'fallbackReason', 'gpu'}}}
        if manifest is not None:
            manifest['result'] = row.result
            self.repository.publish(row.album, row.file, manifest, files)

    def _report(self, row):
        state = {STATUS_QUEUED: 'queued', STATUS_LEASED: 'running', STATUS_DONE: 'done', STATUS_FAILED: 'failed'}[row.status]
        tracker = self.progress_tracker
        if tracker:
            cached = tracker.get_progress(row.job_id)
            if not cached or tracker.attempt_for(row.job_id) != row.job_attempt:
                tracker.create_progress(row.job_id, 1)
            if state in ('queued', 'running'):
                tracker.set_status(row.job_id, 'queued' if state == 'queued' else 'in_progress')
                tracker.set_track_phase(row.job_id, row.file, row.phase or 'queued', row.progress)
            else:
                tracker.update_progress(row.job_id, row.file)
                tracker.complete_progress(row.job_id, 'done' if state == 'done' else 'failed', succeeded=int(state == 'done'), failed=int(state == 'failed'))

    def _save(self) -> None:
        # Recovered leases and retryable failures can become queued too. Keep
        # the cap and off switch true at every persisted transition, not just enqueue.
        background: dict[str | None, list[StemJob]] = {}
        for row in self._rows.values():
            if row.status == STATUS_QUEUED and row.priority == "background":
                background.setdefault(row.requested_by, []).append(row)
        enabled = self.background_enabled()
        for rows in background.values():
            ordered = sorted(rows, key=lambda r: r.requested_at)
            for row in ordered[:-2] if enabled else ordered:
                self._remove_locked(row)
        for row in self._rows.values():
            self._report(row)
        for row in self._rows.values():
            self.queue.save_payload(row.to_dict())

    def _find(self, album: str, file: str) -> StemJob | None:
        for row in self._rows.values():
            if row.album == album and row.file == file:
                return row
        return None

    def _by_lease(self, lease: str) -> StemJob | None:
        if not lease:
            return None
        for row in self._rows.values():
            if self.ledger:
                job = self.ledger.get(row.job_id)
                if not job or job['state'] not in ('queued', 'running') or job['attempt'] != row.job_attempt:
                    continue
            if row.status == STATUS_LEASED and row.lease == lease:
                return row
        return None

    def _touch(self, row: StemJob) -> None:
        row.updated_at = self.now()

    # ------------------------------------------------------------ clients

    def request(self, album: str, file: str, model: str = DEFAULT_MODEL, *, job_id=None,
                priority: StemPriority = "now", requested_by: str | None = None) -> StemJob:
        from app.infra.progress import progress_principal
        from app.infra.identity import is_real_user

        principal = progress_principal.get()
        if requested_by is None and is_real_user(principal):
            requested_by = principal.user_id
        with self._lock:
            self._ensure_loaded()
            row = self._find(album, file)
            if row is not None and row.status in (STATUS_QUEUED, STATUS_LEASED):
                if priority == "now" and row.priority == "background":
                    row.priority = "now"
                    self._touch(row)
                    self._save()
                return row
            if self.ledger:
                if row and row.job_id and self.ledger.retryable(row.job_id):
                    record = self.ledger.get(row.job_id)
                    self.ledger.retry(row.job_id, record['attempt'])
                    job_id = row.job_id
                job_id = job_id or f"s{uuid.uuid4().hex[:12]}"
                self.ledger.start('stems', file.rsplit('.', 1)[0],
                    [{'item': file.rsplit('.', 1)[0], 'rel_path': f'{album}/{file}',
                      'detail': {'_retry': {'producer': 'stems', 'album': album, 'file': file, 'model': model}}}],
                    progress_principal.get(), job_id=job_id)
            if row is not None:
                self.queue.hide(row.id)
            if row is not None:  # failed: asking again is the retry
                row.status = STATUS_QUEUED
                row.error = None
                row.phase = PHASE_QUEUED
                row.progress = None
                row.lease = None
                row.attempts = 0
                row.model = model
                row.requested_at = self.now()
                row.offered_at = row.requested_at
                row.result = None
                # Retrying must not downgrade a foreground request either.
                row.priority = "now" if row.priority == "now" else priority
                row.requested_by = requested_by
                self._touch(row)
            else:
                row = StemJob(
                    id=job_id or f"s{uuid.uuid4().hex[:12]}",
                    album=album,
                    file=file,
                    model=model,
                    priority=priority,
                    requested_by=requested_by,
                    requested_at=self.now(),
                    updated_at=self.now(),
                )
                self._rows[row.id] = row
            if self.ledger:
                row.job_id = job_id
                row.job_attempt = self.ledger.get(job_id)['attempt']
            data = self.queue.enqueue('stems', f'{album}/{file}', row.to_dict(),
                                      job_id=row.job_id, attempt=row.job_attempt)
            row.__dict__.update(StemJob.from_dict(data).__dict__)
            self._rows[row.id] = row
            self._save()
            return row

    def get(self, album: str, file: str) -> StemJob | None:
        with self._lock:
            self._ensure_loaded()
            self._reap_locked()
            return self._find(album, file)

    def remove(self, album: str, file: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            row = self._find(album, file)
            if row is None:
                return False
            self._remove_locked(row)
            self._save()
            return True

    def _remove_locked(self, row: StemJob) -> None:
        if self.ledger:
            record = self.ledger.get(row.job_id)
            if record and record['state'] in ('queued', 'running'):
                self.ledger.cancel(row.job_id, row.job_attempt)
                if self.progress_tracker:
                    self.progress_tracker.complete_progress(row.job_id, "cancelled")
        self.queue.cancel(row.id)
        self.queue.hide(row.id)
        self._rows.pop(row.id, None)
        self.worker.finished(row.id)

    def evict_background(self) -> None:
        """Drop only queued background work; a helper's live lease stays valid."""
        with self._lock:
            self._ensure_loaded()
            rows = [r for r in self._rows.values() if r.status == STATUS_QUEUED and r.priority == "background"]
            for row in rows:
                self._remove_locked(row)
            if rows:
                self._save()

    def has_queued(self) -> bool:
        with self._lock:
            self._ensure_loaded()
            return any(r.status == STATUS_QUEUED for r in self._rows.values())

    # -------------------------------------------------------------- agent

    def _reap(self) -> None:
        self._ensure_loaded()
        self._reap_locked()

    def _handle_recovered(self, changed):
        for data in changed:
            row = self._rows.get(data['id'])
            if row:
                row.__dict__.update(StemJob.from_dict(data).__dict__)
                self.worker.finished(row.id)
                self._touch(row)
        if changed:
            self._save()

    def _reap_locked(self) -> None:
        self._handle_recovered(self.queue.recover(self.kinds))

    def release_helper(self, identity: str) -> None:
        with self._lock:
            self._ensure_loaded()
            self._handle_recovered(self.queue.recover(self.kinds, holder=identity))

    def owns_lease(self, lease: str, identity: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            row = self._by_lease(lease)
            return bool(row and row.leased_by == identity)

    def _can_claim(self, row, identity):
        return self.worker.can_claim(row, identity)

    def claim(self, agent: dict[str, Any] | None = None) -> StemJob | dict[str, Any] | None:
        """Lease eligible foreground work first, then oldest, or ``None``; ``lease`` is the agent's id."""
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            agent = agent or {"name": "agent"}
            if not self.worker.seen(agent):
                return dict(REPLACED)
            if refusal := self.worker.claim_refusal(agent):
                return refusal
            identity = worker_id(agent)
            if self.worker.busy(identity):
                return None
            for old in list(self._rows.values()):
                if old.status == STATUS_LEASED and not self.worker.accepts(old.leased_by):
                    self._handle_recovered(self.queue.recover(self.kinds, holder=old.leased_by))
            data = self.queue.claim(self.kinds, identity, eligible=lambda r: self.worker.can_claim(r, identity))
            if data is None:
                return None
            row = self._rows[data['id']]
            row.__dict__.update(StemJob.from_dict(data).__dict__)
            self.worker.working(row.id, row.leased_by, row.file, row.phase)
            self._touch(row)
            self._save()
            return row

    def heartbeat(self, lease: str, phase: str | None = None, progress: float | None = None, agent: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            row = self._by_lease(lease)
            if agent is not None and not self.worker.seen(agent, enroll=False):
                return dict(REPLACED)
            if row is None or (agent and worker_id(agent) != row.leased_by):
                return {"stop": True, "reason": "lease-lost"}
            response = self.queue.heartbeat(row.id, lease, wire_phase(phase), progress)
            if response['stop']:
                return response
            row.__dict__.update(StemJob.from_dict(self.queue.get(row.id)).__dict__)
            self.worker.touch(row.leased_by)
            self.worker.working(row.id, row.leased_by, row.file, wire_phase(phase) if phase else row.phase)
            if phase:
                row.phase = wire_phase(phase)
                row.progress = progress
                if self.progress_tracker:
                    self.progress_tracker.set_track_phase(row.job_id, row.file, row.phase, progress)
                elif self.ledger:
                    self.ledger.phase_changed()
                self._touch(row)
            return {"stop": False}

    def leased(self, lease: str) -> StemJob | None:
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            row = self._by_lease(lease)
            return row if row and self.worker.accepts(row.leased_by) else None

    def complete(self, lease: str, manifest=None, files=None) -> bool:
        """The split is on disk: the row has served its purpose."""
        with self._lock:
            self._ensure_loaded()
            row = self._by_lease(lease)
            if row is None or not self.worker.accepts(row.leased_by):
                return False
            if not self.queue.complete(row.id, lease, manifest, files,
                                       execution={key: value for key, value in (manifest or {}).get('worker', {}).items()
                                                  if key in {'accel', 'fallbackReason', 'gpu'}}):
                return False
            try:
                duration = self.duration(row.album, row.file)
            except Exception:  # noqa: BLE001 — a metadata failure cannot undo publication
                duration = None
            seconds = row.result["seconds"] if row.result else max(0, self.now() - row.leased_at)
            self.worker.record_result(row.leased_by, row.kind, seconds, duration)
            row.status, row.phase, row.progress = STATUS_DONE, "ready", 100
            self._report(row)
            self._receipt(lease, row, {"accepted": True, "status": "ready"})
            self.queue.save_payload(row.to_dict())
            self.queue.hide(row.id)
            self._rows.pop(row.id, None)
            self.worker.finished(row.id)
            self._save()
            return True

    def _receipt(self, lease: str, row: StemJob, response: dict[str, Any]) -> None:
        self._receipts[lease] = {"identity": row.leased_by, "response": response, "row": row.to_dict()}
        self.queue.receipt('stems', lease, self._receipts[lease])

    def result_response(self, lease: str, identity: str | None = None, job_id: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_loaded()
            receipt = self._receipts.get(lease)
            if receipt and (identity is None or receipt["identity"] == identity) and (job_id is None or receipt["row"]["id"] == job_id):
                return receipt["response"].copy()
            return None

    def fail(self, lease: str, error: str, *, final: bool) -> dict[str, Any]:
        """``final=False`` is an accident worth another lease; a verdict is final."""
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            receipt = self.result_response(lease)
            if receipt:
                return receipt
            row = self._by_lease(lease)
            if row is None or not self.worker.accepts(row.leased_by):
                return {"accepted": False, "reason": "lease-lost"}
            self.worker.finished(row.id)
            reason = (error or "el agente no devolvió stems")[:200]
            retry = self.queue.fail(row.id, lease, reason, final=final)
            row.__dict__.update(StemJob.from_dict(self.queue.get(row.id)).__dict__)
            self._touch(row)
            if retry:
                self._receipt(lease, row, {"accepted": True, "requeued": True})
                self._save()
                return {"accepted": True, "requeued": True}
            self._receipt(lease, row, {"accepted": True, "requeued": False})
            self._save()
            return {"accepted": True, "requeued": False}

    # -------------------------------------------------------------- status

    def agent_status(self) -> dict[str, Any]:
        worker = self.worker.snapshot("stems")
        return {
            "online": self.worker.legacy()["online"],
            "lastSeen": iso(worker["lastSeenAt"]) if worker else None,
            "name": worker["name"] if worker else None,
        }

    def snapshot(self, *, read_only=False) -> dict[str, Any]:
        with self._lock:
            if not read_only or not self._loaded:
                self._ensure_loaded()
            if read_only:
                rows_by_id = {data['id']: StemJob.from_dict(data) for data in self.queue.rows(self.kinds)}
            else:
                self._reap_locked()
                rows_by_id = self._rows
            rows = sorted(rows_by_id.values(), key=lambda r: r.requested_at)
            views = []
            for row in rows:
                views.append({**row.snapshot(), "waitReason": self.worker.wait_reason(row.kind, row.needs) if row.status == STATUS_QUEUED else None})
            return {"jobs": views, "agent": self.agent_status(),
                    "waitReason": self.worker.wait_reason("stems"),
                    "oldestAt": min((r.requested_at for r in rows if r.status in (STATUS_QUEUED, STATUS_LEASED)), default=None)}
