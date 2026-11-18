"""Account deletion over HTTP with persisted rows and isolated files.

Preview and deletion agree on eligible files and account cleanup.
Use real credentials without accessing a personal music library.
See docs/security.md#account-routes.
"""
import json

import pytest

from app.domains.lyrics.models import LyricsRecord
from app.domains.user_library.store import UserTrackStore


def test_preview_counts_is_read_only_and_has_no_provenance_on_wire(deletion_house):
    h = deletion_house
    before = {p: p.read_bytes() for p in h.root.rglob("*") if p.is_file()}
    response = h.admin.get(h.url + "/deletion-preview")
    assert response.status_code == 200
    assert response.json() == {"devices": 2, "songs": 5, "playlists": 1,
                               "removable": {"count": 1, "bytes": 7}, "kept": 4}
    assert before == {p: p.read_bytes() for p in h.root.rglob("*") if p.is_file()}
    library = h.client.get("/api/me/library").json()
    assert all("acquired" not in row for row in library["tracks"])


def test_default_delete_drops_every_row_transfers_playlists_and_keeps_files(deletion_house):
    h = deletion_house
    before = {p: p.read_bytes() for p in h.album.iterdir()}
    playlist_before = json.loads(h.playlist.read_text())
    response = h.admin.delete(h.url)
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True and body["user"]["id"] == h.member.user_id
    assert (body["removedSongs"], body["freedBytes"], body["playlists"]) == (0, 0, "transferred")
    assert h.accounts.get_user(h.member.user_id) is None
    assert h.client.get("/api/me").status_code == 401
    assert UserTrackStore(h.config.user_tracks_file).list_for_user(h.member.user_id) == []
    assert before == {p: p.read_bytes() for p in h.album.iterdir()}
    assert json.loads(h.playlist.read_text()) == {**playlist_before, "owner": h.owner.user_id}
    assert h.other_playlist.exists()


def test_delete_songs_uses_shared_cleanup_path_and_counts_removed_audio_bytes(deletion_house):
    h = deletion_house
    audio = h.album / "exclusive.mp3"
    for suffix in (".lrc", ".txt"):
        audio.with_suffix(suffix).write_text("words")
    lyrics = h.container.get_lyrics_service()
    lyrics.repository.put_record(LyricsRecord("Album/exclusive.mp3", "synced", "manual", edited=True))
    stems = h.container.get_stems_service()
    stem_dir = stems.repository.track_dir("Album", "exclusive.mp3")
    stem_dir.mkdir(parents=True)
    (stem_dir / "vocals.ogg").write_bytes(b"voice")
    music = h.container.get_music_service()
    analysis = music.music_repo.analysis
    with analysis.connection() as db:
        db.execute("INSERT INTO track_analysis (rel_path, bpm) VALUES ('Album/exclusive.mp3', 120)")
    music.music_repo._tag_cache[str(audio.resolve())] = ((0, 7), {})

    response = h.admin.delete(h.url + "?songs=true")

    assert response.status_code == 200
    assert response.json()["removedSongs"] == 1
    assert response.json()["freedBytes"] == 7
    assert response.json()["playlists"] == "deleted"
    assert not audio.exists()
    assert not audio.with_suffix(".lrc").exists() and not audio.with_suffix(".txt").exists()
    assert lyrics.repository.get_record("Album/exclusive.mp3") is None
    assert not stem_dir.exists()
    assert analysis.get("Album/exclusive.mp3") is None
    assert str(audio.resolve()) not in music.music_repo._tag_cache
    assert music.music_repo.scans.dirty
    assert (h.album / "shared.mp3").exists()
    assert (h.album / "hit.mp3").exists() and (h.album / "manual.mp3").exists()
    assert h.tracks.get(h.owner.user_id, "Album/shared.mp3") is not None
    assert UserTrackStore(h.config.user_tracks_file).list_for_user(h.member.user_id) == []
    assert not h.playlist.exists() and h.other_playlist.exists()


def test_delete_recomputes_eligibility_after_preview(deletion_house):
    h = deletion_house
    assert h.admin.get(h.url + "/deletion-preview").json()["removable"]["count"] == 1
    h.tracks.add_many(h.owner.user_id, ["Album/exclusive.mp3"])
    response = h.admin.delete(h.url + "?songs=true")
    assert response.status_code == 200
    assert response.json()["removedSongs"] == response.json()["freedBytes"] == 0
    assert (h.album / "exclusive.mp3").exists()


