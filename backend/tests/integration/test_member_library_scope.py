"""Real tokens and tmp tagged audio exercise the shared routes' member boundary."""
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import time

import pytest
from fastapi.testclient import TestClient
from mutagen.easyid3 import EasyID3
from mutagen.mp3 import MP3

from app.dependencies import DependencyContainer, get_dashboard_service, get_provider_registry
from app.domains.dashboard.models import Dashboard, DashboardItem, DashboardRow
from app.domains.dashboard.services import YOUR_ARTISTS_ROW_ID
from app.domains.downloads.models import DownloadResult
from app.domains.downloads.services import DownloadService
from app.main import app

FRAME = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40
OWN = "Artist∕Album/CD1∕own.mp3"
OTHER = "Artist∕Album/other.mp3"
HIDDEN = "Hidden/secret.mp3"


def write_song(path: Path, title: str, artist: str, album: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(FRAME)
    song = MP3(path, ID3=EasyID3)
    song.add_tags()
    song["title"], song["artist"], song["album"] = title, artist, album
    song.save()


@pytest.fixture
def house(config, monkeypatch):
    monkeypatch.setattr(app.state, "config", config)
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, "container", container)
    base = config.base_music_dir
    write_song(base / "Artist/Album/CD1/own.mp3", "Mine", "Artist", "Album")
    write_song(base / "Artist/Album/other.mp3", "Other", "Artist", "Album")
    write_song(base / "Hidden/secret.mp3", "Secret", "Hidden Artist", "Hidden")
    for album in (base / "Artist/Album", base / "Hidden"):
        (album / "cover.jpg").write_bytes(b"\xff\xd8\xff\xe0")
    tokens = container.get_token_store()
    ana, member_token = tokens.mint("Ana", "member")
    owner, owner_token = tokens.mint("Owner", "owner")
    tracks = container.get_user_track_store()
    tracks.add_many(ana.user_id, [OWN])
    tracks.add_many(owner.user_id, [OWN, OTHER, HIDDEN])
    headers = {"Authorization": f"Bearer {member_token}"}
    owner_headers = {"Authorization": f"Bearer {owner_token}"}
    client = TestClient(app, client=("192.0.2.42", 50000))
    return client, base, container, headers, owner_headers, ana, owner


def test_listings_and_summary_filter_tracks_drop_empty_albums_and_preserve_owner(house):
    client, base, _, member, owner, *_ = house
    assert client.get("/api/listar-albums", headers=member).json() == {"albums": ["Album"]}
    for covers in ("true", "false"):
        listing = client.get(f"/api/listar-albums-con-metadata?covers={covers}", headers=member)
        assert listing.status_code == 200
        albums = listing.json()
        assert len(albums) == 1
        assert [t["relPath"] for t in albums[0]["tracks"]] == [OWN]
        assert albums[0]["duration"] == albums[0]["tracks"][0]["duration"]
    assert client.get("/api/library/summary", headers=member).json() == {
        "folder": str(base), "songs": 1, "albums": 1, "artists": 1,
    }
    owner_listing = client.get("/api/listar-albums-con-metadata?covers=false", headers=owner).json()
    assert {t["relPath"] for a in owner_listing for t in a["tracks"]} == {OWN, OTHER, HIDDEN}
    assert set(client.get("/api/listar-albums", headers=owner).json()["albums"]) == {"Album", "Hidden"}
    summary = client.get("/api/library/summary", headers=owner).json()
    assert (summary["songs"], summary["albums"], summary["artists"]) == (3, 2, 2)


@pytest.mark.parametrize("rel_path", [OTHER, HIDDEN])
@pytest.mark.parametrize("route", [
    "/api/media/{}", "/api/waveform/{}", "/api/wavesurfer-peaks/{}",
])
def test_disallowed_file_is_identical_to_the_same_file_missing(house, route, rel_path):
    client, base, _, member, owner, *_ = house
    denied = client.get(route.format(rel_path), headers=member)
    assert denied.status_code == 404
    path = base / rel_path.replace("∕", "/")
    path.unlink()
    missing = client.get(route.format(rel_path), headers=owner)
    assert (denied.status_code, denied.json()) == (missing.status_code, missing.json())


