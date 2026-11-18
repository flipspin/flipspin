"""Check account-scoped library references without deleting shared audio.

Cover idempotent linking, missing files, independent accounts, positional
ownership, and synthetic-principal refusal using temporary state.
"""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.dependencies import get_music_service
from app.domains.music.models import Album, Track
from app.main import app

LIBRARY = "/api/me/library"
OWNERSHIP = "/api/me/library/ownership"
MISSING = "/api/me/library/missing"
PLAYS = "/api/me/plays"

ALBUM = "In Rainbows"
SONG = "01 - 15 Step.mp3"
REL_PATH = f"{ALBUM}/{SONG}"
OTHER = f"{ALBUM}/02 - Bodysnatchers.mp3"
NOT_ON_DISK = "Kid A/01 - Everything In Its Right Place.mp3"
SHARED = "s3cret-shared-token"


@pytest.fixture
def library(tmp_path, monkeypatch):
    """A throwaway token table, user_track table and music library."""
    music = tmp_path / "Music"
    (music / ALBUM).mkdir(parents=True)
    for name in (SONG, "02 - Bodysnatchers.mp3"):
        # A real (silent) MPEG-1 Layer III frame repeated: the scanner in
        # domains/music reads it with mutagen and skips anything it cannot
        # parse, so a placeholder byte string would produce an empty library and
        # make TestExistingEndpointsAreUnchanged vacuous.
        (music / ALBUM / name).write_bytes((b"\xff\xfb\x90\x00" + b"\x00" * 413) * 40)

    monkeypatch.setattr(app.state.config, "jobs_file", tmp_path / "jobs.sqlite")
    monkeypatch.setattr(app.state.config, "base_music_dir", music)
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    # Force both stores to rebuild against the new paths, and drop them after so
    # the next test file cannot inherit a deleted tmpdir.
    for key in ("token_store", "user_track_store"):
        app.state.container._services.pop(key, None)
    yield music
    for key in ("token_store", "user_track_store"):
        app.state.container._services.pop(key, None)


@pytest.fixture
def store(library):
    return app.state.container.get_token_store()


@pytest.fixture
def tracks(library):
    return app.state.container.get_user_track_store()


def remote_client() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def local_client() -> TestClient:
    return TestClient(app)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def member(store, label="Ana (iPhone)") -> dict:
    """Headers for a freshly minted member token."""
    _, token = store.mint(label, ROLE_MEMBER)
    return bearer(token)


class TestTheDedupeHit:
    def test_a_path_already_on_disk_becomes_mine_instantly(self, store, library):
        ana = member(store)
        response = remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        assert response.status_code == 200
        assert response.json() == {"added": [REL_PATH], "already": [], "missing": []}

        listed = remote_client().get(LIBRARY, headers=ana).json()
        assert listed["count"] == 1
        assert listed["tracks"][0]["relPath"] == REL_PATH
        assert listed["tracks"][0]["liked"] is False
        assert listed["tracks"][0]["offline"] is False
        assert listed["tracks"][0]["playCount"] == 0
        assert listed["tracks"][0]["lastPlayedAt"] is None
        assert listed["tracks"][0]["addedAt"]

    def test_the_row_is_a_reference_and_copies_nothing(self, store, library):
        """One shared catalog: adding must not duplicate audio or add files."""
        before = sorted(p.name for p in (library / ALBUM).iterdir())
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=member(store))
        assert sorted(p.name for p in (library / ALBUM).iterdir()) == before

    def test_a_missing_path_is_reported_not_refused(self, store, library):
        """The caller decides whether to acquire it; this is not an error."""
        response = remote_client().post(
            LIBRARY, json={"relPaths": [REL_PATH, NOT_ON_DISK]}, headers=member(store)
        )

        assert response.status_code == 200
        assert response.json() == {
            "added": [REL_PATH],
            "already": [],
            "missing": [NOT_ON_DISK],
        }

    def test_asking_twice_does_not_duplicate_a_row(self, store, library):
        ana = member(store)
        first = remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        second = remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        assert second.json() == {"added": [], "already": [REL_PATH], "missing": []}
        listed = remote_client().get(LIBRARY, headers=ana).json()
        assert listed["count"] == 1
        assert first.status_code == second.status_code == 200

    def test_re_adding_is_not_a_reset(self, store, library):
        """An existing row keeps addedAt, liked and playCount."""
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        remote_client().post(PLAYS, json={"relPath": REL_PATH}, headers=ana)
        remote_client().patch(LIBRARY, json={"relPath": REL_PATH, "liked": True}, headers=ana)
        before = remote_client().get(LIBRARY, headers=ana).json()["tracks"][0]

        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        assert remote_client().get(LIBRARY, headers=ana).json()["tracks"][0] == before

    def test_the_same_path_twice_in_one_body_is_answered_once(self, store, library):
        response = remote_client().post(
            LIBRARY, json={"relPaths": [REL_PATH, REL_PATH]}, headers=member(store)
        )
        body = response.json()
        assert body["added"] == [REL_PATH]
        assert body["already"] == [] and body["missing"] == []

    def test_an_empty_body_is_a_no_op(self, store, library):
        response = remote_client().post(LIBRARY, json={"relPaths": []}, headers=member(store))
        assert response.status_code == 200
        assert response.json() == {"added": [], "already": [], "missing": []}


