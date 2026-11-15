"""``/api/lyrics`` through the real app: auth, status codes, and the file on disk.

The lyrics service is rebuilt per test against a tmp library and its provider
registry is replaced by a scripted catalog, so nothing here talks to
lrclib.net and nothing touches the developer's ``~/Krobi``.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.domains.lyrics.models import LyricsCandidate
from app.main import app
from app.providers.registry import ProviderDescriptor, ProviderKind, ProviderRegistry

pytestmark = pytest.mark.integration

ALBUM = "In Rainbows"
SONG = "01 - 15 Step.mp3"
LRC = "[00:01.00] Paper lanterns drifting past the harbor\n[00:05.20] Paper lanterns counting every wave\n"


class ScriptedCatalog:
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0

    def search_lyrics(self, query):
        self.calls += 1
        return list(self.rows)


@pytest.fixture
def library(tmp_path, monkeypatch):
    music = tmp_path / "Music"
    (music / ALBUM).mkdir(parents=True)
    (music / ALBUM / SONG).write_bytes((b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40)
    monkeypatch.setattr(app.state.config, "base_music_dir", music)
    monkeypatch.setattr(app.state.config, "lyrics_file", tmp_path / "lyrics.json")
    monkeypatch.setattr(app.state.config, "lyrics_auto_fetch", False)
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    app.state.container._services.pop("lyrics_service", None)
    service = app.state.container.get_lyrics_service()
    # Let the real worker drain its jobs, then exit without the 60s idle wait.
    monkeypatch.setattr(service._wake, "wait", lambda timeout: False)
    yield music
    worker = service._worker  # the worker clears this attribute itself when it exits
    if worker is not None:
        worker.join(timeout=5)
        assert not worker.is_alive(), "lyrics worker outlived its test ledger"
    app.state.container._services.pop("lyrics_service", None)


@pytest.fixture
def catalog(library):
    """Swap the lyrics service's registry for one scripted provider."""
    rows = [
        LyricsCandidate(
            provider="lrclib", title="15 Step", artist="Radiohead", album=ALBUM,
            duration_s=237.0, synced_lyrics=LRC, provider_ref="lrclib:42",
        )
    ]
    scripted = ScriptedCatalog(rows)
    registry = ProviderRegistry(store=None)
    registry.register(
        ProviderDescriptor(id="lrclib", kind=ProviderKind.LYRICS, name="LRCLIB", description="", capabilities=("lyrics",)),
        scripted,
    )
    service = app.state.container.get_lyrics_service()
    service.registry = registry
    return scripted


@pytest.fixture
def client(library):
    return TestClient(app)


