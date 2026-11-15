"""owner helper credentials, immediate release, legacy and additive wire."""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app

pytestmark = pytest.mark.integration
AGENT = {"name": "Mac", "version": "0.10.0", "sessionId": "launch-1"}
ROUTES = [
    ("/api/lyrics/agent/claim", {"agent": AGENT}),
    ("/api/lyrics/agent/heartbeat", {"agent": AGENT}),
    ("/api/lyrics/agent/bye", {"reason": "quit"}),
    ("/api/lyrics/agent/result", {"lease": "old", "jobId": "old", "ok": False}),
    ("/api/stems/agent/claim", {"agent": AGENT}),
    ("/api/stems/agent/heartbeat", {"id": "old", "agent": AGENT}),
    ("/api/stems/agent/result", None),
]


@pytest.fixture
def house(accounts, tmp_path, monkeypatch):
    cfg = app.state.config
    for key, value in {"base_music_dir": tmp_path / "Music", "lyrics_file": tmp_path / "lyrics.json",
                       "stems_dir": tmp_path / "stems", "lyrics_engine_mode": "agent",
                       "user_tracks_file": tmp_path / "user-tracks.json"}.items():
        monkeypatch.setattr(cfg, key, value)
    (cfg.base_music_dir / "Album").mkdir(parents=True)
    (cfg.base_music_dir / "Album" / "Song.mp3").write_bytes(b"audio")
    keys = ("lyrics_service", "stems_service", "user_track_store")
    for key in keys:
        app.state.container._services.pop(key, None)
    owner, token = accounts.mint("Owner", "owner")
    admin = TestClient(app, headers={"Authorization": f"Bearer {token}"})

    def enrol(label="Helper", **body):
        reply = admin.post("/api/me/devices", json={"label": label, **body})
        assert reply.status_code == 201, reply.text
        payload = reply.json()
        return payload["device"]["id"], TestClient(app, headers={"Authorization": f"Bearer {payload['token']}"})

    identity, helper = enrol(helper=True)
    yield SimpleNamespace(admin=admin, helper=helper, id=identity, owner=owner, enrol=enrol,
                          store=accounts, root=tmp_path, container=app.state.container)
    for key in keys:
        app.state.container._services.pop(key, None)


def post_agent(client, path, body):
    return client.post(path, json=body) if body is not None else client.post(path, data={"id": "old", "ok": "false"})


@pytest.mark.parametrize("path,body", ROUTES)
@pytest.mark.parametrize("caller", ["member", "member-helper", "ordinary", "local"])
def test_not_a_helper_on_all_seven_routes(house, path, body, caller):
    if caller.startswith("member"):
        member, token = house.store.mint("Member", "member")
        if caller == "member-helper":
            _, _, token = house.store.add_device(member.user_id, "Old Mac · trabajador")
        client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    else:
        client = house.admin if caller == "ordinary" else TestClient(app)
    reply = post_agent(client, path, body)
    assert reply.status_code == 403
    assert reply.json() == {"detail": "not-a-helper"}


def lease_one(house, kind):
    lyrics = house.container.get_lyrics_service().agent_queue
    stems = house.container.get_stems_service().queue
    if kind == "lyrics":
        lyrics.enqueue([{"relPath": "Album/Song.mp3", "item": "Song"}])
        claim = house.helper.post("/api/lyrics/agent/claim", json={"agent": AGENT}).json()
        return lyrics, stems, claim["lease"], claim["jobs"][0]["id"]
    stems.request("Album", "Song.mp3")
    claim = house.helper.post("/api/stems/agent/claim", json={"agent": AGENT}).json()
    return lyrics, stems, claim["id"], None


def assert_requeued(lyrics, stems, kind):
    adapter = lyrics if kind == "lyrics" else stems
    row = adapter.queue.rows(adapter.kinds)[0]
    assert row["status"] == "queued" and row["attempts"] == 1 and row["lease"] is None