def test_own_and_owner_media_work_and_scope_precedes_conditional_cache(house):
    client, _, _, member, owner, *_ = house
    own = client.get(f"/api/media/{OWN}", headers=member)
    assert own.status_code == 200 and own.content.startswith(b"ID3")
    assert client.get(f"/api/media/{OWN}", headers={**member, "Range": "bytes=0-9"}).status_code == 206
    other = client.get(f"/api/media/{OTHER}", headers=owner)
    assert other.status_code == 200
    denied = client.get(f"/api/media/{OTHER}", headers={**member, "If-None-Match": other.headers["etag"]})
    assert denied.status_code == 404


def test_cover_requires_one_allowed_track_in_the_album(house):
    client, base, _, member, owner, *_ = house
    assert client.get("/api/media/Artist∕Album/cover.jpg", headers=member).status_code == 200
    hidden = "/api/media/Hidden/cover.jpg"
    assert client.get(hidden, headers=owner).status_code == 200
    denied = client.get(hidden, headers=member)
    (base / "Hidden/cover.jpg").unlink()
    (base / "Hidden/secret.mp3").unlink()
    (base / "Hidden").rmdir()
    missing = client.get(hidden, headers=owner)
    assert (denied.status_code, denied.json()) == (missing.status_code, missing.json())


def test_allowed_waveforms_reach_services(house, monkeypatch):
    client, _, container, member, *_ = house
    music = container.get_music_service()
    waveform = Mock(return_value=[0, 0.5])
    monkeypatch.setattr(music, "generate_waveform", waveform)
    assert client.get(f"/api/waveform/{OWN}", headers=member).json()["waveform"] == [0, 0.5]
    assert client.get(f"/api/wavesurfer-peaks/{OWN}", headers=member).json()["data"] == [[0, 0.5]]
    waveform.assert_called()


@pytest.mark.parametrize("rel_path", [OWN, OTHER, HIDDEN, "Absent/missing.mp3"])
def test_file_deletion_rejects_members_without_changing_rows_or_files(house, rel_path):
    client, base, container, member, _, account, owner = house
    store = container.get_user_track_store()
    path = base / rel_path.replace("∕", "/")
    before = path.read_bytes() if path.exists() else None
    response = client.post("/api/delete-track", json={"path": str(path.resolve())}, headers=member)
    assert response.status_code == 403
    assert store.get(account.user_id, OWN) is not None
    assert store.get(owner.user_id, OWN) is not None
    assert (path.read_bytes() if path.exists() else None) == before


@pytest.mark.parametrize("rel_path", [OWN, OTHER, "Absent/missing.mp3"])
@pytest.mark.parametrize("route", ["/api/library/move-track", "/api/update-tags"])
def test_members_cannot_move_or_retag_shared_files(house, route, rel_path):
    client, base, _, member, *_ = house
    response = client.post(route, json={"path": str(base / rel_path.replace("∕", "/"))}, headers=member)
    assert response.status_code == 403


NEST_WIDE = [
    ("put", "/api/providers/lrclib", {"enabled": True}),
    ("put", "/api/providers/lyrics/order", {"order": ["lrclib"]}),
    ("get", "/api/logs", None),
    ("post", "/api/set-basedir", {"path": "/tmp"}),
    ("post", "/api/reset-basedir", None),
    ("post", "/api/open-file", {"path": "/tmp"}),
]


@pytest.mark.parametrize("method,route,body", NEST_WIDE)
def test_members_cannot_change_nest_settings_or_read_logs_even_on_the_nest_itself(house, method, route, body):
    _, _, _, member, *_ = house
    # A member signed in on the desktop that hosts the nest arrives over loopback.
    local = TestClient(app, client=("127.0.0.1", 50000))
    kwargs = {"headers": member, **({"json": body} if body is not None else {})}
    assert getattr(local, method)(route, **kwargs).status_code == 403


def test_owner_still_reads_logs_and_toggles_a_provider(house):
    client, _, _, _, owner, *_ = house
    assert client.get("/api/logs", headers=owner).status_code == 200
    providers = client.get("/api/providers", headers=owner).json()["providers"]
    row = next(p for p in providers if p["enabled"])
    assert client.put(f"/api/providers/{row['id']}", json={"enabled": True}, headers=owner).status_code == 200

