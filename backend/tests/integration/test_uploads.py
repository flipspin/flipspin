"""real WAV bytes, HTTP offsets, private dedupe, and pipeline publication."""
import asyncio
import hashlib
import io
import wave
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.domains.acquisition.upload_routes import uploads as dependency
from app.domains.acquisition.uploads import Uploads
from app.main import app
from tests.unit.test_acquisition import pipeline as acquisition_pipeline  # noqa: F401, F811
from tests.unit.test_analysis_step1 import analysis  # noqa: F401


def wav():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * 8000)
    return output.getvalue()


def manifest(content=None, name='music.wav'):
    content = wav() if content is None else content
    return {'id': name, 'sha256': hashlib.sha256(content).hexdigest(), 'name': name, 'bytes': len(content)}


@pytest.fixture
def api(acquisition_pipeline, accounts, monkeypatch):  # noqa: F811
    service = Uploads(acquisition_pipeline)
    owner, token = accounts.mint('Ana', 'owner')
    member, member_token = accounts.mint('Beto', 'member')
    app.dependency_overrides[dependency] = lambda: service
    monkeypatch.setattr(service, 'kick', lambda id: None)
    client = TestClient(app)
    client.headers['Authorization'] = f'Bearer {token}'
    yield client, service, owner.principal(), member.principal(), {'Authorization': f'Bearer {member_token}'}
    app.dependency_overrides.pop(dependency, None)


def create(client, files=None, id='batch'):
    result = client.post('/api/uploads/batches', json={'id': id, 'files': files or [manifest()]})
    assert result.status_code == 200, result.text
    return '/api/uploads/batches/' + id


def start(client, url, choice='keep-both'):
    assert client.post(url+'/start', json={'duplicates': choice}).status_code == 200


def patch(client, url, file, offset, content, **kwargs):
    return client.patch(url+'/files/'+file['sha256'], content=content, headers={'Upload-Offset': str(offset), **kwargs})


def test_check_bounds_and_household_hit_is_indistinguishable_from_success(api):
    client, service, owner, member, member_headers = api
    song = service.pipeline.root / 'Album' / 'music.wav'
    song.parent.mkdir()
    song.write_bytes(wav())
    file = manifest()
    assert client.post('/api/uploads/check', json={'files': [file]*5001}).status_code == 422
    assert client.post('/api/uploads/check', json={'files': [file]}).json()['files'][0]['state'] == 'ya-estaba'
    client.headers.update(member_headers)
    check = client.post('/api/uploads/check', json={'files': [file]}).json()
    assert check['files'][0]['state'] == 'por-subir'
    assert set(check['files'][0]) == {'id','sha256','name','bytes','offset','state','reason','duplicate','already'}
    url = create(client)
    start(client, url)
    asyncio.run(service.process('batch'))
    # A private household hit completes through link without transferring bytes.
    view = client.get(url).json()
    assert view['files'][0]['state'] == 'agregada'
    assert view['phase'] == 'terminado'
    assert len(list(service.pipeline.root.rglob('*.wav'))) == 1
    assert service.pipeline.user_tracks.get(member.user_id, 'Album/music.wav')
    request = service._query('SELECT request_id FROM upload_items')[0]['request_id']
    view = service.pipeline.view(request, member)
    assert len(set(view['stages'].values())) == 1
    assert all(item['state'] == 'done' for item in view['items'])


