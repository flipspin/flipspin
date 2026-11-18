"""Lyrics batch progress and legacy agent wire views over the shared lease queue."""
from __future__ import annotations

import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from collections.abc import Callable
from urllib.parse import quote

from app.domains.helpers import helper_ranking as ranking
from app.domains.helpers.mac_worker import REPLACED, WorkerRecord, worker_id
from app.infra.jobs import Jobs
from app.infra.jobs.queue import Queue, LANES
from app.infra.jobs.kinds import JobKind
from app.infra.changes import Changes
from app.infra.progress import ProgressTracker

STATUS_QUEUED = "queued"
STATUS_LEASED = "leased"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"


@dataclass
class QueueRow:
    id: str
    rel_path: str
    item: str
    progress_id: str
    text: str | None = None
    expected_lyric: str | None = None
    selection: dict[str, Any] | None = None
    isolate_vocals: bool = True
    #: The song has a fresh split: the agent fetches its vocals stem instead of running demucs.
    stems_vocals: bool = False
    job_attempt: int = 1
    job_idx: int = 0
    status: str = STATUS_QUEUED
    lease: str | None = None
    leased_by: str | None = None
    leased_at: float = 0.0
    last_heartbeat: float = 0.0
    attempts: int = 0
    created_at: float = field(default_factory=time.time)
    phase: str | None = None
    error: str | None = None

    kind: str = ""
    needs: list[str] = field(default_factory=list)
    offered_at: float | None = None
    result: dict[str, Any] | None = None
    provenance: dict[str, Any] | None = None
    lane: str = 'now'

    def __post_init__(self) -> None:
        self.kind = self.kind or ("align" if self.text else "transcribe")
        self.needs = self.needs or ranking.default_needs(self.kind)
        if self.offered_at is None:
            self.offered_at = self.created_at

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "jobId": self.progress_id, "offeredAt": self.offered_at, "leasedBy": self.leased_by}

    def snapshot(self, helpers: list[dict[str, Any]]) -> dict[str, Any]:
        return {**self.to_dict(), "waitReason": ranking.wait_reason(helpers, self.kind, self.needs) if self.status == STATUS_QUEUED else None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> QueueRow:
        known = {k: data.get(k) for k in cls.__dataclass_fields__ if k in data}  # type: ignore[attr-defined]
        if "offeredAt" in data:
            known["offered_at"] = data["offeredAt"]
        if "leasedBy" in data:
            known["leased_by"] = data["leasedBy"]
        return cls(**known)


class AgentQueue:
    def __init__(
        self,
        *,
        path: Path,
        progress_tracker: ProgressTracker,
        logger: logging.Logger,
        on_result: Callable[[QueueRow, str, str, dict[str, Any]], None],
        on_failure: Callable[[QueueRow, str], None],
        now: Callable[[], float] = time.time,
        duration: Callable[[str], float | None] = lambda rel: None,
        changes: Changes | None = None,
    ):
        self.changes = changes or Changes()
        self.path = path
        self.progress_tracker = progress_tracker
        self.ledger = progress_tracker.ledger or Jobs(path.with_name('jobs.sqlite'), now=now)
        progress_tracker.ledger = self.ledger
        self.queue = Queue.for_ledger(self.ledger, now=now)
        self.kinds = ('align', 'transcribe')
        for kind in self.kinds:
            self.queue.kinds.register(JobKind(kind, tuple(ranking.default_needs(kind)),
                                             self._apply_result, 'lyrics-helper', show_retry_error=False,
                                             can_claim=self._can_claim,
                                             provenance=lambda identity: self.worker.result_metadata(identity, 0)))
        self.logger = logger
        self.on_result = on_result
        self.on_failure = on_failure
        self.now = now
        self.duration = duration
        self._receipts: dict[str, dict[str, Any]] = {}
        self._rows: dict[str, QueueRow] = {}
        self.worker = WorkerRecord(now=now, path=path.with_name("helpers.json"), changes=self.changes)
        self._lock = self.worker.lock
        self.worker.register_release(self.release_helper)
        self._loaded = False
        self.degraded = False
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
            row = QueueRow.from_dict(data)
            if 'lane' not in data and self.ledger.get(row.progress_id)['total'] > 1:
                row.lane = 'library'
                self.queue.save_payload(row.to_dict())
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
        row = QueueRow.from_dict(data)
        if 'job_idx' not in data:
            existing = self.ledger.items(row.progress_id)
            match = next((i for i in existing if i['rel_path'] == row.rel_path), None)
            row.job_idx = match['idx'] if match else len(existing)
        if not self.ledger.get(row.progress_id):
            # Older installations may predate the ledger. Import the whole batch
            # before linking its individual helper rows.
            self.ledger.start('lyrics-helper', row.item, [], job_id=row.progress_id)
            row.job_attempt = 1
        self.ledger.configure(row.progress_id, items=[{'idx': row.job_idx, 'item': row.item,
            'rel_path': row.rel_path, 'detail': {'_retry': {'producer': 'lyrics-helper', 'job': {
                'relPath': row.rel_path, 'item': row.item, 'text': row.text,
                'isolateVocals': row.isolate_vocals, 'expectedLyric': row.expected_lyric,
                'stemsVocals': row.stems_vocals, 'selection': row.selection}}}}], total=max(
                    self.ledger.get(row.progress_id)['total'], row.job_idx + 1))
        payload = row.to_dict()
        if 'lane' not in data:
            payload.pop('lane')  # Infer old batches once every member is imported.
        return row.kind, f'{row.progress_id}:{row.job_attempt}:{row.job_idx}', payload, dict(
            job_id=row.progress_id, idx=row.job_idx, attempt=row.job_attempt)

    def _ensure_loaded(self) -> None:
        if self._loaded:
            self._sync()
            self._apply_pending_failures()
            return
        self._loaded = True
        try:
            self.queue.migrate(self.path, 'rows', self._migrate_row, default_kind='transcribe')
        except (OSError, ValueError, TypeError) as e:
            self.degraded = True
            self.logger.warning('lyrics queue migration %s unreadable (%s)', self.path, e)
        self._receipts = self.queue.receipts(self.kinds)
        self._sync()
        self._rebuild_progress()
        changed = self.queue.recover(self.kinds, restart=True)
        self._handle_recovered(changed)
        self._apply_pending_failures()
        self._save()

    def _apply_pending_failures(self):
        # A claim on another connection may have expired the lease. Applying
        # the feature outcome is idempotent and acknowledged on the item.
        for row in list(self._rows.values()):
            if row.status == STATUS_FAILED and self.queue.failure_pending(row.id):
                self.on_failure(row, row.error or 'error')
                self.queue.failure_applied(row.id)
                self.progress_tracker.update_progress(row.progress_id, row.item)
                self._finish_if_done(row.progress_id)

    def _apply_result(self, data, lrc, source, extra):
        row = self._rows[data['id']]
        self.on_result(row, lrc, source, extra)

    def _rebuild_progress(self) -> None:
        by_batch: dict[str, list[QueueRow]] = {}
        for row in self._rows.values():
            if row.status in (STATUS_QUEUED, STATUS_LEASED) or self.queue.failure_pending(row.id):
                by_batch.setdefault(row.progress_id, []).append(row)
        for progress_id, rows in by_batch.items():
            if self.progress_tracker.get_progress(progress_id) is None:
                total = sum(1 for r in self._rows.values() if r.progress_id == progress_id)
                self.progress_tracker.create_progress(progress_id, total)
                for r in self._rows.values():
                    if r.progress_id == progress_id and r.status in (STATUS_DONE, STATUS_FAILED, STATUS_CANCELLED):
                        self.progress_tracker.update_progress(progress_id, r.item)
                for r in rows:
                    self.progress_tracker.set_track_phase(progress_id, r.item, "en cola")

    def _save(self) -> None:
        self.changes.bump('lyrics')
        for row in self._rows.values():
            self.queue.save_payload(row.to_dict())

    # ------------------------------------------------------------ enqueue

    def enqueue(self, jobs: list[dict[str, Any]], *, progress_id=None, label=None) -> str:
        """``jobs``: ``{relPath, item, text?, isolateVocals?, stemsVocals?}``. Returns the batch's progress id."""
        with self._lock:
            self._ensure_loaded()
            wanted = {str(j['relPath']) for j in jobs}
            lanes = {str(j['relPath']): j.get('lane', 'now' if len(jobs) == 1 else 'library') for j in jobs}
            for current in self._rows.values():
                batch = {r.rel_path for r in self._rows.values() if r.progress_id == current.progress_id and r.status in (STATUS_QUEUED, STATUS_LEASED)}
                if batch == wanted and progress_id is None:
                    for row in self._rows.values():
                        if row.progress_id == current.progress_id and row.status == STATUS_QUEUED and LANES[lanes[row.rel_path]] < LANES[row.lane]:
                            row.lane = lanes[row.rel_path]
                    self._save()
                    return current.progress_id
            progress_id = progress_id or f"lyrics-agent-{uuid.uuid4()}"
            label = label or (str(jobs[0].get('item') or jobs[0]['relPath']) if len(jobs) == 1 else f"{len(jobs)} canciones")
            items = [{'item': str(j.get('item') or j['relPath']), 'rel_path': j['relPath'],
                      'detail': {'_retry': {'producer': 'lyrics-helper', 'job': j}}} for j in jobs]
            self.progress_tracker.create_progress(progress_id, len(jobs), kind='lyrics-helper', label=label, items=items)
            if self.ledger:
                record = self.ledger.get(progress_id)
                indices = [i['idx'] for i in self.ledger.items(progress_id) if i['attempt'] == record['attempt']]
            else:
                record, indices = {'attempt': 1}, list(range(len(jobs)))
            for index, job in zip(indices, jobs, strict=True):
                row = QueueRow(
                    id=f"q{uuid.uuid4().hex[:12]}",
                    rel_path=str(job["relPath"]),
                    item=str(job.get("item") or job["relPath"]),
                    progress_id=progress_id,
                    job_idx=index, job_attempt=record["attempt"],
                    created_at=self.now(),
                    text=job.get("text"),
                    expected_lyric=job.get("expectedLyric"),
                    selection=job.get("selection"),
                    isolate_vocals=bool(job.get("isolateVocals", True)),
                    stems_vocals=bool(job.get("stemsVocals", False)),
                    lane=job.get('lane', 'now' if len(jobs) == 1 else 'library'),
                )
                data = self.queue.enqueue(row.kind, f'{progress_id}:{row.job_attempt}:{row.job_idx}',
                    row.to_dict(), job_id=progress_id, idx=row.job_idx, attempt=row.job_attempt)
                row = QueueRow.from_dict(data)
                self._rows[row.id] = row
                self.progress_tracker.set_track_phase(progress_id, row.item, "en cola")
            self._save()
            return progress_id

    def cancel(self, progress_id: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            touched = False
            for row in self._rows.values():
                if row.progress_id != progress_id:
                    continue
                if self.queue.cancel(row.id):
                    self.worker.finished(row.id)
                    row.__dict__.update(QueueRow.from_dict(self.queue.get(row.id)).__dict__)
                    self.progress_tracker.update_progress(progress_id, row.item)
                    touched = True
            if touched:
                self._finish_if_done(progress_id)
                self._save()
            return touched

    # -------------------------------------------------------------- agent

    def _reap(self) -> None:
        self._ensure_loaded()
        self._reap_locked()

    def has_claimable(self, identity: str) -> bool:
        self._ensure_loaded()
        helpers = self.worker.scheduling_helpers()
        return any(r.status == STATUS_QUEUED and ranking.can_claim(helpers, identity, r.kind, r.needs, r.offered_at, now=self.now()) for r in self._rows.values())

    def _can_claim(self, row, identity):
        return self.worker.can_claim(row, identity)

    def _handle_recovered(self, changed):
        batches = set()
        for data in changed:
            row = self._rows.get(data['id'])
            if row is None:
                continue
            row.__dict__.update(QueueRow.from_dict(data).__dict__)
            self.worker.finished(row.id)
            if row.status == STATUS_FAILED:
                self.on_failure(row, row.error)
                self.queue.failure_applied(row.id)
                self.progress_tracker.update_progress(row.progress_id, row.item)
                batches.add(row.progress_id)
            else:
                self.progress_tracker.set_track_phase(row.progress_id, row.item, 'en cola')
        for progress_id in batches:
            self._finish_if_done(progress_id)
        if changed:
            self._save()

    def _reap_locked(self) -> None:
        self._handle_recovered(self.queue.recover(self.kinds))

    def release_helper(self, identity: str) -> None:
        with self._lock:
            self._ensure_loaded()
            self._handle_recovered(self.queue.recover(self.kinds, holder=identity))

    def owns_lease(self, lease: str, job_id: str, identity: str) -> bool:
        with self._lock:
            self._ensure_loaded()
            return self.queue.owns(job_id, lease, identity)

    def claim(self, agent: dict[str, Any], max_jobs: int = 1) -> dict[str, Any]:
        name = worker_id(agent)
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            if not self.worker.seen(agent):
                return {**REPLACED, "jobs": []}
            if refusal := self.worker.claim_refusal(agent):
                return {**refusal, "jobs": []}
            for row in list(self._rows.values()):
                if row.status == STATUS_LEASED and not self.worker.accepts(row.leased_by):
                    self._handle_recovered(self.queue.recover(self.kinds, holder=row.leased_by))
            lease = uuid.uuid4().hex
            if self.worker.busy(name):
                return {"lease": lease, "jobs": [], "queued": self._count(STATUS_QUEUED)}
            handed: list[dict[str, Any]] = []
            data = self.queue.claim(self.kinds, name, eligible=lambda r: max_jobs > 0 and self.worker.can_claim(r, name))
            if data:
                row = self._rows[data['id']]
                row.__dict__.update(QueueRow.from_dict(data).__dict__)
                lease = row.lease
                self.worker.working(row.id, name, row.item, row.phase)
                album, _, file_name = row.rel_path.partition("/")
                stem_base = f"/api/stems/{quote(album, safe='')}/{quote(file_name, safe='')}"
                handed.append(
                    {
                        "id": row.id,
                        "kind": row.kind, "needs": row.needs, "offeredAt": row.offered_at, "leasedBy": name,
                        "relPath": row.rel_path,
                        "album": album,
                        "file": file_name,
                        "item": row.item,
                        "text": row.text,
                        "isolateVocals": row.isolate_vocals,
                        "mediaPath": f"/api/media/{quote(album, safe='')}/{quote(file_name, safe='')}",
                        # Additive: an older agent ignores it and runs demucs.
                        "vocalsPath": f"{stem_base}/vocals" if row.stems_vocals and row.text else None,
                    }
                )
            if handed:
                self._save()
            return {"lease": lease, "jobs": handed, "queued": self._count(STATUS_QUEUED)}

    def heartbeat(self, lease: str = "", job_id: str = "", phase: str | None = None, percent: float | None = None, agent: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            row = self._rows.get(job_id)
            if row and self.ledger:
                record = self.ledger.get(row.progress_id)
                if not record or record['state'] not in ('queued', 'running') or record['attempt'] != row.job_attempt:
                    row = None
            if agent is not None:
                if not self.worker.seen(agent, enroll=False):
                    return dict(REPLACED)
                if not lease and not job_id:
                    return {"stop": False}
            if row is None or row.lease != lease or row.status != STATUS_LEASED or (agent and worker_id(agent) != row.leased_by):
                return {"stop": True, "reason": "lease-lost"}
            response = self.queue.heartbeat(row.id, lease, phase, percent)
            if response['stop']:
                return response
            row.__dict__.update(QueueRow.from_dict(self.queue.get(row.id)).__dict__)
            if agent is None:
                # Compatibility with workers whose heartbeat only names a lease.
                self.worker.touch(row.leased_by)
            row.phase = phase or row.phase
            self.worker.working(row.id, row.leased_by, row.item, row.phase)
            if phase:
                self.progress_tracker.set_track_phase(row.progress_id, row.item, phase, percent)
            return {"stop": False}

    def result(self, lease: str, job_id: str, *, ok: bool, lrc: str | None = None, source: str | None = None, error: str | None = None, final: bool = True, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        """``final=False`` marks an accident (a crash, a lost download) worth another
        attempt; a verdict ("no lyrics in this audio") is final and lands in pending."""
        with self._lock:
            self._ensure_loaded()
            self.worker.reap()
            receipt = self._receipts.get(lease)
            if receipt and receipt["jobId"] == job_id:
                return receipt["response"].copy()
            row = self._rows.get(job_id)
            if row and self.ledger:
                record = self.ledger.get(row.progress_id)
                if not record or record['state'] not in ('queued', 'running') or record['attempt'] != row.job_attempt:
                    row = None
            if row is None or not self.queue.owns(job_id, lease) or not self.worker.accepts(row.leased_by):
                return {"accepted": False, "reason": "lease-lost"}
            self.worker.finished(row.id)
            if ok and lrc and lrc.strip():
                try:
                    row.result = {**(row.provenance or self.worker.result_metadata(row.leased_by, 0)),
                                  'seconds': max(0, self.now() - row.leased_at),
                                  **{key: value for key, value in (extra or {}).items()
                                     if key in {'accel', 'fallbackReason', 'gpu'}}}
                    if not self.queue.complete(row.id, lease, lrc, source or 'stt', extra or {},
                                               execution={key: value for key, value in (extra or {}).items()
                                                          if key in {'accel', 'fallbackReason', 'gpu'}}):
                        return {"accepted": False, "reason": "lease-lost"}
                    try:
                        duration = self.duration(row.rel_path)
                    except Exception:  # noqa: BLE001
                        duration = None
                    self.worker.record_result(row.leased_by, row.kind, row.result['seconds'], duration)
                except Exception as e:  # noqa: BLE001 — a refused save is a failed row
                    self.queue.fail(row.id, lease, str(e)[:200], final=True)
            else:
                reason = (error or "el agente no devolvió letra")[:200]
                retry = self.queue.fail(row.id, lease, reason, final=final)
                if retry:
                    row.__dict__.update(QueueRow.from_dict(self.queue.get(row.id)).__dict__)
                    # Historically lyrics do not expose accident reasons while queued.
                    self.progress_tracker.set_track_phase(row.progress_id, row.item, 'en cola')
                    self._receipt(lease, row, {"accepted": True, "requeued": True})
                    self._save()
                    return {"accepted": True, "requeued": True}
            result = row.result
            row.__dict__.update(QueueRow.from_dict(self.queue.get(row.id)).__dict__)
            row.result = result
            if row.status == STATUS_FAILED:
                self.on_failure(row, row.error)
                self.queue.failure_applied(row.id)
            self._receipt(lease, row, {"accepted": True})
            self.progress_tracker.update_progress(row.progress_id, row.item)
            self._finish_if_done(row.progress_id)
            self._save()
            return {"accepted": True}

    def _receipt(self, lease: str, row: QueueRow, response: dict[str, Any]) -> None:
        self._receipts[lease] = {"jobId": row.id, "identity": row.leased_by, "response": response, "row": row.to_dict()}
        self.queue.receipt(row.kind, lease, self._receipts[lease])

    def result_response(self, lease: str, job_id: str, identity: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_loaded()
            receipt = self._receipts.get(lease)
            if receipt and receipt["identity"] == identity and receipt["jobId"] == job_id:
                return receipt["response"].copy()
            return None

    def _finish_if_done(self, progress_id: str) -> None:
        rows = [r for r in self._rows.values() if r.progress_id == progress_id]
        if any(r.status in (STATUS_QUEUED, STATUS_LEASED) for r in rows):
            return
        # A reboot or a retry can leave prior successes outside this live view.
        # The ledger owns the batch totals across every item attempt.
        record = self.ledger.get(progress_id)
        done = record['succeeded']
        failed = record['failed'] + record['skipped']
        cancelled = any(r.status == STATUS_CANCELLED for r in rows)
        self.progress_tracker.complete_progress(
            progress_id, "cancelled" if cancelled and done == 0 else "done", succeeded=done, failed=failed
        )
        # Finished rows are not worth keeping around; the index has the lyric.
        for r in rows:
            self.queue.save_payload(r.to_dict())
            self.queue.hide(r.id)
            self._rows.pop(r.id, None)

    # -------------------------------------------------------------- status

    def _count(self, status: str) -> int:
        return sum(1 for r in self._rows.values() if r.status == status)

    @property
    def version(self) -> int:
        with self._lock:
            return self.ledger.version

    def waiting_tracks(self) -> dict[str, float]:
        """Track identities for an exact union with catalog misses, not a count sum."""
        with self._lock:
            return {r['rel_path']: r['created_at'] for r in self.queue.rows(self.kinds)
                    if r['status'] in (STATUS_QUEUED, STATUS_LEASED)}

    def status(self, *, read_only=False) -> dict[str, Any]:
        with self._lock:
            if not read_only or not self._loaded:
                self._ensure_loaded()
            if read_only:
                rows_by_id = {data['id']: QueueRow.from_dict(data) for data in self.queue.rows(self.kinds)}
            else:
                self._reap_locked()
                rows_by_id = self._rows
            legacy = self.worker.legacy()
            live = [r for r in rows_by_id.values() if r.status in (STATUS_QUEUED, STATUS_LEASED)]
            waiting = min((r for r in live if r.status == STATUS_QUEUED), key=lambda r: r.created_at, default=None)
            running = None
            if live:
                head = min(live, key=lambda r: r.created_at)
                batch = [r for r in rows_by_id.values() if r.progress_id == head.progress_id]
                state = self.progress_tracker.get_progress(head.progress_id)
                running = {
                    "progressId": head.progress_id,
                    "total": state.total if state else len(batch),
                    "done": state.completed if state else 0,
                    "saved": None,
                    "failed": None,
                }
            helpers = self.worker.scheduling_helpers()
            return {
                "rows": [r.snapshot(helpers) for r in live],
                "queued": sum(r.status == STATUS_QUEUED for r in rows_by_id.values()),
                "leased": sum(r.status == STATUS_LEASED for r in rows_by_id.values()),
                **legacy,
                "worker": self.worker.snapshot(waiting.kind) if waiting else self.worker.snapshot(),
                "helpers": self.worker.helpers(),
                "waitReason": self.worker.wait_reason(waiting.kind, waiting.needs) if waiting else self.worker.wait_reason(),
                "oldestAt": min((r.created_at for r in live), default=None),
                "oldestQueuedAt": min((r.created_at for r in rows_by_id.values() if r.status == STATUS_QUEUED), default=None),
                "running": running,
            }