class TestPerTrack:
    def test_no_lyric_yet_is_404_and_the_song_missing_is_404_too(self, client):
        assert client.get(f"/api/lyrics/{ALBUM}/{SONG}").status_code == 404
        assert client.get(f"/api/lyrics/{ALBUM}/nope.mp3").status_code == 404

    def test_none_has_a_validator_and_revalidates_without_a_body(self, client):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        missing = client.get(url)
        assert missing.status_code == 404
        assert missing.json() == {"detail": f"No lyrics for {ALBUM}/{SONG}"}
        etag = missing.headers["etag"]
        assert etag.startswith('"') and etag.endswith('"')
        current = client.get(url, headers={"If-None-Match": etag})
        assert current.status_code == 304 and current.content == b""
        assert current.headers["etag"] == etag
        client.put(url, json={"kind": "synced", "text": LRC})
        found = client.get(url, headers={"If-None-Match": etag})
        assert found.status_code == 200 and found.headers["etag"] != etag
        # A missing track is still missing even with a wildcard validator.
        assert client.get(f"/api/lyrics/{ALBUM}/nope.mp3", headers={"If-None-Match": "*"}).status_code == 404

    def test_strong_etag_revalidates_and_changes_on_save_and_offset(self, client):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        client.put(url, json={"kind": "synced", "text": LRC})
        first = client.get(url)
        etag = first.headers["etag"]
        assert etag == f'"{first.json()["revision"]}"'
        for validator in (etag, f'"unrelated", W/{etag}', "*"):
            current = client.get(url, headers={"If-None-Match": validator})
            assert current.status_code == 304 and current.content == b""
            assert current.headers["etag"] == etag
        client.put(url, json={"kind": "synced", "text": LRC + "[00:08] More words\n"})
        saved = client.get(url, headers={"If-None-Match": etag})
        assert saved.status_code == 200 and saved.headers["etag"] != etag
        edited = client.put(url + "/offset", json={"offsetMs": 500, "expectedRevision": saved.json()["revision"]})
        assert edited.status_code == 200
        offset = client.get(url, headers={"If-None-Match": saved.headers["etag"]})
        assert offset.status_code == 200 and offset.headers["etag"] != saved.headers["etag"]
        # Removing the sidecar returns to the same none representation.
        assert client.delete(url).status_code == 200
        assert client.get(url, headers={"If-None-Match": offset.headers["etag"]}).status_code == 404

    def test_a_traversal_never_reaches_the_filesystem(self, client):
        response = client.get("/api/lyrics/..%2F..%2Fetc/passwd")
        assert response.status_code in (404, 422)

    def test_put_writes_the_sidecar_and_get_reads_it_back(self, client, library):
        response = client.put(
            f"/api/lyrics/{ALBUM}/{SONG}",
            json={"kind": "synced", "text": LRC, "source": "lrclib", "providerRef": "lrclib:42"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["kind"] == "synced" and body["sidecar"] == "01 - 15 Step.lrc" and body["edited"] is False
        assert (library / ALBUM / "01 - 15 Step.lrc").read_text(encoding="utf-8") == LRC
        assert client.get(f"/api/lyrics/{ALBUM}/{SONG}").json()["text"] == LRC

    def test_an_edited_lyric_answers_409_until_forced(self, client):
        client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "plain", "text": "mine", "source": "manual", "edited": True})
        blocked = client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "synced", "text": LRC, "source": "lrclib"})
        assert blocked.status_code == 409
        forced = client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "synced", "text": LRC, "source": "lrclib", "force": True})
        assert forced.status_code == 200 and forced.json()["edited"] is False

    def test_an_unknown_kind_or_empty_text_is_422(self, client):
        assert client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "karaoke", "text": "x"}).status_code == 422
        assert client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "plain", "text": "   "}).status_code == 422

    def test_delete_removes_it(self, client, library):
        client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "synced", "text": LRC, "source": "lrclib"})
        assert client.delete(f"/api/lyrics/{ALBUM}/{SONG}").json() == {"success": True, "removed": True}
        assert not (library / ALBUM / "01 - 15 Step.lrc").exists()
        assert client.get(f"/api/lyrics/{ALBUM}/{SONG}").status_code == 404


class TestSearchAndPass:
    def test_search_lists_candidates_with_their_delta_and_writes_nothing(self, client, catalog, library):
        response = client.post("/api/lyrics/search", json={"album": ALBUM, "file": SONG})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["providers"] == ["lrclib"]
        assert body["candidates"][0]["providerRef"] == "lrclib:42"
        assert body["candidates"][0]["kind"] == "synced"
        assert body["candidates"][0]["preview"][0].startswith("[00:01.00]")
        assert not (library / ALBUM / "01 - 15 Step.lrc").exists()

    def test_jobs_snapshot_shape(self, client, catalog):
        body = client.get("/api/lyrics/jobs").json()
        assert set(body) >= {"autoFetch", "providers", "running", "queued", "withLyrics", "pendingCount", "pending", "lastRun"}
        assert body["autoFetch"] is False and body["running"] is None
        # The modal reads `engine` from here, so it must be the service view
        # (mode + queue), not the raw engine that ignores the agent path.
        assert body["engine"]["mode"] in ("local", "agent")
        assert body["engine"]["mode"] == client.get("/api/lyrics/engine").json()["mode"]
        assert "queue" in body["engine"]

    def test_pending_lists_every_song_the_jobs_preview_cuts_off(self, client, library):
        from app.domains.lyrics.models import PendingTrack
        from app.domains.lyrics.services import PENDING_PREVIEW

        repo = app.state.container.get_lyrics_service().repository
        n = PENDING_PREVIEW + 5
        for i in range(n):
            repo.mark_pending(PendingTrack(rel_path=f"Album/Song {i}.mp3", title=f"Song {i}", artist="A", tried_at=float(i)))
        assert len(client.get("/api/lyrics/jobs").json()["pending"]) == PENDING_PREVIEW
        body = client.get("/api/lyrics/pending").json()
        assert body["pendingCount"] == n and len(body["pending"]) == n
        assert body["pending"][0]["title"] == f"Song {n - 1}"  # newest first
        assert set(body["pending"][0]) == {"relPath", "title", "artist", "album", "triedAt", "reason"}

    def test_scan_mints_a_progress_id_the_stream_can_follow(self, client, catalog):
        response = client.post("/api/lyrics/scan")
        assert response.status_code == 200
        body = response.json()
        assert body["started"] is True and body["total"] == 1
        service = app.state.container.get_lyrics_service()
        for _ in range(500):
            state = service.progress_tracker.get_progress(body["progressId"])
            if state is not None and state.is_terminal:
                break
            import time
            time.sleep(0.01)
        assert state.is_terminal
        assert client.get("/api/lyrics/jobs").json()["withLyrics"] >= 0


