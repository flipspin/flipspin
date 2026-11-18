"""real HTTP surfaces over generated audio, in an isolated subprocess.

The checked-in oracle is the declarative base tree (no audio assets).
The CLI also audits the original internal generator's tree:
    python tests/integration/test_messy_surfaces.py MUSIC STATE OUTPUT
No application code is imported until test_messy_library.collect redirects HOME.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import quote

import pytest

from test_messy_library import collect as collect_listing, media_url

pytestmark = [pytest.mark.integration, pytest.mark.slow]
ORACLE = Path(__file__).parents[1] / "fixtures/messy_surface_oracle.json"
KNOWN_MEDIA: set[str] = set()  # fixed both former media 404s


def generate(music, encoder):
    """Reconstitute the public declarative oracle without private fixture dependencies."""
    from mutagen import File
    from mutagen.id3 import TALB, TIT2, TPE1, TPE2, TRCK
    from mutagen.mp4 import MP4

    manifest = json.loads(ORACLE.read_text())
    codecs = {
        "mp3": ["-c:a", "libmp3lame", "-b:a", "320k"], "flac": ["-c:a", "flac"],
        "m4a": ["-c:a", "aac"], "vorbis": ["-c:a", "vorbis", "-strict", "experimental", "-ac", "2"],
        "opus": ["-c:a", "libopus"], "wav": ["-c:a", "pcm_s16le"],
    }
    templates = {}
    music.mkdir()
    for row in manifest["files"]:
        dest = music / row["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        if row["kind"] == "directory_symlink":
            dest.symlink_to(row["target"], target_is_directory=True)
        elif row["kind"] == "virtual_symlink_child":
            continue
        elif row["kind"] != "audio":
            if dest.suffix == ".lrc":
                dest.write_text("[00:00.00]A generated tone\n[00:01.00]Only a tone\n")
            elif dest.suffix == ".jpg":
                dest.write_bytes(b"\xff\xd8\xff\xd9")
            else:
                dest.write_text("Synthetic sidecar\n")
        else:
            codec = row["codec"]
            if codec not in templates:
                ext = "ogg" if codec in {"opus", "vorbis"} else codec
                tone = music.parent / f"tone-{codec}.{ext}"
                subprocess.run([encoder, "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                                "sine=frequency=440:sample_rate=48000:duration=2", *codecs[codec], str(tone)],
                               check=True, capture_output=True, timeout=30)
                templates[codec] = tone
            shutil.copyfile(templates[codec], dest)
            audio = File(dest)
            audio.delete()
            if row["tagEncoding"] != "none":
                values = (row["title"], row["artist"], row["album"], row["albumArtist"], "1")
                if dest.suffix in {".mp3", ".wav"}:
                    if audio.tags is None:
                        audio.add_tags()
                    encoding = {"latin1": 0, "utf16": 1, "utf8": 3}[row["tagEncoding"]]
                    for frame, value in zip((TIT2, TPE1, TALB, TPE2, TRCK), values, strict=True):
                        audio.tags.add(frame(encoding=encoding, text=[value]))
                    audio.save(v2_version=3 if encoding in {0, 1} else 4)
                else:
                    keys = ("©nam", "©ART", "©alb", "aART") if isinstance(audio, MP4) else (
                        "title", "artist", "album", "albumartist")
                    audio.update({key: [value] for key, value in zip(keys, values[:4], strict=True)})
                    audio.save()
    (music / "expected.json").write_text(json.dumps(manifest, ensure_ascii=False))


def collect(music, state):
    listing = collect_listing(music, state)
    from fastapi.testclient import TestClient
    from mutagen import File
    from app.main import app

    app.state.config.lyrics_engine_mode = "agent"  # queue-only audit, never launch an engine
    manifest = json.loads((music / "expected.json").read_text())
    rows = [r for r in manifest["files"] if r["listed"]]
    client = TestClient(app, client=("127.0.0.1", 50000), base_url='http://localhost', raise_server_exceptions=False)

    def wire(reply):
        try:
            body = reply.json()
        except ValueError:
            body = reply.text[:500]
        return {"status": reply.status_code, "body": body}

    def play(url, source, **kwargs):
        reply = client.get(url, **kwargs)
        return {"status": reply.status_code, "bytesMatch": reply.content == source.read_bytes()}

    def rel(row):
        return f"{row['mediaKey']}/{row['fileKey']}"

    def ownership(queries, headers=None):
        return wire(client.post("/api/library/ownership", json={"tracks": queries}, headers=headers))

    # Independent tag reads give the actual duration, rather than trusting the
    # ownership response or the listing under test. The generator writes no ISRC.
    queries = [{"title": r["title"], "artist": r["artist"],
                "durationSeconds": File(music / r["path"]).info.length} for r in rows]
    controls = [
        {"title": "Echo", "artist": "Version Band", "durationSeconds": 120},
        {"title": "Absent Song", "artist": "Absent Artist", "durationSeconds": 2},
        {"title": "Echo (Live)", "artist": "Version Band", "durationSeconds": 2},
        {"title": "Guest One", "artist": "Various Artists", "durationSeconds": 2},
        # The untagged title is inferred from its filename, not ground truth;
        # swapped title/artist tags have a declared inverse in the generator.
        {"title": "Mystery", "artist": "Unknown Artist", "durationSeconds": 2},
        {"title": "Correct Song", "artist": "Actual Artist", "durationSeconds": 2},
        {"title": "Echo (Remastered 2011)", "artist": "Version Band", "durationSeconds": 2},
    ]
    excluded = [r for r in manifest["files"] if r["kind"] == "audio" and not r["listed"]]
    excluded_queries = [{"title": r["title"], "artist": r["artist"],
                         "durationSeconds": File(music / r["path"]).info.length} for r in excluded]
    owned = ownership(queries + controls + excluded_queries)
    owner, token = app.state.container.get_token_store().claim_first_owner("Fixture Owner")
    owner_headers = {"Authorization": f"Bearer {token}"}

    create = wire(client.post("/api/playlists", json={"name": "Messy surfaces"}, headers=owner_headers))
    tracks = [{"path": str(music / r["path"]), "title": r["title"], "artist": r["artist"]} for r in rows]
    update = wire(client.put("/api/playlists/Messy%20surfaces/tracks", json=tracks, headers=owner_headers))
    detail = wire(client.get("/api/playlists/Messy%20surfaces", headers=owner_headers))
    playlist_plays = []
    for track in detail["body"].get("tracks", []):
        row = next(r for r in rows if str(music / r["path"]) == track["path"])
        # Playlist rows only carry absolute paths. Resolve them against the
        # independent oracle here; Vitest exercises the renderer's derivation.
        key = rel(row)
        album, _, file = key.partition("/")
        playlist_plays.append({"path": row["path"], "case": row["case"], "relPath": key,
                               **play(media_url(album, file), music / row["path"], headers=owner_headers)})

    def identifier(kind, key):
        return f"{kind}-" + base64.urlsafe_b64encode(key.encode()).decode().rstrip("=")

    def rest(method, auth_token=token, **params):
        return client.get(f"/rest/{method}", params={"apiKey": auth_token, "f": "json", "v": "1.16.1",
                                                    "c": "messy-surfaces", **params})

    sub_albums = []
    for key in sorted({r["mediaKey"] for r in rows}):
        album_id = identifier("al", key)
        sub_albums.append({"key": key, "album": wire(rest("getAlbum", id=album_id)),
                           "directory": wire(rest("getMusicDirectory", id=album_id))})
    sub_songs = []
    for row in rows:
        reply = rest("stream", id=identifier("tr", rel(row)))
        search = wire(rest("search3", query=row["title"].strip(), songCount=500))
        sub_songs.append({"path": row["path"], "case": row["case"], "relPath": rel(row),
                          "id": identifier("tr", rel(row)), "search": search,
                          "stream": {"status": reply.status_code,
                                     "bytesMatch": reply.content == (music / row["path"]).read_bytes()}})
    artists = wire(rest("getArtists"))
    artist_dirs = []
    for index in artists["body"]["subsonic-response"]["artists"].get("index", []):
        for artist in index["artist"]:
            artist_dirs.append(wire(rest("getMusicDirectory", id=artist["id"])))

    lyric = next(r for r in rows if r["case"] == "sidecars")
    lyric_url = f"/api/lyrics/{quote(lyric['mediaKey'], safe='')}/{quote(lyric['fileKey'], safe='')}"
    lyrics = wire(client.get(lyric_url, headers=owner_headers))
    lyrics_again = wire(client.get(lyric_url, headers=owner_headers))
    lyrics_index = json.loads(app.state.config.lyrics_file.read_text())

    stems = []
    for row in rows:
        payload = {"album": row["mediaKey"], "file": row["fileKey"]}
        first = wire(client.post("/api/stems/request", json=payload, headers=owner_headers))
        again = wire(client.post("/api/stems/request", json=payload, headers=owner_headers))
        stems.append({"path": row["path"], "case": row["case"], "keys": payload,
                      "first": first, "again": again})
    jobs = wire(client.get("/api/stems/jobs", headers=owner_headers))
    queue_file = app.state.config.lyrics_file.parent / "stems-queue.json"

    # Two real members; partly shared album, nested disc key and seven-level key.
    members = []
    for label, cases in (("Member A", {"deep", "sidecars"}), ("Member B", {"discs", "compilation"})):
        _, member_token = app.state.container.get_token_store().mint(label, "member")
        headers = {"Authorization": f"Bearer {member_token}"}
        mine = [r for r in rows if r["case"] in cases and not (
            label == "Member B" and r["fileKey"] == "CD1∕01.mp3")]
        if label == "Member A":
            mine += [r for r in rows if r["fileKey"] == "CD1∕01.mp3"]
        allowed = [rel(r) for r in mine]
        added = wire(client.post("/api/me/library", json={"relPaths": allowed}, headers=headers))
        members.append({
            "label": label, "allowed": allowed, "add": added,
            "library": wire(client.get("/api/me/library", headers=headers)),
            "listing": wire(client.get("/api/listar-albums-con-metadata", headers=headers)),
            "ownership": ownership(queries, headers),
            "media": [{"relPath": rel(r), **play(media_url(r["mediaKey"], r["fileKey"]), music / r["path"],
                                                 headers=headers)} for r in rows if r["case"] not in KNOWN_MEDIA],
            "subsonicSearch": wire(rest("search3", auth_token=member_token, query="", songCount=500)),
            "subsonicAlbums": [{"key": key, "reply": wire(rest("getAlbum", auth_token=member_token,
                                                              id=identifier("al", key)))}
                               for key in sorted({r["mediaKey"] for r in rows})],
            "subsonicStreams": [{"relPath": rel(r), **play("/rest/stream", music / r["path"],
                                  params={"apiKey": member_token, "f": "json", "id": identifier("tr", rel(r))})}
                                 for r in rows if r["case"] not in KNOWN_MEDIA],
            "stemsRequests": [{"relPath": rel(r), "reply": wire(client.post("/api/stems/request",
                               json={"album": r["mediaKey"], "file": r["fileKey"]}, headers=headers))}
                              for r in rows if r["case"] not in KNOWN_MEDIA],
            "lyrics": wire(client.get(lyric_url, headers=headers)),
        })
    owner_after = wire(client.get("/api/listar-albums-con-metadata", headers=owner_headers))
    client.close()
    return {"rows": rows, "albums": listing["albums"], "queries": queries + controls + excluded_queries,
            "ownership": owned, "excluded": excluded,
            "playlist": {"create": create, "update": update, "detail": detail, "plays": playlist_plays},
            "subsonic": {"albums": sub_albums, "songs": sub_songs, "artistDirectories": artist_dirs},
            "lyrics": {"first": lyrics, "again": lyrics_again, "index": lyrics_index},
            "stems": {"requests": stems, "jobs": jobs, "disk": _stems_queue_rows(queue_file.parent / "jobs.sqlite")},
            "members": members, "ownerAfter": owner_after, "ownerId": owner.user_id}



def _stems_queue_rows(db_path):
    """The stems rows of the one lease queue (moved them from stems-queue.json into jobs.sqlite)."""
    import sqlite3
    con = sqlite3.connect(db_path)
    try:
        rows = con.execute("SELECT queue_payload, state FROM items WHERE queue_kind LIKE 'stems%' AND queue_visible=1").fetchall()
    finally:
        con.close()
    jobs = []
    for payload, state in rows:
        data = json.loads(payload)
        jobs.append({"album": data.get("album"), "file": data.get("file"), "status": state})
    return {"jobs": jobs}

@pytest.fixture(scope="module")
def surfaces(tmp_path_factory):
    if saved := os.getenv("PLU129_SURFACES_JSON"):
        return json.loads(Path(saved).read_text())
    encoder = shutil.which("ffmpeg")
    if encoder is None:
        pytest.skip("requires ffmpeg for synthetic tones")
    root = tmp_path_factory.mktemp("messy-surfaces")
    generate(root / "Music", encoder)
    output = root / "surfaces.json"
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(root / "Music"),
                             str(root / "state"), str(output)], capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"surface collector exited {result.returncode}: {result.stdout}{result.stderr}")
    return json.loads(output.read_text())


def test_ownership_tagged_tracks_and_controls(surfaces):
    response = surfaces["ownership"]
    assert response["status"] == 200 and not response["body"].get("degraded"), response
    verdicts = response["body"]["results"]
    assert len(verdicts) == len(surfaces["queries"])
    versions = {r["path"] for r in surfaces["rows"] if r["case"] in {"duplicate-formats", "remaster"}}
    for row, verdict in zip(surfaces["rows"], verdicts, strict=False):
        if row["case"] == "wrong-tags":
            continue  # semantic false-positive expectation lives in a strict xfail
        assert verdict["owned"], (row, verdict)
        path = verdict["match"]["path"]
        assert path.endswith("/" + row["path"]) or any(path.endswith("/" + p) for p in versions) and (
            row["case"] in {"duplicate-formats", "remaster"}), (row, verdict)
    near, absent, live, compilation_artist, _, _, remaster = verdicts[len(surfaces["rows"]):len(surfaces["rows"]) + 7]
    assert not near["owned"] and near["nearMatch"] and near["reason"]
    assert all(not v["owned"] and v["nearMatch"] is None for v in (absent, live, compilation_artist))
    assert remaster["owned"]


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=(
    "ownership only indexes metadata: Correct Song / Actual Artist is missed with swapped tags"
))
def test_ownership_catalog_identity_despite_swapped_tags(surfaces):
    verdict = surfaces["ownership"]["body"]["results"][len(surfaces["rows"]) + 5]
    assert verdict["owned"], verdict
    row = next(r for r in surfaces["rows"] if r["case"] == "wrong-tags")
    assert verdict["match"]["path"].endswith("/" + row["path"]), verdict


@pytest.mark.xfail(strict=True, raises=AssertionError, reason=(
    "ownership trusts swapped title/artist tags and claims the wrong catalog identity"
))
def test_ownership_does_not_claim_swapped_tag_identity(surfaces):
    index = next(i for i, r in enumerate(surfaces["rows"]) if r["case"] == "wrong-tags")
    verdict = surfaces["ownership"]["body"]["results"][index]
    assert not verdict["owned"], verdict


def test_ownership_policy_excluded_audio_is_a_miss(surfaces):
    verdicts = surfaces["ownership"]["body"]["results"][len(surfaces["rows"]) + 7:]
    assert len(verdicts) == len(surfaces["excluded"]) == 2
    assert all(not v["owned"] and v["nearMatch"] is None for v in verdicts)


def test_playlist_nested_rows_and_playback(surfaces):
    data = surfaces["playlist"]
    assert all(data[k]["status"] == 200 for k in ("create", "update", "detail")), data
    assert len(data["plays"]) == len(surfaces["rows"])
    for row in data["plays"]:
        if row["case"] not in KNOWN_MEDIA:
            assert row["status"] == 200 and row["bytesMatch"], row
        expected = next(r for r in surfaces["rows"] if r["path"] == row["path"])
        assert row["relPath"] == f"{expected['mediaKey']}/{expected['fileKey']}"


def test_subsonic_tree_search_stream(surfaces):
    data = surfaces["subsonic"]
    for album in data["albums"]:
        expected = {s["id"] for s in data["songs"] if s["relPath"].startswith(album["key"] + "/")}
        for field, envelope, children in (("album", "album", "song"), ("directory", "directory", "child")):
            reply = album[field]
            body = reply["body"]["subsonic-response"]
            assert reply["status"] == 200 and body["status"] == "ok", reply
            assert {s["id"] for s in body[envelope][children]} == expected
    assert len(data["artistDirectories"]) > 1
    for reply in data["artistDirectories"]:
        assert reply["status"] == 200 and reply["body"]["subsonic-response"]["status"] == "ok", reply
    for row in data["songs"]:
        search = row["search"]["body"]["subsonic-response"]
        assert search["status"] == "ok" and row["id"] in {
            s["id"] for s in search["searchResult3"].get("song", [])}, row
        if row["case"] not in KNOWN_MEDIA:
            assert row["stream"] == {"status": 200, "bytesMatch": True}, row


def test_lyrics_sidecar_adopted_and_persisted(surfaces):
    data = surfaces["lyrics"]
    assert data["first"]["status"] == 200, data
    body = data["first"]["body"]
    assert body["source"] == "file" and body["kind"] == "synced" and not body["edited"], body
    assert body["text"] == "[00:00.00]A generated tone\n[00:01.00]Only a tone\n"
    assert data["again"] == data["first"]
    assert "15-sidecars∕Sidecar Album/01 - With Lyrics.mp3" in data["index"]["entries"]


def test_stems_nested_keys_queue_and_idempotency(surfaces):
    data = surfaces["stems"]
    assert data["jobs"]["status"] == 200 and data["jobs"]["body"]["mode"] == "agent"
    jobs = data["jobs"]["body"]["jobs"]
    wanted = set()
    for row in data["requests"]:
        if row["case"] in KNOWN_MEDIA:
            continue
        assert row["first"]["status"] == 200, row
        assert row["first"]["body"]["status"] == "queued", row
        assert row["again"] == row["first"], row
        wanted.add((row["keys"]["album"], row["keys"]["file"]))
    assert {(r["album"], r["file"]) for r in jobs} == wanted
    assert all(r["status"] == "queued" and r["phase"] == "queued" for r in jobs)
    assert {(r["album"], r["file"]) for r in data["disk"]["jobs"]} == wanted
    assert all(r["status"] == "queued" for r in data["disk"]["jobs"])


def test_members_only_see_their_nested_rows(surfaces):
    for member in surfaces["members"]:
        allowed = set(member["allowed"])
        assert member["add"]["status"] == 200 and set(member["add"]["body"]["added"]) == allowed, member
        assert {r["relPath"] for r in member["library"]["body"]["tracks"]} == allowed
        assert {t["relPath"] for a in member["listing"]["body"] for t in a["tracks"]} == allowed
        for row, verdict in zip(surfaces["rows"], member["ownership"]["body"]["results"], strict=True):
            assert verdict["owned"] == (f"{row['mediaKey']}/{row['fileKey']}" in allowed), (member, row, verdict)
        for row in member["media"]:
            assert row["status"] == (200 if row["relPath"] in allowed else 404), row
            assert row["bytesMatch"] == (row["relPath"] in allowed), row
        songs = member["subsonicSearch"]["body"]["subsonic-response"]["searchResult3"].get("song", [])
        assert {s["id"] for s in songs} == {
            "tr-" + base64.urlsafe_b64encode(key.encode()).decode().rstrip("=") for key in allowed}
        for album in member["subsonicAlbums"]:
            body = album["reply"]["body"]["subsonic-response"]
            visible = any(key.startswith(album["key"] + "/") for key in allowed)
            assert body["status"] == ("ok" if visible else "failed"), album
            if visible:
                assert {s["id"] for s in body["album"]["song"]} <= {s["id"] for s in songs}
            else:
                assert body["error"]["code"] == 70
        for stream in member["subsonicStreams"]:
            assert stream["bytesMatch"] == (stream["relPath"] in allowed), stream
        for request in member["stemsRequests"]:
            assert request["reply"]["status"] == (200 if request["relPath"] in allowed else 404), request
        assert member["lyrics"]["status"] == (200 if member["label"] == "Member A" else 404)
    assert sum(len(a["tracks"]) for a in surfaces["ownerAfter"]["body"]) == len(surfaces["rows"])


if __name__ == "__main__":
    music, state, output = (Path(arg).resolve() for arg in sys.argv[1:])
    output.write_text(json.dumps(collect(music, state), ensure_ascii=False, indent=2) + "\n")
    print(f"Collected all seven surfaces for {music.name}; evidence: {output.name}")
