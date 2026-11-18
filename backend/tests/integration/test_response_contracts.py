"""Pin exact response keys so FastAPI model filtering cannot drop shipped fields.

Mixed key spellings, timestamp encodings, and optional-key presence are public
contracts. Mocked services and temporary identity state isolate the suite.
See docs/API_COMPATIBILITY.md for compatibility rules.
"""
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.dependencies import (
    get_download_service,
    get_music_service,
    get_ownership_index,
    get_playlist_service,
    get_tag_edits,
)
from app.domains.music.models import Album, Track
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.ownership import OwnedTrack, OwnershipVerdict
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.main import app

# An analysis blob carrying a key no model in this repo knows about. It stands
# in for the next analyzer version reading an older on-disk cache: the route
# must hand it back whole, which is why ``analysis`` is a free-form object and
# not a Pydantic model.
ANALYSIS = {
    "bpm": 128,
    "mood": "energetic",
    "energy": 0.42,
    "brightness": 0.31,
    "pulse": 1.7,
    "arousal": 0.75,
    "bpm_source": "estimated",
    "analysis_source": "audio",
    "key": "A",
    "scale": "minor",
    "key_name": "A minor",
    "camelot": "8A",
    "an_analyzer_field_added_next_year": "must survive",
}

# Nested-library keys are additive; preserve both identities for clients.
ALBUM_KEYS = {
    "album", "artist", "path", "mediaKey", "year", "genre", "cover", "coverVersion", "duration", "tracks",
    "albumArtist", "compilation", "genres", "albumSort", "albumArtistSort",
}
TRACK_KEYS = {
    "title", "artist", "duration", "path", "url_path", "relPath", "track_number",
    "genre", "dateAdded", "bpm", "key", "mood", "analysis", "arousal",
    "bpmEstimated", "keyEstimated", "analysisState", "bpmFixed", "keyFixed", "keySource", "bpmSource", "keyConfidence", "bpmConfidence",
    "artists", "genres", "albumArtist", "albumArtists", "discNumber", "compilation", "year",
    "titleSort", "artistSort", "albumSort", "albumArtistSort", "composerSort",
    "missingFromNest", "missingSince",
}


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def music(tmp_path):
    """A mocked ``MusicService`` with a real base directory under it.

    ``delete-track`` and ``update-tags`` resolve the incoming path under
    ``config.base_music_dir`` before doing anything, so the mock needs a real
    directory or those two routes 400 before they can answer.
    """
    service = Mock()
    service.config = Mock()
    service.config.base_music_dir = tmp_path
    service.music_repo.config = service.config
    service.music_repo.analysis = AnalysisRepository(tmp_path / 'analysis.sqlite')
    service.music_repo._tag_cache = {}
    service.music_repo.tag_revision = 0
    service.music_repo._owner_ghosts = None
    app.dependency_overrides[get_music_service] = lambda: service
    edits = Mock()
    app.dependency_overrides[get_tag_edits] = lambda: edits
    yield service
    app.dependency_overrides.pop(get_music_service, None)
    app.dependency_overrides.pop(get_tag_edits, None)


@pytest.fixture
def playlists(config):
    import logging
    from app.domains.music.repositories import MusicRepository
    service = Mock()
    service.music_repo = MusicRepository(config, logging.getLogger(__name__))
    app.dependency_overrides[get_playlist_service] = lambda: service
    yield service
    app.dependency_overrides.pop(get_playlist_service, None)


def _album(cover_art=None) -> Album:
    return Album(
        name="Kid A",
        artist="Radiohead",
        path=Path("/music/Kid A"),
        tracks=[
            Track(
                title="Everything In Its Right Place",
                artist="Radiohead",
                album="Kid A",
                path=Path("/music/Kid A/01 - Everything In Its Right Place.mp3"),
                track_number=1,
                duration=251.0,
                file_size=6_000_000,
                date_added=1_234_567_890.0,
                genre="Alternative",
                bpm=128,
                key="A minor",
                mood="energetic",
                analysis=dict(ANALYSIS),
            )
        ],
        cover_art=cover_art,
        year=2000,
        genre="Alternative",
        total_duration=251.0,
    )


def _playlist(tracks=None) -> Playlist:
    return Playlist(
        name="Road Trip",
        tracks=tracks if tracks is not None else [],
        description="for the drive",
        created_at=1_234_567_890.0,
        modified_at=1_234_567_899.0,
        total_duration=251.0,
        source_url="https://example.invalid/list",
        cover="https://example.invalid/cover.jpg",
        owner_id="usr_abc",
    )


