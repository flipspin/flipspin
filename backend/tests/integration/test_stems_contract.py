"""stems contract checks 1–7, plus persistence and live settings."""
import logging
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from mutagen.easyid3 import EasyID3
from mutagen.mp3 import MP3

from app.config import settings_from_env
from app.infra import env_sources
from app.dependencies import DependencyContainer
from app.domains.stems.models import STEMS, StemJob
from app.domains.stems.jobs import StemsQueue
from app.domains.stems.services import file_signature
from app.main import app

pytestmark = pytest.mark.integration
ALBUM = "Artist∕Album"
MINE = "CD1∕mine.mp3"
HIDDEN = "hidden.mp3"
FRAME = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40


@pytest.fixture
def nest(config, tmp_path, monkeypatch):
    config.base_music_dir = tmp_path / "Music"
    config.stems_dir = tmp_path / "stems"
    config.lyrics_file = tmp_path / "lyrics.json"
    config.users_file = tmp_path / "users.json"
    config.user_tracks_file = tmp_path / "user_tracks.json"
    config.jobs_file = tmp_path / "jobs.sqlite"
    config.lyrics_engine_mode = "agent"
    config.api_token = None
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(app.state, "container", container)
    store = container.get_token_store()
    owner, owner_token = store.mint("Owner", "owner")
    ana, ana_token = store.mint("Ana", "member")
    bob, bob_token = store.mint("Bob", "member")
    _, _, helper_token = store.add_device(owner.user_id, "Helper", helper=True)

    def client(token):
        return TestClient(app, client=("192.0.2.42", 50000), headers={"Authorization": f"Bearer {token}"})

    def song(file, *, user=ana, album=ALBUM):
        path = config.base_music_dir / album.replace("∕", "/") / file.replace("∕", "/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(FRAME)
        audio = MP3(path, ID3=EasyID3)
        audio.add_tags()
        audio["title"], audio["artist"], audio["album"] = "Tagged title", "Tagged artist", "Tagged album"
        audio.save()
        container.get_user_track_store().add_many(user.user_id, [f"{album}/{file}"])
        return path

    song(MINE)
    song(HIDDEN, user=bob)
    service = container.get_stems_service()
    service.queue.duration = lambda *_: 120
    clock = [1000.0]
    service.queue.now = lambda: clock[0]
    monkeypatch.setattr(service.queue.worker, "now", lambda: clock[0])

    def request(file, *, who=None, priority="now", album=ALBUM):
        clock[0] += 1
        response = (who or member).post("/api/stems/request", json={"album": album, "file": file, "priority": priority})
        assert response.status_code == 200, response.text
        return response.json()

    def ready(file, *, album=ALBUM):
        song(file, album=album)
        files = {}
        for stem in STEMS:
            source = tmp_path / f"{stem}.ogg"
            source.write_bytes(b"OggS" * 40)
            files[stem] = source
        manifest = {"version": 1, "createdAt": "2026-11-08T00:00:00Z", "track": {
            "source": file_signature(service.repository.audio_path(album, file)),
        }}
        service.repository.publish(album, file, manifest, files)

    member = client(ana_token)
    return SimpleNamespace(config=config, container=container, service=service, owner=client(owner_token), member=member,
                           other=client(bob_token), helper=client(helper_token), ana=ana, bob=bob,
                           request=request, song=song, ready=ready, clock=clock)


def claim(nest):
    response = nest.helper.post("/api/stems/agent/claim", json={"agent": {"name": "Helper", "version": "0.10.0"}})
    assert response.status_code == 200, response.text
    return response.json()


def switch(nest, value):
    return nest.owner.put("/api/server/config", json={"changes": {"KROBI_STEMS_BACKGROUND": value}})


def test_check_1_member_list_and_audio_hide_other_accounts_splits(nest):
    nest.ready(MINE)
    nest.ready(HIDDEN)
    # Remove the link ready() gave Ana, so only Bob owns this one.
    nest.container.get_user_track_store().remove_many(nest.ana.user_id, [f"{ALBUM}/{HIDDEN}"])
    assert len(nest.owner.get("/api/stems").json()["splits"]) == 2  # warm shared cache as owner first
    response = nest.member.get("/api/stems")
    assert response.status_code == 200
    assert response.json() == {"splits": [{
        "album": ALBUM, "file": MINE, "title": "Tagged title", "artist": "Tagged artist",
        "albumTitle": "Tagged album", "createdAt": "2026-11-08T00:00:00Z", "stale": False,
        "sizeBytes": sum(p.stat().st_size for p in nest.service.repository.track_dir(ALBUM, MINE).iterdir()),
    }]}
    url = f"/api/stems/{ALBUM}/{HIDDEN}/drums"
    denied = nest.member.get(url)
    nest.service.repository.delete(ALBUM, HIDDEN)
    missing = nest.owner.get(url)
    assert denied.status_code == missing.status_code == 404
    assert denied.json() == missing.json() == {"detail": f"No drums stem for {ALBUM}/{HIDDEN}"}


def test_list_sizes_sum_five_files_and_refresh_without_reading_contents(nest, monkeypatch):
    nest.ready(MINE)
    nest.ready("second.mp3")
    repository = nest.service.repository
    expected = {}
    for index, file in enumerate((MINE, "second.mp3"), start=1):
        directory = repository.track_dir(ALBUM, file)
        for number, stem in enumerate(STEMS, start=1):
            (directory / f"{stem}.ogg").write_bytes(b"x" * (index * number * 100))
        expected[file] = sum((directory / f"{stem}.ogg").stat().st_size for stem in STEMS)
        expected[file] += (directory / "song.json").stat().st_size
        (directory / "extra.bin").write_bytes(b"x" * 9000)
    # Warm the manifest and metadata caches before forbidding content reads.
    assert nest.member.get("/api/stems").status_code == 200
    original_open = Path.open

    def no_split_reads(path, *args, **kwargs):
        assert not path.is_relative_to(repository.root), f"Unexpected split content read: {path}"
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", no_split_reads)
    rows = nest.member.get("/api/stems").json()["splits"]
    assert {row["file"]: row["sizeBytes"] for row in rows} == expected
    assert sum(row["sizeBytes"] for row in rows) == sum(expected.values())
    # In-place size changes do not change directory mtimes or invalidate manifests.
    stem = repository.track_dir(ALBUM, MINE) / "drums.ogg"
    with original_open(stem, "ab") as stream:
        stream.write(b"more bytes")
    expected[MINE] += len(b"more bytes")
    rows = nest.member.get("/api/stems").json()["splits"]
    assert {row["file"]: row["sizeBytes"] for row in rows} == expected


def test_size_ignores_missing_files_symlinks_and_directories(nest):
    nest.ready(MINE)
    repository = nest.service.repository
    directory = repository.track_dir(ALBUM, MINE)
    manifest_size = (directory / "song.json").stat().st_size
    for stem in STEMS:
        (directory / f"{stem}.ogg").unlink()
    (directory / "drums.ogg").symlink_to(repository.audio_path(ALBUM, MINE))
    (directory / "bass.ogg").mkdir()
    assert nest.member.get("/api/stems").json()["splits"][0]["sizeBytes"] == manifest_size
    repository.delete(ALBUM, MINE)
    assert repository.size_bytes(ALBUM, MINE) == 0


def test_check_2_member_requests_own_tracks_missing_404_and_owner_deletes(nest):
    assert nest.request(MINE)["status"] == "queued"
    body = {"album": ALBUM, "file": HIDDEN}
    denied = nest.member.post("/api/stems/request", json=body)
    nest.service.repository.audio_path(ALBUM, HIDDEN).unlink()
    missing = nest.owner.post("/api/stems/request", json=body)
    assert denied.status_code == missing.status_code == 404
    assert denied.json() == missing.json() == {"detail": f"Track not found: {ALBUM}/{HIDDEN}"}
    assert nest.member.delete(f"/api/stems/{ALBUM}/{MINE}").status_code == 403
    assert nest.member.delete("/api/stems").status_code == 403
    remote = TestClient(app, client=("192.0.2.42", 50000))
    assert remote.post("/api/stems/request", json=body).status_code == 401
    assert remote.get("/api/stems").status_code == 401


def test_check_3_background_cap_is_per_account_cancels_ledger_and_preserves_lease(nest):
    assert switch(nest, True).status_code == 200
    running = nest.request(MINE, priority="background")
    lease = claim(nest)
    other = nest.request(HIDDEN, who=nest.other, priority="background")
    ids = []
    for file in ("one.mp3", "two.mp3", "three.mp3"):
        nest.song(file)
        ids.append(nest.request(file, priority="background")["jobId"])
    queue = nest.service.queue
    assert queue.get(ALBUM, "one.mp3") is None
    assert queue.get(ALBUM, "two.mp3") and queue.get(ALBUM, "three.mp3")
    assert queue.get(ALBUM, HIDDEN).id == other["jobId"]
    assert queue.leased(lease["id"]).id == running["jobId"]
    ledger = nest.container.get_jobs()
    assert ledger.get(ids[0])["state"] == "cancelled"
    assert nest.container.get_progress_tracker().get_progress(ids[0]).status == "cancelled"
    assert ledger.get(running["jobId"])["state"] == "running"
    # Bob also reaches his own cap without touching Ana's rows.
    for file in ("bob1.mp3", "bob2.mp3"):
        nest.song(file, user=nest.bob)
        nest.request(file, who=nest.other, priority="background")
    assert queue.get(ALBUM, HIDDEN) is None
    assert queue.get(ALBUM, "two.mp3") and queue.get(ALBUM, "three.mp3")


@pytest.mark.parametrize("leased", [False, True])
def test_check_4_foreground_upgrades_same_job_and_never_downgrades(nest, leased):
    switch(nest, True)
    first = nest.request(MINE, priority="background")
    if leased:
        claim(nest)
    # Anyone with this track can upgrade it, including another account.
    nest.container.get_user_track_store().add_many(nest.bob.user_id, [f"{ALBUM}/{MINE}"])
    upgraded = nest.request(MINE, who=nest.other)
    assert upgraded["jobId"] == first["jobId"]
    row = nest.service.queue.get(ALBUM, MINE)
    assert row.priority == "now" and row.requested_by == nest.ana.user_id
    assert nest.request(MINE, priority="background")["jobId"] == first["jobId"]
    assert row.priority == "now"
    stored = nest.service.queue.queue.rows(("stems",))[0]
    assert stored["priority"] == "now" and stored["requestedBy"] == nest.ana.user_id


def test_check_5_claim_now_before_background_then_fifo(nest):
    switch(nest, True)
    background = nest.request(MINE, priority="background")
    nest.song("now1.mp3")
    nest.song("now2.mp3")
    first = nest.request("now1.mp3")
    second = nest.request("now2.mp3")
    for expected in (first, second, background):
        assert claim(nest)["jobId"] == expected["jobId"]
        row = next(r for r in nest.service.queue._rows.values() if r.id == expected["jobId"])
        nest.service.queue.remove(row.album, row.file)


def test_foreground_upgrade_keeps_background_job_even_if_old_split_matches_again(nest):
    switch(nest, True)
    nest.ready(MINE)
    source = nest.service.repository.audio_path(ALBUM, MINE)
    stamp = source.stat()
    os.utime(source, (stamp.st_atime, stamp.st_mtime + 60))
    background = nest.request(MINE, priority="background")
    os.utime(source, (stamp.st_atime, stamp.st_mtime))
    assert nest.request(MINE) == background
    assert nest.service.queue.get(ALBUM, MINE).priority == "now"


def test_check_6_delete_all_only_ready_idempotent_and_running_result_still_lands(nest):
    nest.ready("ready1.mp3")
    nest.ready("ready2.mp3", album="Other")
    running = nest.request(MINE)
    lease = claim(nest)
    nest.song("queued.mp3")
    queued = nest.request("queued.mp3")
    # Even a stale split for a running re-split can be removed without cancelling it.
    nest.ready(MINE)
    before = nest.service.queue.queue.rows(("stems",))
    assert nest.owner.delete("/api/stems").json() == {"removed": 3}
    assert nest.owner.delete("/api/stems").json() == {"removed": 0}
    assert nest.service.queue.queue.rows(("stems",)) == before
    assert nest.service.queue.leased(lease["id"]).id == running["jobId"]
    assert nest.service.queue.get(ALBUM, "queued.mp3").id == queued["jobId"]
    assert nest.service.heartbeat(lease["id"]) == {"stop": False}
    uploads = [("song.json", ("song.json", b'{"version":1}', "application/json"))]
    uploads += [(stem, (f"{stem}.ogg", b"OggS", "audio/ogg")) for stem in STEMS]
    result = nest.helper.post("/api/stems/agent/result", data={"id": lease["id"]}, files=uploads)
    assert result.json()["accepted"] is True
    assert nest.member.get(f"/api/stems/{ALBUM}/{MINE}").status_code == 200


def test_check_7_both_deletes_log_the_current_principal(nest, caplog):
    nest.ready(MINE)
    with caplog.at_level(logging.INFO, logger="app.domains.stems.routes"):
        assert nest.owner.delete(f"/api/stems/{ALBUM}/{MINE}").json()["removed"] is True
        nest.ready("other.mp3")
        assert nest.owner.delete("/api/stems").json() == {"removed": 1}
    principal = nest.container.get_token_store().list_users()[0].principal()
    messages = [r.getMessage() for r in caplog.records if r.name == "app.domains.stems.routes"]
    assert len(messages) == 2
    assert all(str(principal) in message for message in messages)
    assert f"{ALBUM}/{MINE}" in messages[0]
    assert "removed 1" in messages[1]


def test_background_setting_default_skip_live_off_eviction_and_env_lock(nest, monkeypatch):
    before = nest.owner.get("/api/server/config").json()
    group = next(g for g in before["groups"] if g["id"] == "stems")
    setting = group["settings"][0]
    assert setting["key"] == "KROBI_STEMS_BACKGROUND"
    assert setting["value"] is setting["default"] is False
    assert setting["editable"] and not setting["needsRestart"]
    assert nest.request(MINE, priority="background") == {"status": "skipped"}
    assert nest.service.queue.snapshot()["jobs"] == []
    assert nest.container.get_jobs().list() == []
    assert switch(nest, True).status_code == 200
    assert env_sources.read_values(nest.config.credentials_dir.parent / ".env")["KROBI_STEMS_BACKGROUND"] == "true"
    running = nest.request(MINE, priority="background")
    lease = claim(nest)
    queued = nest.request(HIDDEN, who=nest.other, priority="background")
    nest.song("now.mp3")
    now = nest.request("now.mp3")
    assert switch(nest, False).status_code == 200
    assert switch(nest, False).status_code == 200
    assert nest.service.queue.get(ALBUM, HIDDEN) is None
    assert nest.container.get_jobs().get(queued["jobId"])["state"] == "cancelled"
    assert nest.service.queue.get(ALBUM, "now.mp3").id == now["jobId"]
    assert nest.service.queue.leased(lease["id"]).id == running["jobId"]
    assert nest.request(MINE, priority="background") == {"status": "skipped"}
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset(["KROBI_STEMS_BACKGROUND"]))
    assert switch(nest, True).status_code == 409
    assert not nest.config.stems_background
    assert nest.member.put("/api/server/config", json={"changes": {"KROBI_STEMS_BACKGROUND": True}}).status_code == 403