@pytest.mark.parametrize("kind", ["lyrics", "stems"])
@pytest.mark.parametrize("owner_route", [False, True])
def test_revoke_immediately_requeues_and_rejects_every_agent_call(house, owner_route, kind):
    lyrics, stems, _, _ = lease_one(house, kind)
    path = f"/api/users/{house.owner.user_id}/devices/{house.id}" if owner_route else f"/api/me/devices/{house.id}"
    assert house.admin.delete(path).status_code == 200
    assert_requeued(lyrics, stems, kind)
    assert lyrics.worker.helpers()[0]["state"] == "revoked"
    for route, body in ROUTES:
        assert post_agent(house.helper, route, body).status_code == 401
    assert json.loads((house.root / "helpers.json").read_text())["helpers"][house.id]["revokedAt"] is not None
    assert not lyrics.worker.seen(AGENT | {"id": house.id})


@pytest.mark.parametrize("kind", ["lyrics", "stems"])
@pytest.mark.parametrize("reason,state", [("sleep", "asleep"), ("quit", "closed")])
def test_bye_releases_without_refunding_attempts(house, reason, state, kind):
    lyrics, stems, lease, job = lease_one(house, kind)
    assert house.helper.post("/api/lyrics/agent/bye", json={"reason": reason, "sessionId": AGENT["sessionId"]}).json() == {"stop": False}
    assert_requeued(lyrics, stems, kind)
    assert lyrics.worker.snapshot()["state"] == state
    if kind == "lyrics":
        result = house.helper.post("/api/lyrics/agent/result", json={"lease": lease, "jobId": job, "ok": True, "lrc": "late"})
    else:
        result = house.helper.post("/api/stems/agent/result", data={"id": lease, "ok": "false"})
    assert result.json()["accepted"] is False and result.json()["reason"] == "lease-lost"


@pytest.mark.parametrize("kind", ["lyrics", "stems"])
def test_session_replacement_releases_and_old_session_cannot_bye(house, kind):
    lyrics, stems, lease, job = lease_one(house, kind)
    assert house.helper.post("/api/lyrics/agent/heartbeat", json={"agent": AGENT | {"sessionId": "launch-2"}}).json() == {"stop": False}
    assert_requeued(lyrics, stems, kind)
    for route, payload in [("claim", {"agent": AGENT}),
                           ("heartbeat", {"agent": AGENT, "lease": lease, "jobId": job or ""}),
                           ("bye", {"sessionId": AGENT["sessionId"]})]:
        assert house.helper.post(f"/api/lyrics/agent/{route}", json=payload).json()["reason"] == "replaced"
    assert lyrics.worker.snapshot()["state"] == "idle"


@pytest.mark.parametrize("kind", ["lyrics", "stems"])
def test_identity_is_bound_to_token_and_cannot_fence_another_helpers_lease(house, kind):
    lyrics, _, lease, job = lease_one(house, kind)
    identity, stranger = house.enrol(helper=True)
    stranger.post("/api/lyrics/agent/claim", json={"agent": AGENT | {"id": house.id}})
    assert {row["id"] for row in lyrics.worker.helpers()} == {identity, house.id}
    if kind == "lyrics":
        beat = {"agent": AGENT, "lease": lease, "jobId": job}
        result = stranger.post("/api/lyrics/agent/result", json={"lease": lease, "jobId": job, "ok": False})
    else:
        beat = {"agent": AGENT, "id": lease}
        result = stranger.post("/api/stems/agent/result", data={"id": lease, "ok": "false"})
    assert stranger.post(f"/api/{kind}/agent/heartbeat", json=beat).json() == {"stop": True, "reason": "lease-lost"}
    assert result.json()["accepted"] is False and result.json()["reason"] == "lease-lost"
    assert house.helper.post(f"/api/{kind}/agent/heartbeat", json=beat).json() == {"stop": False}


