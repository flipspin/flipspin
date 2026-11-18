"""Music's analysis JobKind and read/correction service over the one helper queue."""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from urllib.parse import quote

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.domains.helpers import helper_ranking as ranking
from app.domains.helpers.mac_worker import worker_id
from app.domains.helpers.nest_helper import NEST_ID
from app.domains.music.analysis_runs import RunControls, RunConflict, category
from app.domains.music.analysis_constants import ENGINE, ENGINE_VERSION, WRITEBACK_RULES_VERSION
from app.domains.music.analysis_mood import _classify_mood
from app.domains.music.analysis_precedence import precedence, effective_confidences
from app.domains.music.tag_edits import TagEdits
from app.domains.metadata.tagwriter import file_lock
from app.domains.music.analysis_writeback import owned_tags, reconcile_ownership, write_tags
from app.domains.music.key_tag_migration import KeyTagMigration
from app.exceptions import ValidationError as CursorError
from app.infra.jobs.kinds import JobKind
from app.infra.jobs.queue import Queue, LANES, lane as job_lane
from app.utils.library_paths import rel_path_for, resolve_rel_path, split_rel_path

logger = logging.getLogger(__name__)
NEEDS = ('jobs:analysis', f'analysis>={ENGINE_VERSION}')
_WRITEBACK_RULES_LOCK = threading.Lock()
WRITEBACK_PAUSE_SECONDS = 0.1
NEST_ANALYSIS_REST_S = 30.0


class Measurement(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra='forbid', populate_by_name=True)
    rel_path: str = Field(alias='relPath')
    size: int = Field(ge=0)
    mtime_ns: int = Field(alias='mtimeNs', ge=0)
    engine: str = Field(pattern=f'^{re.escape(ENGINE)}$')
    engine_version: int = Field(alias='engineVersion', ge=ENGINE_VERSION, le=ENGINE_VERSION)
    key: str | None = Field(pattern=r'^(?:[1-9]|1[0-2])[AB]$')
    key_conf: float = Field(alias='keyConf', ge=0, le=1)
    bpm: float | None = Field(ge=30, le=300)
    bpm_conf: float = Field(alias='bpmConf', ge=0, le=1)
    energy: float
    brightness: float
    pulse: float
    track_lufs: float | None = Field(default=None, alias='trackLufs', ge=-70, le=0)
    true_peak: float | None = Field(default=None, alias='truePeak', ge=0, le=8)
    lra: float | None = Field(default=None, ge=0, le=100)
    decode_seconds: float | None = Field(default=None, alias='decodeSeconds', ge=0)
    loudness_blocks: list[Annotated[float, Field(ge=-70, le=30)]] | None = Field(default=None, alias='loudnessBlocks', max_length=1000000)


class Failure(BaseModel):
    model_config = ConfigDict(extra='forbid')
    relPath: str
    ok: bool = Field(default=False)
    error: str = Field(min_length=1, max_length=200)
    final: bool


