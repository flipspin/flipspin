"""Acquisition enrichment and persisted tag precedence."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.acquisition.services import Pipeline
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, body, submit

pipeline = fixtures.pipeline


@pytest.mark.parametrize('provider,album', [('deezer', 'Album'), ('spotify', None), ('other', 'Album')])
def test_submit_enriches_metadata_before_fetch_and_persists_tags(pipeline, provider, album):
    from app.domains.metadata.genres import AlbumGenres
    lookup = Mock(spec=AlbumGenres)
    lookup.lookup.return_value = ('Latino, Pop', 2019, [])
    pipeline.metadata_lookup = lambda: lookup
    data = body().model_copy(update={'provider': provider})
    data.tracks[0].album = album
    request = submit(pipeline, data)
    tagged = []

    async def finish(path, req, phase):
        tagged.append((req.metadata.genre, req.metadata.year))

    pipeline.engine._finish_staged_file = finish
    results = asyncio.run(pipeline.run(request['id']))
    assert results[0].success
    assert tagged == [('Latino, Pop', 2019)]
    lookup.lookup.assert_called_once_with('Artist', album, 'Song 0', None)
    track = pipeline.store.work(request['id'])['body']['tracks'][0]
    assert (track['genre'], track['year']) == tagged[0]


def test_lookup_error_still_downloads(pipeline):
    from app.domains.metadata.genres import AlbumGenres
    lookup = Mock(spec=AlbumGenres)
    lookup.lookup.side_effect = RuntimeError('catalog unavailable')
    pipeline.metadata_lookup = lambda: lookup
    request = submit(pipeline)
    results = asyncio.run(pipeline.run(request['id']))
    assert results[0].success and results[0].file_path.is_file()
    assert len(pipeline.engine.calls) == 1
    assert pipeline.store.get(request['id'], ANA.user_id)['state'] == 'completo'


@pytest.mark.parametrize('genre,year,expected', [('Rock', None, ('Rock', 2019)),
                                                (None, 1999, ('Pop', 1999)),
                                                ('Jazz', 2000, ('Jazz', 2000))])
def test_stored_track_tags_are_preserved_independently(pipeline, genre, year, expected):
    import json
    lookup = Mock()
    lookup.lookup.return_value = ('Pop', 2019, [])
    pipeline.metadata_lookup = lambda: lookup
    request = submit(pipeline)
    stored = pipeline.store.work(request['id'])['body']
    stored['tracks'][0].update(genre=genre, year=year)
    with pipeline.store.transaction() as db:
        db.execute('UPDATE acquisition_work SET body=? WHERE request_id=?', (json.dumps(stored), request['id']))
    seen = []

    async def finish(path, req, phase):
        seen.append((req.metadata.genre, req.metadata.year))

    pipeline.engine._finish_staged_file = finish
    assert asyncio.run(pipeline.run(request['id']))[0].success
    assert seen == [expected]
    assert lookup.lookup.call_count == (0 if genre and year else 1)


@pytest.mark.parametrize('retry', [False, True])
def test_enriched_tags_survive_retry_or_resume_in_a_new_pipeline(pipeline, retry):
    lookup = Mock()
    lookup.lookup.return_value = ('Rock', 2001, [])
    pipeline.metadata_lookup = lambda: lookup
    original = pipeline.engine._resolve_source_url

    async def interrupted(req):
        raise OSError('fetch failed') if retry else asyncio.CancelledError()

    pipeline.engine._resolve_source_url = interrupted
    request = submit(pipeline)
    if retry:
        asyncio.run(pipeline.run(request['id']))
        pipeline.retry(request['id'], ANA, schedule=False)
    else:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(pipeline.run(request['id']))
    lookup.lookup.assert_called_once()
    pipeline.engine._resolve_source_url = original
    restarted = Pipeline(ledger=pipeline.ledger, engine=pipeline.engine, ownership=pipeline.ownership,
                         user_tracks=pipeline.user_tracks, root=pipeline.root, data=pipeline.data,
                         metadata_lookup=Mock(side_effect=AssertionError('already enriched')))
    scheduled = []
    restarted.kick = scheduled.append
    restarted.resume()
    assert scheduled == [request['id']]
    tagged = []

    async def finish(path, req, phase):
        tagged.append((req.metadata.genre, req.metadata.year))

    pipeline.engine._finish_staged_file = finish
    assert asyncio.run(restarted.run(request['id']))[0].success
    assert tagged == [('Rock', 2001)]
    restarted.metadata_lookup.assert_not_called()


def test_container_acquisition_uses_current_deezer_toggle(pipeline, config, monkeypatch):
    from app.dependencies import DependencyContainer
    from app.domains.metadata.genres import AlbumGenres
    from app.providers.registry import ProviderKind
    container = DependencyContainer(config)
    monkeypatch.setattr(config, 'base_music_dir', pipeline.root)
    for method, value in (('get_jobs', pipeline.ledger), ('get_ownership_index', pipeline.ownership),
                          ('get_user_track_store', pipeline.user_tracks), ('get_progress_tracker', None)):
        monkeypatch.setattr(container, method, lambda value=value: value)
    registry = Mock()
    repository = Mock()
    registry.instance.return_value = SimpleNamespace(repository=repository)
    monkeypatch.setattr(container, 'get_provider_registry', lambda: registry)
    service = container._acquisition_for(pipeline.engine)
    registry.order.return_value = ['deezer']
    assert isinstance(service.metadata_lookup(), AlbumGenres)
    # Disable metadata while leaving the independent streaming source enabled.
    registry.order.side_effect = lambda kind: ['youtube'] if kind == ProviderKind.STREAMING else []
    request = submit(service)
    assert asyncio.run(service.run(request['id']))[0].success
    registry.order.assert_any_call(ProviderKind.METADATA)
    repository.assert_not_called()
    assert repository.mock_calls == []


def test_catalog_enriches_once_and_retry_decodes_persisted_tags(pipeline):
    from app.domains.browse.acquisition import AcquireRequest
    from app.infra.progress import ProgressTracker
    pipeline.tracker = ProgressTracker(pipeline.ledger)
    lookup = Mock()
    lookup.lookup.return_value = ('Pop', 2020, [])
    pipeline.metadata_lookup = lambda: lookup
    original = pipeline.engine._download_audio_file

    async def fail(*args):
        raise OSError('fetch failed')

    pipeline.engine._download_audio_file = fail
    data = AcquireRequest(tracks=[{'title': 'Song', 'artistName': 'Artist', 'albumTitle': 'Album', 'isrc': 'TEST123'}])

    async def scenario():
        await pipeline.catalog(data, ANA)
        async def finished():
            while pipeline.store.list(ANA.user_id)[0]['state'] != 'fallido':
                await asyncio.sleep(0.01)
        await asyncio.wait_for(finished(), 2)

    asyncio.run(scenario())
    request = pipeline.store.list(ANA.user_id)[0]
    lookup.lookup.assert_called_once_with('Artist', 'Album', 'Song', 'TEST123')
    stored = pipeline.store.work(request['id'])['body']
    assert stored['_requests'][0]['metadata']['genre'] == 'Pop'
    assert stored['_requests'][0]['metadata']['year'] == 2020
    pipeline.engine._download_audio_file = original
    seen = []

    async def finish(path, req, phase):
        seen.append((req.metadata.genre, req.metadata.year))

    pipeline.engine._finish_staged_file = finish
    pipeline.retry(request['id'], ANA, schedule=False)
    assert asyncio.run(pipeline.run(request['id']))[0].success
    assert seen == [('Pop', 2020)]
    assert lookup.lookup.call_count == 1
