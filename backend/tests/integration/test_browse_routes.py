"""Pin browse identities and distinct unavailable/provider-failure responses.

Clients navigate by provider refs and choose recovery actions from status codes.
The mocked service makes no provider requests.
"""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_browse_service
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
from app.domains.browse.services import BrowseService, ProviderUnavailable
from app.exceptions import ExternalAPIError, ValidationError
from app.main import app


def _ref(entity_id="302127"):
    return ProviderRef(provider="deezer", id=entity_id, url=f"https://www.deezer.com/album/{entity_id}")


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
def client_and_service():
    service = Mock(spec=BrowseService)
    app.dependency_overrides[get_browse_service] = lambda: service
    try:
        yield TestClient(app), service
    finally:
        app.dependency_overrides.pop(get_browse_service, None)


class TestAlbumPayload:
    def test_shape(self, client_and_service):
        client, service = client_and_service
        service.get_album.return_value = AlbumPage(album=_album(), tracks=[_track()])

        response = client.get("/api/browse/album/deezer/302127")

        assert response.status_code == 200
        body = response.json()
        assert body["album"]["ref"] == {
            "provider": "deezer",
            "id": "302127",
            "url": "https://www.deezer.com/album/302127",
        }
        assert body["album"]["title"] == "Discovery"
        assert body["album"]["genres"] == ["Electro"]

    def test_track_carries_what_acquisition_needs(self, client_and_service):
        """title/artist/album place the file; duration vetoes; isrc identifies."""
        client, service = client_and_service
        service.get_album.return_value = AlbumPage(album=_album(), tracks=[_track()])

        track = client.get("/api/browse/album/deezer/302127").json()["tracks"][0]

        assert track["title"] == "One More Time"
        assert track["artistName"] == "Daft Punk"
        assert track["albumTitle"] == "Discovery"
        # Seconds on the wire, named so it cannot be mistaken for milliseconds.
        assert track["durationSeconds"] == 320.0
        assert track["trackPosition"] == 1
        assert track["isrc"] == "GBDUW0000053"
        assert track["coverUrl"]

    def test_refresh_is_forwarded(self, client_and_service):
        client, service = client_and_service
        service.get_album.return_value = AlbumPage(album=_album(), tracks=[])

        client.get("/api/browse/album/deezer/302127?refresh=true")

        assert service.get_album.call_args.kwargs["force_refresh"] is True


class TestStatusCodes:
    def test_provider_turned_off_is_409_not_502(self, client_and_service):
        """A settings problem, not a network problem. Retrying cannot fix it."""
        client, service = client_and_service
        service.get_album.side_effect = ProviderUnavailable(
            "«Deezer» está desactivada.", "deezer"
        )

        response = client.get("/api/browse/album/deezer/302127")

        assert response.status_code == 409
        # Rendered verbatim by the UI, so it is Spanish like the rest of the app.
        assert "desactivada" in response.json()["detail"]

    def test_missing_entity_is_404(self, client_and_service):
        """Deezer reports "no data" as code 800 inside an HTTP 200 body."""
        client, service = client_and_service
        service.get_album.side_effect = ExternalAPIError(
            "Deezer error: no data",
            api_name="deezer",
            details={"deezer_error": {"type": "DataException", "message": "no data", "code": 800}},
        )

        response = client.get("/api/browse/album/deezer/999999999999")

        assert response.status_code == 404

    def test_provider_failure_is_502(self, client_and_service):
        client, service = client_and_service
        service.get_album.side_effect = ExternalAPIError(
            "Deezer error: Quota limit exceeded",
            api_name="deezer",
            details={"deezer_error": {"code": 4}},
        )

        response = client.get("/api/browse/album/deezer/302127")

        assert response.status_code == 502

    def test_malformed_id_is_422_not_500(self, client_and_service):
        """`_path_id` refuses a non-numeric id; that is the caller's error."""
        client, service = client_and_service
        service.get_album.side_effect = ValueError("invalid Deezer id '../chart'")

        response = client.get("/api/browse/album/deezer/nonsense")

        assert response.status_code == 422

    def test_validation_error_is_422(self, client_and_service):
        client, service = client_and_service
        service.search.side_effect = ValidationError("Search query cannot be empty")

        response = client.get("/api/browse/search?q=+")

        assert response.status_code == 422


