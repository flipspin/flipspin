"""Check acquisition linking against a tagged temporary library.

Existing files avoid downloads; new files link after publication. Repeated
completion preserves rows, accounts remain independent, and linking failure
cannot fail a download. Synthetic principals acquire without personal rows.
Only the download engine is mocked.
"""
import time
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import ROLE_MEMBER
from app.dependencies import (
    get_download_service,
    get_progress_tracker,
    get_provider_registry,
)
from app.domains.downloads.models import DownloadResult
from app.main import app

ACQUIRE = "/api/browse/acquire"
LIBRARY = "/api/me/library"

ALBUM = "Discovery"
SONG = "One More Time.mp3"
REL_PATH = f"{ALBUM}/{SONG}"
TITLE = "One More Time"
ARTIST = "Daft Punk"
#: The synthetic MP3 below really is ~1.04 s long, and the ownership oracle
#: vetoes a key match whose duration is wildly off. Queries therefore either
#: send no duration (the oracle then trusts the key) or send a deliberately
#: wrong one to exercise the veto.
REAL_DURATION_S = 1.04
SHARED = "s3cret-shared-token"

# A real (silent) MPEG-1 Layer III frame repeated — mutagen has to be able to
# read it or the library scans as empty and every assertion below is vacuous.
MP3_BYTES = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40


def write_track(path: Path, title: str, artist: str) -> Path:
    """A tagged, playable-enough MP3. The tags are what the oracle matches on."""
    from mutagen.easyid3 import EasyID3
    from mutagen.mp3 import MP3

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(MP3_BYTES)
    audio = MP3(path, ID3=EasyID3)
    try:
        audio.add_tags()
    except Exception:  # noqa: BLE001 — already tagged
        pass
    audio["title"] = title
    audio["artist"] = artist
    audio["album"] = ALBUM
    audio.save()
    return path


@pytest.fixture
def acquiring(tmp_path, monkeypatch):
    """A real tmp library plus a mocked download engine.

    Yields ``(music_dir, downloads)`` where ``downloads`` records every call the
    engine received — an empty ``downloads.calls`` is the assertion that a
    dedupe hit downloaded nothing.
    """
    music = tmp_path / "Music"
    music.mkdir(parents=True)

    monkeypatch.setattr(app.state.config, "base_music_dir", music)
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    # Both stores and the ownership index must be rebuilt against the tmp paths,
    # or a previous test's index answers for this one's library.
    for key in ("token_store", "user_track_store", "ownership_index", "music_repository"):
        app.state.container._services.pop(key, None)

    downloads = Mock()
    downloads.calls = []
    downloads.lands = []  # files the fake engine creates, in order
    downloads.results = None  # set to override what the engine reports

    async def _download(**kwargs):
        downloads.calls.append(kwargs)
        if downloads.results is not None:
            return downloads.results
        results = []
        for track, landing in zip(kwargs["tracks"], downloads.lands, strict=False):
            write_track(Path(landing), track["name"], track["artist"])
            results.append(DownloadResult(success=True, file_path=Path(landing)))
        return results

    download_service = Mock()
    download_service.config.base_music_dir = music
    download_service.download_spotify_playlist = _download

    registry = Mock()
    registry.order = Mock(return_value=["youtube"])

    tracker = app.state.container.get_progress_tracker()

    app.dependency_overrides[get_download_service] = lambda: download_service
    app.dependency_overrides[get_provider_registry] = lambda: registry
    app.dependency_overrides[get_progress_tracker] = lambda: tracker
    try:
        yield music, downloads
    finally:
        for dep in (get_download_service, get_provider_registry, get_progress_tracker):
            app.dependency_overrides.pop(dep, None)
        for key in ("token_store", "user_track_store", "ownership_index", "music_repository"):
            app.state.container._services.pop(key, None)


@pytest.fixture
def tracks_store(acquiring):
    return app.state.container.get_user_track_store()


@pytest.fixture
def token_store(acquiring):
    return app.state.container.get_token_store()


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def desktop_client() -> TestClient:
    """The Electron app on the same machine: loopback, no token, LOCAL_OWNER."""
    return TestClient(app)


def member(store, label="Ana (iPhone)") -> dict:
    _, token = store.mint(label, ROLE_MEMBER)
    return {"Authorization": f"Bearer {token}"}


