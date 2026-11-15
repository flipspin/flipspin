"""Acquisition intent, authorization, cancellation, and typed outcomes."""
import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.acquisition.models import AcquisitionError
from app.domains.acquisition.repository import Requests
from app.domains.acquisition.services import Pipeline
from app.domains.downloads.core import ResolvedVideo
from app.exceptions import ProviderRateLimitedError
from app.infra.identity import LOCAL_OWNER, Principal
from app.infra.jobs import Jobs
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, BETO, body, submit

from tests.unit.test_source_plugin import fake_source as fake_source

pipeline = fixtures.pipeline


def test_check_1_idempotent_repeat_and_conflict(pipeline):
    first = submit(pipeline, key='phone-intent')
    asyncio.run(pipeline.run(first['id']))
    assert submit(pipeline, key='phone-intent') == first
    changed = body().model_copy(update={'title': 'Different'})
    with pytest.raises(AcquisitionError) as error:
        submit(pipeline, changed, key='phone-intent')
    assert error.value.status == 422
    assert len(pipeline.store.list(ANA.user_id)) == 1


def test_open_requests_are_unique_per_account_in_sqlite(pipeline):
    one = submit(pipeline)
    assert submit(pipeline)['id'] == one['id']
    assert submit(pipeline, principal=BETO)['id'] != one['id']
    index = pipeline.ledger.db.execute("SELECT sql FROM sqlite_master WHERE name='acquisition_open'").fetchone()[0]
    assert 'WHERE state IN' in index
    assert set(r[1] for r in pipeline.ledger.db.execute('PRAGMA table_info(acquisition_requests)')) == {
        'id', 'account_id', 'kind', 'provider', 'provider_id', 'title', 'state', 'created_at', 'decided_by',
        'decided_at', 'expected_tracks', 'imported_tracks', 'dismissed_at'}


def test_acquisition_schema_migrates_old_rows_and_preserves_dismissal_on_restart(tmp_path):
    path = tmp_path / 'jobs.sqlite'
    ledger = Jobs(path)
    job = ledger.start('download', 'existing job', ['one'], ANA)
    with ledger.db:
        ledger.db.execute('DROP TABLE acquisition_requests')
        ledger.db.execute('PRAGMA user_version=0')  # pre-runner release shape
        ledger.db.execute('''CREATE TABLE acquisition_requests (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('song','album','playlist')),
            provider TEXT NOT NULL, provider_id TEXT NOT NULL, title TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN
                ('pending','approved','fetching','importing','completo','parcial','fallido','rechazado')),
            created_at REAL NOT NULL, decided_by TEXT, decided_at REAL,
            expected_tracks INTEGER NOT NULL, imported_tracks INTEGER NOT NULL DEFAULT 0
        )''')
        ledger.db.execute("INSERT INTO acquisition_requests VALUES('old','ana','song','deezer','old','Old song','completo',1,'ana',1,1,1)")
    ledger.close()

    ledger = Jobs(path)
    try:
        store = Requests(ledger)
        columns = {row[1]: row for row in ledger.db.execute('PRAGMA table_info(acquisition_requests)')}
        assert columns['dismissed_at'][2:4] == ('REAL', 0)
        assert store.get('old', ANA.user_id)['dismissed_at'] is None
        assert [row['id'] for row in store.list(ANA.user_id)] == ['old']
        fresh, created = store.create(body().model_dump(), ANA)
        assert created and fresh['dismissed_at'] is None
        assert store.dismiss_finished(ANA.user_id) == 1
        dismissed_at = store.get('old', ANA.user_id)['dismissed_at']
        assert dismissed_at is not None
        assert ledger.items(job)[0]['item'] == 'one'
        assert ledger.db.execute('PRAGMA foreign_key_check').fetchall() == []
    finally:
        ledger.close()

    ledger = Jobs(path)
    try:
        store = Requests(ledger)
        assert store.get('old', ANA.user_id)['dismissed_at'] == dismissed_at
        assert [row['id'] for row in store.list(ANA.user_id)] == [fresh['id']]
        assert store.dismiss_finished(ANA.user_id) == 0
    finally:
        ledger.close()


def test_check_2_on_disk_song_links_without_fetch(pipeline):
    song = pipeline.root / 'Album' / 'Song.mp3'
    song.parent.mkdir()
    song.write_bytes(b'already here')
    pipeline.ownership.lookup_many.side_effect = lambda tracks: [SimpleNamespace(owned=True, match=SimpleNamespace(path=song))]
    request = submit(pipeline)
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.engine.calls == []
    assert pipeline.user_tracks.get(ANA.user_id, 'Album/Song.mp3').acquired is False
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'
    assert set(pipeline.view(request['id'], ANA)['stages'].values()) == {request['id']}


