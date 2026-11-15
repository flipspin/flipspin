"""Exercise playlist ownership over HTTP with real temporary files and accounts.

Members see their own playlists; owners see all. Names share one namespace,
and access conflicts differ from missing files. Existing playlists migrate once.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.domains.accounts.identity import LOCAL_OWNER, ROLE_MEMBER, ROLE_OWNER
from app.dependencies import get_playlist_service
from app.domains.playlists.ownership import MIGRATION_MARKER_NAME
from app.main import app

# Any gated route would do; this one needs no library state.
GATED_PATH = "/api/playlists"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def remote_client() -> TestClient:
    """A phone on the LAN. Never loopback, so it is never LOCAL_OWNER."""
    return TestClient(app, client=("192.0.2.42", 51000))


def local_client() -> TestClient:
    """The Electron desktop talking to its own backend — the loopback owner."""
    return TestClient(app)


def write_playlist(playlist_dir, name, *, owner=None, tracks=None):
    """Write a playlist fixture, omitting owner to exercise pre-ownership migration."""
    data = {
        "name": name,
        "description": "",
        "tracks": tracks or [],
        "created": 1234567890.0,
        "modified": 1234567890.0,
    }
    if owner is not None:
        data["owner"] = owner
    path = playlist_dir / f"{name.replace(' ', '_')}.json"
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


@pytest.fixture
def house(tmp_path, monkeypatch):
    """A throwaway library, token table and container, wired into the live app.

    Everything the playlist domain caches is dropped on the way in *and* on the
    way out: the repositories cache their directories at construction, so a
    stale one would either read the developer's real ``~/Krobi`` or hand the
    next test file a deleted tmpdir.
    """
    playlist_dir = tmp_path / "playlists"
    music_dir = tmp_path / "music"
    playlist_dir.mkdir()
    music_dir.mkdir()

    config = app.state.config
    monkeypatch.setattr(config, "playlist_dir", playlist_dir)
    monkeypatch.setattr(config, "base_music_dir", music_dir)
    monkeypatch.setattr(config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(config, "user_tracks_file", tmp_path / "user_tracks.json")
    monkeypatch.setattr(config, "api_token", None)
    monkeypatch.setattr(config, "allow_unauthenticated_remote", False)

    container = app.state.container

    def reset():
        for key in ("playlist_service", "token_store", "user_track_store"):
            container._services.pop(key, None)
        for key in ("playlist_repository", "music_repository"):
            container._repositories.pop(key, None)

    reset()
    store = container.get_token_store()

    class House:
        def __init__(self):
            self.dir = playlist_dir
            self.music = music_dir
            self.root = tmp_path
            self.store = store

        @property
        def marker(self):
            return tmp_path / MIGRATION_MARKER_NAME

        def member(self, label):
            """Mint a member token and return ``(user_id, client)``."""
            record, token = store.mint(label, ROLE_MEMBER)
            client = remote_client()
            client.headers.update(bearer(token))
            return record.user_id, client

        def owner(self, label):
            record, token = store.mint(label, ROLE_OWNER)
            client = remote_client()
            client.headers.update(bearer(token))
            return record.user_id, client

        def boot(self):
            """Build the playlist service — which is what runs the migration."""
            return container.get_playlist_service()

        def reboot(self):
            """Forget the built service, as a process restart would."""
            container._services.pop("playlist_service", None)
            container._repositories.pop("playlist_repository", None)

        def owner_of(self, name):
            path = playlist_dir / f"{name.replace(' ', '_')}.json"
            return json.loads(path.read_text(encoding="utf-8")).get("owner")

        def track(self, filename):
            """A real file, because add_tracks skips paths that do not exist."""
            path = music_dir / filename
            path.write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")
            return str(path)

    yield House()
    reset()


# --------------------------------------------------------------------- migration


class TestMigration:
    def test_pre_existing_playlists_are_assigned_to_the_owner(self, house):
        owner_id, _ = house.owner("Robin (desktop)")
        write_playlist(house.dir, "Road Trip")
        write_playlist(house.dir, "Kitchen")

        house.boot()

        assert house.owner_of("Road Trip") == owner_id
        assert house.owner_of("Kitchen") == owner_id

    def test_the_owner_can_still_see_what_predates_ownership(self, house):
        """The failure this migration exists to prevent: a library that upgrades
        into an empty screen."""
        _, client = house.owner("Robin")
        write_playlist(house.dir, "Road Trip")

        names = [p["name"] for p in client.get("/api/playlists").json()]

        assert names == ["Road Trip"]

    def test_a_deployment_with_no_owner_token_falls_back_to_the_local_owner(self, house):
        """Local and shared-secret owners retain access before account enrollment.

        Owner-role access does not depend on the migrated playlist's owner id."""
        write_playlist(house.dir, "Road Trip")

        house.boot()

        assert house.owner_of("Road Trip") == LOCAL_OWNER.user_id
        body = local_client().get("/api/playlists").json()
        assert [p["name"] for p in body] == ["Road Trip"]

    def test_it_writes_a_marker_naming_the_owner_it_used(self, house):
        owner_id, _ = house.owner("Robin")
        write_playlist(house.dir, "Road Trip")

        house.boot()

        marker = json.loads(house.marker.read_text(encoding="utf-8"))
        assert marker["version"] == 1
        assert marker["ownerId"] == owner_id
        assert marker["migratedAt"].endswith("Z")

    def test_a_second_run_leaves_a_reorganised_library_alone(self, house):
        """The one-shot half. A playlist that becomes ownerless *after* the
        migration must not be swept back to the owner on the next start."""
        owner_id, _ = house.owner("Robin")
        write_playlist(house.dir, "Road Trip")
        house.boot()
        assert house.owner_of("Road Trip") == owner_id

        write_playlist(house.dir, "Later")  # arrives with no owner
        house.reboot()
        house.boot()

        assert house.owner_of("Later") is None

    def test_it_never_overwrites_an_owner_that_is_already_there(self, house):
        """The idempotent half, tested without the marker: even if the marker is
        lost, a second pass reassigns nobody."""
        member_id, _ = house.member("Ana")
        house.owner("Robin")
        write_playlist(house.dir, "Ana's Mix", owner=member_id)
        write_playlist(house.dir, "Road Trip")

        house.boot()
        house.marker.unlink()
        house.reboot()
        house.boot()

        assert house.owner_of("Ana's Mix") == member_id

    def test_it_does_not_re_date_the_playlists_it_stamps(self, house):
        """A load/save round trip would stamp `modified` with now and reshuffle
        every "recently modified" list in both clients."""
        house.owner("Robin")
        write_playlist(house.dir, "Road Trip")

        house.boot()

        raw = json.loads((house.dir / "Road_Trip.json").read_text(encoding="utf-8"))
        assert raw["modified"] == 1234567890.0
        assert raw["created"] == 1234567890.0


