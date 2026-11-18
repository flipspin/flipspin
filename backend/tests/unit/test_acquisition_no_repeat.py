"""Acquisition lookups are reused, and catalog latency never holds up fetching."""
import asyncio
import logging
import threading
from unittest.mock import AsyncMock, Mock

import pytest

from app.domains.acquisition.engine import DownloadEngine
from app.domains.acquisition.services import Pipeline
from app.domains.metadata.deezer_repository import DeezerRepository
from app.domains.metadata.genres import AlbumGenres
from app.infra.jobs import Jobs
from tests.unit.test_acquisition import ANA, body, configure_capacity, pipeline as pipeline, submit


def engine(config):
    return DownloadEngine(Mock(), Mock(), Mock(), None, config, logging.getLogger(__name__))


def test_thirteen_songs_download_one_cover_and_read_one_album(pipeline, config):
    real = engine(config)
    real.genius_repo.download_cover_art.side_effect = lambda url, path: path.write_bytes(b'cover bytes')
    pipeline.engine._finish_staged_file = real._finish_staged_file
    session = Mock()
    response = session.get.return_value
    response.status_code = 200
    response.json.return_value = {'genres': {'data': [{'id': 1, 'name': 'Rock'}]}, 'release_date': '1999-02-03'}
    repo = DeezerRepository(config, Mock(), session=session, min_interval_s=0)
    repo.search_albums = Mock(return_value=[{'id': 123, 'title': 'Album', 'artist': {'name': 'Artist'}}])
    pipeline.metadata_lookup = lambda: AlbumGenres(repo)
    data = body(13)
    for track in data.tracks:
        track.cover_url = 'https://example.com/cover.jpg'
    request = submit(pipeline, data)
    results = asyncio.run(pipeline.run(request['id']))
    assert all(r.success for r in results)
    assert session.get.call_count == 1
    assert session.get.call_args.args[0].endswith('/album/123')
    assert session.get.call_args.kwargs['headers']['Accept-Language'] == 'es'
    real.genius_repo.download_cover_art.assert_called_once()
    assert real.metadata_repo.embed_cover_art.call_count == 13
    assert all(call.args[1] == b'cover bytes' for call in real.metadata_repo.embed_cover_art.call_args_list)
    assert (results[0].file_path.parent / 'cover.jpg').read_bytes() == b'cover bytes'
    assert all(call.args[1].genre == 'Rock' and call.args[1].year == 1999
               for call in real.metadata_repo.write_id3_tags.call_args_list)


def test_supplied_album_tags_skip_lookup(pipeline):
    data = body(13)
    for track in data.tracks:
        track.genre, track.year = 'Rock', 1999
    pipeline.metadata_lookup = Mock(side_effect=AssertionError('browse supplied the tags'))
    request = submit(pipeline, data)
    assert all(r.success for r in asyncio.run(pipeline.run(request['id'])))
    pipeline.metadata_lookup.assert_not_called()


def test_fetch_overlaps_enrichment_and_each_song_notifies_before_last_import(pipeline):
    configure_capacity(pipeline, 3)
    request = submit(pipeline, body(3))
    release_enrichment = threading.Event()
    events = []
    lookup = Mock()
    def enrich(*args):
        assert release_enrichment.wait(5)
        events.append('enriched')
        return 'Rock', 1999, []
    lookup.lookup.side_effect = enrich
    pipeline.metadata_lookup = lambda: lookup
    original = pipeline.engine._download_audio_file

    async def scenario():
        fetched, notified, release_last = asyncio.Event(), asyncio.Event(), asyncio.Event()
        def listener(paths, *, origin, batch_total):
            assert origin == 'deezer' and batch_total == 3
            events.append(('notify', paths[0].name))
            if paths[0].name.startswith('01'):
                loop.call_soon_threadsafe(notified.set)
        pipeline.engine.completion_listeners = [listener]
        async def download(url, destination, filename, percent_cb=None):
            events.append('fetch')
            fetched.set()
            if not filename.startswith('01'):
                await release_last.wait()
            return await original(url, destination, filename, percent_cb)
        async def tag(path, req, phase):
            assert req.metadata.genre == 'Rock' and req.metadata.year == 1999
            events.append('tag')
        pipeline.engine._download_audio_file = download
        pipeline.engine._finish_staged_file = tag
        loop = asyncio.get_running_loop()
        task = asyncio.create_task(pipeline.run(request['id']))
        try:
            await asyncio.wait_for(fetched.wait(), 5)
            assert 'enriched' not in events
            release_enrichment.set()
            await asyncio.wait_for(notified.wait(), 5)
            assert pipeline.view(request['id'], ANA)['imported_tracks'] <= 1
            assert not task.done()
            release_last.set()
            assert all(r.success for r in await asyncio.wait_for(task, 5))
        finally:
            release_enrichment.set()
            release_last.set()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())
    assert events.index('fetch') < events.index('enriched') < events.index('tag')
    assert len([event for event in events if isinstance(event, tuple)]) == 3