# --------------------------------------------------------------------- music

class TestTheLibraryScreen:
    """The two routes the library screen is built on. Nothing may move here."""

    def test_listing_answers_only_album_names(self, client, music):
        music.list_albums.return_value = [_album()]

        body = client.get("/api/listar-albums").json()

        assert set(body) == {"albums"}
        assert body["albums"] == ["Kid A"]

    def test_the_metadata_listing_keeps_every_key_it_ever_had(self, client, music):
        music.list_albums.return_value = [_album()]

        body = client.get("/api/listar-albums-con-metadata").json()

        assert isinstance(body, list), "a bare array, never an envelope"
        album = body[0]
        assert set(album) == ALBUM_KEYS
        # The album's display name lives under "album". "name" belongs to a
        # different endpoint's object and a client reading it here gets nothing.
        assert album["album"] == "Kid A"
        assert "name" not in album

        track = album["tracks"][0]
        assert set(track) == TRACK_KEYS
        assert track["dateAdded"] == 1_234_567_890.0
        assert track['arousal'] == .75
        assert track["url_path"] == "/api/media/Kid A/01 - Everything In Its Right Place.mp3"

    def test_an_unscanned_track_still_answers_every_key(self, client, music):
        """bpm/key/mood/analysis are null before a scan — null, not missing.

        A client renders "—" for these. It cannot do that for a key that is not
        in the object, and this is the state a freshly added album is in.
        """
        album = _album()
        album.tracks[0].bpm = None
        album.tracks[0].key = None
        album.tracks[0].mood = None
        album.tracks[0].analysis = None
        music.list_albums.return_value = [album]

        track = client.get("/api/listar-albums-con-metadata").json()[0]["tracks"][0]

        assert set(track) == TRACK_KEYS
        assert track['arousal'] is None
        assert (track["bpm"], track["key"], track["mood"], track["analysis"]) == (
            None, None, None, None,
        )

    def test_an_unknown_analysis_key_is_handed_back_untouched(self, client, music):
        """The analysis blob is versioned on disk and this route is a pipe."""
        music.list_albums.return_value = [_album()]

        track = client.get("/api/listar-albums-con-metadata").json()[0]["tracks"][0]

        assert track["analysis"] == ANALYSIS

    def test_covers_false_nulls_the_value_and_not_the_key(self, client, music, tmp_path):
        """The expensive-response escape hatch changes one value, nothing else."""
        cover = tmp_path / "cover.jpg"
        cover.write_bytes(b"\xff\xd8\xff\xe0")
        music.list_albums.return_value = [_album(cover_art=str(cover))]

        inlined = client.get("/api/listar-albums-con-metadata?covers=true").json()[0]
        urls_only = client.get("/api/listar-albums-con-metadata?covers=false").json()[0]

        assert set(inlined) == set(urls_only) == ALBUM_KEYS
        assert inlined["cover"].startswith("data:image/")
        assert urls_only["cover"] is None


class TestWaveforms:
    def test_the_waveform_body(self, client, music):
        music.get_track.return_value = Mock(path=Path("/music/Kid A/01.mp3"))
        music.generate_waveform.return_value = [0.0, 0.5, 1.0]

        body = client.get("/api/waveform/Kid A/01.mp3").json()

        assert set(body) == {"waveform", "samples", "track"}
        assert body == {"waveform": [0.0, 0.5, 1.0], "samples": 3, "track": "01.mp3"}

    def test_the_peaks_body_keeps_the_widget_s_own_field_names(self, client, music):
        """Preserve the waveform widget's field names for its decoder.

        ``data`` is a list *of channels* even though this backend emits one.
        """
        music.get_track.return_value = Mock(path=Path("/music/Kid A/01.mp3"))
        music.generate_waveform.return_value = [0.0, 0.5]

        body = client.get("/api/wavesurfer-peaks/Kid A/01.mp3").json()

        assert set(body) == {
            "version", "channels", "sample_rate", "samples_per_pixel",
            "bits", "length", "data",
        }
        assert body["data"] == [[0.0, 0.5]]


class TestTrackMutations:
    def test_delete_track_echoes_the_resolved_path(self, client, music, tmp_path):
        song = tmp_path / "Kid A" / "01.mp3"
        song.parent.mkdir()
        song.write_bytes(b"ID3")

        body = client.post("/api/delete-track", json={"path": str(song)}).json()

        assert set(body) == {"success", "path", "playlistsUpdated"}
        assert body == {"success": True, "path": str(song.resolve()), "playlistsUpdated": []}

    def test_update_tags_answers_the_same_two_keys(self, client, music, tmp_path):
        song = tmp_path / "Kid A" / "01.mp3"
        song.parent.mkdir()
        song.write_bytes(b"ID3")

        body = client.post(
            "/api/update-tags", json={"path": str(song), "title": "Idioteque"}
        ).json()

        assert set(body) == {"success", "path"}