def test_owner_still_updates_tags_and_deletes_files(house):
    client, base, _, _, owner, *_ = house
    path = base / "Hidden/secret.mp3"
    assert client.post("/api/update-tags", json={"path": str(path), "title": "Renamed"}, headers=owner).status_code == 200
    assert MP3(path, ID3=EasyID3)["title"] == ["Renamed"]
    response = client.post("/api/delete-track", json={"path": str(path.resolve())}, headers=owner)
    assert response.json() == {"success": True, "path": str(path.resolve()), "playlistsUpdated": []}
    assert not path.exists()


def test_ownership_filters_both_exact_and_near_matches(house):
    client, _, _, member, owner, *_ = house
    query = {"tracks": [
        {"title": "Mine", "artist": "Artist"},
        {"title": "Other", "artist": "Artist"},
        {"title": "Other", "artist": "Artist", "durationSeconds": 300},
        {"title": "Mine", "artist": "Artist", "durationSeconds": 300},
    ]}
    mine = client.post("/api/library/ownership", json=query, headers=member).json()
    theirs = client.post("/api/library/ownership", json=query, headers=owner).json()
    assert "degraded" not in mine
    assert mine["results"][0]["owned"] is True
    for i in (1, 2):
        assert mine["results"][i] == {"owned": False, "match": None, "nearMatch": None, "reason": None}
    assert mine["results"][3]["nearMatch"] is not None
    assert theirs["results"][1]["owned"] is True
    assert theirs["results"][2]["nearMatch"] is not None


def test_dashboard_drops_the_library_derived_row_without_mutating_shared_cache(house):
    client, _, _, member, owner, *_ = house
    snapshot = Dashboard(rows=[
        DashboardRow("top-artists", "Top", "artist", "test", "Test"),
        DashboardRow(YOUR_ARTISTS_ROW_ID, "Your artists", "album", "test", "Test",
                     [DashboardItem("secret", "Owner's library artist")]),
    ])
    service = Mock()
    service.get_dashboard.return_value = snapshot
    service.empty_dashboard.return_value = snapshot
    app.dependency_overrides[get_dashboard_service] = lambda: service
    try:
        assert [r["id"] for r in client.get("/api/dashboard", headers=member).json()["rows"]] == ["top-artists"]
        assert client.get("/api/dashboard", headers=owner).json() == snapshot.to_dict()
        service.get_dashboard.side_effect = OSError("unavailable")
        assert [r["id"] for r in client.get("/api/dashboard", headers=member).json()["rows"]] == ["top-artists"]
    finally:
        app.dependency_overrides.pop(get_dashboard_service)
    assert len(snapshot.rows) == 2


def test_anonymous_transport_keeps_the_whole_library(house, monkeypatch):
    client, _, _, *_ = house
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
    response = client.get("/api/listar-albums")
    assert set(response.json()["albums"]) == {"Album", "Hidden"}


@pytest.mark.parametrize("route", [
    "/api/listar-albums", "/api/listar-albums-con-metadata?covers=false", "/api/library/summary",
])
def test_owner_local_shared_secret_and_anonymous_payloads_are_identical(house, monkeypatch, route):
    client, _, _, _, owner, *_ = house
    expected = client.get(route, headers=owner)
    local = TestClient(app).get(route)
    assert (local.status_code, local.content) == (expected.status_code, expected.content)
    monkeypatch.setattr(app.state.config, "api_token", "test-shared-secret")
    shared = client.get(route, headers={"Authorization": "Bearer test-shared-secret"})
    assert (shared.status_code, shared.content) == (expected.status_code, expected.content)
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
    anonymous = client.get(route)
    assert (anonymous.status_code, anonymous.content) == (expected.status_code, expected.content)


