"""Consumer-driven source contracts over real child pipes, without network."""
import asyncio
import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.domains.acquisition.sources import SourceSupervisor
from app.domains.acquisition.sources.manifest import read_manifest
from app.exceptions import SourceFailure

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/source-plugin.json').read_text())
CASES = {case['name']: case for case in CONTRACT['cases']}


@pytest.fixture
def fake_source(tmp_path, config, write_audio):
    audio = tmp_path / 'fixture.m4a'
    write_audio(audio, [0.1] * 44100, 44100)
    template = Path(__file__).resolve().parents[1] / 'fixtures/source_plugin/krobi-extension.json'
    manifest = json.loads(template.read_text())
    manifest.update(id='fake', name='Fake')
    manifest['entry']['command'] = ['{python}', str(Path(__file__).resolve().parents[1] / 'fixtures/source_plugin/plugin.py')]
    path = tmp_path / 'krobi-extension.json'
    path.write_text(json.dumps(manifest))
    log = tmp_path / 'calls.jsonl'
    env = {**os.environ, 'FAKE_LOG': str(log), 'FAKE_AUDIO': str(audio)}
    source = SourceSupervisor(path, env=env, backoff=0.01)
    source.calls = lambda: [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    yield source
    source.close()


def test_manifest_refuses_before_spawn(fake_source, tmp_path):
    manifest = dict(fake_source.manifest)
    manifest['protocol'] = {'source': CASES['hello-refusal']['helloProtocols']}
    path = tmp_path / 'old.json'
    path.write_text(json.dumps(manifest))
    old = SourceSupervisor(path)
    assert old.state == 'incompatible' and not old.ready() and old.process is None
    assert not fake_source.calls()


@pytest.mark.parametrize('mutation,state', [({'name': None}, 'invalid'), ({'entry': {}}, 'invalid'),
                                            ({'protocol': {'source': [0]}}, 'incompatible'),
                                            ({'extra': True}, 'on')])
def test_manifest_validation(fake_source, tmp_path, mutation, state):
    path = tmp_path / 'manifest.json'
    path.write_text(json.dumps({**fake_source.manifest, **mutation}))
    assert read_manifest(path)[1] == state


def test_hello_refusal_precedes_search(fake_source):
    fake_source.env['FAKE_MODE'] = 'refuse'
    with pytest.raises(SourceFailure):
        asyncio.run(fake_source.search({'title': 'Song', 'artist': ''}))
    case = CASES['hello-refusal']
    assert fake_source.state == case['expectedState']
    assert any(c['method'] == 'hello' for c in fake_source.calls())
    assert any(c['method'] == 'search' for c in fake_source.calls()) == case['searchCalled']


def test_hello_accepted_once_and_process_reused(fake_source):
    async def scenario():
        assert await fake_source.test() == {'ok': True}
        assert await fake_source.search({'title': 'Song', 'artist': 'Artist'}) == [
            {'id': 'Song', 'title': 'Song', 'artist': 'Artist', 'url': 'https://example.test/Song', 'duration': 1, 'flags': []}]
        assert await fake_source.test() == {'ok': True}
    asyncio.run(scenario())
    assert fake_source.state == CASES['hello-accepted']['expectedState']
    assert len({call['pid'] for call in fake_source.calls()}) == 1
    assert sum(call['method'] == 'hello' for call in fake_source.calls()) == 1


@pytest.mark.parametrize('kind', CASES['typed-kinds']['kinds'])
def test_typed_kinds_are_not_guessed_from_message(fake_source, tmp_path, kind):
    with pytest.raises(SourceFailure) as caught:
        asyncio.run(fake_source.fetch(kind, tmp_path, deadline=2000))
    assert caught.value.kind == kind
    assert caught.value.retry_after == CASES['typed-kinds']['retryAfter']


def test_deadline_kills_all_pending_then_respawns(fake_source, tmp_path):
    async def scenario():
        await fake_source.test()
        process = fake_source.process
        first = asyncio.create_task(fake_source.fetch('hang', tmp_path, deadline=CASES['deadline-kill']['deadline']))
        second = asyncio.create_task(fake_source.fetch('hang', tmp_path, deadline=3000))
        errors = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(error, SourceFailure) and error.kind == 'broken' for error in errors)
        assert process.poll() is not None
        assert await fake_source.test() == {'ok': True}
        assert fake_source.process.pid != process.pid
    asyncio.run(scenario())