class TestConfig:
    def test_the_switch_persists_to_env_and_applies_live(self, client, catalog, tmp_path, monkeypatch):
        monkeypatch.setattr(app.state.config, "credentials_dir", tmp_path / "credentials")
        (tmp_path / "credentials").mkdir()
        assert client.get("/api/lyrics/config").json() == {"autoFetch": False}
        response = client.put("/api/lyrics/config", json={"autoFetch": True})
        assert response.status_code == 200 and response.json() == {"autoFetch": True}
        assert "KROBI_LYRICS_AUTO_FETCH=true" in (tmp_path / ".env").read_text()
        assert app.state.config.lyrics_auto_fetch is True
        client.put("/api/lyrics/config", json={"autoFetch": False})
        assert "KROBI_LYRICS_AUTO_FETCH=false" in (tmp_path / ".env").read_text()


class TestAuth:
    def test_every_lyrics_route_is_closed_to_a_remote_caller(self, library, monkeypatch):
        from app.domains.accounts import auth as auth_module
        monkeypatch.setattr(app.state.config, "api_token", "secret")
        client = TestClient(app)
        headers = {"X-Forwarded-For": "10.0.0.7"}
        assert client.get("/api/lyrics/jobs", headers=headers).status_code == 401
        assert client.get(f"/api/lyrics/{ALBUM}/{SONG}", headers=headers).status_code == 401
        assert client.get("/api/lyrics/jobs", headers={"Authorization": "Bearer secret"}).status_code == 200
        del auth_module


class TestEngineRoutes:
    def test_quiet_worker_exhausts_leases_into_pending_and_finishes_progress(self, client, catalog, monkeypatch):
        from app.infra.jobs.queue import LEASE_STALE_S, MAX_ATTEMPTS

        monkeypatch.setattr(app.state.config, "lyrics_engine_mode", "agent", raising=False)
        service = app.state.container.get_lyrics_service()
        queue = service.agent_queue
        clock = [1000.0]
        monkeypatch.setattr(queue, "now", lambda: clock[0])
        monkeypatch.setattr(queue.worker, "now", lambda: clock[0])
        pid, total = service.transcribe([(f"{ALBUM}/{SONG}", None)])
        assert total == 1
        for _ in range(MAX_ATTEMPTS):
            assert len(queue.claim({"name": "Mac", "version": "0.10.0"})["jobs"]) == 1
            clock[0] += LEASE_STALE_S + 1
        assert queue.status()["running"] is None
        pending = client.get("/api/lyrics/pending").json()["pending"]
        assert pending[0]["relPath"] == f"{ALBUM}/{SONG}"
        assert pending[0]["reason"] == f"engine: el equipo dejó de responder {MAX_ATTEMPTS} veces"
        state = queue.progress_tracker.get_progress(pid)
        assert state.is_terminal and state.failed == 1 and state.completed == state.total == 1

    def test_status_shape_and_not_installed_refusals(self, client, catalog, tmp_path, monkeypatch):
        monkeypatch.setattr(app.state.config, "tools_dir", tmp_path / "tools")
        monkeypatch.setattr(app.state.config, "models_dir", tmp_path / "models")
        # Local mode is what this asserts. Off Apple Silicon (CI is Linux) the
        # default is agent mode, where /transcribe enqueues instead of refusing.
        monkeypatch.setattr(app.state.config, "lyrics_engine_mode", "local", raising=False)
        body = client.get("/api/lyrics/engine").json()
        assert set(body) >= {"supported", "installed", "ready", "hint", "installing", "running", "toolsDir", "modelsDir"}
        assert body["installed"] is False
        # The jobs snapshot carries the same block, so one poll feeds every screen.
        assert client.get("/api/lyrics/jobs").json()["engine"]["installed"] is False
        refused = client.post("/api/lyrics/transcribe", json={"tracks": [{"album": ALBUM, "file": SONG}]})
        assert refused.status_code == 409
        assert client.post("/api/lyrics/transcribe", json={"tracks": []}).status_code == 422
        assert client.post("/api/lyrics/transcribe/pending", json={}).status_code == 422  # nothing pending
        assert client.post("/api/lyrics/transcribe/nope/cancel").json() == {"cancelled": False}


    def test_explicit_text_realigns_manual_lrc_through_real_routes(self, client, catalog, monkeypatch):
        from app.domains.lyrics.models import lyrics_words
        monkeypatch.setattr(app.state.config, "lyrics_engine_mode", "agent", raising=False)
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        assert client.put(url, json={"kind": "synced", "text": LRC, "source": "manual", "edited": True}).status_code == 200
        response = client.post("/api/lyrics/transcribe", json={
            "tracks": [{"album": ALBUM, "file": SONG, "text": lyrics_words(LRC)}], "isolateVocals": True,
        })
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 1
        service = app.state.container.get_lyrics_service()
        claimed = service.agent_queue.claim({"name": "Mac", "version": "0.10.0"}, max_jobs=1)
        job = claimed["jobs"][0]
        assert job["text"] == lyrics_words(LRC)
        retimed = LRC.replace("00:01.00", "00:02.00")
        service.agent_queue.result(claimed["lease"], job["id"], ok=True, lrc=retimed,
                                   source="aligned:mms-fa", extra={"lineConfidence": [0.8, 0.1], "lowLines": [1]})
        doc = client.get(url).json()
        assert doc["text"] == retimed and doc["edited"] is True
        assert doc["lowLines"] == [1]