def test_enrolment_is_owner_only_and_legacy_worker_devices_still_work(house):
    member, token = house.store.mint("Member", "member")
    client = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    assert client.post("/api/me/devices", json={"label": "CPU", "helper": True}).status_code == 403
    ordinary = client.post("/api/me/devices", json={"label": "Old · trabajador"})
    assert ordinary.status_code == 201
    assert house.store.resolve(ordinary.json()["token"]).user_id == member.user_id
    assert len(house.store.get_user(member.user_id).devices) == 2
    for label, extra in [("Old Mac · trabajador", {"helper": True}), ("New Helper · procesa", {"helper": True})]:
        identity, helper = house.enrol(label, **extra)
        assert helper.post("/api/lyrics/agent/claim", json={"agent": {"name": label, "version": "0.10.0"}}).status_code == 204
        row = next(r for r in house.container.get_lyrics_service().agent_queue.worker.helpers() if r["id"] == identity)
        assert row["os"] == "macos" and row["accel"] == "mlx"
        assert row["jobs"] == ["align", "transcribe", "stems"]


def test_device_appears_only_on_first_claim_and_reports_optional_capabilities(house):
    worker = house.container.get_lyrics_service().agent_queue.worker
    assert house.helper.post("/api/lyrics/agent/heartbeat", json={"agent": AGENT}).json() == {"stop": False}
    assert worker.helpers() == []
    capabilities = {"os": "linux", "accel": "cuda", "gpu": "RTX", "chip": "x86_64",
                    "memoryBytes": 32 << 30, "jobs": ["align", "stems"], "keepAwake": "held"}
    assert house.helper.post("/api/lyrics/agent/claim", json={"agent": AGENT | capabilities}).status_code == 204
    assert {k: worker.helpers()[0][k] for k in capabilities} == capabilities
    assert house.helper.post("/api/stems/agent/heartbeat", json={"id": "lost", "agent": AGENT | capabilities | {"keepAwake": "failed"}}).json() == {"stop": True, "reason": "lease-lost"}
    assert worker.helpers()[0]["keepAwake"] == "failed"


def test_revoke_one_helper_keeps_another_helpers_live_lease(house):
    lyrics, stems, _, _ = lease_one(house, "lyrics")
    stems.request("Album", "Song.mp3")
    identity, other = house.enrol(helper=True)
    stem = other.post("/api/stems/agent/claim", json={"agent": AGENT}).json()
    assert house.admin.delete(f"/api/me/devices/{house.id}").status_code == 200
    assert stems.owns_lease(stem["id"], identity)
    assert other.post("/api/stems/agent/heartbeat", json={"id": stem["id"], "agent": AGENT}).json() == {"stop": False}
    views = {row["id"]: row for row in lyrics.worker.helpers()}
    assert views[house.id]["state"] == "revoked" and views[identity]["state"] == "working"


def test_owner_can_revoke_a_different_owners_helper_but_member_cannot(house):
    lease_one(house, "stems")
    _, owner_token = house.store.mint("Other owner", "owner")
    _, member_token = house.store.mint("Member", "member")
    path = f"/api/users/{house.owner.user_id}/devices/{house.id}"
    assert TestClient(app, headers={"Authorization": f"Bearer {member_token}"}).delete(path).status_code == 403
    assert TestClient(app, headers={"Authorization": f"Bearer {owner_token}"}).delete(path).status_code == 200
    assert house.helper.post("/api/lyrics/agent/heartbeat", json={"agent": AGENT}).status_code == 401


def test_waiting_stems_precede_library_lyrics_and_second_claim_is_204(house):
    lyrics = house.container.get_lyrics_service().agent_queue
    stems = house.container.get_stems_service().queue
    lyrics.enqueue([{"relPath": "Album/Song.mp3"}, {"relPath": "Album/Other.mp3"}])
    stems.request("Album", "Song.mp3")
    assert house.helper.post("/api/lyrics/agent/claim", json={"agent": AGENT, "max": 5}).status_code == 204
    assert house.helper.post("/api/stems/agent/claim", json={"agent": AGENT}).status_code == 200
    assert house.helper.post("/api/lyrics/agent/claim", json={"agent": AGENT}).status_code == 204
    assert house.helper.post("/api/stems/agent/claim", json={"agent": AGENT}).status_code == 204


