"""Pin complete response bodies decoded by independently shipped clients.

Whole-body fixtures catch changes that undeclared schemas cannot describe.
Normalize random ids only. Review contracts/wire diffs when accepting with
UPDATE_WIRE_SNAPSHOTS=1; external decoder suites run in their own repositories.
"""
import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.dependencies import (
    get_browse_service,
    get_download_service,
    get_ownership_index,
    get_progress_tracker,
    get_provider_registry,
)
from app.domains.browse.models import (
    AlbumPage,
    ArtistPage,
    BrowseAlbum,
    BrowseArtist,
    BrowsePlaylist,
    BrowseTrack,
    PlaylistPage,
    ProviderRef,
    SearchResults,
)
from app.domains.browse.services import BrowseService
from app.domains.music.ownership import OwnedTrack, OwnershipVerdict
from app.main import app

# The repo root's contracts/, shared with the clients' suites (contracts/README.md).
SNAPSHOT_DIR = Path(__file__).resolve().parents[3] / "contracts" / "wire"


def assert_matches_snapshot(name: str, body) -> None:
    path = SNAPSHOT_DIR / f"{name}.json"
    rendered = json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if os.environ.get("UPDATE_WIRE_SNAPSHOTS") == "1":
        SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered)
    assert path.exists(), f"No snapshot for {name}; create it with UPDATE_WIRE_SNAPSHOTS=1."
    assert rendered == path.read_text(), (
        f"The body of {name} changed. The iOS client decodes it by hand; "
        f"rerun with UPDATE_WIRE_SNAPSHOTS=1 only if the change is intended."
    )