class TestCatalogOwnership:
    """``POST /api/library/ownership`` — positional, and ``degraded`` is absent."""

    @pytest.fixture
    def index(self):
        stub = Mock()
        app.dependency_overrides[get_ownership_index] = lambda: stub
        yield stub
        app.dependency_overrides.pop(get_ownership_index, None)

    def test_a_verdict_carries_its_four_keys_with_nulls_intact(self, client, index):
        index.lookup_many.return_value = [
            OwnershipVerdict(owned=False),
            OwnershipVerdict(
                owned=True,
                match=OwnedTrack(
                    title="Idioteque", artist="Radiohead", album="Kid A",
                    path="/music/Kid A/08.mp3", duration_s=328.0, track_number=8,
                ),
            ),
        ]

        body = client.post(
            "/api/library/ownership",
            json={"tracks": [{"title": "a"}, {"title": "Idioteque"}]},
        ).json()

        assert set(body) == {"results"}, "no 'degraded' key on the happy path"
        assert set(body["results"][0]) == {"owned", "match", "nearMatch", "reason"}
        assert body["results"][0]["match"] is None
        assert set(body["results"][1]["match"]) == {
            "title", "artist", "album", "path", "durationSeconds", "trackNumber",
        }

    def test_degraded_appears_only_when_the_library_could_not_be_read(self, client, index):
        """Presence *is* the signal: a client seeing it draws no markers at all."""
        index.lookup_many.side_effect = RuntimeError("the disk went away")

        body = client.post(
            "/api/library/ownership", json={"tracks": [{"title": "a"}, {"title": "b"}]}
        ).json()

        assert set(body) == {"results", "degraded"}
        assert body["degraded"] is True
        assert len(body["results"]) == 2, "still positional, one verdict per query"

    def test_an_empty_query_is_an_empty_result_and_nothing_else(self, client, index):
        body = client.post("/api/library/ownership", json={"tracks": []}).json()

        assert body == {"results": []}


# ----------------------------------------------------------------- playlists