# -------------------------------------------------------------------- visibility


class TestVisibility:
    def test_a_member_sees_their_own_and_not_another_members(self, house):
        ana_id, ana = house.member("Ana")
        beto_id, beto = house.member("Beto")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)
        write_playlist(house.dir, "Beto Mix", owner=beto_id)

        assert [p["name"] for p in ana.get("/api/playlists").json()] == ["Ana Mix"]
        assert [p["name"] for p in beto.get("/api/playlists").json()] == ["Beto Mix"]

    def test_an_owner_sees_every_playlist_in_the_house(self, house):
        """The decision: an owner is a household administrator, not a peer."""
        ana_id, _ = house.member("Ana")
        _, robin = house.owner("Robin")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)
        write_playlist(house.dir, "Robin Mix", owner="robin-somebody-else")

        names = sorted(p["name"] for p in robin.get("/api/playlists").json())

        assert names == ["Ana Mix", "Robin Mix"]

    def test_the_list_carries_the_owner_so_a_client_can_mark_yours(self, house):
        ana_id, ana = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        row = ana.get("/api/playlists").json()[0]

        assert row["owner"] == ana_id
        # Additive only: the renderer and the phone read these four.
        for key in ("name", "trackCount", "created", "modified"):
            assert key in row

    def test_reading_another_members_playlist_is_403_not_404(self, house):
        ana_id, _ = house.member("Ana")
        _, beto = house.member("Beto")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        assert beto.get("/api/playlists/Ana%20Mix").status_code == 403

    def test_reading_a_playlist_that_does_not_exist_is_404(self, house):
        _, beto = house.member("Beto")

        assert beto.get("/api/playlists/Ghost").status_code == 404

    def test_a_member_reads_their_own_playlist(self, house):
        ana_id, ana = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        response = ana.get("/api/playlists/Ana%20Mix")

        assert response.status_code == 200
        assert response.json()["owner"] == ana_id


