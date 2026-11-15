"""Real JPEG/ffmpeg tests for the thumbnail route, including its failure path."""
import os
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_cover_cache, get_library_scope, get_music_service
from app.domains.music import covers
from app.domains.music.covers import CoverCache, cover_version
from app.domains.music.models import Album
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.user_library.scope import LibraryScope
from app.infra.ffmpeg import resolve_ffmpeg
from app.main import app

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "covers"
URL = "/api/media/Album/cover.jpg"


@pytest.fixture
def library(tmp_path):
    album_dir = tmp_path / "Music" / "Album"
    album_dir.mkdir(parents=True)
    source = album_dir / "cover.jpg"
    source.write_bytes((FIXTURES / "large.jpg").read_bytes())
    service = Mock()
    service.config.base_music_dir = album_dir.parent
    service.music_repo.config = service.config
    service.music_repo.analysis = AnalysisRepository(tmp_path / 'analysis.sqlite')
    service.music_repo._tag_cache = {}
    service.music_repo.tag_revision = 0
    service.music_repo._owner_ghosts = None
    service.music_repo._find_cover_art.return_value = source
    service.list_albums.return_value = [Album(
        name="Album", artist="Artist", path=album_dir, tracks=[], cover_art=source,
    )]
    cache = CoverCache(tmp_path / "cache" / "covers", 200 * 1024 * 1024)
    overrides = {get_music_service: lambda: service, get_cover_cache: lambda: cache}
    app.dependency_overrides.update(overrides)
    resolve_ffmpeg()  # Probe before patching the subprocess runner.
    try:
        yield TestClient(app), source, cache, service
    finally:
        for dependency in overrides:
            app.dependency_overrides.pop(dependency, None)


def dimensions(jpeg):
    # Decode the response, without adding an image dependency to the backend.
    decoded = subprocess.run(
        [resolve_ffmpeg(), "-v", "error", "-i", "pipe:0", "-frames:v", "1",
         "-c:v", "ppm", "-threads", "1", "-f", "image2pipe", "pipe:1"],
        input=jpeg, capture_output=True, check=True, timeout=10,
    ).stdout
    magic, size, depth, _ = decoded.split(b"\n", 3)
    assert magic == b"P6" and depth == b"255"
    return tuple(int(value) for value in size.split())


@pytest.mark.parametrize("size", [64, 96, 128, 300])
@pytest.mark.parametrize("fixture,original", [("large.jpg", (1000, 600)), ("small.jpg", (40, 60))])
def test_real_jpegs_keep_aspect_and_never_upscale(library, fixture, original, size):
    client, source, _, _ = library
    source.write_bytes((FIXTURES / fixture).read_bytes())
    assert dimensions(source.read_bytes()) == original
    response = client.get(URL, params={"size": size})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    width, height = dimensions(response.content)
    assert max(width, height) == min(size, max(original))
    assert abs(width / height - original[0] / original[1]) < 0.03


def test_disk_hit_strong_etag_conditional_range_and_head(library, monkeypatch):
    client, _, cache, _ = library
    runner = Mock(wraps=subprocess.run)
    monkeypatch.setattr(covers.subprocess, "run", runner)
    first = client.get(URL + "?size=96")
    assert first.status_code == 200
    etag = first.headers["etag"]
    cached = next(cache.directory.glob("*.jpg"))
    assert etag == f'"{cached.stem}"'
    assert not etag.startswith("W/")
    assert runner.call_count == 1

    # A fresh instance proves it is the disk cache, not a memoized byte buffer.
    app.dependency_overrides[get_cover_cache] = lambda: CoverCache(cache.directory, cache.max_bytes)
    runner.side_effect = AssertionError("a cache hit must not run ffmpeg")
    again = client.get(URL + "?size=96")
    assert again.content == first.content
    assert again.headers["etag"] == etag
    for candidate in [etag, f'"old", W/{etag}', "*"]:
        response = client.get(URL + "?size=96", headers={"If-None-Match": candidate})
        assert response.status_code == 304
        assert response.content == b""
        assert response.headers["etag"] == etag
        assert response.headers["cache-control"] == "public, max-age=86400"
    partial = client.get(URL + "?size=96", headers={"Range": "bytes=0-9", "If-Range": etag})
    assert partial.status_code == 206
    assert partial.content == first.content[:10]
    assert partial.headers["content-range"] == f"bytes 0-9/{len(first.content)}"
    assert client.head(URL + "?size=96").status_code == client.head(URL).status_code
    assert not cache._active


@pytest.mark.parametrize("size", ["97", "600", "0", "-1", "96.5", "nope", ""])
def test_invalid_sizes_are_422(library, size):
    client, _, _, _ = library
    assert client.get(URL, params={"size": size}).status_code == 422