class TestPlaylistBodies:
    """Four different spellings of the same facts. All four are live."""

    def test_the_listing_is_a_bare_array_of_camelcase_rows(self, client, playlists):
        playlists.list_playlists.return_value = [_playlist()]

        body = client.get("/api/playlists").json()

        assert isinstance(body, list), "a bare array — the legacy shape both clients parse"
        assert set(body[0]) == {
            "name", "description", "trackCount", "created", "modified", "owner",
            "cover", "coverAlbums", "coverVersions", "totalDuration",
        }
        assert len(body[0]["coverVersions"]) == len(body[0]["coverAlbums"])
        assert body[0]["created"] == 1_234_567_890.0, "a POSIX float, not an ISO string"

    def test_the_listing_totals_durations_only_when_every_track_has_one(self, client, playlists):
        timed = _playlist()
        timed.tracks = [PlaylistTrack(path=Path(f"/music/A/{n}.mp3"), title=str(n), duration=60.5) for n in range(2)]
        untimed = _playlist()
        untimed.tracks = [*timed.tracks, PlaylistTrack(path=Path("/music/A/x.mp3"), title="x")]
        playlists.list_playlists.return_value = [timed, untimed]

        body = client.get("/api/playlists").json()

        assert body[0]["totalDuration"] == 121.0
        assert body[1]["totalDuration"] is None, "a partial sum must not read as the total"

    def test_the_listing_names_the_first_four_distinct_album_dirs(self, client, playlists):
        """``coverAlbums`` is what a client tiles a playlist's cover from.

        Directory names in track order, deduplicated, capped at four — a
        playlist that opens with five songs off one record yields one entry,
        not five copies of the same cover.
        """
        def track(album, n):
            return PlaylistTrack(path=Path(f"/music/{album}/{n:02d}.mp3"), title=f"t{n}", album=album)

        tracks = [
            track("Kid A", 1), track("Kid A", 2), track("Amnesiac", 1),
            track("Kid A", 3), track("In Rainbows", 1), track("OK Computer", 1),
            track("Hail to the Thief", 1),
        ]
        playlists.list_playlists.return_value = [_playlist(tracks=tracks)]

        body = client.get("/api/playlists").json()

        assert body[0]["coverAlbums"] == ["Kid A", "Amnesiac", "In Rainbows", "OK Computer"]
        assert body[0]["trackCount"] == 7

    def test_one_playlist_is_flat_snake_case_with_one_camelcase_key(self, client, playlists):
        track = PlaylistTrack(
            path=Path("/music/Kid A/01.mp3"),
            title="Everything In Its Right Place",
            artist="Radiohead",
            album="Kid A",
            duration=251.0,
            date_added=1_234_567_890.0,
        )
        playlists.get_playlist.return_value = _playlist(tracks=[track])

        body = client.get("/api/playlists/Road Trip").json()

        assert set(body) == {
            "name", "description", "tracks", "created", "modified",
            "source_url", "cover", "owner",
        }
        assert set(body["tracks"][0]) == {
            "path", "title", "artist", "album", "track_number", "duration", "dateAdded", "genre",
        }

    def test_creating_answers_iso_strings_inside_an_envelope(self, client, playlists):
        """The one endpoint that formats its timestamps. The renderer parses these.

        And it formats them as naive local time — ``datetime.fromtimestamp``
        with no tz — unlike the identity surface, which is UTC with a ``Z``.
        Pinned against the same call rather than a literal so the test says what
        the encoding is without asserting the machine's timezone.
        """
        playlists.create_playlist.return_value = _playlist()

        body = client.post("/api/playlists", json={"name": "Road Trip"}).json()

        assert set(body) == {"success", "playlist"}
        assert set(body["playlist"]) == {
            "name", "description", "tracks", "created_at", "modified_at", "total_duration",
        }
        assert body["playlist"]["created_at"] == datetime.fromtimestamp(
            1_234_567_890.0
        ).isoformat(), "an ISO-8601 string, not the POSIX float the listing answers"
        assert body["playlist"]["tracks"] == []

    def test_writing_the_track_list_answers_snake_case_counts(self, client, playlists):
        playlists.get_playlist.return_value = _playlist()
        playlists.replace_tracks.return_value = (_playlist(), 0, [])

        body = client.put(
            "/api/playlists/Road Trip/tracks",
            json=[{"path": "/music/Kid A/01.mp3", "title": "Everything"}],
        ).json()

        assert set(body) == {"success", "playlist"}
        assert set(body["playlist"]) == {"name", "track_count", "total_duration"}

    def test_renaming_answers_camelcase_counts(self, client, playlists):
        """The same nested slot as the write above, spelled the other way."""
        playlists.get_playlist.return_value = _playlist()
        playlists.rename_playlist.return_value = _playlist()

        body = client.patch(
            "/api/playlists/Road Trip", json={"new_name": "Road Trip 2"}
        ).json()

        assert set(body) == {"success", "playlist"}
        assert set(body["playlist"]) == {
            "name", "description", "trackCount", "created", "modified",
        }

    def test_deleting_answers_a_message(self, client, playlists):
        playlists.get_playlist.return_value = _playlist()

        body = client.delete("/api/playlists/Road Trip").json()

        assert set(body) == {"success", "message"}

    def test_the_metadata_refresh_adds_a_third_timestamp_spelling(self, client, playlists):
        playlists.get_playlist.return_value = _playlist()
        playlists.refresh_playlist.return_value = _playlist()

        body = client.post("/api/playlists/Road Trip/refresh").json()

        assert set(body) == {"success", "playlist"}
        assert set(body["playlist"]) == {
            "name", "track_count", "total_duration", "modified_at",
        }

    def test_the_source_refresh_answers_status_message_added(self, client, playlists):
        """``status`` is "success" even when nothing was added. Branch on ``added``."""
        downloads = Mock()
        downloads.get_playlist_tracks_from_url.return_value = ("Road Trip", [])
        app.dependency_overrides[get_download_service] = lambda: downloads
        playlists.get_playlist.return_value = _playlist()
        try:
            body = client.post("/api/refresh-playlist/Road Trip").json()
        finally:
            app.dependency_overrides.pop(get_download_service, None)

        assert set(body) == {"status", "message", "added"}
        assert body == {"status": "success", "message": "No hay pistas nuevas", "added": 0}


# ------------------------------------------------------------------ identity

@pytest.fixture
def store(tmp_path, monkeypatch):
    """A throwaway token table, wired into the live app.

    Same isolation the identity suite uses: without it these tests would mint
    live credentials into the developer's real ``~/Krobi/users.json``.
    """
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(app.state.config, "base_music_dir", tmp_path / "Music")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    for key in ("token_store", "user_track_store"):
        app.state.container._services.pop(key, None)
    yield app.state.container.get_token_store()
    for key in ("token_store", "user_track_store"):
        app.state.container._services.pop(key, None)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