def test_resume_offset_checksum_restart_and_only_pipeline_import(api):
    client, service, principal, _, _ = api
    file = manifest()
    url = create(client)
    start(client, url)
    assert patch(client, url, file, 0, wav()[:100]).status_code == 204
    # The SQLite receipt survives reopening the upload service.
    recovered = Uploads(service.pipeline)
    assert recovered.head('batch', file['sha256'], principal)['offset'] == 100
    head = client.head(url+'/files/'+file['sha256'])
    assert head.headers['upload-offset'] == '100'
    assert 'upload-expires' in head.headers
    assert patch(client, url, file, 99, b'bad').status_code == 409
    assert patch(client, url, file, 100, b'bad', **{'Upload-Checksum': '0'*64}).status_code == 460
    assert list(service.pipeline.root.rglob('*.wav')) == []
    assert patch(client, url, file, 100, wav()[100:]).status_code == 204
    asyncio.run(service.process('batch'))
    assert client.get(url).json()['files'][0]['state'] == 'agregada'
    assert service.ledger.get('batch')['kind'] == 'upload'
    assert service.ledger.get('batch')['state'] == 'succeeded'
    assert [p.read_bytes() for p in service.pipeline.root.rglob('*.wav')] == [wav()]
    assert len([j for j in service.ledger.list() if j['kind'] == 'acquisition-request']) == 1
    again = create(client, id='again')
    start(client, again)
    asyncio.run(service.process('again'))
    assert client.get(again).json()['files'][0]['state'] == 'agregada'
    assert len(list(service.pipeline.root.rglob('*.wav'))) == 1


@pytest.mark.parametrize(('content','name','reason'), [(b'hello','x.txt','no-es-audio'), (b'invalid audio','x.wav','archivo-danado')])
def test_named_failures(api, content, name, reason):
    client, service, *_ = api
    file = manifest(content, name)
    url = create(client, [file])
    start(client, url)
    if name.endswith('.wav'):
        assert patch(client, url, file, 0, content).status_code == 204
    asyncio.run(service.process('batch'))
    assert client.get(url).json()['files'][0]['reason'] == reason


def test_size_disk_floor_expiry_and_cross_account(api, monkeypatch):
    client, service, principal, _, other = api
    service.max_bytes = 10
    assert client.post('/api/uploads/check', json={'files': [manifest()]}).json()['files'][0]['reason'] == 'muy-grande'
    service.max_bytes = 500*1024*1024
    url = create(client)
    assert client.get(url, headers=other).status_code == 404
    start(client, url)
    file = manifest()
    assert patch(client, url, file, 0, wav()[:100]).status_code == 204
    row = service.item('batch', file['sha256'], principal)
    part = service._part(row)
    service.ledger.now = lambda: row['updated']+86401
    service.expire()
    assert not part.exists()
    assert service.head('batch', file['sha256'], principal)['offset'] == 0
    assert service.view('batch', principal)['files'][0]['reason'] == 'fallo-subida'
    monkeypatch.setattr('app.domains.acquisition.uploads.shutil.disk_usage', lambda _: type('Disk', (), {'free': 0})())
    response = client.post('/api/uploads/batches', json={'id':'full', 'files':[manifest()]})
    assert response.status_code == 507
    assert response.json()['detail']['reason'] == 'sin-espacio'


def test_stop_preserves_imports_retry_only_failed_and_repeat_intent(api):
    client, service, principal, *_ = api
    one = manifest()
    two = manifest(wav()+b'\0\0', 'two.wav')
    url = create(client, [one, two])
    assert client.post('/api/uploads/batches', json={'id':'batch','files':[one]}).status_code == 422
    start(client, url)
    assert patch(client, url, one, 0, wav()).status_code == 204
    asyncio.run(service.process('batch'))
    assert client.post(url+'/files/'+two['sha256']+'/fail').status_code == 200
    assert service.view('batch', principal)['phase'] == 'terminado'
    response = client.post(url+'/retry')
    assert response.status_code == 200, response.text
    assert client.post(url+'/retry').status_code == 200
    assert patch(client, url, two, 0, wav()+b'\0\0').status_code == 204
    asyncio.run(service.process('batch'))
    assert service.ledger.get('batch')['succeeded'] == 2
    assert service.ledger.get('batch')['attempt'] == 2
    assert len(list(service.pipeline.root.rglob('*.wav'))) == 2
    assert client.post(url+'/stop').status_code == 200
    assert len(list(service.pipeline.root.rglob('*.wav'))) == 2


