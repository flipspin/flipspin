"""compare a synthetic library with an independent intent oracle.

The subprocess imports the shipped app only after redirecting HOME and every
KROBI storage path. There is no app factory on this branch. No TCP server,
mocked scanner, or private/internal fixture-generator dependency is needed.

The same collector can audit the tree:
    python tests/integration/test_messy_library.py MUSIC STATE OUTPUT_JSON
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

pytestmark = [pytest.mark.integration, pytest.mark.slow]

ROOT_ALBUM_KEY = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts/library-keys.json").read_text()
)["rootAlbumKey"]


def media_url(album, file):
    return f"/api/media/{quote(album, safe='')}/{quote(file, safe='')}"


def collect(music, state):
    """Collect actual wire data and byte checks; never derive expected keys."""
    state.mkdir(parents=True, exist_ok=True)
    # This must precede every app import, including config.KROBI_HOME.
    for key in list(os.environ):
        if key.startswith(("KROBI_", "SPOTIFY_")):
            del os.environ[key]
    os.environ["HOME"] = str(state)
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from app.config import REQUIRED_DIRS, STATE_PATHS

    for env, name in [*REQUIRED_DIRS.values(), *STATE_PATHS.values()]:
        os.environ[env] = str(state / "Krobi" / name)
    for env, name in (
        ("KROBI_DASHBOARD_CACHE_FILE", "dashboard-cache.json"),
        ("KROBI_BROWSE_CACHE_FILE", "browse-cache.json"),
        ("KROBI_PLUGINS_DIR", "plugins"),
    ):
        os.environ[env] = str(state / "Krobi" / name)
    os.environ.update({
        "KROBI_MUSIC_DIR": str(music), "KROBI_API_TOKEN": "",
        "KROBI_ADVERTISE": "false", "KROBI_UPDATE_CHECK": "false",
        "KROBI_WRITE_ANALYSIS_TAGS": "false", "KROBI_LYRICS_AUTO_FETCH": "false",
        "KROBI_LOG_LEVEL": "ERROR",
    })
    from fastapi.testclient import TestClient
    from app.main import app

    expected = json.loads((music / "expected.json").read_text())
    # Deliberately no lifespan: startup launches unrelated worker/discovery jobs.
    client = TestClient(app, client=("127.0.0.1", 50000))
    response = client.get("/api/listar-albums-con-metadata", params={"covers": "true"})
    response.raise_for_status()
    albums = response.json()
    repo = app.state.container.get_music_repository()
    # TrackWithMetadata does not expose a track-level album. Read that one
    # value from the real cached scan, not from the enclosing album card.
    tag_albums = {str(t.path): t.album for a in repo.scan_albums() for t in a.tracks}
    actual = {}
    for album in albums:
        for track in album["tracks"]:
            path = Path(track["path"]).relative_to(music).as_posix()
            actual.setdefault(path, []).append({
                "mediaKey": album["mediaKey"], "relPath": track["relPath"],
                "url_path": track["url_path"], "title": track["title"], "artist": track["artist"],
                "album": tag_albums[track["path"]], "albumDisplay": album["album"],
                "albumArtist": album["artist"],
            })

    def fetch(url, source):
        reply = client.get(url)
        return {"url": url, "status": reply.status_code,
                "bytesMatch": reply.content == source.read_bytes() if source.is_file() else False}

    rows = []
    for row in expected["files"]:
        source = music / row["path"]
        media = None
        if source.is_file():
            # Excluded nested junk still gets a probe. Root songs use the
            # reserved two-segment identity pinned by the shared contract.
            album, file = row["mediaKey"], row["fileKey"]
            if album is None and len(source.relative_to(music).parts) > 1:
                album = "∕".join(source.relative_to(music).parts[:-1])
                file = source.name
            if album is not None:
                media = fetch(media_url(album, file), source)
        listed = actual.get(row["path"], [])
        handed_out = [fetch(media_url(*t["url_path"].removeprefix("/api/media/").split("/")), source)
                      for t in listed]
        rows.append({"expected": row, "actual": listed, "media": media, "listedMedia": handed_out})
    covers = []
    for key in sorted({r["mediaKey"] for r in expected["files"] if r["listed"]}):
        album_rows = [r for r in expected["files"] if r["listed"] and r["mediaKey"] == key]
        # Physical parent, disc folder removed using the oracle fileKey only.
        first = album_rows[0]
        parts = len(first["fileKey"].split("∕"))
        album_dir = (music / first["path"]).parents[parts - 1]
        cover = album_dir / "cover.jpg"
        reply = client.get(media_url(key, "cover.jpg"))
        inline = [a["cover"] for a in albums if a["mediaKey"] == key]
        covers.append({"mediaKey": key, "expectedStatus": 200 if cover.exists() else 404,
                       "status": reply.status_code,
                       "bytesMatch": reply.content == cover.read_bytes() if cover.exists() else None,
                       "inlineMatch": inline == ["data:image/jpeg;base64," + base64.b64encode(
                           cover.read_bytes()).decode()] if cover.exists() else inline == [None]})
    client.close()
    return {"rows": rows, "covers": covers, "albums": albums,
            "unexpectedPaths": sorted(set(actual) - {r["path"] for r in expected["files"]}),
            "listedTracks": sum(len(v) for v in actual.values()), "albumCount": len(albums)}


def listing_errors(row):
    expected, actual = row["expected"], row["actual"]
    if not expected["listed"]:
        return [] if not actual else [f"excluded path was listed: {actual!r}"]
    if len(actual) != 1:
        return [f"expected exactly one listing, got {len(actual)}"]
    wanted = {k: expected[k] for k in ("mediaKey", "title", "artist", "album", "albumDisplay", "albumArtist")}
    wanted["relPath"] = f"{expected['mediaKey']}/{expected['fileKey']}"
    wanted["url_path"] = f"/api/media/{wanted['relPath']}"
    return [f"{key}: expected {value!r}, actual {actual[0].get(key)!r}"
            for key, value in wanted.items() if actual[0].get(key) != value]


def media_errors(row):
    if not row["expected"]["listed"] and row["media"] is None:
        return []  # directories and unkeyed junk are not media
    return [f"media: {reply!r}" for reply in [row["media"], *row["listedMedia"]]
            if reply is None or reply["status"] != 200 or not reply["bytesMatch"]]


def generate_small(music, encoder):
    """Tiny public fixture: 20 short tones, plus exclusions and a cover.

    Keys and expected presentation below are literal and independent of the
    production path encoder, tag reader and the gitignored generator script.
    """
    from mutagen import File
    from mutagen.id3 import TALB, TIT2, TPE1, TPE2
    from mutagen.mp4 import MP4

    specs = [
        ("flat", "Flat/01.mp3", "Flat", "01.mp3", "Flat Song", "Band", "Flat Tags", "Band"),
        ("deep", "archive/a/b/Artist/Album/01.mp3", "archive∕a∕b∕Artist∕Album", "01.mp3",
         "Deep Song", "Band", "Album", "Band"),
        ("discs", "Band/Discs/CD1/01.mp3", "Band∕Discs", "CD1∕01.mp3", "Disc One", "Band", "Discs", "Band"),
        ("discs", "Band/Discs/Disc 2/01.mp3", "Band∕Discs", "Disc 2∕01.mp3", "Disc Two", "Band", "Discs", "Band"),
        ("compilation", "Mix/01.mp3", "Mix", "01.mp3", "Guest One", "Guest A", "Mix", "Various Artists"),
        ("compilation", "Mix/02.mp3", "Mix", "02.mp3", "Guest Two", "Guest B", "Mix", "Various Artists"),
        ("untagged", "No Tags/01 - mystery.mp3", "No Tags", "01 - mystery.mp3",
         "01 - mystery", "Unknown Artist", "Unknown Album", "Unknown Artist"),
        ("accents-emoji", "Beyoncé 🐧/Corazón/01 🎵.mp3", "Beyoncé 🐧∕Corazón", "01 🎵.mp3",
         "Mañana 🎵", "Beyoncé 🐧", "Corazón", "Beyoncé 🐧"),
        ("leading-spaces", " Leading/ 01.mp3", " Leading", " 01.mp3", " Space", " Band", " Leading", " Band"),
        ("literal-division-slash", "unicode/Literal∕Album/01.mp3", "unicode∕Literal∕Album", "01.mp3",
         "Literal Slash", "Band", "Literal∕Album", "Band"),
        ("root-loose", "loose.mp3", ROOT_ALBUM_KEY, "loose.mp3", "Loose", "Band", "Loose", "Band"),
        ("hidden-file", "Flat/.hidden.mp3", "Flat", ".hidden.mp3", "Hidden", "Band", "Flat Tags", "Band"),
        ("hidden-folder", ".hidden/Secret/01.mp3", ".hidden∕Secret", "01.mp3",
         "Secret", "Band", "Secret", "Band"),
    ]
    for filename, title in (("01.mp3", "MP3"), ("02.flac", "FLAC"), ("03.m4a", "M4A"),
                            ("04-vorbis.ogg", "Vorbis"), ("05-opus.ogg", "Opus OGG"),
                            ("06.wav", "WAV"), ("07.opus", "Native Opus")):
        specs.append(("native-opus" if filename.endswith(".opus") else "mixed-formats",
                      f"Formats/{filename}", "Formats", filename, title, "Band", "Formats", "Band"))
    music.mkdir()
    codecs = {".mp3": ["-c:a", "libmp3lame"], ".flac": ["-c:a", "flac"],
              ".m4a": ["-c:a", "aac"], ".ogg": ["-c:a", "vorbis", "-strict", "experimental", "-ac", "2"],
              ".opus": ["-c:a", "libopus"], ".wav": ["-c:a", "pcm_s16le"]}
    templates = {}
    rows = []
    for case, path, album_key, file_key, title, artist, album, album_artist in specs:
        dest = music / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        codec = ".opus" if "opus.ogg" in path else dest.suffix
        if codec not in templates:
            tone = music.parent / f"tone{codec}"
            subprocess.run([encoder, "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                            "sine=frequency=440:duration=0.15", *codecs[codec], str(tone)],
                           check=True, capture_output=True, timeout=30)
            templates[codec] = tone
        shutil.copyfile(templates[codec], dest)
        audio = File(dest)
        audio.delete()
        if case != "untagged":
            if dest.suffix in {".mp3", ".wav"}:
                if audio.tags is None:
                    audio.add_tags()
                for frame, text in ((TIT2, title), (TPE1, artist), (TALB, album), (TPE2, album_artist)):
                    audio.tags.add(frame(encoding=3, text=[text]))
            elif isinstance(audio, MP4):
                audio.update({"©nam": [title], "©ART": [artist], "©alb": [album], "aART": [album_artist]})
            else:
                audio.update({"title": [title], "artist": [artist], "album": [album], "albumartist": [album_artist]})
            audio.save()
        rows.append({"case": case, "path": path, "kind": "audio", "mediaKey": album_key,
                     "fileKey": file_key, "title": title, "artist": artist, "album": album,
                     "albumArtist": album_artist, "albumDisplay": "No Tags" if case == "untagged" else album,
                     "listed": case not in {"hidden-file", "hidden-folder"}})
    for path, data in (("Flat/cover.jpg", b"\xff\xd8\xff\xd9"), ("Flat/notes.nfo", b"synthetic junk")):
        (music / path).write_bytes(data)
        rows.append({"case": "sidecars-junk", "path": path, "kind": "junk", "listed": False,
                     "mediaKey": None, "fileKey": None})
    (music / "alias").symlink_to("Flat", target_is_directory=True)
    rows.append({"case": "symlink-alias", "path": "alias/01.mp3", "kind": "virtual_symlink_child",
                 "listed": False, "mediaKey": "Flat", "fileKey": "01.mp3"})
    (music / "expected.json").write_text(json.dumps({"files": rows}, ensure_ascii=False))


@pytest.fixture(scope="module")
def messy_scan(tmp_path_factory):
    encoder = shutil.which("ffmpeg")
    if encoder is None:
        pytest.skip("messy-library integration requires ffmpeg on PATH to generate synthetic audio")
    root = tmp_path_factory.mktemp("messy-library")
    generate_small(root / "Music", encoder)
    output = root / "actual.json"
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(root / "Music"),
                             str(root / "state"), str(output)],
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(output.read_text())


def test_listing_matches_every_expected_file(messy_scan):
    errors = [(r["expected"]["path"], listing_errors(r)) for r in messy_scan["rows"] if listing_errors(r)]
    assert not errors, errors
    assert not messy_scan["unexpectedPaths"]


def test_expected_media_and_listing_urls_play(messy_scan):
    rows = [r for r in messy_scan["rows"]
            if r["expected"]["case"] not in {"leading-spaces", "literal-division-slash"}]
    errors = [(r["expected"]["path"], media_errors(r)) for r in rows if media_errors(r)]
    assert not errors, errors


def test_nested_literal_division_slash_media(messy_scan):
    row = next(r for r in messy_scan["rows"] if r["expected"]["case"] == "literal-division-slash")
    assert not media_errors(row), media_errors(row)


def test_leading_spaces_media(messy_scan):
    row = next(r for r in messy_scan["rows"] if r["expected"]["case"] == "leading-spaces")
    assert not media_errors(row), media_errors(row)


def test_album_covers(messy_scan):
    for cover in messy_scan["covers"]:
        assert cover["status"] == cover["expectedStatus"], cover
        assert cover["bytesMatch"] is not False, cover
        assert cover["inlineMatch"], cover


if __name__ == "__main__":
    music, state, output = (Path(arg).resolve() for arg in sys.argv[1:])
    data = collect(music, state)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    failures = sum(bool(listing_errors(r) or media_errors(r)) for r in data["rows"])
    print(f"Scanned {len(data['rows'])} oracle rows; {data['albumCount']} albums; "
          f"{data['listedTracks']} listed tracks; {failures} file failures; {len(data['covers'])} cover probes")