def test_queue_persistence_old_rows_default_now_and_sentinels_store_null(nest):
    old = StemJob.from_dict({"id": "old", "album": "Old", "file": "old.mp3"})
    assert old.priority == "now" and old.requested_by is None
    assert StemJob.from_dict(old.to_dict()).priority == "now"
    switch(nest, True)
    nest.request(MINE, priority="background")
    reloaded = StemsQueue(nest.service.repository, logging.getLogger(__name__), ledger=nest.container.get_jobs())
    row = reloaded.get(ALBUM, MINE)
    assert row.priority == "background" and row.requested_by == nest.ana.user_id
    # Local sentinel keeps its unrestricted library view and no account id.
    local = TestClient(app)
    assert local.post("/api/stems/request", json={"album": ALBUM, "file": HIDDEN}).status_code == 200
    assert nest.service.queue.get(ALBUM, HIDDEN).requested_by is None
    invalid = nest.member.post("/api/stems/request", json={"album": ALBUM, "file": MINE, "priority": "later"})
    assert invalid.status_code == 422


def test_background_cap_holds_under_concurrent_requests(nest):
    switch(nest, True)
    files = [f"concurrent{i}.mp3" for i in range(8)]
    for file in files:
        nest.song(file)
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda f: nest.member.post("/api/stems/request", json={
            "album": ALBUM, "file": f, "priority": "background",
        }), files))
    assert all(r.status_code == 200 for r in responses)
    rows = nest.service.queue.snapshot()["jobs"]
    assert len(rows) == 2