@pytest.mark.parametrize('choice', ['use-nest', 'keep-both'])
def test_recording_match_is_one_batch_decision_and_never_overwrites(api, choice):
    from types import SimpleNamespace
    client, service, principal, *_ = api
    old = service.pipeline.root / 'Album' / 'original.wav'
    old.parent.mkdir()
    old.write_bytes(wav()+b'old')
    service.pipeline.ownership.lookup_many.side_effect = lambda tracks: [SimpleNamespace(owned=True, match=SimpleNamespace(path=old)) for _ in tracks]
    file = {**manifest(), 'title': 'Song', 'artist': 'Artist', 'duration_s': 1.0}
    url = create(client, [file])
    assert client.get(url).json()['files'][0]['duplicate'] is True
    start(client, url, choice)
    assert patch(client, url, file, 0, wav()).status_code == 204
    asyncio.run(service.process('batch'))
    assert client.get(url).json()['files'][0]['state'] == 'agregada'
    assert old.read_bytes() == wav()+b'old'
    assert len(list(service.pipeline.root.rglob('*.wav'))) == (1 if choice == 'use-nest' else 2)


def test_server_rehash_refuses_a_spoofed_hash_and_retry_restarts(api):
    client, service, principal, *_ = api
    file = {**manifest(), 'sha256': '0'*64}
    url = create(client, [file])
    start(client, url)
    assert patch(client, url, file, 0, wav()).status_code == 204
    asyncio.run(service.process('batch'))
    assert client.get(url).json()['files'][0]['reason'] == 'archivo-danado'
    assert not list(service.pipeline.root.rglob('*.wav'))
    assert client.post(url+'/retry').status_code == 200
    assert service.head('batch', file['sha256'], principal)['offset'] == 0


def test_disk_is_refused_before_reading_a_chunk_and_expiry_finishes_job(api, monkeypatch):
    client, service, principal, *_ = api
    url = create(client)
    start(client, url)
    monkeypatch.setattr('app.domains.acquisition.uploads.shutil.disk_usage', lambda _: type('Disk', (), {'free': 0})())
    response = patch(client, url, manifest(), 0, b'bytes')
    assert response.status_code == 507
    assert response.json()['detail']['reason'] == 'sin-espacio'
    assert client.get(url).json()['files'][0]['reason'] == 'sin-espacio'
    assert not list(service.pipeline.incoming.rglob('*.wav'))


@pytest.mark.parametrize(('count', 'auto', 'lane'), [(40, True, 'library'), (25, True, 'new'),
                                                     (5, True, 'new'), (40, False, None)])
def test_upload_analysis_per_landing_uses_batch_total_and_refreshes_once(api, analysis, monkeypatch, count, auto, lane):  # noqa: F811
    from app.dependencies import DependencyContainer
    client, service, principal, *_ = api
    a = analysis
    monkeypatch.setattr(a.config, 'base_music_dir', service.pipeline.root)
    a.config.analysis_auto = auto
    service.pipeline.music = a.music
    invalidate = Mock()
    monkeypatch.setattr(a.music, 'invalidate_scan', invalidate)
    container = DependencyContainer(a.config)
    monkeypatch.setattr(container, 'get_analysis_service', lambda: a.service)
    seen = []
    service.pipeline.engine.completion_listeners = [container._enqueue_analysis_files, seen.append]
    monkeypatch.setattr(service.ledger, 'now', lambda: 1000.0)
    contents = [wav() + bytes([i]) for i in range(count)]
    files = [manifest(content, f'{i}.wav') for i, content in enumerate(contents)]
    url = create(client, files)
    start(client, url)
    # Each processing pass publishes one song. Reopen the service mid-batch:
    # The declared manifest size decides the lane before the rest arrive.
    for i, (file, content) in enumerate(zip(files, contents, strict=True)):
        assert patch(client, url, file, 0, content).status_code == 204
        asyncio.run(service.process('batch'))
        rows = a.service.queue.rows(('analysis',))
        assert len(rows) == (i + 1 if auto else 0)
        assert all(r['lane'] == lane and r['nest'] is True for r in rows)
        assert len(seen) == i + 1 and all(len(paths) == 1 for paths in seen)
        service.reconcile('batch', principal)
        if i < count - 1:
            invalidate.assert_not_called()
        if i == 1:
            service = Uploads(service.pipeline)
    rows = a.service.queue.rows(('analysis',))
    assert len(rows) == (count if auto else 0)
    assert all(r['lane'] == lane and r['nest'] is True for r in rows)
    assert len({path for paths in seen for path in paths}) == count
    invalidate.assert_not_called()
    # Reconciliation and replay cannot repeat the completed batch's follow-ups.
    service.reconcile('batch', principal)
    asyncio.run(service.process('batch'))
    invalidate.assert_not_called()
    assert len(seen) == count