@pytest.mark.parametrize("execution", [{}, {"accel": "cpu", "fallbackReason": "oom"}, {"accel": "cuda", "gpu": "NVIDIA test GPU"}])
def test_server_measures_real_track_duration_and_result_retries_are_fenced(house, monkeypatch, execution):
    import io
    import wave

    lyric_service = house.container.get_lyrics_service()
    stems_service = house.container.get_stems_service()
    lyrics, stems = lyric_service.agent_queue, stems_service.queue
    audio = house.root / "Music" / "Album" / "Measured.wav"
    with wave.open(str(audio), "wb") as song:
        song.setnchannels(1)
        song.setsampwidth(2)
        song.setframerate(8000)
        song.writeframes(b"\0\0" * 8000 * 120)
    # Avoid native background analysis; tags and duration still come from the real file.
    monkeypatch.setattr(lyric_service.music_repository, "get_track_info", lambda path: SimpleNamespace(
        title="Measured", artist="Artist", album="Album", duration=120))
    clock = [1000.0]
    for obj in (lyrics, stems, lyrics.worker):
        monkeypatch.setattr(obj, "now", lambda: clock[0])
    lyrics_job_id = lyrics.enqueue([{"relPath": "Album/Measured.wav"}])
    claim = house.helper.post("/api/lyrics/agent/claim", json={"agent": AGENT}).json()
    payload = {"lease": claim["lease"], "jobId": claim["jobs"][0]["id"], "ok": True,
               "lrc": "[00:01.00] measured", "seconds": 0.001, "durationSeconds": 1, **execution}
    clock[0] += 30
    assert house.helper.post("/api/lyrics/agent/result", json=payload).json() == {"accepted": True}
    sidecar = audio.with_suffix(".lrc")
    before = sidecar.read_bytes(), sidecar.stat().st_mtime_ns
    assert house.helper.post("/api/lyrics/agent/result", json=payload | {"lrc": "overwrite"}).json() == {"accepted": True}
    assert (sidecar.read_bytes(), sidecar.stat().st_mtime_ns) == before
    metadata = {"worker": house.id, "analyzed_by": house.id, "helperName": "Mac", "accel": "mlx", "version": "0.10.0", "seconds": 30, **execution}
    assert lyric_service.repository.get_record("Album/Measured.wav").result == metadata
    assert lyrics.ledger.items(lyrics_job_id)[0]['detail']['result'] == metadata
    _, stranger = house.enrol(helper=True)
    assert stranger.post("/api/lyrics/agent/result", json=payload).json() == {"accepted": False, "reason": "lease-lost"}
    stems.request("Album", "Measured.wav")
    claim = house.helper.post("/api/stems/agent/claim", json={"agent": AGENT}).json()
    clock[0] += 30
    manifest = {"version": 1, "track": {"duration": 1}, "seconds": 0.001, "worker": execution}
    files = {"song.json": ("song.json", io.BytesIO(json.dumps(manifest).encode()), "application/json")}
    files.update({s: (f"{s}.ogg", io.BytesIO(b"OggS"), "audio/ogg") for s in ("drums", "bass", "vocals", "other")})
    response = house.helper.post("/api/stems/agent/result", data={"id": claim["id"]}, files=files)
    assert response.json()["accepted"] is True
    assert house.helper.post("/api/stems/agent/result", data={"id": claim["id"]}).json() == response.json()
    assert stranger.post("/api/stems/agent/result", data={"id": claim["id"]}).json()["reason"] == "lease-lost"
    assert stems_service.repository.manifest("Album", "Measured.wav")["result"] == metadata
    assert stems.ledger.items(claim['jobId'])[0]['detail']['result'] == metadata
    assert lyrics.worker.helpers()[0]["speed"] == {
        "transcribe": {"samples": 1, "medianSecondsPerMinute": 15},
        "stems": {"samples": 1, "medianSecondsPerMinute": 15},
    }