class TestDeletingTheSong:
    """``POST /api/delete-track`` takes the song's lyric with it."""

    def test_the_sidecar_and_the_index_row_go_with_the_audio_even_if_edited(self, client, library):
        service = app.state.container.get_lyrics_service()
        service.save(f"{ALBUM}/{SONG}", kind="synced", text=LRC, source="manual", edited=True)
        sidecar = library / ALBUM / "01 - 15 Step.lrc"
        assert sidecar.exists()

        response = client.post("/api/delete-track", json={"path": str(library / ALBUM / SONG)})

        assert response.status_code == 200
        assert not (library / ALBUM / SONG).exists()
        assert not sidecar.exists()
        assert client.get(f"/api/lyrics/{ALBUM}/{SONG}").status_code == 404
        assert f"{ALBUM}/{SONG}" not in service.repository.all_records()

    def test_a_song_with_no_lyric_still_deletes(self, client, library):
        app.state.container.get_lyrics_service()
        response = client.post("/api/delete-track", json={"path": str(library / ALBUM / SONG)})
        assert response.status_code == 200
        assert not (library / ALBUM / SONG).exists()


def test_catalog_failure_is_503_not_empty_results(client, catalog, monkeypatch):
    def unavailable(query):
        raise RuntimeError("HTTP 429")
    monkeypatch.setattr(catalog, "search_lyrics", unavailable)
    response = client.post("/api/lyrics/search", json={"album": ALBUM, "file": SONG})
    assert response.status_code == 503
    assert "LRCLIB: HTTP 429" in response.json()["detail"]


def test_search_rate_limit_includes_remaining_cooldown(client, catalog, monkeypatch):
    from app.domains.lyrics.lrclib_repository import CatalogRateLimited
    def blocked(*args, **kwargs):
        raise CatalogRateLimited(42)
    monkeypatch.setattr(catalog, "search_lyrics", blocked)
    response = client.post("/api/lyrics/search", json={"album": ALBUM, "file": SONG})
    assert response.status_code == 503
    assert response.headers["retry-after"] == "42"
    assert response.json() == {"detail": "LRCLIB: HTTP 429 Too Many Requests", "retryAfter": 42}


class TestConditionalLyricsSave:
    def test_stale_revision_cannot_overwrite_even_with_force(self, client):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        first = client.put(url, json={"kind": "synced", "text": LRC}).json()
        second = client.put(url, json={"kind": "plain", "text": "newer", "force": True}).json()
        rejected = client.put(url, json={"kind": "synced", "text": LRC, "force": True, "expectedRevision": first["revision"]})
        assert rejected.status_code == 409
        assert client.get(url).json()["revision"] == second["revision"]

    def test_current_revision_saves_and_changes_revision(self, client):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        first = client.put(url, json={"kind": "synced", "text": LRC}).json()
        result = client.put(url, json={"kind": "plain", "text": "mine", "expectedRevision": first["revision"]})
        assert result.status_code == 200
        assert result.json()["revision"] != first["revision"]

    def test_sidecar_edit_invalidates_revision(self, client, library):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        first = client.put(url, json={"kind": "synced", "text": LRC}).json()
        (library / ALBUM / "01 - 15 Step.lrc").write_text("[00:01.00]external edit", encoding="utf-8")
        result = client.put(url, json={"kind": "plain", "text": "mine", "expectedRevision": first["revision"]})
        assert result.status_code == 409

    def test_absent_revision_allows_create_but_not_replace(self, client):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        body = {"kind": "synced", "text": LRC, "expectedRevision": ""}
        assert client.put(url, json=body).status_code == 200
        assert client.put(url, json={**body, "force": True}).status_code == 409