@pytest.mark.parametrize("claimed", [False, True])
def test_status_build_identity_preserves_the_shipped_handshake(store, tmp_path, monkeypatch, claimed):
    from app.domains.system import routes

    monkeypatch.setattr(app.state.config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(routes, "_instance_id_cache", {})
    monkeypatch.setattr(routes, "BUILD_ID", "a" * 64)
    if claimed:
        store.mint("Owner", ROLE_OWNER)
    response = remote_client().get("/api/status")
    assert response.status_code == 200
    body = response.json()
    legacy_types = {
        "app": str, "version": str, "instanceId": str, "name": str,
        "pid": int, "isInit": bool, "authMethods": list, "setupDone": bool,
        "restarting": bool, "plugins": list,
    }
    if not claimed:
        legacy_types.update(dataDir=str, setupTokenRequired=bool)
    assert set(body) == set(legacy_types) | {"buildId"}
    for key, expected_type in legacy_types.items():
        assert type(body[key]) is expected_type, key
    assert body["buildId"] == "a" * 64
    assert body["isInit"] is claimed


USER_KEYS = {"id", "label", "role", "createdAt", "lastSeenAt"}
# /api/me includes the caller's sign-in username; public listings omit it.
ME_KEYS = USER_KEYS | {"isOwner", "source", "username", "onboarded"}
#: A device row. ``USER_KEYS`` minus ``role`` — a device has no role, its
#: account does — so one component renders both lists. The listing adds
#: ``isCurrent``; the create and revoke bodies do not, because "is this the
#: caller's device" is only a question about a row in a list.
DEVICE_KEYS = {
    "id", "label", "createdAt", "lastSeenAt", "credentialType", "firstSubsonicRequestAt",
    "lastSubsonicRequestAt", "subsonicClientName", "lastSubsonicFailureAt", "lastSubsonicFailure",
}
ROW_KEYS = {"relPath", "addedAt", "liked", "offline", "playCount", "lastPlayedAt"}


class TestIdentityBodies:
    def test_me_carries_the_listing_keys_plus_three(self, store):
        """The point of the endpoint: this body is comparable to a listing row."""
        _, token = store.mint("Ana (iPhone)", ROLE_MEMBER)

        body = remote_client().get("/api/me", headers=bearer(token)).json()

        assert set(body) == ME_KEYS
        assert isinstance(body["createdAt"], str), "ISO-8601, not a POSIX float"
        assert body["createdAt"].endswith("Z")

    def test_a_sentinel_principal_answers_null_timestamps_not_missing_ones(self, store, monkeypatch):
        """A synthetic owner has no row — and must not look like one that does."""
        monkeypatch.setattr(app.state.config, "api_token", "s3cret-shared-token")

        body = remote_client().get(
            "/api/me", headers=bearer("s3cret-shared-token")
        ).json()

        assert set(body) == ME_KEYS
        assert (body["createdAt"], body["lastSeenAt"]) == (None, None)
        assert body["username"] is None, "no row, so no username to report"

    def test_the_user_listing_never_grows_a_credential_field(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)

        body = remote_client().get("/api/users", headers=bearer(token)).json()

        assert set(body) == {"users"}
        assert set(body["users"][0]) == USER_KEYS
        assert "token" not in body["users"][0]
        assert "token_sha256" not in body["users"][0]

    def test_minting_answers_the_row_and_the_secret_once(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)

        response = remote_client().post(
            "/api/users", json={"label": "Ana", "role": ROLE_MEMBER},
            headers=bearer(owner_token),
        )

        assert response.status_code == 201
        body = response.json()
        assert set(body) == {"user", "token"}
        assert set(body["user"]) == USER_KEYS

    def test_revoking_answers_the_row_as_it_was(self, store):
        _, owner_token = store.mint("Robin", ROLE_OWNER)
        victim, _ = store.mint("Ana", ROLE_MEMBER)

        body = remote_client().delete(
            f"/api/users/{victim.user_id}", headers=bearer(owner_token)
        ).json()

        assert set(body) == {"success", "user", "removedSongs", "freedBytes", "playlists"}
        assert (body["removedSongs"], body["freedBytes"], body["playlists"]) == (0, 0, "transferred")
        assert set(body["user"]) == USER_KEYS


class TestMyDeviceBodies:
    """``/api/me/devices`` — camelCase and ISO-8601, like the rest of this surface."""

    def test_rename_returns_the_same_metadata_row_as_both_listings(self, store):
        account, token = store.mint("Robin", ROLE_OWNER)
        device = account.devices[0]
        response = remote_client().patch(
            f"/api/me/devices/{device.device_id}", json={"label": "MacBook"}, headers=bearer(token)
        )
        assert response.status_code == 200
        body = response.json()
        assert set(body) == DEVICE_KEYS | {"isCurrent", "helper"}
        assert body["createdAt"] == device.created_at
        assert body["createdAt"].endswith("Z")
        assert body["isCurrent"] is True
        assert body["helper"] is False
        for path in ["/api/me/devices", f"/api/users/{account.user_id}/devices"]:
            assert remote_client().get(path, headers=bearer(token)).json()["devices"][0] == body
        assert token not in response.text
        assert device.token_sha256 not in response.text
        assert "token" not in response.text

    def test_a_device_row_is_the_user_keys_minus_role_plus_is_current(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)

        body = remote_client().get("/api/me/devices", headers=bearer(token)).json()

        assert set(body) == {"devices"}
        assert set(body["devices"][0]) == DEVICE_KEYS | {"isCurrent", "helper"}
        assert body["devices"][0]["createdAt"].endswith("Z"), "ISO-8601, not a float"

    def test_adding_a_device_answers_the_row_and_the_secret_once(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)

        response = remote_client().post(
            "/api/me/devices", json={"label": "MacBook"}, headers=bearer(token)
        )

        assert response.status_code == 201
        body = response.json()
        assert set(body) == {"device", "token"}
        assert set(body["device"]) == DEVICE_KEYS

    def test_revoking_a_device_says_whether_it_signed_this_client_out(self, store):
        _, token = store.mint("Robin", ROLE_OWNER)
        created = remote_client().post(
            "/api/me/devices", json={"label": "MacBook"}, headers=bearer(token)
        ).json()

        body = remote_client().delete(
            f"/api/me/devices/{created['device']['id']}", headers=bearer(token)
        ).json()

        assert set(body) == {"success", "device", "signedOutThisDevice"}
        assert set(body["device"]) == DEVICE_KEYS
        assert body["signedOutThisDevice"] is False

    def test_no_digest_reaches_any_device_body(self, store):
        """The second wall, same as for the user rows: the store holds digests."""
        _, token = store.mint("Robin", ROLE_OWNER)
        created = remote_client().post(
            "/api/me/devices", json={"label": "MacBook"}, headers=bearer(token)
        ).json()

        raw = remote_client().get("/api/me/devices", headers=bearer(token)).text
        assert "token_sha256" not in raw
        assert created["token"] not in raw


class TestTheUserListingStaysOneRowPerPerson:
    """``/api/users`` is pinned above and decoded by two clients.

    Accounts gained devices underneath it; its shape must not have moved. One
    row per person, the same five keys, and no way to reach a device from it.
    """

    def test_several_devices_are_still_one_row_with_the_same_keys(self, store):
        account, phone_token = store.mint("Robin", ROLE_OWNER)
        store.add_device(account.user_id, "MacBook")
        store.add_device(account.user_id, "iPad")

        body = remote_client().get("/api/users", headers=bearer(phone_token)).json()

        assert len(body["users"]) == 1
        assert set(body["users"][0]) == USER_KEYS
        assert "devices" not in body["users"][0]

    def test_last_seen_reports_the_most_recent_device_of_the_account(self, store):
        """The account was here, even though the phone that made it never came back."""
        account, _phone_token = store.mint("Robin", ROLE_OWNER)
        _, mac, mac_token = store.add_device(account.user_id, "MacBook")

        row = remote_client().get("/api/users", headers=bearer(mac_token)).json()["users"][0]
        devices = remote_client().get(
            "/api/me/devices", headers=bearer(mac_token)
        ).json()["devices"]

        by_id = {d["id"]: d for d in devices}
        assert by_id[mac.device_id]["lastSeenAt"] is not None
        assert by_id[account.devices[0].device_id]["lastSeenAt"] is None
        assert row["lastSeenAt"] == by_id[mac.device_id]["lastSeenAt"]


class TestPasswordSignInBodies:
    """``/api/login``, ``/api/me/username`` and ``/api/me/password``.

    The point of pinning these is mostly what they do not carry: the
    password half of this feature added three routes and zero keys to any
    existing body, because ``UserPublic`` is decoded by two shipped clients that
    cannot be updated in step with the server.
    """

    @pytest.fixture
    def signed_up(self, store):
        from app.domains.accounts import passwords

        passwords.login_throttle.reset()
        record, token = store.mint("Robin", ROLE_OWNER)
        store.set_username(record.user_id, "Robin")
        store.set_password(record.user_id, "correct horse battery")
        yield record, token
        passwords.login_throttle.reset()

    def test_login_answers_exactly_what_adding_a_device_answers(self, signed_up):
        """Pairing and login use the same response model and decoder."""
        _, phone_token = signed_up

        signed_in = remote_client().post(
            "/api/login", json={"username": "robin", "password": "correct horse battery"}
        )
        added = remote_client().post(
            "/api/me/devices", json={"label": "MacBook"}, headers=bearer(phone_token)
        )

        assert signed_in.status_code == added.status_code == 201
        assert set(signed_in.json()) == set(added.json()) == {"device", "token"}
        assert set(signed_in.json()["device"]) == set(added.json()["device"]) == DEVICE_KEYS

    def test_a_failed_login_carries_nothing_but_a_detail(self, signed_up):
        response = remote_client().post(
            "/api/login", json={"username": "nobody", "password": "correct horse battery"}
        )
        assert response.status_code == 401
        assert set(response.json()) == {"detail"}

    def test_setting_a_username_answers_the_name_as_stored(self, signed_up):
        _, token = signed_up
        response = remote_client().post(
            "/api/me/username", json={"username": "Robin"}, headers=bearer(token)
        )
        assert response.status_code == 200
        assert response.json() == {"username": "Robin"}

    def test_changing_a_password_answers_what_it_did_not_do(self, signed_up):
        _, token = signed_up
        response = remote_client().post(
            "/api/me/password",
            json={
                "currentPassword": "correct horse battery",
                "newPassword": "a completely different one",
            },
            headers=bearer(token),
        )
        assert response.status_code == 200
        assert set(response.json()) == {"success", "otherDevicesSignedOut", "deviceCount"}
        assert response.json()["otherDevicesSignedOut"] is False

    def test_no_password_material_reaches_any_body(self, signed_up):
        """The second wall, exactly as for token digests: not the plaintext, not
        the hash, not the salt, not the algorithm."""
        _, token = signed_up
        for response in (
            remote_client().get("/api/me", headers=bearer(token)),
            remote_client().get("/api/users", headers=bearer(token)),
            remote_client().get("/api/me/devices", headers=bearer(token)),
            remote_client().post(
                "/api/login",
                json={"username": "robin", "password": "correct horse battery"},
            ),
        ):
            assert "correct horse battery" not in response.text
            assert "scrypt" not in response.text
            assert "password_hash" not in response.text


class TestTheIdentityRowsNeverGrewAUsername:
    """``UserPublic`` is five keys and stays five keys.

    Adding ``username`` to it would have been free to write and would have
    broken both shipped clients, which is why a username appears on this whole
    surface in exactly two places: the route that owns it, and ``/api/me`` — the
    one body that describes the caller to itself, where it was added (additively)
    so "My account" could show the name you sign in with.
    """

    def test_the_listing_row_is_untouched(self, store):
        record, token = store.mint("Robin", ROLE_OWNER)
        store.set_username(record.user_id, "robin")
        store.set_password(record.user_id, "correct horse battery")

        body = remote_client().get("/api/users", headers=bearer(token)).json()
        assert set(body["users"][0]) == USER_KEYS

    def test_the_me_body_carries_the_username_and_nothing_else_new(self, store):
        record, token = store.mint("Robin", ROLE_OWNER)
        store.set_username(record.user_id, "robin")
        store.set_password(record.user_id, "correct horse battery")

        body = remote_client().get("/api/me", headers=bearer(token)).json()
        assert set(body) == ME_KEYS
        assert body["username"] == "robin"

    def test_the_claim_body_is_untouched_by_credentials(self, store, monkeypatch):
        monkeypatch.setattr(app.state.config, "setup_token_file", store.path.parent / "st")
        monkeypatch.setattr(app.state.config, "require_setup_token", False)

        body = remote_client().post(
            "/api/claim",
            json={
                "label": "Robin",
                "username": "robin",
                "password": "correct horse battery",
            },
        ).json()

        assert set(body) == {"user", "token"}
        assert set(body["user"]) == USER_KEYS


class TestMyLibraryBodies:
    """The ``/api/me/library`` surface — all camelCase, ISO-8601 timestamps."""

    @pytest.fixture
    def owned(self, store, tmp_path):
        """A member token holding one row for a file that really is on disk."""
        album = tmp_path / "Music" / "Kid A"
        album.mkdir(parents=True)
        (album / "01.mp3").write_bytes(b"ID3")
        _, token = store.mint("Ana", ROLE_MEMBER)
        return token, "Kid A/01.mp3"

    def test_adding_answers_three_disjoint_buckets(self, owned):
        token, rel_path = owned

        body = remote_client().post(
            "/api/me/library",
            json={"relPaths": [rel_path, "Nowhere/nope.mp3"]},
            headers=bearer(token),
        ).json()

        assert set(body) == {"added", "already", "missing"}
        assert body == {
            "added": [rel_path], "already": [], "missing": ["Nowhere/nope.mp3"],
        }

    def test_the_listing_carries_a_count_and_camelcase_rows(self, owned):
        token, rel_path = owned
        remote_client().post(
            "/api/me/library", json={"relPaths": [rel_path]}, headers=bearer(token)
        )

        body = remote_client().get("/api/me/library", headers=bearer(token)).json()

        assert set(body) == {"tracks", "count"}
        assert set(body["tracks"][0]) == ROW_KEYS
        assert isinstance(body["tracks"][0]["addedAt"], str), "ISO-8601, not a float"

    def test_patching_answers_the_bare_row(self, owned):
        token, rel_path = owned
        remote_client().post(
            "/api/me/library", json={"relPaths": [rel_path]}, headers=bearer(token)
        )

        body = remote_client().patch(
            "/api/me/library", json={"relPath": rel_path, "liked": True},
            headers=bearer(token),
        ).json()

        assert set(body) == ROW_KEYS, "no envelope — the row itself"
        assert body["liked"] is True

    def test_a_play_answers_the_bare_row_too(self, owned):
        token, rel_path = owned
        remote_client().post("/api/me/library", json={"relPaths": [rel_path]}, headers=bearer(token))

        body = remote_client().post(
            "/api/me/plays", json={"relPath": rel_path}, headers=bearer(token)
        ).json()

        assert set(body) == ROW_KEYS
        assert body["playCount"] == 1

    def test_removing_answers_only_what_was_held(self, owned):
        token, rel_path = owned
        remote_client().post(
            "/api/me/library", json={"relPaths": [rel_path]}, headers=bearer(token)
        )

        body = remote_client().request(
            "DELETE", "/api/me/library",
            json={"relPaths": [rel_path, "Kid A/never-added.mp3"]},
            headers=bearer(token),
        ).json()

        assert set(body) == {"removed", "playlistsUpdated"}
        assert body["removed"] == [rel_path]
        assert body["playlistsUpdated"] == []

    def test_my_ownership_answers_positionally_with_the_path_echoed(self, owned):
        token, rel_path = owned
        remote_client().post(
            "/api/me/library", json={"relPaths": [rel_path]}, headers=bearer(token)
        )

        body = remote_client().post(
            "/api/me/library/ownership",
            json={"relPaths": ["Kid A/other.mp3", rel_path, rel_path]},
            headers=bearer(token),
        ).json()

        assert set(body) == {"results"}
        assert set(body["results"][0]) == {"relPath", "owned"}
        # Repeats answered in place, never de-duplicated: a client draws markers
        # by index and a shortened list would shift every one of them.
        assert [r["owned"] for r in body["results"]] == [False, True, True]
        assert [r["relPath"] for r in body["results"]] == [
            "Kid A/other.mp3", rel_path, rel_path,
        ]


def test_server_config_never_returns_secret_values_lengths_digests_or_users_path(config, monkeypatch):
    """Owner diagnosis exposes only configured, including PUT's full response."""
    from app.infra import env_sources
    from app.dependencies import DependencyContainer

    config.api_token = "private-api-marker"
    config.spotify_client_id = "private-spotify-client"
    config.spotify_client_secret = "private-spotify-secret"
    config.genius_api_key = "private-genius-marker"
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(app.state, "container", DependencyContainer(config))
    store = app.state.container.get_token_store()
    owner, token = store.mint("Owner", ROLE_OWNER)
    client = TestClient(app)
    auth = {"Authorization": f"Bearer {token}"}
    for response in [client.get("/api/server/config", headers=auth),
                     client.put("/api/server/config", json={"changes": {"KROBI_LOG_LEVEL": "INFO"}}, headers=auth)]:
        assert response.status_code == 200, response.text
        for secret in [config.api_token, config.spotify_client_id, config.spotify_client_secret,
                       config.genius_api_key, str(config.users_file), owner.devices[0].token_sha256]:
            assert secret not in response.text
        row = next(s for g in response.json()["groups"] for s in g["settings"] if s["key"] == "KROBI_API_TOKEN")
        assert row["value"] is None and row["default"] is None and row["configured"] is True
        assert "length" not in row