@pytest.mark.parametrize("kind", ["lyrics", "stems"])
def test_concurrent_result_retries_return_the_same_response(house, kind):
    from concurrent.futures import ThreadPoolExecutor

    _, _, lease, job = lease_one(house, kind)

    def post(_):
        if kind == "lyrics":
            return house.helper.post("/api/lyrics/agent/result", json={"lease": lease, "jobId": job, "ok": False, "error": "silence"}).json()
        return house.helper.post("/api/stems/agent/result", data={"id": lease, "ok": "false", "final": "true", "error": "silence"}).json()

    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(post, range(8)))
    assert responses[0]["accepted"] is True
    assert all(response == responses[0] for response in responses)

# the same real services and device credentials through the unified API.

PROTOCOL = json.loads((Path(__file__).resolve().parents[3] / 'contracts/helper-protocol.json').read_text())
NEW_AGENT = {"workerId": "untrusted-id", "name": "Mac", "version": "0.10.0", "sessionId": "launch-1",
             "kinds": ["align", "transcribe", "stems"],
             "capabilities": {"os": "macos", "accel": "mlx", "memoryBytes": 16 << 30}}


def claim_helper(house, **changes):
    return house.helper.post('/api/helpers/claim', json=NEW_AGENT | changes)


def enqueue_helper(house, kind):
    if kind == 'stems':
        house.container.get_stems_service().queue.request('Album', 'Song.mp3')
    else:
        house.container.get_lyrics_service().agent_queue.enqueue([
            {'relPath': 'Album/Song.mp3', 'item': 'Song', 'text': 'hola' if kind == 'align' else None}])


def helper_files(**extra):
    manifest = {'version': 1, 'track': {'duration': 12, 'sampleRate': 44100}, 'chops': {}}
    manifest.update(extra)
    return {'song.json': ('song.json', json.dumps(manifest).encode(), 'application/json'),
            **{name: (f'{name}.ogg', b'OggS123', 'audio/ogg') for name in ('drums', 'bass', 'vocals', 'other')}}


@pytest.mark.parametrize('case', PROTOCOL['httpCases'], ids=lambda case: case['kind'])
def test_unified_claim_heartbeat_result_and_receipt(house, case):
    enqueue_helper(house, case['kind'])
    response = house.helper.post(case['claim'], json=NEW_AGENT)
    assert response.status_code == 200, response.text
    got = response.json()
    assert set(got) == {'job', 'lease'}
    job = got['job']
    assert house.container.get_lyrics_service().agent_queue.worker.snapshot()['id'] == house.id
    assert job['kind'] == case['kind']
    assert set(job) == {'id', 'kind', 'input'}
    assert claim_helper(house).status_code == 204  # one lease across all kinds
    path = case['heartbeat'].replace('{id}', job['id'])
    assert house.helper.post(path, json={'lease': got['lease'], 'phase': 'separando', 'progress': 42}).json() == {'stop': False}
    endpoint = case['result'].replace('{id}', job['id'])
    if job['kind'] == 'stems':
        def send(client=house.helper):
            return client.post(endpoint, data={'lease': got['lease']}, files=helper_files())
    else:
        def send(client=house.helper):
            return client.post(endpoint, json={'lease': got['lease'], 'ok': True, 'lrc': '[00:01.00]hola',
                                              'lineConfidence': [0.8], 'lowLines': []})
    result = send()
    assert result.status_code == 200, result.text
    assert result.json()['accepted'] is True
    assert send().json() == result.json()
    _, stranger = house.enrol(helper=True)
    assert send(stranger).json() == {'accepted': False, 'reason': 'lease-lost'}
    assert claim_helper(house).status_code == 204
    if job['kind'] == 'stems':
        assert house.admin.get('/api/stems/Album/Song.mp3').status_code == 200
    else:
        assert (house.root / 'Music/Album/Song.lrc').read_text().strip() == '[00:01.00]hola'


