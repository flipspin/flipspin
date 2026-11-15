"""Analysis uses the shipped helper API, identity gates and acquisition listener."""
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer
from app.infra.jobs_runtime import boot
from app.main import app

FRAME = (b'\xff\xfb\x90\x00' + b'\x00' * 413) * 40
CLAIM = {'kinds': ['analysis'], 'name': 'Helper', 'version': '0.10.0', 'sessionId': 'session',
         'capabilities': {'os': 'linux', 'accel': 'cpu', 'memoryBytes': 1, 'labels': ['analysis>=2']}}


@pytest.fixture
def house(config, monkeypatch):
    config.lyrics_engine_mode = 'agent'
    config.instance_file = config.playlist_dir.parent / 'instance.json'
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, 'container', container)
    monkeypatch.setattr(app.state, 'config', config)
    tokens = container.get_token_store()
    owner, token = tokens.mint('Owner', 'owner')
    member, member_token = tokens.mint('Member', 'member')
    admin = TestClient(app, headers={'Authorization': f'Bearer {token}'})
    response = admin.post('/api/me/devices', json={'label': 'Helper', 'helper': True})
    assert response.status_code == 201, response.text
    helper = TestClient(app, headers={'Authorization': f"Bearer {response.json()['token']}"})
    container.get_music_repository().refresh()
    path = config.base_music_dir / 'Album/song.mp3'
    path.parent.mkdir(); path.write_bytes(FRAME)
    service = container.get_analysis_service()
    yield SimpleNamespace(admin=admin, member=TestClient(app, headers={'Authorization': f'Bearer {member_token}'}),
                          member_id=member.user_id, helper=helper, path=path, service=service, container=container)
    service.stop()
    container.get_jobs().close()


def result_item(item):
    return {**{k: item[k] for k in ('relPath', 'size', 'mtimeNs')}, 'engine': 'keyfinder+tempocnn',
            'engineVersion': 2, 'key': '5A', 'keyConf': .9, 'bpm': 123.4, 'bpmConf': .9,
            'energy': .06, 'brightness': .25, 'pulse': 1.6}


def test_loudness_rejections_are_final_per_item_over_http(house):
    h = house
    invalid = [
        ('trackLufs', -70.001), ('trackLufs', .001), ('trackLufs', 'NaN'),
        ('trackLufs', 'Infinity'), ('trackLufs', '-Infinity'),
        ('truePeak', -.001), ('truePeak', 8.001), ('truePeak', 'NaN'),
        ('truePeak', 'Infinity'), ('truePeak', '-Infinity'),
    ]
    for index in range(len(invalid)):
        h.path.with_name(f'bad-{index:02}.mp3').write_bytes(FRAME)
    h.service.scan()
    claimed = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    inputs = {item['relPath']: item for item in claimed['job']['input']['items']}
    items = [{**result_item(inputs[f'Album/bad-{i:02}.mp3']), field: value}
             for i, (field, value) in enumerate(invalid)]
    items.append({**result_item(inputs['Album/song.mp3']), 'trackLufs': -70, 'truePeak': 0})
    url = f"/api/helpers/jobs/{claimed['job']['id']}/result"
    payload = {'lease': claimed['lease'], 'items': items}
    response = h.helper.post(url, json=payload)
    assert response.status_code == 200
    assert [item['status'] for item in response.json()['items']] == [422] * len(invalid) + [200]
    rows = h.service.queue.rows(('analysis',))
    assert all(row['status'] == 'failed' and row['attempts'] == 1 for row in rows if 'bad-' in row['relPath'])
    for i in range(len(invalid)):
        row = h.service.repository.get(f'Album/bad-{i:02}.mp3')
        assert row['error'] == 'invalid-result' and row['track_lufs'] is None and row['true_peak'] is None
    assert h.helper.post('/api/helpers/claim', json=CLAIM).status_code == 204
    assert h.helper.post(url, json=payload).json() == response.json()


