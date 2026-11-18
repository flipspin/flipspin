"""Admission is shared across jobs; legacy analysis capacity stays accepted."""
import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from app.infra import env_sources
from app.infra.capacity import CapacityLimiter
from app.infra.progress import ProgressTracker
from app.dependencies import DependencyContainer
from app.domains.downloads.core import DownloadEngine
from app.domains.downloads.models import TrackDownloadRequest, TrackMetadata
from app.domains.music.repositories import MusicRepository
from app.domains.server import machine, services

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "contracts/server-config.json").read_text())


@pytest.fixture
def fake_media(monkeypatch):
    """Capacity tests use sentinel bytes; real media has separate boundary tests."""
    def package(path, **kwargs):
        target = path.with_suffix('.m4a')
        path.rename(target)
        return target
    monkeypatch.setattr('app.domains.acquisition.engine.prepare_m4a', package)
    monkeypatch.setattr('app.domains.acquisition.import_stage.validate', lambda *args, **kwargs: {})


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_two_jobs_share_one_download_limit_and_resize_live(config, tmp_path, fake_media):
    config.max_concurrent_downloads = 2
    config.max_concurrent_jobs = 2
    tracker = ProgressTracker()
    repo = Mock()
    active, peak = 0, 0
    started, releases = [], asyncio.Queue()
    async def download(url, output_path, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        started.append(output_path)
        await releases.get()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"audio")
        active -= 1
        return output_path
    repo.download_source_audio = AsyncMock(side_effect=download)
    # Different engines with the same nest config must still share capacity.
    engines = [DownloadEngine(repo, Mock(), Mock(), tracker, config, Mock()) for _ in range(2)]
    requests = [[TrackDownloadRequest(youtube_url="https://youtube.com/watch?v=test",
                                    destination=tmp_path / str(job), filename=f"song-{i}",
                                    metadata=TrackMetadata(title=f"song-{job}-{i}")) for i in range(4)]
                for job in range(2)]
    tasks = [asyncio.create_task(e.download_multiple_tracks(r, progress_id=f"job-{i}"))
             for i, (e, r) in enumerate(zip(engines, requests, strict=True))]
    await until(lambda: len(started) == 2)
    assert config.job_limiter.active == 2 and peak == 2
    config.max_concurrent_downloads = 1
    config.download_limiter.wake()
    await releases.put(None)
    await until(lambda: active == 1)
    assert len(started) == 2  # lowering leaves running work alone, admits nothing
    await releases.put(None)
    await until(lambda: len(started) == 3)
    assert active == 1
    config.max_concurrent_downloads = 3
    config.download_limiter.wake()
    await until(lambda: active == 3)  # increasing wakes waiters without a completion
    for _ in range(8):
        await releases.put(None)
    results = await asyncio.gather(*tasks)
    assert all(r.success for batch in results for r in batch)
    assert peak == 3 and config.download_limiter.active == config.job_limiter.active == 0


@pytest.mark.asyncio
async def test_jobs_wait_as_nonterminal_queued_and_wake_live(config, tmp_path, fake_media):
    config.max_concurrent_jobs = 1
    tracker = ProgressTracker()
    repo = Mock()
    release = asyncio.Event()
    entered = 0
    async def download(url, output_path, **kwargs):
        nonlocal entered
        entered += 1
        await release.wait()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"audio")
        return output_path
    repo.download_source_audio = AsyncMock(side_effect=download)
    engine = DownloadEngine(repo, Mock(), Mock(), tracker, config, Mock())
    tasks = []
    for i in range(2):
        req = TrackDownloadRequest(youtube_url="https://youtube.com/watch?v=test", destination=tmp_path / str(i))
        tasks.append(asyncio.create_task(engine.download_multiple_tracks([req], progress_id=str(i))))
    await until(lambda: entered == 1 and tracker.get_progress("1") is not None)
    queued = tracker.get_progress("1").to_dict()
    assert queued["status"] == "queued" and queued["terminal"] is False
    assert not queued["active"]
    config.max_concurrent_jobs = 2
    config.job_limiter.wake()
    await until(lambda: entered == 2)
    release.set()
    results = await asyncio.gather(*tasks)
    assert all(r.success for batch in results for r in batch)
    assert tracker.get_progress("1").is_terminal


@pytest.mark.asyncio
async def test_cancelled_waiter_and_track_do_not_leak_capacity():
    limiter = CapacityLimiter(lambda: 1)
    entered, release = asyncio.Event(), asyncio.Event()
    async def work():
        async with limiter.slot():
            entered.set()
            await release.wait()
    first = asyncio.create_task(work())
    await entered.wait()
    second = asyncio.create_task(work())
    await until(lambda: bool(limiter._waiters))
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert limiter.active == 0 and not limiter._waiters
    async with limiter.slot():
        assert limiter.active == 1