class TestArtistAndPlaylist:
    def test_artist_sections_and_partial(self, client_and_service):
        client, service = client_and_service
        service.get_artist.return_value = ArtistPage(
            artist=BrowseArtist(ref=ProviderRef(provider="deezer", id="27"), name="Daft Punk", fan_count=5),
            top_tracks=[_track()],
            albums=[_album()],
            related=[],
            playlists=[],
            partial=["related"],
        )

        body = client.get("/api/browse/artist/deezer/27").json()

        assert body["artist"]["name"] == "Daft Punk"
        assert len(body["topTracks"]) == 1
        assert len(body["albums"]) == 1
        # Named so the UI can say "this part is missing" rather than implying
        # the artist has no related artists.
        assert body["partial"] == ["related"]

    def test_playlist_shape(self, client_and_service):
        client, service = client_and_service
        service.get_playlist.return_value = PlaylistPage(
            playlist=BrowsePlaylist(
                ref=ProviderRef(provider="deezer", id="908"),
                title="En mode 60",
                owner="Alex",
                track_count=1,
            ),
            tracks=[_track()],
        )

        body = client.get("/api/browse/playlist/deezer/908").json()

        assert body["playlist"]["title"] == "En mode 60"
        assert body["playlist"]["owner"] == "Alex"
        assert body["tracks"][0]["isrc"] == "GBDUW0000053"


class TestSearch:
    def test_categories_are_separate(self, client_and_service):
        client, service = client_and_service
        service.search.return_value = SearchResults(
            query="daft punk",
            artists=[BrowseArtist(ref=ProviderRef(provider="deezer", id="27"), name="Daft Punk")],
            albums=[_album()],
            tracks=[_track()],
            playlists=[],
            requested=["artists", "albums", "tracks", "playlists"],
            failed=["playlists"],
        )

        body = client.get("/api/browse/search?q=daft+punk").json()

        assert body["query"] == "daft punk"
        assert [a["name"] for a in body["artists"]] == ["Daft Punk"]
        assert [a["title"] for a in body["albums"]] == ["Discovery"]
        # A failed category is named rather than silently returning nothing, so
        # "no playlists exist" and "playlists could not be searched" differ.
        assert body["failed"] == ["playlists"]

    def test_types_filter_is_forwarded(self, client_and_service):
        client, service = client_and_service
        service.search.return_value = SearchResults(query="x")

        client.get("/api/browse/search?q=x&types=albums&types=tracks")

        assert service.search.call_args.kwargs["categories"] == ["albums", "tracks"]

    def test_search_mode_defaults_full_and_accepts_typing(self, client_and_service):
        client, service = client_and_service
        service.search.return_value = SearchResults(query="dua")
        assert client.get("/api/browse/search?q=dua").status_code == 200
        assert service.search.call_args.kwargs["mode"] == "full"
        assert client.get("/api/browse/search?q=dua&mode=typing").status_code == 200
        assert service.search.call_args.kwargs["mode"] == "typing"
        assert client.get("/api/browse/search?q=dua&mode=unknown").status_code == 422

    def test_limit_is_bounded_by_the_route(self, client_and_service):
        client, service = client_and_service
        service.search.return_value = SearchResults(query="x")

        assert client.get("/api/browse/search?q=x&limit=999").status_code == 422
        assert client.get("/api/browse/search?q=x&limit=0").status_code == 422

    def test_query_is_required(self, client_and_service):
        client, _service = client_and_service

        assert client.get("/api/browse/search").status_code == 422


class TestAuth:
    def test_browse_is_not_in_the_public_allowlist(self):
        """Browse must stay token-gated like every other domain router."""
        from app.domains.accounts.auth import is_public_route

        for path in (
            "/api/browse/album/deezer/302127",
            "/api/browse/artist/deezer/27",
            "/api/browse/playlist/deezer/908",
            "/api/browse/search",
        ):
            assert not is_public_route("GET", path), f"{path} must not be public"


