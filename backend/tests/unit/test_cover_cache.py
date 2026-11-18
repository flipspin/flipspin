"""Cache bounds, leases, and the process-wide ffmpeg admission limit."""
import os
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest

from app.config import ConfigManager
from app.domains.music import covers
from app.domains.music.covers import CoverCache
from app.exceptions import ConfigurationError
from app.infra.files import write_bytes_atomic


def test_lru_eviction_and_disk_hit_refresh(tmp_path, monkeypatch):
    cache = CoverCache(tmp_path / "cache", 12)
    runner = Mock(return_value=b"jpeg12")
    monkeypatch.setattr(cache, "_resize", runner)
    sources = [tmp_path / f"source{i}.jpg" for i in range(3)]
    paths = []
    for index, source in enumerate(sources[:2]):
        source.write_bytes(b"source")
        with cache.thumbnail(source, 96, source.stat()) as (path, _):
            paths.append(path)
        os.utime(path, ns=(index + 1, index + 1))
    # Touch the older entry through the public path, then exceed the cap.
    with cache.thumbnail(sources[0], 96, sources[0].stat()) as (hit, _):
        assert hit == paths[0]
    sources[2].write_bytes(b"source")
    with cache.thumbnail(sources[2], 96, sources[2].stat()) as (new, _):
        assert new.exists() and paths[0].exists()
        assert not paths[1].exists()
    assert sum(p.stat().st_size for p in cache.directory.glob("*.jpg")) == 12
    assert runner.call_count == 3
    assert not list(cache.directory.glob(".*.tmp"))


def test_active_response_files_survive_eviction_until_release(tmp_path, monkeypatch):
    cache = CoverCache(tmp_path / "cache", 1)
    monkeypatch.setattr(cache, "_resize", lambda *_: b"jpeg12")
    source = tmp_path / "source.jpg"
    source.write_bytes(b"source")
    with cache.thumbnail(source, 96, source.stat()) as (first, _):
        with cache.thumbnail(source, 128, source.stat()) as (second, _):
            assert first.read_bytes() == second.read_bytes() == b"jpeg12"
        assert first.exists()
    # Eviction runs only on a write (a hit never walks the directory), so the
    # released file waits for the next write to be dropped.
    assert not cache._active
    with cache.thumbnail(source, 300, source.stat()) as (third, _):
        assert third.exists()
    assert not first.exists() and not second.exists()


def test_ffmpeg_global_semaphore_bounds_different_keys(monkeypatch, tmp_path):
    assert covers._RESIZES._value == (os.cpu_count() or 1)
    monkeypatch.setattr(covers, "_RESIZES", threading.Semaphore(2))
    monkeypatch.setattr(covers, "resolve_ffmpeg", lambda: "ffmpeg")
    guard = threading.Lock()
    entered = threading.Event()
    release = threading.Event()
    active = peak = calls = 0

    def run(*args, **kwargs):
        nonlocal active, peak, calls
        with guard:
            calls += 1
            active += 1
            peak = max(peak, active)
            if active == 2:
                entered.set()
        assert release.wait(5)
        with guard:
            active -= 1
        return subprocess.CompletedProcess(args[0], 0, b"\xff\xd8JPEG\xff\xd9")

    monkeypatch.setattr(covers.subprocess, "run", run)
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(CoverCache._resize, tmp_path / f"{i}.jpg", 96) for i in range(6)]
        assert entered.wait(5)
        release.set()
        for future in futures:
            assert future.result(timeout=10).startswith(b"\xff\xd8")
    assert calls == 6 and peak == 2 and active == 0


def test_failed_atomic_binary_replace_preserves_previous_file(tmp_path, monkeypatch):
    target = tmp_path / "cover.jpg"
    write_bytes_atomic(target, b"old")
    monkeypatch.setattr(os, "replace", Mock(side_effect=OSError("full disk")))
    with pytest.raises(OSError):
        write_bytes_atomic(target, b"new")
    assert target.read_bytes() == b"old"
    assert list(tmp_path.iterdir()) == [target]


def test_cover_cache_configuration_follows_data_dir_and_env(config, monkeypatch):
    assert config.cover_cache_dir == config.playlist_dir.parent / "cache" / "covers"
    assert config.cover_cache_mb == 200
    monkeypatch.setenv("KROBI_COVER_CACHE_MB", "7")
    assert ConfigManager.from_env().cover_cache_mb == 7
    config.cover_cache_mb = 0
    with pytest.raises(ConfigurationError, match="cover_cache_mb"):
        config.validate()


def test_concurrent_mosaics_generate_once_and_eviction_respects_leases(tmp_path, monkeypatch):
    cache = CoverCache(tmp_path / "cache", 12)
    sources = [tmp_path / f"{i}.jpg" for i in range(4)]
    for source in sources:
        source.write_bytes(b"source")
    entered, release = threading.Event(), threading.Event()

    def render(*_):
        entered.set()
        assert release.wait(5)
        return b"jpeg12"

    runner = Mock(side_effect=render)
    monkeypatch.setattr(cache, "_mosaic", runner)

    def request():
        with cache.mosaic(sources, 120) as (path, _):
            return path.read_bytes()

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(request)
        assert entered.wait(5)
        second = pool.submit(request)
        release.set()
        assert first.result(timeout=10) == second.result(timeout=10) == b"jpeg12"
    assert runner.call_count == 1
    # A different size shares the byte cap; pinned files survive concurrent writes.
    with cache.mosaic(sources, 120) as (first_path, _):
        with cache.mosaic(sources, 122) as (second_path, _):
            assert first_path.exists() and second_path.exists()
        with cache.mosaic(sources, 124) as (third_path, _):
            assert first_path.exists() and third_path.exists()
            assert not second_path.exists()
    assert not cache._active
    assert sum(p.stat().st_size for p in cache.directory.glob("*.jpg")) == 12