def test_list_cache_refreshes_nested_publish_delete_and_source_retag(nest, monkeypatch):
    nest.ready(MINE)
    repository = nest.service.repository
    read = Mock(wraps=repository.manifest)
    monkeypatch.setattr(repository, "manifest", read)
    first = nest.member.get("/api/stems").json()["splits"]
    assert first[0]["stale"] is False
    assert nest.member.get("/api/stems").json()["splits"] == first
    assert read.call_count == 1  # directory stats only; no repeated manifest reads
    source = repository.audio_path(ALBUM, MINE)
    os.utime(source, (source.stat().st_atime, source.stat().st_mtime + 60))
    assert nest.member.get("/api/stems").json()["splits"][0]["stale"] is True
    assert read.call_count == 1
    root_mtime = repository.root.stat().st_mtime_ns
    nest.ready("new.mp3")
    assert repository.root.stat().st_mtime_ns == root_mtime
    assert len(nest.member.get("/api/stems").json()["splits"]) == 2
    nest.ready(MINE)  # atomic replacement updates the album's stamp
    assert nest.member.get("/api/stems").json()["splits"][0]["stale"] is False
    repository.delete(ALBUM, "new.mp3")
    assert len(nest.member.get("/api/stems").json()["splits"]) == 1
    source.unlink()
    row = nest.member.get("/api/stems").json()["splits"][0]
    assert row["stale"] and row["title"] == "mine"