class AnalysisService:
    engine_version = ENGINE_VERSION
    needs = NEEDS

    def __init__(self, config, repository, music, ledger, worker):
        self.config, self.repository, self.music = config, repository, music
        self.queue, self.worker = Queue.for_ledger(ledger), worker
        self.queue.kinds.register(JobKind('analysis', NEEDS, self._apply_result, 'analysis',
                                         queued_phase='queued', failed_phase='failed', order=2,
                                         can_claim=self._can_claim,
                                         provenance=lambda identity: {**self.worker.result_metadata(identity, 0), "accel": "cpu"}))
        worker.register_needs('analysis', NEEDS)
        self._scan_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._migrating = False
        self._nest_finished_at = {}
        self._pending_writebacks = {}
        # The last library state the loop answered. Seeded from the persisted
        # snapshot so changes made while the server was down still count.
        self._scanned_folders = dict(getattr(getattr(music, 'scans', None), 'folders', None) or {})
        self._scanned_flags = None
        # Retain changed folders while automatic arrivals are paused, without
        # making the idle loop repeat a pass. Re-enabling can then catch up.
        self._pending_folders = set()
        self.runs = RunControls(self)
        worker.register_release(self.release_helper)
        worker.register_reap(self.reap)
        with worker.lock:
            # Evict queued legacy work before restart recovery requeues leases.
            # Already leased work retains the normal recovery/finish path.
            self._evict_automatic()
            self._recovered(self.queue.recover(('analysis',), restart=True))
            self.runs.reconcile(boot=True)

    def _recovered(self, rows):
        for row in rows:
            self.worker.finished(row['id'])
        for row in self.queue.rows(('analysis',)):
            if self.queue.failure_pending(row['id']):
                self.repository.error(row['relPath'], row['error'], (row['size'], row['mtimeNs']))
                self.queue.failure_applied(row['id'])
        self.runs.reconcile()

    def reap(self):
        self._recovered(self.queue.recover(('analysis',)))

    def release_helper(self, identity):
        self._recovered(self.queue.recover(('analysis',), holder=identity))

    def _scan_flags(self):
        return (str(self.config.base_music_dir), self.config.analysis_auto)

    def _scan_due(self):
        """A pass only when the library on disk or the switches changed (no periodic walk)."""
        return self._scanned_flags != self._scan_flags() or self.music.scans.folders != self._scanned_folders

    def scan(self):
        """Explicit/background scan only. Listings never invoke this producer.

        Limit the pass to songs in folders whose signature moved
        since the last pass, plus arrivals: no per-file work for an unchanged library.
        """
        if not self._scan_lock.acquire(blocking=False):
            return 0
        try:
            try:
                paths = self.runs.files()
            except RunConflict:
                return 0
            root = self.config.base_music_dir
            # Discovery owns first_seen and commits the root baseline only after
            # a complete, successful scan. Failed/partial scans produce no work.
            self.music.refresh(reason='analysis')
            if self.music.scans.error or root != self.config.base_music_dir:
                return 0
            arrivals = self.music.scans.store.analysis_arrivals(root)
            flags, folders = self._scan_flags(), dict(self.music.scans.folders)
            moved = {f for f, sig in folders.items() if self._scanned_folders.get(f) != sig}
            self._pending_folders.update(moved)
            paths = [p for p in paths if str(p.parent) in self._pending_folders or str(p) in arrivals]
            visible_revision = self.repository.revision
            self.repository.sweep(self.config.base_music_dir)
            self.repository.recompute_arousals()
            if self.repository.revision != visible_revision:
                self.music.invalidate_scan()
            count = self.enqueue_files(paths, background=True, arrivals=arrivals)
            self.runs.reconcile()
            if self.config.analysis_auto:
                self._pending_folders.clear()
            self._scanned_folders, self._scanned_flags = folders, flags
            return count
        finally:
            self._scan_lock.release()

    @staticmethod
    def tag_sha(path):
        from app.domains.metadata.tagwriter import identity, TagError
        try:
            return identity(path)['tagSha']
        except (OSError, ValueError, TagError):
            return None  # Unreadable inputs still reach the helper's normal failure path.

    def remember_tag_signature(self, rel, path):
        stat = path.stat()
        self.repository.tag_record(rel, 'file_tag_signature', {
            'sha': self.tag_sha(path), 'size': stat.st_size, 'mtime': stat.st_mtime_ns})

    def payload(self, path):
        stat = path.stat()
        rel = rel_path_for(self.config.base_music_dir, path)
        album, file = split_rel_path(rel)
        return {'engineVersion': ENGINE_VERSION, 'relPath': rel, 'album': album, 'file': file,
                'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns,
                'tagSha': self.tag_sha(path),
                'mediaUrl': f'/api/media/{quote(album, safe="")}/{quote(file, safe="")}',
                'lane': 'new', 'nest': True, 'force': False}

    def enqueue_files(self, paths, *, run=None, lane='new', nest=True, refresh=True, background=False, arrivals=()):
        with self.worker.lock:
            if run is not None:
                keys = {rel_path_for(self.config.base_music_dir, Path(p)) for p in paths}
                tracks = [t['payload'] for t in self.runs.store.tracks(run['id']) if t['rel_path'] in keys]
                self.runs.materialize(run, tracks)
                return sum(t['owned'] for t in tracks)
            existing = {r['relPath']: r for r in self.queue.rows(('analysis',))}
            cancelled = self.runs.store.cancelled()
            wanted, replaced = [], 0
            for path in paths:
                path = Path(path)
                rel = rel_path_for(self.config.base_music_dir, path)
                if not rel or not self._available(rel, path) or path.suffix.lower() not in self.music.AUDIO_EXTENSIONS:
                    continue
                payload = {**self.payload(path), 'lane': lane, 'nest': nest}
                row, old = self.repository.get(rel), existing.get(rel)
                if row and row['missing_since'] is not None:
                    continue
                state = category(row, path.stat())
                saved = self.repository.tag_record(rel, 'file_tag_signature')
                tags_changed = bool(row and saved.get('sha') and payload.get('tagSha')
                                    and (saved['size'], saved['mtime']) == (row['size'], row['mtime_ns'])
                                    and saved['sha'] != payload['tagSha'])
                if tags_changed:
                    state = 'waiting'
                changed = tags_changed or row and row['analyzed_at'] and (row['size'], row['mtime_ns']) != (
                    payload['size'], payload['mtimeNs'])
                arrival_work = old and old['status'] in ('queued', 'leased') and not self._retired_automatic(old)
                eligible = not background or changed or arrival_work or str(path) in arrivals
                payload['autoSource'] = 'arrival'
                enabled = self.config.analysis_auto and eligible
                if old and old['status'] in ('queued', 'leased'):
                    if (old['size'], old['mtimeNs'], old.get('engineVersion'), old.get('tagSha')) == (
                            payload['size'], payload['mtimeNs'], ENGINE_VERSION, payload.get('tagSha')):
                        # Acquisition may arrive after a library scan. Promote
                        # the queued item without duplicating or demoting it.
                        if enabled and old['status'] == 'queued' and not self._owner_work(old):
                            promote = LANES[payload['lane']] < LANES[job_lane(old)]
                            if promote:
                                old['autoSource'] = 'arrival'
                                old['lane'] = payload['lane']
                                self.queue.save_payload(old)
                        continue
                    # Owner runs retain their controls. Changed automatic work
                    # becomes an arrival even if it began as library/upgrade work.
                    owned = self._owner_work(old)
                    if enabled or owned:
                        fresh = {**old, **{k: payload[k] for k in ('size', 'mtimeNs', 'engineVersion', 'tagSha')}}
                        if not owned:
                            fresh.update(lane=payload['lane'], autoSource='arrival', nest=payload['nest'])
                            fresh.pop('night', None)
                        if self.queue.replace(old['id'], fresh):
                            self.worker.finished(old['id'])
                            self.runs.store.replace(rel, fresh)
                            replaced += 1
                    continue
                suppressed = cancelled.get(rel)
                if suppressed and (suppressed['size'], suppressed['mtimeNs']) == (payload['size'], payload['mtimeNs']):
                    continue
                if state != 'waiting':
                    continue
                if not enabled:
                    continue
                if old and old['status'] == 'failed' and (old['size'], old['mtimeNs']) == (payload['size'], payload['mtimeNs']):
                    continue
                if old:
                    self.queue.hide(old['id'])
                wanted.append(payload)
                existing[rel] = {**payload, 'status': 'queued'}
            if wanted:
                job_id = self.queue.ledger.start('analysis', f'{len(wanted)} canciones',
                    [{'item': p['file'], 'rel_path': p['relPath'], 'detail': {'trigger': 'new'}} for p in wanted], 'system')
                for idx, payload in enumerate(wanted):
                    self.queue.enqueue('analysis', payload['relPath'], payload, job_id=job_id, idx=idx)
            if refresh and (wanted or replaced):
                self.music.invalidate_scan()
            return len(wanted) + replaced

    def set_auto(self, enabled):
        with self.worker.lock:
            if self.config.analysis_auto == enabled:
                return
            self.config.analysis_auto = enabled
            if not enabled:
                self._evict_automatic()
            # The next scan tick queues pending arrivals as one job.
            logger.info('Analysis automatic processing enabled=%s', enabled)

    @staticmethod
    def _retired_automatic(row):
        # Pre-marker library work used the library lane. Explicit bulk arrivals
        # carry autoSource=arrival, even when they share that lane.
        return bool(row.get('night') or row.get('autoSource') in ('library', 'upgrade') or
                    not row.get('autoSource') and job_lane(row) == 'library')

    def _owner_work(self, row, live=None):
        live = live if live is not None else {r['id'] for r in self.runs.store.live()}
        return row.get('runId') in live or bool(live.intersection(row.get('ownerRuns', [])))

    def _evict_automatic(self):
        live = {r['id'] for r in self.runs.store.live()}
        for row in self.queue.rows(('analysis',)):
            if (row['status'] == 'queued' and not self._owner_work(row, live) and
                    (self._retired_automatic(row) or not self.config.analysis_auto)):
                self.queue.cancel(row['id'])
                self.queue.hide(row['id'])
        self.music.invalidate_scan()

    def cancel_job(self, job_id):
        with self.worker.lock:
            job = self.queue.ledger.get(job_id)
            rows = [i for i in self.queue.ledger.items(job_id) if i.get('queue_id')]
            self.queue.ledger.cancel(job_id, job['attempt'])
            for row in rows:
                self.worker.finished(row['queue_id'])
            for run in self.runs.store.live():
                if run['job_id'] == job_id:
                    self.runs.store.end(run['id'], 'cancelled')
            self.music.invalidate_scan()

    def startup(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._migrating = True
        self._scanned_flags = None  # One pass per boot catches events missed while down.
        def run():
            from app.domains.music.analysis_legacy import migrate_legacy_tags
            try:
                self.repository.recompute_moods()
                self.repository.recompute_arousals()
                self.music.invalidate_scan()
            except Exception:
                logger.exception('Analysis derived values migration failed; retry on next boot')
                return
            try:
                migrate_legacy_tags(self.config, self.repository)
            except Exception:
                logger.exception('Analysis ownership migration failed; retry on next boot')
                return
            try:
                if not KeyTagMigration(self.config, self.repository, self.music, self.worker,
                                       self._scan_lock, self._stop).run():
                    return
            except Exception:
                logger.exception('Key tag notation migration failed; retry on next boot')
                return
            try:
                if not self.reapply_writeback_rules():
                    return
            except Exception:
                logger.exception('Analysis write-back rules failed; retry on next boot')
                return
            self._migrating = False
            while not self._stop.is_set():
                try:
                    self.runs.reconcile()
                    if self._scan_due():
                        self.scan()
                except Exception:
                    logger.exception('Analysis scan failed')
                self._stop.wait(30)
        self._thread = threading.Thread(target=run, name='analysis-scan', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def reapply_writeback_rules(self):
        """A stopped/failed pass leaves the version pending for the next boot."""
        if not self.config.write_analysis_tags:
            return True
        while not _WRITEBACK_RULES_LOCK.acquire(blocking=False):
            if self._stop.wait(WRITEBACK_PAUSE_SECONDS):
                return False
        try:
            if self.repository.meta('writeback_rules_version') == WRITEBACK_RULES_VERSION:
                return True
            counts = dict.fromkeys(('rewritten', 'removed', 'untouched'), 0)
            for rel in self.repository.owned_tag_paths():
                while not self._scan_lock.acquire(blocking=False):
                    if self._stop.wait(WRITEBACK_PAUSE_SECONDS):
                        return False
                try:
                    if self._stop.is_set():
                        return False
                    with self.worker.lock:
                        outcome = self._reapply_file_writeback(rel)
                        counts[outcome] += 1
                finally:
                    self._scan_lock.release()
                if self._stop.wait(WRITEBACK_PAUSE_SECONDS):
                    return False
            if self._stop.is_set():
                return False
            self.repository.writeback_rules_applied(WRITEBACK_RULES_VERSION)
            self.music.invalidate_scan()
            logger.info('Analysis write-back rules: rewritten=%d removed=%d untouched=%d',
                        counts['rewritten'], counts['removed'], counts['untouched'])
            return True
        finally:
            _WRITEBACK_RULES_LOCK.release()

    def _reapply_file_writeback(self, rel):
        path = resolve_rel_path(self.config.base_music_dir, rel)
        with file_lock(path):
            row = self.repository.get(rel)
            if not row or row['tag_owner'] != 'krobi' or not row['analyzed_at']:
                return 'untouched'
            if not path.is_file():
                return 'untouched'  # The following scan sweeps missing files.
            stat = path.stat()
            row, tags = reconcile_ownership(self.repository, rel, row, self.music.read_tags(path), stat)
            if row['tag_owner'] != 'krobi':
                return 'untouched'
            owned = tags.get('owned_fields', True)
            outcome = write_tags(path, row, owned=owned, owned_only=True, expected=(stat.st_size, stat.st_mtime_ns), writer=TagEdits(self.config, self.repository, self.music).edit)
            if not outcome or not outcome[0]:
                return 'untouched'
            self.repository.signature(rel, path.stat(), outcome[1], outcome[2])
            self.remember_tag_signature(rel, path)
            self.repository.tag_record(rel, 'tag_values', self.music.read_tags(path))
            return 'rewritten' if outcome[1] else 'removed'

    def claim(self, agent):
        identity = worker_id(agent)
        with self.worker.lock:
            self.worker.reap()
            if not self.worker.seen(agent):
                return {'stop': True, 'reason': 'replaced'}
            if refusal := self.worker.claim_refusal(agent):
                return refusal
            rows = self.queue.claim_batch(('analysis',), identity)
            if not rows:
                return None
            for row in rows:
                self.worker.working(row['id'], identity, row['file'], 'analizando')
            return {'job': {'id': rows[0]['id'], 'kind': 'analysis', 'input': {'items': [
                {k: row[k] for k in ('relPath', 'album', 'file', 'size', 'mtimeNs', 'mediaUrl')} for row in rows]}},
                    'lease': rows[0]['lease']}

    def _can_claim(self, row, identity):
        return self._claimable(row, identity) and self._available(row['relPath']) and self.worker.can_claim(row, identity)

    def _claimable(self, row, identity):
        if identity != NEST_ID:
            return True
        if row.get('libraryRun') or not row.get('nest', True):
            return False
        gentle = not self.worker.compute or self.worker.compute.settings.limits({'nest': True})['pace'] == 'gentle'
        if gentle and row.get('runId') and self.queue.now() - self._nest_finished_at.get(row['runId'], float('-inf')) < NEST_ANALYSIS_REST_S:
            return False
        return not any(r['status'] == 'leased' for r in self.queue.rows(('align', 'transcribe', 'stems')))

    def _available(self, rel, path=None):
        """Fence ghosts and vanished files, including previously queued work."""
        row = self.repository.get(rel)
        if row and row['missing_since'] is not None:
            return False
        try:
            path = path if path is not None else resolve_rel_path(self.config.base_music_dir, rel)
            return path.is_file()
        except (CursorError, ValueError, OSError):
            return False

    def _leased(self, id, lease, identity):
        return [r for r in self.queue.rows(('analysis',))
                if r.get('batchId', r['id']) == id and r['lease'] == lease
                and self.queue.owns(r['id'], lease, identity)]

    def heartbeat(self, id, lease, identity, phase=None, progress=None):
        with self.worker.lock:
            rows = self._leased(id, lease, identity)
            if not rows or not self.worker.accepts(identity):
                return {'stop': True, 'reason': 'lease-lost'}
            for row in rows:
                answer = self.queue.heartbeat(row['id'], lease, phase, progress)
                if answer.get('stop'):
                    self.worker.finished(row['id'])
                    return answer
                self.worker.working(row['id'], identity, row['file'], phase)
            self.worker.touch(identity)
            return {'stop': False}

    def _apply_result(self, row, measurement):
        data = measurement.model_dump()
        data['bpm'] = round(data['bpm'], 1) if data['bpm'] is not None else None
        self.repository.apply(row['relPath'], data, _classify_mood(data['bpm'], data['energy'], data['brightness'], data['pulse']),
                              analyzed_by=row['leased_by'], accel='cpu')

    def _writeback(self, rel, path, fixed=None, owned=None, expected=None, principal='analysis', *, album=True):
        if not album:
            if not self.config.write_analysis_tags:
                return
            # The result's album pass writes track and album fields together.
            # Writing here as well creates two edits for every fresh singleton.
            # Retain ownership determined before committing the measurements.
            self._pending_writebacks[rel] = (owned, expected)
            return
        with file_lock(path):
            if not self.config.write_analysis_tags:
                return
            try:
                originals = self.repository.tag_record(rel, 'tag_originals')
                measured = self.repository.get(rel)
                if owned is None:
                    measured, tags = reconcile_ownership(self.repository, rel, measured, self.music.read_tags(path), path.stat())
                    owned = tags.get('owned_fields', owned_tags(measured, tags))
                outcome = write_tags(path, measured, fixed=fixed, owned=owned, originals=originals,
                                     expected=expected, principal=principal,
                                     writer=TagEdits(self.config, self.repository, self.music).edit)
                if outcome and outcome[0]:
                    self.repository.signature(rel, path.stat(), outcome[1], outcome[2])
                    self.remember_tag_signature(rel, path)
                    self.repository.tag_record(rel, 'tag_values', self.music.read_tags(path))
                    if fixed:
                        self.repository.tag_record(rel, 'tag_originals', {f: v for f, v in originals.items()
                                                                        if f not in fixed or fixed[f] is not None})
            except Exception:
                logger.exception('Analysis tag write failed: %s', rel)

    def result(self, id, lease, items, identity):
        with self.worker.lock:
            visible_revision = self.repository.revision
            receipt = self.queue.receipts(('analysis',)).get(lease)
            if receipt and receipt['id'] == id and receipt['identity'] == identity:
                return receipt['response']
            leased = self._leased(id, lease, identity)
            if not leased or not self.worker.accepts(identity):
                return {'accepted': False, 'stop': True, 'reason': 'lease-lost'}
            rows = {r['relPath']: r for r in leased}
            members = set(leased[0].get('batchKeys', rows))
            responses, seen = [], set()
            for item in items:
                rel = item.get('relPath') if isinstance(item, dict) else None
                row = rows.get(rel)
                if not row or rel in seen:
                    responses.append({'relPath': rel, 'status': 200, 'dropped': True} if rel in members and rel not in seen
                                     else {'relPath': rel, 'status': 422, 'error': 'unclaimed-item'})
                    continue
                seen.add(rel)
                try:
                    value = Failure.model_validate(item) if item.get('ok') is False else Measurement.model_validate(item)
                except ValidationError:
                    self.queue.fail(row['id'], lease, 'invalid-result', final=True)
                    self.repository.error(rel, 'invalid-result', (row['size'], row['mtimeNs']))
                    self.worker.finished(row['id'])
                    responses.append({'relPath': rel, 'status': 422, 'error': 'invalid-result'})
                    continue
                if isinstance(value, Failure):
                    retry = self.queue.fail(row['id'], lease, value.error, final=value.final)
                    if not retry:
                        self.repository.error(rel, value.error, (row['size'], row['mtimeNs']))
                    responses.append({'relPath': rel, 'status': 200, 'requeued': bool(retry)})
                else:
                    path = resolve_rel_path(self.config.base_music_dir, rel)
                    with file_lock(path):
                        try:
                            stat = path.stat()
                        except OSError:
                            stat = None
                        tags_changed = stat and row.get('tagSha') and row['tagSha'] != self.tag_sha(path)
                        if not stat or tags_changed or (value.size, value.mtime_ns) != (stat.st_size, stat.st_mtime_ns) or (
                                value.size, value.mtime_ns) != (row['size'], row['mtimeNs']):
                            if stat and (self.config.analysis_auto or self._owner_work(row)):
                                fresh = {**row, **{k: v for k, v in self.payload(path).items() if k in ('size', 'mtimeNs', 'tagSha')}}
                                self.queue.replace(row['id'], fresh)
                                self.runs.store.replace(rel, fresh)
                            else:
                                self.queue.fail(row['id'], lease, 'signature-changed', final=True)
                                self.queue.hide(row['id'])
                                if row.get('runId'):
                                    self.repository.error(rel, 'file-missing')
                            responses.append({'relPath': rel, 'status': 200, 'dropped': True})
                        else:
                            old = self.repository.get(rel)
                            tags = self.music.read_tags(path)
                            old, tags = reconcile_ownership(self.repository, rel, old, tags, stat)
                            owned = tags.get('owned_fields', owned_tags(old, tags))
                            if not self.queue.complete(row['id'], lease, value):
                                responses.append({'relPath': rel, 'status': 200, 'dropped': True})
                                self.worker.finished(row['id'])
                                continue
                            if owned:
                                self.repository.ownership(rel, 'krobi')
                            self.remember_tag_signature(rel, path)
                            new = self.repository.get(rel)
                            if not old or new['analyzed_at'] != old.get('analyzed_at') or (old['size'], old['mtime_ns']) != (stat.st_size, stat.st_mtime_ns):
                                self._writeback(rel, path, owned=owned, expected=(stat.st_size, stat.st_mtime_ns), album=False)
                            duration = tags.get('duration')
                            self.worker.record_result(identity, 'analysis', max(0.001, self.queue.now() - row['leased_at']) / len(leased), duration)
                            responses.append({'relPath': rel, 'status': 200})
                self.worker.finished(row['id'])
                if identity == NEST_ID and row.get('runId'):
                    self._nest_finished_at[row['runId']] = self.queue.now()
            self._refresh_album_loudness(seen)
            self.repository.recompute_arousals()
            self.runs.reconcile()
            # Missing items remain leased and can be submitted later with this lease.
            response = {'accepted': True, 'items': responses}
            if seen >= rows.keys():
                self.queue.receipt('analysis', lease, {'id': id, 'identity': identity, 'response': response})
            if self.repository.revision != visible_revision:
                self.music.invalidate_scan()
            return response

    def _refresh_album_loudness(self, completed):
        pending_writebacks, self._pending_writebacks = self._pending_writebacks, {}
        # Fold disc folders using the catalog's album grouping, never display names.
        groups = self.music.album_files(self.config.base_music_dir)
        for paths in groups.values():
            members = {}
            for path in paths:
                try:
                    stat = path.stat()
                    members[rel_path_for(self.config.base_music_dir, path)] = (stat.st_size, stat.st_mtime_ns)
                except OSError:
                    members[rel_path_for(self.config.base_music_dir, path)] = None
            if not completed.intersection(members):
                continue
            gain, _peak = self.repository.album_loudness(members)
            if self.config.write_analysis_tags:
                for path in paths:
                    rel = rel_path_for(self.config.base_music_dir, path)
                    if rel not in pending_writebacks and gain is None:
                        continue
                    row = self.repository.get(rel)
                    pending = pending_writebacks.get(rel)
                    if row and members[rel] == (row['size'], row['mtime_ns']):
                        owned, expected = pending if pending else (None, members[rel])
                        self._writeback(rel, path, owned=owned, expected=expected)
                # Tag writes change signatures but never the measured audio.
                members = {rel_path_for(self.config.base_music_dir, p): (p.stat().st_size, p.stat().st_mtime_ns) if p.is_file() else None
                           for p in paths}
                self.repository.album_loudness(members)

    def state(self, rel, path, row=None):
        row = row if row is not None else self.repository.get(rel)
        if row and row.get('analyzed_at'):
            return 'analyzed'  # stale retains its old value on the public wire.
        queued = next((r for r in self.queue.rows(('analysis',)) if r['relPath'] == rel), None)
        if queued and queued['status'] in ('queued', 'leased'):
            return 'queued'
        if row and row['error'] or queued and queued['status'] == 'failed':
            return 'failed'
        return 'none'

    def view(self, rel, path):
        row = self.repository.get(rel) or {}
        tags = self.music.read_tags(path).copy()
        row, tags = reconcile_ownership(self.repository, rel, row, tags, path.stat())
        effective = precedence(row, tags)
        computed = precedence({**row, 'fixed_key': None, 'fixed_bpm': None})
        return {**effective, **effective_confidences(row, effective), 'computed': {**{f: row.get(f) for f in ('key', 'bpm')},
                                         **{f'{f}Estimated': computed[f]['estimated'] for f in ('key', 'bpm')}},
                'fixed': {f: row.get(f'fixed_{f}') for f in ('key', 'bpm')},
                'rev': row.get('rev', 0), 'state': self.state(rel, path, row)}

    def fix(self, rel, path, rev, fields, principal):
        with self.worker.lock, file_lock(path):
            stat = path.stat()
            row = self.repository.get(rel) or {}
            row, tags = reconcile_ownership(self.repository, rel, row, self.music.read_tags(path), path.stat())
            owned = tags.get('owned_fields', tags.get('tag_owner') == 'krobi')
            if not self.repository.fix(rel, rev, fields, principal):
                return False, self.view(rel, path)
            logger.info('Analysis correction principal=%s relPath=%s', principal, rel)
            if self.config.write_analysis_tags:
                originals = self.repository.tag_record(rel, 'tag_originals')
                for field, value in fields.items():
                    if value is not None and tags.get(field) is not None and not (
                            owned is True or isinstance(owned, list) and field in owned):
                        originals[field] = tags[field]
                self.repository.tag_record(rel, 'tag_originals', originals)
            self._writeback(rel, path, fields, owned=owned, expected=(stat.st_size, stat.st_mtime_ns), principal=principal)
            self.music.invalidate_scan()
            return True, self.view(rel, path)

    def summary(self):
        estimated = {'songs': 0, 'keys': 0, 'bpms': 0}
        counts = {'total': 0, 'analyzed': 0, 'outdated': 0, 'queued': 0, 'failed': 0, 'waiting': 0}
        queued = {r['relPath']: r for r in self.queue.rows(('analysis',)) if self._available(r['relPath'])}
        for files in self.music.album_files(self.config.base_music_dir).values():
            for path in files:
                rel = rel_path_for(self.config.base_music_dir, path)
                if rel is None:
                    continue
                row = self.repository.get(rel)
                if row and row['missing_since'] is not None:
                    continue
                try:
                    stat = path.stat()
                except OSError:
                    continue
                effective = self.view(rel, path)
                key_est, bpm_est = effective['key']['estimated'], effective['bpm']['estimated']
                estimated['songs'] += int(key_est or bpm_est)
                estimated['keys'] += int(key_est)
                estimated['bpms'] += int(bpm_est)
                counts['total'] += 1
                if row and row['analyzed_at'] and (row['size'], row['mtime_ns'], row['engine_version']) == (
                        stat.st_size, stat.st_mtime_ns, ENGINE_VERSION):
                    counts['analyzed'] += 1
                counts['outdated'] += int(category(row, stat) == 'outdated' and row['engine_version'] is not None and row['engine_version'] < ENGINE_VERSION)
                job = queued.get(rel)
                if job and job['status'] in ('queued', 'leased'):
                    counts['queued'] += 1
                elif job and job['status'] == 'failed' and (job['size'], job['mtimeNs']) == (stat.st_size, stat.st_mtime_ns) or category(row, stat) == 'failed':
                    counts['failed'] += 1
                elif category(row, stat) in ('waiting', 'outdated'):
                    counts['waiting'] += 1
        capable = [h for h in self.worker.scheduling_helpers() if ranking.capable(h, 'analysis', list(NEEDS))]
        helper = max(capable, key=lambda h: (ranking.online(h), h['lastSeenAt']), default=None)
        return {**counts, 'run': self.runs.progress(), 'estimated': estimated, 'engineVersion': ENGINE_VERSION, 'helper': {
            'online': bool(helper and ranking.online(helper)), 'name': helper['name'] if helper else None,
            'working': any(r['status'] == 'leased' for r in queued.values())}}

    def estimates(self, after, limit, scope):
        # Sort the full scoped listing before filtering: a confirmed/deleted cursor
        # must still locate the next page. The cursor identifies a stable sort tuple.
        rows = []
        for album in self.music.scan_albums():
            for song in album.tracks:
                rel = rel_path_for(self.config.base_music_dir, song.path)
                if rel is None or not scope.allows(rel) or not self._available(rel, song.path):
                    continue
                rows.append((song.artist.casefold(), song.title.casefold(), rel, song, album))
        rows.sort(key=lambda r: r[:3])
        cursor = next((r[:3] for r in rows if r[2] == after), None)
        if after and cursor is None:
            raise CursorError('Unknown estimates cursor')
        result = []
        for artist, title, rel, song, album in rows:
            if cursor is not None and (artist, title, rel) <= cursor:
                continue
            view = self.view(rel, song.path)
            if not any(view[f]['estimated'] for f in ('key', 'bpm')):
                continue
            result.append({'relPath': rel, 'title': song.title, 'artist': song.artist, 'album': album.name,
                           **{f: view[f]['value'] for f in ('key', 'bpm')},
                           **{f + 'Estimated': view[f]['estimated'] for f in ('key', 'bpm')},
                           **{f + 'Source': view[f]['source'] for f in ('key', 'bpm')},
                           **{f + 'Confidence': view[f + 'Confidence'] for f in ('key', 'bpm')}, 'rev': view['rev']})
            if len(result) > limit:
                break
        return {'rows': result[:limit], 'after': result[limit - 1]['relPath'] if len(result) > limit else None}