class TestDeleteNeverTouchesTheFilesystem:
    """The one confusion that would be unrecoverable: this is not delete-track."""

    def test_removing_a_row_leaves_the_file_on_disk(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        response = remote_client().request(
            "DELETE", LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana
        )

        assert response.status_code == 200
        assert response.json() == {"removed": [REL_PATH], "playlistsUpdated": []}
        assert remote_client().get(LIBRARY, headers=ana).json()["count"] == 0
        # The whole point.
        assert (library / ALBUM / SONG).is_file()

    def test_another_member_keeps_their_row(self, store, library):
        ana, beto = member(store, "Ana"), member(store, "Beto")
        for who in (ana, beto):
            remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=who)

        remote_client().request("DELETE", LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        assert remote_client().get(LIBRARY, headers=ana).json()["count"] == 0
        assert remote_client().get(LIBRARY, headers=beto).json()["count"] == 1
        assert (library / ALBUM / SONG).is_file()

    def test_removing_something_i_do_not_hold_is_harmless(self, store, library):
        response = remote_client().request(
            "DELETE", LIBRARY, json={"relPaths": [REL_PATH]}, headers=member(store)
        )
        assert response.status_code == 200
        assert response.json() == {"removed": [], "playlistsUpdated": []}

    def test_a_removed_row_can_be_added_straight_back(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        remote_client().request("DELETE", LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        again = remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        assert again.json()["added"] == [REL_PATH]


class TestTwoUsersDoNotBleed:
    def test_the_same_path_is_two_independent_rows(self, store, library):
        ana, beto = member(store, "Ana"), member(store, "Beto")
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH, OTHER]}, headers=beto)

        remote_client().patch(LIBRARY, json={"relPath": REL_PATH, "liked": True}, headers=ana)
        remote_client().post(PLAYS, json={"relPath": REL_PATH}, headers=beto)

        mine = remote_client().get(LIBRARY, headers=ana).json()
        theirs = remote_client().get(LIBRARY, headers=beto).json()

        assert mine["count"] == 1 and theirs["count"] == 2
        assert mine["tracks"][0]["liked"] is True
        assert mine["tracks"][0]["playCount"] == 0
        beto_row = [t for t in theirs["tracks"] if t["relPath"] == REL_PATH][0]
        assert beto_row["liked"] is False
        assert beto_row["playCount"] == 1

    def test_one_library_is_never_visible_from_the_other_token(self, store, library):
        ana, beto = member(store, "Ana"), member(store, "Beto")
        remote_client().post(LIBRARY, json={"relPaths": [OTHER]}, headers=ana)
        assert remote_client().get(LIBRARY, headers=beto).json() == {"tracks": [], "count": 0}