def test_crash_restarts(fake_source):
    fake_source.env['FAKE_MODE'] = 'crash'
    async def scenario():
        with pytest.raises(SourceFailure):
            await fake_source.search({'title': 'Song', 'artist': ''})
        assert await fake_source.search({'title': 'Song', 'artist': ''})
    asyncio.run(scenario())
    assert len({c['pid'] for c in fake_source.calls()}) == 2


def test_progress_and_fetch_shape(fake_source, tmp_path):
    values = []
    result = asyncio.run(fake_source.fetch('progress', tmp_path, deadline=3000, progress=values.append))
    assert values == CASES['progress']['percentages']
    assert set(CASES['fetch-result']['required']) <= result.keys()
    assert Path(result['path']).is_file()
    assert result['bytes'] > 0 and result['codec'] == 'aac' and result['transcoded'] is False


@pytest.mark.parametrize('mode', ['bad-path', 'bad-result'])
def test_invalid_result_never_crosses_port(fake_source, tmp_path, mode):
    fake_source.env['FAKE_MODE'] = mode
    directory = tmp_path / 'incoming'
    with pytest.raises(SourceFailure, match='Invalid source fetch result'):
        asyncio.run(fake_source.fetch('test', directory, deadline=3000))


def test_revision_change_restarts_extractor(fake_source):
    revision = [1]
    fake_source.revision = lambda: revision[0]
    asyncio.run(fake_source.test())
    old = fake_source.process
    revision[0] += 1
    asyncio.run(fake_source.test())
    assert old.poll() is not None and fake_source.process.pid != old.pid


def test_clean_shutdown_reaps_plugin(fake_source):
    asyncio.run(fake_source.test())
    process = fake_source.process
    fake_source.close()
    assert process.poll() is not None
    assert not any(thread.is_alive() for thread in fake_source.threads)


def test_cancel_reaps_before_return(fake_source, tmp_path):
    async def scenario():
        await fake_source.test()
        process = fake_source.process
        task = asyncio.create_task(fake_source.fetch('hang', tmp_path, deadline=30000))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert process.poll() is not None
    asyncio.run(scenario())


def test_no_sources_after_refusal(fake_source, config):
    from app.dependencies import DependencyContainer
    from app.domains.acquisition.models import AcquisitionError
    container = DependencyContainer(config)
    registry = container.get_provider_registry()
    from app.providers.registry import ProviderDescriptor, ProviderKind
    from app.providers.adapters import SourceStreamingProvider
    registry.register(ProviderDescriptor(id='youtube', name='Source', kind=ProviderKind.STREAMING, description=''), SourceStreamingProvider(fake_source))
    fake_source.env.update(FAKE_ID='youtube', FAKE_MODE='refuse')
    fake_source.id = 'youtube'
    registry.instance('youtube').source = fake_source
    try:
        with pytest.raises(AcquisitionError, match='no-sources'):
            container.get_acquisition().check_sources()
    finally:
        container.stop_sources()


@pytest.mark.parametrize('songs,expected_duration,success', [(13, 1, True), (1, 2.5, False)])
def test_real_port_album_and_validate_before_publish(fake_source, config, tmp_path, songs, expected_duration, success):
    import logging
    from types import SimpleNamespace
    from app.domains.acquisition import audio
    from app.domains.acquisition.engine import DownloadEngine
    from app.domains.acquisition.provider import DownloadRepository
    from app.domains.acquisition.services import Pipeline
    from app.domains.acquisition.request_job import RequestJob
    from app.domains.metadata.repositories import MetadataRepository
    from app.domains.user_library.store import UserTrackStore
    from app.infra.jobs import Jobs
    from tests.unit.test_acquisition import ANA, body

    root = tmp_path / 'Music'
    root.mkdir()
    config.base_music_dir = root
    config.max_concurrent_downloads = 2
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    log = logging.getLogger(__name__)
    engine = DownloadEngine(DownloadRepository(config, log, source=fake_source), MetadataRepository(config, log),
                            Mock(), None, config, log)
    ownership = Mock()
    ownership.lookup_many.side_effect = lambda tracks: [SimpleNamespace(owned=False) for _ in tracks]
    pipeline = Pipeline(ledger=ledger, engine=engine, ownership=ownership,
                        user_tracks=UserTrackStore(tmp_path / 'tracks.json'), root=root, data=tmp_path,
                        sources=lambda: ['fake'])
    request = body(songs)
    for track in request.tracks:
        track.duration_s = expected_duration
    try:
        row = pipeline.submit(request, ANA, schedule=False)
        results = asyncio.run(pipeline.run(row['id']))
        assert all(result.success is success for result in results), [r.error for r in results]
        items = ledger.items(RequestJob.find(ledger, row['id']).id)
        assert len(items) == songs
        assert all(item['detail']['provider'] == 'fake' for item in items)
        if success:
            assert all(item['stage'] == 'linked' for item in items)
            assert all(set(item['detail']['_stage_times']) == {'requested', 'matched', 'fetched', 'processed', 'imported', 'linked'} for item in items)
            assert len(list(root.rglob('*.m4a'))) == songs
            assert all(audio.validate(result.file_path, expected_duration=1, ffmpeg=config.ffmpeg_path) for result in results)
            assert len({c['pid'] for c in fake_source.calls()}) == 1
            active = peak = 0
            for call in fake_source.calls():
                if call['method'] == 'fetch':
                    active += 1
                    peak = max(peak, active)
                elif call['method'] == 'fetched':
                    active -= 1
            assert peak == 2
        else:
            assert not list(root.rglob('*'))
            assert items[0]['detail']['kind'] == 'broken'
            assert pipeline.user_tracks.list_for_user(ANA.user_id) == []
    finally:
        ledger.close()