def test_unified_priority_and_requested_kinds(house):
    enqueue_helper(house, 'stems')
    enqueue_helper(house, 'transcribe')
    got = claim_helper(house).json()
    assert got['job']['kind'] == 'transcribe'
    assert house.helper.post('/api/helpers/bye', json={'reason': 'sleep', 'sessionId': 'launch-1'}).json() == {'stop': False}
    # This helper explicitly offers only stems: lyrics do not block its claim.
    got = claim_helper(house, kinds=['stems']).json()
    assert got['job']['kind'] == 'stems'
    assert house.helper.post('/api/helpers/bye', json={'reason': 'quit'}).json() == {'stop': False}
    assert claim_helper(house, kinds=[]).status_code == 204


@pytest.mark.parametrize('kind', ['transcribe', 'stems'])
def test_unified_fences_wrong_id_holder_and_stale_leases(house, kind):
    enqueue_helper(house, kind)
    got = claim_helper(house).json()
    job_id, lease = got['job']['id'], got['lease']
    _, stranger = house.enrol(helper=True)
    path = f'/api/helpers/jobs/{job_id}/heartbeat'
    assert stranger.post(path, json={'lease': lease}).json() == {'stop': True, 'reason': 'lease-lost'}
    assert house.helper.post('/api/helpers/jobs/wrong/heartbeat', json={'lease': lease}).json()['stop'] is True
    result = '/api/helpers/jobs/wrong/result'
    data = {'lease': lease, 'ok': False, 'final': True, 'error': 'verdict'}
    reply = house.helper.post(result, data=data, files={'unused': ('x', b'')}) if kind == 'stems' else house.helper.post(result, json=data)
    assert reply.json() == {'accepted': False, 'reason': 'lease-lost'}
    assert claim_helper(house, sessionId='launch-2').status_code == 200
    assert house.helper.post(path, json={'lease': lease, 'agent': AGENT}).json() == {'stop': True, 'reason': 'replaced'}
    assert house.helper.post(path, json={'lease': lease}).json()['stop'] is True


@pytest.mark.parametrize('kind', ['transcribe', 'stems'])
@pytest.mark.parametrize('final', [False, True])
def test_unified_failure_retains_retry_policy(house, kind, final):
    enqueue_helper(house, kind)
    got = claim_helper(house).json()
    path = f"/api/helpers/jobs/{got['job']['id']}/result"
    body = {'lease': got['lease'], 'ok': False, 'error': 'no voice', 'final': final}
    response = (house.helper.post(path, data={k: str(v).lower() if isinstance(v, bool) else v for k, v in body.items()},
                                  files={'unused': ('x', b'')}) if kind == 'stems'
                else house.helper.post(path, json=body))
    assert response.status_code == 200, response.text
    assert response.json()['accepted']
    assert claim_helper(house).status_code == (204 if final else 200)


@pytest.mark.parametrize('part', ['song.json', 'drums'])
def test_unified_same_upload_caps_and_cleanup(house, monkeypatch, part):
    from app.domains.helpers import legacy
    monkeypatch.setattr(legacy, 'MAX_MANIFEST_BYTES', 1024)
    monkeypatch.setattr(legacy, 'MAX_STEM_BYTES', 8)
    enqueue_helper(house, 'stems')
    got = claim_helper(house).json()
    files = helper_files()
    files[part] = (part, b'x' * 1025, 'application/octet-stream')
    response = house.helper.post(f"/api/helpers/jobs/{got['job']['id']}/result", data={'lease': got['lease']}, files=files)
    assert response.status_code == 413, response.text
    assert part in response.json()['detail']
    assert not list((house.root / 'stems/.incoming').iterdir())


@pytest.mark.parametrize('path,body', [('/api/helpers/claim', NEW_AGENT),
    ('/api/helpers/jobs/old/heartbeat', {'lease': 'old'}),
    ('/api/helpers/jobs/old/result', {'lease': 'old', 'ok': False}),
    ('/api/helpers/bye', {'reason': 'quit'})])
def test_unified_requires_helper_role(house, path, body):
    assert house.admin.post(path, json=body).status_code == 403
    assert house.helper.post(path, json=body).status_code in (200, 204)