def test_check_3_album_failure_is_partial_11_of_12(pipeline):
    original = pipeline.engine._download_audio_file

    async def fail_one(url, destination, filename, percent_cb=None):
        if filename.startswith('06'):
            raise OSError('source unavailable')
        return await original(url, destination, filename, percent_cb)

    pipeline.engine._download_audio_file = fail_one
    request = submit(pipeline, body(12))
    asyncio.run(pipeline.run(request['id']))
    row = pipeline.store.get(request['id'], ANA.user_id)
    assert (row['state'], row['imported_tracks'], row['expected_tracks']) == ('parcial', 11, 12)
    failures = [i for i in pipeline.view(request['id'], ANA)['items'] if i['state'] == 'failed']
    assert any(i['reason'] == 'fallo-descarga' and i['stage'] == 'fetch' for i in failures)
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 11


def test_check_4_session_limit_pauses_all_pending_items_and_resumes(pipeline):
    now = [1000.0]
    pipeline.ledger.now = lambda: now[0]
    pipeline.health.started_at = now[0] - 901
    pipeline.health.jitter = lambda: 1
    original = pipeline.engine._download_audio_file
    limited = [False]
    observed = []
    resumed = asyncio.Event()

    async def download(*args):
        if not limited[0]:
            limited[0] = True
            raise ProviderRateLimitedError('HTTP 429: session rate limit')
        await resumed.wait()
        return await original(*args)

    async def resume(seconds):
        if resumed.is_set():
            return
        live = pipeline.view(request['id'], ANA)
        pending = [i for i in live['items'] if i['stage'] == 'fetch' and i['state'] in ('queued', 'running')]
        assert len(pending) == 3
        assert all(i['reason'] == 'en-pausa' and i['detail']['until'] == 1060 for i in pending)
        assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'fetching'
        assert not any(i['state'] == 'failed' for i in live['items'])
        observed.append(seconds)
        now[0] = 1061
        resumed.set()

    pipeline.engine._download_audio_file = download
    pipeline.sleep = resume
    request = submit(pipeline, body(3))
    asyncio.run(pipeline.run(request['id']))
    assert observed
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'


def test_check_5_fetch_stays_in_incoming_and_import_is_atomic(pipeline, monkeypatch):
    from app.domains.music import writer
    snapshots = []
    original = writer.os.replace

    def rename(source, target):
        target = Path(target)
        if target.suffix == '.mp3':
            assert Path(source).name.startswith('.import-')
            assert Path(source).read_bytes() == b'complete audio'
            snapshots.append(list(pipeline.root.rglob('*.mp3')))
        return original(source, target)

    monkeypatch.setattr(writer.os, 'replace', rename)
    request = submit(pipeline, body(3))
    asyncio.run(pipeline.run(request['id']))
    assert all(p.is_relative_to(pipeline.incoming) for p in pipeline.engine.calls)
    assert [len(s) for s in snapshots] == [0, 1, 2]
    assert len(list(pipeline.root.rglob('*.mp3'))) == 3
    assert not list(pipeline.root.rglob('.import-*'))


def test_check_6_other_account_request_id_is_404_even_for_owner(pipeline):
    request = submit(pipeline)
    owner = Principal(BETO.user_id, 'Owner', 'owner')
    for action in (pipeline.view, pipeline.cancel, pipeline.retry):
        with pytest.raises(AcquisitionError) as error:
            action(request['id'], owner)
        assert error.value.status == 404
    assert pipeline.store.list(BETO.user_id) == []


def test_sentinel_is_refused_before_creating_intent(pipeline):
    with pytest.raises(AcquisitionError, match='sign-in-required') as error:
        submit(pipeline, principal=LOCAL_OWNER)
    assert error.value.status == 409
    assert pipeline.store.list(LOCAL_OWNER.user_id) == []


def test_disk_floor_refuses_before_any_work(pipeline, monkeypatch):
    monkeypatch.setattr('app.domains.acquisition.services.shutil.disk_usage', lambda p: SimpleNamespace(free=0))
    with pytest.raises(AcquisitionError, match='sin-espacio') as error:
        submit(pipeline)
    assert error.value.status == 507
    assert pipeline.store.list(ANA.user_id) == []
    assert pipeline.engine.calls == []


def test_import_failure_records_reason_and_recycles_replacement(pipeline, monkeypatch):
    from app.domains.acquisition import services
    song = pipeline.root / 'Album' / '01 - Song 0.mp3'
    song.parent.mkdir()
    song.write_bytes(b'old recording')
    request = submit(pipeline)
    asyncio.run(pipeline.run(request['id']))
    assert song.read_bytes() == b'complete audio'
    assert [p.read_bytes() for p in pipeline.recycle.iterdir()] == [b'old recording']
    def refuse(*args, **kwargs):
        raise OSError('read-only filesystem')
    monkeypatch.setattr(services, 'import_file', refuse)
    request = submit(pipeline, body().model_copy(update={'provider_id': 'different'}))
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'fallido'
    assert any(i['reason'] == 'fallo-importar' and 'read-only filesystem' in i['detail']['error'] for i in pipeline.view(request['id'], ANA)['items'])


