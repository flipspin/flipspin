"""Producer dispatch and read composition for the durable ledger."""
from __future__ import annotations

from dataclasses import replace

import logging

from app.infra.progress import ProgressState, progress_principal
from app.infra.identity import LOCAL_OWNER, LEGACY_OWNER, ANONYMOUS
from app.infra.tasks import spawn_background

logger = logging.getLogger(__name__)


def starter_for(container, job):
    user_id = job['starter_user_id']
    if user_id is None:
        raise ValueError('starter-unavailable')
    for sentinel in (LOCAL_OWNER, LEGACY_OWNER, ANONYMOUS):
        if user_id == sentinel.user_id:
            return sentinel
    user = container.get_token_store().get_user(user_id)
    if user is None:
        raise ValueError('starter-unavailable')
    return user.principal()


def dispatch(container, job_id):
    """Re-enter the producer, with the original principal and only this attempt."""
    ledger = container.get_jobs()
    job = ledger.get(job_id)
    items = [i for i in ledger.items(job_id) if i['attempt'] == job['attempt'] and i['state'] == 'queued']
    principal = starter_for(container, job)
    payloads = [i['detail']['_retry'] for i in items]
    token = progress_principal.set(principal)
    try:
        tracker = container.get_progress_tracker()
        tracker.delete_progress(job_id)
        tracker.create_progress(job_id, len(ledger.items(job_id)))
        # Reconstruct successes from previous attempts for counts and SSE.
        for item in ledger.items(job_id):
            if item['state'] == 'done':
                tracker.update_progress(job_id, item['item'])
        producer = payloads[0]['producer'] if payloads else None
        if producer == 'source-install':
            container.get_source_installer().kick(job_id)
        elif producer == 'download-call':
            async def resume_call():
                from pathlib import Path
                try:
                    payload = payloads[0]
                    args = dict(payload['arguments'])
                    if 'tracks' in args:
                        args['tracks'] = [t for p in payloads for t in p['arguments']['tracks']]
                    args['destination'] = Path(args['destination'])
                    args['progress_id'] = job_id
                    if args.get('metadata'):
                        from app.infra.media_requests import TrackMetadata
                        args['metadata'] = TrackMetadata(**args['metadata'])
                    service = container.get_download_service()
                    result = await getattr(service, payload['method'])(**args)
                    results = result[1] if isinstance(result, tuple) else result
                    results = results if isinstance(results, list) else [results]
                    from app.domains.user_library.acquisition_links import link_results
                    link_results(container.get_user_track_store(), principal, container.config.base_music_dir, results)
                    await finish_import(container, job_id, principal)
                except Exception:
                    logger.exception('jobs call dispatch failed id=%s', job_id)
                    ledger.finish(job_id, job['attempt'], error=True)
                    tracker.complete_progress(job_id, 'failed')
            spawn_background(resume_call())
        elif producer == 'download':
            from app.infra.job_requests import decode_request
            from app.domains.user_library.acquisition_links import link_results

            async def run():
                try:
                    service = container.get_download_service()
                    requests = [decode_request(p['request']) for p in payloads]
                    results = await service.engine.download_multiple_tracks(requests, progress_id=job_id)
                    link_results(container.get_user_track_store(), principal, container.config.base_music_dir, results)
                    await finish_import(container, job_id, principal)
                except Exception:
                    logger.exception('jobs dispatch failed id=%s', job_id)
                    ledger.finish(job_id, job['attempt'], error=True)
                    tracker.complete_progress(job_id, 'failed')
            spawn_background(run())
        elif producer == 'lyrics-helper':
            lyrics = container.get_lyrics_service()
            if lyrics.engine_mode == 'agent':
                lyrics.agent_queue.enqueue([p['job'] for p in payloads], progress_id=job_id, label=job['label'])
            else:
                jobs = [lyrics._engine_job(p['job']['relPath'], text=p['job'].get('text'), isolate=p['job'].get('isolateVocals', True)) for p in payloads]
                for item, payload in zip(jobs, payloads, strict=True):
                    item.expected_lyric = payload['job'].get('expectedLyric')
                    item.selection = payload['job'].get('selection')
                lyrics.engine.run(jobs, progress_id=job_id)
        elif producer == 'lyrics-search':
            from app.domains.lyrics.services import _Job
            container.get_lyrics_service()._enqueue(
                [_Job(p['rel_path'], p['title'], p['artist'], p['album'], p['duration_s'], None) for p in payloads],
                label=payloads[0].get('batch_label', 'retry'), progress_id=job_id)
        elif producer == 'stems':
            p = payloads[0]
            service = container.get_stems_service()
            service.queue.request(p['album'], p['file'], p['model'], job_id=job_id)
            service.kick_local()
        else:
            raise ValueError('producer-unavailable')
    finally:
        progress_principal.reset(token)