def test_upload_total_includes_failed_files_and_duplicates_but_only_notifies_publications(api):
    client, service, principal, *_ = api
    service.pipeline.music = Mock()
    seen = Mock()
    service.pipeline.engine.completion_listeners = [seen]
    existing = service.pipeline.root / 'Album' / 'existing.wav'
    existing.parent.mkdir()
    existing.write_bytes(wav())
    contents = [wav() + bytes([i]) for i in range(3)]
    files = [manifest(content, f'{i}.wav') for i, content in enumerate(contents)]
    files += [manifest(wav(), 'existing.wav')]
    files += [manifest(b'invalid' + bytes([i]), f'bad-{i}.wav') for i in range(24)]
    url = create(client, files)
    start(client, url)
    for file, content in zip(files[:3], contents, strict=True):
        assert patch(client, url, file, 0, content).status_code == 204
    asyncio.run(service.process('batch'))
    for file in files[4:]:
        service.fail(service.item('batch', file['sha256'], principal), 'fallo-subida')
    service.reconcile('batch', principal)
    paths = [path for call in seen.call_args_list for path in call.args[0]]
    assert len(set(paths)) == 3 and existing not in paths
    assert seen.call_count == 3
    assert all(call.kwargs == {'origin': 'upload', 'batch_total': len(files)} for call in seen.call_args_list)
    service.pipeline.music.invalidate_scan.assert_not_called()


@pytest.mark.parametrize('missed_completion', [False, True])
@pytest.mark.parametrize(('count', 'auto', 'lane'), [(40, True, 'library'), (5, True, 'new'), (40, False, None)])
def test_stop_completes_only_landed_files_once(api, analysis, monkeypatch, missed_completion, count, auto, lane):  # noqa: F811
    from app.dependencies import DependencyContainer
    client, service, principal, *_ = api
    a = analysis
    monkeypatch.setattr(a.config, 'base_music_dir', service.pipeline.root)
    monkeypatch.setattr(service.ledger, 'now', lambda: 1000.0)
    a.config.analysis_auto = auto
    service.pipeline.music = a.music
    invalidate = Mock()
    monkeypatch.setattr(a.music, 'invalidate_scan', invalidate)
    container = DependencyContainer(a.config)
    monkeypatch.setattr(container, 'get_analysis_service', lambda: a.service)
    seen = []
    service.pipeline.engine.completion_listeners = [container._enqueue_analysis_files, seen.append]
    contents = [wav() + bytes([i]) for i in range(count)]
    files = [manifest(content, f'{i}.wav') for i, content in enumerate(contents)]
    url = create(client, files)
    start(client, url)
    # A crash can leave publication audits without completion receipts.
    with monkeypatch.context() as patcher:
        if missed_completion:
            patcher.setattr(service, '_complete_batch', lambda *args, **kwargs: None)
        for file, content in zip(files[:3], contents[:3], strict=True):
            assert patch(client, url, file, 0, content).status_code == 204
        asyncio.run(service.process('batch'))
    invalidate.assert_not_called()
    assert len(seen) == (0 if missed_completion else 3)
    # Stop must recover the durable publications through a fresh service.
    service = Uploads(service.pipeline)
    service.stop('batch', principal)
    rows = a.service.queue.rows(('analysis',))
    assert len(rows) == (3 if auto else 0)
    assert all(r['lane'] == lane and r['nest'] is True for r in rows)
    paths = [path for landing in seen for path in landing]
    assert len(paths) == len(set(paths)) == 3
    invalidate.assert_not_called()
    service.stop('batch', principal)
    service.reconcile('batch', principal)
    assert paths == [path for landing in seen for path in landing]
    invalidate.assert_not_called()