def test_requeued_background_lease_obeys_cap_and_off_switch(nest):
    switch(nest, True)
    first = nest.request(MINE, priority="background")
    lease = claim(nest)
    for file in ("one.mp3", "two.mp3"):
        nest.song(file)
        nest.request(file, priority="background")
    nest.service.fail(lease["id"], "temporary failure", final=False)
    assert nest.service.queue.get(ALBUM, MINE) is None
    assert nest.container.get_jobs().get(first["jobId"])["state"] == "cancelled"
    assert len(nest.service.queue.snapshot()["jobs"]) == 2
    lease = claim(nest)
    assert switch(nest, False).status_code == 200
    assert nest.service.queue.leased(lease["id"])
    nest.service.fail(lease["id"], "temporary failure", final=False)
    assert nest.service.queue.snapshot()["jobs"] == []


def test_stems_restart_honors_disabled_background_setting(nest):
    switch(nest, True)
    background = nest.request(MINE, priority="background")
    now = nest.request(HIDDEN, who=nest.other)
    nest.config.stems_background = False  # next boot's env/default disables it
    nest.container._services.pop("stems_service")
    service = nest.container.get_stems_service()
    assert service.queue.get(ALBUM, MINE) is None
    assert nest.container.get_jobs().get(background["jobId"])["state"] == "cancelled"
    assert service.queue.get(ALBUM, HIDDEN).id == now["jobId"]


def test_background_config_reads_environment(monkeypatch):
    monkeypatch.delenv("KROBI_STEMS_BACKGROUND", raising=False)
    assert settings_from_env()["stems_background"] is False
    monkeypatch.setenv("KROBI_STEMS_BACKGROUND", "true")
    assert settings_from_env()["stems_background"] is True
