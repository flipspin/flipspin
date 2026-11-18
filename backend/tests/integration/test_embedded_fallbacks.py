"""Embedded fallbacks through real audio files, disk caches and HTTP routes."""
import hashlib
import logging
import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from mutagen import File
from mutagen.flac import Picture
from mutagen.id3 import APIC, SYLT, USLT

from app.dependencies import get_cover_cache, get_library_scope, get_lyrics_service, get_music_service
from app.domains.lyrics.embedded import read_embedded
from app.domains.lyrics.models import KIND_PLAIN, KIND_SYNCED, LyricsRecord
from app.domains.lyrics import repositories as lyrics_repositories
from app.domains.lyrics.repositories import LyricsRepository
from app.domains.lyrics.services import LyricsService
from app.domains.music import embedded_art
from app.domains.music.covers import CoverCache, cover_version
from app.domains.music.embedded_art import EmbeddedArtCache, read_picture
from app.domains.music.repositories import MusicRepository
from app.domains.music.services import MusicService
from app.domains.user_library.scope import LibraryScope, get_library_scope as lyrics_scope
from app.infra.progress import ProgressTracker
from app.main import app
from app.providers.registry import ProviderRegistry
from app.utils.library_paths import ROOT_ALBUM_KEY, rel_path_for

pytestmark = pytest.mark.integration
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "embedded"
FORMATS = ["uslt.mp3", "sylt.mp3", "picture.flac", "covr.m4a", "vorbis.ogg"]
WORDS = "First café line\nSecond line"
LRC = "[00:01.250]First café line\n[01:01.234]Second line"
LOG = logging.getLogger(__name__)


@pytest.fixture
def library(config, tmp_path):
    config.lyrics_file = tmp_path / "lyrics.json"
    config.lyrics_auto_fetch = True
    music = MusicRepository(config, LOG)
    lyrics = LyricsService(
        repository=LyricsRepository(config, LOG), music_repository=music,
        config=config, logger=LOG, registry=ProviderRegistry(store=None), progress_tracker=ProgressTracker(),
    )
    lyrics._collect = Mock(side_effect=AssertionError("local lyrics must not reach providers"))
    album = config.base_music_dir / "Album"
    album.mkdir()
    service = MusicService(music, Mock(), config, LOG)
    overrides = {
        get_music_service: lambda: service,
        get_lyrics_service: lambda: lyrics,
        get_library_scope: lambda: LibraryScope(),
        lyrics_scope: lambda: LibraryScope(),
        get_cover_cache: lambda: CoverCache(config.cover_cache_dir, 20 * 1024 * 1024),
    }
    previous = dict(app.dependency_overrides)
    app.dependency_overrides.update(overrides)
    yield SimpleNamespace(config=config, album=album, music=music, lyrics=lyrics, client=TestClient(app))
    app.dependency_overrides.clear()
    app.dependency_overrides.update(previous)


def song(library, name="uslt.mp3", target=None):
    target = target or library.album / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURES / name, target)
    return target


@pytest.mark.parametrize("name", FORMATS)
def test_real_formats_serve_art_and_lyrics_without_touching_audio_or_sidecars(library, name):
    path = song(library, name)
    before = hashlib.sha256(path.read_bytes()).digest()
    assert File(path).info.length > 0  # Actual decodable audio containers, not tag-only stubs.
    response = library.client.get("/api/media/Album/cover.jpg")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "image/png"
    assert response.content == (FIXTURES / "front.png").read_bytes()
    assert library.client.head("/api/media/Album/cover.jpg").status_code == 405
    thumbnail = library.client.get("/api/media/Album/cover.jpg?size=96")
    assert thumbnail.status_code == 200 and thumbnail.headers["content-type"] == "image/jpeg"
    assert thumbnail.content.startswith(b"\xff\xd8")
    listing = library.client.get("/api/listar-albums-con-metadata").json()[0]
    assert listing["cover"].startswith("data:image/png;base64,")
    version = listing["coverVersion"]
    assert library.client.get(f"/api/media/Album/cover.jpg?v={version}").headers["cache-control"].endswith("immutable")
    result = library.client.get(f"/api/lyrics/Album/{name}")
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["text"] == (LRC if name == "sylt.mp3" else WORDS)
    assert body["kind"] == (KIND_SYNCED if name == "sylt.mp3" else KIND_PLAIN)
    assert body["source"] == "file" and body["sidecar"] is None and body["edited"] is False
    assert library.lyrics.repository.get_record(f"Album/{name}").source == "file"
    assert library.lyrics.start_scan().total == 0
    assert library.lyrics.enqueue_files([path]) is None
    library.lyrics._collect.assert_not_called()
    assert not path.with_suffix(".lrc").exists() and not path.with_suffix(".txt").exists()
    assert hashlib.sha256(path.read_bytes()).digest() == before