class TestFlagsRoundTrip:
    def test_liked_and_offline_patch_and_come_back(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        patched = remote_client().patch(
            LIBRARY, json={"relPath": REL_PATH, "liked": True, "offline": True}, headers=ana
        )
        assert patched.status_code == 200
        assert patched.json()["liked"] is True
        assert patched.json()["offline"] is True
        assert patched.json()["relPath"] == REL_PATH

        listed = remote_client().get(LIBRARY, headers=ana).json()["tracks"][0]
        assert (listed["liked"], listed["offline"]) == (True, True)

    def test_an_absent_field_is_untouched(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        remote_client().patch(
            LIBRARY, json={"relPath": REL_PATH, "liked": True, "offline": True}, headers=ana
        )

        body = remote_client().patch(
            LIBRARY, json={"relPath": REL_PATH, "liked": False}, headers=ana
        ).json()

        assert body["liked"] is False
        assert body["offline"] is True

    def test_an_explicit_null_is_also_untouched(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        remote_client().patch(LIBRARY, json={"relPath": REL_PATH, "offline": True}, headers=ana)

        body = remote_client().patch(
            LIBRARY, json={"relPath": REL_PATH, "liked": None, "offline": None}, headers=ana
        ).json()

        assert (body["liked"], body["offline"]) == (False, True)

    def test_patching_a_row_i_do_not_have_is_a_404(self, store, library):
        """Not an upsert: that would be a second add verb with no on-disk check."""
        response = remote_client().patch(
            LIBRARY, json={"relPath": REL_PATH, "liked": True}, headers=member(store)
        )
        assert response.status_code == 404


class TestPlays:
    def test_a_play_increments_and_stamps(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        first = remote_client().post(PLAYS, json={"relPath": REL_PATH}, headers=ana).json()
        second = remote_client().post(PLAYS, json={"relPath": REL_PATH}, headers=ana).json()

        assert first["playCount"] == 1
        assert second["playCount"] == 2
        assert second["lastPlayedAt"]
        assert remote_client().get(LIBRARY, headers=ana).json()["tracks"][0]["playCount"] == 2

    def test_playing_something_never_adds_membership(self, store, library):
        ana = member(store)
        response = remote_client().post(PLAYS, json={"relPath": REL_PATH}, headers=ana)
        assert response.status_code == 404
        assert remote_client().get(LIBRARY, headers=ana).json()["count"] == 0

    def test_a_play_does_not_require_the_file_to_be_on_disk(self, store, tracks, library):
        ana = member(store)
        # It belonged to this account before the file disappeared.
        who = remote_client().get('/api/me', headers=ana).json()['id']
        tracks.add_many(who, [NOT_ON_DISK])
        response = remote_client().post(PLAYS, json={"relPath": NOT_ON_DISK}, headers=ana)
        assert response.status_code == 200
        assert response.json()["relPath"] == NOT_ON_DISK


class TestOwnershipIsPositional:
    def test_results_line_up_with_the_request(self, store, library):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        asked = [OTHER, REL_PATH, NOT_ON_DISK, REL_PATH]
        body = remote_client().post(OWNERSHIP, json={"relPaths": asked}, headers=ana).json()

        assert [r["relPath"] for r in body["results"]] == asked
        assert [r["owned"] for r in body["results"]] == [False, True, False, True]

    def test_an_empty_request_answers_empty(self, store, library):
        response = remote_client().post(OWNERSHIP, json={"relPaths": []}, headers=member(store))
        assert response.json() == {"results": []}

    def test_ownership_is_per_caller(self, store, library):
        ana, beto = member(store, "Ana"), member(store, "Beto")
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)

        mine = remote_client().post(OWNERSHIP, json={"relPaths": [REL_PATH]}, headers=ana)
        theirs = remote_client().post(OWNERSHIP, json={"relPaths": [REL_PATH]}, headers=beto)

        assert mine.json()["results"][0]["owned"] is True
        assert theirs.json()["results"][0]["owned"] is False


class TestGating:
    def test_no_token_is_a_401_on_every_route(self, store, library, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        client = remote_client()
        assert client.get(LIBRARY).status_code == 401
        assert client.post(LIBRARY, json={"relPaths": []}).status_code == 401
        assert client.request("DELETE", LIBRARY, json={"relPaths": []}).status_code == 401
        assert client.patch(LIBRARY, json={"relPath": REL_PATH}).status_code == 401
        assert client.post(PLAYS, json={"relPath": REL_PATH}).status_code == 401
        assert client.post(OWNERSHIP, json={"relPaths": []}).status_code == 401

    def test_a_member_token_succeeds(self, store, library):
        """Not owner-gated: a member managing their own library is the feature."""
        assert remote_client().get(LIBRARY, headers=member(store)).status_code == 200

    def test_an_owner_token_has_a_library_like_anyone_else(self, store, library):
        _, token = store.mint("Robin", ROLE_OWNER)
        response = remote_client().post(
            LIBRARY, json={"relPaths": [REL_PATH]}, headers=bearer(token)
        )
        assert response.status_code == 200
        assert response.json()["added"] == [REL_PATH]

    def test_an_unknown_token_is_refused(self, store, library):
        assert remote_client().get(LIBRARY, headers=bearer("nope")).status_code == 401

    def test_a_revoked_token_loses_access_immediately(self, store, library):
        store.mint("Robin", ROLE_OWNER)
        phone, token = store.mint("Ana", ROLE_MEMBER)
        assert remote_client().get(LIBRARY, headers=bearer(token)).status_code == 200

        store.revoke(phone.user_id)

        assert remote_client().get(LIBRARY, headers=bearer(token)).status_code == 401


class TestSentinelPrincipalsHaveNoLibrary:
    """No row in users.json means no person — and no rows nobody can delete."""

    def test_the_loopback_owner_is_refused(self, store, library):
        response = local_client().get(LIBRARY)
        assert response.status_code == 409
        assert "per-user token" in response.json()["detail"]

    def test_the_shared_secret_is_refused(self, store, library, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote_client().get(LIBRARY, headers=bearer(SHARED)).status_code == 409

    def test_an_anonymous_remote_caller_is_refused(self, store, library, monkeypatch):
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        assert remote_client().get(LIBRARY).status_code == 409

    def test_a_sentinel_cannot_write_a_row_either(self, store, library, tracks):
        """The consistency the choice is for: nothing accumulates under 'local'."""
        assert local_client().post(LIBRARY, json={"relPaths": [REL_PATH]}).status_code == 409
        assert local_client().post(PLAYS, json={"relPath": REL_PATH}).status_code == 409
        assert local_client().patch(
            LIBRARY, json={"relPath": REL_PATH, "liked": True}
        ).status_code == 409
        assert local_client().request(
            "DELETE", LIBRARY, json={"relPaths": [REL_PATH]}
        ).status_code == 409
        assert local_client().post(OWNERSHIP, json={"relPaths": [REL_PATH]}).status_code == 409
        assert tracks.list_for_user("local") == []
        assert not app.state.config.user_tracks_file.exists()


class TestRelPathValidation:
    def test_a_media_url_with_a_token_is_refused_not_stripped(self, store, library):
        """A relPath is not a url_path; ?access_token would key a phantom row."""
        response = remote_client().post(
            LIBRARY,
            json={"relPaths": [f"{REL_PATH}?access_token=abc123"]},
            headers=member(store),
        )
        assert response.status_code == 422
        assert "access_token" in response.json()["detail"]

    def test_traversal_is_refused(self, store, library):
        for bad in ("../../etc/passwd", f"..{'/'}{SONG}", "/etc/passwd"):
            response = remote_client().post(
                LIBRARY, json={"relPaths": [bad]}, headers=member(store)
            )
            assert response.status_code == 422, bad

    def test_a_bare_filename_is_refused(self, store, library):
        response = remote_client().post(
            LIBRARY, json={"relPaths": [SONG]}, headers=member(store)
        )
        assert response.status_code == 422

    def test_a_malformed_path_fails_the_batch_rather_than_being_called_missing(
        self, store, library
    ):
        ana = member(store)
        response = remote_client().post(
            LIBRARY, json={"relPaths": [REL_PATH, "nope"]}, headers=ana
        )
        assert response.status_code == 422
        assert remote_client().get(LIBRARY, headers=ana).json()["count"] == 0


class TestPersistence:
    def test_rows_survive_a_reload_of_the_store(self, store, library, tracks):
        ana = member(store)
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=ana)
        remote_client().patch(LIBRARY, json={"relPath": REL_PATH, "offline": True}, headers=ana)

        tracks.reload()

        listed = remote_client().get(LIBRARY, headers=ana).json()
        assert listed["count"] == 1
        assert listed["tracks"][0]["offline"] is True

    def test_the_table_lives_where_config_says(self, store, library):
        remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=member(store))
        assert app.state.config.user_tracks_file.is_file()


class TestCatalogScope:
    def test_the_library_listing_is_filtered_by_user(self, store, library):
        """Each account sees its own rows through the existing catalog listing."""
        service = Mock()
        service.config.base_music_dir = library
        service.list_albums.return_value = [
            Album(
                name=ALBUM,
                artist="Radiohead",
                path=library / ALBUM,
                tracks=[
                    Track(
                        title="15 Step",
                        artist="Radiohead",
                        album=ALBUM,
                        path=library / ALBUM / SONG,
                        track_number=1,
                        duration=237.0,
                        file_size=1,
                        date_added=0,
                        genre="Rock",
                    )
                ],
                cover_art=None,
                year=2007,
                genre="Rock",
                total_duration=237.0,
            )
        ]
        app.dependency_overrides[get_music_service] = lambda: service
        try:
            ana, beto = member(store, "Ana"), member(store, "Beto")
            remote_client().post(LIBRARY, json={"relPaths": [REL_PATH]}, headers=beto)

            # Ana holds nothing and Beto holds one track.
            mine = remote_client().get(
                "/api/listar-albums-con-metadata?covers=false", headers=ana
            )
            theirs = remote_client().get(
                "/api/listar-albums-con-metadata?covers=false", headers=beto
            )

            assert mine.status_code == theirs.status_code == 200
            assert mine.json() == []
            assert [a["album"] for a in theirs.json()] == [ALBUM]
            assert len(theirs.json()[0]["tracks"]) == 1
        finally:
            app.dependency_overrides.pop(get_music_service, None)

    def test_the_catalog_ownership_endpoint_still_answers_the_old_shape(
        self, store, library
    ):
        response = remote_client().post(
            "/api/library/ownership",
            json={"tracks": [{"title": "15 Step", "artist": "Radiohead"}]},
            headers=member(store),
        )
        assert response.status_code == 200
        assert len(response.json()["results"]) == 1
        assert set(response.json()["results"][0]) >= {"owned", "match", "nearMatch", "reason"}

class TestLibraryPresenceAndOwnerScope:
    def test_missing_file_keeps_ownership_and_reports_presence(self, store, library, tracks):
        ana, token = store.mint('Ana', ROLE_MEMBER)
        tracks.add_many(ana.user_id, [REL_PATH, NOT_ON_DISK])
        response = remote_client().get(LIBRARY, headers=bearer(token))
        assert response.status_code == 200
        body = response.json()
        assert body['count'] == 2
        assert [r['relPath'] for r in body['tracks']] == [REL_PATH, NOT_ON_DISK]
        assert remote_client().get(MISSING, headers=bearer(token)).json() == {'relPaths': [NOT_ON_DISK]}
        assert len(tracks.list_for_user(ana.user_id)) == 2

    @pytest.mark.parametrize('route', [LIBRARY, MISSING])
    def test_owner_can_scope_but_member_cannot_read_another_account(self, store, tracks, route):
        _, owner_token = store.mint('Owner', ROLE_OWNER)
        _, ana_token = store.mint('Ana', ROLE_MEMBER)
        luz, luz_token = store.mint('Luz', ROLE_MEMBER)
        tracks.add_many(luz.user_id, [OTHER, NOT_ON_DISK])
        client = remote_client()
        response = client.get(route, params={'accountId': luz.user_id}, headers=bearer(owner_token))
        assert response.status_code == 200
        if route == LIBRARY:
            assert [r['relPath'] for r in response.json()['tracks']] == [OTHER, NOT_ON_DISK]
        else:
            assert response.json() == {'relPaths': [NOT_ON_DISK]}
            assert client.get(route, headers=bearer(ana_token)).json() == {'relPaths': []}
        assert client.get(route, params={'accountId': luz.user_id}, headers=bearer(ana_token)).status_code == 403
        assert client.get(route, params={'accountId': 'not-an-account'}, headers=bearer(ana_token)).status_code == 403
        assert client.get(route, params={'accountId': luz.user_id}, headers=bearer(luz_token)).status_code == 200

    def test_missing_etag_tracks_disk_and_membership_changes(self, store, library, tracks):
        ana, token = store.mint('Ana', ROLE_MEMBER)
        headers = bearer(token)
        client = remote_client()
        tracks.add_many(ana.user_id, [REL_PATH, NOT_ON_DISK])
        first = client.get(MISSING, headers=headers)
        tag = first.headers['etag']
        assert tag.startswith('"') and tag.endswith('"')
        assert first.headers['cache-control'] == 'private, no-cache'
        for match in (tag, f'W/{tag}', f'"old", {tag}', '*'):
            cached = client.get(MISSING, headers={**headers, 'If-None-Match': match})
            assert cached.status_code == 304
            assert cached.content == b''
            assert cached.headers['etag'] == tag
        (library / ALBUM / SONG).unlink()
        changed = client.get(MISSING, headers={**headers, 'If-None-Match': tag})
        assert changed.status_code == 200
        assert changed.json() == {'relPaths': [REL_PATH, NOT_ON_DISK]}
        assert changed.headers['etag'] != tag
        (library / ALBUM / SONG).write_bytes(b'restored')
        assert client.get(MISSING, headers=headers).headers['etag'] == tag
        tracks.remove_many(ana.user_id, [NOT_ON_DISK])
        assert client.get(MISSING, headers={**headers, 'If-None-Match': tag}).json() == {'relPaths': []}

    def test_missing_rechecks_scope_before_conditional_response(self, store, tracks):
        _, owner = store.mint('Owner', ROLE_OWNER)
        ana, member_token = store.mint('Ana', ROLE_MEMBER)
        client = remote_client()
        params = {'accountId': ana.user_id}
        tag = client.get(MISSING, params=params, headers=bearer(owner)).headers['etag']
        assert client.get(MISSING, params={'accountId': 'other'}, headers={**bearer(member_token), 'If-None-Match': tag}).status_code == 403
        assert client.get(MISSING, headers={'If-None-Match': tag}).status_code == 401
        assert local_client().get(MISSING, headers={'If-None-Match': tag}).status_code == 409

class TestOfflineContract:
    def test_check_13_deduplicates_old_plays_and_refuses_future(self, store, library):
        import sqlite3
        from datetime import UTC, datetime, timedelta
        ana = member(store)
        client = remote_client()
        client.post(LIBRARY, json={'relPaths': [REL_PATH]}, headers=ana)
        play = {'trackKey': REL_PATH, 'listenedAt': '2001-01-01T00:00:00Z', 'clientPlayId': 'one'}
        assert client.post(PLAYS, json={'plays': [play]}, headers=ana).json() == {'accepted': 1}
        assert client.post(PLAYS, json={'plays': [{**play, 'clientPlayId': 'another'}]}, headers=ana).json() == {'accepted': 0}
        with sqlite3.connect(app.state.config.jobs_file) as db:
            assert db.execute('SELECT count(*) FROM plays').fetchone()[0] == 1
        play['listenedAt'] = (datetime.now(UTC) + timedelta(hours=1, minutes=1)).isoformat()
        assert client.post(PLAYS, json=[play], headers=ana).status_code == 422
        assert client.post(PLAYS, json={'plays': [play] * 51}, headers=ana).status_code == 422
        assert client.get(LIBRARY, headers=ana).json()['tracks'][0]['playCount'] == 1

    def test_whole_body_etag_and_idempotency_are_account_scoped(self, store, library):
        client = remote_client()
        ana, other = member(store), member(store, 'Other')
        body = {'relPaths': [REL_PATH]}
        headers = {**ana, 'Idempotency-Key': 'offline-1'}
        first = client.post(LIBRARY, json=body, headers=headers)
        assert first.status_code == 200
        assert client.post(LIBRARY, json=body, headers=headers).json() == first.json()
        assert client.post(LIBRARY, json={'relPaths': []}, headers=headers).status_code == 422
        assert client.post(LIBRARY, json=body, headers={**other, 'Idempotency-Key': 'offline-1'}).json() == first.json()
        listed = client.get(LIBRARY, headers=ana)
        etag = listed.headers['etag']
        assert not etag.startswith('W/')
        assert client.get(LIBRARY, headers={**ana, 'If-None-Match': etag}).status_code == 304
        assert client.get(LIBRARY, headers={**ana, 'If-None-Match': etag}).content == b''
        client.request('DELETE', LIBRARY, json=body, headers=ana)
        assert client.get(LIBRARY, headers={**ana, 'If-None-Match': etag}).status_code == 200

    def test_idempotency_in_flight_and_retention(self, tmp_path):
        from fastapi import HTTPException
        from app.infra.idempotency import Receipts, database
        receipts = Receipts(tmp_path / 'jobs.sqlite')
        assert receipts.begin('k', 'a', '/route', {'x': 1}) is None
        with pytest.raises(HTTPException) as error:
            receipts.begin('k', 'a', '/route', {'x': 1})
        assert error.value.status_code == 409
        receipts.finish('k', 'a', '/route', 200, {'ok': True})
        assert receipts.begin('k', 'a', '/route', {'x': 1}) == (200, {'ok': True})
        with database(tmp_path / 'jobs.sqlite') as db:
            db.execute('UPDATE idempotency_keys SET created_at=0')
        assert receipts.begin('k', 'a', '/route', {'x': 2}) is None

    def test_all_snapshot_listings_have_strong_conditional_validators(self, store, library, monkeypatch):
        # No analysis workers: the payload must remain fixed between reads.
        music = app.state.container.get_music_service()
        # Publish the initial catalog as startup would. Revision reads no longer
        # perform discovery before validating a conditional request.
        music.music_repo.refresh(reason='fixture')
        monkeypatch.setattr(music, 'list_albums', lambda: [])
        _, token = store.mint('Owner', ROLE_OWNER)
        headers = bearer(token)
        for path in ['/api/listar-albums-con-metadata?covers=false', '/api/playlists', '/api/library/summary', '/api/me/home']:
            response = remote_client().get(path, headers=headers)
            assert response.status_code == 200, (path, response.text)
            etag = response.headers['etag']
            assert etag.startswith('"') and not etag.startswith('W/')
            checked = remote_client().get(path, headers={**headers, 'If-None-Match': etag})
            assert checked.status_code == 304, (path, checked.text)
            assert checked.content == b''