class TestOwnershipRoute:
    """POST /api/library/ownership — batch, and never fails the page."""

    @pytest.fixture
    def ownership_client(self):
        from unittest.mock import Mock

        from app.dependencies import get_ownership_index

        index = Mock()
        app.dependency_overrides[get_ownership_index] = lambda: index
        try:
            yield TestClient(app), index
        finally:
            app.dependency_overrides.pop(get_ownership_index, None)

    def test_batch_shape(self, ownership_client):
        from app.domains.music.ownership import OwnedTrack, OwnershipVerdict

        client, index = ownership_client
        index.lookup_many.return_value = [
            OwnershipVerdict(
                owned=True,
                match=OwnedTrack(
                    title="Butter", artist="BTS", album="Butter",
                    path="/music/Butter/01 - Butter.mp3", duration_s=183.0, track_number=1,
                ),
            ),
            OwnershipVerdict(owned=False),
        ]

        response = client.post(
            "/api/library/ownership",
            json={
                "tracks": [
                    {"title": "Butter", "artist": "BTS", "durationSeconds": 183.0},
                    {"title": "Butter (Instrumental)", "artist": "BTS", "durationSeconds": 183.0},
                ]
            },
        )

        assert response.status_code == 200
        results = response.json()["results"]
        assert [r["owned"] for r in results] == [True, False]
        assert results[0]["match"]["path"].endswith("01 - Butter.mp3")
        assert results[0]["match"]["durationSeconds"] == 183.0

    def test_empty_batch_short_circuits(self, ownership_client):
        client, index = ownership_client

        response = client.post("/api/library/ownership", json={"tracks": []})

        assert response.json() == {"results": []}
        index.lookup_many.assert_not_called()

    def test_a_broken_library_degrades_rather_than_failing_the_page(self, ownership_client):
        """A browse page without ownership markers beats no browse page."""
        client, index = ownership_client
        index.lookup_many.side_effect = OSError("disk gone")

        response = client.post(
            "/api/library/ownership",
            json={"tracks": [{"title": "Butter", "artist": "BTS"}]},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["degraded"] is True
        assert body["results"] == [{"owned": False, "match": None, "nearMatch": None, "reason": None}]

    def test_an_oversized_batch_is_refused(self, ownership_client):
        client, _index = ownership_client

        response = client.post(
            "/api/library/ownership",
            json={"tracks": [{"title": f"t{i}"} for i in range(501)]},
        )

        assert response.status_code in (422, 400)

    def test_ownership_is_not_public(self):
        from app.domains.accounts.auth import is_public_route

        assert not is_public_route("POST", "/api/library/ownership")


class TestAcquire:
    """POST /api/browse/acquire — the terminal action of browsing.

    Two things are pinned hard: the identity fields reach the download engine
    (that is the entire payoff of browsing over typing), and the STREAMING kind
    actually gates acquisition (that is what makes the YouTube toggle real
    rather than decorative).
    """

    @pytest.fixture
    def acquire_client(self, tmp_path):
        from unittest.mock import Mock

        from app.dependencies import (
            get_download_service,
            get_ownership_index,
            get_progress_tracker,
            get_provider_registry,
        )
        from app.providers.registry import ProviderKind

        calls = {}

        async def _download(**kwargs):
            calls.update(kwargs)

        download_service = Mock()
        download_service.config.base_music_dir = tmp_path
        download_service.download_spotify_playlist = _download

        registry = Mock()
        registry.order = Mock(return_value=["youtube"])

        tracker = Mock()
        ownership = Mock()

        app.dependency_overrides[get_download_service] = lambda: download_service
        app.dependency_overrides[get_progress_tracker] = lambda: tracker
        app.dependency_overrides[get_provider_registry] = lambda: registry
        app.dependency_overrides[get_ownership_index] = lambda: ownership
        try:
            yield TestClient(app), calls, registry, tracker, ownership, ProviderKind
        finally:
            for dep in (
                get_download_service,
                get_progress_tracker,
                get_provider_registry,
                get_ownership_index,
            ):
                app.dependency_overrides.pop(dep, None)

    @staticmethod
    def _body():
        return {
            "tracks": [
                {
                    "title": "One More Time",
                    "artistName": "Daft Punk",
                    "albumTitle": "Discovery",
                    "trackPosition": 1,
                    "durationSeconds": 320.0,
                    "coverUrl": (
                        "https://cdn-images.dzcdn.net/images/cover/"
                        "5718f7c81c27e0b2417e2a4c45224f8a/500x500-000000-80-0-0.jpg"
                    ),
                    "isrc": "GBDUW0000053",
                }
            ]
        }

    def test_identity_reaches_the_download_engine(self, acquire_client):
        """Browsing beats typing only if the known recording survives the hop."""
        client, calls, _r, _t, _o, _k = acquire_client

        response = client.post("/api/browse/acquire", json=self._body())

        assert response.status_code == 200
        assert response.json()["status"] == "started"
        assert _wait_for_calls(calls)
        track = calls["tracks"][0]
        # 'name', not 'title' — the engine's shape.
        assert track["name"] == "One More Time"
        assert track["artist"] == "Daft Punk"
        assert track["album"] == "Discovery"
        assert track["track_number"] == 1
        # Seconds on the wire, milliseconds to the engine. Converted once, and
        # this is the field that arms DURATION_VETO_S.
        assert track["duration_ms"] == 320000
        # Not the URL that was sent. The client forwards the row it renders,
        # which is the 500 px display cover; what gets embedded into a file the
        # user keeps forever is the 1000 px variant, derived from the same URL
        # so it costs no second call to a quota-limited provider.
        assert track["album_images"] == [
            {
                "url": (
                    "https://cdn-images.dzcdn.net/images/cover/"
                    "5718f7c81c27e0b2417e2a4c45224f8a/1000x1000-000000-80-0-0.jpg"
                )
            }
        ]

    def test_the_job_holds_the_ownership_index_until_it_finishes(self, acquire_client):
        """Started before the job spawns, finished when it ends — so a burst of
        acquisitions rebuilds the index once, not once per song."""
        import time

        client, calls, _r, _t, ownership, _k = acquire_client

        response = client.post("/api/browse/acquire", json=self._body())

        assert response.status_code == 200
        ownership.acquisition_started.assert_called_once_with()
        assert _wait_for_calls(calls)
        deadline = time.time() + 2.0
        while not ownership.acquisition_finished.called and time.time() < deadline:
            time.sleep(0.02)
        ownership.acquisition_finished.assert_called_once_with()
        ownership.invalidate.assert_not_called()

    def test_an_album_is_not_nested_inside_itself(self, acquire_client, tmp_path):
        """The adapter already files tracks under `destination / album`.

        Naming the album as the destination too produced
        Music/Discovery/Discovery. Found by looking at the disk after a real
        run; no unit test would have noticed, because the nesting happens in a
        different module than the one that chose the destination.
        """
        client, calls, _r, _t, _o, _k = acquire_client

        client.post("/api/browse/acquire", json=self._body())

        assert _wait_for_calls(calls)
        assert calls["destination"] == tmp_path, "an album inherits the music root"

    def test_an_explicit_folder_is_honoured(self, acquire_client, tmp_path):
        """A playlist does want its own parent folder."""
        client, calls, _r, _t, _o, _k = acquire_client
        body = self._body()
        body["folder"] = "En mode 60"

        client.post("/api/browse/acquire", json=body)

        assert _wait_for_calls(calls)
        assert calls["destination"] == (tmp_path / "En mode 60").resolve()

    def test_no_streaming_provider_refuses_with_409(self, acquire_client):
        """Turning YouTube off in Settings → Sources must actually stop this."""
        client, calls, registry, _t, _o, _k = acquire_client
        registry.order.return_value = []

        response = client.post("/api/browse/acquire", json=self._body())

        assert response.status_code == 409
        assert "fuente de audio" in response.json()["detail"]
        assert not calls, "must not download when no audio source is enabled"

    def test_it_is_the_streaming_kind_that_gates(self, acquire_client):
        client, _c, registry, _t, _o, kind = acquire_client

        client.post("/api/browse/acquire", json=self._body())

        # The first ask is the gate; the genre lookup asks for METADATA after.
        assert registry.order.call_args_list[0][0][0] is kind.STREAMING

    def test_progress_is_registered_before_returning(self, acquire_client):
        """Or an SSE client attaching immediately races a 404."""
        client, _c, _r, tracker, _o, _k = acquire_client

        body = client.post("/api/browse/acquire", json=self._body()).json()

        tracker.create_progress.assert_called_once_with(body["progress_id"], 1)

    def test_empty_and_oversized_batches_are_refused(self, acquire_client):
        client, _c, _r, _t, _o, _k = acquire_client

        assert client.post("/api/browse/acquire", json={"tracks": []}).status_code == 422
        big = {"tracks": [{"title": f"t{i}"} for i in range(201)]}
        assert client.post("/api/browse/acquire", json=big).status_code == 422

    def test_a_traversing_folder_is_refused(self, acquire_client):
        client, calls, _r, _t, _o, _k = acquire_client
        body = self._body()
        body["folder"] = "../../etc"

        response = client.post("/api/browse/acquire", json=body)

        assert response.status_code == 400
        assert not calls

    def test_acquire_is_not_public(self):
        from app.domains.accounts.auth import is_public_route

        assert not is_public_route("POST", "/api/browse/acquire")


def _wait_for_calls(calls, timeout=2.0):
    """The download runs as a background task; give it a moment to start."""
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if calls:
            return True
        time.sleep(0.02)
    return False


class TestActiveDownloadsListing:
    """GET /api/downloads/active — the endpoint that makes jobs discoverable.

    Without it, a progress entry was only reachable by an id the *starting*
    component happened to hold, so a job vanished from the UI the moment that
    component unmounted (which App.jsx does on every navigation) and a job
    started anywhere else was never visible at all.
    """

    @pytest.fixture
    def listing_client(self):
        from app.infra.progress import ProgressTracker
        from app.dependencies import get_progress_tracker

        tracker = ProgressTracker()
        app.dependency_overrides[get_progress_tracker] = lambda: tracker
        try:
            yield TestClient(app), tracker
        finally:
            app.dependency_overrides.pop(get_progress_tracker, None)

    def test_lists_in_flight_jobs(self, listing_client):
        client, tracker = listing_client
        tracker.create_progress("a", 3)
        tracker.create_progress("b", 1)

        body = client.get("/api/downloads/active").json()

        assert body["count"] == 2
        assert {j["progress_id"] for j in body["jobs"]} == {"a", "b"}

    def test_finished_jobs_are_excluded_by_default(self, listing_client):
        client, tracker = listing_client
        tracker.create_progress("done", 1)
        tracker.complete_progress("done", "Downloaded 1/1 tracks", succeeded=1, failed=0)

        assert client.get("/api/downloads/active").json()["count"] == 0

    def test_recently_finished_can_be_included(self, listing_client):
        """So the UI can show an outcome instead of the job just vanishing."""
        client, tracker = listing_client
        tracker.create_progress("done", 1)
        tracker.complete_progress("done", "Downloaded 0/1 tracks (1 failed)", succeeded=0, failed=1)

        body = client.get("/api/downloads/active?include_finished_seconds=60").json()

        assert body["count"] == 1
        job = body["jobs"][0]
        assert job["terminal"] is True
        # The outcome must be readable without parsing the prose summary.
        assert job["succeeded"] == 0
        assert job["failed"] == 1

    def test_newest_first(self, listing_client):
        client, tracker = listing_client
        tracker.create_progress("old", 1)
        tracker.create_progress("new", 1)

        ids = [j["progress_id"] for j in client.get("/api/downloads/active").json()["jobs"]]

        assert ids[0] == "new"

    def test_empty_is_not_an_error(self, listing_client):
        client, _tracker = listing_client

        response = client.get("/api/downloads/active")

        assert response.status_code == 200
        assert response.json() == {"jobs": [], "count": 0}

    def test_the_window_is_bounded(self, listing_client):
        client, _tracker = listing_client

        assert client.get("/api/downloads/active?include_finished_seconds=99999").status_code == 422
        assert client.get("/api/downloads/active?include_finished_seconds=-1").status_code == 422

    def test_listing_is_not_public(self):
        from app.domains.accounts.auth import is_public_route

        assert not is_public_route("GET", "/api/downloads/active")


class TestLogsEndpoint:
    """GET /api/logs — Settings → Logs.

    A log viewer is one careless `?file=` away from being an arbitrary-file
    reader, so the allowlist is the test that matters most here.
    """

    @pytest.fixture
    def logs_client(self, tmp_path):
        from app.config import ConfigManager
        from app.dependencies import get_config

        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "krobi.log").write_text(
            "\n".join(
                [
                    "2026-08-20 10:00:00 INFO     app.main: Starting",
                    "2026-08-20 10:00:01 WARNING  app.deezer: slow",
                    "2026-08-20 10:00:02 ERROR    app.downloads: yt-dlp failed 403",
                ]
            )
            + "\n"
        )
        (log_dir / "krobi_errors.log").write_text(
            '{"timestamp": "2026-08-20T10:00:02Z", "level": "ERROR", '
            '"module": "app.downloads", "message": "yt-dlp failed"}\n'
        )

        config = ConfigManager.from_env()
        config.log_dir = log_dir
        app.dependency_overrides[get_config] = lambda: config
        try:
            yield TestClient(app), log_dir
        finally:
            app.dependency_overrides.pop(get_config, None)

    def test_tails_the_app_log(self, logs_client):
        client, _ = logs_client

        body = client.get("/api/logs?file=app").json()

        assert body["file"] == "app"
        assert len(body["lines"]) == 3
        assert "Starting" in body["lines"][0]

    def test_level_filter(self, logs_client):
        client, _ = logs_client

        body = client.get("/api/logs?file=app&level=ERROR").json()

        assert body["matched"] == 1
        assert body["scanned"] == 3
        assert "403" in body["lines"][0]

    def test_text_filter(self, logs_client):
        client, _ = logs_client

        assert client.get("/api/logs?file=app&q=deezer").json()["matched"] == 1
        assert client.get("/api/logs?file=app&q=nothinghere").json()["matched"] == 0

    def test_errors_log_is_json_per_line(self, logs_client):
        client, _ = logs_client

        body = client.get("/api/logs?file=errors").json()

        assert body["lines"][0].startswith("{")

    @pytest.mark.parametrize(
        "name",
        ["../../../etc/passwd", "..%2Fetc%2Fpasswd", "krobi.log", "nope", "", "/etc/passwd"],
    )
    def test_only_allowlisted_names_are_readable(self, logs_client, name):
        """`file` is a key into a fixed map, never a path fragment.

        Note `krobi.log` is refused too: the *filename* is not the key, so a
        caller cannot reach a file by guessing what it is called on disk.
        """
        client, _ = logs_client

        assert client.get(f"/api/logs?file={name}").status_code == 422

    def test_a_missing_log_is_not_an_error(self, logs_client):
        """A fresh install has no errors log until something fails."""
        client, log_dir = logs_client
        (log_dir / "krobi_errors.log").unlink()

        body = client.get("/api/logs?file=errors").json()

        assert body["lines"] == []
        assert body["sizeBytes"] == 0

    def test_line_count_is_capped(self, logs_client):
        client, log_dir = logs_client
        (log_dir / "krobi.log").write_text("\n".join(f"line {i}" for i in range(5000)) + "\n")

        body = client.get("/api/logs?file=app&lines=99999").json()

        assert len(body["lines"]) == 2000
        assert body["truncated"] is True
        # The tail, not the head — the end of a log is the interesting part.
        assert body["lines"][-1] == "line 4999"

    def test_a_filter_searches_past_the_visible_window(self, logs_client):
        """"Filter the log" must mean the log, not the last N lines of it.

        The interesting line is usually *older* than the noise at the tail, so
        filtering only the requested window answers "0 matches" for something
        that is plainly in the file.
        """
        client, log_dir = logs_client
        noise = [f"2026-08-20 10:00:00 INFO app.middleware: Request completed {i}" for i in range(400)]
        (log_dir / "krobi.log").write_text(
            "2026-08-20 09:00:00 ERROR app.downloads: yt-dlp failed 403\n" + "\n".join(noise) + "\n"
        )

        body = client.get("/api/logs?file=app&lines=50&q=yt-dlp").json()

        assert body["matched"] == 1, "the match is 400 lines behind the tail"
        assert "403" in body["lines"][0]
        assert body["scanned"] > 50

    def test_matches_are_capped_at_the_requested_count(self, logs_client):
        client, log_dir = logs_client
        (log_dir / "krobi.log").write_text("\n".join(f"yt-dlp line {i}" for i in range(500)) + "\n")

        body = client.get("/api/logs?file=app&lines=10&q=yt-dlp").json()

        assert body["matched"] == 500
        assert len(body["lines"]) == 10
        assert body["lines"][-1] == "yt-dlp line 499"
        assert body["truncated"] is True

    def test_a_symlink_out_of_the_log_dir_is_refused(self, logs_client):
        """The allowlist fixes the *name*; this fixes where that name points.

        Without the containment check, anyone who could drop a symlink into
        ~/Krobi/logs could read any file the backend user can read — and on a
        shared home server that is the whole point of having auth at all.
        """
        import os

        client, log_dir = logs_client
        (log_dir / "krobi.log").unlink()
        os.symlink("/etc/passwd", log_dir / "krobi.log")

        response = client.get("/api/logs?file=app")

        assert response.status_code == 404
        assert "passwd" not in response.text

    def test_logs_are_not_public(self):
        from app.domains.accounts.auth import is_public_route

        assert not is_public_route("GET", "/api/logs")