# --------------------------------------------------------------------- mutation


class TestMutation:
    def test_a_member_cannot_delete_another_members_playlist(self, house):
        """The footgun the whole feature exists to close. 403, and the file stays."""
        ana_id, _ = house.member("Ana")
        _, beto = house.member("Beto")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        response = beto.delete("/api/playlists/Ana%20Mix")

        assert response.status_code == 403
        assert (house.dir / "Ana_Mix.json").exists()

    def test_a_member_deletes_their_own(self, house):
        ana_id, ana = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        assert ana.delete("/api/playlists/Ana%20Mix").status_code == 200
        assert not (house.dir / "Ana_Mix.json").exists()

    def test_the_owner_deletes_a_members_playlist(self, house):
        ana_id, _ = house.member("Ana")
        _, robin = house.owner("Robin")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        assert robin.delete("/api/playlists/Ana%20Mix").status_code == 200

    def test_a_member_cannot_rename_another_members_playlist(self, house):
        ana_id, _ = house.member("Ana")
        _, beto = house.member("Beto")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        response = beto.patch("/api/playlists/Ana%20Mix", json={"new_name": "Mine Now"})

        assert response.status_code == 403
        assert not (house.dir / "Mine_Now.json").exists()

    def test_a_rename_keeps_the_owner(self, house):
        ana_id, ana = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        assert ana.patch(
            "/api/playlists/Ana%20Mix", json={"new_name": "Ana Mix v2"}
        ).status_code == 200
        assert house.owner_of("Ana Mix v2") == ana_id

    def test_replacing_your_own_track_list_keeps_the_owner(self, house):
        """PUT rewrites the file through save_playlist; the owner must survive
        the round trip or a member would lose their playlist by editing it."""
        ana_id, ana = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        album = house.music / "Album"
        album.mkdir()
        path = album / "ana.mp3"
        path.write_bytes(b"ID3")
        app.state.container.get_user_track_store().add_many(ana_id, ["Album/ana.mp3"])

        response = ana.put(
            "/api/playlists/Ana%20Mix/tracks",
            json=[{"path": str(path), "title": "Hers"}],
        )

        assert response.status_code == 200
        assert house.owner_of("Ana Mix") == ana_id
        assert [p["name"] for p in ana.get("/api/playlists").json()] == ["Ana Mix"]

    def test_a_member_cannot_refresh_another_members_playlist(self, house):
        ana_id, _ = house.member("Ana")
        _, beto = house.member("Beto")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        assert beto.post("/api/playlists/Ana%20Mix/refresh").status_code == 403
        assert beto.post("/api/refresh-playlist/Ana%20Mix").status_code == 403

    def test_a_new_playlist_belongs_to_whoever_created_it(self, house):
        ana_id, ana = house.member("Ana")

        assert ana.post("/api/playlists", json={"name": "Ana Mix"}).status_code == 200
        assert house.owner_of("Ana Mix") == ana_id


# --------------------------------------------------------------- name collisions