def test_nested_file_is_removed_but_an_outside_symlink_is_kept(deletion_house):
    h = deletion_house
    nested = h.config.base_music_dir / "Artist" / "Record"
    nested.mkdir(parents=True)
    audio = nested / "song.mp3"
    audio.write_bytes(b"1234")
    audio.with_suffix(".lrc").write_text("words")
    outside = h.root / "outside.mp3"
    outside.write_bytes(b"private")
    (h.album / "outside.mp3").symlink_to(outside)
    h.tracks.add_many(h.member.user_id, ["Artist∕Record/song.mp3", "Album/outside.mp3"], acquired=True)
    assert h.admin.get(h.url + "/deletion-preview").json()["removable"] == {"count": 2, "bytes": 11}
    response = h.admin.delete(h.url + "?songs=true")
    assert response.status_code == 200
    assert (response.json()["removedSongs"], response.json()["freedBytes"]) == (2, 11)
    assert not audio.exists() and not audio.with_suffix(".lrc").exists()
    assert outside.read_bytes() == b"private"


def test_failed_file_is_logged_skipped_and_other_files_still_delete(deletion_house, monkeypatch, caplog):
    h = deletion_house
    (h.album / "second.mp3").write_bytes(b"1234")
    h.tracks.add_many(h.member.user_id, ["Album/second.mp3"], acquired=True)
    music = h.container.get_music_service()
    delete = music.delete_track

    def fail_one(path):
        assert h.accounts.get_user(h.member.user_id) is None
        assert h.tracks.list_for_user(h.member.user_id) == []
        if path.name == "exclusive.mp3":
            raise OSError("locked audio")
        delete(path)

    monkeypatch.setattr(music, "delete_track", fail_one)
    response = h.admin.delete(h.url + "?songs=true")
    assert response.status_code == 200
    assert (response.json()["removedSongs"], response.json()["freedBytes"]) == (1, 4)
    assert (h.album / "exclusive.mp3").exists() and not (h.album / "second.mp3").exists()
    assert "locked audio" in caplog.text


@pytest.mark.parametrize("songs", [False, True])
def test_last_admin_refusal_touches_nothing(deletion_house, songs):
    h = deletion_house
    h.tracks.add_many(h.owner.user_id, ["Album/manual.mp3"], acquired=True)
    before = {p: p.read_bytes() for p in h.root.rglob("*") if p.is_file()}
    response = h.admin.delete(f"/api/users/{h.owner.user_id}?songs={str(songs).lower()}")
    assert response.status_code == 422
    assert before == {p: p.read_bytes() for p in h.root.rglob("*") if p.is_file()}
    assert h.accounts.get_user(h.owner.user_id) is not None


def test_member_forbidden_and_unknown_user_404(deletion_house):
    h = deletion_house
    for client, expected, url in ((h.client, 403, h.url), (h.admin, 404, "/api/users/unknown")):
        assert client.get(url + "/deletion-preview").status_code == expected
        assert client.delete(url + "?songs=true").status_code == expected
    assert h.accounts.get_user(h.member.user_id) is not None


def test_legacy_manual_play_and_download_provenance_persists(deletion_house):
    h = deletion_house
    # Pre-provenance disk rows load conservatively and preserve their wire shape.
    data = json.loads(h.config.user_tracks_file.read_text())
    for row in data["rows"]:
        row.pop("acquired", None)
    h.config.user_tracks_file.write_text(json.dumps(data))
    h.tracks.reload()
    row = h.tracks.get(h.member.user_id, "Album/exclusive.mp3")
    assert row.acquired is False
    old_public = row.public()
    h.tracks.remove_many(h.member.user_id, ["Album/manual.mp3", "Album/hit.mp3"])
    assert h.client.post("/api/me/library", json={"relPaths": ["Album/manual.mp3"]}).status_code == 200
    assert not h.tracks.get(h.member.user_id, "Album/manual.mp3").acquired
    assert h.client.post("/api/me/plays", json={"relPath": "Album/hit.mp3"}).status_code == 404
    assert h.tracks.get(h.member.user_id, "Album/hit.mp3") is None
    assert h.client.post("/api/me/library", json={"relPaths": ["Album/hit.mp3"]}).status_code == 200
    assert h.client.post("/api/me/plays", json={"relPath": "Album/hit.mp3"}).status_code == 200
    assert not h.tracks.get(h.member.user_id, "Album/hit.mp3").acquired
    assert h.client.post("/api/me/library", json={"relPaths": ["Album/exclusive.mp3"]}).status_code == 200
    assert h.client.post("/api/me/plays", json={"relPath": "Album/exclusive.mp3"}).status_code == 200
    assert not h.tracks.get(h.member.user_id, "Album/exclusive.mp3").acquired
    # A real later download can upgrade provenance without resetting person data.
    h.tracks.add_many(h.member.user_id, ["Album/exclusive.mp3"], acquired=True)
    h.tracks.add_many(h.member.user_id, ["Album/exclusive.mp3"])
    row = UserTrackStore(h.config.user_tracks_file).get(h.member.user_id, "Album/exclusive.mp3")
    assert row.acquired is True and row.play_count == 1
    assert row.added_at == old_public["addedAt"] and "acquired" not in row.public()