def test_source_names_and_extractor_dicts_stay_out_of_core():
    import re
    acquisition = Path(__file__).resolve().parents[2] / 'app/domains/acquisition'
    from app.domains.acquisition.sources.known import CATALOG
    catalog_locations = [location for _, location in CATALOG.values()]
    for source in acquisition.rglob('*.py'):
        for number, line in enumerate(source.read_text(encoding='utf-8').splitlines(), 1):
            if re.search(r'\byoutube\b', line):
                relative = source.relative_to(acquisition).as_posix()
                assert relative == 'sources/compat.py' or (relative == 'sources/known.py' and
                       any(location in line for location in catalog_locations)), f'{relative}:{number}: {line}'
    matcher = (acquisition / 'matching.py').read_text()
    assert 'webpage_url' not in matcher and '.get("uploader")' not in matcher


def test_tool_switch_finishes_old_fetch_before_respawn(fake_source, tmp_path):
    revision = [1]
    fake_source.revision = lambda: revision[0]
    async def scenario():
        await fake_source.test()
        process = fake_source.process
        fetch = asyncio.create_task(fake_source.fetch('progress', tmp_path, deadline=2000))
        while not any(call['method'] == 'fetch' for call in fake_source.calls()):
            await asyncio.sleep(0.005)
        revision[0] += 1
        probe = asyncio.create_task(fake_source.test(deadline=2000))
        result, tested = await asyncio.gather(fetch, probe)
        assert result['codec'] == 'aac' and tested['ok'] is True
        assert process.poll() is not None and fake_source.process.pid != process.pid
    asyncio.run(scenario())


def test_search_fetch_uses_opaque_id_and_direct_fetch_uses_the_url(fake_source, config, tmp_path):
    from app.dependencies import DependencyContainer
    from app.domains.acquisition.provider import DownloadRepository
    from app.providers.adapters import SourceStreamingProvider
    from app.providers.registry import ProviderDescriptor, ProviderKind
    from app.domains.acquisition.models import AcquisitionError
    container = DependencyContainer(config)
    registry = container.get_provider_registry()
    registry.register(ProviderDescriptor(id='fake', name='Fake', kind=ProviderKind.STREAMING, description=''), SourceStreamingProvider(fake_source))
    repository = DownloadRepository(config, Mock(), source=container._selected_source)
    cookies = tmp_path / 'cookies.txt'
    cookies.write_text('# Netscape HTTP Cookie File\n')
    config.source_cookies_file = str(cookies)
    async def scenario():
        repository.select()
        rows = await repository.search_source('Song')
        repository.remember_candidates(rows)
        await repository.download_source_audio(rows[0]['url'], tmp_path / 'search.m4a')
        direct = 'https://example.test/audio'
        repository.select(direct)
        await repository.download_source_audio(direct, tmp_path / 'direct.m4a')
        with pytest.raises(AcquisitionError, match='no-sources'):
            repository.select('https://elsewhere.test/audio')
    asyncio.run(scenario())
    calls = [call for call in fake_source.calls() if call['method'] == 'fetch']
    assert [call['params']['id'] for call in calls] == ['Song', 'https://example.test/audio']
    assert all(call['params']['options']['cookiesFile'] == str(cookies) for call in calls)


def test_status_and_action_wrappers_send_v1_envelopes(fake_source):
    async def scenario():
        assert (await fake_source.status())['revision'] == 'one'
        assert (await fake_source.action('update'))['revision'] == 'two'
    asyncio.run(scenario())
    calls = {call['method']: call['params'] for call in fake_source.calls()}
    assert 0 < calls['action']['deadline'] <= 120_000
    assert calls['action']['id'] == 'update'