def body(title=TITLE, artist=ARTIST, duration=None, folder=None) -> dict:
    payload = {
        "tracks": [
            {
                "title": title,
                "artistName": artist,
                "albumTitle": ALBUM,
                "trackPosition": 1,
                "durationSeconds": duration,
            }
        ]
    }
    if folder:
        payload["folder"] = folder
    return payload


def wait_for(predicate, timeout=3.0):
    """The linking rides a background task; give it a moment."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


class TestTheDedupeHit:
    """Already on disk: one row, nothing transferred. The point of the feature."""

    def test_it_links_instantly_and_queues_nothing(self, acquiring, token_store, tracks_store):
        music, downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)
        ana = member(token_store)

        response = remote_client().post(ACQUIRE, json=body(), headers=ana)

        assert response.status_code == 200
        payload = response.json()
        assert payload["requested"] == 1
        assert payload["queued"] == 1
        assert payload["total"] == 1
        assert payload["alreadyPresent"] == []
        assert payload["linking"] == "user"
        # The half that makes this worth building: no YouTube request happened.
        assert downloads.calls == [], "a dedupe hit must not queue a download"

        listed = remote_client().get(LIBRARY, headers=ana).json()
        assert [t["relPath"] for t in listed["tracks"]] == [REL_PATH]
        user_id = token_store.resolve(ana["Authorization"].removeprefix("Bearer ")).user_id
        assert tracks_store.get(user_id, REL_PATH).acquired is False

    def test_the_progress_entry_is_terminal_from_birth(self, acquiring, token_store):
        """A client opening the SSE stream must get a close, not a hang."""
        music, _downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)
        client = remote_client()
        headers = member(token_store)

        progress_id = client.post(ACQUIRE, json=body(), headers=headers).json()["progress_id"]

        snapshot = client.get(f"/api/download-progress/{progress_id}", headers=headers)
        assert snapshot.status_code == 200
        assert snapshot.json()["terminal"] is True

    def test_the_row_is_a_reference_and_copies_nothing(self, acquiring, token_store):
        music, _downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)
        before = sorted(p.name for p in (music / ALBUM).iterdir())

        remote_client().post(ACQUIRE, json=body(), headers=member(token_store))

        assert sorted(p.name for p in (music / ALBUM).iterdir()) == before

    def test_the_duration_veto_still_governs(self, acquiring, token_store):
        """A same-name file of a very different length is a different recording.

        The oracle refuses to call it owned, so acquisition must still download —
        otherwise asking for the 3-minute studio take hands you the 9-minute
        extended mix you already had and calls it done.
        """
        music, downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)
        downloads.lands = [music / ALBUM / "One More Time (2).mp3"]

        payload = remote_client().post(
            ACQUIRE, json=body(duration=320.0), headers=member(token_store)
        ).json()

        assert payload["queued"] == 1
        assert payload["alreadyPresent"] == []
        assert wait_for(lambda: downloads.calls)

    def test_two_users_each_get_their_own_row(self, acquiring, token_store, tracks_store):
        """One catalog, per-user references — no bleed, no shared row."""
        music, downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)
        ana = member(token_store, "Ana")
        beto = member(token_store, "Beto")

        assert remote_client().post(ACQUIRE, json=body(), headers=ana).status_code == 200
        assert remote_client().post(ACQUIRE, json=body(), headers=beto).status_code == 200

        assert remote_client().get(LIBRARY, headers=ana).json()["count"] == 1
        assert remote_client().get(LIBRARY, headers=beto).json()["count"] == 1
        rows = [r for r in tracks_store._records().values() if r.rel_path == REL_PATH]
        assert len({r.user_id for r in rows}) == 2
        assert downloads.calls == []


class TestTheMiss:
    """Not on disk: queue it, and remember who asked."""

    def test_it_queues_and_links_when_the_file_lands(self, acquiring, token_store, tracks_store):
        music, downloads = acquiring
        downloads.lands = [music / ALBUM / SONG]
        ana = member(token_store)

        payload = remote_client().post(ACQUIRE, json=body(), headers=ana).json()

        assert payload["queued"] == 1
        assert payload["total"] == 1
        assert payload["alreadyPresent"] == []
        assert payload["status"] == "started"
        assert wait_for(lambda: downloads.calls), "the download must still be queued"

        assert wait_for(
            lambda: [t["relPath"] for t in remote_client().get(LIBRARY, headers=ana).json()["tracks"]]
            == [REL_PATH]
        )
        user_id = token_store.resolve(ana["Authorization"].removeprefix("Bearer ")).user_id
        assert tracks_store.get(user_id, REL_PATH).acquired is True

    def test_a_later_download_upgrades_a_manual_row_without_resetting_it(
        self, acquiring, token_store, tracks_store,
    ):
        music, downloads = acquiring
        ana = member(token_store)
        user_id = token_store.resolve(ana["Authorization"].removeprefix("Bearer ")).user_id
        tracks_store.add_many(user_id, [REL_PATH])
        tracks_store.update_flags(user_id, REL_PATH, liked=True)
        before = tracks_store.get(user_id, REL_PATH).public()
        downloads.lands = [music / ALBUM / SONG]

        response = remote_client().post(ACQUIRE, json=body(), headers=ana)

        assert response.status_code == 200
        assert wait_for(lambda: tracks_store.get(user_id, REL_PATH).acquired)
        assert tracks_store.get(user_id, REL_PATH).public() == before
        tracks_store.reload()
        assert tracks_store.get(user_id, REL_PATH).acquired is True

    def test_a_failed_download_produces_no_row(self, acquiring, token_store):
        """A row for a file that does not exist is a track the phone cannot play."""
        music, downloads = acquiring
        downloads.results = [DownloadResult(success=False, file_path=None, error="no results")]
        ana = member(token_store)

        remote_client().post(ACQUIRE, json=body(), headers=ana)

        assert wait_for(lambda: downloads.calls)
        assert remote_client().get(LIBRARY, headers=ana).json()["count"] == 0

    def test_a_repeated_completion_report_does_not_duplicate_the_row(
        self, acquiring, token_store, tracks_store
    ):
        """A retried job, or one reporting twice, must be harmless.

        Drives the linking entry point directly with the same completion report
        twice — which is what a worker that crashed after writing the file and
        came back looks like from here.
        """
        from app.domains.user_library.acquisition_links import link_results

        music, _downloads = acquiring
        landed = write_track(music / ALBUM / SONG, TITLE, ARTIST)
        user, _token = token_store.mint("Ana", ROLE_MEMBER)
        principal = user.principal()
        results = [DownloadResult(success=True, file_path=landed)]

        first = link_results(tracks_store, principal, music, results)
        added_at = tracks_store.get(principal.user_id, REL_PATH).added_at
        second = link_results(tracks_store, principal, music, results)

        assert first.linked == [REL_PATH]
        assert second.linked == []
        assert second.already == [REL_PATH], "the second report is a no-op, not a row"
        assert len(tracks_store.list_for_user(principal.user_id)) == 1
        assert tracks_store.get(principal.user_id, REL_PATH).added_at == added_at

    def test_acquiring_the_same_track_again_is_a_hit_not_a_second_row(
        self, acquiring, token_store
    ):
        """The end-to-end shape of the same property: download once, then link."""
        music, downloads = acquiring
        downloads.lands = [music / ALBUM / SONG]
        ana = member(token_store)
        client = remote_client()

        client.post(ACQUIRE, json=body(), headers=ana)
        assert wait_for(lambda: (music / ALBUM / SONG).exists())
        assert wait_for(lambda: client.get(LIBRARY, headers=ana).json()["count"] == 1)

        again = client.post(ACQUIRE, json=body(), headers=ana).json()

        assert again["queued"] == 1, "the dedupe hit is indistinguishable to the member"
        assert again["alreadyPresent"] == []
        assert client.get(LIBRARY, headers=ana).json()["count"] == 1
        assert len(downloads.calls) == 1

    def test_a_playlist_folder_links_under_its_nested_key(
        self, acquiring, token_store, tracks_store
    ):
        """Fold nested folders into the album key so every track keeps a two-segment identity."""
        music, downloads = acquiring
        downloads.lands = [music / "En mode 60" / ALBUM / SONG]
        ana = member(token_store)

        response = remote_client().post(
            ACQUIRE, json=body(folder="En mode 60"), headers=ana
        )

        assert response.status_code == 200
        assert wait_for(lambda: (music / "En mode 60" / ALBUM / SONG).exists())
        assert wait_for(lambda: remote_client().get(LIBRARY, headers=ana).json()["count"] == 1)
        rows = remote_client().get(LIBRARY, headers=ana).json()
        rel = (rows.get("tracks") or rows.get("items") or [{}])[0].get("relPath")
        assert rel == f"En mode 60\u2215{ALBUM}/{SONG}"


class TestTheDesktopKeepsWorking:
    """Synthetic principals can acquire audio without accumulating personal rows.

    Their /api/me/library refusal must not prevent ordinary downloads."""

    def test_a_loopback_desktop_acquires_and_is_simply_not_linked(
        self, acquiring, tracks_store
    ):
        music, downloads = acquiring
        downloads.lands = [music / ALBUM / SONG]

        response = desktop_client().post(ACQUIRE, json=body())

        assert response.status_code == 200, "the desktop must never get a 409 here"
        payload = response.json()
        assert payload["success"] is True
        assert payload["status"] == "started"
        assert payload["queued"] == 1
        assert payload["linking"] == "skipped"
        assert wait_for(lambda: downloads.calls), "the file is still fetched"
        assert wait_for(lambda: (music / ALBUM / SONG).exists())
        # Nothing accumulates under a synthetic id that nobody could ever delete.
        assert tracks_store._records() == {}

    def test_a_dedupe_hit_as_the_desktop_is_success_with_no_row(
        self, acquiring, tracks_store
    ):
        music, downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)

        payload = desktop_client().post(ACQUIRE, json=body()).json()

        assert payload["queued"] == 0
        assert payload["alreadyPresent"] == [
            {"title": TITLE, "relPath": REL_PATH, "linked": False}
        ]
        assert payload["linking"] == "skipped"
        assert downloads.calls == []
        assert tracks_store._records() == {}

    def test_the_shared_secret_acquires_too(self, acquiring, tracks_store, monkeypatch):
        """``KROBI_API_TOKEN`` is on real deployments and Electron reads it."""
        music, downloads = acquiring
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        downloads.lands = [music / ALBUM / SONG]

        response = remote_client().post(
            ACQUIRE, json=body(), headers={"Authorization": f"Bearer {SHARED}"}
        )

        assert response.status_code == 200
        assert response.json()["linking"] == "skipped"
        assert wait_for(lambda: downloads.calls)
        assert tracks_store._records() == {}

    def test_the_response_still_carries_every_field_the_two_clients_read(
        self, acquiring, token_store
    ):
        """Additive only: the iOS build in the field decodes these five."""
        music, downloads = acquiring
        downloads.lands = [music / ALBUM / SONG]

        payload = desktop_client().post(ACQUIRE, json=body()).json()

        assert payload["success"] is True
        assert payload["status"] == "started"
        assert isinstance(payload["progress_id"], str) and payload["progress_id"]
        assert payload["total"] == 1
        assert payload["destination"] == str(music)


class TestLinkingNeverBreaksADownload:
    """The file existing is the more important fact."""

    def test_a_store_that_refuses_does_not_fail_the_download(
        self, acquiring, token_store, tracks_store, monkeypatch
    ):
        music, downloads = acquiring
        downloads.lands = [music / ALBUM / SONG]

        def _boom(*_args, **_kwargs):
            raise OSError("read-only file system")

        monkeypatch.setattr(tracks_store, "add_many", _boom)

        response = remote_client().post(ACQUIRE, json=body(), headers=member(token_store))

        assert response.status_code == 200
        assert wait_for(lambda: downloads.calls)
        assert wait_for(lambda: (music / ALBUM / SONG).exists()), "the file still lands"

    def test_a_hit_that_cannot_be_linked_still_answers_200(
        self, acquiring, token_store, tracks_store, monkeypatch
    ):
        music, _downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)

        def _boom(*_args, **_kwargs):
            raise OSError("read-only file system")

        monkeypatch.setattr(tracks_store, "add_many", _boom)

        response = remote_client().post(ACQUIRE, json=body(), headers=member(token_store))

        assert response.status_code == 200
        assert response.json()["alreadyPresent"] == []

    def test_an_unreadable_library_acquires_everything(self, acquiring, token_store):
        """Allow acquisition when ownership lookup fails rather than refusing the requested song."""
        from app.dependencies import get_ownership_index

        music, downloads = acquiring
        write_track(music / ALBUM / SONG, TITLE, ARTIST)
        downloads.lands = [music / ALBUM / "One More Time (2).mp3"]
        broken = Mock()
        broken.lookup_many.side_effect = OSError("disk gone")
        app.dependency_overrides[get_ownership_index] = lambda: broken
        try:
            payload = remote_client().post(
                ACQUIRE, json=body(), headers=member(token_store)
            ).json()
        finally:
            app.dependency_overrides.pop(get_ownership_index, None)

        assert payload["queued"] == 1
        assert wait_for(lambda: downloads.calls)