def test_mac_waiting_deduplicates_pending_and_queue_and_includes_alignments(client, library):
    service = app.state.container.get_lyrics_service()
    from app.domains.lyrics.models import PendingTrack
    service.repository.mark_pending(PendingTrack(rel_path=f"{ALBUM}/{SONG}", title="15 Step", artist="Radiohead", album=ALBUM, tried_at=100.0))
    service.agent_queue.enqueue([
        {"relPath": f"{ALBUM}/{SONG}", "item": "15 Step"},
        {"relPath": "Other/plain.mp3", "item": "Known plain lyrics", "text": "Align me"},
    ])
    jobs = client.get('/api/lyrics/jobs').json()
    assert jobs['pendingCount'] == 1
    assert jobs['engine']['waiting'] == {"count": 2, "oldestAt": 100.0}


@pytest.fixture
def states_service(client, library, tmp_path, monkeypatch):
    from types import SimpleNamespace
    from app.infra.jobs import Jobs
    from app.infra.progress import ProgressTracker

    service = app.state.container.get_lyrics_service()
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    tracker = ProgressTracker(ledger)
    monkeypatch.setattr(service, 'progress_tracker', tracker)
    monkeypatch.setattr(service.agent_queue, 'progress_tracker', tracker)
    monkeypatch.setattr(service.agent_queue, 'ledger', ledger)
    monkeypatch.setattr(service, '_ensure_worker_locked', lambda: None)
    monkeypatch.setattr(service, 'registry', ProviderRegistry(store=None))
    monkeypatch.setattr(service.config, 'lyrics_engine_mode', 'agent')
    tracks = []
    for name in ['synced', 'plain', 'instrumental', 'pending', 'no-singing', 'queued', 'none']:
        path = library / ALBUM / f'{name}.mp3'
        path.write_bytes(b'audio')
        tracks.append(SimpleNamespace(path=path, title=name, artist='Artist', album=ALBUM, duration=120))
    monkeypatch.setattr(service.music_repository, 'scan_albums', lambda: [SimpleNamespace(name=ALBUM, tracks=tracks)])
    monkeypatch.setattr(service.music_repository, 'get_track_info', lambda path: next(t for t in tracks if t.path == path))
    yield service, ledger
    ledger.close()


def test_states_derivation_304_and_changes(client, states_service):
    from app.domains.lyrics.models import PendingTrack

    service, ledger = states_service
    for kind in ('synced', 'plain', 'instrumental'):
        service.save(f'{ALBUM}/{kind}.mp3', kind=kind, text=LRC if kind == 'synced' else 'words', source='manual')
    for name, reason in [('pending', 'no-results'), ('no-singing', 'engine: No se reconoció voz cantada en el audio; parece instrumental.')]:
        service.repository.mark_pending(PendingTrack(f'{ALBUM}/{name}.mp3', name, 'Artist', ALBUM, 1, reason))
    queued = service.agent_queue.enqueue([{'relPath': f'{ALBUM}/queued.mp3', 'item': 'Queued'}])
    first = client.get('/api/lyrics/states')
    assert first.status_code == 200
    expected = ['synced', 'plain', 'instrumental', 'pending', 'instrumental', 'queued', 'none']
    names = ['synced', 'plain', 'instrumental', 'pending', 'no-singing', 'queued', 'none']
    assert first.json()['states'] == {f'{ALBUM}/{name}.mp3': state for name, state in zip(names, expected, strict=True)}
    assert first.json()['counts'] == dict(synced=1, plain=1, instrumental=2, pending=1, queued=1, none=1)
    assert client.get('/api/lyrics/states', headers={'If-None-Match': first.headers['etag']}).status_code == 304
    ledger.cancel(queued, 1)
    service.agent_queue.cancel(queued)
    changed = client.get('/api/lyrics/states', headers={'If-None-Match': first.headers['etag']})
    assert changed.status_code == 200 and changed.json()['states'][f'{ALBUM}/queued.mp3'] == 'none'
    service.repository.mark_pending(PendingTrack(f'{ALBUM}/pending.mp3', 'pending', 'Artist', ALBUM, 2, 'engine: no singing'))
    assert client.get('/api/lyrics/states', headers={'If-None-Match': changed.headers['etag']}).json()['states'][f'{ALBUM}/pending.mp3'] == 'instrumental'