@pytest.mark.parametrize("name", FORMATS)
def test_library_pass_and_acquisition_adopt_embedded_before_any_get(library, name):
    path = song(library, name)
    rel = f"Album/{name}"
    assert library.lyrics.start_scan().total == 0
    assert library.lyrics.repository.get_record(rel).source == "file"
    library.lyrics.repository.remove_record(rel)
    assert library.lyrics.enqueue_files([path]) is None
    assert library.lyrics.repository.get_record(rel).sidecar is None
    library.lyrics._collect.assert_not_called()


def test_disk_cache_survives_restart_and_both_mtime_and_size_invalidate(library, monkeypatch):
    path = song(library)
    first = library.music._find_cover_art(library.album)
    version = cover_version(first)
    original = embedded_art.read_picture
    reader = Mock(side_effect=AssertionError("disk hits must not parse tags"))
    monkeypatch.setattr(embedded_art, "read_picture", reader)
    fresh = MusicRepository(library.config, LOG)
    assert fresh._find_cover_art(library.album) == first
    assert cover_version(first) == version  # Access cannot invalidate URL/thumbnail caches.
    monkeypatch.setattr(embedded_art, "read_picture", original)
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    second = fresh._find_cover_art(library.album)
    assert second != first
    stat = path.stat()
    path.write_bytes(path.read_bytes() + b"padding")
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert fresh._find_cover_art(library.album) not in (first, second)
    assert not list(library.config.cover_cache_dir.rglob("*.tmp"))


def test_folder_precedence_first_usable_track_and_external_retags(library):
    first = song(library, target=library.album / "01.mp3")
    audio = File(first)
    audio.tags.delall("APIC")
    audio.save()
    second = song(library, target=library.album / "02.mp3")
    (library.album / "00.mp3").write_bytes(b"corrupt audio")
    art = library.music._find_cover_art(library.album)
    assert art.read_bytes() == (FIXTURES / "front.png").read_bytes()
    cover = library.album / "folder.jpg"
    cover.write_bytes(b"folder")
    assert library.music._find_cover_art(library.album) == cover
    nested = library.album / "cover" / "front.png"
    nested.parent.mkdir()
    nested.write_bytes(b"cover subdirectory")
    assert library.music._find_cover_art(library.album) == nested
    nested.unlink()
    cover.unlink()
    # Retagging in place changes no directory timestamp.
    audio = File(first)
    audio.tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="new", data=b"\xff\xd8\xffnew"))
    audio.save()
    assert library.music._find_cover_art(library.album).read_bytes() == b"\xff\xd8\xffnew"
    first.unlink()
    assert library.music._find_cover_art(library.album).read_bytes() == art.read_bytes()
    second.unlink()
    assert library.music._find_cover_art(library.album) is None