def test_cancel_only_before_fetch_and_retry_only_failures(pipeline):
    request = submit(pipeline)
    assert pipeline.cancel(request['id'], ANA)['state'] == 'rechazado'
    assert asyncio.run(pipeline.run(request['id'])) == []
    with pytest.raises(AcquisitionError, match='cannot-retry'):
        pipeline.retry(request['id'], ANA, schedule=False)


def test_ledger_schema_migration_preserves_jobs_and_foreign_keys(tmp_path):
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    job = ledger.start('download', 'existing', ['one'], ANA)
    ledger.close()
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    assert ledger.items(job)[0]['item'] == 'one'
    assert ledger.db.execute('PRAGMA foreign_key_check').fetchall() == []
    assert ledger.start('acquisition-fetch', 'new', ['new'], ANA)
    ledger.close()


def test_accounts_share_the_fetch_reservation_and_link_independently(pipeline):
    first = submit(pipeline)
    second = submit(pipeline, principal=BETO)
    original = pipeline.engine._download_audio_file
    async def concurrent():
        entered = asyncio.Event()
        release = asyncio.Event()
        async def download(*args):
            entered.set()
            await release.wait()
            return await original(*args)
        pipeline.engine._download_audio_file = download
        one = asyncio.create_task(pipeline.run(first['id']))
        await entered.wait()
        two = asyncio.create_task(pipeline.run(second['id']))
        await asyncio.sleep(0.02)
        release.set()
        await asyncio.wait_for(asyncio.gather(one, two), 2)
    asyncio.run(concurrent())
    assert len(pipeline.engine.calls) == 1
    assert pipeline.view(first['id'], ANA)['stages']['fetch'] != pipeline.view(second['id'], BETO)['stages']['fetch']
    assert len(pipeline.ledger.list()) == 2
    assert all(item['state'] == 'done' and item['stageAt'] is not None for item in pipeline.view(second['id'], BETO)['items'])
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 1
    assert len(pipeline.user_tracks.list_for_user(BETO.user_id)) == 1


def test_idempotent_replay_ignores_changed_disk_capacity(pipeline, monkeypatch):
    first = submit(pipeline, key='one')
    monkeypatch.setattr('app.domains.acquisition.services.shutil.disk_usage', lambda p: SimpleNamespace(free=0))
    assert submit(pipeline, key='one') == first


def test_playlist_folder_is_created_only_at_import(pipeline):
    request = submit(pipeline, body(3, folder='Collection'))
    assert not (pipeline.root / 'Collection').exists()
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'
    assert len(list((pipeline.root / 'Collection' / 'Album').glob('*.mp3'))) == 3


def test_traversal_is_rejected_before_committing_intent(pipeline):
    with pytest.raises(AcquisitionError, match='invalid-destination'):
        submit(pipeline, body(folder='../outside'))
    assert pipeline.store.list(ANA.user_id) == []


def test_rejected_match_is_typed_and_never_downloads(pipeline):
    async def reject(request):
        return ResolvedVideo(None, 'duration veto', 'rejected')
    pipeline.engine._resolve_source_url = reject
    request = submit(pipeline)
    asyncio.run(pipeline.run(request['id']))
    assert pipeline.engine.calls == []
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'fallido'
    item = next(i for i in pipeline.view(request['id'], ANA)['items'] if i['stage'] == 'match')
    assert item['reason'] == 'no-encontrada' and item['detail']['decision'] == 'REJECTED'


def test_catalog_duplicate_returns_the_first_progress_id(pipeline):
    from app.domains.browse.acquisition import AcquireRequest
    from app.infra.progress import ProgressTracker
    pipeline.tracker = ProgressTracker(pipeline.ledger)
    original = pipeline.engine._download_audio_file
    data = AcquireRequest(tracks=[{'title': 'Song', 'artistName': 'Artist', 'albumTitle': 'Album'}])
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        async def download(*args):
            entered.set()
            await release.wait()
            return await original(*args)
        pipeline.engine._download_audio_file = download
        first, second = await asyncio.gather(pipeline.catalog(data, ANA), pipeline.catalog(data, ANA))
        assert first == second
        assert pipeline.tracker.get_progress(first['progress_id']) is not None
        await entered.wait()
        assert await pipeline.catalog(data, ANA) == first
        release.set()
        async def finished():
            while pipeline.store.list(ANA.user_id)[0]['state'] != 'completo':
                await asyncio.sleep(0.01)
        await asyncio.wait_for(finished(), 2)
    asyncio.run(scenario())
    assert len(pipeline.engine.calls) == 1