def test_original_is_byte_identical_without_a_resize(library, monkeypatch):
    client, source, cache, _ = library
    runner = Mock(side_effect=AssertionError("originals do not invoke ffmpeg"))
    monkeypatch.setattr(covers.subprocess, "run", runner)
    response = client.get(URL)
    assert response.status_code == 200
    assert response.content == source.read_bytes()
    assert response.headers["cache-control"] == "public, max-age=86400"
    assert not cache.directory.exists()
    runner.assert_not_called()


@pytest.mark.parametrize("query", ["", "?size=96"])
def test_listing_revision_controls_cache_lifetime_and_changes_with_source(library, query):
    client, source, _, _ = library
    listing = client.get("/api/listar-albums-con-metadata?covers=false").json()[0]
    version = listing["coverVersion"]
    assert version == cover_version(source) and len(version) == 12
    assert listing["cover"] is None
    separator = "&" if query else "?"
    url = URL + query
    matching = client.get(f"{url}{separator}v={version}")
    assert matching.headers["cache-control"] == "public, max-age=31536000, immutable"
    conditional = client.get(f"{url}{separator}v={version}", headers={"If-None-Match": matching.headers["etag"]})
    assert conditional.status_code == 304
    assert conditional.headers["cache-control"] == matching.headers["cache-control"]
    for suffix in ["", f"{separator}v=wrong"]:
        assert client.get(url + suffix).headers["cache-control"] == "public, max-age=86400"
    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    updated = client.get("/api/listar-albums-con-metadata?covers=false").json()[0]["coverVersion"]
    assert updated != version
    stale = client.get(f"{url}{separator}v={version}")
    assert stale.headers["cache-control"] == "public, max-age=86400"
    assert stale.headers["etag"] != matching.headers["etag"]
    # A size-only change also invalidates the revision.
    stat = source.stat()
    source.write_bytes(source.read_bytes() + b"extra")
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert cover_version(source) != updated


def test_missing_cover_and_album_stay_404_and_listing_revision_is_null(library):
    client, source, _, service = library
    source.unlink()
    for url in [URL, URL + "?size=96&v=abc", "/api/media/Missing/cover.jpg?size=96"]:
        assert client.get(url).status_code == 404
    assert client.get("/api/listar-albums-con-metadata").json()[0]["coverVersion"] is None
    service.music_repo._find_cover_art.return_value = None
    assert client.get(URL + "?size=96").status_code == 404


def test_undecodable_falls_back_and_logs_once_per_revision(library, monkeypatch, caplog):
    client, source, cache, _ = library
    source.write_bytes(b"this is not an image")
    runner = Mock(wraps=subprocess.run)
    monkeypatch.setattr(covers.subprocess, "run", runner)
    for size in [96, 96, 128]:
        response = client.get(URL, params={"size": size})
        assert response.status_code == 200
        assert response.content == source.read_bytes()
    assert runner.call_count == 1
    assert len([r for r in caplog.records if "Could not resize cover" in r.message]) == 1
    assert not list(cache.directory.glob("*.jpg"))
    source.write_bytes((FIXTURES / "large.jpg").read_bytes())
    assert client.get(URL + "?size=96").content != source.read_bytes()
    assert runner.call_count == 2


def test_scope_and_path_safety_apply_before_thumbnail_lookup(library, monkeypatch):
    client, _, cache, _ = library
    app.dependency_overrides[get_library_scope] = lambda: LibraryScope(frozenset({"Other/song.mp3"}))
    runner = Mock(side_effect=AssertionError("unauthorized covers must not be resized"))
    monkeypatch.setattr(cache, "_resize", runner)
    try:
        for url in [URL + "?size=96", "/api/media/..%E2%88%95Album/cover.jpg?size=96"]:
            assert client.get(url).status_code == 404
        runner.assert_not_called()
    finally:
        app.dependency_overrides.pop(get_library_scope, None)


def test_same_key_concurrent_requests_run_ffmpeg_once(library, monkeypatch):
    client, _, cache, _ = library
    entered = threading.Event()
    finish = threading.Event()
    original = cache._resize

    def resize(source, size):
        entered.set()
        assert finish.wait(5)
        return original(source, size)

    runner = Mock(side_effect=resize)
    monkeypatch.setattr(cache, "_resize", runner)
    with ThreadPoolExecutor(max_workers=6) as pool:
        first = pool.submit(client.get, URL + "?size=96")
        assert entered.wait(5)
        others = [pool.submit(client.get, URL + "?size=96") for _ in range(5)]
        finish.set()
        responses = [first.result(timeout=10), *(f.result(timeout=10) for f in others)]
    assert all(r.status_code == 200 and r.content == responses[0].content for r in responses)
    assert runner.call_count == 1
    assert not cache._active and not cache._locks
