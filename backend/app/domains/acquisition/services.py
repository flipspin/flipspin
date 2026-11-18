"""Request → match → fetch → import → link, with durable item decisions.

In-memory tasks are only wakeups. Requests, source reservations, provider cooldowns
and stage outcomes all live on the existing FULL/WAL ledger.
"""
import asyncio
import hashlib
import inspect
import json
import logging
import shutil
import threading
from dataclasses import replace
from contextlib import nullcontext
from pathlib import Path

from app.infra.media_requests import DownloadResult, TrackDownloadRequest, TrackMetadata
from app.domains.metadata.genres import fill_tracks, norm
from app.domains.music.public import owned_paths
from app.domains.user_library.public import link, restore, unlink_replaced
from app.infra.identity import LOCAL_OWNER, Principal, is_real_user
from app.exceptions import FailureKind, SourceFailure, ValidationError
from app.infra.tasks import spawn_background
from app.infra.capacity import CapacityLimiter
from app.utils.path_safety import safe_music_subpath, safe_open_path, resolve_under
from app.utils.library_paths import resolve_rel_path
from app.utils.images import full_size_image_url

from .import_stage import AlbumRefresh, finish_batch, import_file, replace_landed
from app.domains.music.public import remember_arrival
from .models import AcquisitionError, Request
from .repository import Requests
from .request_job import RequestJob, Stage, STAGES
from .lookups import RequestLookups, current_lookups
from .provider import source_download_context
from .sources.compat import LEGACY_SOURCE_ID
from .failures import classify_failure, POLICIES
from .health import SourceHealth

logger = logging.getLogger(__name__)


