"""``/api/stems`` through the real app: the client routes, the agent routes, the files.

Every test gets a tmp library, a tmp stems dir and a tmp queue file, and the
engine placement is forced to ``agent`` so nothing tries to run a model.
"""
from __future__ import annotations

import errno
import json
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import ROLE_MEMBER
from app.main import app
from app.utils.library_paths import ROOT_ALBUM_DIR, ROOT_ALBUM_KEY

pytestmark = pytest.mark.integration

ALBUM = "In Rainbows"
SONG = "01 - 15 Step.mp3"
STEMS = ("drums", "bass", "vocals", "other")


@pytest.fixture
def library(tmp_path, monkeypatch):
    music = tmp_path / "Music"
    (music / ALBUM).mkdir(parents=True)
    (music / ALBUM / SONG).write_bytes(b"\xff\xfb\x90\x00" * 100)
    cfg = app.state.config
    monkeypatch.setattr(cfg, "base_music_dir", music)
    monkeypatch.setattr(cfg, "lyrics_file", tmp_path / "lyrics.json")
    monkeypatch.setattr(cfg, "stems_dir", tmp_path / "stems")
    monkeypatch.setattr(cfg, "lyrics_engine_mode", "agent")
    monkeypatch.setattr(cfg, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(cfg, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(cfg, "api_token", None)
    monkeypatch.setattr(cfg, "allow_unauthenticated_remote", False)
    for key in ("lyrics_service", "stems_service", "token_store"):
        app.state.container._services.pop(key, None)
    yield tmp_path
    for key in ("lyrics_service", "stems_service", "token_store"):
        app.state.container._services.pop(key, None)


@pytest.fixture
def client(library):
    store = app.state.container.get_token_store()
    owner, owner_token = store.mint("Owner", "owner")
    _, _, token = store.add_device(owner.user_id, "Mac · trabajador", helper=True)
    client = TestClient(app, headers={"Authorization": f"Bearer {owner_token}"})
    client.helper = TestClient(app, headers={"Authorization": f"Bearer {token}"})
    return client


def _track_url(album=ALBUM, file=SONG):
    return f"/api/stems/{quote(album, safe='')}/{quote(file, safe='')}"


def _song_json(**extra):
    body = {
        "version": 1,
        "track": {"album": "ignored", "file": "ignored", "duration": 12.0, "sampleRate": 44100},
        "model": "htdemucs",
        "stems": {s: f"{s}.ogg" for s in STEMS},
        "analysis": {"bpm": 120.0, "key": "C# minor", "beats": [0.5, 1.0], "downbeats": [0.5]},
        "chops": {"full": [{"start": 0.5, "end": 2.5, "label": "bar 1"}], "drums": [], "bass": [], "other": [], "vocals": []},
        "createdAt": "2026-10-09T00:00:00Z",
        "worker": {"host": "test", "seconds": 1.0},
    }
    body.update(extra)
    return json.dumps(body).encode()


def _upload(client, lease, *, song=None, stems=STEMS, payload=b"OggS" + bytes(range(256)) * 40):
    files = [("song.json", ("song.json", song if song is not None else _song_json(), "application/json"))]
    files += [(s, (f"{s}.ogg", payload, "audio/ogg")) for s in stems]
    return client.helper.post("/api/stems/agent/result", data={"id": lease}, files=files)


def _claim(client, name="mac"):
    return client.helper.post("/api/stems/agent/claim", json={"agent": {"name": name, "platform": "darwin-arm64", "version": "0.10.0"}})


def _ready(client):
    client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
    lease = _claim(client).json()["id"]
    assert _upload(client, lease).json()["accepted"] is True
    return lease


@pytest.mark.parametrize("album", [ROOT_ALBUM_KEY, ALBUM], ids=["root", "album"])
@pytest.mark.parametrize("bulk", [False, True], ids=["single-delete", "bulk-delete"])
def test_split_round_trip_listing_and_delete(client, library, album, bulk):
    file = "Loose Song.mp3"
    source = library / "Music" / file if album == ROOT_ALBUM_KEY else library / "Music" / album / file
    source.write_bytes(b"\xff\xfb\x90\x00" * 100)
    url = _track_url(album, file)
    assert client.get(url).status_code == 404
    assert client.get("/api/stems").json() == {"splits": []}  # warm the listing before publishing
    requested = client.post("/api/stems/request", json={"album": album, "file": file})
    assert requested.status_code == 200 and requested.json()["status"] == "queued"
    assert client.get(url).status_code == 202
    claimed = _claim(client)
    assert claimed.status_code == 200
    job = claimed.json()
    assert (job["album"], job["file"], job["jobId"]) == (album, file, requested.json()["jobId"])
    assert job["mediaPath"] == f"/api/media/{quote(album, safe='')}/{quote(file, safe='')}"
    payload = b"OggS" * 1000
    result = _upload(client, job["id"], payload=payload)
    assert result.status_code == 200 and result.json()["accepted"] is True
    manifest = client.get(url)
    assert manifest.status_code == 200
    assert (manifest.json()["track"]["album"], manifest.json()["track"]["file"]) == (album, file)
    for stem, stem_url in manifest.json()["stems"].items():
        assert stem_url == f"{url}/{stem}"
        audio = client.get(stem_url)
        assert audio.status_code == 200 and audio.content == payload
    assert client.post("/api/stems/request", json={"album": album, "file": file}).json() == {
        "status": "ready", "jobId": None,
    }
    folder = ROOT_ALBUM_DIR if album == ROOT_ALBUM_KEY else album
    stored = library / "stems" / folder / file
    assert (stored / "song.json").is_file()
    assert not any((library / "stems" / ".incoming").iterdir())
    # Hidden staging/other directories must stay out of listing and bulk delete.
    for hidden in (".incoming", ".other"):
        decoy = library / "stems" / hidden / file
        decoy.mkdir(parents=True)
        (decoy / "song.json").write_bytes(_song_json())
    listed = client.get("/api/stems")
    assert listed.status_code == 200
    rows = listed.json()["splits"]
    assert [(row["album"], row["file"], row["stale"]) for row in rows] == [(album, file, False)]
    assert rows[0]["sizeBytes"] == sum(path.stat().st_size for path in stored.iterdir())
    assert client.get("/api/stems").json() == listed.json()  # memoized identity stays on the wire
    deleted = client.delete("/api/stems" if bulk else url)
    assert deleted.status_code == 200
    assert deleted.json() == ({"removed": 1} if bulk else {"success": True, "removed": True})
    assert not stored.exists() and source.is_file()
    assert client.get(url).status_code == 404
    assert client.get(f"{url}/drums").status_code == 404
    assert client.get("/api/stems").json() == {"splits": []}
    assert client.delete("/api/stems").json() == {"removed": 0}
    assert all((library / "stems" / hidden / file / "song.json").is_file()
               for hidden in (".incoming", ".other"))


@pytest.mark.parametrize("album", [ROOT_ALBUM_DIR, ".incoming", ".album"])
def test_hidden_album_request_keys_cannot_address_reserved_storage(client, library, album):
    file = "Loose Song.mp3"
    (library / "Music" / album).mkdir()
    (library / "Music" / album / file).write_bytes(b"audio")
    stored = library / "stems" / album / file
    stored.mkdir(parents=True)
    (stored / "song.json").write_bytes(_song_json())
    (stored / "drums.ogg").write_bytes(b"OggS")
    assert client.post("/api/stems/request", json={"album": album, "file": file}).status_code == 404
    assert client.get(_track_url(album, file)).status_code == 404
    assert client.get(f"{_track_url(album, file)}/drums").status_code == 404
    assert client.delete(_track_url(album, file)).status_code == 404
    assert (stored / "song.json").is_file()


@pytest.mark.parametrize("level", ["album", "track"])
def test_root_storage_mapping_keeps_symlink_containment(client, library, level):
    file = "Loose Song.mp3"
    (library / "Music" / file).write_bytes(b"audio")
    outside = library / "outside"
    outside.mkdir()
    (outside / "song.json").write_bytes(_song_json())
    (outside / "drums.ogg").write_bytes(b"OggS")
    root = app.state.container.get_stems_service().repository.root
    link = root / ROOT_ALBUM_DIR
    if level == "track":
        link.mkdir()
        link = link / file
    link.symlink_to(outside, target_is_directory=True)
    url = _track_url(ROOT_ALBUM_KEY, file)
    assert client.get(url).status_code == 404
    assert client.get(f"{url}/drums").status_code == 404
    assert client.delete(url).status_code == 404
    assert client.get("/api/stems").json() == {"splits": []}
    assert client.delete("/api/stems").json() == {"removed": 0}
    assert (outside / "song.json").is_file()


@pytest.mark.parametrize("location", ["manifest", "track_dir"])
@pytest.mark.parametrize("error", [errno.ENAMETOOLONG, errno.EACCES])
def test_stat_errors_return_the_normal_stems_404(client, library, monkeypatch, location, error):
    service = app.state.container.get_stems_service()
    service.repository.root.mkdir(exist_ok=True)
    target = library / "stems"
    if location == "manifest":
        target = target / ALBUM / SONG / "song.json"
    original = Path.stat

    def fail_stat(path, *args, **kwargs):
        if path == target:
            raise OSError(error, "stat failed")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", fail_stat)
    response = client.get(_track_url())
    assert response.status_code == 404
    assert response.json() == {"detail": f"No stems requested for {ALBUM}/{SONG}"}


class TestRequest:
    def test_never_requested_is_404(self, client):
        assert client.get(_track_url()).status_code == 404

    def test_request_is_idempotent_and_202_until_ready(self, client):
        first = client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        assert first.status_code == 200 and first.json()["status"] == "queued"
        again = client.post("/api/stems/request", json={"album": ALBUM, "file": SONG, "model": "htdemucs"})
        assert again.json() == first.json()
        pending = client.get(_track_url())
        assert pending.status_code == 202
        assert pending.json() == {
            "status": "queued", "phase": "queued", "progress": None, "error": None,
            "agent": {"online": False, "lastSeen": None, "name": None},
        }
        jobs = client.get("/api/stems/jobs").json()
        assert len(jobs["jobs"]) == 1 and jobs["jobs"][0]["status"] == "queued"
        assert jobs["agent"]["online"] is False and jobs["mode"] == "agent"

    def test_a_track_not_in_the_library_is_404_and_a_model_we_lack_is_422(self, client):
        assert client.post("/api/stems/request", json={"album": ALBUM, "file": "nope.mp3"}).status_code == 404
        assert client.post("/api/stems/request", json={"album": ALBUM, "file": SONG, "model": "spleeter"}).status_code == 422

    def test_traversal_is_refused_everywhere(self, client):
        for album, file in (("..", "etc"), (".incoming", "x"), (ALBUM, "..")):
            assert client.post("/api/stems/request", json={"album": album, "file": file}).status_code == 404
        assert client.get("/api/stems/..%2F..%2Fetc/passwd").status_code == 404
        assert client.get(f"{_track_url('..', 'x')}").status_code == 404
        assert client.get(f"{_track_url('..', 'x')}/drums").status_code == 404
        assert client.get(f"{_track_url()}/..").status_code == 404

    def test_ready_means_no_new_job(self, client):
        _ready(client)
        again = client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        assert again.json() == {"status": "ready", "jobId": None}
        assert client.get("/api/stems/jobs").json()["jobs"] == []

    def test_a_changed_file_makes_the_split_stale_but_still_served(self, client, library):
        import os

        _ready(client)
        manifest = client.get(_track_url()).json()
        audio = library / "Music" / ALBUM / SONG
        assert manifest["track"]["source"] == {"size": audio.stat().st_size, "mtime": int(audio.stat().st_mtime)}
        # A re-download: different bytes, a new mtime.
        audio.write_bytes(b"\xff\xfb\x90\x00" * 150)
        os.utime(audio, (audio.stat().st_atime, audio.stat().st_mtime + 60))
        again = client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        assert again.json()["status"] == "queued"
        assert client.get(_track_url()).status_code == 200, "the old split is served until the new one lands"
        assert client.get("/api/stems/jobs").json()["jobs"][0]["status"] == "queued"
        # Only mtime changed (a retag that kept the size) → also stale.
        lease = _claim(client).json()["id"]
        assert _upload(client, lease).json()["accepted"] is True
        assert client.post("/api/stems/request", json={"album": ALBUM, "file": SONG}).json()["status"] == "ready"
        os.utime(audio, (audio.stat().st_atime, audio.stat().st_mtime + 60))
        assert client.post("/api/stems/request", json={"album": ALBUM, "file": SONG}).json()["status"] == "queued"

    def test_a_manifest_without_a_signature_stays_valid(self, client, library):
        import json as J

        _ready(client)
        path = library / "stems" / ALBUM / SONG / "song.json"
        data = J.loads(path.read_text())
        del data["track"]["source"]
        path.write_text(J.dumps(data))
        assert client.post("/api/stems/request", json={"album": ALBUM, "file": SONG}).json()["status"] == "ready"


class TestAgent:
    def test_claim_heartbeat_result_then_the_manifest(self, client, library):
        job_id = client.post("/api/stems/request", json={"album": ALBUM, "file": SONG}).json()["jobId"]
        claimed = _claim(client)
        assert claimed.status_code == 200
        body = claimed.json()
        assert body["jobId"] == job_id and body["album"] == ALBUM and body["file"] == SONG
        assert body["mediaPath"] == f"/api/media/{quote(ALBUM, safe='')}/{quote(SONG, safe='')}"
        assert body["model"] == "htdemucs"
        assert _claim(client).status_code == 204, "one job, one lease"
        assert client.get(_track_url()).json()["phase"] == "claimed"

        beat = client.helper.post("/api/stems/agent/heartbeat", json={"id": body["id"], "phase": "separando", "progress": 40})
        assert beat.json() == {"stop": False}
        running = client.get(_track_url()).json()
        # The worker's Spanish key is mapped to the wire's English one.
        assert {k: running[k] for k in ("status", "phase", "progress", "error")} == {
            "status": "running", "phase": "separating", "progress": 40.0, "error": None,
        }
        assert running["agent"]["online"] is True
        client.helper.post("/api/stems/agent/heartbeat", json={"id": body["id"], "phase": "beats"})
        assert client.get(_track_url()).json()["phase"] == "beats", "English keys pass through"
        snapshot = client.get("/api/stems/jobs").json()
        assert snapshot["agent"]["online"] is True and snapshot["agent"]["name"] == "mac"
        assert snapshot["agent"]["lastSeen"].endswith("Z")

        result = _upload(client, body["id"])
        assert result.json() == {"accepted": True, "status": "ready", "requeued": None, "reason": None}
        manifest = client.get(_track_url())
        assert manifest.status_code == 200
        m = manifest.json()
        assert m["track"]["album"] == ALBUM and m["track"]["file"] == SONG, "identity is the job's, not the worker's"
        assert m["stems"]["drums"] == f"{_track_url()}/drums"
        assert m["analysis"]["key"] == "C# minor"
        stored = library / "stems" / ALBUM / SONG
        assert sorted(p.name for p in stored.iterdir()) == ["bass.ogg", "drums.ogg", "other.ogg", "song.json", "vocals.ogg"]
        assert not any((library / "stems" / ".incoming").iterdir()), "staging is cleaned"

    def test_a_result_under_a_lost_lease_is_ignored(self, client):
        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        assert _upload(client, "not-a-lease").json()["accepted"] is False
        assert client.helper.post("/api/stems/agent/heartbeat", json={"id": "not-a-lease"}).json() == {"stop": True, "reason": "lease-lost"}

    def test_an_incomplete_or_bad_upload_is_422(self, client):
        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        lease = _claim(client).json()["id"]
        assert _upload(client, lease, stems=("drums", "bass")).status_code == 422
        assert _upload(client, lease, song=b"{not json").status_code == 422
        assert _upload(client, lease, song=_song_json(version=2)).status_code == 422
        bad_chop = _song_json(chops={"full": [{"start": 2.0, "end": 1.0, "label": "x"}]})
        assert _upload(client, lease, song=bad_chop).status_code == 422
        assert client.get(_track_url()).status_code == 202, "still running; nothing published"

    def test_an_oversized_part_is_413_and_nothing_is_kept(self, client, library, monkeypatch):
        from app.domains.helpers import legacy as R

        monkeypatch.setattr(R, "MAX_STEM_BYTES", 1 << 20)
        monkeypatch.setattr(R, "MAX_MANIFEST_BYTES", 1024)
        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        lease = _claim(client).json()["id"]
        too_big = _upload(client, lease, payload=b"\0" * ((1 << 20) + 1))
        assert too_big.status_code == 413 and "drums" in too_big.json()["detail"]
        fat_manifest = _upload(client, lease, song=_song_json(padding="x" * 2000))
        assert fat_manifest.status_code == 413 and "song.json" in fat_manifest.json()["detail"]
        assert not any((library / "stems" / ".incoming").iterdir()), "staging removed"
        assert client.get(_track_url()).status_code == 202, "lease still live; nothing published"
        assert _upload(client, lease, payload=b"OggS" * 1000).json()["accepted"] is True

    def test_an_accident_is_requeued_and_a_verdict_is_final(self, client):
        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        lease = _claim(client).json()["id"]
        r = client.helper.post("/api/stems/agent/result", data={"id": lease, "ok": "false", "error": "boom", "final": "false"})
        assert r.json()["requeued"] is True
        assert client.get(_track_url()).json()["status"] == "queued"
        lease = _claim(client).json()["id"]
        r = client.helper.post("/api/stems/agent/result", data={"id": lease, "ok": "false", "error": "silencio", "final": "true"})
        assert r.json() == {"accepted": True, "status": None, "requeued": False, "reason": None}
        failed = client.get(_track_url())
        assert failed.status_code == 202 and failed.json()["status"] == "failed" and failed.json()["error"] == "silencio"
        assert failed.json()["phase"] == "failed"
        # Asking again is the retry.
        assert client.post("/api/stems/request", json={"album": ALBUM, "file": SONG}).json()["status"] == "queued"

    def test_delete_while_running_tells_the_agent_to_stop(self, client):
        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        lease = _claim(client).json()["id"]
        assert client.delete(_track_url()).json() == {"success": True, "removed": True}
        assert client.helper.post("/api/stems/agent/heartbeat", json={"id": lease}).json() == {"stop": True, "reason": "lease-lost"}
        assert _upload(client, lease).json()["accepted"] is False
        assert client.get(_track_url()).status_code == 404

    def test_claim_with_no_version_is_refused(self, client):
        from app.domains.helpers.mac_worker import MIN_WORKER_VERSION
        response = client.helper.post("/api/stems/agent/claim")
        assert response.status_code == 200
        assert response.json() == {"stop": True, "reason": "too-old", "minimum": MIN_WORKER_VERSION}


class TestServing:
    def test_a_stem_streams_with_range(self, client):
        _ready(client)
        url = f"{_track_url()}/drums"
        full = client.get(url)
        assert full.status_code == 200 and full.headers["content-type"] == "audio/ogg"
        assert full.headers.get("accept-ranges") == "bytes"
        part = client.get(url, headers={"Range": "bytes=0-99"})
        assert part.status_code == 206
        assert part.headers["content-range"] == f"bytes 0-99/{len(full.content)}"
        assert part.content == full.content[:100]

    def test_unknown_stem_and_missing_stems_are_404(self, client):
        assert client.get(f"{_track_url()}/drums").status_code == 404
        _ready(client)
        assert client.get(f"{_track_url()}/piano").status_code == 404

    def test_delete_removes_the_files(self, client, library):
        _ready(client)
        assert client.delete(_track_url()).json()["removed"] is True
        assert not (library / "stems" / ALBUM).exists()
        assert client.get(_track_url()).status_code == 404
        assert client.delete(_track_url()).json()["removed"] is False

    def test_delete_is_owner_only(self, client, library):
        _ready(client)
        store = app.state.container.get_token_store()
        record, token = store.mint("Ana", ROLE_MEMBER)
        app.state.container.get_user_track_store().add_many(record.user_id, [f"{ALBUM}/{SONG}"])
        remote = TestClient(app, client=("192.0.2.42", 51000))
        headers = {"Authorization": f"Bearer {token}"}
        assert remote.get(_track_url(), headers=headers).status_code == 200, "members read"
        assert remote.delete(_track_url(), headers=headers).status_code == 403
        assert remote.get(_track_url()).status_code == 401, "and nobody without a token"

    def test_request_is_scoped_to_the_members_library(self, client, library):
        store = app.state.container.get_token_store()
        record, token = store.mint("Ana", ROLE_MEMBER)
        remote = TestClient(app, client=("192.0.2.42", 51000))
        headers = {"Authorization": f"Bearer {token}"}
        body = {"album": ALBUM, "file": SONG}
        assert remote.post("/api/stems/request", json=body, headers=headers).status_code == 404
        app.state.container.get_user_track_store().add_many(record.user_id, [f"{ALBUM}/{SONG}"])
        assert remote.post("/api/stems/request", json=body, headers=headers).status_code == 200
        assert remote.post("/api/stems/request", json=body).status_code == 401
        assert client.post("/api/stems/request", json=body).status_code == 200, "the owner can"


class TestLeaseRequeue:
    def test_a_quiet_lease_is_requeued_then_given_up(self, client, monkeypatch):
        from app.infra.jobs import queue as Q

        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        service = app.state.container.get_stems_service()
        clock = [1_000_000.0]
        service.queue.now = lambda: clock[0]
        monkeypatch.setattr(service.queue.worker, "now", lambda: clock[0])
        for attempt in range(1, Q.MAX_ATTEMPTS + 1):
            claimed = _claim(client)
            assert claimed.status_code == 200 and claimed.json()["attempt"] == attempt
            clock[0] += Q.LEASE_STALE_S + 1
        snap = client.get("/api/stems/jobs").json()
        assert snap["jobs"][0]["status"] == "failed"
        assert snap["jobs"][0]["error"] == "el equipo dejó de responder 3 veces"
        assert _claim(client).status_code == 204

    def test_rows_survive_a_restart_but_leases_do_not(self, client):
        client.post("/api/stems/request", json={"album": ALBUM, "file": SONG})
        lease = _claim(client).json()["id"]
        app.state.container._services.pop("stems_service", None)  # a restart
        app.state.container._services.pop("lyrics_service", None)  # registry/locks restart too
        assert client.get(_track_url()).json()["status"] == "queued"
        assert client.helper.post("/api/stems/agent/heartbeat", json={"id": lease}).json() == {"stop": True, "reason": "lease-lost"}
        assert _claim(client).status_code == 200


class TestSharedMac:
    def test_stems_uses_lyrics_identity_presence_and_goodbye(self, client):
        facts = {"id": app.state.container.get_token_store().resolve(client.helper.headers["Authorization"].split()[1]).device_id, "name": "Helper", "version": "0.10.0", "chip": "Apple M1 Pro",
                 "memoryBytes": 17179869184, "macos": "26.1", "state": "idle", "lastError": None}
        assert client.helper.post('/api/lyrics/agent/claim', json={"agent": facts}).status_code == 204
        assert client.get('/api/stems/jobs').json()['agent']['online'] is True
        client.post('/api/stems/request', json={"album": ALBUM, "file": SONG})
        job = client.helper.post('/api/stems/agent/claim', json={"agent": facts}).json()
        answer = client.helper.post('/api/stems/agent/heartbeat', json={"id": job['id'], "phase": "separando", "agent": facts | {"chip": "Apple M4"}})
        assert answer.json() == {"stop": False}
        worker = client.get('/api/lyrics/jobs').json()['engine']['worker']
        assert worker['state'] == 'working' and worker['chip'] == 'Apple M4'
        assert worker['job'] == {"title": SONG, "phase": "separating"}
        for reason, state in [('sleep', 'asleep'), ('quit', 'closed')]:
            assert client.helper.post('/api/lyrics/agent/bye', json={"id": facts['id'], "reason": reason}).status_code == 200
            assert client.get('/api/lyrics/jobs').json()['engine']['worker']['state'] == state
            assert client.get('/api/stems/jobs').json()['agent']['online'] is False
            client.helper.post('/api/lyrics/agent/heartbeat', json={"agent": facts})
        newer = facts | {"sessionId": "new-run", "name": "Other Mac"}
        client.helper.post('/api/lyrics/agent/claim', json={"agent": newer})
        assert client.helper.post('/api/stems/agent/heartbeat', json={"id": job['id'], "agent": facts}).json() == {"stop": True, "reason": "replaced"}
        assert client.helper.post('/api/stems/agent/claim', json={"agent": facts}).json() == {"stop": True, "reason": "replaced"}
        assert client.helper.post('/api/stems/agent/result', data={"id": job['id'], "ok": "false"}).json()['accepted'] is False
        assert client.get('/api/stems/jobs').json()['agent']['name'] == 'Other Mac'

    def test_stems_claim_can_select_mac_and_lyrics_heartbeat_replaces_it(self, client):
        device_id = app.state.container.get_token_store().resolve(client.helper.headers["Authorization"].split()[1]).device_id
        facts = {"id": device_id, "name": "Stems Mac", "version": "0.10.0"}
        assert client.helper.post('/api/stems/agent/claim', json={"agent": facts}).status_code == 204
        assert client.get('/api/lyrics/jobs').json()['engine']['worker']['id'] == device_id
        # The spec's reason-only goodbye addresses the nest's current Mac.
        assert client.helper.post('/api/lyrics/agent/bye', json={"reason": "sleep"}).status_code == 200
        assert client.get('/api/lyrics/jobs').json()['engine']['worker']['state'] == 'asleep'
        other = facts | {"sessionId": "new-run"}
        client.helper.post('/api/lyrics/agent/heartbeat', json={"agent": other})
        assert client.helper.post('/api/lyrics/agent/claim', json={"agent": facts}).json()['reason'] == 'replaced'
        assert client.get('/api/lyrics/jobs').json()['engine']['worker']['id'] == device_id