@pytest.fixture
def acquisition_engine(house, monkeypatch):
    client, base, container, *_ = house
    tracker = container.get_progress_tracker()
    downloads = DownloadService(
        download_repo=Mock(), metadata_repo=Mock(), progress_tracker=tracker,
        config=container.config, logger=Mock(),
    )
    fail_titles = set()

    async def land(request, progress_cb=None):
        if request.metadata.title in fail_titles:
            return DownloadResult(success=False, error="No results", failure_kind="no-results")
        path = base / "New" / f"{request.metadata.title}.mp3"
        write_song(path, request.metadata.title, request.metadata.artist, "New")
        return DownloadResult(success=True, file_path=path)

    downloads.engine.download_single_track = AsyncMock(side_effect=land)
    container._services["download_service"] = downloads
    registry = Mock()
    registry.order.return_value = ["youtube"]
    terminal_snapshots = []
    complete = tracker.complete_progress

    def record_complete(*args, **kwargs):
        complete(*args, **kwargs)
        terminal_snapshots.append(tracker.get_progress(args[0]).to_dict())

    monkeypatch.setattr(tracker, "complete_progress", record_complete)
    app.dependency_overrides[get_provider_registry] = lambda: registry
    try:
        # Keep the request loop alive for the real batch engine and linker.
        with client:
            yield downloads.engine, fail_titles, terminal_snapshots
    finally:
        app.dependency_overrides.pop(get_provider_registry)