def test_stop_without_publications_does_not_notify_or_refresh(api):
    client, service, principal, *_ = api
    service.pipeline.music = Mock()
    seen = Mock()
    service.pipeline.engine.completion_listeners = [seen]
    url = create(client)
    start(client, url)
    service.stop('batch', principal)
    seen.assert_not_called()
    service.pipeline.music.invalidate_scan.assert_not_called()


@pytest.mark.parametrize('stop', [False, True])
def test_slow_upload_refreshes_each_request_without_trailing_full_scans(api, monkeypatch, stop):
    client, service, principal, *_ = api
    service.pipeline.music = Mock()
    clock = [1000.0]
    monkeypatch.setattr(service.ledger, 'now', lambda: clock[0])
    contents = [wav() + bytes([i]) for i in range(5)]
    files = [manifest(content, f'{i}.wav') for i, content in enumerate(contents)]
    url = create(client, files)
    start(client, url)
    for i, elapsed in enumerate((0, 180, 181, 240)):
        clock[0] = 1000 + elapsed
        assert patch(client, url, files[i], 0, contents[i]).status_code == 204
        asyncio.run(service.process('batch'))
        assert service.pipeline.music.refresh_folders.call_count == i + 1
        service.pipeline.music.invalidate_scan.assert_not_called()
        service = Uploads(service.pipeline)
    if stop:
        # Each publication was refreshed before the request finished.
        service.stop('batch', principal)
        assert service.pipeline.music.refresh_folders.call_count == 4
    else:
        clock[0] = 1241
        assert patch(client, url, files[4], 0, contents[4]).status_code == 204
        asyncio.run(service.process('batch'))
        assert service.view('batch', principal)['phase'] == 'terminado'
        assert service.pipeline.music.refresh_folders.call_count == 5
        service = Uploads(service.pipeline)
        clock[0] = 1299
        service.expire()
        assert service.pipeline.music.refresh_folders.call_count == 5
        clock[0] = 1300
        service.expire()
        assert service.pipeline.music.refresh_folders.call_count == 5
        service.expire()
        assert service.pipeline.music.refresh_folders.call_count == 5
    service.pipeline.music.invalidate_scan.assert_not_called()


def tagged_wav(*, title='Song', artist='Artist', album='Album'):
    from mutagen.id3 import TALB, TIT2, TPE1
    from mutagen.wave import WAVE
    output = io.BytesIO(wav())
    audio = WAVE(output)
    audio.add_tags()
    for frame, text in ((TIT2, title), (TPE1, artist), (TALB, album)):
        audio.tags.add(frame(encoding=3, text=[text]))
    audio.save(output)
    return output.getvalue()


@pytest.mark.parametrize(('content', 'name', 'folder'), [
    (tagged_wav(), 'music.wav', 'Artist/Album'),
    (tagged_wav(artist='Art/ist:?', album='Al/bum:?'), 'music.wav', 'Artist/Album'),
    (wav(), 'music.wav', 'Unknown Artist/Unknown Album'),
    (wav(), 'Source Album/music.wav', 'Unknown Artist/Source Album'),
    (wav(), r'Source Album\music.wav', 'Unknown Artist/Source Album'),
], ids=['tags', 'clean-tags', 'unknown', 'source-folder', 'windows-source-folder'])
def test_upload_files_by_tags_or_source_folder(api, content, name, folder):
    from app.utils.library_paths import rel_path_for
    client, service, principal, *_ = api
    # Manifest hints must not override the audio's real tags (or their absence).
    file = {**manifest(content, name), 'artist': 'Manifest artist', 'title': 'Hint'}
    url = create(client, [file])
    start(client, url)
    assert patch(client, url, file, 0, content).status_code == 204
    asyncio.run(service.process('batch'))
    final = service.pipeline.root / folder / 'music.wav'
    assert client.get(url).json()['files'][0]['state'] == 'agregada'
    assert final.read_bytes() == content
    rel = folder.replace('/', '∕') + '/music.wav'
    assert rel_path_for(service.pipeline.root, final) == rel
    assert service.pipeline.user_tracks.get(principal.user_id, rel)
    assert not (service.pipeline.root / 'Uploads').exists()
    assert service.item('batch', file['sha256'], principal)['sha256'] == file['sha256']


