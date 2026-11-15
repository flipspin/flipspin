"""Owner run decisions over the existing helper queue."""
import json
import logging
import math
import uuid
from pathlib import Path

from mutagen import MutagenError

from app.domains.helpers import helper_ranking as ranking
from app.domains.helpers.nest_helper import NEST_ID
from app.domains.music.analysis_constants import ENGINE_VERSION
from app.domains.music.analysis_run_repository import RunRepository, timestamp
from app.domains.music.library_files import walk_library
from app.exceptions import ValidationError
from app.infra.jobs.queue import LANES, lane as job_lane
from app.utils.library_paths import rel_path_for, resolve_rel_path

logger = logging.getLogger(__name__)


class RunConflict(ValueError):
    def __init__(self, code, **detail):
        self.detail = {'code': code, **detail}
        super().__init__(code)


def category(row, stat):
    if row and row.get('error') and (row['size'], row['mtime_ns']) == (stat.st_size, stat.st_mtime_ns):
        return 'failed'
    if not row or not row.get('analyzed_at'):
        return 'waiting'
    if (row['size'], row['mtime_ns']) != (stat.st_size, stat.st_mtime_ns):
        return 'waiting'
    if row['engine_version'] != ENGINE_VERSION:
        return 'outdated'
    return 'current'


def selected(mode, state):
    return mode == 'all' or state == 'waiting' or mode == 'outdated' and state == 'outdated'