def test_source_search_429_keeps_its_typed_pause_signal(config):
    from unittest.mock import AsyncMock
    from app.domains.acquisition.provider import DownloadRepository
    port = SimpleNamespace(search=AsyncMock(side_effect=ProviderRateLimitedError('busy')))
    repo = DownloadRepository(config, Mock(), source=port)
    with pytest.raises(ProviderRateLimitedError):
        asyncio.run(repo.search_source('Song Artist'))


@pytest.mark.parametrize('encoded', [False, True])
@pytest.mark.parametrize('manual', [False, True])
def test_item_selection_retries_only_that_manifest_item_and_survives_restart(pipeline, encoded, manual):
    from app.domains.acquisition.models import RetrySelection
    from app.infra.job_requests import encode_request
    request = submit(pipeline, body(3))
    id = request['id']
    if encoded:
        work = pipeline.store.work(id)['body']
        work['_requests'] = [encode_request(req) for req in pipeline._requests(work)]
        import json
        with pipeline.ledger.db:
            pipeline.ledger.db.execute('UPDATE acquisition_work SET body=? WHERE request_id=?', (json.dumps(work), id))
    original = pipeline.engine._resolve_source_url
    async def search(req):
        return await original(req) if req.metadata.track_number == 1 else ResolvedVideo(None, 'no results', 'no-results')
    pipeline.engine._resolve_source_url = search
    asyncio.run(pipeline.run(id))
    assert len(pipeline.engine.calls) == 1
    selected = 'https://www.youtube.com/watch?v=chosen' if manual else None
    pipeline.retry(id, ANA, selection=RetrySelection(index=1, youtube_url=selected), schedule=False)
    # Construct a fresh pipeline from durable work, as startup does.
    resumed = Pipeline(ledger=pipeline.ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                       user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data)
    seen = []
    async def chosen(req):
        seen.append(req)
        assert req.youtube_url == selected
        assert req.search_query is None if manual else req.search_query == 'Song 1 Artist'
        assert req.metadata.title == 'Song 1'
        return await original(req)
    pipeline.engine._resolve_source_url = chosen
    asyncio.run(resumed.run(id))
    assert len(seen) == 1
    assert len(pipeline.engine.calls) == 2
    view = resumed.view(id, ANA)
    assert (view['id'], view['state'], view['imported_tracks']) == (id, 'parcial', 2)
    links = sorted((i for i in view['items'] if i['stage'] == 'link'), key=lambda i: i['detail']['index'])
    assert [i['state'] for i in links] == ['done', 'done', 'failed']
    assert links[1]['detail']['rel_path'] == 'Album/02 - Song 1.mp3'
    # An ordinary retry still retries the remaining failed song.
    resumed.retry(id, ANA, schedule=False)
    pipeline.engine._resolve_source_url = original
    asyncio.run(resumed.run(id))
    assert resumed.view(id, ANA)['state'] == 'completo'
    assert len(pipeline.engine.calls) == 3


@pytest.mark.asyncio
async def test_cancel_fetch_job_stops_source_with_track_info(pipeline, config, tmp_path, caplog, fake_source):
    import logging
    from app.domains.acquisition import provider
    from app.domains.acquisition.engine import DownloadEngine
    from app.infra.progress import ProgressTracker
    log = logging.getLogger('test.fetch-cancel')
    engine = DownloadEngine(provider.DownloadRepository(config, log, source=fake_source), Mock(), Mock(), ProgressTracker(), config, log)
    async def resolve(request):
        return ResolvedVideo('hang', decision='STRONG')
    engine._resolve_source_url = resolve
    pipeline.engine = engine
    request = submit(pipeline)
    with caplog.at_level(logging.INFO):
        task = asyncio.create_task(pipeline.run(request['id']))
        async def ready():
            while not any(c['method'] == 'fetch' for c in fake_source.calls()):
                await asyncio.sleep(0.01)
        await asyncio.wait_for(ready(), 5)
        process = fake_source.process
        job = pipeline.view(request['id'], ANA)['stages']['fetch']
        pipeline.ledger.cancel(job, pipeline.ledger.get(job)['attempt'])
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
    assert process.poll() is not None
    assert pipeline.ledger.get(job)['state'] == 'cancelled'
    assert not any(r.levelno >= logging.ERROR for r in caplog.records)
    assert 'Download cancelled · «Song 0»' in caplog.text
    with pipeline.ledger.lock:
        assert not pipeline.ledger.db.execute("SELECT 1 FROM acquisition_transfers WHERE state='running'").fetchone()