class TestNameCollisions:
    def test_a_write_never_lands_on_another_users_playlist_of_the_same_name(self, house):
        """The worst outcome available to this change, pinned.

        Beto sends the same PUT he would send for his own "Rock". It must be
        refused, and Ana's track list must be byte-identical afterwards.
        """
        ana_id, _ = house.member("Ana")
        _, beto = house.member("Beto")
        keeper = house.track("ana.mp3")
        write_playlist(
            house.dir,
            "Rock",
            owner=ana_id,
            tracks=[{"path": keeper, "title": "Hers", "artist": "Ana"}],
        )
        before = (house.dir / "Rock.json").read_bytes()

        response = beto.put(
            "/api/playlists/Rock/tracks",
            json=[{"path": house.track("beto.mp3"), "title": "His"}],
        )

        assert response.status_code == 403
        assert (house.dir / "Rock.json").read_bytes() == before

    def test_a_name_is_taken_house_wide_and_a_collision_is_409(self, house):
        """Rule 2: one namespace. A member cannot create a second "Rock" even
        though the first one is invisible to them."""
        ana_id, _ = house.member("Ana")
        _, beto = house.member("Beto")
        write_playlist(house.dir, "Rock", owner=ana_id)

        response = beto.post("/api/playlists", json={"name": "Rock"})

        assert response.status_code == 409
        # The shared namespace reveals only that the name is occupied, not its owner
        # or contents.
        detail = response.json()["detail"]
        assert "Rock" in detail
        assert ana_id not in detail

    def test_renaming_onto_another_users_name_is_409_and_changes_nothing(self, house):
        ana_id, _ = house.member("Ana")
        beto_id, beto = house.member("Beto")
        write_playlist(house.dir, "Rock", owner=ana_id)
        write_playlist(house.dir, "Beto Mix", owner=beto_id)

        response = beto.patch("/api/playlists/Beto%20Mix", json={"new_name": "Rock"})

        assert response.status_code == 409
        assert house.owner_of("Rock") == ana_id
        assert (house.dir / "Beto_Mix.json").exists()


# ------------------------------------------------------------------ the desktop


class TestTheDesktopStillWorks:
    def test_the_loopback_owner_manages_everything_it_did_before(self, house):
        """Electron: no token, loopback, LOCAL_OWNER. The full CRUD round trip."""
        ana_id, _ = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)
        write_playlist(house.dir, "Legacy")  # predates ownership
        client = local_client()

        listing = client.get("/api/playlists")
        assert listing.status_code == 200
        assert sorted(p["name"] for p in listing.json()) == ["Ana Mix", "Legacy"]

        assert client.get("/api/playlists/Legacy").status_code == 200
        assert client.post("/api/playlists", json={"name": "Desktop"}).status_code == 200
        assert client.put(
            "/api/playlists/Desktop/tracks",
            json=[{"path": house.track("d.mp3"), "title": "D"}],
        ).status_code == 200
        assert client.patch(
            "/api/playlists/Desktop", json={"new_name": "Desktop 2"}
        ).status_code == 200
        assert client.delete("/api/playlists/Desktop%202").status_code == 200

    def test_the_shared_secret_is_still_an_owner(self, house, monkeypatch):
        """``KROBI_API_TOKEN`` lives in ~/Krobi/.env on real deployments and
        Electron reads it; it resolves to LEGACY_OWNER and must see everything."""
        monkeypatch.setattr(app.state.config, "api_token", "s3cret-shared-token")
        ana_id, _ = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        response = remote_client().get(
            "/api/playlists", headers=bearer("s3cret-shared-token")
        )

        assert response.status_code == 200
        assert [p["name"] for p in response.json()] == ["Ana Mix"]

    def test_auth_turned_off_entirely_does_not_hide_the_library(self, house, monkeypatch):
        """Unauthenticated remote mode shares one anonymous principal, so it cannot
        filter playlists by individual account ownership."""
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        ana_id, _ = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)

        response = remote_client().get("/api/playlists")

        assert response.status_code == 200
        assert [p["name"] for p in response.json()] == ["Ana Mix"]

    def test_no_token_is_still_401_before_any_of_this(self, house):
        """401 before 403: ownership never gets a say on an unauthenticated call."""
        ana_id, _ = house.member("Ana")
        write_playlist(house.dir, "Ana Mix", owner=ana_id)
        anonymous = remote_client()

        assert anonymous.get(GATED_PATH).status_code == 401
        assert anonymous.get("/api/playlists/Ana%20Mix").status_code == 401
        assert anonymous.delete("/api/playlists/Ana%20Mix").status_code == 401


# ------------------------------------------------------------------- imports