def wait_until(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    assert predicate(), "background acquisition did not finish"


def acquire(client, headers, *titles):
    response = client.post("/api/browse/acquire", headers=headers, json={"tracks": [
        {"title": title, "artistName": "Artist" if title in {"Mine", "Other"} else "Hidden Artist"}
        for title in titles
    ]})
    assert response.status_code == 200, response.text
    return response.json()


def progress(client, headers, payload):
    response = client.get(f"/api/download-progress/{payload['progress_id']}", headers=headers)
    assert response.status_code == 200
    return response.json()


def test_member_all_hits_are_normal_completed_downloads_and_link_nested_keys(house, acquisition_engine):
    client, _, container, member, _, ana, *_ = house
    engine, _, snapshots = acquisition_engine
    payload = acquire(client, member, "Other", "Secret")
    assert payload["requested"] == payload["queued"] == payload["total"] == 2
    assert payload["alreadyPresent"] == []
    assert payload["linking"] == "user"
    engine.download_single_track.assert_not_called()
    state = progress(client, member, payload)
    assert state["terminal"] is True
    assert state["total"] == state["completed"] == state["succeeded"] == 2
    assert state["failed"] == 0 and state["percentage"] == 100
    assert state["items"] == ["Other", "Secret"]
    assert state["status"] == "Downloaded 2/2 tracks"
    assert state["active"] == {} and state["failures"] == []
    assert container.get_user_track_store().get(ana.user_id, OTHER) is not None
    assert container.get_user_track_store().get(ana.user_id, HIDDEN) is not None
    assert snapshots == [{key: value for key, value in state.items() if key != "done"}]


@pytest.mark.parametrize("fail", [False, True])
def test_member_mixed_acquisition_counts_hits_in_every_terminal_snapshot(house, acquisition_engine, fail):
    client, _, container, member, _, ana, *_ = house
    engine, failures, snapshots = acquisition_engine
    if fail:
        failures.add("New Song")
    payload = acquire(client, member, "Secret", "New Song")
    assert payload["requested"] == payload["queued"] == payload["total"] == 2
    assert payload["alreadyPresent"] == []
    wait_until(lambda: snapshots and len(container.get_user_track_store().list_for_user(ana.user_id)) >= 2)
    wait_until(lambda: len(snapshots) == 2)
    engine.download_single_track.assert_awaited_once()
    for snapshot in snapshots:
        assert snapshot["total"] == snapshot["completed"] == 2
        assert snapshot["succeeded"] == (1 if fail else 2)
        assert snapshot["failed"] == int(fail)
        assert snapshot["status"] == ("Downloaded 1/2 tracks (1 failed)" if fail else "Downloaded 2/2 tracks")
        assert snapshot["items"] == ["Secret", "New Song"]
    state = progress(client, member, payload)
    assert state["terminal"] is True and state["percentage"] == 100
    assert bool(state["failures"]) is fail


def test_member_engine_exception_keeps_hit_successes(house, acquisition_engine, monkeypatch):
    client, _, container, member, *_ = house
    _, _, snapshots = acquisition_engine
    monkeypatch.setattr(container.get_download_service(), "download_spotify_playlist",
                        AsyncMock(side_effect=OSError("engine unavailable")))
    payload = acquire(client, member, "Secret", "New Song")
    wait_until(lambda: snapshots)
    state = progress(client, member, payload)
    assert state["succeeded"] == state["failed"] == 1
    assert state["completed"] == state["total"] == 2
    assert state["status"] == "Downloaded 1/2 tracks (1 failed)"


def test_owner_acquisition_keeps_visible_hits_and_zero_item_terminal_progress(house, acquisition_engine):
    client, _, _, _, owner, *_ = house
    engine, _, _ = acquisition_engine
    payload = acquire(client, owner, "Secret")
    assert payload["requested"] == 1
    assert payload["queued"] == payload["total"] == 0
    assert payload["alreadyPresent"] == [{"title": "Secret", "relPath": HIDDEN, "linked": True}]
    engine.download_single_track.assert_not_called()
    state = progress(client, owner, payload)
    assert state["total"] == state["completed"] == state["succeeded"] == state["failed"] == 0
    assert state["items"] == [] and state["terminal"] is True
    assert state["status"] == "Already in the library (1) — nothing to download"


def test_owner_mixed_acquisition_reports_only_downloaded_misses(house, acquisition_engine):
    client, _, _, _, owner, *_ = house
    engine, _, snapshots = acquisition_engine
    payload = acquire(client, owner, "Secret", "New Song")
    assert payload["requested"] == 2
    assert payload["queued"] == payload["total"] == 1
    assert payload["alreadyPresent"] == [{"title": "Secret", "relPath": HIDDEN, "linked": True}]
    wait_until(lambda: snapshots)
    state = progress(client, owner, payload)
    assert state["total"] == state["completed"] == state["succeeded"] == 1
    assert state["items"] == ["New Song"]
    assert state["status"] == "Downloaded 1/1 tracks"
    engine.download_single_track.assert_awaited_once()


@pytest.mark.parametrize("second_is_miss", [False, True])
def test_member_progress_counts_each_item_even_when_titles_repeat(house, acquisition_engine, second_is_miss):
    client, _, _, member, *_ = house
    engine, _, snapshots = acquisition_engine
    second = {"title": "Secret", "artistName": "Hidden Artist"}
    if second_is_miss:
        second["durationSeconds"] = 300  # same title, different recording
    response = client.post("/api/browse/acquire", headers=member, json={"tracks": [
        {"title": "Secret", "artistName": "Hidden Artist"}, second,
    ]})
    assert response.status_code == 200
    wait_until(lambda: len(snapshots) == (2 if second_is_miss else 1))
    state = progress(client, member, response.json())
    assert state["total"] == state["completed"] == state["succeeded"] == 2
    assert state["items"] == ["Secret", "Secret"]
    assert state["status"] == "Downloaded 2/2 tracks"
    assert engine.download_single_track.await_count == int(second_is_miss)


def test_member_replacement_swaps_their_row_and_never_the_shared_file(house, acquisition_engine):
    client, base, container, member, _, ana, owner = house
    old = base / "Artist/Album/CD1/own.mp3"
    response = client.post("/api/browse/acquire", headers=member, json={"tracks": [
        {"title": "Fresh", "artistName": "Artist", "replaces": str(old)},
    ]})
    assert response.status_code == 200, response.text
    store = container.get_user_track_store()
    wait_until(lambda: store.get(ana.user_id, "New/Fresh.mp3") is not None and store.get(ana.user_id, OWN) is None)
    assert old.is_file()
    assert store.get(owner.user_id, OWN) is not None


def test_range_requests_reuse_scope_until_membership_or_catalog_changes(house, monkeypatch):
    client, _, container, member, _, principal, _ = house
    tracks = container.get_user_track_store()
    listed = Mock(wraps=tracks.list_for_user)
    monkeypatch.setattr(tracks, 'list_for_user', listed)
    headers = {**member, 'Range': 'bytes=0-9'}
    for _ in range(100):
        assert client.get(f'/api/media/{OWN}', headers=headers).status_code == 206
    assert listed.call_count == 1
    tracks.add_many(principal.user_id, [HIDDEN])
    assert client.get(f'/api/media/{HIDDEN}', headers=headers).status_code == 206
    assert listed.call_count == 2
    tracks.remove_many(principal.user_id, [HIDDEN])
    assert client.get(f'/api/media/{HIDDEN}', headers=headers).status_code == 404
    assert listed.call_count == 3
    container.changes.bump('library')  # what a scan publish does
    assert client.get(f'/api/media/{OWN}', headers=headers).status_code == 206
    assert listed.call_count == 4