def test_removed_cached_cover_with_unchanged_directory_stamp_uses_embedded(library):
    song(library)
    cover = library.album / "folder.jpg"
    cover.write_bytes(b"folder")
    assert library.music._find_cover_art(library.album) == cover
    stamp = library.album.stat()
    cover.unlink()
    # Model filesystems whose directory timestamp did not advance on removal.
    os.utime(library.album, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    found = library.music._find_cover_art(library.album)
    assert found != cover
    assert found.read_bytes() == (FIXTURES / "front.png").read_bytes()

def test_sidecars_override_embedded_even_when_added_later_and_only_save_materializes(library):
    path = song(library, "sylt.mp3")
    rel = "Album/sylt.mp3"
    initial = library.lyrics.get(rel)
    assert initial.text == LRC and initial.record.sidecar is None
    # The row survives a repository restart; its text still comes from the audio.
    restarted = LyricsRepository(library.config, LOG)
    assert restarted.read_sidecar(restarted.get_record(rel)) == LRC
    path.with_suffix(".txt").write_text("Plain sidecar", encoding="utf-8")
    assert library.lyrics.get(rel).text == "Plain sidecar"
    path.with_suffix(".txt").unlink()
    assert library.lyrics.get(rel).text == LRC
    path.with_suffix(".txt").write_text("Plain sidecar", encoding="utf-8")
    path.with_suffix(".lrc").write_text("[00:00.00]Synced sidecar", encoding="utf-8")
    library.lyrics.repository.remove_record(rel)
    assert library.lyrics.get(rel).text == "[00:00.00]Synced sidecar"
    path.with_suffix(".txt").unlink()
    path.with_suffix(".lrc").unlink()
    response = library.client.put("/api/lyrics/Album/sylt.mp3", json={
        "kind": "synced", "text": "[00:01.00]Edited words", "source": "manual", "edited": True,
    })
    assert response.status_code == 200, response.text
    assert response.json()["sidecar"] == "sylt.lrc"
    assert path.with_suffix(".lrc").read_text() == "[00:01.00]Edited words\n"
    assert read_embedded(path) == (KIND_SYNCED, LRC)


def test_missing_removed_and_changed_embedded_tags_do_not_leave_stale_text(library):
    path = song(library)
    rel = "Album/uslt.mp3"
    assert library.lyrics.get(rel).text == WORDS
    audio = File(path)
    audio.tags.add(USLT(encoding=3, lang="eng", desc="", text="Changed words"))
    audio.save()
    assert library.lyrics.get(rel).text == "Changed words"
    audio.tags.delall("USLT")
    audio.save()
    assert library.lyrics.get(rel) is None
    assert library.lyrics.repository.get_record(rel) is None
    path.write_bytes(b"broken audio")
    assert read_embedded(path) is None
    assert library.client.get("/api/lyrics/Album/uslt.mp3").status_code == 404


def test_scope_blocks_reads_and_adoption_before_any_extraction(library, monkeypatch):
    song(library)
    app.dependency_overrides[get_library_scope] = lambda: LibraryScope(frozenset({"Other/song.mp3"}))
    app.dependency_overrides[lyrics_scope] = app.dependency_overrides[get_library_scope]
    extractor = Mock(side_effect=AssertionError("out of scope"))
    monkeypatch.setattr(library.music._embedded_art, "extract", extractor)
    assert library.client.get("/api/media/Album/cover.jpg").status_code == 404
    assert library.client.get("/api/lyrics/Album/uslt.mp3").status_code == 404
    extractor.assert_not_called()
    monkeypatch.undo()
    assert library.lyrics._tracks_without_lyrics(allows=lambda rel: False) == []
    assert library.lyrics.repository.all_records() == {}


def test_disc_root_hidden_and_unrelated_album_candidates(library):
    # An unrelated child album must not lend its image to this album.
    song(library, target=library.album / "Other" / "song.mp3")
    song(library, target=library.album / ".hidden.mp3")
    assert library.music._find_cover_art(library.album) is None
    disc = song(library, target=library.album / "CD2" / "song.mp3")
    assert library.music._find_cover_art(library.album).is_file()
    rel = rel_path_for(library.config.base_music_dir, disc)
    assert rel == "Album/CD2∕song.mp3" and library.lyrics.get(rel).text == WORDS
    root = song(library, target=library.config.base_music_dir / "loose.mp3")
    assert library.music._find_cover_art(library.config.base_music_dir).is_file()
    assert library.lyrics.get(f"{ROOT_ALBUM_KEY}/{root.name}").text == WORDS


def test_concurrent_disk_extraction_is_atomic_and_parses_once(library, monkeypatch):
    path = song(library)
    reader = Mock(wraps=read_picture)
    monkeypatch.setattr(embedded_art, "read_picture", reader)
    cache = library.music._embedded_art
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = list(pool.map(lambda _: cache.extract(path, library.config.cover_cache_dir, 10000), range(12)))
    assert len(set(paths)) == 1 and paths[0].read_bytes() == (FIXTURES / "front.png").read_bytes()
    assert reader.call_count == 1


def test_size_limits_bad_picture_labels_and_disk_failure(library, monkeypatch):
    path = song(library)
    audio = File(path)
    audio.tags.delall("APIC")
    audio.tags.add(APIC(encoding=3, mime="image/png", type=3, desc="oversize", data=b"\x89PNG\r\n\x1a\n" + b"x" * 80))
    audio.save()
    monkeypatch.setattr(embedded_art, "MAX_IMAGE_BYTES", 80)
    assert read_picture(path) is None
    audio.tags.add(APIC(encoding=3, mime="image/jpeg", type=4, desc="wrong MIME", data=(FIXTURES / "front.png").read_bytes()))
    audio.save()
    assert read_picture(path)[1] == ".png"
    cache = EmbeddedArtCache()
    assert cache.extract(path, library.config.cover_cache_dir, 1) is None
    monkeypatch.setattr(embedded_art, "write_bytes_atomic", Mock(side_effect=OSError("disk full")))
    assert cache.extract(path, library.config.cover_cache_dir, 10000) is None


def test_sylt_frame_timestamps_and_non_lyric_content(library):
    path = song(library, "sylt.mp3")
    audio = File(path)
    audio.tags.delall("SYLT")
    audio.tags.add(SYLT(encoding=3, lang="eng", format=1, type=1, text=[("Frame timed", 100)]))
    audio.save()
    milliseconds = round(100 * 1152 * 1000 / audio.info.sample_rate)
    seconds, fraction = divmod(milliseconds, 1000)
    assert read_embedded(path) == (KIND_SYNCED, f"[00:{seconds:02d}.{fraction:03d}]Frame timed")
    audio.tags.delall("SYLT")
    audio.tags.add(SYLT(encoding=3, lang="eng", format=2, type=3, text=[("Movement title", 100)]))
    audio.save()
    assert read_embedded(path) == (KIND_PLAIN, WORDS)


@pytest.mark.parametrize("key", ["LYRICS", "UNSYNCEDLYRICS"])
def test_vorbis_lyrics_can_carry_lrc_and_bad_picture_blocks_are_skipped(library, key):
    path = song(library, "vorbis.ogg")
    audio = File(path)
    del audio["UNSYNCEDLYRICS"]
    audio[key] = ["  ", LRC]
    audio["covr"] = ["unrelated Vorbis comment"]
    audio["METADATA_BLOCK_PICTURE"] = ["invalid base64", *audio["METADATA_BLOCK_PICTURE"]]
    audio.save()
    assert read_embedded(path) == (KIND_SYNCED, LRC)
    assert read_picture(path)[1] == ".png"


def test_flac_native_picture_and_lyrics_absent_are_safe(library):
    path = song(library, "picture.flac")
    audio = File(path)
    audio.clear_pictures()
    audio.tags.clear()
    audio.save()
    assert read_picture(path) is None and read_embedded(path) is None
    picture = Picture()
    picture.data = b"not an image"
    picture.mime, picture.type = "image/png", 3
    audio.add_picture(picture)
    audio.save()
    assert read_picture(path) is None


def test_queued_song_gains_embedded_words_before_provider_call(library, monkeypatch):
    path = song(library)
    audio = File(path)
    audio.tags.delall("USLT")
    audio.save()
    monkeypatch.setattr(library.lyrics, "_ensure_worker_locked", lambda: None)
    summary = library.lyrics.start_scan()
    assert summary.total == 1
    job = library.lyrics._queue.popleft()
    audio.tags.add(USLT(encoding=3, lang="eng", desc="", text=WORDS))
    audio.save()
    library.lyrics._process(job)
    library.lyrics._collect.assert_not_called()
    assert library.lyrics.repository.get_record("Album/uslt.mp3").sidecar is None
    assert library.lyrics.repository.pending() == []
    assert not path.with_suffix(".txt").exists()


def test_syllable_sylt_becomes_lines_with_first_fragment_timestamps(library):
    path = song(library, "sylt.mp3")
    audio = File(path)
    audio.tags.delall("SYLT")
    audio.tags.add(SYLT(encoding=3, lang="eng", format=2, type=1, text=[
        ("First ", 1000), ("café ", 1200), ("line", 1500), ("\nSecond ", 6000), ("line\n", 6500),
    ]))
    audio.save()
    assert read_embedded(path) == (KIND_SYNCED, "[00:01.000]First café line\n[00:06.000]Second line")


def test_embedded_cache_lru_cap_and_evicted_image_can_be_reextracted(library):
    cache = EmbeddedArtCache()
    directory = library.config.cover_cache_dir
    paths = [song(library, target=library.album / f"{i}.mp3") for i in range(3)]
    budget = (FIXTURES / "front.png").stat().st_size * 2
    first = cache.extract(paths[0], directory, budget)
    second = cache.extract(paths[1], directory, budget)
    os.utime(first, ns=(1, first.stat().st_mtime_ns))
    os.utime(second, ns=(1, second.stat().st_mtime_ns))
    assert cache.extract(paths[0], directory, budget) == first  # Refresh LRU.
    third = cache.extract(paths[2], directory, budget)
    assert first.exists() and third.exists() and not second.exists()
    assert sum(p.stat().st_size for p in directory.iterdir()) <= budget
    assert cache.extract(paths[1], directory, budget).read_bytes() == (FIXTURES / "front.png").read_bytes()


def test_retargeted_music_root_never_reuses_previous_album_or_lyrics(library, tmp_path):
    song(library)
    assert library.lyrics.get("Album/uslt.mp3").text == WORDS
    old = library.music._find_cover_art(library.album)
    library.config.base_music_dir = tmp_path / "Replacement"
    library.config.base_music_dir.mkdir()
    new_album = library.config.base_music_dir / "Album"
    new_album.mkdir()
    song(library, "sylt.mp3", target=new_album / "uslt.mp3")
    assert library.lyrics.get("Album/uslt.mp3").text == LRC
    assert library.music._find_cover_art(new_album) != old


def test_local_adoption_cannot_replace_an_edit_saved_during_tag_read(library, monkeypatch):
    song(library)
    rel = "Album/uslt.mp3"
    repository = library.lyrics.repository
    entered, release = threading.Event(), threading.Event()

    def read(path):
        entered.set()
        assert release.wait(5)
        return read_embedded(path)

    monkeypatch.setattr(lyrics_repositories, "read_embedded", read)
    with ThreadPoolExecutor(max_workers=1) as pool:
        adoption = pool.submit(repository.adopt, rel, None, None)
        assert entered.wait(5)
        sidecar = repository.write_sidecar(rel, KIND_PLAIN, "User's saved words")
        saved = LyricsRecord(rel, KIND_PLAIN, "manual", edited=True, sidecar=sidecar)
        repository.put_record(saved)
        release.set()
        assert adoption.result(timeout=5).edited is True
    current = repository.get_record(rel)
    assert current.source == "manual" and current.edited is True
    assert repository.read_sidecar(current).strip() == "User's saved words"


def test_large_embedded_lyric_still_prevents_refetch_and_sidecar_creation(library):
    path = song(library)
    words = "x" * (1024 * 1024 + 1)
    audio = File(path)
    audio.tags.delall("USLT")
    audio.tags.add(USLT(encoding=3, lang="eng", desc="", text=words))
    audio.save()
    assert library.lyrics.start_scan().total == 0
    assert library.lyrics.get("Album/uslt.mp3").text == words
    library.lyrics._collect.assert_not_called()
    assert not path.with_suffix(".txt").exists() and not path.with_suffix(".lrc").exists()
