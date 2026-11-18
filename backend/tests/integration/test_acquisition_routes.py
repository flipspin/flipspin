"""HTTP checks for scoped intents and exact idempotency replay."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from app.domains.acquisition.routes import pipeline as pipeline_dependency
from app.main import app
from tests.unit import test_acquisition as helpers

acquisition_pipeline = helpers.pipeline
body = helpers.body


@pytest.fixture
def api(acquisition_pipeline, accounts, monkeypatch):
    pipeline = acquisition_pipeline
    owner, token = accounts.mint('Ana', 'owner')
    _, other = accounts.mint('Beto', 'owner')
    app.dependency_overrides[pipeline_dependency] = lambda: pipeline
    monkeypatch.setattr(pipeline, 'kick', lambda id: None)
    client = TestClient(app)
    client.headers['Authorization'] = f'Bearer {token}'
    yield client, {'Authorization': f'Bearer {other}'}, owner.principal()
    app.dependency_overrides.pop(pipeline_dependency, None)


def test_check_1_http_repeat_returns_original_body_and_changed_body_422(api, acquisition_pipeline):
    pipeline = acquisition_pipeline
    client, _, principal = api
    url = '/api/acquisition/requests'
    first = client.post(url, json=body().model_dump(), headers={'Idempotency-Key': 'stable'})
    assert first.status_code == 200
    asyncio.run(pipeline.run(first.json()['id']))
    repeated = client.post(url, json=body().model_dump(), headers={'Idempotency-Key': 'stable'})
    assert repeated.status_code == first.status_code
    assert repeated.content == first.content
    changed = body().model_dump()
    changed['title'] = 'Other song'
    assert client.post(url, json=changed, headers={'Idempotency-Key': 'stable'}).status_code == 422
    assert client.get(url).json()['requests'][0]['state'] == 'completo'


@pytest.mark.parametrize('deezer_enabled', [False, True])
def test_http_acquisition_writes_album_genre_and_year(api, acquisition_pipeline, config, write_audio, deezer_enabled):
    import logging
    from unittest.mock import Mock
    from mutagen.id3 import ID3
    from app.domains.acquisition.engine import DownloadEngine
    from app.domains.metadata.genres import AlbumGenres
    from app.domains.metadata.repositories import MetadataRepository

    client, _, _ = api
    pipeline = acquisition_pipeline
    source = config.temp_dir / 'source.mp3'
    write_audio(source, [0] * 4410, 44100)
    original = pipeline.engine._download_audio_file

    async def download(*args):
        path = await original(*args)
        path.write_bytes(source.read_bytes())
        return path

    # Only the audio transfer is faked; production finishing writes real ID3.
    engine = DownloadEngine(download_repo=Mock(), metadata_repo=MetadataRepository(config, logging.getLogger(__name__)),
                            genius_repo=None, progress_tracker=None, config=config, logger=logging.getLogger(__name__))
    pipeline.engine._download_audio_file = download
    pipeline.engine._finish_staged_file = engine._finish_staged_file
    lookup = Mock(spec=AlbumGenres)
    lookup.lookup.return_value = ('Latino, Pop', 2019, [])
    pipeline.metadata_lookup = lambda: lookup if deezer_enabled else None
    response = client.post('/api/acquisition/requests', json=body().model_dump())
    assert response.status_code == 200
    result = asyncio.run(pipeline.run(response.json()['id']))[0]
    assert result.success and result.file_path.is_relative_to(pipeline.root)
    tags = ID3(result.file_path)
    assert tags['TPE1'].text == ['Artist']
    assert tags['TALB'].text == ['Album']
    if deezer_enabled:
        assert tags['TCON'].text == ['Latino, Pop']
        assert str(tags['TDRC'].text[0]) == '2019'
        lookup.lookup.assert_called_once()
    else:
        assert 'TCON' not in tags and 'TDRC' not in tags
        lookup.lookup.assert_not_called()


def test_check_6_http_other_account_is_404_on_every_action(api):
    client, other, _ = api
    first = client.post('/api/acquisition/requests', json=body().model_dump()).json()
    url = f"/api/acquisition/requests/{first['id']}"
    assert client.get(url, headers=other).status_code == 404
    assert client.post(url+'/cancel', headers=other).status_code == 404
    assert client.post(url+'/retry', headers=other).status_code == 404
    assert client.get('/api/acquisition/requests', headers=other).json() == {'requests': []}
    assert client.post(url+'/cancel').json()['state'] == 'rechazado'


def test_sentinel_http_is_typed_409(api):
    client, _, _ = api
    client.headers.pop('Authorization')
    response = client.post('/api/acquisition/requests', json=body().model_dump())
    assert response.status_code == 409
    assert response.json() == {'detail': {'reason': 'sign-in-required'}}


def test_clear_hides_only_own_finished_requests_and_is_idempotent(api, acquisition_pipeline):
    client, other, principal = api
    store = acquisition_pipeline.store
    ledger = acquisition_pipeline.ledger
    url = '/api/acquisition/requests'
    finished = ('completo', 'parcial', 'fallido', 'rechazado')
    opened = ('pending', 'approved', 'fetching', 'importing')

    def create(state, headers=None):
        data = body().model_dump()
        data['provider_id'] = state
        response = client.post(url, json=data, headers=headers)
        assert response.status_code == 200
        id = response.json()['id']
        with ledger.lock, ledger.db:
            ledger.db.execute('UPDATE acquisition_requests SET state=? WHERE id=?', (state, id))
        return id

    own_finished = {create(state) for state in finished}
    own_open = {create(state) for state in opened}
    other_ids = {create(state, other) for state in (*finished, *opened)}
    version = ledger.version
    ledger.now = lambda: 1234.0
    response = client.post(url+'/clear')
    assert response.status_code == 200
    assert response.json() == {'cleared': len(finished)}
    assert ledger.version == version + 1
    assert {row['id'] for row in client.get(url).json()['requests']} == own_open
    for id in own_finished:
        response = client.get(f'{url}/{id}')
        assert response.status_code == 200
        assert response.json()['dismissed_at'] == 1234.0
    assert all(store.get(id, principal.user_id)['dismissed_at'] is None for id in own_open)
    others = client.get(url, headers=other).json()['requests']
    assert {row['id'] for row in others} == other_ids
    assert all(row['dismissed_at'] is None for row in others)
    assert client.post(url+'/clear').json() == {'cleared': 0}
    assert ledger.version == version + 1


def test_clear_sentinel_is_typed_409(api):
    client, _, _ = api
    client.headers.pop('Authorization')
    response = client.post('/api/acquisition/requests/clear')
    assert response.status_code == 409
    assert response.json() == {'detail': {'reason': 'sign-in-required'}}


@pytest.mark.parametrize('state', ['fallido', 'parcial'])
def test_retry_reopens_a_dismissed_request(api, acquisition_pipeline, state):
    client, _, principal = api
    url = '/api/acquisition/requests'
    id = client.post(url, json=body().model_dump()).json()['id']
    store = acquisition_pipeline.store
    store.state(id, 'fetching')
    store.state(id, 'importing')
    store.state(id, state)
    assert client.post(url+'/clear').json() == {'cleared': 1}
    assert client.get(url).json() == {'requests': []}
    response = client.post(f'{url}/{id}/retry')
    assert response.status_code == 200
    assert response.json()['state'] == 'approved'
    assert response.json()['dismissed_at'] is None
    assert [row['id'] for row in client.get(url).json()['requests']] == [id]
    assert store.get(id, principal.user_id)['dismissed_at'] is None


@pytest.mark.parametrize('path', [
    '/api/browse/acquire', '/api/download-album-song', '/api/download-single-song',
    '/api/download-youtube-url', '/api/download-search', '/api/download-spotify-playlist',
    '/api/import-playlist-url', '/api/downloads/retry', '/api/download',
    '/api/playlists/spotify-export/import', '/api/refresh-playlist/Collection',
])
def test_d5_every_real_legacy_door_refuses_sentinels(api, path):
    client, _, _ = api
    client.headers.pop('Authorization')
    # These exercise the real service dependency, without the old fixtures'
    # download-service overrides; no bytes or progress records may be created.
    response = client.post(path, json={})
    assert response.status_code == 409, response.text
    assert response.json() == {'detail': {'reason': 'sign-in-required'}}


def test_legacy_disk_floor_is_refused_before_background_progress(api, monkeypatch):
    from app.domains.acquisition.models import AcquisitionError
    from app.domains.acquisition.services import Pipeline
    def full(self):
        raise AcquisitionError('sin-espacio', 507)
    monkeypatch.setattr(Pipeline, 'check_space', full)
    client, _, _ = api
    response = client.post('/api/download-spotify-playlist', json={'tracks': [{'title': 'Song', 'artist': 'Artist'}]})
    assert response.status_code == 507
    assert response.json() == {'detail': {'reason': 'sin-espacio'}}
    assert app.state.container.get_jobs().list() == []


def test_clear_one_finished_request_is_scoped_and_idempotent(api, acquisition_pipeline):
    client, other, _ = api
    url = '/api/acquisition/requests'
    first = client.post(url, json=body().model_dump()).json()['id']
    second_body = body().model_dump()
    second_body['provider_id'] = 'second'
    second = client.post(url, json=second_body).json()['id']
    route = f'{url}/{first}/clear'
    assert client.post(route).status_code == 409
    assert client.post(route, headers=other).status_code == 404
    asyncio.run(acquisition_pipeline.run(first))
    assert client.post(route).json() == {'cleared': 1}
    assert client.post(route).json() == {'cleared': 0}
    assert [r['id'] for r in client.get(url).json()['requests']] == [second]


def test_live_manifest_percent_and_partial_link_receipts(api, acquisition_pipeline):
    client, _, _ = api
    pipeline = acquisition_pipeline
    data = body(2).model_dump()
    for index, track in enumerate(data['tracks']):
        track.update(title='Repeated title', provider_id=f'track-{index}', duration_s=200)
    id = client.post('/api/acquisition/requests', json=data).json()['id']
    route = f'/api/acquisition/requests/{id}'
    expected = [{key: track[key] for key in ('title', 'artist', 'album', 'provider_id', 'track_number', 'duration_s')} for track in data['tracks']]
    assert client.get(route).json()['tracks'] == expected
    original = pipeline.engine._download_audio_file
    observed = []
    tick = [0.0]
    pipeline.tracker.now = lambda: tick[0]
    first_finished = asyncio.Event()
    original_match = pipeline.engine._resolve_source_url

    async def match(request):
        # Keep the second fetch queued while inspecting the first song's progress.
        if request.metadata.track_number == 2:
            await first_finished.wait()
        return await original_match(request)

    pipeline.engine._resolve_source_url = match

    async def download(url, destination, filename, percent_cb=None):
        assert percent_cb is not None
        if filename.startswith('01'):
            try:
                for value in (23, 68):
                    tick[0] += 0.25
                    percent_cb(value)
                    live = client.get(route).json()
                    assert live['state'] == 'fetching'
                    assert live['tracks'] == expected
                    fetching = {item['detail']['index']: item for item in live['items'] if item['stage'] == 'fetch'}
                    assert fetching[0]['state'] == 'running'
                    assert fetching[0]['detail']['percent'] == value
                    assert fetching[1]['state'] == 'queued'
                    assert '_path' not in fetching[0]['detail']
                    observed.append(value)
            finally:
                first_finished.set()
            raise OSError('source refused')
        return await original(url, destination, filename, percent_cb)

    pipeline.engine._download_audio_file = download
    asyncio.run(pipeline.run(id))
    result = client.get(route).json()
    assert observed == [23, 68]
    assert (result['state'], result['imported_tracks'], result['expected_tracks']) == ('parcial', 1, 2)
    assert result['tracks'] == expected
    failed = next(item for item in result['items'] if item['stage'] == 'fetch' and item['state'] == 'failed')
    assert failed['detail']['index'] == 0
    assert failed['detail']['kind'] == 'network'
    assert 'diagnostic' not in failed['detail']
    stored = pipeline.ledger.items(result['stages']['fetch'])
    assert next(item for item in stored if item['state'] == 'failed')['detail']['_diagnostic']['raw'] == 'source refused'
    links = [item for item in result['items'] if item['stage'] == 'link']
    assert len(links) == 2
    failed_link, added = sorted(links, key=lambda item: item['detail']['index'])
    assert failed_link['state'] == 'failed'
    assert failed_link['reason'] == 'fallo-descarga'
    assert added['detail']['index'] == 1
    assert added['state'] == 'done'
    assert added['detail']['rel_path'].startswith('Album/')
    assert all(not key.startswith('_') for item in result['items'] for key in item['detail'])


@pytest.mark.parametrize('manual', [False, True])
def test_item_retry_is_additive_scoped_and_validated(api, acquisition_pipeline, manual):
    from app.domains.downloads.core import ResolvedVideo
    client, other, _ = api
    id = client.post('/api/acquisition/requests', json=body(2).model_dump()).json()['id']
    original = acquisition_pipeline.engine._resolve_source_url
    async def absent(req):
        return ResolvedVideo(None, 'no results', 'no-results')
    acquisition_pipeline.engine._resolve_source_url = absent
    asyncio.run(acquisition_pipeline.run(id))
    route = f'/api/acquisition/requests/{id}/retry'
    selection = {'index': 1, **({'youtube_url': 'https://www.youtube.com/watch?v=chosen'} if manual else {})}
    assert client.post(route, json=selection, headers=other).status_code == 404
    assert client.post(route, json={**selection, 'index': -1}).status_code == 422
    assert client.post(route, json={**selection, 'index': 2}).status_code == 409
    for url in ('file:///etc/passwd', 'https://youtube.com.attacker.test/watch?v=x'):
        assert client.post(route, json={**selection, 'youtube_url': url}).status_code == 422
    response = client.post(route, json=selection)
    assert response.status_code == 200
    assert response.json()['id'] == id
    acquisition_pipeline.engine._resolve_source_url = original
    asyncio.run(acquisition_pipeline.run(id))
    view = client.get(f'/api/acquisition/requests/{id}').json()
    assert view['imported_tracks'] == 1
    assert len(acquisition_pipeline.engine.calls) == 1
    assert client.post(route, json=selection).status_code == 409
    assert client.post(route).status_code == 200  # old no-body callers still work


def test_http_acquisition_writes_identity_and_full_size_embedded_cover(api, acquisition_pipeline, config, write_audio):
    import logging
    import struct
    import subprocess
    from unittest.mock import Mock
    from mutagen.id3 import ID3
    from app.domains.acquisition.engine import DownloadEngine
    from app.domains.metadata.repositories import MetadataRepository

    client, _, _ = api
    pipeline = acquisition_pipeline
    source = config.temp_dir / 'source.mp3'
    write_audio(source, [0] * 4410, 44100)
    cover = config.temp_dir / 'cover.jpg'
    subprocess.run([config.ffmpeg_path, '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
                    '-i', 'color=c=blue:s=1000x1000:d=0.1', '-frames:v', '1', str(cover)],
                   capture_output=True, check=True, timeout=30)
    original = pipeline.engine._download_audio_file

    async def download(*args):
        path = await original(*args)
        path.write_bytes(source.read_bytes())
        return path

    url = 'https://cdn-images.dzcdn.net/images/cover/abc123/500x500-000000-80-0-0.jpg'
    genius = Mock()

    def download_cover(requested, destination):
        assert requested == url.replace('500x500', '1000x1000')
        destination.write_bytes(cover.read_bytes())

    genius.download_cover_art.side_effect = download_cover
    engine = DownloadEngine(download_repo=Mock(), metadata_repo=MetadataRepository(config, logging.getLogger(__name__)),
                            genius_repo=genius, progress_tracker=None, config=config, logger=logging.getLogger(__name__))
    pipeline.engine._download_audio_file = download
    pipeline.engine._finish_staged_file = engine._finish_staged_file
    data = body().model_dump()
    data['tracks'][0].update(isrc='USAAA2400001', album_artist='Album Artist', track_total=12,
                             disc_number=2, disc_total=2, compilation=True, cover_url=url,
                             recording_mbid='11111111-1111-4111-8111-111111111111',
                             release_mbid='22222222-2222-4222-8222-222222222222')
    response = client.post('/api/acquisition/requests', json=data)
    assert response.status_code == 200
    result = asyncio.run(pipeline.run(response.json()['id']))[0]
    assert result.success
    tags = ID3(result.file_path)
    assert tags['TSRC'].text == ['USAAA2400001']
    assert tags['TPE2'].text == ['Album Artist']
    assert tags['TRCK'].text == ['1/12']
    assert tags['TPOS'].text == ['2/2']
    assert tags['TCMP'].text == ['1']
    assert tags['UFID:http://musicbrainz.org'].data == data['tracks'][0]['recording_mbid'].encode()
    assert tags['TXXX:MusicBrainz Album Id'].text == [data['tracks'][0]['release_mbid']]
    embedded = tags.getall('APIC')[0].data
    assert embedded == cover.read_bytes()
    # Decode bytes read back from the imported file, then inspect PNG IHDR.
    decoded = subprocess.run([config.ffmpeg_path, '-v', 'error', '-i', 'pipe:0', '-frames:v', '1',
                              '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
                             input=embedded, capture_output=True, check=True, timeout=30).stdout
    assert struct.unpack('>II', decoded[16:24]) == (1000, 1000)
    genius.download_cover_art.assert_called_once()


def test_no_sources_returns_409_without_affecting_other_routes(api, acquisition_pipeline):
    client, _, _ = api
    acquisition_pipeline.sources = lambda: []
    response = client.post('/api/acquisition/requests', json=body().model_dump())
    assert response.status_code == 409
    assert response.json() == {'code': 'no-sources'}
    assert client.get('/api/acquisition/requests').json() == {'requests': []}
    assert client.get('/api/providers').status_code == 200
    assert acquisition_pipeline.engine.calls == []


def test_old_and_new_jobs_project_the_same_completed_five_stage_view(api, acquisition_pipeline):
    client, _, principal = api
    service = acquisition_pipeline
    fresh = client.post('/api/acquisition/requests', json=body(2).model_dump()).json()
    results = asyncio.run(service.run(fresh['id']))
    new = client.get(f"/api/acquisition/requests/{fresh['id']}").json()
    old_body = body(2).model_copy(update={'provider_id': 'old-record'})
    old = service.submit(old_body, principal, schedule=False)
    with service.ledger.db:
        service.ledger.db.execute('DELETE FROM jobs WHERE id=?', (old['id'],))
    requests = service._requests(service.store.work(old['id'])['body'])
    for stage in ('request', 'match', 'fetch', 'import', 'link'):
        job = service._stage(old['id'], stage, requests, principal, share=False)
        for idx, result in enumerate(results):
            detail = {'decision': 'STRONG', 'reason': 'same recording'} if stage == 'match' else {'audio_format': {}} if stage == 'import' else {'rel_path': f'Album/{result.file_path.name}'} if stage == 'link' else {}
            service._done(job, idx, detail=detail)
        service.ledger.finish(job, 1)
    service.store.state(old['id'], 'fetching')
    service.store.state(old['id'], 'importing')
    service.store.state(old['id'], 'completo', imported=2)
    legacy = client.get(f"/api/acquisition/requests/{old['id']}").json()
    assert set(new['stages']) == set(legacy['stages']) == {'request', 'match', 'fetch', 'import', 'link'}
    assert len(set(new['stages'].values())) == 1
    assert len(set(legacy['stages'].values())) == 5
    assert all(isinstance(item['stageAt'], float) for item in new['items'])
    assert all('stageAt' not in item for item in legacy['items'])
    sort = lambda rows: sorted(rows, key=lambda item: (item['stage'], item['idx']))
    assert sort([{k: v for k, v in item.items() if k != 'stageAt'} for item in new['items']]) == sort(legacy['items'])