def test_upload_collision_suffix_preserves_both_files_and_sha_dedupes(api):
    client, service, principal, *_ = api
    first, second = tagged_wav(), tagged_wav(title='Other song')
    for batch, content in (('first', first), ('second', second)):
        file = manifest(content)
        url = create(client, [file], id=batch)
        start(client, url)
        assert patch(client, url, file, 0, content).status_code == 204
        asyncio.run(service.process(batch))
        assert client.get(url).json()['files'][0]['state'] == 'agregada'
    album = service.pipeline.root / 'Artist' / 'Album'
    assert (album / 'music.wav').read_bytes() == first
    assert (album / 'music (2).wav').read_bytes() == second
    assert service.item('second', manifest(second)['sha256'], principal)['published_path'] == str(album / 'music (2).wav')
    url = create(client, [manifest(second)], id='again')
    start(client, url)
    asyncio.run(service.process('again'))
    assert client.get(url).json()['files'][0]['state'] == 'agregada'
    assert sorted(p.name for p in album.iterdir()) == ['music (2).wav', 'music.wav']
    assert not service.pipeline.recycle.exists()


@pytest.mark.parametrize('crash_at', ['before-publication', 'after-publication', 'after-import', 'after-request'])
def test_upload_crash_replays_actual_suffixed_path_and_followups(api, monkeypatch, crash_at):
    from app.domains.acquisition import services
    from app.domains.music import writer
    client, service, principal, *_ = api
    content = tagged_wav()
    album = service.pipeline.root / 'Artist' / 'Album'
    album.mkdir(parents=True)
    original = album / 'music.wav'
    original.write_bytes(b'original bytes')
    service.pipeline.music = Mock()
    seen = []
    service.pipeline.engine.completion_listeners = [seen.append]
    file = manifest(content)
    url = create(client, [file])
    start(client, url)
    assert patch(client, url, file, 0, content).status_code == 204

    class Crash(BaseException):
        pass

    with monkeypatch.context() as patcher:
        if crash_at in ('before-publication', 'after-publication'):
            link = writer.os.link
            def interrupted(source, destination):
                if crash_at == 'after-publication':
                    link(source, destination)
                raise Crash()
            patcher.setattr(writer.os, 'link', interrupted)
        elif crash_at == 'after-import':
            publish = services.import_file
            def interrupted(*args, **kwargs):
                publish(*args, **kwargs)
                raise Crash()
            patcher.setattr(services, 'import_file', interrupted)
        else:
            run = service.pipeline.run
            async def interrupted(*args, **kwargs):
                await run(*args, **kwargs)
                raise Crash()
            patcher.setattr(service.pipeline, 'run', interrupted)
        with pytest.raises(Crash):
            asyncio.run(service.process('batch'))
    row = service.item('batch', file['sha256'], principal)
    final = album / 'music (2).wav'
    assert row['state'] == 'importando'
    assert row['published_path'] == str(final)
    assert seen == []
    recovered = Uploads(service.pipeline)
    asyncio.run(recovered.process('batch'))
    assert recovered.view('batch', principal)['phase'] == 'terminado'
    assert recovered.item('batch', file['sha256'], principal)['state'] == 'agregada'
    assert final.read_bytes() == content and original.read_bytes() == b'original bytes'
    assert len(list(album.glob('*.wav'))) == 2
    assert recovered.pipeline.user_tracks.get(principal.user_id, 'Artist∕Album/music (2).wav')
    assert seen == [[final]]
    recovered.pipeline.music.invalidate_scan.assert_not_called()
    asyncio.run(recovered.process('batch'))
    assert seen == [[final]]