def use_real_search(pipeline, config):
    real = engine(config)
    async def search(query, **kwargs):
        title = query.removesuffix(' Artist')
        return [{'id': title, 'url': 'https://youtube.com/watch?v=test', 'title': f'Artist - {title}', 'duration': 180}]
    real.download_repo.search_source = AsyncMock(side_effect=search)
    pipeline.engine._resolve_source_url = real._resolve_source_url
    return real.download_repo.search_source


def test_restart_mid_request_reuses_all_searches_from_sqlite(pipeline, config):
    search = use_real_search(pipeline, config)
    request = submit(pipeline, body(13))
    original = pipeline.engine._download_audio_file
    async def interrupted():
        entered = asyncio.Queue()
        async def download(*args):
            entered.put_nowait(None)
            await asyncio.Event().wait()
        pipeline.engine._download_audio_file = download
        task = asyncio.create_task(pipeline.run(request['id']))
        try:
            for _ in range(2):
                await asyncio.wait_for(entered.get(), 5)
            async def searched_all():
                while any(pipeline.store.search_get(f'Song {i} Artist') is None for i in range(13)):
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(searched_all(), 5)
            assert entered.empty()  # only two fetches can be admitted
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
    asyncio.run(interrupted())
    assert search.await_count == 13
    path = pipeline.ledger.path
    pipeline.ledger.close()
    ledger = Jobs(path)
    restarted = Pipeline(ledger=ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                         user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data)
    restarted.kick = Mock()
    restarted.resume()
    pipeline.engine._download_audio_file = original
    try:
        assert all(r.success for r in asyncio.run(restarted.run(request['id'])))
        assert search.await_count == 13
    finally:
        ledger.close()


def test_search_ttl_normalization_and_failed_fetch_invalidation(pipeline, config):
    search = use_real_search(pipeline, config)
    pipeline.store.search_put('  Song  0 ARTIST ', [{'title': 'cached'}])
    assert pipeline.store.search_get('song 0 artist') == [{'title': 'cached'}]
    pipeline.ledger.now = lambda: 10**12
    assert pipeline.store.search_get('song 0 artist') is None
    pipeline.engine._download_audio_file = AsyncMock(return_value=None)
    request = submit(pipeline)
    assert not asyncio.run(pipeline.run(request['id']))[0].success
    assert pipeline.store.search_get('Song 0 Artist') is None
    pipeline.ledger.now = lambda: 10**12 + 1000  # the source's broken backoff has expired
    pipeline.retry(request['id'], ANA, schedule=False)
    asyncio.run(pipeline.run(request['id']))
    assert search.await_count == 2


def test_slow_album_does_not_hold_another_albums_tagging(pipeline):
    data = body(2)
    data.tracks[1].album = 'Slow Album'
    request = submit(pipeline, data)
    release = threading.Event()
    lookup = Mock()
    def enrich(artist, album, *args):
        if album == 'Slow Album':
            assert release.wait(5)
        return 'Rock', 2000, []
    lookup.lookup.side_effect = enrich
    pipeline.metadata_lookup = lambda: lookup
    async def scenario():
        tagged = asyncio.Event()
        async def tag(path, req, phase):
            if req.metadata.album == 'Album':
                tagged.set()
        pipeline.engine._finish_staged_file = tag
        task = asyncio.create_task(pipeline.run(request['id']))
        try:
            await asyncio.wait_for(tagged.wait(), 5)
            assert not release.is_set() and not task.done()
            release.set()
            assert all(r.success for r in await asyncio.wait_for(task, 5))
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())