def test_analysis_capacity_is_accepted_without_starting_a_pool(config):
    config.analysis_workers = 1
    repo = MusicRepository(config, Mock())
    config.analysis_workers = 3
    assert repo.scan_albums() == []
    assert not hasattr(repo.analysis, '_analysis_executor')


@pytest.mark.parametrize("case", CONTRACT["sources"])
def test_boot_sources_contract(tmp_path, monkeypatch, case):
    key = "KROBI_LOG_LEVEL"
    path = tmp_path / ".env"
    monkeypatch.setattr(env_sources, "ENV_KEYS", frozenset([key]) if case["env"] else frozenset())
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    if case["app"]:
        path.write_text(f"{key}=ERROR\n")
    assert env_sources.source(key, path) == case["out"]


@pytest.mark.parametrize("case", CONTRACT["machines"])
def test_machine_presets_and_suggestions_contract(config, tmp_path, monkeypatch, case):
    monkeypatch.setattr(machine.os, "cpu_count", lambda: case["cores"])
    monkeypatch.setattr(machine.os, "sched_getaffinity", lambda _: set(range(case["cores"])), raising=False)
    monkeypatch.setattr(machine.os, "sysconf", lambda name: case["memoryBytes"] if name == "SC_PHYS_PAGES" else 1)
    facts = machine.machine_facts(tmp_path)
    assert facts["suggestedPreset"] == case["preset"]
    monkeypatch.setattr(services, "machine_facts", lambda: facts)
    body = services.ServerConfigService(DependencyContainer(config)).describe()
    settings = {s["key"]: s for g in body["groups"] for s in g["settings"]}
    keys = ["KROBI_MAX_CONCURRENT_DOWNLOADS", "KROBI_MAX_CONCURRENT_JOBS", "KROBI_ANALYSIS_WORKERS"]
    assert [settings[k]["suggestedMax"] for k in keys] == case["suggestedMax"]
    assert facts["capacityPresets"] == {
        "light": {"KROBI_MAX_CONCURRENT_DOWNLOADS": 1, "KROBI_MAX_CONCURRENT_JOBS": 1},
        "normal": {"KROBI_MAX_CONCURRENT_DOWNLOADS": 2, "KROBI_MAX_CONCURRENT_JOBS": 2},
    }
    assert facts["presets"]["light"] == [1, 1, 1] and facts["presets"]["normal"] == [3, 2, 2]
    assert facts["presets"]["powerful"] == [6, 3, max(1, facts["cores"] - 1)]


def test_machine_honours_affinity_and_cgroup_limits(tmp_path, monkeypatch):
    monkeypatch.setattr(machine.os, "cpu_count", lambda: 32)
    monkeypatch.setattr(machine.os, "sched_getaffinity", lambda _: {0, 1, 2, 3}, raising=False)
    monkeypatch.setattr(machine.os, "sysconf", lambda name: 16_000_000_000 if name == "SC_PHYS_PAGES" else 1)
    (tmp_path / "cpu.max").write_text("200000 100000")
    (tmp_path / "memory.max").write_text("1500000000")
    facts = machine.machine_facts(tmp_path)
    assert facts["cores"] == 2 and facts["memoryBytes"] == 1_500_000_000
    assert facts["cpuLimit"] == 2 and facts["memoryLimitBytes"] == 1_500_000_000
    assert facts["suggestedPreset"] == "light"


def test_editor_timeout_new_name_wins_and_old_name_still_reads(config, monkeypatch):
    from app.config import ConfigManager
    monkeypatch.setenv("KROBI_DOWNLOAD_TIMEOUT", "42")
    monkeypatch.delenv("KROBI_EDITOR_RENDER_TIMEOUT", raising=False)
    assert ConfigManager.from_env().editor_render_timeout == 42
    monkeypatch.setenv("KROBI_EDITOR_RENDER_TIMEOUT", "123")
    assert ConfigManager.from_env().editor_render_timeout == 123


def test_download_limiter_is_shared_across_event_loops_and_threads():
    from concurrent.futures import ThreadPoolExecutor
    limiter = CapacityLimiter(lambda: 1)
    inside, release = threading.Event(), threading.Event()
    second_inside = threading.Event()
    async def first():
        async with limiter.slot():
            inside.set()
            await asyncio.to_thread(release.wait, 3)
    async def second():
        async with limiter.slot():
            second_inside.set()
    with ThreadPoolExecutor(max_workers=2) as executor:
        a = executor.submit(asyncio.run, first())
        assert inside.wait(3)
        b = executor.submit(asyncio.run, second())
        # Observe a registered waiter, then finish the first loop's work.
        import time
        deadline = time.monotonic() + 3
        while not limiter._waiters and time.monotonic() < deadline:
            time.sleep(0.001)
        assert limiter._waiters and not second_inside.is_set()
        release.set()
        a.result(timeout=3)
        b.result(timeout=3)
    assert second_inside.is_set() and limiter.active == 0