@pytest.mark.parametrize('lufs,peak', [(-70, 0), (0, 8)])
def test_loudness_bounds_are_inclusive(house, lufs, peak):
    h = house
    h.service.scan()
    claimed = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    item = {**result_item(claimed['job']['input']['items'][0]), 'trackLufs': lufs, 'truePeak': peak}
    response = h.helper.post(f"/api/helpers/jobs/{claimed['job']['id']}/result",
                             json={'lease': claimed['lease'], 'items': [item]})
    assert response.status_code == 200 and response.json()['items'][0]['status'] == 200
    row = h.service.repository.get('Album/song.mp3')
    assert (row['track_lufs'], row['true_peak']) == (lufs, peak)


@pytest.mark.parametrize("accel", ["cpu", "cuda", "mlx"])
def test_claim_result_status_codes_scope_and_listing(house, accel):
    h = house
    assert h.admin.get('/api/listar-albums-con-metadata?covers=false').status_code == 200
    assert h.admin.get('/api/analysis/Album/song.mp3').json()['arousal'] is None
    assert h.admin.get('/api/listar-albums-con-metadata?covers=false').json()[0]['tracks'][0]['arousal'] is None
    assert h.service.queue.rows(('analysis',)) == []
    h.service.scan()
    assert h.admin.post('/api/helpers/claim', json=CLAIM).status_code == 403
    old = {**CLAIM, 'capabilities': {**CLAIM['capabilities'], 'labels': ['analysis>=0']}}
    assert h.helper.post('/api/helpers/claim', json=old).status_code == 204
    reply = h.helper.post('/api/helpers/claim', json={**CLAIM, 'capabilities': {**CLAIM['capabilities'], 'accel': accel}})
    assert reply.status_code == 200, reply.text
    got = reply.json(); url = '/api/helpers/jobs/' + got['job']['id']
    assert got['job']['kind'] == 'analysis'
    beat = h.helper.post(url + '/heartbeat', json={'lease': got['lease'], 'phase': 'analizando', 'progress': .5})
    assert beat.json() == {'stop': False}
    body = {'lease': got['lease'], 'items': [result_item(i) for i in got['job']['input']['items']]}
    first = h.helper.post(url + '/result', json=body)
    assert first.status_code == 200 and first.json()['items'][0]['status'] == 200, first.text
    assert h.helper.post(url + '/result', json=body).json() == first.json()
    assert h.helper.post(url + '/result', json={**body, 'lease': 'old'}).json()['stop']
    listing = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()[0]['tracks'][0]
    assert listing['analysisState'] == 'analyzed' and listing['bpm'] == 123
    assert h.service.repository.get('Album/song.mp3')['accel'] == 'cpu'
    assert listing['arousal'] == listing['analysis']['arousal'] == .5
    for field in ('bpmEstimated', 'keyEstimated', 'bpmFixed', 'keyFixed'):
        assert listing[field] is False
    url = '/api/analysis/Album/song.mp3'
    view = h.admin.get(url)
    assert view.status_code == 200 and view.json()['computed'] == {'key': '5A', 'bpm': 123.4, 'keyEstimated': False, 'bpmEstimated': False}
    assert view.json()['arousal'] == .5
    assert h.member.put(url + '/fixed', json={'rev': 0, 'key': '2A'}).status_code == 403
    assert h.member.get(url).status_code == 404
    h.container.get_user_track_store().add_many(h.member_id, ['Album/song.mp3'])
    assert h.member.get(url).status_code == 200
    assert h.member.get(url).json()['arousal'] == .5
    member_listing = h.member.get('/api/listar-albums-con-metadata?covers=false').json()
    assert [t['arousal'] for a in member_listing for t in a['tracks']] == [.5]
    assert h.member.get('/api/analysis/summary').status_code == 403
    first = h.admin.put(url + '/fixed', json={'rev': 0, 'key': '2A'})
    assert first.status_code == 200
    second = h.admin.put(url + '/fixed', json={'rev': 0, 'key': '3A'})
    assert second.status_code == 409 and second.json() == first.json()
    summary = h.admin.get('/api/analysis/summary')
    assert summary.json()['analyzed'] == 1
    assert h.admin.get('/api/analysis/summary', headers={'If-None-Match': summary.headers['etag']}).status_code == 304
    assert any(j['kind'] == 'analysis' for j in h.admin.get('/api/jobs').json()['jobs'])