def test_states_and_scans_respect_member_scope(client, states_service):
    from app.domains.user_library.scope import LibraryScope, get_library_scope

    service, ledger = states_service
    mine = f'{ALBUM}/none.mp3'
    app.dependency_overrides[get_library_scope] = lambda: LibraryScope(frozenset([mine]))
    try:
        assert client.get('/api/lyrics/states').json()['states'] == {mine: 'none'}
        forbidden = client.post('/api/lyrics/scan', json={'tracks': [{'album': ALBUM, 'file': 'plain.mp3'}]})
        assert forbidden.status_code == 404 and not ledger.list()
        response = client.post('/api/lyrics/scan')
        assert response.status_code == 200 and response.json()['total'] == 1
        assert [j.rel_path for j in service._queue] == [mine]
    finally:
        app.dependency_overrides.pop(get_library_scope, None)


def test_selected_scan_conflict_and_ledger(client, states_service):
    service, ledger = states_service
    request = {'tracks': [{'album': ALBUM, 'file': 'none.mp3'}]}
    response = client.post('/api/lyrics/scan', json=request)
    assert response.status_code == 200
    job = response.json()['jobId']
    assert job == response.json()['progressId']
    assert [j.rel_path for j in service._queue] == [f'{ALBUM}/none.mp3']
    assert ledger.get(job)['kind'] == 'lyrics-search' and ledger.get(job)['label'] == 'none'
    assert client.get('/api/lyrics/states').json()['states'][f'{ALBUM}/none.mp3'] == 'queued'
    again = client.post('/api/lyrics/scan', json=request)
    assert again.status_code == 409 and again.json()['detail'] == {'reason': 'scan-running', 'jobId': job}
    service._process(service._queue.popleft())
    assert [p.rel_path for p in service.repository.pending()] == [f'{ALBUM}/none.mp3']
    assert ledger.items(job)[0]['reason'] == 'no-results'
    # Boot/retry dispatch uses _enqueue directly, preserving the same conflict handle.
    service._enqueue(service._tracks_without_lyrics({f'{ALBUM}/none.mp3'}), label='scan', progress_id='restored-search')
    assert client.post('/api/lyrics/scan', json=request).json()['detail']['jobId'] == 'restored-search'


@pytest.mark.parametrize('body', [None, {}, {'tracks': []}])
def test_empty_scan_preserves_whole_library_pass(client, states_service, body):
    service, ledger = states_service
    response = client.post('/api/lyrics/scan', **({'json': body} if body is not None else {}))
    assert response.status_code == 200 and response.json()['total'] == 7
    assert ledger.get(response.json()['jobId'])['label'] == '7 canciones'