class Pipeline:
    def __init__(self, *, ledger, engine, ownership, user_tracks, root, data, tracker=None,
                 floor_bytes=512 * 1024 * 1024, sleep=asyncio.sleep,
                 metadata_lookup=lambda: None, relocator=lambda: None, music=None, health=None, sources=lambda: [LEGACY_SOURCE_ID]):
        self.ledger, self.engine, self.ownership, self.user_tracks = ledger, engine, ownership, user_tracks
        self.root, self.data = Path(root), Path(data)
        self.incoming, self.recycle = self.data / 'incoming', self.data / 'recycle'
        if self.incoming.resolve().is_relative_to(self.root.resolve()):
            raise ValueError('incoming-must-be-outside-music-root')
        from app.infra.progress import ProgressTracker
        self.store, self.tracker = Requests(ledger), tracker or ProgressTracker(ledger)
        self.floor_bytes, self.sleep = floor_bytes, sleep
        self.health = health or SourceHealth(ledger)
        self.sources = sources
        self.fetch_limiters = {}
        self.process_limiter = CapacityLimiter(lambda: 1)
        self.import_limiter = CapacityLimiter(lambda: 1)
        self.metadata_lookup = metadata_lookup
        self.relocator = relocator
        self.music = music
        self._active = set()
        self._catalog_registration = threading.Lock()
        # Separate from downloads: three source searches across all requests
        # can feed audio slots without flooding source or starving fetches.
        self.search_limiter = CapacityLimiter(lambda: 3)

    def space(self):
        return {'freeBytes': shutil.disk_usage(self.data).free, 'floorBytes': self.floor_bytes}

    def check_space(self):
        space = self.space()
        if space['freeBytes'] < space['floorBytes']:
            raise AcquisitionError('sin-espacio', 507)

    def submit(self, data: Request, principal, *, key=None, schedule=True):
        if not is_real_user(principal):
            raise AcquisitionError('sign-in-required')
        self.check_sources()
        # Validate before committing intent, including a symlinked folder.
        if data.kind == 'song' and len(data.tracks) != 1:
            raise AcquisitionError('song-needs-one-track', 422)
        if data.folder:
            try:
                safe_music_subpath(self.root, data.folder)
            except ValidationError as error:
                raise AcquisitionError('invalid-destination', 422) from error
        for track in data.tracks:
            if track.replaces:
                try:
                    resolve_rel_path(self.root, track.replaces)
                except ValidationError as error:
                    raise AcquisitionError('invalid-replacement', 422) from error
        body = data.model_dump()
        # Omitted additive fields must keep the pre-upgrade idempotency hash.
        for track in body['tracks']:
            for field in ('isrc', 'replaces', 'album_artist', 'track_total', 'disc_number',
                          'disc_total', 'compilation', 'recording_mbid', 'release_mbid', 'release_group_mbid', 'artist_mbid', 'genre', 'year'):
                if track[field] is None:
                    del track[field]
        response, fresh = self.store.create(body, principal, key=key, before_create=self.check_space, source_id=self.source_id)
        if schedule and fresh:
            self.kick(response['id'])
        return response

    def kick(self, id):
        if id not in self._active:
            self._active.add(id)
            spawn_background(self._background(id))

    async def _background(self, id):
        try:
            await self.run(id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception('acquisition wakeup failed request=%s', id)
        finally:
            self._active.discard(id)

    def resume(self):
        with self.ledger.lock:
            ids = [r[0] for r in self.ledger.db.execute("SELECT id FROM acquisition_requests WHERE state IN ('approved','fetching','importing')")]
            # A process died while owning these source reservations. No process
            # can still publish them; the import stage is safe to replay.
            with self.ledger.db:
                self.ledger.db.execute("DELETE FROM acquisition_transfers WHERE state='running'")
        for id in ids:
            self.kick(id)

    def view(self, id, principal):
        row = self.store.get(id, principal.user_id)
        row['retryable'] = row['state'] in ('fallido', 'parcial')
        with self.ledger.lock:
            stages = list(self.ledger.db.execute('SELECT stage,job_id FROM acquisition_stages WHERE request_id=?', (id,)))
        # Keep the submitted order and catalog identity: stage idx is local to
        # that stage, while detail.index addresses this manifest (also on retry).
        body = self.store.work(id)['body']
        tracks = body['tracks']
        if body.get('_requests') is not None:
            # Imports and catalog adapters keep their canonical song metadata
            # in encoded requests; expose it to the same manual-search sheet.
            tracks = [{**track, **encoded['metadata'], 'duration_s': encoded.get('duration_s')}
                      for track, encoded in zip(tracks, body['_requests'], strict=True)]
        row['tracks'] = [{k: track[k] for k in ('title', 'artist', 'album', 'provider_id', 'track_number', 'duration_s') if k in track}
                         for track in tracks]
        unified = RequestJob.find(self.ledger, id, self.tracker) if not stages else None
        if unified:
            row['imported_tracks'] = sum(item['state'] in ('done', 'failed') and 'imported' in item['detail'].get('_stage_times', {}) for item in self.ledger.items(unified.id))
            stages = [(name, unified.stage(name)) for name in STAGES]
        row['stages'] = {stage: job.id if isinstance(job, Stage) else job for stage, job in stages}
        row['items'] = [{**{k: item[k] for k in ('idx', 'item', 'state', 'reason')},
                         'detail': {k: v for k, v in item['detail'].items() if not k.startswith('_')},
                         'stage': stage, **({'stageAt': item['stageAt']} if unified else {})}
                        for stage, job in stages for item in self._items(job)]
        if unified and row['state'] in ('approved', 'fetching', 'importing'):
            health = self.health.status(self.source_id)
            if health['state'] != 'ok':
                for item in row['items']:
                    if item['stage'] in ('match', 'fetch') and item['state'] in ('queued', 'running'):
                        item['reason'] = 'en-pausa'
                        item['detail'].update(until=health.get('until'), kind=health.get('kind'))
        failures = [item for item in row['items'] if item['state'] == 'failed']
        if failures:
            row['retryable'] = row['retryable'] and any(item['detail'].get('retryable', True) for item in failures)
        # Paths under data/incoming and other accounts never enter the wire.
        return row

    def cancel(self, id, principal):
        row = self.store.get(id, principal.user_id)
        if row['state'] not in ('pending', 'approved'):
            raise AcquisitionError('cannot-cancel')
        self.store.state(id, 'rechazado')
        unified = RequestJob.find(self.ledger, id, self.tracker)
        if unified:
            self.ledger.cancel(unified.id, unified.attempt)
            self.tracker.complete_progress(unified.id, 'cancelled')
        return self.store.get(id, principal.user_id)

    def retry(self, id, principal, *, selection=None, schedule=True, update_retry=None):
        row = self.store.get(id, principal.user_id)
        if row['state'] not in ('fallido', 'parcial') or not self.view(id, principal)['retryable']:
            raise AcquisitionError('cannot-retry')
        self.check_sources()
        self.check_space()
        # Preserve successful paths before replacing the current stage graph.
        # Older attempts remain immutable audit records in jobs/items.
        saved = self._saved_results(id, row['expected_tracks'])
        with self.store.transaction() as db:
            current = db.execute('SELECT state FROM acquisition_requests WHERE id=?', (id,)).fetchone()[0]
            if current not in ('fallido', 'parcial'):
                raise AcquisitionError('cannot-retry')
            conflict = db.execute("SELECT 1 FROM acquisition_requests WHERE account_id=? AND provider=? AND provider_id=? AND state IN ('pending','approved','fetching','importing')", (row['account_id'], row['provider'], row['provider_id'])).fetchone()
            if conflict:
                raise AcquisitionError('request-already-open')
            attempts = db.execute("SELECT count(*) FROM jobs WHERE parent_id=? AND kind='acquisition-request'", (id,)).fetchone()[0]
            if attempts >= 20:
                raise AcquisitionError('retry-limit')
            work = self.store.work(id)
            body = work['body']
            failures = {item['detail']['index']: item for job in set(self.view(id, principal)['stages'].values())
                        for item in self.ledger.items(job) if item['state'] == 'failed'}
            held = {}
            if update_retry is not None:
                eligible, release = update_retry
                held = {str(i): {'reason': item['reason'], 'error': item['detail'].get('error', item['reason']),
                                 'kind': item['detail'].get('kind'), '_diagnostic': item['detail'].get('_diagnostic'),
                                 'failedAt': item['detail'].get('failedAt', self.ledger.get(item['job_id'])['ended_at'])}
                        for i, item in failures.items() if i not in eligible}
                marks = body.setdefault('_source_retried', {})
                marks.update({str(i): release for i in eligible})
                for i in eligible:
                    item = failures[i]
                    detail = {**item['detail'], 'sourceRetry': release}
                    db.execute('UPDATE items SET detail=? WHERE job_id=? AND idx=? AND attempt=?',
                               (json.dumps(detail), item['job_id'], item['idx'], item['attempt']))
            elif selection is not None:
                if selection.index not in failures or not failures[selection.index]['detail'].get('retryable', True) or (selection.youtube_url is not None and failures[selection.index]['reason'] not in ('no-encontrada', 'fallo-descarga')):
                    raise AcquisitionError('cannot-retry-item')
                held = {str(i): {'reason': item['reason'], 'error': item['detail'].get('error', item['reason']),
                                 'kind': item['detail'].get('kind'), '_diagnostic': item['detail'].get('_diagnostic'),
                                 'failedAt': item['detail'].get('failedAt', self.ledger.get(item['job_id'])['ended_at'])}
                        for i, item in failures.items() if i != selection.index}
                if selection.youtube_url is not None:
                    body.setdefault('_source_urls', {})[str(selection.index)] = selection.youtube_url
            else:
                held = {str(i): {'reason': item['reason'], 'error': item['detail'].get('error', item['reason']),
                                 'kind': item['detail'].get('kind'), '_diagnostic': item['detail'].get('_diagnostic'),
                                 'failedAt': item['detail'].get('failedAt', self.ledger.get(item['job_id'])['ended_at'])}
                        for i, item in failures.items() if not item['detail'].get('retryable', True)}
            # An item retry retries one manifest row. Keep the other failures
            # durable so a crash or later full retry cannot silently drop them.
            body.pop('_failure', None)
            body['_held_failures'] = held
            body['_completed'] = {str(i): str(r.file_path) for i, r in enumerate(saved) if r.success}
            unified = RequestJob.find(self.ledger, id, self.tracker)
            if not unified:
                body['_legacy_stages'] = True
            db.execute('UPDATE acquisition_work SET body=? WHERE request_id=?', (json.dumps(body), id))
            if unified:
                job = self.ledger.get(unified.id)
                if job['attempt'] >= 20:
                    raise AcquisitionError('retry-limit')
                attempt = job['attempt'] + 1
                db.execute("UPDATE jobs SET state='queued',attempt=?,started_at=NULL,ended_at=NULL,cleared_at=NULL,failed=0,skipped=0 WHERE id=?", (attempt, unified.id))
                for item in self.ledger.items(unified.id):
                    if item['state'] == 'done':
                        continue
                    detail = {'index': item['detail']['index'], 'provider': self.source_id, '_stage_times': {'requested': self.ledger.now()}}
                    if str(detail['index']) in body.get('_source_retried', {}):
                        detail['sourceRetry'] = body['_source_retried'][str(detail['index'])]
                    db.execute("INSERT INTO items(job_id,idx,attempt,item,state,detail,stage,stage_at) VALUES(?,?,?,?,'queued',?,'requested',?)",
                               (unified.id, item['idx'], attempt, item['item'], json.dumps(detail), self.ledger.now()))
            else:
                db.execute('DELETE FROM acquisition_stages WHERE request_id=?', (id,))
            for idx in range(len(body['tracks'])):
                identity = self._identity(body, idx)
                db.execute("DELETE FROM acquisition_transfers WHERE identity=? AND state='failed'", (identity,))
            db.execute("UPDATE acquisition_requests SET state='approved',decided_at=?,decided_by=?,dismissed_at=NULL WHERE id=? AND state IN ('fallido','parcial')", (self.ledger.now(), principal.user_id, id))
            self.ledger._bump()
        if schedule:
            self.kick(id)
        return self.store.get(id, principal.user_id)

    def retry_broken(self, since, until, release, *, source_id=None):
        """Re-enter normal acquisition once per song, preserving other outcomes.

        A window stays pending while older requests are in flight: an update
        triggered by their failure may finish before they persist that outcome.
        The marker and new request intent commit in the same ledger transaction.
        """
        if source_id is not None and source_id not in self.sources():
            return [], False
        ids = []
        pending = False
        with self.ledger.lock:
            rows = list(self.ledger.db.execute("SELECT * FROM acquisition_requests WHERE state IN ('fallido','parcial')"))
            for row in rows:
                work = self.store.work(row['id'])
                body = work['body']
                if body.get('_upload_path'):
                    continue
                marks = body.get('_source_retried', {})
                principal = Principal(**work['principal'])
                failures = {}
                for job in set(self.view(row['id'], principal)['stages'].values()):
                    record = self.ledger.get(job)
                    for item in self.ledger.items(job):
                        if item['state'] == 'failed':
                            failures[item['detail']['index']] = (item, record)
                eligible = {i for i, (item, job) in failures.items()
                            if item['detail'].get('kind') in (FailureKind.BROKEN, FailureKind.BLOCKED)
                            and item['detail'].get('provider') == (source_id or self.source_id)
                            and marks.get(str(i)) != release and item['detail'].get('sourceRetry') != release
                            and since < item['detail'].get('failedAt', job['ended_at'] or job['created_at']) <= until}
                if not eligible:
                    continue
                try:
                    self.retry(row['id'], principal, schedule=False, update_retry=(eligible, release))
                except AcquisitionError:
                    pending = True
                    continue  # Space, disabled sources or a conflicting request: try next tick.
                ids.append(row['id'])
            active = self.ledger.db.execute("SELECT 1 FROM acquisition_requests WHERE state IN ('approved','fetching','importing') AND created_at<=? LIMIT 1", (until,)).fetchone()
            # Re-wake already committed retries too: the process might have
            # stopped after committing intent, before dispatching the wakeup.
            for row in self.ledger.db.execute("SELECT id FROM acquisition_requests WHERE state='approved'"):
                if release in self.store.work(row['id'])['body'].get('_source_retried', {}).values():
                    if row['id'] not in ids:
                        ids.append(row['id'])
        return ids, not active and not pending

    def _stage(self, id, stage, requests, principal, indices=None, *, share=True):
        marks = self.store.work(id)['body'].get('_source_retried', {})
        job = self.store.stage(id, stage, [{'item': r.metadata.title or r.search_query or r.youtube_url or 'Canción',
                               'detail': {'provider': self.source_id, 'index': indices[i] if indices is not None else i,
                                          **({'sourceRetry': marks[str(indices[i] if indices is not None else i)]}
                                             if str(indices[i] if indices is not None else i) in marks else {})}}
                              for i, r in enumerate(requests)], principal, share=share and not marks)
        self.ledger.running(job, self._record(job)['attempt'])
        return job

    def _record(self, job):
        return self.ledger.get(job.id if isinstance(job, Stage) else job)

    def _items(self, job):
        if isinstance(job, Stage):
            return job.request.items(job.name)
        items = self.ledger.items(job)
        for item in items:
            phase = self.tracker.track_phase(job, item['idx'])
            if phase.get('percent') is not None:
                item['detail']['percent'] = phase['percent']
        return items

    def _finish(self, job):
        finished = self.ledger.finish(job.id if isinstance(job, Stage) else job,
                                      job.request.attempt if isinstance(job, Stage) else self._record(job)['attempt'])
        if not isinstance(job, Stage) and self.tracker.get_progress(job):
            row = self.ledger.get(job)
            self.tracker.complete_progress(job, 'done' if row['state'] == 'succeeded' else row['state'],
                                           succeeded=row['succeeded'], failed=row['failed'])
        return finished

    def _done(self, job, idx, *, path=None, error=None, reason=None, detail=None):
        failure_detail = {}
        if isinstance(error, SourceFailure):
            policy = POLICIES[error.kind]
            failure_detail = {'error': policy.message, 'kind': error.kind,
                              'retryable': policy.retryable, '_diagnostic': error.details,
                              'failedAt': getattr(error, 'failed_at', self.ledger.now())}
        elif error is not None:
            failure_detail = {'error': str(error), 'kind': type(error).__name__, 'retryable': True}
        merged = {'provider': self.source_id, **(detail or {}), **({'_path': str(path)} if path else {}), **failure_detail}
        if isinstance(job, Stage):
            return job.request.done(job.name, idx, error=error, reason=reason, detail=merged)
        self.ledger.outcome(job, '', idx=idx, success=error is None, reason=reason, detail=merged)

    @property
    def source_id(self):
        from .provider import DownloadRepository
        repository = getattr(self.engine, "download_repo", None)
        if isinstance(repository, DownloadRepository) and repository._selected.get() is not None:
            return repository.source_id
        ids = self.sources()
        return ids[0] if ids else LEGACY_SOURCE_ID

    def check_sources(self):
        if not self.sources():
            raise AcquisitionError('no-sources', 409)

    def fetch_limiter(self, source):
        config = getattr(self.engine, 'config', None)
        if config is not None:
            return config.download_limiter
        if source not in self.fetch_limiters:
            def limit():
                config = getattr(self.engine, 'config', None)
                return max(1, min(4, getattr(config, 'max_concurrent_downloads', 2)))
            self.fetch_limiters[source] = CapacityLimiter(limit)
        return self.fetch_limiters[source]

    def _gate_step(self, job, idx, *, admitted=False):
        with self.ledger.lock:
            status = self.health.status(self.source_id)
            wait = self.health.wait(self.source_id)
            if not isinstance(job, Stage) and (wait > 0 or admitted):
                self.ledger.item_transition(job, idx, self._record(job)['attempt'],
                    'running' if wait <= 0 else 'queued', reason='en-pausa' if wait > 0 else None,
                    detail={'until': status.get('until') if wait > 0 else None,
                            'kind': status.get('kind') if wait > 0 else None, 'provider': self.source_id})
        # ProgressTracker's own producers can take its lock before the ledger.
        # Publish the disposable phase after releasing the durable lock.
        if isinstance(job, Stage) and admitted and wait <= 0:
            item = job.request.item(idx)
            self.tracker.set_track_phase(job.id, item['item'], 'searching' if job.name == 'match' else 'downloading', index=idx)
        return wait

    async def _gate(self, job, idx):
        while True:
            wait = await asyncio.to_thread(self._gate_step, job, idx)
            if wait <= 0:
                return
            await self.health.pause(self.source_id, min(wait, 30), self.sleep)

    def _requests(self, body):
        destination = safe_music_subpath(self.root, body['folder']) if body.get('folder') else self.root
        requests = []
        for track in body['tracks']:
            folder = resolve_under(self.root, *destination.relative_to(self.root.resolve()).parts,
                                   TrackDownloadRequest._clean_filename(track.get('album') or 'Singles') or 'Singles')
            requests.append(TrackDownloadRequest(
                search_query=None if track.get('youtube_url') else f"{track['title']} {track.get('artist', '')}".strip(),
                youtube_url=track.get('youtube_url'),
                metadata=TrackMetadata(title=track['title'], artist=track.get('artist'), album=track.get('album'),
                                       track_number=track.get('track_number'), genre=track.get('genre'), year=track.get('year'),
                                       **{key: track.get(key) for key in ('isrc', 'album_artist', 'track_total', 'disc_number',
                                                                        'disc_total', 'compilation', 'recording_mbid', 'release_mbid', 'release_group_mbid', 'artist_mbid')}),
                destination=folder, duration_s=track.get('duration_s'), cover_url=full_size_image_url(track.get('cover_url'))))
        return requests

    async def _enrich(self, id, requests, body, indices):
        """Fill missing tags before tagging; retain answers across retries/restarts."""
        indices = [i for i in indices if requests[i].metadata.artist
                   and (requests[i].metadata.album or requests[i].metadata.title)
                   and not (requests[i].metadata.genre and requests[i].metadata.year)]
        if not indices:
            return
        tracks = [{'name': requests[i].metadata.title, 'artist': requests[i].metadata.artist,
                   'album': requests[i].metadata.album, 'genre': requests[i].metadata.genre,
                   'year': requests[i].metadata.year} for i in indices]
        try:
            lookup = self.metadata_lookup()
            if lookup is None:
                return
            await asyncio.to_thread(fill_tracks, tracks, [requests[i].metadata.isrc for i in indices], lookup)
        except Exception:
            # No retry, provider cooldown, or failed download for enrichment.
            logger.info('acquisition genre lookup skipped', exc_info=True)
        for i, track in zip(indices, tracks, strict=True):
            requests[i].metadata.genre = track.get('genre')
            requests[i].metadata.year = track.get('year')
        # Merge only filled tags into the latest body, preserving retry inputs
        # and adapter metadata. Empty/failed answers may be tried again later.
        try:
            def save_enrichment():
                with self.store.transaction() as db:
                    stored = self.store.work(id)['body']
                    for i in indices:
                        for field in ('genre', 'year'):
                            if value := getattr(requests[i].metadata, field):
                                stored['tracks'][i][field] = value
                                if stored.get('_requests') is not None:
                                    stored['_requests'][i]['metadata'][field] = value
                    db.execute('UPDATE acquisition_work SET body=? WHERE request_id=?', (json.dumps(stored), id))
            await asyncio.to_thread(save_enrichment)
        except Exception:
            logger.info('acquisition enriched tags not persisted', exc_info=True)

    @staticmethod
    def _identity(body, idx):
        identity = [body['provider'], body['provider_id'], idx]
        if source := body.get('_source_urls', {}).get(str(idx)):
            identity.append(source)
        return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()

    async def run(self, id, *, requests=None, hits=None, relocator=None):
        from app.infra.capacity import _job
        config = getattr(self.engine, 'config', None)
        slot = config.job_limiter.slot() if config is not None and _job.get() is None else nullcontext()
        async with slot:
            try:
                try:
                    await asyncio.to_thread(self.ownership.acquisition_started)
                except AttributeError:
                    pass
                return await self._run(id, requests=requests, hits=hits, relocator=relocator)
            except Exception as error:
                await asyncio.to_thread(self._fail_request, id, error)
                raise
            finally:
                try:
                    await asyncio.to_thread(self.ownership.acquisition_finished, refresh=False)
                except AttributeError:
                    pass

    def _fail_request(self, id, error):
        """Close a crashed run, retaining successful receipts for a manual retry."""
        work = self.store.work(id)
        principal = Principal(**work['principal'])
        if self.store.get(id, principal.user_id)['state'] not in ('approved', 'fetching', 'importing'):
            return
        detail = {'kind': type(error).__name__, 'retryable': True, 'error': str(error)}
        with self.ledger.lock:
            jobs = [r[0] for r in self.ledger.db.execute('SELECT id FROM jobs WHERE parent_id=?', (id,))]
        if not jobs:
            # A pre-upgrade intent can fail before its stage graph was created.
            registered = RequestJob.create(self.ledger, id, work, None, principal, self.tracker, source_id=self.source_id)
            jobs = [registered.id]
        unified = RequestJob.find(self.ledger, id, self.tracker)
        for job in jobs:
            record = self.ledger.get(job)
            for item in self.ledger.items(job):
                if item['state'] in ('queued', 'running'):
                    if unified and job == unified.id:
                        unified.done('match' if item['stage'] == 'requested' else 'fetch' if item['stage'] in ('matched','fetched') else 'import' if item['stage'] == 'processed' else 'link',
                                     item['idx'], error=error, reason='error', detail=detail)
                    else:
                        self.ledger.outcome(job, item['item'], idx=item['idx'], attempt=record['attempt'],
                                            success=False, reason='error', detail=detail)
            self.ledger.finish(job, record['attempt'], error=True)
        with self.ledger.lock, self.ledger.db:
            work['body']['_failure'] = detail
            self.ledger.db.execute('UPDATE acquisition_work SET body=? WHERE request_id=?', (json.dumps(work['body']), id))
            self.ledger.db.execute("UPDATE acquisition_transfers SET state='failed',reason='error',error=? WHERE owner_request_id=? AND state='running'",
                                   (str(error), id))
        self.store.state(id, 'fallido')
        if self.tracker and self.tracker.get_progress(work['job_id']):
            self.tracker.add_failure(work['job_id'], {'index': 0, **detail})
            self.tracker.complete_progress(work['job_id'], 'failed')

    async def _run(self, id, *, requests=None, hits=None, relocator=None):
        work = await asyncio.to_thread(self.store.work, id)
        principal = Principal(**work['principal'])
        row = await asyncio.to_thread(self.store.get, id, principal.user_id)
        if row['state'] not in ('approved', 'fetching', 'importing'):
            return []
        if requests is None and work['body'].get('_requests') is not None:
            from app.infra.job_requests import decode_request
            requests = [decode_request(r) for r in work['body']['_requests']]
        if requests is None:
            requests = await asyncio.to_thread(self._requests, work['body'])
        requests = [replace(req, youtube_url=work['body']['_source_urls'][str(i)], search_query=None)
                    if str(i) in work['body'].get('_source_urls', {}) else req for i, req in enumerate(requests)]
        progress_items = work['body'].get('_progress_items', [])
        progress_id = work['job_id']
        album_refresh = await asyncio.to_thread(AlbumRefresh, self.music, self.root, [r.destination for r in requests])

        def report(idx):
            result = results[idx]
            if not unified and idx < len(progress_items) and self.ledger.running(progress_id, work['body']['_progress_attempt']):
                item = progress_items[idx]
                self.ledger.outcome(progress_id, item['item'], idx=item['idx'],
                    attempt=work['body']['_progress_attempt'], success=result.success,
                    reason=result.failure_kind, detail={'kind': result.failure_kind, 'reason': result.error,
                    **({'audio_format': result.audio_format} if result.audio_format else {}),
                    '_result': {'path': str(result.file_path) if result.file_path else None,
                                'title': result.title, 'artist': result.artist}})
                if self.tracker:
                    if not result.success:
                        self.engine._remember_failure(progress_id, item['idx'], requests[idx], result)
                    self.tracker.update_progress(progress_id, item['item'])
            if unified:
                item = unified.item(idx)
                self.tracker.update_progress(unified.id, item['item'], index=idx)
                if item['state'] == 'failed':
                    self.tracker.add_failure(unified.id, {**{k: v for k, v in item['detail'].items() if not k.startswith('_')}, 'item': item['item']})
            else:
                # Historical stage jobs keep their original request counters.
                with self.ledger.lock:
                    current = self.store.get(id, principal.user_id)
                    self.store.state(id, current['state'], imported=sum(bool(r and r.success) for r in results))
            album_refresh.done(idx)

        def allocate():
            with self.ledger.lock:
                old = self.ledger.db.execute('SELECT 1 FROM acquisition_stages WHERE request_id=?', (id,)).fetchone()
            old = old or work['body'].get('_legacy_stages', False)
            unified = None if old else RequestJob.find(self.ledger, id, self.tracker)
            if not old and unified is None:
                unified = RequestJob.create(self.ledger, id, work, requests, principal, self.tracker, source_id=self.source_id)
            if unified:
                self.ledger.running(unified.id, self.ledger.get(unified.id)['attempt'])
                self.tracker.create_progress(unified.id, len(requests), deduplicate_items=False)
            return unified
        unified = await asyncio.to_thread(allocate)

        async def stage(name, songs, indices=None, **kwargs):
            if unified:
                return unified.stage(name)
            return await asyncio.to_thread(self._stage, id, name, songs, principal, indices, **kwargs)

        request_job = await stage('request', requests)
        if not unified:
            for i in range(len(requests)):
                await asyncio.to_thread(self._done, request_job, i)
            await asyncio.to_thread(self._finish, request_job)
        if row['state'] == 'approved':
            await asyncio.to_thread(self.store.state, id, 'fetching')
        # The public oracle is the single dedupe decision, for every account.
        if work['body'].get('_upload_path') and hits is None:
            hits = {}
        if hits is None:
            try:
                hits = await asyncio.to_thread(owned_paths, self.ownership, self.root,
                        [{'title': r.metadata.title, 'artist': r.metadata.artist, 'duration_s': r.duration_s} for r in requests])
            except Exception:
                logger.warning('acquisition ownership unavailable', exc_info=True)
                hits = {}
        # An explicit version choice must fetch even when ownership answers.
        for idx, track in enumerate(work['body']['tracks']):
            if track.get('replaces'):
                hits.pop(idx, None)
        previous = await asyncio.to_thread(self._saved_results, id, len(requests))
        for idx, result in enumerate(previous):
            if result.success and await asyncio.to_thread(result.file_path.is_file):
                hits[idx] = result.file_path
        match_job = await stage('match', requests)
        missing = [i for i in range(len(requests)) if i not in hits]
        enrichments = {}
        lookups = RequestLookups(self.store)
        def existing_stages():
            with self.ledger.lock:
                existing = dict(self.ledger.db.execute('SELECT stage,job_id FROM acquisition_stages WHERE request_id=?', (id,)))
            return existing
        existing = await asyncio.to_thread(existing_stages)
        fetch_job = await stage('fetch', [requests[i] for i in missing], missing, share=not work['body'].get('_source_urls')) if missing and not work['body'].get('_upload_path') else unified.stage('fetch') if unified else existing.get('fetch')
        results = [None] * len(requests)
        # Allocate stable manifest-indexed stages before workers start. Replayed
        # jobs may have sparse indices from an older, batch-based attempt.
        import_job = await stage('import', [requests[i] for i in missing], missing) if missing else unified.stage('import') if unified else existing.get('import')
        link_job = await stage('link', requests)

        def positions(job):
            return {item['detail']['index']: item['idx'] for item in self._items(job)} if job else {}

        fetch_positions = await asyncio.to_thread(positions, fetch_job)
        import_positions = await asyncio.to_thread(positions, import_job)
        link_positions = await asyncio.to_thread(positions, link_job)
        if not unified and fetch_job:
            await asyncio.to_thread(self.tracker.create_progress, fetch_job, len(fetch_positions))

        def done(job, indices, idx, **kwargs):
            # Older batches allocated import/link items only for successes.
            if idx in indices:
                self._done(job, indices[idx], **kwargs)

        # Publication and progress reporting stay ordered within a critical
        # section; slow fetches never hold it or delay another song's link.
        publication = self.import_limiter.slot

        def importing():
            if self.store.get(id, principal.user_id)['state'] == 'fetching':
                self.store.state(id, 'importing')

        def link_result(idx):
            try:
                if is_real_user(principal):
                    if row['provider'] == 'library-readd':
                        rel = restore(self.user_tracks, principal, self.root, results[idx].file_path,
                                      row['provider_id'], acquired=not results[idx].already_present)
                    else:
                        rel = link(self.user_tracks, principal.user_id, self.root, results[idx].file_path,
                                   acquired=not results[idx].already_present)
                else:
                    rel = None  # One-release legacy compatibility; never a row.
                if old_rel := work['body']['tracks'][idx].get('replaces'):
                    mover = relocator if relocator is not None else self.relocator()
                    if mover is None:
                        raise ValueError('replacement-unavailable')
                    # The legacy adapter accepts physical paths; new requests
                    # carry the same encoded library keys as the listing.
                    old_path = Path(old_rel) if Path(old_rel).is_absolute() else resolve_rel_path(self.root, old_rel)
                    if old_path.is_file():
                        old = mover.library_file(old_path)
                        if principal.is_owner:
                            replace_landed(mover, old, results[idx].file_path, recycle=self.recycle)
                        else:
                            unlink_replaced(self.user_tracks, principal.user_id, self.root, old, results[idx].file_path)
                    elif not principal.is_owner:
                        unlink_replaced(self.user_tracks, principal.user_id, self.root, old_path, results[idx].file_path)
                done(link_job, link_positions, idx, detail={'rel_path': rel})
            except Exception as error:
                done(link_job, link_positions, idx, error=error, reason='fallo-importar')

        def reuse_hits():
            for i, path in hits.items():
                self._done(match_job, i, path=path, detail={'decision': 'STRONG', 'reason': 'on-nido'})
                results[i] = DownloadResult(True, path, already_present=True, audio_format=self._published_format(path))
                if unified:
                    unified.advance(i, 'fetched', detail={'_path': str(path)})
                if i in fetch_positions:
                    self._done(fetch_job, fetch_positions[i], path=path)
                # A restart can see publication committed before its stage outcome.
                if i in import_positions:
                    with self.ledger.lock:
                        published = self.ledger.db.execute(
                            'SELECT 1 FROM upload_items WHERE request_id=? AND published_path=?',
                            (id, str(path))).fetchone()
                    self._done(import_job, import_positions[i], path=path,
                               detail={**({'_published': True} if published else {}),
                                       '_result': {'path': str(path), 'title': results[i].title, 'artist': results[i].artist}})
                link_result(i)
                report(i)
        await asyncio.to_thread(reuse_hits)

        async def acquire(idx):
            req = requests[idx]
            from .provider import DownloadRepository
            if isinstance(getattr(self.engine, 'download_repo', None), DownloadRepository):
                self.engine.download_repo.select(req.youtube_url)
            identity = self._identity(work['body'], idx)
            pos = fetch_positions.get(idx)
            if work['body'].get('_upload_path'):
                path = Path(work['body']['_upload_path'])
                await asyncio.to_thread(self._done, match_job, idx, detail={'decision': 'STRONG', 'reason': 'upload'})
                if unified:
                    await asyncio.to_thread(unified.advance, idx, 'fetched', detail={'_path': str(path)})
                    await asyncio.to_thread(self._done, fetch_job, idx, path=path)
            else:
                try:
                    # A durable reservation shares fetch AND publication across
                    # account requests; SQLite decides who does the work.
                    def fetch_reservation():
                        with self.ledger.lock:
                            reservation = self.ledger.db.execute('SELECT * FROM acquisition_transfers WHERE identity=?', (identity,)).fetchone()
                        return reservation
                    reservation = await asyncio.to_thread(fetch_reservation)
                    prior = await asyncio.to_thread(unified.item, pos) if unified else next((i for i in await asyncio.to_thread(self._items, fetch_job) if i['idx'] == pos), None)
                    staged_path = Path(prior['detail']['_path']) if prior and prior['detail'].get('_path') else None
                    if ((reservation is None or reservation['owner_request_id'] == id)
                            and prior and (prior.get('stage') in ('fetched', 'processed') if unified else prior['state'] == 'done') and staged_path is not None
                            and staged_path.is_relative_to(self.incoming) and await asyncio.to_thread(staged_path.is_file)):
                        transfer = {'state': 'staged', 'path': str(staged_path), 'job_id': fetch_job.id if isinstance(fetch_job, Stage) else fetch_job}
                        def claim_staged_fetch():
                            with self.ledger.lock, self.ledger.db:
                                self.ledger.db.execute("INSERT OR REPLACE INTO acquisition_transfers(identity,provider,job_id,state,path,owner_request_id) VALUES(?,? ,?,'running',?,?)", (identity, self.source_id, fetch_job.id if unified else fetch_job, str(staged_path), id))
                        await asyncio.to_thread(claim_staged_fetch)
                        if unified and prior['stage'] == 'fetched':
                            path = await self._process_fetched(req, staged_path, fetch_job, pos, enrichments.get(idx))
                            transfer['path'] = str(path)
                    else:
                        transfer = await self._transfer(identity, req, match_job, idx, fetch_job, pos, id, enrichment=enrichments.get(idx))
                    path = Path(transfer['path'])
                    if transfer['state'] == 'done':
                        results[idx] = DownloadResult(True, path, audio_format=await asyncio.to_thread(self._published_format, path))
                        await asyncio.to_thread(self._done, match_job, idx, path=path, detail={'decision': 'STRONG', 'reason': 'shared-fetch'})
                        if unified:
                            await asyncio.to_thread(unified.advance, idx, 'fetched', detail={'_path': str(path)})
                        await asyncio.to_thread(self._done, fetch_job, pos, path=path, detail={'shared_job_id': transfer['job_id']})
                        await asyncio.to_thread(done, import_job, import_positions, idx, path=path)
                        await asyncio.to_thread(link_result, idx)
                        await asyncio.to_thread(report, idx)
                        return
                except Exception as error:
                    error = classify_failure(error)
                    reason = POLICIES[error.kind].reason
                    results[idx] = DownloadResult(False, error=POLICIES[error.kind].message, failure_kind=reason)
                    if reason == 'no-encontrada':
                        await asyncio.to_thread(self._done, match_job, idx, error=error, reason=reason, detail={'decision': 'REJECTED'})
                    else:
                        await asyncio.to_thread(self._done, match_job, idx, detail={'decision': 'REVIEW', 'reason': POLICIES[error.kind].message})
                    await asyncio.to_thread(self._done, fetch_job, pos, error=error, reason=reason)
                    await asyncio.to_thread(done, import_job, import_positions, idx, error=error, reason=reason)
                    await asyncio.to_thread(done, link_job, link_positions, idx, error=error, reason=reason)
                    await asyncio.to_thread(report, idx)
                    return
            async with publication():
                # A cancelled coroutine must not leave a publication worker
                # mutating the ledger after recovery has started.
                def publish():
                    try:
                        publish_result(idx, path, identity, req)
                    except BaseException as error:
                        # Propagate process-stop signals through the parent task
                        # after its cleanup, rather than aborting a child task.
                        return error
                    return None
                worker = asyncio.create_task(asyncio.to_thread(publish))
                try:
                    error = await asyncio.shield(worker)
                except asyncio.CancelledError:
                    await asyncio.shield(worker)
                    raise
                if error is not None:
                    raise error

        def publish_result(idx, path, identity, req):
            importing()
            if not unified:
                self.ledger.item_transition(import_job, import_positions[idx], self._record(import_job)['attempt'], 'running')
            try:
                publication_reused = False
                def remember(final, *, already_present=False):
                    # Commit arrivals before visibility: a scanner can read the
                    # file immediately after publication, before this job resumes.
                    nonlocal publication_reused
                    publication_reused = already_present
                    if work['body'].get('_upload_path'):
                        with self.ledger.lock, self.ledger.db:
                            if already_present:
                                self.ledger.db.execute('UPDATE upload_items SET hit=?,published_path=NULL WHERE request_id=?',
                                                       (str(final), id))
                            else:
                                self.ledger.db.execute('UPDATE upload_items SET published_path=? WHERE request_id=?',
                                                       (str(final), id))
                            self.ledger._bump()
                    remember_arrival(self.music, final, receipt=row['created_at'],
                                     sha=work['body']['provider_id'] if work['body']['provider'] == 'upload' else None)
                    if not already_present:
                        # The receipt also covers interruption immediately after
                        # the writer's atomic rename, before it returns to us.
                        album_refresh.landed(final)
                format_report = {}
                config = getattr(self.engine, 'config', None)
                publish_options = {'before_publish': remember, 'expected_duration': req.duration_s,
                                   'ffmpeg': getattr(config, 'ffmpeg_path', 'ffmpeg'),
                                   'timeout': getattr(config, 'download_timeout', 300), 'format_report': format_report}
                if work['body'].get('_upload_path'):
                    publish_options['overwrite'] = False
                final = import_file(path, req.destination,
                             root=self.root, incoming=self.incoming, recycle=self.recycle, **publish_options)
                with self.ledger.lock, self.ledger.db:
                    self.ledger.db.execute("UPDATE acquisition_transfers SET state='done',path=? WHERE identity=?", (str(final), identity))
                if not work['body'].get('_upload_path'):
                    self.health.success(self.source_id)
                results[idx] = self.engine._success_result(final, req)
                results[idx].already_present = publication_reused
                results[idx].audio_format = format_report
                done(import_job, import_positions, idx, path=final, detail={'_published': not publication_reused, 'audio_format': format_report,
                     '_result': {'path': str(final), 'title': results[idx].title, 'artist': results[idx].artist}})
                if not work['body'].get('_upload_path') and not publication_reused:
                    self.health.published(self.source_id, format_report)
                shutil.rmtree(path.parent, ignore_errors=True)
            except Exception as error:
                reason = POLICIES[error.kind].reason if isinstance(error, SourceFailure) else 'fallo-importar'
                results[idx] = DownloadResult(False, error=str(error), failure_kind=reason)
                done(import_job, import_positions, idx, error=error, reason=reason)
                done(link_job, link_positions, idx, error=error, reason=reason)
                if isinstance(error, SourceFailure):
                    if not work['body'].get('_upload_path'):
                        self.health.failure(self.source_id, error)
                        self.store.search_forget(req.search_query, self.source_id)
                    shutil.rmtree(path.parent, ignore_errors=True)
                with self.ledger.lock, self.ledger.db:
                    self.ledger.db.execute("DELETE FROM acquisition_transfers WHERE identity=?", (identity,))
            if results[idx].success:
                link_result(idx)
                if not results[idx].already_present and not work['body'].get('_upload_batch'):
                    self.complete_batch([results[idx].file_path], origin=work['body']['provider'],
                                        batch_total=len(requests), refresh=False)
            report(idx)

        held = work['body'].get('_held_failures', {})
        def report_held():
            for index, failure in held.items():
                idx = int(index)
                if idx in hits:
                    continue
                results[idx] = DownloadResult(False, error=failure['error'], failure_kind=failure['reason'])
                error = failure['error']
                if failure.get('kind') in FailureKind:
                    error = SourceFailure(POLICIES[FailureKind(failure['kind'])].message, failure.get('_diagnostic'))
                    error.kind = FailureKind(failure['kind'])
                    if failure.get('failedAt') is not None:
                        error.failed_at = failure['failedAt']
                self._done(match_job, idx, error=error, reason=failure['reason'])
                for job, indices in ((fetch_job, fetch_positions), (import_job, import_positions), (link_job, link_positions)):
                    done(job, indices, idx, error=error, reason=failure['reason'])
                report(idx)
        await asyncio.to_thread(report_held)
        # One enrichment task per album: another album's slow catalog lookup
        # cannot hold a song that has already fetched its audio.
        groups = {}
        if not work['body'].get('_upload_path'):
            for idx in missing:
                if str(idx) not in held:
                    meta = requests[idx].metadata
                    groups.setdefault((norm(meta.artist), norm(meta.album or meta.title)), []).append(idx)
            for indices in groups.values():
                task = asyncio.create_task(self._enrich(id, requests, work['body'], indices))
                for idx in indices:
                    enrichments[idx] = task

        async def acquire_with_lookups(idx):
            token = current_lookups.set(lookups)
            try:
                await acquire(idx)
            finally:
                current_lookups.reset(token)

        workers = [asyncio.create_task(acquire_with_lookups(idx)) for idx in missing if str(idx) not in held]
        try:
            await asyncio.gather(*workers)
        except BaseException:
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            raise
        finally:
            # Let best-effort lookups persist their answers even when a fetch
            # failed early. No orphaned tasks or writes after request teardown.
            await asyncio.gather(*set(enrichments.values()), return_exceptions=True)
            await asyncio.to_thread(album_refresh.close)
        def finish_request():
            importing()
            for job in ([request_job] if unified else (match_job, fetch_job, import_job, link_job)):
                if job:
                    self._finish(job)
            successful = [i for i, r in enumerate(results) if r and r.success]
            count = len(successful)
            linked_all = all(i['state'] == 'done' for i in self._items(link_job))
            self.store.state(id, 'completo' if count == len(requests) and linked_all else 'parcial' if count else 'fallido', imported=count)
            if unified:
                job = self.ledger.get(unified.id)
                self.tracker.complete_progress(unified.id, 'done' if job['state'] == 'succeeded' else job['state'],
                                               succeeded=job['succeeded'], failed=job['failed'])
        await asyncio.to_thread(finish_request)
        return results

    def published_paths(self, *, upload_batch, request_id=None):
        """Recover actual publications, excluding reused files and other batches."""
        with self.ledger.lock:
            # Retries replace the stage graph but retain the publication audit.
            jobs = self.ledger.db.execute('''SELECT j.id FROM jobs j
                JOIN acquisition_work w ON w.request_id=j.parent_id
                WHERE j.kind IN ('acquisition-import','acquisition-request') AND json_extract(w.body, '$._upload_batch')=?
                AND (? IS NULL OR w.request_id=?)''', (upload_batch, request_id, request_id)).fetchall()
        return [Path(item['detail']['_path']) for job in jobs for item in self.ledger.items(job[0])
                if (item['state'] == 'done' or 'imported' in item['detail'].get('_stage_times', {})) and item['detail'].get('_published')]

    def complete_batch(self, paths, *, origin, batch_total=None, refresh=True):
        if not paths:
            return
        for listener in list(self.engine.completion_listeners):
            try:
                # Bind first: a TypeError raised inside a listener must never
                # cause a second invocation through the legacy signature.
                context = {'origin': origin}
                if batch_total is not None:
                    context['batch_total'] = batch_total
                for kwargs in (context, {'origin': origin}, {}):
                    try:
                        inspect.signature(listener).bind(paths, **kwargs)
                    except (TypeError, ValueError):
                        continue
                    break
                else:
                    kwargs = {}
                listener(paths, **kwargs)
            except Exception:
                logger.warning('acquisition after-listener failed', exc_info=True)
        if refresh:
            self.refresh_batch()

    def refresh_batch(self):
        finish_batch(self.music)

    def _reserve_transfer(self, identity, fetch_job, owner):
        with self.store.transaction() as db:
            row = db.execute('SELECT * FROM acquisition_transfers WHERE identity=?', (identity,)).fetchone()
            if row and row['state'] == 'failed':
                try:
                    saved = json.loads(row['error'] or '{}')
                except (ValueError, TypeError):
                    saved = {}
                if isinstance(saved, dict) and saved.get('kind') in FailureKind:
                    failure = SourceFailure(POLICIES[FailureKind(saved['kind'])].message, saved.get('details'))
                    failure.kind = FailureKind(saved['kind'])
                    raise failure
                raise AcquisitionError(row['reason'] or 'fallo-descarga')
            if row and row['state'] == 'done' and Path(row['path']).is_file():
                return dict(row)
            if row is None or row['state'] == 'done':
                db.execute('INSERT OR REPLACE INTO acquisition_transfers(identity,provider,job_id,state,owner_request_id) VALUES(?,?,?,?,?)',
                           (identity, self.source_id, fetch_job.id if isinstance(fetch_job, Stage) else fetch_job, 'running', owner))
                return {'state': 'reserved'}
            return None

    async def _transfer(self, identity, request, match_job, idx, fetch_job, pos, owner, *, enrichment=None):
        while True:
            reservation = await asyncio.to_thread(self._reserve_transfer, identity, fetch_job, owner)
            if reservation is not None:
                if reservation['state'] == 'done':
                    return reservation
                break
            await self.sleep(0.1)
        stage_dir = self.incoming / (fetch_job.id if isinstance(fetch_job, Stage) else fetch_job) / str(pos)
        try:
            while True:
                try:
                    prior = fetch_job.request.item(pos) if isinstance(fetch_job, Stage) else None
                    saved_url = prior['detail'].get('_source_url') if prior else None
                    while True:
                        await self._gate(match_job, idx)
                        async with self.search_limiter.slot():
                            if await asyncio.to_thread(self._gate_step, match_job, idx, admitted=True) > 0:
                                continue
                            if saved_url:
                                from .engine import ResolvedVideo
                                resolved = ResolvedVideo(saved_url, '', decision=prior['detail'].get('decision'))
                            else:
                                resolved = await self.engine._resolve_source_url(request)
                            break
                    if not resolved.url:
                        raise AcquisitionError('no-encontrada')
                    await asyncio.to_thread(self._done, match_job, idx, detail={'decision': resolved.decision, 'reason': resolved.reason, '_source_url': resolved.url})
                    stage_dir = self.incoming / (fetch_job.id if isinstance(fetch_job, Stage) else fetch_job) / str(pos)
                    await asyncio.to_thread(stage_dir.mkdir, parents=True, exist_ok=True)
                    attempt = (await asyncio.to_thread(self._record, fetch_job))['attempt']

                    progress_item = (await asyncio.to_thread(fetch_job.request.item, pos) if isinstance(fetch_job, Stage)
                                     else next((item for item in await asyncio.to_thread(self._items, fetch_job) if item['idx'] == pos), None))
                    def percent(value, item=progress_item):
                        # Percent is disposable for old and new requests alike.
                        if item:
                            self.tracker.set_track_phase(fetch_job.id if isinstance(fetch_job, Stage) else fetch_job, item['item'], 'downloading', max(0, min(100, value)), index=pos)

                    while True:
                        await self._gate(fetch_job, pos)
                        async with self.fetch_limiter(self.source_id).slot():
                            # Recheck after admission: a sibling may have failed
                            # while this song waited for the source's capacity.
                            if await asyncio.to_thread(self._gate_step, fetch_job, pos, admitted=True) > 0:
                                continue
                            def cancelled(version=attempt):
                                row = self._record(fetch_job)
                                return not row or row['attempt'] != version or row['state'] in ('cancelled', 'interrupted')

                            with source_download_context(request.metadata.title or request.search_query or request.get_filename(), cancelled, defer_processing=True):
                                path = await self.engine._download_audio_file(resolved.url, stage_dir, request.get_filename(), percent)
                            break
                    if path is None:
                        raise AcquisitionError('fallo-descarga')
                    path = await asyncio.to_thread(safe_open_path, stage_dir, Path(path))
                    if isinstance(fetch_job, Stage):
                        await asyncio.to_thread(fetch_job.request.advance, pos, 'fetched', detail={'_path': str(path)})
                    path = await self._process_fetched(request, path, fetch_job, pos, enrichment)
                    return {'state': 'staged', 'path': str(path), 'job_id': fetch_job.id if isinstance(fetch_job, Stage) else fetch_job}
                except Exception as error:
                    failure = classify_failure(error)
                    policy = POLICIES[failure.kind]
                    await asyncio.to_thread(self.health.failure, self.source_id, failure)
                    if failure.kind in (FailureKind.NOT_FOUND, FailureKind.BROKEN):
                        await asyncio.to_thread(self.store.search_forget, request.search_query, self.source_id)
                    if not policy.automatic:
                        raise failure from error
        except asyncio.CancelledError:
            def release_transfer():
                with self.ledger.lock, self.ledger.db:
                    self.ledger.db.execute("DELETE FROM acquisition_transfers WHERE identity=? AND state='running'", (identity,))
            await asyncio.to_thread(release_transfer)
            raise
        except Exception as error:
            def fail_transfer(error=error):
                failure = classify_failure(error)
                with self.ledger.lock, self.ledger.db:
                    self.ledger.db.execute("UPDATE acquisition_transfers SET state='failed',reason=?,error=? WHERE identity=?",
                        (POLICIES[failure.kind].reason, json.dumps({'kind': failure.kind, 'details': failure.details}), identity))
            await asyncio.to_thread(fail_transfer)
            await asyncio.to_thread(shutil.rmtree, stage_dir, ignore_errors=True)
            raise

    async def _process_fetched(self, request, path, fetch_job, pos, enrichment):
        if enrichment is not None:
            await asyncio.shield(enrichment)
        if isinstance(fetch_job, Stage):
            item = await asyncio.to_thread(fetch_job.request.item, pos)
            self.tracker.set_track_phase(fetch_job.id, item['item'], 'processing', index=pos)
        async with self.process_limiter.slot():
            finished = await self.engine._finish_staged_file(path, replace(request, destination=path.parent), lambda *args: None)
            path = finished or path
        await asyncio.to_thread(self._done, fetch_job, pos, path=path)
        return path

    async def legacy(self, requests, *, progress_id=None):
        """One-release adapter used by all eight old download service calls.

        Adapters still parse their historical inputs; this is the single point
        at which any of them can fetch, import, or link a track.
        """
        from app.infra.capacity import _job
        from app.infra.job_requests import encode_request
        from app.infra.progress import progress_principal
        principal = progress_principal.get() or LOCAL_OWNER
        job = _job.get()
        progress_id = progress_id or (job[1] if job else None)
        def legacy_destinations():
            return [replace(r, destination=self.root / 'Singles') if r.destination.resolve() == self.root.resolve() else r for r in requests]
        requests = await asyncio.to_thread(legacy_destinations)
        encoded = [encode_request(r) for r in requests]
        identity = hashlib.sha256(json.dumps(encoded, sort_keys=True).encode()).hexdigest()
        parent = await asyncio.to_thread(self.ledger.get, progress_id) if progress_id else None
        title = (parent or {}).get('label') or (requests[0].metadata.title if requests else None) or 'Descarga'
        pending = [i for i in await asyncio.to_thread(self.ledger.items, progress_id) if i['state'] in ('queued', 'running')] if parent else []
        body = {'kind': 'song' if len(requests) == 1 else 'playlist', 'provider': 'legacy',
                '_progress_items': [{'idx': i['idx'], 'item': i['item']} for i in pending],
                '_progress_attempt': parent['attempt'] if parent else None,
                'provider_id': identity, 'title': title,
                'tracks': [{} for r in requests], '_requests': encoded}
        self.check_sources()
        await asyncio.to_thread(self.check_space)
        row, fresh = await asyncio.to_thread(self.store.create, body, principal, job_id=progress_id, source_id=self.source_id)
        if not fresh:
            while (await asyncio.to_thread(self.store.get, row['id'], principal.user_id))['state'] in ('approved', 'fetching', 'importing'):
                await self.sleep(0.1)
            # A second caller of the same open intent observes the first result.
            return await asyncio.to_thread(self._saved_results, row['id'], len(requests))
        if parent:
            await asyncio.to_thread(self.ledger.running, progress_id, parent['attempt'])
        results = await self.run(row['id'], requests=requests)
        if self.tracker and parent:
            current = await asyncio.to_thread(self.ledger.get, progress_id)
            if current and current['attempt'] == parent['attempt'] and current['state'] in ('queued', 'running'):
                count, failed = current['succeeded'], current['failed']
                await asyncio.to_thread(self.tracker.complete_progress, progress_id, f"Downloaded {count}/{current['total']} tracks",
                                               succeeded=count, failed=failed)
        return results

    def _published_format(self, path):
        with self.ledger.lock:
            row = self.ledger.db.execute(
                "SELECT json_extract(detail, '$.audio_format') FROM items "
                "WHERE json_extract(detail, '$._path')=? AND json_extract(detail, '$.audio_format') IS NOT NULL "
                "ORDER BY rowid DESC LIMIT 1", (str(path),)).fetchone()
        return json.loads(row[0]) if row else None

    def _saved_results(self, id, total):
        with self.ledger.lock:
            jobs = self.ledger.db.execute("SELECT job_id FROM acquisition_stages WHERE request_id=? AND stage IN ('match','import')", (id,)).fetchall()
        paths = {int(i): Path(path) for i, path in self.store.work(id)['body'].get('_completed', {}).items()}
        unified = RequestJob.find(self.ledger, id, self.tracker)
        if unified:
            paths.update({i['detail']['index']: Path(i['detail']['_path']) for i in self.ledger.items(unified.id)
                          if 'imported' in i['detail'].get('_stage_times', {}) and i['detail'].get('_path')})
        for (job,) in jobs:
            for item in self.ledger.items(job):
                if item['state'] == 'done' and item['detail'].get('_path'):
                    paths[item['detail']['index']] = Path(item['detail']['_path'])
        return [DownloadResult(i in paths, paths.get(i), error=None if i in paths else 'fallo-descarga',
                               audio_format=self._published_format(paths[i]) if i in paths else None) for i in range(total)]

    async def catalog(self, data, principal, *, relocator=None):
        """Translate the shipped browse response; all work stays in this pipeline."""
        from app.infra.media_requests import CATALOG_EFFECT_TYPE, CATALOG_VOLUME_BOOST_DB
        from app.domains.acquisition.adapters import SpotifyAdapter
        from app.infra.job_requests import encode_request, request_item
        from app.utils.library_paths import rel_path_for
        import uuid

        destination = await asyncio.to_thread(safe_music_subpath, self.root, data.folder) if data.folder else self.root
        await asyncio.to_thread(self.check_space)
        tracks = [{'name': t.title, 'artist': t.artistName or '', 'album': t.albumTitle,
                   'track_number': t.trackPosition or None,
                   'duration_ms': int(t.durationSeconds * 1000) if t.durationSeconds else None,
                   'isrc': t.isrc, 'replaces': t.replaces,
                   'album_images': [{'url': t.coverUrl}] if t.coverUrl else None} for t in data.tracks]
        requests = await asyncio.to_thread(SpotifyAdapter(self.engine, logger)._build_track_requests,
            tracks, destination, False, CATALOG_EFFECT_TYPE, CATALOG_VOLUME_BOOST_DB)
        wanted = [{'title': r.metadata.title, 'artist': r.metadata.artist, 'duration_s': r.duration_s} for r in requests]
        try:
            hits = await asyncio.to_thread(owned_paths, self.ownership, self.root, wanted)
        except Exception:
            hits = {}
        for i, t in enumerate(data.tracks):
            if t.replaces:
                hits.pop(i, None)
        if len(hits) < len(requests):
            self.check_sources()
        member = not principal.is_owner
        progress_id = str(uuid.uuid4())
        total = len(requests) if member else len(requests)-len(hits)
        body = {'kind': 'song' if len(requests) == 1 else 'playlist', 'provider': 'catalog',
                'provider_id': hashlib.sha256(data.model_dump_json().encode()).hexdigest(),
                'title': data.label or data.tracks[0].albumTitle or data.tracks[0].title,
                'tracks': tracks, '_requests': [encode_request(r) for r in requests]}
        response = {'success': True, 'status': 'started', 'progress_id': progress_id, 'total': total,
                'destination': str(destination), 'requested': len(requests), 'queued': total,
                'alreadyPresent': [] if member else [{'title': data.tracks[i].title, 'relPath': rel_path_for(self.root, path), 'linked': is_real_user(principal)} for i, path in sorted(hits.items())],
                'linking': 'user' if is_real_user(principal) else 'skipped'}
        body['_legacy_response'] = response
        def register_catalog():
            # A duplicate must not receive an id before its tracker exists.
            # This lock is only acquired in workers; network work never holds it.
            with self._catalog_registration:
                row, fresh = self.store.create(body, principal, job_id=progress_id, source_id=self.source_id)
                if fresh:
                    self.tracker.create_progress(progress_id, total,
                        label=data.label or data.folder or data.tracks[0].albumTitle or data.tracks[0].title,
                        items=[request_item(r) for i, r in enumerate(requests) if member or i not in hits],
                        deduplicate_items=not member)
                return row, fresh
        row, fresh = await asyncio.to_thread(register_catalog)
        if not fresh:
            old = await asyncio.to_thread(self.store.work, row['id'])
            return old['body']['_legacy_response']
        linked = []
        for path in hits.values():
            if is_real_user(principal):
                try:
                    await asyncio.to_thread(link, self.user_tracks, principal.user_id, self.root, path, acquired=False)
                    linked.append(path)
                except Exception:
                    logger.warning('catalog immediate link failed', exc_info=True)
        async def run_catalog():
            try:
                results = await self.run(row['id'], requests=requests, hits=hits, relocator=relocator)
                chosen = [(i, r) for i, r in enumerate(results) if member or i not in hits]
                pending = await asyncio.to_thread(self.ledger.items, progress_id)
                for item, (_idx, result) in zip(pending, chosen, strict=False):
                    await asyncio.to_thread(self.ledger.outcome, progress_id, item['item'], idx=item['idx'], success=result.success,
                                        reason=result.failure_kind, detail={'reason': result.error, 'kind': result.failure_kind})
                    await asyncio.to_thread(self.tracker.update_progress, progress_id, item['item'])
                count = sum(r.success for _, r in chosen)
                status = f'Downloaded {count}/{total} tracks' + (f' ({total-count} failed)' if count < total else '')
                if not member and total == 0:
                    status = f'Already in the library ({len(hits)}) — nothing to download'
                await asyncio.to_thread(self.tracker.complete_progress, progress_id, status, succeeded=count, failed=total-count)
            except Exception as error:
                await asyncio.to_thread(self._fail_request, row['id'], error)
                await asyncio.to_thread(self.tracker.complete_progress, progress_id, 'failed')
                logger.exception('catalog acquisition failed request=%s', row['id'])
        if fresh:
            if len(hits) == len(requests):
                await run_catalog()
            else:
                spawn_background(run_catalog())
        return response
