"""Member boundaries and acquisition links through the real HTTP/auth stack.

Only external work (catalogs, network downloads, VLC and ffmpeg) is replaced.
Every library, token table, sidecar, playlist and user-track row is temporary.
"""
import asyncio
from contextvars import copy_context
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TIT2, TPE1, TALB

from app.infra.progress import progress_principal
from app.dependencies import DependencyContainer
from app.domains.accounts.identity import ANONYMOUS, LEGACY_OWNER, LOCAL_OWNER, UNKNOWN
from app.domains.downloads.core import ResolvedVideo
from app.domains.downloads.models import DownloadResult, TrackDownloadRequest
from app.domains.lyrics.models import PendingTrack
from app.domains.playlists.models import PlaylistTrack
from app.domains.user_library.scope import LibraryScope
from app.main import app

pytestmark = pytest.mark.integration


@pytest.fixture
def house(config, tmp_path, monkeypatch):
    for key, value in {
        "users_file": tmp_path / "users.json", "user_tracks_file": tmp_path / "user_tracks.json",
        "lyrics_file": tmp_path / "lyrics.json", "stems_dir": tmp_path / "stems",
        "lyrics_engine_mode": "agent", "lyrics_auto_fetch": False, "api_token": None,
        "allow_unauthenticated_remote": False,
    }.items():
        monkeypatch.setattr(config, key, value)
    container = DependencyContainer(config)
    from app.providers.registry import ProviderDescriptor, ProviderKind
    from app.providers.adapters import SourceStreamingProvider
    port = SimpleNamespace(id='youtube', manifest={'name': 'Test Source'}, state='on', reason=None,
                           url_hosts=frozenset({'youtube.com', 'www.youtube.com', 'youtu.be'}),
                           ready=lambda: True, close=lambda: None, call=lambda *args: {})
    container.get_provider_registry().register(ProviderDescriptor(id='youtube', name='Test Source',
        kind=ProviderKind.STREAMING, description=''), SourceStreamingProvider(port))
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(app.state, "container", container)
    clients = {}
    records = {}
    for role, label in [("owner", "owner"), ("member", "member"), ("member", "other")]:
        record, token = container.get_token_store().mint(label, role)
        clients[label] = TestClient(app, headers={"Authorization": f"Bearer {token}"})
        records[label] = record
    music = config.base_music_dir
    (music / "Album").mkdir()
    for filename in ("mine.mp3", "hidden.mp3"):
        audio = music / "Album" / filename
        audio.write_bytes((b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40)
        tags = ID3()
        tags.add(TIT2(encoding=3, text=audio.stem))
        tags.add(TPE1(encoding=3, text="Artist"))
        tags.add(TALB(encoding=3, text="Album"))
        tags.save(audio)
    rows = container.get_user_track_store()
    rows.add_many(records["member"].user_id, ["Album/mine.mp3"])
    jobs = []

    def queue(coro):
        jobs.append((copy_context(), coro))

    def drain():
        while jobs:
            context, coro = jobs.pop(0)
            context.run(asyncio.run, coro)

    monkeypatch.setattr("app.domains.downloads.routes.spawn_background", queue)
    monkeypatch.setattr("app.domains.playlists.export_import.spawn_background", queue)
    h = SimpleNamespace(config=config, container=container, rows=rows, music=music,
                        member=clients["member"], owner=clients["owner"], other=clients["other"],
                        uid=records["member"].user_id, records=records, drain=drain)
    yield h
    for _, coro in jobs:
        coro.close()
    for client in clients.values():
        client.close()


def test_scope_sentinels_and_real_roles(house):
    for principal in (ANONYMOUS, LEGACY_OWNER, LOCAL_OWNER,
                      house.records["owner"].principal()):
        scope = LibraryScope.for_principal(principal, house.rows)
        assert scope.unrestricted and scope.allows("Album/hidden.mp3")
    for principal in (None, UNKNOWN):
        scope = LibraryScope.for_principal(principal, house.rows)
        assert not scope.unrestricted and not scope.allows('Album/hidden.mp3')
    scope = LibraryScope.for_principal(house.records["member"].principal(), house.rows)
    assert not scope.unrestricted
    assert scope.allows("Album/mine.mp3") and scope.allows_album("Album")
    assert not scope.allows("Album/hidden.mp3") and not scope.allows_album("Secret")


def test_lyrics_track_boundary_matches_missing_and_never_mutates_hidden(house):
    path = "/api/lyrics/Album/hidden.mp3"
    body = {"kind": "plain", "text": "private lyrics"}
    assert house.owner.put(path, json=body).status_code == 200
    for method, payload in [("get", {}), ("put", {"json": body})]:
        denied = getattr(house.member, method)(path, **payload)
        # Compare the exact answer for the same path with its audio/sidecar absent.
        audio = house.music / "Album/hidden.mp3"
        sidecar = audio.with_suffix(".txt")
        audio.unlink()
        sidecar.unlink()
        service = house.container.get_lyrics_service()
        service.repository.remove_record("Album/hidden.mp3")
        missing = getattr(house.owner, method)(path, **payload)
        assert (denied.status_code, denied.json()) == (missing.status_code, missing.json())
        audio.write_bytes(b"ID3")
        assert house.owner.put(path, json=body).status_code == 200
    assert house.member.delete(path).json() == {"success": True, "removed": False}
    assert house.owner.get(path).json()["text"] == "private lyrics\n"
    assert house.member.delete("/api/lyrics/Album/absent.mp3").json() == house.member.delete(path).json()
    assert house.member.put("/api/lyrics/Album/mine.mp3", json=body).status_code == 200
    assert house.member.get("/api/lyrics/Album/mine.mp3").status_code == 200
    assert house.member.delete("/api/lyrics/Album/mine.mp3").json()["removed"] is True


def test_lyrics_pending_transcription_and_owner_only_management(house, monkeypatch):
    service = house.container.get_lyrics_service()
    for filename in ("mine.mp3", "hidden.mp3"):
        service.repository.mark_pending(PendingTrack(
            rel_path=f"Album/{filename}", title=filename, artist="Artist", album="Album", tried_at=1, reason="none",
        ))
    assert house.member.get("/api/lyrics/pending").json()["pendingCount"] == 1
    assert house.owner.get("/api/lyrics/pending").json()["pendingCount"] == 2
    mine = house.member.get("/api/lyrics/jobs")
    assert mine.status_code == 200
    assert mine.json()["pendingCount"] == 1 and [p["relPath"] for p in mine.json()["pending"]] == ["Album/mine.mp3"]
    assert mine.json()["engine"]["waiting"]["count"] == 1
    assert mine.json()["running"] is None and mine.json()["lastRun"] is None
    assert house.owner.get("/api/lyrics/jobs").json()["pendingCount"] == 2
    monkeypatch.setattr(service, "transcribe", lambda *a, **kw: ("engine-job", 1))
    monkeypatch.setattr(service, "transcribe_pending", lambda **kw: ("all", 2))
    monkeypatch.setattr(service, "cancel_processing", lambda pid: True)
    for method, path, payload in [
        ("post", "/transcribe/pending", {"json": {}}),
        ("post", "/transcribe/all/cancel", {}),
    ]:
        assert getattr(house.member, method)("/api/lyrics" + path, **payload).status_code == 403
        assert getattr(house.owner, method)("/api/lyrics" + path, **payload).status_code == 200
    def transcribe(client, file):
        return client.post("/api/lyrics/transcribe", json={"tracks": [{"album": "Album", "file": file}]})
    assert transcribe(house.member, "mine.mp3").status_code == 200
    assert transcribe(house.member, "hidden.mp3").json() == {"detail": "Track not found: Album/hidden.mp3"}
    assert transcribe(house.member, "missing.mp3").status_code == 404
    assert transcribe(house.owner, "hidden.mp3").status_code == 200



def test_lyrics_scan_passes_only_the_callers_scope(house, monkeypatch):
    from app.domains.lyrics.models import ScanSummary

    service = house.container.get_lyrics_service()
    calls = []
    def scan(tracks=None, *, allows=None):
        calls.append((tracks, allows('Album/mine.mp3'), allows('Album/hidden.mp3')))
        return ScanSummary(progress_id='scan-job', total=1)
    monkeypatch.setattr(service, 'start_scan', scan)
    assert house.member.post('/api/lyrics/scan').status_code == 200
    assert calls[-1] == (None, True, False)
    assert house.member.post('/api/lyrics/scan', json={'tracks': [{'album': 'Album', 'file': 'mine.mp3'}]}).status_code == 200
    assert calls[-1] == (['Album/mine.mp3'], True, False)
    before = len(calls)
    assert house.member.post('/api/lyrics/scan', json={'tracks': [{'album': 'Album', 'file': 'hidden.mp3'}]}).status_code == 404
    assert len(calls) == before
    assert house.owner.post('/api/lyrics/scan').status_code == 200
    assert calls[-1] == (None, True, True)


def test_stems_jobs_manifest_and_stream_are_scoped(house, monkeypatch):
    service = house.container.get_stems_service()
    for filename in ("mine.mp3", "hidden.mp3"):
        assert house.owner.post("/api/stems/request", json={"album": "Album", "file": filename}).status_code == 200
    assert len(house.owner.get("/api/stems/jobs").json()["jobs"]) == 2
    assert [j["file"] for j in house.member.get("/api/stems/jobs").json()["jobs"]] == ["mine.mp3"]
    assert house.owner.get("/api/stems/Album/hidden.mp3").status_code == 202
    assert house.member.get("/api/stems/Album/hidden.mp3").json() == {"detail": "No stems requested for Album/hidden.mp3"}
    monkeypatch.setattr(service, "status", lambda *a: (200, {"track": "ready"}))
    stem = house.config.stems_dir / "drums.ogg"
    stem.parent.mkdir(exist_ok=True)
    stem.write_bytes(b"OggS" * 40)
    monkeypatch.setattr(service, "stem_file", lambda *a: stem)
    for client in (house.member, house.owner):
        assert client.get("/api/stems/Album/mine.mp3").status_code == 200
        assert client.get("/api/stems/Album/mine.mp3/drums").content == stem.read_bytes()
    assert house.owner.get("/api/stems/Album/hidden.mp3/drums").status_code == 200
    assert house.member.get("/api/stems/Album/hidden.mp3/drums").json() == {"detail": "No drums stem for Album/hidden.mp3"}
    assert house.member.get("/api/stems/Album/missing.mp3/drums").status_code == 404


def playlist(house, *, tracks=("mine.mp3", "hidden.mp3"), source_url=None):
    service = house.container.get_playlist_service()
    p = service.create_playlist("Mine", owner_id=house.uid)
    p.tracks = [PlaylistTrack(path=house.music / "Album" / f, title=f) for f in tracks]
    p.source_url = source_url
    service.playlist_repo.save_playlist(p)
    return service


def test_playlist_reads_and_writes_respect_membership(house):
    playlist(house)
    assert len(house.owner.get("/api/playlists/Mine").json()["tracks"]) == 2
    assert len(house.member.get("/api/playlists/Mine").json()["tracks"]) == 1
    assert house.member.get("/api/playlists").json()[0]["trackCount"] == 1
    for filename in ("hidden.mp3", "missing.mp3"):
        response = house.member.put("/api/playlists/Mine/tracks", json=[{
            "path": str(house.music / "Album" / filename), "title": "any",
        }])
        assert response.status_code == 404
        assert response.json() == {"detail": f"Track not found: {house.music / 'Album' / filename}"}
    assert len(house.owner.get("/api/playlists/Mine").json()["tracks"]) == 2
    assert house.owner.put("/api/playlists/Mine/tracks", json=[{
        "path": str(house.music / "Album/hidden.mp3"), "title": "any",
    }]).status_code == 200
    assert house.member.put("/api/playlists/Mine/tracks", json=[{
        "path": str(house.music / "Album/mine.mp3"), "title": "any",
    }]).json()["playlist"]["track_count"] == 1
    # These schemas accept no track mutations, including when extras are sent.
    assert house.member.post("/api/playlists", json={"name": "Empty", "tracks": ["Album/hidden.mp3"]}).json()["playlist"]["tracks"] == []
    assert house.member.patch("/api/playlists/Mine", json={"new_name": "Renamed", "tracks": ["Album/hidden.mp3"]}).status_code == 200
    assert len(house.member.get("/api/playlists/Renamed").json()["tracks"]) == 1


@pytest.mark.parametrize("role", ["member", "owner"])
@pytest.mark.parametrize("route", ["/api/refresh-playlist/Mine", "/api/playlists/Mine/refresh"])
def test_playlist_refresh_links_existing_tracks(house, monkeypatch, role, route):
    playlist(house, source_url="https://example.test/list")
    service = house.container.get_download_service()
    monkeypatch.setattr(service, "get_playlist_tracks_from_url", lambda url: ("Mine", [{"name": "hidden.mp3"}]))
    response = getattr(house, role).post(route)
    assert response.status_code == 200, response.text
    uid = house.records[role].user_id
    assert house.rows.get(uid, "Album/hidden.mp3") is not None


def test_playlist_source_refresh_links_new_results(house, monkeypatch):
    playlist(house, tracks=("mine.mp3",), source_url="https://example.test/list")
    service = house.container.get_download_service()
    monkeypatch.setattr(service, "get_playlist_tracks_from_url", lambda url: ("Mine", [{"name": "new"}]))
    result = DownloadResult(True, house.music / "Album/hidden.mp3")
    monkeypatch.setattr(service.spotify_adapter, "download_playlist", AsyncMock(return_value=[result]))
    assert house.member.post("/api/refresh-playlist/Mine").json()["added"] == 1
    assert house.rows.get(house.uid, "Album/hidden.mp3") is not None


@pytest.mark.parametrize("role", ["member", "owner"])
@pytest.mark.parametrize("route,body,method", [
    ("/api/download-album-song", {"genius_url": "https://genius.com/albums/A/B", "titulos": [{"title": "hidden", "track_number": 1}], "album": "Album", "artista": "Artist", "cover_url": "https://example.test/cover"}, "download_from_genius"),
    ("/api/download", {"genius_url": "https://genius.com/albums/A/B", "titulos": [{"title": "hidden", "track_number": 1}], "album": "Album", "artista": "Artist", "cover_url": "https://example.test/cover"}, "download_from_genius"),
    ("/api/download-single-song", {"genius_url": "https://genius.com/A-B-lyrics"}, "download_from_genius"),
    ("/api/download-youtube-url", {"url": "https://youtube.com/watch?v=abc"}, "download_from_url"),
    ("/api/download-search", {"search_term": "hidden"}, "download_from_search"),
    ("/api/download-spotify-playlist", {"tracks": [{"title": "hidden", "album": "Album"}]}, "download_spotify_playlist"),
    ("/api/import-playlist-url", {"playlist_url": "https://example.test/list"}, "import_playlist_from_url"),
    ("/api/playlists/spotify-export/import", {"playlistName": "Imported", "tracks": [{"title": "hidden", "album": "Album"}]}, "download_spotify_playlist"),
])
def test_every_download_entry_links_successful_existing_results(house, monkeypatch, role, route, body, method):
    service = house.container.get_download_service()
    result = DownloadResult(True, house.music / "Album/hidden.mp3", title="hidden")
    value = result if method in ("download_from_url", "download_from_search") else [result]
    if method == "import_playlist_from_url":
        value = ("Imported", [result])
    monkeypatch.setattr(service, method, AsyncMock(return_value=value))
    response = getattr(house, role).post(route, json=body)
    assert response.status_code == 200, response.text
    house.drain()
    assert house.rows.get(house.records[role].user_id, "Album/hidden.mp3") is not None
    assert house.rows.get(house.records[role].user_id, "Album/hidden.mp3").acquired is True


def test_dedupe_on_export_import_links_without_downloading_or_revealing_hit(house, monkeypatch):
    service = house.container.get_download_service()
    # The file is already on disk but the member has never held it.
    resolve = AsyncMock(side_effect=AssertionError("dedupe must not search or download"))
    monkeypatch.setattr(service.engine, "_resolve_source_url", resolve)
    response = house.member.post("/api/playlists/spotify-export/import", json={
        "playlistName": "Collection", "tracks": [{"title": "hidden", "artist": "Artist", "album": "Album"}],
    })
    assert response.status_code == 200
    assert not any(k in response.json() for k in ("alreadyPresent", "already", "skipped"))
    house.drain()
    assert house.rows.get(house.uid, "Album/hidden.mp3") is not None
    assert house.rows.get(house.uid, "Album/hidden.mp3").acquired is False
    resolve.assert_not_called()
    job = house.container.get_progress_tracker().get_progress(response.json()["progress_id"])
    assert job.succeeded == 1 and job.failed == 0
    imported = house.member.get("/api/playlists/Collection").json()
    assert Path(imported["tracks"][0]["path"]).resolve() == (house.music / "Album/hidden.mp3").resolve()
    assert len(list(house.music.rglob("hidden.mp3"))) == 1


def test_active_downloads_are_attributed_through_background_engine_and_sync_threads(house, monkeypatch):
    service = house.container.get_download_service()
    async def batch(*args, **kwargs):
        # Child jobs created after the HTTP request retains its initiator context.
        await asyncio.to_thread(
            service.progress_tracker.create_progress, f"child-{progress_principal.get().user_id}", 1,
        )
        return []
    monkeypatch.setattr(service, "download_spotify_playlist", batch)
    member = house.member.post("/api/download-spotify-playlist", json={"tracks": [{"title": "song"}]}).json()
    owner = house.owner.post("/api/download-spotify-playlist", json={"tracks": [{"title": "song"}]}).json()
    house.drain()
    service.progress_tracker.create_progress("unattributed", 1)
    mine = house.member.get("/api/downloads/active").json()
    assert {j["progress_id"] for j in mine["jobs"]} == {member["progress_id"], f"child-{house.uid}"}
    assert house.other.get("/api/downloads/active").json()["count"] == 0
    assert house.owner.get("/api/downloads/active").json()["count"] == 5
    assert house.member.get(f"/api/download-progress/{member['progress_id']}").status_code == 200
    for route in ("download-progress", "download-progress-stream"):
        denied = house.member.get(f"/api/{route}/{owner['progress_id']}")
        missing = house.member.get(f"/api/{route}/unknown")
        assert (denied.status_code, denied.json()) == (missing.status_code, missing.json())
    assert service.progress_tracker.get_progress(owner["progress_id"]).starter_user_id == house.records["owner"].user_id
    assert "starter_user_id" not in mine["jobs"][0]
    assert progress_principal.get() is None


def test_retry_links_and_does_not_allow_another_members_job(house, monkeypatch):
    service = house.container.get_download_service()
    tracker = house.container.get_progress_tracker()
    token = progress_principal.set(house.records['member'].principal())
    try:
        tracker.create_progress("failed", 1)
    finally:
        progress_principal.reset(token)
    request = TrackDownloadRequest(youtube_url="https://youtube.com/watch?v=x", destination=house.music / "Album")
    monkeypatch.setattr(service.engine, "retry_request", lambda *a: request)
    monkeypatch.setattr(service.engine, "download_multiple_tracks", AsyncMock(return_value=[DownloadResult(True, house.music / "Album/hidden.mp3")]))
    body = {"progress_id": "failed", "index": 0, "youtube_url": "https://youtube.com/watch?v=x"}
    assert house.other.post("/api/downloads/retry", json=body).status_code == 404
    response = house.member.post("/api/downloads/retry", json=body)
    assert response.status_code == 200, response.text
    house.drain()
    assert house.rows.get(house.uid, "Album/hidden.mp3") is not None
    assert tracker.get_progress(response.json()["progress_id"]).starter_user_id == house.uid
    assert house.owner.post("/api/downloads/retry", json=body).status_code == 200
    house.drain()


def test_transfers_select_only_member_tracks_and_match_missing(house, monkeypatch):
    service = house.container.get_transfer_service()
    send = Mock()
    monkeypatch.setattr(service, "send_to_vlc", send)
    body = {"paths": [str(house.music / "Album/hidden.mp3")], "vlc_ip": "192.0.2.5"}
    denied = house.member.post("/api/upload-selected-vlc", json=body)
    (house.music / "Album/hidden.mp3").unlink()
    missing = house.owner.post("/api/upload-selected-vlc", json=body)
    assert (denied.status_code, denied.json()) == (missing.status_code, missing.json())
    send.assert_not_called()
    (house.music / "Album/hidden.mp3").write_bytes(b"ID3")
    assert house.owner.post("/api/upload-selected-vlc", json=body).status_code == 200
    body["paths"] = [str(house.music / "Album/mine.mp3")]
    assert house.member.post("/api/upload-selected-vlc", json=body).status_code == 200
    assert house.member.post("/api/upload-audio-vlc?vlc_ip=192.0.2.5").status_code == 200
    assert send.call_args.kwargs["files"] == [(house.music / "Album/mine.mp3").resolve()]
    assert house.owner.post("/api/upload-audio-vlc?vlc_ip=192.0.2.5").status_code == 200
    assert len(send.call_args.kwargs["files"]) == 2




def test_member_root_download_gets_linkable_album_owner_keeps_destination(house, monkeypatch):
    engine = house.container.get_download_service().engine
    monkeypatch.setattr(engine, "_resolve_source_url", AsyncMock(return_value=ResolvedVideo("https://youtube.com/watch?v=x")))
    async def build(request, **kwargs):
        output = request.destination / "new.mp3"
        output.parent.mkdir(exist_ok=True)
        output.write_bytes(b"ID3")
        return output
    monkeypatch.setattr(engine, "_build_in_staging", build)
    for role, expected in [("member", "Singles/new.mp3"), ("owner", "new.mp3")]:
        response = getattr(house, role).post("/api/download-search", json={"search_term": "new song"})
        assert response.status_code == 200, response.text
        assert response.json()["file_path"] == str(house.music / expected)
    assert house.rows.get(house.uid, "Singles/new.mp3") is not None


def test_startup_drops_rows_of_deleted_accounts(house):
    from app.main import _prune_orphan_library_rows

    store = house.container.get_user_track_store()
    store.add_many("deleted-long-ago", ["Album/mine.mp3"])
    _prune_orphan_library_rows()
    assert store.list_for_user("deleted-long-ago") == []
    assert [r.rel_path for r in store.list_for_user(house.uid)] == ["Album/mine.mp3"]


def test_lyrics_alignment_does_not_reveal_another_members_song(house):
    url = "/api/lyrics/Album/hidden.mp3"
    house.owner.put(url, json={"kind": "plain", "text": "Private current", "source": "genius"})
    for client in (house.member, house.other):
        assert client.get(url).status_code == 404
        assert client.post("/api/lyrics/align", json={
            "album": "Album", "file": "hidden.mp3", "text": "Other words", "source": "manual", "force": True,
        }).status_code == 404