def test_transcribe_skips_and_helper_ledger(client, states_service):
    service, ledger = states_service
    service.save(f'{ALBUM}/synced.mp3', kind='synced', text=LRC, source='manual', edited=True)
    response = client.post('/api/lyrics/transcribe', json={'tracks': [
        {'album': ALBUM, 'file': name + '.mp3'} for name in ('synced', 'none')]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['total'] == 1 and body['skipped'] == 1 and body['jobId'] == body['progressId']
    assert ledger.get(body['jobId'])['kind'] == 'lyrics-helper'
    assert ledger.get(body['jobId'])['label'] == 'Artist – none'
    assert [i['rel_path'] for i in ledger.items(body['jobId'])] == [f'{ALBUM}/none.mp3']
    assert client.post('/api/lyrics/transcribe', json={'tracks': [{'album': ALBUM, 'file': 'none.mp3'}]}).json()['jobId'] == body['jobId']
    skipped = client.post('/api/lyrics/transcribe', json={'tracks': [{'album': ALBUM, 'file': 'synced.mp3'}]})
    assert skipped.status_code == 200 and skipped.json()['skipped'] == 1 and skipped.json()['total'] == 0
    assert ledger.items(skipped.json()['jobId'])[0]['state'] == 'skipped'
    different = client.post('/api/lyrics/transcribe', json={'tracks': [{'album': ALBUM, 'file': 'synced.mp3', 'text': 'Different words'}]})
    assert different.status_code == 200 and different.json()['skipped'] == 1
    retime = client.post('/api/lyrics/transcribe', json={'tracks': [{'album': ALBUM, 'file': 'synced.mp3', 'text': LRC}]})
    assert retime.status_code == 200 and retime.json()['skipped'] == 0 and retime.json()['total'] == 1


def test_live_ledger_item_overlays_pending_and_terminal_items_do_not(client, states_service):
    from app.domains.lyrics.models import PendingTrack

    service, ledger = states_service
    rel = f'{ALBUM}/pending.mp3'
    service.repository.mark_pending(PendingTrack(rel, 'pending', 'Artist', ALBUM, 1, 'no-results'))
    job = ledger.start('lyrics-helper', 'pending', [{'item': 'pending', 'rel_path': rel}])
    assert client.get('/api/lyrics/states').json()['states'][rel] == 'queued'
    ledger.item_transition(job, 0, 1, 'done')
    ledger.finish(job, 1)
    assert client.get('/api/lyrics/states').json()['states'][rel] == 'pending'


def test_scan_ledger_failure_enqueues_nothing_and_releases_pass_lock(client, states_service, monkeypatch):
    service, ledger = states_service
    def fail(*args, **kwargs):
        raise OSError('ledger unavailable')
    monkeypatch.setattr(ledger, 'start', fail)
    response = client.post('/api/lyrics/scan', json={'tracks': [{'album': ALBUM, 'file': 'none.mp3'}]})
    assert response.status_code == 500
    assert not service._queue and not service._scan_running


class TestAddonAPI:
    def test_install_requires_engine_first(self, client, monkeypatch):
        engine = app.state.container.get_lyrics_service().engine
        monkeypatch.setattr(engine, 'check', lambda **kw: None)
        response = client.post('/api/lyrics/engine/install', json={'target': 'lyrics'})
        assert response.status_code == 409
        assert 'Install the engine first' in response.json()['detail']

    def test_unknown_addon_is_rejected(self, client):
        assert client.post('/api/lyrics/engine/install', json={'target': 'unknown'}).status_code == 422


def test_only_current_lyrics_are_exposed(client):
    url = f"/api/lyrics/{ALBUM}/{SONG}"
    client.put(url, json={"kind": "synced", "text": LRC, "source": "lrclib"})
    client.put(url, json={"kind": "plain", "text": "New words", "source": "genius"})
    assert client.get(url + "/previous").status_code == 404
    assert "previous" not in client.get(url).json()


def test_align_route_queues_text_without_replacing_current(client, monkeypatch):
    service = app.state.container.get_lyrics_service()
    monkeypatch.setattr(service, "engine_status", lambda: {"ready": True})
    monkeypatch.setattr(service.config, "lyrics_engine_mode", "agent")
    url = f"/api/lyrics/{ALBUM}/{SONG}"
    client.put(url, json={"kind": "synced", "text": LRC, "source": "manual", "edited": True})
    payload = {"album": ALBUM, "file": SONG, "text": "New words", "source": "genius"}
    assert client.post("/api/lyrics/align", json=payload).status_code == 409
    response = client.post("/api/lyrics/align", json={**payload, "force": True})
    assert response.status_code == 200 and response.json()["total"] == 1
    assert client.get(url).json()["text"] == LRC


def test_align_requires_text_and_a_ready_engine(client, monkeypatch):
    service = app.state.container.get_lyrics_service()
    monkeypatch.setattr(service, "engine_status", lambda: {"ready": False})
    payload = {"album": ALBUM, "file": SONG, "text": "New words", "source": "genius"}
    assert client.post("/api/lyrics/align", json={**payload, "text": ""}).status_code == 422
    response = client.post("/api/lyrics/align", json=payload)
    assert response.status_code == 409 and response.json()["detail"] == "Engine not ready"


def test_explicit_synced_selection_preserves_timing_even_for_a_fetch_offset_rule(client, monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr("app.domains.lyrics.services.demo_overrides.rule_for",
                        lambda *args: SimpleNamespace(lyrics_offset_s=5))
    response = client.put(f"/api/lyrics/{ALBUM}/{SONG}", json={"kind": "synced", "text": LRC, "source": "lrclib"})
    assert response.status_code == 200 and response.json()["text"] == LRC


def test_renderer_undo_restores_the_sidecar_and_full_record(client):
    service = app.state.container.get_lyrics_service()
    rel = f"{ALBUM}/{SONG}"
    before = service.save(rel, kind="synced", text=LRC, source="genius", provider_ref="g:42", edited=True,
                          line_confidence=[0.8], low_lines=[0], result={"timingSource": "aligned:mms-fa"}).to_dict()
    url = f"/api/lyrics/{ALBUM}/{SONG}"
    saved = client.put(url, json={"kind": "plain", "text": "Replacement", "source": "manual", "force": True}).json()
    payload = {key: before[key] for key in ("kind", "text", "source", "providerRef", "edited")}
    metadata = {key: before[key] for key in ("fetchedAt", "title", "artist", "lineConfidence", "lowLines", "result")}
    undo = {**payload, "restore": metadata, "force": True, "expectedRevision": saved["revision"]}
    response = client.put(url, json=undo)
    assert response.status_code == 200
    assert response.json() == before
    assert service.repository.read_sidecar(service.get(rel).record) == before["text"]
    # Undo is conditional; a later correction must win.
    assert client.put(url, json=undo).status_code == 409


def test_undo_of_first_save_cannot_delete_a_later_edit(client):
    url = f"/api/lyrics/{ALBUM}/{SONG}"
    saved = client.put(url, json={"kind": "plain", "text": "First", "source": "genius"}).json()
    latest = client.put(url, json={"kind": "plain", "text": "Correction", "source": "genius", "edited": True}).json()
    assert client.delete(url, params={"expectedRevision": saved["revision"]}).status_code == 409
    assert client.get(url).json() == latest
    assert client.delete(url, params={"expectedRevision": latest["revision"]}).status_code == 200
    assert client.get(url).status_code == 404


class TestOffset:
    def test_tag_only_preserves_index_and_metadata(self, client, library):
        service = app.state.container.get_lyrics_service()
        doc = service.save(f"{ALBUM}/{SONG}", kind="synced", text=LRC, source="aligned:test",
                           edited=False, line_confidence=[0.9, 0.1], low_lines=[1],
                           result={"timingSource": "test", "durationDeltaSeconds": 0.2})
        index = service.repository.index_path
        before = index.read_bytes()
        original = doc.to_dict()
        url = f"/api/lyrics/{ALBUM}/{SONG}/offset"
        response = client.put(url, json={"offsetMs": 500, "expectedRevision": original["revision"]})
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved["text"] == "[offset:+500]\n" + LRC
        assert saved["offsetMs"] == 500
        assert saved["revision"] != original["revision"]
        assert {k: v for k, v in saved.items() if k not in ("text", "offsetMs", "revision")} == {
            k: v for k, v in original.items() if k not in ("text", "offsetMs", "revision")}
        assert index.read_bytes() == before
        assert client.get(url.removesuffix("/offset")).json() == saved
        assert client.put(url, json={"offsetMs": -100, "expectedRevision": original["revision"]}).status_code == 409
        assert index.read_bytes() == before
        reset = client.put(url, json={"offsetMs": 0, "expectedRevision": saved["revision"]})
        assert reset.json()["text"] == LRC
        assert reset.json()["offsetMs"] == 0
        assert index.read_bytes() == before

    def test_missing_plain_and_invalid_values(self, client):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        assert client.put(url + "/offset", json={"offsetMs": 500}).status_code == 404
        assert client.put(url, json={"kind": "plain", "text": "Words"}).status_code == 200
        assert client.put(url + "/offset", json={"offsetMs": 500}).status_code == 422
        for value in [600001, -600001, 0.5, "500", True]:
            assert client.put(url + "/offset", json={"offsetMs": value}).status_code == 422

    def test_shared_tag_contract(self):
        import json
        from pathlib import Path
        from app.domains.lyrics.offset import set_offset

        cases = json.loads((Path(__file__).resolve().parents[3] / "contracts/lyrics-offset.json").read_text())
        for case in cases["setOffset"]:
            assert set_offset(case["text"], case["offsetMs"]) == case["expected"], case["name"]

    def test_replaces_tag_preserving_crlf_and_accepts_limit(self, client, library):
        url = f"/api/lyrics/{ALBUM}/{SONG}"
        assert client.put(url, json={"kind": "synced", "text": LRC}).status_code == 200
        sidecar = library / ALBUM / "01 - 15 Step.lrc"
        text = "[ti:Song]\r\n[offset:+500]\r\n[00:00.20]<00:00.20>Early\r\n"
        sidecar.write_bytes(text.encode())
        response = client.put(url + "/offset", json={"offsetMs": -600000})
        assert response.status_code == 200, response.text
        assert sidecar.read_bytes() == text.replace("[offset:+500]", "[offset:-600000]").encode()
        assert response.json()["offsetMs"] == -600000