def test_claim_order_lyrics_stems_analysis(house):
    h = house
    lyrics = h.container.get_lyrics_service().agent_queue
    stems = h.container.get_stems_service().queue
    h.service.scan()
    stems.request('Album', 'song.mp3')
    lyrics.enqueue([{'relPath': 'Album/song.mp3', 'item': 'song'}])
    body = {**CLAIM, 'kinds': ['transcribe', 'stems', 'analysis'],
            'capabilities': {**CLAIM['capabilities'], 'memoryBytes': 16 << 30}}
    got = h.helper.post('/api/helpers/claim', json=body).json()
    assert got['job']['kind'] == 'transcribe'
    assert h.helper.post('/api/helpers/jobs/' + got['job']['id'] + '/result',
                         json={'lease': got['lease'], 'ok': True, 'lrc': '[00:01] words'}).json()['accepted']
    got = h.helper.post('/api/helpers/claim', json=body).json()
    assert got['job']['kind'] == 'stems'
    assert h.helper.post('/api/helpers/jobs/' + got['job']['id'] + '/result',
                         files={'lease': (None, got['lease']), 'ok': (None, 'false'), 'error': (None, 'failed'), 'final': (None, 'true')}).json()['accepted']
    assert h.helper.post('/api/helpers/claim', json=body).json()['job']['kind'] == 'analysis'


def test_arousal_batches_refresh_old_ranks_and_reads_only_project(house, monkeypatch):
    h = house

    def submit(energy, pulse, bpm):
        h.service.scan()
        job = h.helper.post('/api/helpers/claim', json=CLAIM).json()
        item = result_item(job['job']['input']['items'][0])
        item.update(energy=energy, pulse=pulse, bpm=bpm)
        reply = h.helper.post(f"/api/helpers/jobs/{job['job']['id']}/result",
                              json={'lease': job['lease'], 'items': [item]})
        assert reply.status_code == 200 and reply.json()['items'][0]['status'] == 200

    submit(.2, .8, 100)
    assert h.admin.get('/api/analysis/Album/song.mp3').json()['arousal'] == .5
    h.path.with_name('high.mp3').write_bytes(FRAME)
    submit(.4, 1.2, 160)
    assert h.admin.get('/api/analysis/Album/song.mp3').json()['arousal'] == 0
    assert h.admin.get('/api/analysis/Album/high.mp3').json()['arousal'] == 1
    h.container.get_user_track_store().add_many(h.member_id, ['Album/song.mp3'])

    def forbidden():
        pytest.fail('a read recomputed the library arousal ranks')

    monkeypatch.setattr(h.service.repository, 'recompute_arousals', forbidden)
    h.service.music.invalidate_scan()
    for client, expected in [(h.admin, [0, 1]), (h.member, [0])]:
        listing = client.get('/api/listar-albums-con-metadata?covers=false')
        assert listing.status_code == 200
        values = [t['arousal'] for a in listing.json() for t in a['tracks']]
        assert sorted(values) == expected
        assert client.get('/api/analysis/Album/song.mp3').json()['arousal'] == 0
    assert h.member.get('/api/analysis/Album/high.mp3').status_code == 404


def test_acquisition_listener_and_boot_preserve_analysis_work(house):
    h = house
    listeners = h.container.get_download_service().engine.completion_listeners
    assert h.container._enqueue_analysis_files in listeners
    h.service.enqueue_files([h.path])
    got = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    boot(h.container)
    rows = h.service.queue.rows(('analysis',))
    assert len(rows) == 1 and rows[0]['status'] == 'leased'
    assert h.container.get_jobs().get(h.container.get_jobs().list()[0]['id'])['state'] == 'running'
    h.service.release_helper(rows[0]['leased_by'])
    assert h.helper.post('/api/helpers/jobs/' + got['job']['id'] + '/result',
                         json={'lease': got['lease'], 'items': []}).json()['stop']