async def finish_import(container, job_id, principal):
    """Rebuild the import's playlist from every successful item, across attempts."""
    from pathlib import Path
    from app.infra.media_requests import DownloadResult
    ledger = container.get_jobs()
    items = ledger.items(job_id)
    recipe = next((i['detail']['_after'] for i in items if i['detail'].get('_after')), None)
    if not recipe:
        return
    results = []
    for item in items:
        saved = item['detail'].get('_result')
        if item['state'] == 'done' and saved and saved['path']:
            results.append(DownloadResult(success=True, file_path=Path(saved['path']), title=saved['title'], artist=saved['artist']))
    if recipe['mode'] == 'export':
        from app.domains.playlists.export_import import save_export_playlist
        save_export_playlist(container.get_playlist_service(), recipe['name'], results, principal)
    else:
        from app.domains.downloads.routes import _save_imported_playlist_json
        await _save_imported_playlist_json(container.get_download_service(), container.get_playlist_service(),
            recipe['source_url'], ledger.get(job_id)['label'], results, principal)


def boot(container):
    ledger = container.get_jobs()
    # Import legacy files and recover helper leases before sweeping other
    # producers. Never enqueue a second copy of a linked item.
    lyrics = container.get_lyrics_service().agent_queue
    stems = container.get_stems_service().queue
    lyrics.status()
    stems.snapshot()
    queued = ledger.boot()
    with ledger.lock:
        linked = {r[0] for r in ledger.db.execute(
            'SELECT DISTINCT job_id FROM items WHERE queue_visible=1')}
    for job in queued:
        if job['kind'] in ('upload','source-install') or job['kind'].startswith('acquisition-') or job['id'] in linked:
            continue
        try:
            dispatch(container, job['id'])
        except Exception:
            logger.exception('jobs boot dispatch failed id=%s', job['id'])
            ledger.finish(job['id'], job['attempt'], error=True)

    # Do not replace a legacy producer already being replayed during this boot.
    # New acquisition rows have their own durable stage graph and recovery.
    with ledger.lock:
        table = ledger.db.execute("SELECT 1 FROM sqlite_master WHERE name='acquisition_requests'").fetchone()
        # Schema now exists for every install. Recovery must follow stored work,
        # rather than activating the upload pipeline just because a table exists.
        uploads_pending = ledger.db.execute('SELECT 1 FROM upload_batches LIMIT 1').fetchone()
        acquisition_pending = table and ledger.db.execute("SELECT 1 FROM acquisition_requests WHERE state IN ('approved','fetching','importing') LIMIT 1").fetchone()
    if acquisition_pending:
        container.get_acquisition().resume()
    if uploads_pending:
        container.get_uploads().recover()