@pytest.mark.parametrize('reason', ['no-engine', 'no-cgroup', 'memory'])
def test_nest_row_explains_why_it_cannot_help(house, monkeypatch, reason):
    from unittest.mock import Mock, PropertyMock
    service = house.container.get_lyrics_service()
    nest = house.container.get_nest_helper()
    if reason != 'no-engine':
        monkeypatch.setattr(type(service.engine), 'installed', PropertyMock(return_value=True))
        monkeypatch.setattr(service.engine, 'check', lambda **kwargs: {'version': '0.10.0', 'jobs': ['align', 'stems']})
        nest.probe = Mock(return_value=None if reason == 'no-cgroup' else SimpleNamespace(mode='cgroup'))
    monkeypatch.setattr('app.domains.helpers.nest_helper.machine_facts', lambda: {'memoryBytes': 4 << 30})
    response = house.admin.get('/api/lyrics/jobs')
    assert response.status_code == 200, response.text
    row = next(row for row in response.json()['engine']['helpers'] if row['nest'])
    assert row['disabledReason'] == reason
    assert {'code': reason, 'kind': None, 'requiredBytes': None, 'availableBytes': None} in row['blockedReasons']
    assert service.agent_queue.worker.helpers() == []


def test_unified_claim_respects_lanes_and_round_robin(house):
    lyrics = house.container.get_lyrics_service().agent_queue
    stems = house.container.get_stems_service().queue
    lyrics.enqueue([{'relPath': 'Album/library.mp3', 'lane': 'library'}])
    lyrics.enqueue([{'relPath': 'Album/now.mp3'}])
    lyrics.enqueue([{'relPath': 'Album/second-now.mp3'}])
    stems.request('Album', 'Song.mp3')
    body = {'kinds': ['align', 'transcribe', 'stems'], 'name': 'Helper', 'version': '0.10.0'}
    first = house.helper.post('/api/helpers/claim', json=body).json()
    assert first['job']['input']['relPath'] == 'Album/now.mp3'
    # A verdict completes the turn without needing real audio processing.
    house.helper.post(f"/api/helpers/jobs/{first['job']['id']}/result", json={'lease': first['lease'], 'ok': False, 'error': 'silence'})
    second = house.helper.post('/api/helpers/claim', json=body).json()
    assert second['job']['kind'] == 'stems'


@pytest.mark.parametrize('path', ['/api/helpers/claim', '/api/lyrics/agent/claim', '/api/stems/agent/claim'])
def test_claim_floor_is_a_successful_refusal_and_helper_stays_listed(house, path):
    from app.domains.helpers.mac_worker import MIN_WORKER_VERSION
    lyrics = house.container.get_lyrics_service().agent_queue
    if path != '/api/stems/agent/claim':
        lyrics.enqueue([{'relPath': 'Album/Song.mp3', 'item': 'Song'}])
    house.container.get_stems_service().queue.request('Album', 'Song.mp3')
    agent = AGENT | {'version': '0.9.9'}
    body = {'kinds': ['align', 'transcribe', 'stems'], **agent} if path == '/api/helpers/claim' else {'agent': agent}
    for _ in range(2):
        reply = house.helper.post(path, json=body)
        assert reply.status_code == 200
        assert reply.json().items() >= {'stop': True, 'reason': 'too-old', 'minimum': MIN_WORKER_VERSION}.items()
    row = next(h for h in house.admin.get('/api/compute/summary').json()['computers'] if h['id'] == house.id)
    assert row['version'] == '0.9.9' and row['minimumVersion'] == MIN_WORKER_VERSION
    assert row['versionState'] == 'too-old'
    agent['version'] = MIN_WORKER_VERSION
    body = {'kinds': ['align', 'transcribe', 'stems'], **agent} if path == '/api/helpers/claim' else {'agent': agent}
    reply = house.helper.post(path, json=body)
    assert reply.status_code == 200 and not reply.json().get('stop')
    assert reply.json().get('job') or reply.json().get('jobs') or reply.json().get('jobId')