def test_confidence_follows_the_effective_source_and_wire_snapshots(house):
    from mutagen.id3 import ID3, TBPM, TKEY
    from tests.integration.test_wire_snapshots import assert_matches_snapshot

    h = house
    url = '/api/analysis/Album/song.mp3'
    empty = h.admin.get(url).json()
    assert empty['keyConfidence'] is empty['bpmConfidence'] is None
    h.service.scan()
    job = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    item = result_item(job['job']['input']['items'][0])
    item.update(keyConf=0.012, bpmConf=0.31)
    assert h.helper.post('/api/helpers/jobs/' + job['job']['id'] + '/result',
                         json={'lease': job['lease'], 'items': [item]}).json()['accepted']

    def check(key, bpm):
        view = h.admin.get(url).json()
        listing = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()[0]['tracks'][0]
        assert view['keyConfidence'] == listing['keyConfidence'] == key
        assert view['bpmConfidence'] == listing['bpmConfidence'] == bpm
        return view

    computed = check(0.012, 0.31)
    assert_matches_snapshot('analysis-computed', computed)
    estimates = h.admin.get('/api/analysis/estimates').json()
    assert estimates['rows'][0]['keyConfidence'] == 0.012
    assert estimates['rows'][0]['bpmConfidence'] == 0.31
    assert_matches_snapshot('analysis-estimates', estimates)
    corrected = h.admin.put(url + '/fixed', json={'rev': computed['rev'], 'key': '2A'}).json()
    assert corrected['keyConfidence'] is None and corrected['bpmConfidence'] == 0.31
    check(None, 0.31)
    assert_matches_snapshot('analysis-corrected', corrected)
    h.admin.put(url + '/fixed', json={'rev': corrected['rev'], 'key': None})
    check(0.012, 0.31)
    tags = ID3()
    tags.add(TKEY(encoding=3, text=['8B']))
    tags.add(TBPM(encoding=3, text=['126']))
    tags.save(h.path)
    h.service.music.invalidate_scan()
    tagged = check(None, None)
    assert tagged['key']['source'] == tagged['bpm']['source'] == 'tag'
    assert_matches_snapshot('analysis-tagged', tagged)


def test_arrivals_have_new_trigger_and_engine_changes_need_an_owner(house):
    h = house
    service = h.service
    assert service.scan() == 1
    first = service.queue.rows(('analysis',))[0]
    job = service.queue.ledger.list()[0]
    assert first['lane'] == 'new' and not first.get('night')
    assert service.queue.ledger.items(job['id'])[0]['detail']['trigger'] == 'new'
    got = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post(f"/api/helpers/jobs/{got['job']['id']}/result", json={
        'lease': got['lease'], 'items': [result_item(i) for i in got['job']['input']['items']]})
    with service.repository.connection() as db:
        db.execute('UPDATE track_analysis SET engine_version=0')
    assert service.scan() == service.enqueue_files([h.path]) == 0
    summary = h.admin.get('/api/analysis/summary').json()
    assert summary['outdated'] == summary['waiting'] == 1
    assert h.admin.post('/api/analysis/runs', json={
        'requestId': 'upgrade', 'mode': 'outdated', 'scope': 'library'}).status_code == 200
    got = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post(f"/api/helpers/jobs/{got['job']['id']}/result", json={
        'lease': got['lease'], 'items': [result_item(i) for i in got['job']['input']['items']]})
    assert h.admin.get('/api/analysis/summary').json()['outdated'] == 0


def test_acquisition_promotes_a_song_already_seen_by_the_library_scan(house):
    service = house.service
    assert service.scan() == 1
    row = service.queue.rows(('analysis',))[0]
    assert row['lane'] == 'new'
    assert service.enqueue_files([house.path]) == 0
    promoted = service.queue.rows(('analysis',))
    assert len(promoted) == 1 and promoted[0]['id'] == row['id']
    assert promoted[0]['lane'] == 'new'
    service.scan()
    assert service.queue.rows(('analysis',))[0]['lane'] == 'new'


def test_analysis_claim_respects_protocol_floor(house):
    from app.domains.helpers.mac_worker import MIN_WORKER_VERSION
    house.service.scan()
    reply = house.helper.post('/api/helpers/claim', json=CLAIM | {'version': '0.9.9'})
    assert reply.status_code == 200
    assert reply.json() == {'stop': True, 'reason': 'too-old', 'minimum': MIN_WORKER_VERSION}
    reply = house.helper.post('/api/helpers/claim', json=CLAIM | {'version': MIN_WORKER_VERSION})
    assert reply.status_code == 200 and reply.json()['job']['kind'] == 'analysis'