class RunControls:
    def __init__(self, service):
        self.service = service
        self.store = RunRepository(service.repository)

    def helpers(self, nest=True):
        return [h for h in self.service.worker.scheduling_helpers() if nest or not h.get('nest')]

    def files(self):
        """Validate the complete walk before a producer or sweep can write anything."""
        s = self.service
        def unreadable(error):
            raise error
        try:
            if not s.config.base_music_dir.is_dir():
                raise OSError('missing root')
            paths = []
            for root, _, names in walk_library(s.config.base_music_dir, onerror=unreadable):
                for name in sorted(names):
                    if name.startswith('.') or Path(name).suffix.lower() not in s.music.AUDIO_EXTENSIONS:
                        continue
                    path = Path(root) / name
                    rel = rel_path_for(s.config.base_music_dir, path)
                    if rel and resolve_rel_path(s.config.base_music_dir, rel).is_file():
                        path.stat()
                        paths.append(path)
            if not paths:
                raise OSError('empty root')
            return paths
        except (OSError, ValueError, ValidationError):
            raise RunConflict('library-unavailable')

    def candidates(self, mode, scope, rel_paths):
        s = self.service
        paths, skipped = self.files(), []
        present = {rel_path_for(s.config.base_music_dir, p): p for p in paths}
        if scope != 'library':
            present = {}
            for rel in dict.fromkeys(rel_paths):
                try:
                    path = resolve_rel_path(s.config.base_music_dir, rel)
                    canonical = rel_path_for(s.config.base_music_dir, path)
                except (OSError, ValueError, ValidationError):
                    skipped.append({'relPath': rel, 'reason': 'outside'})
                    continue
                row = s.repository.get(canonical)
                if row and row['missing_since'] is not None:
                    skipped.append({'relPath': rel, 'reason': 'ghost'})
                elif not path.is_file() or path.suffix.lower() not in s.music.AUDIO_EXTENSIONS:
                    skipped.append({'relPath': rel, 'reason': 'missing'})
                else:
                    present[canonical] = path
        rows, counts = [], dict.fromkeys(('waiting', 'outdated', 'failed', 'correctionsKept', 'confirmationsKept'), 0)
        queued = {r['relPath']: r for r in s.queue.rows(('analysis',))}
        for rel, path in present.items():
            row, stat = s.repository.get(rel), path.stat()
            if row and row['missing_since'] is not None:
                skipped.append({'relPath': rel, 'reason': 'ghost'})
                continue
            state = category(row, stat)
            old = queued.get(rel)
            if old and old['status'] == 'failed' and (old['size'], old['mtimeNs']) == (stat.st_size, stat.st_mtime_ns):
                state = 'failed'
            if state in counts:
                counts[state] += 1
            if not selected(mode, state):
                skipped.append({'relPath': rel, 'reason': 'failed' if state == 'failed' else 'current'})
                continue
            for field in ('key', 'bpm'):
                fixed = (row or {}).get('fixed_' + field)
                if fixed is not None:
                    counts['confirmationsKept' if fixed == row.get(field) else 'correctionsKept'] += 1
            rows.append((path, old))
        return rows, skipped, counts

    def estimate(self, paths, nest=True):
        """Never substitute an assumed throughput for measured helper work."""
        rates = [h.get('speed', {}).get('analysis', {}) for h in self.helpers(nest)
                 if ranking.capable(h, 'analysis', list(self.service.needs))]
        rates = [r['medianSecondsPerMinute'] for r in rates if r.get('samples', 0) > 0
                 and math.isfinite(r.get('medianSecondsPerMinute', float('nan')))
                 and r['medianSecondsPerMinute'] > 0]
        if not rates:
            return None
        try:
            durations = [self.service.music.read_tags(p).get('duration') for p in paths]
        except (OSError, ValueError, MutagenError):
            return None
        if any(d is None or not math.isfinite(d) or d <= 0 for d in durations):
            return None
        return round(sum(durations) / 60 * min(rates), 1)

    def preview(self, mode, scope='library', rel_paths=()):
        rows, skipped, counts = self.candidates(mode, scope, rel_paths)
        return {**counts, 'size': len(rows), 'skipped': skipped,
                'estimateSeconds': self.estimate([p for p, _ in rows], nest=scope != 'library')}

    def start(self, request_id, mode, scope, rel_paths, principal):
        s = self.service
        # Replay wins even during a migration or after a file disappears.
        with s.worker.lock:
            response = self.store.response(request_id)
            if response is not None:
                return response
        if s._migrating:
            raise RunConflict('migrating')
        if not s._scan_lock.acquire(timeout=5):
            raise RunConflict('scan-busy')
        try:
            with s.worker.lock:
                response = self.store.response(request_id)
                if response is not None:
                    return response
                if s._migrating:
                    raise RunConflict('migrating')
                self.reconcile()
                if scope == 'library':
                    live = next((r for r in self.store.live() if r['scope'] == 'library'), None)
                    if live:
                        if live['mode'] != mode:
                            raise RunConflict('run-in-progress', runId=live['id'])
                        response = {**json.loads(live['response']), 'joined': True}
                        return self.store.remember(request_id, response)
                rows, skipped, _ = self.candidates(mode, scope, rel_paths)
                if not rows:
                    return self.store.remember(request_id, {'run': None, 'queued': 0, 'joined': False,
                                                           'skipped': skipped})
                nest = scope != 'library'
                helpers = self.helpers(nest=False)
                if not nest and mode != 'new' and not any(ranking.online(h) and ranking.capable(h, 'analysis', list(s.needs)) for h in helpers):
                    raise RunConflict('no-helper', waiting=ranking.wait_reason(helpers, 'analysis', list(s.needs)))
                run = {'id': uuid.uuid4().hex, 'request_id': request_id, 'mode': mode, 'scope': scope,
                       'size': len(rows), 'job_id': uuid.uuid4().hex, 'requested_by': principal,
                       'requested_at': timestamp(), 'nest_allowed': nest}
                tracks = []
                for path, old in rows:
                    payload = s.payload(path)
                    joined = old and old['status'] in ('queued', 'leased')
                    payload.update(runId=run['id'], force=mode == 'all',
                                   lane='library' if scope == 'library' else 'now', libraryRun=scope == 'library',
                                   nest=nest and (scope != 'selection' or len(rows) <= 25), owned=not joined)
                    tracks.append(payload)
                run['counts'] = {'queued': sum(t['owned'] for t in tracks), 'joined': sum(not t['owned'] for t in tracks),
                                 'skipped': {reason: sum(t['reason'] == reason for t in skipped)
                                             for reason in ('missing', 'ghost', 'outside', 'current', 'failed')},
                                 **dict.fromkeys(('same', 'changed', 'toEstimated', 'toConfident', 'failed'), 0)}
                response = {'run': {'id': run['id'], 'jobId': run['job_id'], 'mode': mode, 'scope': scope,
                                    'size': len(rows)}, 'queued': run['counts']['queued'], 'joined': False, 'skipped': skipped}
                # Durable intent precedes the job and every queue mutation. Boot repairs gaps.
                self.store.create(run, tracks, response)
                s.enqueue_files([p for p, _ in rows], run=run)
                logger.info('Analysis run started principal=%s mode=%s scope=%s size=%d run=%s', principal, mode, scope, len(rows), run['id'])
                return response
        finally:
            s._scan_lock.release()

    def materialize(self, run, tracks):
        s, job_id = self.service, run['job_id']
        memberships = self.store.tracks(run['id'])
        s.queue.ledger.start('analysis', f"{run['size']} canciones", [
            {'item': t['payload']['file'], 'rel_path': t['rel_path']} for t in memberships], run['requested_by'], job_id=job_id)
        memberships = {t['rel_path']: t for t in memberships}
        existing = {r['relPath']: r for r in s.queue.rows(('analysis',))}
        for payload in tracks:
            membership = memberships[payload['relPath']]
            idx = membership['idx']
            if membership and membership['state'] != 'pending':
                continue
            old = existing.get(payload['relPath'])
            if old and old['status'] in ('queued', 'leased'):
                # Drop the retired automatic-hours marker from joined work.
                old.pop('night', None)
                if LANES[job_lane(payload)] < LANES[job_lane(old)]:
                    old['lane'] = job_lane(payload)
                old['libraryRun'] = old.get('libraryRun', False) or payload.get('libraryRun', False)
                if old.get('runId') != run['id']:
                    old['ownerRuns'] = list(set(old.get('ownerRuns', []) + [run['id']]))
                # Joining never relaxes an existing run's nest fence, and a
                # newly joined library run revokes an in-flight nest lease.
                old['nest'] = old.get('nest', True) and payload['nest']
                changed = (old['size'], old['mtimeNs']) != (payload['size'], payload['mtimeNs'])
                if changed or not old['nest'] and old['status'] == 'leased' and old['leased_by'] == NEST_ID:
                    fresh = {**old, 'size': payload['size'], 'mtimeNs': payload['mtimeNs']}
                    s.queue.replace(old['id'], fresh)
                    s.worker.finished(old['id'])
                    self.store.replace(payload['relPath'], fresh)
                else:
                    s.queue.save_payload(old)
                continue
            if old:
                s.queue.hide(old['id'])
            s.queue.enqueue('analysis', payload['relPath'], payload, job_id=job_id, idx=idx)
        if any(not (s.repository.get(t['relPath']) or {}).get('analyzed_at') for t in tracks):
            s.music.invalidate_scan()

    def reconcile(self, boot=False):
        with self.service.worker.lock:
            self._reconcile(boot)

    def _reconcile(self, boot):
        s = self.service
        for run in self.store.live():
            job = s.queue.ledger.get(run['job_id'])
            tracks = self.store.tracks(run['id'])
            if job and job['state'] in ('cancelled', 'interrupted'):
                self.store.end(run['id'], 'cancelled')
                continue
            if boot and (job is None or job['state'] in ('queued', 'running')):
                self.materialize(run, [t['payload'] for t in tracks])
                job = s.queue.ledger.get(run['job_id'])
            for t in tracks:
                if t['state'] != 'pending':
                    s.queue.ledger.outcome(run['job_id'], t['rel_path'], idx=t['idx'], success=t['state'] == 'done')
            if all(t['state'] != 'pending' for t in tracks):
                s.queue.ledger.finish(run['job_id'], 1)
                if self.store.end(run['id'], 'done'):
                    logger.info('Analysis run finished run=%s', run['id'])
            elif job and job['state'] not in ('queued', 'running'):
                self.store.end(run['id'], 'done')

    def progress(self):
        s = self.service
        self.reconcile()
        run = next(iter(self.store.live()), None)
        if not run:
            return None
        tracks = self.store.tracks(run['id'])
        remaining = [t for t in tracks if t['state'] == 'pending']
        active = {t['rel_path'] for t in remaining}
        working = any(r['status'] == 'leased' and r['relPath'] in active for r in s.queue.rows(('analysis',)))
        return {'id': run['id'], 'jobId': run['job_id'], 'mode': run['mode'], 'scope': run['scope'],
                'size': run['size'], 'done': len(tracks) - len(remaining),
                'failed': sum(t['state'] == 'failed' for t in tracks),
                'waiting': ranking.wait_reason(self.helpers(bool(run['nest_allowed'])), 'analysis', list(s.needs))
                if remaining and not working else None,
                'etaSeconds': self.estimate([resolve_rel_path(s.config.base_music_dir, t['rel_path'])
                                             for t in remaining], bool(run['nest_allowed'])),
                'counts': json.loads(run['counts'])}
