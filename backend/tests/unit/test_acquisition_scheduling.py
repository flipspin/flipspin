"""Bounded acquisition concurrency and publication timing."""
import asyncio

import pytest

from app.domains.downloads.core import ResolvedVideo
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, body, configure_capacity, submit

pipeline = fixtures.pipeline


@pytest.mark.parametrize('fail_first', [False, True])
def test_each_song_links_before_slow_fetches_finish(pipeline, fail_first):
    configure_capacity(pipeline)
    request = submit(pipeline, body(3))
    original = pipeline.engine._download_audio_file

    async def scenario():
        entered = [asyncio.Event() for _ in range(3)]
        release = [asyncio.Event() for _ in range(3)]

        async def download(url, destination, filename, percent_cb=None):
            index = int(filename[:2]) - 1
            entered[index].set()
            await release[index].wait()
            if index == 0 and fail_first:
                raise OSError('source refused')
            return await original(url, destination, filename, percent_cb)

        pipeline.engine._download_audio_file = download
        task = asyncio.create_task(pipeline.run(request['id']))
        try:
            await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered)), 2)
            release[1].set()

            async def linked_second():
                while pipeline.view(request['id'], ANA)['imported_tracks'] != 1:
                    await asyncio.sleep(0.001)

            await asyncio.wait_for(linked_second(), 2)
            live = pipeline.view(request['id'], ANA)
            second = {item['stage']: item for item in live['items'] if item['detail']['index'] == 1}
            assert second['import']['state'] == second['link']['state'] == 'done'
            assert second['link']['detail']['rel_path'] == 'Album/02 - Song 1.mp3'
            assert live['imported_tracks'] == 1
            assert all(item['state'] == 'running' for item in live['items']
                       if item['stage'] == 'fetch' and item['detail']['index'] in (0, 2))
            assert not task.done()
            release[0].set()
            release[2].set()
            results = await asyncio.wait_for(task, 2)
            assert [result.success for result in results] == [not fail_first, True, True]
            assert [result.title for result in results if result.success] == (['Song 1', 'Song 2'] if fail_first else ['Song 0', 'Song 1', 'Song 2'])
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    assert pipeline.view(request['id'], ANA)['state'] == ('parcial' if fail_first else 'completo')
    assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == (2 if fail_first else 3)


@pytest.mark.parametrize('limit', [1, 2, 3])
def test_parallel_fetches_obey_shared_nest_capacity(pipeline, limit):
    configure_capacity(pipeline, limit)
    first = submit(pipeline, body(3))
    second = submit(pipeline, body(3).model_copy(update={'provider_id': 'other-album'}))
    original = pipeline.engine._download_audio_file
    active = 0
    peak = 0

    async def scenario():
        entered = asyncio.Queue()
        release = asyncio.Semaphore(0)

        async def download(*args):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            entered.put_nowait(None)
            try:
                await release.acquire()
                return await original(*args)
            finally:
                active -= 1

        pipeline.engine._download_audio_file = download
        tasks = [asyncio.create_task(pipeline.run(row['id'])) for row in (first, second)]
        try:
            for _ in range(limit):
                await asyncio.wait_for(entered.get(), 2)
            assert active == limit
            release.release()
            await asyncio.wait_for(entered.get(), 2)
            assert active == limit
            for _ in range(6):
                release.release()
            await asyncio.wait_for(asyncio.gather(*tasks), 2)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())
    assert peak == limit
    assert len(pipeline.engine.calls) == 6
    assert all(pipeline.view(row['id'], ANA)['state'] == 'completo' for row in (first, second))