def test_library_album_body(tmp_path):
    from app.dependencies import get_music_service
    from app.domains.music.models import Album, Track

    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"\xff\xd8\xff\xe0")
    os.utime(cover, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
    service = Mock()
    service.config.base_music_dir = Path("/music")
    from app.domains.music.analysis_repository import AnalysisRepository
    service.music_repo.config = service.config
    service.music_repo.analysis = AnalysisRepository(tmp_path / 'analysis.sqlite')
    service.music_repo._tag_cache = {}
    service.music_repo.tag_revision = 0
    service.music_repo._owner_ghosts = None
    service.list_albums.return_value = [Album(
        name="Album", artist="Artist", path=Path("/music/Album"), cover_art=cover,
        tracks=[Track(title="Song", artist="Artist", album="Album", path=Path("/music/Album/01.mp3"))],
    )]
    app.dependency_overrides[get_music_service] = lambda: service
    try:
        response = TestClient(app).get("/api/listar-albums-con-metadata?covers=false")
    finally:
        app.dependency_overrides.pop(get_music_service, None)
    assert response.status_code == 200
    assert_matches_snapshot("library-albums", response.json())


@pytest.fixture
def subsonic_nest(tmp_path, monkeypatch):
    from tests.integration.test_subsonic import nest
    yield from nest.__wrapped__(tmp_path, monkeypatch)


@pytest.mark.parametrize('source', ['foreign', 'computed', 'missing'])
def test_replaygain_bodies(subsonic_nest, source):
    from mutagen.id3 import ID3, TXXX
    from tests.integration.test_subsonic import call, ok

    nest = subsonic_nest
    path = nest['music'] / 'Daft Punk/Discovery/01.mp3'
    repository = app.state.container.get_analysis_repository()
    if source == 'foreign':
        tags = ID3(path)
        for field, value in [('R128_TRACK_GAIN', '-512'), ('REPLAYGAIN_ALBUM_GAIN', '-5 dB'),
                             ('REPLAYGAIN_TRACK_PEAK', '.9'), ('REPLAYGAIN_ALBUM_PEAK', '.95')]:
            tags.add(TXXX(encoding=3, desc=field, text=[value]))
        tags.save(path)
    elif source == 'computed':
        repository.apply('Daft Punk∕Discovery/01.mp3', {
            'size': path.stat().st_size, 'mtime_ns': path.stat().st_mtime_ns,
            'engine': 'keyfinder+tempocnn', 'engine_version': 2,
            'key': None, 'key_conf': 0, 'bpm': None, 'bpm_conf': 0,
            'energy': 0, 'brightness': 0, 'pulse': 0,
            'track_lufs': -24, 'true_peak': .5,
        }, None)
    app.state.container.get_music_repository().invalidate_scan()
    songs = ok(call(nest, 'search3', query='', songCount='10'))['searchResult3']['song']
    song = next(song for song in songs if song['path'] == 'Daft Punk/Discovery/01.mp3')
    child = ok(call(nest, 'getSong', id=song['id']))['song']
    if source == 'missing':
        assert 'replayGain' not in child
    else:
        assert child['replayGain']['trackGain'] == (3 if source == 'foreign' else 6)
    child['created'] = '2026-01-01T00:00:00+00:00'
    assert_matches_snapshot('subsonic-replaygain-' + source, child)
    url = '/api/analysis/Daft Punk∕Discovery/01.mp3/replaygain'
    owner = {'Authorization': f"Bearer {nest['owner_token']}"}
    response = nest['client'].get(url, headers=owner)
    assert response.status_code == 200
    gain = response.json()
    assert ({field: value for field, value in gain.items() if value is not None} if gain else None) == child.get('replayGain')
    assert_matches_snapshot('analysis-replaygain-' + source, response.json())
    member, token = app.state.container.get_token_store().mint('Member', 'member')
    headers = {'Authorization': f'Bearer {token}'}
    outside = nest['client'].get(url, headers=headers)
    missing = nest['client'].get('/api/analysis/Absent/song.mp3/replaygain', headers=headers)
    assert outside.status_code == missing.status_code == 404
    assert outside.json() == missing.json()
    assert_matches_snapshot('analysis-replaygain-not-found', outside.json())
    app.state.container.get_user_track_store().add_many(member.user_id, ['Daft Punk∕Discovery/01.mp3'])
    allowed = nest['client'].get(url, headers=headers)
    assert allowed.status_code == 200 and allowed.json() == response.json()


def test_account_deletion_bodies(deletion_house):
    h = deletion_house
    preview = h.admin.get(h.url + "/deletion-preview")
    assert preview.status_code == 200
    assert_matches_snapshot("deletion-preview", preview.json())
    response = h.admin.delete(h.url + "?songs=true")
    assert response.status_code == 200
    body = response.json()
    body["user"] = {**body["user"], "id": "<account-id>",
                    "createdAt": "2026-10-28T12:00:00Z", "lastSeenAt": None}
    assert_matches_snapshot("delete-user", body)


def test_account_recovery_bodies(accounts, monkeypatch):
    """Random credentials/ids normalized; additive route bodies pinned."""
    from app.domains.accounts import identity
    monkeypatch.setattr(identity, "utc_now_iso", lambda: "2026-10-27T12:00:00Z")
    _, owner_token = accounts.mint("Robin", "owner")
    member, member_token = accounts.mint("Ana", "member")
    accounts.set_username(member.user_id, "ana")
    client = TestClient(app, client=("192.0.2.42", 51000))
    auth = {"Authorization": f"Bearer {member_token}"}
    ticket = TestClient(app).post("/api/sign-in-code", json={"deviceLabel": "TV", "username": "ANA"}).json()
    pending = client.get("/api/me/sign-in-requests", headers=auth)
    assert pending.status_code == 200
    row = pending.json()["requests"][0]
    assert_matches_snapshot("sign-in-requests", {"requests": [{**row, "id": "<request-id>", "code": "ABC234",
        "createdAt": "2026-10-28T12:00:00Z", "expiresAt": "2026-10-28T12:10:00Z"}]})
    assert_matches_snapshot("sign-in-code-request", {**ticket, "code": "ABC234", "secret": "<poll-secret>"})
    assert_matches_snapshot("sign-in-code-pending", client.post(
        "/api/sign-in-code/poll", json={"secret": "unknown"}).json())
    assert_matches_snapshot("sign-in-code-approve", client.post(
        "/api/me/sign-in-code", json={"code": ticket["code"]}, headers=auth).json())
    credential = client.post("/api/sign-in-code/poll", json={"secret": ticket["secret"]}).json()
    assert_matches_snapshot("sign-in-code-authorized", {"credential": {
        **credential["credential"], "token": "<device-token>",
        "device": {**credential["credential"]["device"], "id": "<device-id>"}}})
    assert_matches_snapshot("account-password-reset", client.post(
        f"/api/users/{member.user_id}/password", json={"newPassword": "replacement-password"},
        headers={"Authorization": f"Bearer {owner_token}"}).json())
    assert_matches_snapshot("account-onboarded", client.post("/api/me/onboarded", headers=auth).json())
    me = client.get("/api/me", headers=auth).json()
    assert_matches_snapshot("account-me", {**me, "id": "<account-id>"})


def _ref(entity_id="302127", kind="album"):
    return ProviderRef(provider="deezer", id=entity_id, url=f"https://www.deezer.com/{kind}/{entity_id}")


def _album():
    return BrowseAlbum(
        ref=_ref(),
        title="Discovery",
        artist_name="Daft Punk",
        artist_ref=ProviderRef(provider="deezer", id="27"),
        cover_url="https://cdn.deezer.test/c.jpg",
        release_date="2001-03-07",
        record_type="album",
        track_count=1,
        label="Daft Life Ltd.",
        genres=["Electro"],
    )


def _artist():
    return BrowseArtist(ref=_ref("27", "artist"), name="Daft Punk", fan_count=5)


def _playlist():
    return BrowsePlaylist(ref=_ref("908", "playlist"), title="En mode 60", owner="Alex", track_count=1)


def _track():
    return BrowseTrack(
        ref=ProviderRef(provider="deezer", id="3135553"),
        title="One More Time",
        artist_name="Daft Punk",
        album_title="Discovery",
        album_ref=_ref(),
        cover_url="https://cdn.deezer.test/c.jpg",
        duration_s=320.0,
        track_position=1,
        disc_number=1,
        isrc="GBDUW0000053",
        preview_url="https://cdn.deezer.test/p.mp3",
    )


@pytest.fixture
def browse():
    service = Mock(spec=BrowseService)
    app.dependency_overrides[get_browse_service] = lambda: service
    try:
        yield TestClient(app), service
    finally:
        app.dependency_overrides.pop(get_browse_service, None)


class TestEntityPages:
    def test_album(self, browse):
        client, service = browse
        service.get_album.return_value = AlbumPage(album=_album(), tracks=[_track()])

        response = client.get("/api/browse/album/deezer/302127")

        assert response.status_code == 200
        assert_matches_snapshot("browse-album", response.json())

    def test_artist(self, browse):
        client, service = browse
        service.get_artist.return_value = ArtistPage(
            artist=_artist(),
            top_tracks=[_track()],
            albums=[_album()],
            related=[_artist()],
            playlists=[_playlist()],
            partial=["related"],
        )

        response = client.get("/api/browse/artist/deezer/27")

        assert response.status_code == 200
        assert_matches_snapshot("browse-artist", response.json())

    def test_playlist(self, browse):
        client, service = browse
        service.get_playlist.return_value = PlaylistPage(playlist=_playlist(), tracks=[_track()])

        response = client.get("/api/browse/playlist/deezer/908")

        assert response.status_code == 200
        assert_matches_snapshot("browse-playlist", response.json())

    def test_search(self, browse):
        client, service = browse
        service.search.return_value = SearchResults(
            query="daft punk",
            artists=[_artist()],
            albums=[_album()],
            tracks=[_track()],
            playlists=[_playlist()],
            requested=["artists", "albums", "tracks", "playlists"],
            failed=[],
        )

        response = client.get("/api/browse/search?q=daft+punk")

        assert response.status_code == 200
        assert_matches_snapshot("browse-search", response.json())


def test_ownership():
    index = Mock()
    index.lookup_many.return_value = [
        OwnershipVerdict(
            owned=True,
            match=OwnedTrack(
                title="Butter", artist="BTS", album="Butter",
                path="/music/Butter/01 - Butter.mp3", duration_s=183.0, track_number=1,
            ),
        ),
        OwnershipVerdict(owned=False),
        # Another cut of the song: what "Swap for this version" acts on.
        OwnershipVerdict(
            owned=False,
            near_match=OwnedTrack(
                title="Butter", artist="BTS", album="Butter (Hotter Remix)",
                path="/music/Butter (Hotter Remix)/01 - Butter.mp3", duration_s=290.0, track_number=1,
            ),
            reason="Duración distinta: 4:50 frente a 3:03",
        ),
    ]
    app.dependency_overrides[get_ownership_index] = lambda: index
    try:
        response = TestClient(app).post(
            "/api/library/ownership",
            json={
                "tracks": [
                    {"title": "Butter", "artist": "BTS", "durationSeconds": 183.0},
                    {"title": "Butter (Instrumental)", "artist": "BTS", "durationSeconds": 183.0},
                    {"title": "Butter", "artist": "BTS", "durationSeconds": 183.0},
                ]
            },
        )
    finally:
        app.dependency_overrides.pop(get_ownership_index, None)

    assert response.status_code == 200
    assert_matches_snapshot("library-ownership", response.json())


def test_acquire(tmp_path):
    async def _download(**_kwargs):
        return None

    download_service = Mock()
    download_service.config.base_music_dir = tmp_path
    download_service.download_spotify_playlist = _download
    registry = Mock()
    registry.order = Mock(return_value=["youtube"])
    ownership = Mock()
    ownership.lookup_many.return_value = [OwnershipVerdict(owned=False)]

    overrides = {
        get_download_service: lambda: download_service,
        get_progress_tracker: lambda: Mock(),
        get_provider_registry: lambda: registry,
        get_ownership_index: lambda: ownership,
    }
    app.dependency_overrides.update(overrides)
    try:
        response = TestClient(app).post(
            "/api/browse/acquire",
            json={
                "tracks": [
                    {
                        "title": "One More Time",
                        "artistName": "Daft Punk",
                        "albumTitle": "Discovery",
                        "trackPosition": 1,
                        "durationSeconds": 320.0,
                        "isrc": "GBDUW0000053",
                    }
                ]
            },
        )
    finally:
        for dependency in overrides:
            app.dependency_overrides.pop(dependency, None)

    assert response.status_code == 200
    body = response.json()
    assert body["progress_id"]
    body["progress_id"] = "<progress_id>"
    body["destination"] = body["destination"].replace(str(tmp_path), "<music>")
    assert_matches_snapshot("browse-acquire", body)


def test_move_track(tmp_path):
    from app.dependencies import get_track_relocator

    relocator = Mock()
    relocator.library_file.return_value = tmp_path / "Dientes De Fierro" / "01 - Dientes De Fierro.mp3"
    relocator.target_album_dir.return_value = tmp_path / "Mil Problemas"
    relocator.move.return_value = tmp_path / "Mil Problemas" / "01 - Dientes De Fierro.mp3"
    app.dependency_overrides[get_track_relocator] = lambda: relocator
    try:
        response = TestClient(app).post(
            "/api/library/move-track",
            json={"path": "/music/Dientes De Fierro/01 - Dientes De Fierro.mp3",
                  "albumTitle": "Mil Problemas", "trackNumber": 3},
        )
    finally:
        app.dependency_overrides.pop(get_track_relocator, None)

    assert response.status_code == 200
    body = response.json()
    body["path"] = body["path"].replace(str(tmp_path), "<music>")
    assert_matches_snapshot("library-move-track", body)


def test_server_network(tmp_path, monkeypatch):
    """``GET /api/server/network`` — the address list every client walks
    (``docs/features/remote-access.md``). Interfaces and the Tailscale CLI are
    replaced so the body is the same on every machine."""
    from app.infra import discovery, instance, remote_access

    monkeypatch.setattr(app.state.config, "instance_file", tmp_path / "instance.json")
    monkeypatch.delenv("KROBI_BACKEND_PORT", raising=False)
    monkeypatch.setattr(
        discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20", "10.0.0.5", "100.101.1.2"]
    )
    monkeypatch.setattr(remote_access, "_ask_magic_dns_name", lambda: "krobi.tail1234.ts.net")
    monkeypatch.setattr(
        remote_access, "local_topology", lambda: (["192.168.1.0/24", "10.0.0.0/8", "100.64.0.0/10"], None)
    )
    remote_access.clear_cache()
    instance._external_url_cache.clear()
    try:
        instance.set_external_url(tmp_path / "instance.json", "musica.ejemplo.com")
        response = TestClient(app).get("/api/server/network")
    finally:
        remote_access.clear_cache()
        instance._external_url_cache.clear()

    assert response.status_code == 200
    assert_matches_snapshot("server-network", response.json())


def test_helper_jobs_bodies_are_additive_and_select_the_fastest_online(accounts, tmp_path, monkeypatch):
    from app.infra import instance

    # Freeze release metadata in this wire-shape fixture. Version refusal has
    # its own tests; raising the minimum must not rebaseline client snapshots.
    monkeypatch.setattr("app.domains.helpers.mac_worker.MIN_WORKER_VERSION", "0.7.0")
    monkeypatch.setattr("app.domains.helpers.mac_worker.SHIPPED_WORKER_VERSION", "0.8.0")
    monkeypatch.setattr("app.domains.helpers.nest_helper.SHIPPED_WORKER_VERSION", "")
    cfg = app.state.config
    # This fixture checks wire shape with an explicitly named server. Product
    # defaults are covered by test_nest_name; keep existing phone snapshots.
    monkeypatch.setattr(cfg, "instance_file", tmp_path / "instance.json")
    instance.set_name(cfg.instance_file, "Nido")
    for key, value in {"lyrics_file": tmp_path / "lyrics.json", "stems_dir": tmp_path / "stems",
                       "base_music_dir": tmp_path / "Music", "lyrics_engine_mode": "agent",
                       "lyrics_auto_fetch": False}.items():
        monkeypatch.setattr(cfg, key, value)
    monkeypatch.setattr(app.state.container.get_nest_helper(), '_memory', lambda: 16 << 30)
    keys = ("lyrics_service", "stems_service")
    for key in keys:
        app.state.container._services.pop(key, None)
    try:
        service = app.state.container.get_lyrics_service()
        monkeypatch.setattr(service.engine, "status", lambda: {"ready": False, "hint": "unsupported-platform"})
        monkeypatch.setattr(service, "provider_ids", lambda: [])
        worker = service.agent_queue.worker
        clock = [1000.0]
        worker.now = lambda: clock[0]
        client = TestClient(app)

        def bodies():
            lyrics = client.get("/api/lyrics/jobs")
            stems = client.get("/api/stems/jobs")
            assert lyrics.status_code == stems.status_code == 200
            return {"lyrics": lyrics.json(), "stems": stems.json()}

        cases = {"no-helper": bodies()}
        assert cases["no-helper"]["lyrics"]["engine"]["waitReason"] == "no-helper"
        worker.seen({"id": "incapable", "name": "Small CPU", "version": "0.7.0", "os": "linux", "accel": "cpu", "memoryBytes": 4 << 30})
        cases["no-capable-helper"] = bodies()
        assert cases["no-capable-helper"]["lyrics"]["engine"]["waitReason"] == "no-capable-helper"
        worker.revoke("incapable")
        worker.seen({"id": "fast", "name": "GPU", "version": "0.7.0", "accel": "cuda", "os": "windows",
                     "gpu": "RTX", "jobs": ["align", "transcribe", "stems"], "keepAwake": "held", "memoryBytes": 16 << 30})
        clock[0] += 10
        worker.seen({"id": "slow", "name": "CPU", "version": "0.7.0", "os": "linux", "accel": "cpu"})
        cases["online"] = bodies()
        engine = cases["online"]["lyrics"]["engine"]
        assert engine["worker"] == next(r for r in engine["helpers"] if r["id"] == "fast")
        assert engine["waitReason"] is None
        assert cases["online"]["stems"]["agent"]["name"] == "GPU"
        worker.working("example-job", "fast", "Canción", "alineando")
        cases["helpers-busy"] = bodies()
        assert cases["helpers-busy"]["lyrics"]["engine"]["waitReason"] == "helpers-busy"
        assert cases["helpers-busy"]["stems"]["waitReason"] == "helpers-busy"
        worker.finished("example-job")
        clock[0] += 91
        cases["offline"] = bodies()
        assert cases["offline"]["lyrics"]["engine"]["worker"]["id"] == "slow"
        assert cases["offline"]["lyrics"]["engine"]["waitReason"] == "helpers-offline"
        assert cases["offline"]["stems"]["agent"]["name"] == "CPU"
        worker.register_nest({"id": "internal:nest-cpu", "name": "Mi nido", "version": "0.8.0",
                              "os": "linux", "accel": "cpu", "memoryBytes": 16 << 30, "jobs": ["stems"]})
        cases["nest"] = bodies()
        engine = cases["nest"]["lyrics"]["engine"]
        assert engine["helpers"][-1]["nest"] is True
        assert engine["helpers"][-1]["name"] == "Mi nido"
        assert_matches_snapshot("helper-jobs", cases)
    finally:
        for key in keys:
            app.state.container._services.pop(key, None)


def test_lyrics_current_body():
    from app.dependencies import get_lyrics_service
    from app.domains.lyrics.models import LyricsDocument, LyricsRecord

    service = Mock()
    current = LyricsDocument(LyricsRecord("Album/Song.mp3", "synced", "lrclib", fetched_at=2, sidecar="Song.lrc"),
                             "[00:01]Current words\n")
    service.get.return_value = current
    app.dependency_overrides[get_lyrics_service] = lambda: service
    try:
        client = TestClient(app)
        response = client.get("/api/lyrics/Album/Song.mp3")
        assert response.status_code == 200
        assert_matches_snapshot("lyrics-current", response.json())
    finally:
        app.dependency_overrides.pop(get_lyrics_service, None)


def test_upload_space_body(accounts):
    from app.domains.acquisition.upload_routes import uploads
    service = Mock()
    service.pipeline.space.return_value = {'freeBytes': 123456789, 'floorBytes': 987654}
    _, token = accounts.mint('Member', 'member')
    app.dependency_overrides[uploads] = lambda: service
    try:
        response = TestClient(app).get('/api/uploads/space', headers={'Authorization': f'Bearer {token}'})
    finally:
        app.dependency_overrides.pop(uploads, None)
    assert response.status_code == 200
    assert_matches_snapshot('uploads-space', response.json())


def test_providers_health_body(tmp_path):
    from types import SimpleNamespace
    from app.providers.registry import ProviderDescriptor, ProviderKind, ProviderRegistry
    from app.providers.routes import source_health, source_status
    from app.domains.acquisition.sources.status import StatusCache
    from app.domains.acquisition.health import SourceHealth
    from tests.source_plugin_support import failure
    from app.infra.jobs import Jobs

    registry = ProviderRegistry()
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    ledger.now = lambda: 10000
    health = SourceHealth(ledger, started_at=0, jitter=lambda: 1)
    for provider, kind in [('ready', None), ('busy', 'rate-limited'), ('blocked', 'blocked'),
                           ('broken', 'broken'), ('signin', 'auth-required'), ('youtube', None)]:
        source = SimpleNamespace(id=provider, call=lambda *args: {})
        registry.register(ProviderDescriptor(id=provider, kind=ProviderKind.STREAMING,
                          name=provider.title(), description='Audio source'), SimpleNamespace(source=source))
        if kind:
            health.failure(provider, failure(kind))
    health.published('youtube', {'codec': 'aac', 'bitrate_bps': 256000, 'container': 'm4a', 'transcoded': False})
    overrides = {get_provider_registry: lambda: registry, source_health: lambda: health,
                 source_status: lambda: StatusCache()}
    app.dependency_overrides.update(overrides)
    try:
        response = TestClient(app).get('/api/providers')
        assert response.status_code == 200
        assert_matches_snapshot('providers', response.json())
    finally:
        for dependency in overrides:
            app.dependency_overrides.pop(dependency, None)
        ledger.close()


def test_known_source_catalog_body(monkeypatch):
    from app.dependencies import get_container
    from app.domains.acquisition.sources.compat import LEGACY_SOURCES
    from app.infra import env_sources
    container = Mock()
    container.config.data_root = Path('/data')
    container.get_provider_registry.return_value.get.return_value = None
    monkeypatch.setattr(env_sources, 'read_values', lambda _: {})
    for _, setting in LEGACY_SOURCES.values():
        monkeypatch.delenv(setting, raising=False)
    app.dependency_overrides[get_container] = lambda: container
    try:
        response = TestClient(app).get('/api/sources/known')
        assert response.status_code == 200
        assert_matches_snapshot('sources-known', response.json())
    finally:
        app.dependency_overrides.pop(get_container, None)