class TestImports:
    def test_an_import_refuses_to_replace_another_users_playlist(self, house):
        """``save_imported_playlist`` overwrites by name and runs from background
        tasks no route guard covers, so the check lives in the service."""
        from app.domains.accounts.identity import Principal
        from app.domains.playlists.ownership import PlaylistAccessError

        ana_id, _ = house.member("Ana")
        beto_id, _ = house.member("Beto")
        write_playlist(house.dir, "Rock", owner=ana_id)
        service = house.boot()
        beto = Principal(user_id=beto_id, label="Beto", role=ROLE_MEMBER)

        with pytest.raises(PlaylistAccessError):
            service.save_imported_playlist(
                name="Rock",
                source_url=None,
                tracks=[{"path": house.track("beto.mp3"), "title": "His"}],
                principal=beto,
            )

        assert house.owner_of("Rock") == ana_id

    def test_an_import_belongs_to_the_importer(self, house):
        from app.domains.accounts.identity import Principal

        ana_id, _ = house.member("Ana")
        service = house.boot()

        service.save_imported_playlist(
            name="Ana Import",
            source_url=None,
            tracks=[{"path": house.track("ana.mp3"), "title": "Hers"}],
            principal=Principal(user_id=ana_id, label="Ana", role=ROLE_MEMBER),
        )

        assert house.owner_of("Ana Import") == ana_id

    def test_re_importing_your_own_playlist_keeps_its_owner(self, house):
        from app.domains.accounts.identity import Principal

        ana_id, _ = house.member("Ana")
        write_playlist(house.dir, "Ana Import", owner=ana_id)
        service = house.boot()

        service.save_imported_playlist(
            name="Ana Import",
            source_url=None,
            tracks=[{"path": house.track("ana.mp3"), "title": "Hers"}],
            principal=Principal(user_id=ana_id, label="Ana", role=ROLE_MEMBER),
        )

        assert house.owner_of("Ana Import") == ana_id


def test_the_mocked_service_route_tests_next_door_are_unaffected():
    """A tripwire, not a test of this feature.

    ``test_playlist_routes.py`` overrides ``get_playlist_service`` and asserts
    payload shapes. If an override leaked out of a fixture in this file, those
    would start passing (or failing) for the wrong reason.
    """
    assert get_playlist_service not in app.dependency_overrides


# ------------------------------------------------------------ PUT keeps rows


class TestReplaceKeepsRowsWhoseFileMoved:
    """Preserve existing rows after library relocation, even when their files are absent.

    Clients remove rows by omission; saving a read-back list must not erase them.
    """

    def test_existing_row_without_file_survives_a_put(self, house):
        owner_id, owner = house.owner("Robin (desktop)")
        here = house.track("here.mp3")
        gone = str(house.dir / "moved-away.mp3")  # never written: no file
        write_playlist(house.dir, "nn", owner=owner_id, tracks=[
            {"path": gone, "title": "Gone", "artist": "A", "dateAdded": 111.0},
            {"path": here, "title": "Here", "artist": "B", "dateAdded": 222.0},
        ])
        new = house.track("new.mp3")

        response = owner.put("/api/playlists/nn/tracks", json=[
            {"path": gone, "title": "Gone"}, {"path": here, "title": "Here"}, {"path": new, "title": "New"},
        ])

        assert response.status_code == 200
        saved = json.loads((house.dir / "nn.json").read_text(encoding="utf-8"))["tracks"]
        assert [t["path"] for t in saved] == [gone, here, new]
        assert saved[0]["dateAdded"] == 111.0, "an existing row keeps its date_added"

    def test_a_new_path_with_no_file_is_still_refused(self, house):
        owner_id, owner = house.owner("Robin (desktop)")
        write_playlist(house.dir, "nn", owner=owner_id, tracks=[])
        response = owner.put("/api/playlists/nn/tracks", json=[{"path": str(house.dir / "nope.mp3"), "title": "x"}])
        assert response.status_code == 200
        assert json.loads((house.dir / "nn.json").read_text(encoding="utf-8"))["tracks"] == []

    def test_leaving_a_row_out_still_removes_it(self, house):
        owner_id, owner = house.owner("Robin (desktop)")
        a, b = house.track("a.mp3"), house.track("b.mp3")
        write_playlist(house.dir, "nn", owner=owner_id, tracks=[{"path": a, "title": "A"}, {"path": b, "title": "B"}])
        owner.put("/api/playlists/nn/tracks", json=[{"path": b, "title": "B"}])
        assert [t["path"] for t in json.loads((house.dir / "nn.json").read_text(encoding="utf-8"))["tracks"]] == [b]