def test_searches_overlap_with_bounded_capacity_and_link_hits_immediately(pipeline):
    configure_capacity(pipeline)
    request = submit(pipeline, body(16))
    original_match = pipeline.engine._resolve_source_url
    original_download = pipeline.engine._download_audio_file
    hits = {}
    for idx in range(5):
        path = pipeline.root / f'owned-{idx}.mp3'
        path.write_bytes(b'owned audio')
        hits[idx] = path
    active = peak = 0
    searched = []
    fetched = []

    async def scenario():
        nonlocal active, peak
        entered = asyncio.Queue()
        release = asyncio.Semaphore(0)

        async def search(req):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            entered.put_nowait(req.metadata.title)
            try:
                await release.acquire()
                searched.append(req.metadata.title)
                if req.metadata.title == 'Song 5':
                    return ResolvedVideo(None, 'no results', 'no-results')
                return await original_match(req)
            finally:
                active -= 1

        async def download(*args):
            fetched.append(len(searched))
            return await original_download(*args)

        pipeline.engine._resolve_source_url = search
        pipeline.engine._download_audio_file = download
        task = asyncio.create_task(pipeline.run(request['id'], hits=hits))
        try:
            for _ in range(3):
                await asyncio.wait_for(entered.get(), 2)
            assert active == 3
            assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 5
            match = [i for i in pipeline.view(request['id'], ANA)['items'] if i['stage'] == 'match']
            # Worker scheduling may admit any three missing manifest rows.
            states = [i['state'] for i in match]
            assert (states.count('done'), states.count('running'), states.count('queued')) == (5, 3, 8)
            release.release()  # a failed search frees its slot without blocking peers
            await asyncio.wait_for(entered.get(), 2)
            release.release()
            async def first_fetch():
                while not fetched:
                    await asyncio.sleep(0.001)
            await asyncio.wait_for(first_fetch(), 2)
            assert fetched[0] < 11
            assert not task.done()
            for _ in range(11):
                release.release()
            results = await asyncio.wait_for(task, 3)
            assert sum(r.success for r in results) == 15
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    assert peak == 3
    assert pipeline.view(request['id'], ANA)['state'] == 'parcial'


def test_search_capacity_is_shared_between_album_requests(pipeline):
    first = submit(pipeline, body(4))
    second = submit(pipeline, body(4).model_copy(update={'provider_id': 'other'}))
    original = pipeline.engine._resolve_source_url

    async def scenario():
        entered = asyncio.Queue()
        release = asyncio.Event()
        async def search(req):
            entered.put_nowait(None)
            await release.wait()
            return await original(req)
        pipeline.engine._resolve_source_url = search
        tasks = [asyncio.create_task(pipeline.run(row['id'])) for row in (first, second)]
        try:
            for _ in range(3):
                await asyncio.wait_for(entered.get(), 2)
            assert pipeline.search_limiter.active == 3
            assert entered.empty()
            release.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 3)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(scenario())
    assert len(pipeline.engine.calls) == 8


def test_first_fetch_timing_with_stubbed_search_latency(pipeline):
    """The first fetch starts while the other searches are still blocked."""
    configure_capacity(pipeline)
    request = submit(pipeline, body(16))
    hits = {}
    for idx in range(5):
        path = pipeline.root / f'owned-{idx}.mp3'
        path.write_bytes(b'owned audio')
        hits[idx] = path
    original_match = pipeline.engine._resolve_source_url
    original_download = pipeline.engine._download_audio_file

    async def scenario():
        entered = asyncio.Queue()
        release_first = asyncio.Event()
        release_rest = asyncio.Event()
        fetched = asyncio.Event()
        events = []
        active = peak = 0
        searches = 0
        fetches = 0

        async def search(req):
            nonlocal active, peak, searches
            first = not events
            active += 1
            peak = max(peak, active)
            events.append('search-start')
            entered.put_nowait(None)
            try:
                await (release_first if first else release_rest).wait()
                searches += 1
                events.append('search-done')
                return await original_match(req)
            finally:
                active -= 1

        async def download(*args):
            nonlocal fetches
            fetches += 1
            events.append('fetch')
            fetched.set()
            return await original_download(*args)

        pipeline.engine._resolve_source_url = search
        pipeline.engine._download_audio_file = download
        task = asyncio.create_task(pipeline.run(request['id'], hits=hits))
        try:
            # Deadlines only guard deadlocks; ordering is controlled by events.
            for _ in range(3):
                await asyncio.wait_for(entered.get(), 10)
            assert active == 3
            assert len(pipeline.user_tracks.list_for_user(ANA.user_id)) == 5
            release_first.set()
            await asyncio.wait_for(fetched.wait(), 10)
            assert searches == fetches == 1
            assert not task.done()
            release_rest.set()
            results = await asyncio.wait_for(task, 10)
            assert all(result.success for result in results)
            assert searches == fetches == 11
            assert peak == 3
            assert events.index('fetch') < len(events) - 1 - events[::-1].index('search-done')
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
