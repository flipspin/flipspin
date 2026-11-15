"""Keep export parsing, resolution, and acquisition as separate HTTP operations.

Parsing has no side effects, resolution cannot download, and only confirmed
imports reach acquisition. Fake services also exercise upload refusal boundaries.
"""
import builtins
import io
import json
import time
import zipfile
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.infra.progress import ProgressTracker
from app.infra.jobs import Jobs
from app.dependencies import (
    get_download_service,
    get_playlist_service,
    get_progress_tracker,
    get_user_track_store,
)
from app.domains.metadata.matching import Confidence, MatchResult, WantedTrack
from app.domains.playlists import routes as playlist_routes
from app.main import app
from app.providers.registry import ProviderKind


# --------------------------------------------------------------------------- helpers

def _export_zip(playlists) -> bytes:
    """Build an in-memory Spotify-export-shaped zip."""
    payload = {
        "playlists": [
            {
                "name": name,
                "lastModifiedDate": "2026-01-01",
                "items": [
                    {
                        "track": {"trackName": title, "artistName": artist, "albumName": album},
                        "addedDate": "2026-01-02",
                    }
                    for title, artist, album in tracks
                ],
            }
            for name, tracks in playlists
        ]
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("Spotify Account Data/Playlist1.json", json.dumps(payload))
        archive.writestr("Spotify Account Data/ReadMeFirst.txt", "not json")
    return buffer.getvalue()


def _wait_for(predicate, timeout: float = 5.0) -> bool:
    """Yield while polling so the TestClient's background portal thread can progress."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class FakeResolver:
    """Stands in for ResolutionService, honouring its two batch hooks.

    ``resolve_many`` mirrors the real contract on purpose: cancel is checked
    *before* each lookup, progress reported *after* it, and the returned list is
    short when the run stopped early. The route reads cancellation off that
    length, so a fake that got it wrong would hide a real bug.
    """

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.seen = []

    def resolve(self, track):
        self.seen.append(track)
        if self.delay:
            time.sleep(self.delay)
        # Alternate the confidence so the grouping in the response is exercised.
        confidence = Confidence.STRONG if len(self.seen) % 2 else Confidence.REVIEW
        return MatchResult(
            wanted=WantedTrack(title=track.title, artist=track.artist, album=track.album),
            confidence=confidence,
            explanation="fake",
        )

    def resolve_many(self, tracks, progress_callback=None, should_cancel=None):
        results = []
        for track in tracks:
            if should_cancel is not None and should_cancel():
                break
            results.append(self.resolve(track))
            if progress_callback is not None:
                progress_callback(len(results), len(tracks), results[-1])
        return results


class ExplodingResolver:
    """The batch itself fails -- something structural, not a dead provider."""

    def resolve(self, track):
        raise RuntimeError("provider is down")

    def resolve_many(self, tracks, progress_callback=None, should_cancel=None):
        raise RuntimeError("provider is down")


class FakeDownloadService:
    """Records download calls instead of making them."""

    def __init__(self, base_dir, results=None):
        self.config = SimpleNamespace(base_music_dir=base_dir)
        self.calls = []
        self._results = results or []

    async def download_spotify_playlist(self, **kwargs):
        self.calls.append(kwargs)
        return self._results


@pytest.fixture
def tracker(monkeypatch, tmp_path):
    """A progress tracker the tests own, injected into every route that uses one."""
    monkeypatch.setattr(app.state.container, "get_album_genres", lambda registry: None)
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    monkeypatch.setattr(app.state.container, "get_jobs", lambda: ledger)
    instance = ProgressTracker(ledger)
    app.dependency_overrides[get_progress_tracker] = lambda: instance
    yield instance
    app.dependency_overrides.pop(get_progress_tracker, None)
    ledger.close()


@pytest.fixture
def client(tracker):
    """TestClient entered as a context manager so background tasks keep running.

    Without ``with``, Starlette tears the event-loop portal down after each
    request and any background job dies with it.
    """
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def resolver():
    instance = FakeResolver()
    app.dependency_overrides[playlist_routes.get_resolution_service] = lambda: instance
    yield instance
    app.dependency_overrides.pop(playlist_routes.get_resolution_service, None)


@pytest.fixture
def downloads(tmp_path):
    """A download service that records instead of downloading, plus a fake playlist store."""
    landed = tmp_path / "RAM" / "track.mp3"
    landed.parent.mkdir(parents=True, exist_ok=True)
    landed.write_bytes(b"ID3")
    service = FakeDownloadService(
        tmp_path,
        results=[SimpleNamespace(success=True, file_path=landed, title="Get Lucky", artist="Daft Punk")],
    )
    playlists = Mock()
    app.dependency_overrides[get_download_service] = lambda: service
    app.dependency_overrides[get_playlist_service] = lambda: playlists
    yield service, playlists
    app.dependency_overrides.pop(get_download_service, None)
    app.dependency_overrides.pop(get_playlist_service, None)


# --------------------------------------------------------------------------- parse

def test_parse_returns_the_playlists_in_the_export(client):
    data = _export_zip([("Road Trip", [("Get Lucky", "Daft Punk", "Random Access Memories")])])

    response = client.post(
        "/api/playlists/spotify-export/parse",
        files={"file": ("export.zip", data, "application/zip")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["playlistCount"] == 1
    assert body["trackCount"] == 1
    assert body["sourceFiles"] == ["Spotify Account Data/Playlist1.json"]
    playlist = body["playlists"][0]
    assert playlist["name"] == "Road Trip"
    assert playlist["trackCount"] == 1
    assert playlist["tracks"][0] == {
        "title": "Get Lucky",
        "artist": "Daft Punk",
        "album": "Random Access Memories",
        "spotifyUri": None,
        "addedAt": "2026-01-02",
    }


def test_parse_never_downloads_anything(client, downloads):
    service, _ = downloads
    data = _export_zip([("Road Trip", [("Get Lucky", "Daft Punk", "RAM")])])

    client.post(
        "/api/playlists/spotify-export/parse",
        files={"file": ("export.zip", data, "application/zip")},
    )

    assert service.calls == []


def test_parse_rejects_something_that_is_not_an_export(client):
    response = client.post(
        "/api/playlists/spotify-export/parse",
        files={"file": ("notes.txt", b"just some text", "text/plain")},
    )

    assert response.status_code == 400
    assert "No playlists found" in response.json()["detail"]


def test_parse_rejects_a_zip_with_no_playlist_data(client):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("Userdata.json", json.dumps({"email": "someone@example.com"}))

    response = client.post(
        "/api/playlists/spotify-export/parse",
        files={"file": ("export.zip", buffer.getvalue(), "application/zip")},
    )

    assert response.status_code == 400


def test_parse_rejects_an_oversized_upload_before_reading_it(client, monkeypatch):
    monkeypatch.setattr(playlist_routes, "MAX_EXPORT_UPLOAD_BYTES", 512)

    def _never(*args, **kwargs):
        raise AssertionError("parser must not see an oversized upload")

    monkeypatch.setattr(playlist_routes, "parse_spotify_export", _never)

    response = client.post(
        "/api/playlists/spotify-export/parse",
        files={"file": ("huge.zip", b"x" * 4096, "application/zip")},
    )

    assert response.status_code == 413
    assert "too large" in response.json()["detail"]


def test_parse_requires_a_file_field(client):
    response = client.post(
        "/api/playlists/spotify-export/parse",
        data={"notafile": "value"},
    )

    assert response.status_code == 400


# --------------------------------------------------------------------------- resolve

def _resolve(client, tracks, name="Road Trip"):
    return client.post(
        "/api/playlists/spotify-export/resolve",
        json={"playlistName": name, "tracks": tracks},
    )


def test_resolve_returns_a_progress_id_immediately_and_groups_results(client, tracker, resolver):
    tracks = [
        {"title": "Get Lucky", "artist": "Daft Punk", "album": "RAM"},
        {"title": "Instant Crush", "artist": "Daft Punk", "album": "RAM"},
    ]

    response = _resolve(client, tracks)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "started"
    assert body["total"] == 2
    assert body["playlistName"] == "Road Trip"
    progress_id = body["progress_id"]

    # Registered synchronously, so the SSE stream can attach without racing.
    assert tracker.get_progress(progress_id) is not None

    assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)

    results = client.get(f"/api/playlists/spotify-export/resolve/{progress_id}").json()
    assert results["status"] == "done"
    assert results["resolved"] == 2
    assert results["counts"] == {"strong": 1, "review": 1, "rejected": 0}
    assert results["results"]["strong"][0]["wanted"]["title"] == "Get Lucky"
    assert [t.title for t in resolver.seen] == ["Get Lucky", "Instant Crush"]


def test_resolve_does_not_trigger_a_download(client, tracker, resolver, downloads):
    service, playlists = downloads

    response = _resolve(client, [{"title": "Get Lucky", "artist": "Daft Punk", "album": None}])
    progress_id = response.json()["progress_id"]

    assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)

    # The whole point of the review step: resolution acquires nothing, not even
    # for a STRONG match, and writes no playlist.
    assert service.calls == []
    playlists.save_imported_playlist.assert_not_called()


def test_resolve_reports_progress_for_every_item_including_repeats(client, tracker, resolver):
    # The same song twice: ProgressTracker keys completed items by label, so
    # non-unique labels would stall the count one short.
    same = {"title": "Get Lucky", "artist": "Daft Punk", "album": None}
    progress_id = _resolve(client, [same, same]).json()["progress_id"]

    assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)

    state = tracker.get_progress(progress_id)
    assert state.completed == 2
    assert state.percentage == 100.0
    assert state.active == {}


def test_resolve_marks_the_job_failed_when_resolution_blows_up(client, tracker):
    app.dependency_overrides[playlist_routes.get_resolution_service] = lambda: ExplodingResolver()
    try:
        progress_id = _resolve(
            client, [{"title": "Get Lucky", "artist": "Daft Punk", "album": None}]
        ).json()["progress_id"]
        assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)
        assert tracker.get_progress(progress_id).status == "failed"

        results = client.get(f"/api/playlists/spotify-export/resolve/{progress_id}").json()
        assert results["status"] == "failed"
        assert "provider is down" in results["error"]
    finally:
        app.dependency_overrides.pop(playlist_routes.get_resolution_service, None)


def test_resolve_can_be_cancelled_and_keeps_what_it_found(client, tracker):
    slow = FakeResolver(delay=0.05)
    app.dependency_overrides[playlist_routes.get_resolution_service] = lambda: slow
    try:
        tracks = [{"title": f"Track {i}", "artist": "Someone", "album": None} for i in range(50)]
        progress_id = _resolve(client, tracks).json()["progress_id"]

        # Let it get going, then pull the switch.
        assert _wait_for(lambda: len(slow.seen) >= 2)
        cancel = client.post(f"/api/playlists/spotify-export/resolve/{progress_id}/cancel")
        assert cancel.status_code == 200

        assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)
        assert tracker.get_progress(progress_id).status == "cancelled"

        results = client.get(f"/api/playlists/spotify-export/resolve/{progress_id}").json()
        assert results["status"] == "cancelled"
        assert 0 < results["resolved"] < 50
        assert len(slow.seen) < 50
    finally:
        app.dependency_overrides.pop(playlist_routes.get_resolution_service, None)


def test_resolve_rejects_an_empty_track_list(client, resolver):
    assert _resolve(client, []).status_code == 422


def test_resolution_results_404_for_an_unknown_id(client):
    assert client.get("/api/playlists/spotify-export/resolve/nope").status_code == 404
    assert client.post("/api/playlists/spotify-export/resolve/nope/cancel").status_code == 404


def test_the_real_resolution_dependency_builds(client, monkeypatch):
    """The unmocked dependency must actually construct the service.

    Without this, the fakes below would happily pass while production 503'd on
    every resolve -- the constructor takes a config, a logger and the shared
    provider registry, not nothing. The registry is passed explicitly here for
    the same reason it is injected in production: imports and the
    ``/api/providers`` settings routes have to escalate through *one* registry,
    or turning a provider off in the UI would change an object nobody resolves
    through.
    """
    try:
        import app.domains.metadata.resolution_service  # noqa: F401
    except ImportError:
        pytest.skip("ResolutionService is not present in this checkout")

    from app.main import app as real_app

    # Start from an empty container slot so this builds the service rather
    # than reading one an earlier test cached.
    monkeypatch.delitem(real_app.state.container._services, "resolution_service", raising=False)
    registry = real_app.state.container.get_provider_registry()
    service = playlist_routes.get_resolution_service(container=real_app.state.container)
    assert callable(service.resolve)
    assert callable(service.resolve_many)
    assert service.registry is registry
    # The default escalation order is the one the cost model depends on.
    assert service.registry.order(ProviderKind.METADATA)[:2] == ["deezer", "musicbrainz"]


def test_resolve_is_503_when_the_resolution_service_is_unavailable(client, monkeypatch):
    """A missing resolution backend fails this one feature, not the whole API."""
    monkeypatch.delitem(app.state.container._services, "resolution_service", raising=False)

    real_import = builtins.__import__

    def _no_resolution_service(name, *args, **kwargs):
        if name == "app.domains.metadata.resolution_service":
            raise ImportError("not built yet")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_resolution_service)

    response = _resolve(client, [{"title": "Get Lucky", "artist": "Daft Punk", "album": None}])
    assert response.status_code == 503


# --------------------------------------------------------------------------- import

def test_import_carries_the_approved_duration_into_the_download(client, tracker, downloads):
    """Preserve the approved recording's duration through export conversion.

    Video selection needs it to reject live, extended, or sped-up versions of
    the same title."""
    service, _playlists = downloads

    response = client.post(
        "/api/playlists/spotify-export/import",
        json={
            "playlistName": "Road Trip",
            "tracks": [
                {
                    "title": "Get Lucky",
                    "artist": "Daft Punk",
                    "album": "RAM",
                    "durationSeconds": 369.0,
                }
            ],
        },
    )

    assert response.status_code == 200
    assert _wait_for(lambda: bool(service.calls))
    # Seconds on the wire, milliseconds to the engine — converted once, here.
    assert service.calls[0]["tracks"][0]["duration_ms"] == 369000


def test_import_queues_only_the_confirmed_tracks(client, tracker, downloads, tmp_path):
    service, playlists = downloads

    response = client.post(
        "/api/playlists/spotify-export/import",
        json={
            "playlistName": "Road Trip",
            "tracks": [{"title": "Get Lucky", "artist": "Daft Punk", "album": "RAM"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "started"
    assert body["total"] == 1
    progress_id = body["progress_id"]
    assert tracker.get_progress(progress_id) is not None
    assert body["destination"] == str(tmp_path)

    assert _wait_for(lambda: bool(service.calls))
    call = service.calls[0]
    # The download engine speaks the Spotify track shape.
    assert call["tracks"] == [
        {"name": "Get Lucky", "artist": "Daft Punk", "album": "RAM", "duration_ms": None,
         "album_images": None, "provider": None, "provider_id": None, "isrc": None, "recording_mbid": None}
    ]
    assert call["progress_id"] == progress_id
    assert call["destination"] == tmp_path

    assert _wait_for(lambda: playlists.save_imported_playlist.called)
    saved = playlists.save_imported_playlist.call_args.kwargs
    assert saved["name"] == "Road_Trip"
    assert saved["tracks"][0]["title"] == "Get Lucky"
    assert saved["tracks"][0]["path"] == str(tmp_path / "RAM" / "track.mp3")


def test_import_playlist_name_does_not_select_a_music_destination(client, downloads):
    response = client.post(
        "/api/playlists/spotify-export/import",
        json={"playlistName": "../../etc", "tracks": [{"title": "x", "artist": None, "album": None}]},
    )

    assert response.status_code == 200
    assert response.json()["destination"] == str(downloads[0].config.base_music_dir)


def test_import_marks_the_progress_entry_failed_when_the_download_blows_up(client, tracker, tmp_path):
    class Boom(FakeDownloadService):
        async def download_spotify_playlist(self, **kwargs):
            raise RuntimeError("yt-dlp exploded")

    app.dependency_overrides[get_download_service] = lambda: Boom(tmp_path)
    app.dependency_overrides[get_playlist_service] = lambda: Mock()
    try:
        progress_id = client.post(
            "/api/playlists/spotify-export/import",
            json={"playlistName": "Road Trip", "tracks": [{"title": "x", "artist": None, "album": None}]},
        ).json()["progress_id"]

        assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)
        assert tracker.get_progress(progress_id).status == "failed"
    finally:
        app.dependency_overrides.pop(get_download_service, None)
        app.dependency_overrides.pop(get_playlist_service, None)


class TestApprovedIdentitySurvivesImport:
    """The review step decides WHICH recording is wanted; import must honour it.

    Without these, /import accepts only title/artist/album, the download
    re-searches YouTube by text, and can acquire a different recording than the
    one the user just approved — which makes the review screen decorative.
    """

    def test_import_accepts_the_resolved_identity(self, client):
        from app.domains.playlists.routes import ExportTrackRef

        ref = ExportTrackRef.model_validate({
            "title": "Get Lucky",
            "artist": "Daft Punk",
            "album": "Random Access Memories",
            "durationSeconds": 369.0,
            "isrc": "USQX91300809",
            "recordingMbid": "3cd1aed4-0000-0000-0000-000000000000",
        })
        assert ref.duration_seconds == 369.0
        assert ref.isrc == "USQX91300809"
        assert ref.recording_mbid.startswith("3cd1aed4")

    def test_identity_fields_stay_optional_for_resolve(self):
        """/resolve is fed raw export rows, which carry none of them."""
        from app.domains.playlists.routes import ExportTrackRef

        ref = ExportTrackRef.model_validate({"title": "Get Lucky"})
        assert ref.duration_seconds is None and ref.isrc is None

    def test_wrong_length_file_is_flagged(self, tmp_path):
        """A 248s Radio Edit standing in for a 369s album track must be caught."""
        from unittest.mock import patch
        from app.domains.playlists.export_import import (
            verify_acquired_durations as _verify_acquired_durations,
        )
        from app.domains.playlists.routes import ExportTrackRef

        track = ExportTrackRef(title="Get Lucky", artist="Daft Punk", duration_seconds=369.0)
        result = type("R", (), {
            "success": True, "file_path": tmp_path / "x.mp3",
            "title": "Get Lucky", "artist": "Daft Punk",
        })()

        fake = type("A", (), {"info": type("I", (), {"length": 248.0})()})()
        with patch("app.domains.playlists.export_import.MutagenFile", return_value=fake):
            warnings = _verify_acquired_durations([track], [result])

        assert len(warnings) == 1
        assert "248" in warnings[0] and "369" in warnings[0]

    def test_correct_length_file_is_not_flagged(self, tmp_path):
        from unittest.mock import patch
        from app.domains.playlists.export_import import (
            verify_acquired_durations as _verify_acquired_durations,
        )
        from app.domains.playlists.routes import ExportTrackRef

        track = ExportTrackRef(title="Get Lucky", artist="Daft Punk", duration_seconds=369.0)
        result = type("R", (), {
            "success": True, "file_path": tmp_path / "x.mp3",
            "title": "Get Lucky", "artist": "Daft Punk",
        })()

        fake = type("A", (), {"info": type("I", (), {"length": 372.0})()})()
        with patch("app.domains.playlists.export_import.MutagenFile", return_value=fake):
            assert _verify_acquired_durations([track], [result]) == []

    def test_no_expected_duration_means_no_verification(self, tmp_path):
        """Export-only rows have no duration, so there is nothing to check."""
        from app.domains.playlists.export_import import (
            verify_acquired_durations as _verify_acquired_durations,
        )
        from app.domains.playlists.routes import ExportTrackRef

        track = ExportTrackRef(title="Get Lucky", artist="Daft Punk")
        result = type("R", (), {
            "success": True, "file_path": tmp_path / "x.mp3",
            "title": "Get Lucky", "artist": "Daft Punk",
        })()
        assert _verify_acquired_durations([track], [result]) == []


# ------------------------------------------------------- response contracts

class TestTheWireShapeOfTheThreeCalls:
    """Assert exact keys after response-model filtering, including mixed wire spellings.

    Value checks alone cannot detect a silently omitted field.
    """

    def test_the_parse_report_keeps_its_diagnostic_half(self, client):
        """``unreadMembers`` is how a changed export layout becomes visible.

        Without it a file the parser did not recognise leaves no trace at all —
        no playlist, no warning — which is exactly when somebody needs to know.
        """
        data = _export_zip([("Road Trip", [("Get Lucky", "Daft Punk", "RAM")])])

        body = client.post(
            "/api/playlists/spotify-export/parse",
            files={"file": ("export.zip", data, "application/zip")},
        ).json()

        assert set(body) == {
            "playlistCount", "trackCount", "warnings", "sourceFiles",
            "unreadMembers", "unrecognizedCount", "playlists",
        }
        assert set(body["playlists"][0]) == {
            "name", "description", "modifiedAt", "trackCount", "tracks",
        }
        assert set(body["playlists"][0]["tracks"][0]) == {
            "title", "artist", "album", "spotifyUri", "addedAt",
        }
        # The zip carries a ReadMeFirst.txt, so there is always one to inspect.
        assert set(body["unreadMembers"][0]) == {
            "filename", "sizeBytes", "category", "detail",
        }

    def test_the_started_resolution_body(self, client, tracker, resolver):
        body = _resolve(
            client, [{"title": "Get Lucky", "artist": "Daft Punk", "album": None}]
        ).json()

        assert set(body) == {
            "success", "status", "progress_id", "playlistName", "total",
        }

    def test_the_resolution_readout_body(self, client, tracker, resolver):
        """``counts`` and ``results`` are keyed by confidence bucket.

        Mappings rather than three named fields on purpose: a bucket the matcher
        gains later must show up rather than be dropped, and the match rows
        themselves stay free-form for the same reason.
        """
        progress_id = _resolve(
            client, [{"title": "Get Lucky", "artist": "Daft Punk", "album": None}]
        ).json()["progress_id"]
        assert _wait_for(lambda: tracker.get_progress(progress_id).is_terminal)

        body = client.get(
            f"/api/playlists/spotify-export/resolve/{progress_id}"
        ).json()

        assert set(body) == {
            "progressId", "playlistName", "status", "total", "resolved",
            "counts", "results", "error",
        }
        assert body["error"] is None, "null when nothing broke — the key still ships"
        # A provider-specific match row must arrive whole; nothing models it.
        assert "wanted" in body["results"]["strong"][0]

    def test_the_cancel_acknowledgement_body(self, client, tracker, resolver):
        progress_id = _resolve(
            client, [{"title": "Get Lucky", "artist": "Daft Punk", "album": None}]
        ).json()["progress_id"]

        body = client.post(
            f"/api/playlists/spotify-export/resolve/{progress_id}/cancel"
        ).json()

        assert set(body) == {"success", "progressId", "status", "resolved"}

    def test_the_started_import_body_says_where_the_music_will_land(self, client, tracker, downloads):
        body = client.post(
            "/api/playlists/spotify-export/import",
            json={
                "playlistName": "Road Trip",
                "tracks": [{"title": "Get Lucky", "artist": "Daft Punk", "album": "RAM"}],
            },
        ).json()

        assert set(body) == {
            "success", "status", "progress_id", "playlistName", "total", "destination",
        }
        assert _wait_for(lambda: bool(downloads[0].calls))


def test_resolve_has_its_own_ledger_kind(client, tracker, resolver, tmp_path):
    from app.infra.jobs import Jobs
    ledger = Jobs(tmp_path / 'resolve.sqlite')
    tracker.ledger = ledger
    response = client.post('/api/playlists/spotify-export/resolve', json={
        'playlistName': 'Collection', 'tracks': [{'title': 'Track'}],
    })
    assert response.status_code == 200
    job = response.json()['progress_id']
    assert _wait_for(lambda: ledger.get(job)['state'] == 'succeeded')
    assert ledger.get(job)['kind'] == 'match'
    ledger.close()


@pytest.fixture
def job_accounts(monkeypatch, tmp_path):
    from app.domains.accounts.identity import TokenStore
    from app.domains.playlists import export_import

    accounts = TokenStore(tmp_path / 'accounts.json')
    actors = {}
    for label, role in [('starter', 'member'), ('other', 'member'), ('owner', 'owner')]:
        user, token = accounts.mint(label, role)
        actors[label] = (user.user_id, {'Authorization': f'Bearer {token}'})
    actors['local'] = ('local', {})
    actors['legacy'] = ('shared-token', {'Authorization': 'Bearer legacy-test-secret'})
    monkeypatch.setattr(app.state.container, 'get_token_store', lambda: accounts)
    monkeypatch.setattr(app.state.config, 'api_token', None)
    monkeypatch.setattr(app.state.config, 'allow_unauthenticated_remote', True)
    # Keep jobs running deterministically, without provider calls or downloads.
    monkeypatch.setattr(export_import, 'spawn_background', lambda coro: coro.close())
    return actors


@pytest.mark.parametrize('allowed', ['starter', 'owner', 'local', 'legacy'])
def test_resolve_read_and_cancel_are_starter_or_owner_only(
    client, tracker, resolver, job_accounts, monkeypatch, allowed,
):
    response = client.post('/api/playlists/spotify-export/resolve', json={
        'playlistName': 'Private collection', 'tracks': [{'title': 'Private track', 'artist': 'Artist'}],
    }, headers=job_accounts['starter'][1])
    assert response.status_code == 200
    progress_id = response.json()['progress_id']
    assert tracker.ledger.get(progress_id)['starter_user_id'] == job_accounts['starter'][0]
    assert tracker.get_progress(progress_id).starter_user_id == job_accounts['starter'][0]

    base = '/api/playlists/spotify-export/resolve'
    for headers in [job_accounts['other'][1], {'X-Forwarded-For': '192.0.2.10'}]:
        for method, suffix in [(client.get, ''), (client.post, '/cancel')]:
            denied = method(f'{base}/{progress_id}{suffix}', headers=headers)
            unknown = method(f'{base}/unknown{suffix}', headers=headers)
            assert denied.status_code == unknown.status_code == 404
            assert denied.content == unknown.content == b'{"detail":"Resolution not found"}'

    service = app.state.container.get_export_import_service()
    assert not service.job(progress_id).cancel.is_set()
    if allowed == 'legacy':
        monkeypatch.setattr(app.state.config, 'api_token', 'legacy-test-secret')
    headers = job_accounts[allowed][1]
    read = client.get(f'{base}/{progress_id}', headers=headers)
    assert read.status_code == 200
    assert read.json()['playlistName'] == 'Private collection'
    assert client.post(f'{base}/{progress_id}/cancel', headers=headers).status_code == 200
    assert service.job(progress_id).cancel.is_set()


@pytest.mark.parametrize('kind', ['resolve', 'import'])
@pytest.mark.parametrize('allowed', ['starter', 'owner', 'local', 'legacy'])
def test_export_progress_stream_poll_and_active_list_are_starter_or_owner_only(
    client, tracker, resolver, downloads, job_accounts, monkeypatch, kind, allowed,
):
    response = client.post(f'/api/playlists/spotify-export/{kind}', json={
        'playlistName': 'Private collection', 'tracks': [{'title': 'Private track', 'artist': 'Artist'}],
    }, headers=job_accounts['starter'][1])
    assert response.status_code == 200
    progress_id = response.json()['progress_id']
    assert tracker.ledger.get(progress_id)['starter_user_id'] == job_accounts['starter'][0]
    assert tracker.get_progress(progress_id).starter_user_id == job_accounts['starter'][0]

    # Anonymous remote callers have an unrestricted catalog, but are not job owners.
    for headers in [job_accounts['other'][1], {'X-Forwarded-For': '192.0.2.10'}]:
        assert client.get('/api/downloads/active', headers=headers).json() == {'jobs': [], 'count': 0}
        for route in ['download-progress-stream', 'download-progress']:
            denied = client.get(f'/api/{route}/{progress_id}', headers=headers)
            unknown = client.get(f'/api/{route}/unknown', headers=headers)
            assert denied.status_code == unknown.status_code == 404
            assert denied.content == unknown.content == b'{"detail":"Progress ID not found"}'

    if allowed == 'legacy':
        monkeypatch.setattr(app.state.config, 'api_token', 'legacy-test-secret')
    headers = job_accounts[allowed][1]
    active = client.get('/api/downloads/active', headers=headers)
    assert active.status_code == 200
    assert [job['progress_id'] for job in active.json()['jobs']] == [progress_id]
    assert client.get(f'/api/download-progress/{progress_id}', headers=headers).status_code == 200
    # Terminal progress closes SSE immediately, so the HTTP test cannot hang.
    tracker.complete_progress(progress_id, 'done')
    streamed = client.get(f'/api/download-progress-stream/{progress_id}', headers=headers)
    assert streamed.status_code == 200
    assert streamed.headers['content-type'].startswith('text/event-stream')
    payload = json.loads(streamed.text.removeprefix('data: ').strip())
    assert payload['progress_id'] == progress_id and payload['terminal']


@pytest.mark.parametrize('existing_owner', [None, 'member', 'other'])
def test_import_creates_owned_playlist_immediately_without_wiping_existing(
    client, downloads, config, monkeypatch, existing_owner,
):
    from app.dependencies import DependencyContainer
    from app.infra.identity import current_principal, Principal
    from app.domains.playlists import export_import
    service = DependencyContainer(config).get_playlist_service()
    principal = Principal('member', 'Member')
    existing = existing_owner is not None
    if existing:
        service.save_imported_playlist('Collection', None, [
            {'path': str(config.base_music_dir / 'kept.mp3'), 'title': 'Kept'},
        ], principal=Principal(existing_owner, 'Account'))
    target = config.playlist_dir / 'Collection.json'
    before = target.read_bytes() if existing else None
    monkeypatch.setattr(export_import, 'spawn_background', lambda coro: coro.close())
    app.dependency_overrides[get_playlist_service] = lambda: service
    app.dependency_overrides[current_principal] = lambda: principal
    try:
        response = client.post('/api/playlists/spotify-export/import', json={
            'playlistName': 'Collection', 'tracks': [{'title': 'New'}],
        })
        assert response.status_code == 200
        assert target.is_file()
        playlist = service.playlist_repo.load_playlist('Collection')
        assert playlist.owner_id == (existing_owner or principal.user_id)
        if existing:
            assert target.read_bytes() == before
        else:
            assert playlist.tracks == []
    finally:
        app.dependency_overrides.pop(current_principal, None)


def test_import_passes_approved_artwork_and_identity_additively(client, downloads):
    service, _ = downloads
    cover = 'https://cdn-images.dzcdn.net/images/cover/abc123/500x500-000000-80-0-0.jpg'
    response = client.post('/api/playlists/spotify-export/import', json={
        'playlistName': 'Collection', 'tracks': [{
            'title': 'Track', 'artist': 'Artist', 'album': 'Album', 'durationSeconds': 180,
            'coverUrl': cover, 'provider': 'deezer', 'providerId': '123',
            'isrc': 'USAAA2600001', 'mbid': 'recording-id',
        }],
    })
    assert response.status_code == 200
    assert _wait_for(lambda: bool(service.calls))
    track = service.calls[0]['tracks'][0]
    assert track['album_images'] == [{'url': cover.replace('500x500', '1000x1000')}]
    assert (track['provider'], track['provider_id'], track['isrc'], track['recording_mbid']) == (
        'deezer', '123', 'USAAA2600001', 'recording-id')
    assert track['duration_ms'] == 180000


def test_import_files_by_album_shares_folders_and_links_existing_paths(client, tracker, config, monkeypatch):
    """Route -> importer -> real adapter/pipeline -> playlist JSON, without network."""
    monkeypatch.setattr('app.domains.acquisition.import_stage.validate', lambda *args, **kwargs: {})
    import logging
    from pathlib import Path
    from app.dependencies import DependencyContainer
    from app.domains.acquisition.adapters import SpotifyAdapter
    from app.domains.acquisition.services import Pipeline
    from app.domains.downloads.core import ResolvedVideo
    from app.domains.downloads.models import DownloadResult
    from app.domains.user_library.store import UserTrackStore
    from app.infra.identity import current_principal, Principal
    from app.infra.jobs import Jobs

    root = config.base_music_dir.resolve()
    existing = root / 'Existing release' / 'Already here.mp3'
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b'existing recording')
    existing_stat = existing.stat()
    ledger = Jobs(root.parent / 'import-test.sqlite')
    store = UserTrackStore(root.parent / 'import-test-tracks.json')
    principal = Principal('listener', 'Listener')
    engine = SimpleNamespace(completion_listeners=[], calls=[])

    async def resolve(request):
        return ResolvedVideo('https://youtube.com/watch?v=fixture', 'fixture', decision='STRONG')

    async def download(url, destination, filename, progress=None):
        engine.calls.append(filename)
        destination.mkdir(parents=True, exist_ok=True)
        path = destination / f'{filename}.m4a'
        path.write_bytes(b'new recording')
        return path

    async def finish(*args):
        pass

    engine._resolve_source_url = resolve
    engine._download_audio_file = download
    engine._finish_staged_file = finish
    engine._success_result = lambda path, request: DownloadResult(True, path, title=request.metadata.title, artist=request.metadata.artist)
    ownership = Mock()
    ownership.lookup_many.side_effect = lambda tracks: [
        SimpleNamespace(owned=t['title'] == 'Already here', match=SimpleNamespace(path=str(existing))) for t in tracks
    ]
    pipeline = Pipeline(ledger=ledger, engine=engine, ownership=ownership, user_tracks=store,
                        root=root, data=root.parent)
    engine.download_multiple_tracks = pipeline.legacy
    adapter = SpotifyAdapter(engine, logging.getLogger(__name__))
    service = SimpleNamespace(config=config, download_spotify_playlist=adapter.download_playlist)
    playlists = DependencyContainer(config).get_playlist_service()
    app.dependency_overrides[get_download_service] = lambda: service
    app.dependency_overrides[get_playlist_service] = lambda: playlists
    app.dependency_overrides[current_principal] = lambda: principal
    app.dependency_overrides[get_user_track_store] = lambda: store
    try:
        for name, title in [('First list', 'First song'), ('Second list', 'Second song')]:
            response = client.post('/api/playlists/spotify-export/import', json={
                'playlistName': name,
                'tracks': [{'title': title, 'artist': 'Artist', 'album': 'Shared: Album'},
                           {'title': 'Already here', 'artist': 'Artist', 'album': 'Requested release'}],
            })
            assert response.status_code == 200
            assert Path(response.json()['destination']).resolve() == root
            playlist_file = config.playlist_dir / f'{name.replace(" ", "_")}.json'
            assert _wait_for(lambda p=playlist_file: p.exists() and len(json.loads(p.read_text())['tracks']) == 2)
            paths = [Path(t['path']) for t in json.loads(playlist_file.read_text())['tracks']]
            assert paths[0].parent == root / 'Shared Album'
            assert paths[0].is_file() and paths[0].suffix == '.m4a'
            assert paths[1] == existing
            assert not (root / name.replace(' ', '_')).exists()
        assert len(list((root / 'Shared Album').glob('*.m4a'))) == 2
        assert len(engine.calls) == 2
        # Reading metadata may update atime (relatime on Linux). Linking must
        # preserve the recording and its identity, size and modification time.
        assert existing.read_bytes() == b'existing recording'
        current_stat = existing.stat()
        assert (current_stat.st_dev, current_stat.st_ino, current_stat.st_size, current_stat.st_mtime_ns) == (
            existing_stat.st_dev, existing_stat.st_ino, existing_stat.st_size, existing_stat.st_mtime_ns)
        assert not (root / 'Requested release').exists()
        assert store.get(principal.user_id, 'Existing release/Already here.mp3') is not None
    finally:
        for dependency in (get_download_service, get_playlist_service, current_principal, get_user_track_store):
            app.dependency_overrides.pop(dependency, None)
        ledger.close()