def snapshot(container, principal):
    ledger, tracker = container.get_jobs(), container.get_progress_tracker()
    degraded, helpers = [], []
    for source, read in (
        ('lyrics', lambda: container.get_lyrics_service().agent_queue.status(read_only=True)),
        ('stems', lambda: container.get_stems_service().queue.snapshot(read_only=True)),
    ):
        try:
            view = read()
            if source == 'lyrics':
                helpers = view.get('helpers', [])
            unreadable = container.get_lyrics_service().agent_queue.degraded if source == 'lyrics' else getattr(container.get_stems_service().repository, 'queue_degraded', False)
            if unreadable:
                degraded.append(source)
        except Exception:
            logger.warning('jobs source unreadable source=%s', source, exc_info=True)
            degraded.append(source)
    rows = []
    for job in ledger.list():
        if not principal.is_owner and job['starter_user_id'] != principal.user_id:
            continue
        state = job['state']
        waiting = None
        if state in ('queued','running') and job['kind'] in ('lyrics-helper', 'stems', 'analysis'):
            pending = ledger.items(job['id'])
            queued = any(i['state'] == 'queued' for i in pending) and not any(i['state'] == 'running' for i in pending)
            kind = job['kind'] if job['kind'] in ('stems', 'analysis') else ('align' if any(i['detail'].get('_retry', {}).get('job', {}).get('text') for i in pending if i['state'] == 'queued') else 'transcribe')
            capable = container.get_lyrics_service().agent_queue.worker.capable_helpers(kind, helpers) if queued else []
            helper = next((h for h in capable if h.get('state') in ('idle', 'working')), None)
            if helper is None and capable:
                helper = capable[0]
                if helper.get('state') in ('asleep', 'closed', 'offline', 'outdated'):
                    state, waiting = 'waiting', {'name': helper['name'], 'state': helper['state']}
        cache = tracker.get_progress(job['id'])
        active = next(iter(cache.active.items()), (None, {})) if cache and state in ('queued','running','waiting') else (None, {})
        finished = job['succeeded'] + job['failed'] + job['skipped']
        rows.append({'id': job['id'], 'kind': ('import' if job['kind'] == 'acquisition-import' else 'download') if job['kind'].startswith('acquisition-') else job['kind'], 'label': job['label'], 'state': state,
            'total': job['total'], 'succeeded': job['succeeded'], 'failed': job['failed'], 'skipped': job['skipped'],
            'percent': round(100 * finished / job['total'], 2) if job['total'] else 100.0,
            'phase': active[1].get('phase'), 'item': active[0], 'waitingOn': waiting,
            'startedAt': job['started_at'], 'endedAt': job['ended_at'], 'attempt': job['attempt'],
            'failedCount': job['failed'], 'canCancel': state in ('queued','running','waiting'),
            'canRetry': False if job['kind'] == 'upload' else ledger.retryable(job['id'])})
    order = {'running': 0, 'waiting': 1, 'queued': 2}
    rows.sort(key=lambda r: order.get(r['state'], 3))
    return {'jobs': rows, 'degraded': degraded}


# 'match' is a Spotify import's first phase; the import flow polls it here.
DOWNLOAD_KINDS = frozenset({'download', 'import', 'upload', 'match'})


def is_download_kind(kind):
    return kind in DOWNLOAD_KINDS or kind.startswith('acquisition-')


def legacy_states(tracker):
    """Keep the shipped downloads response byte-for-byte shaped like ProgressState."""
    if not tracker.ledger:
        return tracker.list_all_progress()
    result = []
    for row in tracker.ledger.list():
        # This listing means "downloads": older clients draw every row as one.
        # Analysis, lyrics, stems and library edits live only in GET /api/jobs.
        if not is_download_kind(row['kind']):
            continue
        cache = tracker.get_progress(row['id'])
        if cache:
            if row['state'] in ('cancelled','interrupted'):
                cache = replace(cache, status=row['state'])
            elif row['state'] not in ('queued','running') and not cache.is_terminal:
                cache = replace(cache, status='done' if row['state'] == 'succeeded' else row['state'])
            result.append(cache)
            continue
        items = tracker.ledger.items(row['id'])
        state = ProgressState(row['id'], row['total'], created_at=row['created_at'], starter_user_id=row['starter_user_id'])
        state.status = {'running': 'in_progress', 'succeeded': 'done'}.get(row['state'], row['state'])
        state.done = [i['item'] for i in items if i['state'] not in ('queued', 'running')]
        state.succeeded, state.failed = row['succeeded'], row['failed']
        state.failures = [{k: v for k,v in i['detail'].items() if not k.startswith('_')} for i in items if i['state'] == 'failed']
        result.append(state)
    return result