@pytest.mark.parametrize('member', [False, True])
def test_upload_space_matches_pipeline_guard_for_owner_and_member(api, monkeypatch, member):
    from app.domains.acquisition.models import AcquisitionError
    client, service, _, _, member_headers = api
    if member:
        client.headers.update(member_headers)
    service.pipeline.floor_bytes = 987654
    for free in (0, service.pipeline.floor_bytes - 1, service.pipeline.floor_bytes, 123456789):
        disk = Mock(free=free)
        usage = Mock(return_value=disk)
        monkeypatch.setattr('app.domains.acquisition.services.shutil.disk_usage', usage)
        response = client.get('/api/uploads/space')
        assert response.status_code == 200
        assert response.json() == {'freeBytes': free, 'floorBytes': service.pipeline.floor_bytes}
        if free < service.pipeline.floor_bytes:
            with pytest.raises(AcquisitionError, match='sin-espacio'):
                service.pipeline.check_space()
        else:
            service.pipeline.check_space()
        assert usage.call_count == 2
        usage.assert_called_with(service.pipeline.data)
    client.headers.pop('Authorization')
    # Synthetic loopback authority cannot use account upload routes.
    assert client.get('/api/uploads/space').status_code == 409


@pytest.mark.parametrize('same_bytes', [False, True])
def test_upload_writer_handles_a_file_appearing_during_publication(api, monkeypatch, same_bytes):
    from app.domains.music import writer
    client, service, principal, *_ = api
    content = tagged_wav()
    file = manifest(content)
    service.pipeline.music = Mock()
    seen = []
    service.pipeline.engine.completion_listeners = [seen.append]
    url = create(client, [file])
    start(client, url)
    assert patch(client, url, file, 0, content).status_code == 204
    link = writer.os.link
    existing_bytes = content if same_bytes else b'concurrent arrival'
    arrivals = []
    def arrive(source, final):
        if not arrivals:
            final.write_bytes(existing_bytes)
            arrivals.append(final)
        link(source, final)
    monkeypatch.setattr(writer.os, 'link', arrive)
    asyncio.run(service.process('batch'))
    assert client.get(url).json()['files'][0]['state'] == 'agregada'
    album = service.pipeline.root / 'Artist' / 'Album'
    assert (album / 'music.wav').read_bytes() == existing_bytes
    if same_bytes:
        assert list(album.glob('*.wav')) == [album / 'music.wav']
        assert seen == []
        service.pipeline.music.invalidate_scan.assert_not_called()
    else:
        assert (album / 'music (2).wav').read_bytes() == content
        assert seen == [[album / 'music (2).wav']]
    assert service.pipeline.user_tracks.get(principal.user_id, 'Artist∕Album/music.wav' if same_bytes else 'Artist∕Album/music (2).wav')


def test_published_date_uses_upload_receipt_before_chunks_and_import(api):
    import logging
    from types import SimpleNamespace
    from app.domains.music.repositories import MusicRepository
    client, service, principal, _, _ = api
    config = SimpleNamespace(base_music_dir=service.pipeline.root, jobs_file=service.ledger.path,
                             analysis_db=service.pipeline.data / 'analysis.sqlite')
    music = MusicRepository(config, logging.getLogger('test'))
    service.pipeline.music = music
    clock = [1234567890.5]
    service.ledger.now = lambda: clock[0]
    file = manifest()
    url = create(client)
    start(client, url)
    clock[0] += 100
    assert patch(client, url, file, 0, wav()).status_code == 204
    clock[0] += 100
    asyncio.run(service.process('batch'))
    row = service.item('batch', file['sha256'], principal)
    final = next(service.pipeline.root.rglob('*.wav'))
    assert row['received_at'] == 1234567890.5 and row['updated'] > row['received_at']
    assert music.first_seen.get(final) == row['received_at']
