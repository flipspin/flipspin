"""Writer commits drive stream nudges without provider polling."""
import asyncio
from unittest.mock import Mock

import pytest

from app.dependencies import DependencyContainer
from app.domains.helpers.mac_worker import AGENT_ONLINE_S, WorkerRecord
from app.infra.change_bus import revision_token
from app.infra.identity import Principal

OWNER = Principal('owner-account', 'Owner', 'owner')
AGENT = {'id': 'helper', 'sessionId': 'session', 'name': 'Helper', 'version': '0.10.0'}


@pytest.fixture
def writers(config, monkeypatch):
    container = DependencyContainer(config)
    music = container.get_music_repository()
    ledger = container.get_jobs()
    clock = [100.0]
    worker = WorkerRecord(now=lambda: clock[0], changes=container.changes)
    # Keep the real writer composition; isolate the projections so tests measure
    # notification latency independently of unrelated feature initialization.
    monkeypatch.setattr(container.changes, '_providers', {
        'library': container._library_revision,
        'analysis': lambda: music.analysis.revision,
        'jobs': lambda: (ledger.version, container.changes.counter('jobs')),
        'helpers': lambda: (container.changes.counter('helpers'), worker.expiry_revision()),
    })
    yield container, music, ledger, worker, clock
    ledger.close()


async def nudges(client, count=1):
    started = asyncio.get_running_loop().time()
    events = [await asyncio.wait_for(client.queue.get(), .9) for _ in range(count)]
    # The default debounce is 500 ms. No provider watcher exists to wake us.
    assert .4 <= asyncio.get_running_loop().time() - started < .9
    return {event.area: event for _, event in events}


@pytest.mark.asyncio
@pytest.mark.parametrize('targeted', [False, True])
async def test_scan_publication_nudges_within_debounce(writers, monkeypatch, targeted):
    container, music, *_ = writers
    path = music.config.base_music_dir / 'Album' / 'song.mp3'
    path.parent.mkdir()
    path.write_bytes(b'audio')
    monkeypatch.setattr('app.domains.music.repositories.MutagenFile', lambda path: None)
    bus = container.change_bus
    client = bus.subscribe(OWNER)
    try:
        publish = (lambda: music.scans.refresh_folders({path.parent})) if targeted else music.refresh
        await asyncio.to_thread(publish)
        event = (await nudges(client))['library']
        assert event.rev == revision_token(1)
        assert container.changes.counter('library') == 1
        if not targeted:
            await asyncio.to_thread(music.refresh)
            assert client.queue.empty()
            assert not bus._pending and not bus._inbox
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_analysis_commit_nudges_after_visible_data_is_committed(writers):
    container, music, *_ = writers
    bus = container.change_bus
    client = bus.subscribe(OWNER)
    committed = []
    unlisten = container.changes.listen(lambda area, ids: committed.append(music.analysis.get('Album/song.mp3'))
                                         if area == 'analysis' else None)
    try:
        assert music.analysis.fix('Album/song.mp3', 0, {'bpm': 123}, 'owner')
        event = (await nudges(client))['analysis']
        assert event.rev == music.analysis.revision > 0
        assert committed[0]['fixed_bpm'] == 123
        # No-op writes and bookkeeping commits must not notify.
        with music.analysis.connection() as db:
            db.execute("UPDATE track_analysis SET fixed_bpm=123")
            db.execute("INSERT INTO meta VALUES ('bookkeeping', 'one')")
        with pytest.raises(ValueError), music.analysis.connection() as db:
            db.execute('UPDATE track_analysis SET fixed_bpm=456')
            raise ValueError('rollback')
        assert music.analysis.get('Album/song.mp3')['fixed_bpm'] == 123
        assert len(committed) == 1 and client.queue.empty()
        assert not bus._pending and not bus._inbox
    finally:
        unlisten()
        await bus.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('write', ['start', 'touch', 'phase', 'coalesced_phase'])
async def test_ledger_writer_callback_nudges_within_debounce(writers, write):
    container, _, ledger, *_ = writers
    if write == 'coalesced_phase':
        ledger.now = lambda: 100
        ledger.phase_changed()
    bus = container.change_bus
    client = bus.subscribe(OWNER)
    before = ledger.version
    try:
        if write == 'start':
            ledger.start('download', 'Song', ['Song'])
        elif write == 'touch':
            ledger.touch()
        else:
            ledger.phase_changed()
        event = (await nudges(client))['jobs']
        assert ledger.version == before if write == 'coalesced_phase' else ledger.version > before
        assert event.rev == revision_token(container.changes.revision('jobs'))
    finally:
        await bus.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('transition', ['seen', 'touch', 'bye', 'revoke', 'working', 'finished'])
async def test_helper_writers_nudge_helpers_and_jobs(writers, transition):
    container, _, _, worker, _ = writers
    worker.seen(AGENT)
    if transition == 'finished':
        worker.working('job', 'helper', 'Song', 'analysis')
    bus = container.change_bus
    client = bus.subscribe(OWNER)
    try:
        if transition == 'seen':
            worker.seen({**AGENT, 'state': 'working'})  # a visible change; a bare repeat check-in is silent
        elif transition == 'bye':
            worker.bye('helper', 'sleep')
        elif transition == 'working':
            worker.working('job', 'helper', 'Song', 'analysis')
        elif transition == 'finished':
            worker.finished('job')
        elif transition == 'touch':
            worker.bye('helper', 'sleep')
            await nudges(client, 2)
            worker.touch('helper')  # waking from sleep is visible
        else:
            getattr(worker, transition)('helper')
        assert set(await nudges(client, 2)) == {'helpers', 'jobs'}
    finally:
        await bus.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('expiry', ['presence', 'job'])
async def test_helper_expiry_nudges_only_from_throttled_reap(writers, expiry):
    container, _, _, worker, clock = writers
    worker.seen(AGENT)
    worker.reap()
    if expiry == 'job':
        worker.working('job', 'helper', 'Song', 'analysis', ttl=1)
    else:
        clock[0] += AGENT_ONLINE_S - 30
        worker.reap()
    next_reap = clock[0] + 60
    reaper = Mock()
    worker.register_reap(reaper)
    bus = container.change_bus
    client = bus.subscribe(OWNER)
    try:
        clock[0] += 31 if expiry == 'presence' else 2
        worker.reap()
        reaper.assert_not_called()  # Both expirations occur inside the throttle.
        assert client.queue.empty() and not bus._inbox
        clock[0] = next_reap
        worker.reap()
        reaper.assert_called_once()
        assert set(await nudges(client, 2)) == {'helpers', 'jobs'}
        worker.maintain()
        reaper.assert_called_once()
        clock[0] += 60
        worker.reap()
        assert reaper.call_count == 2
        if expiry == 'job':
            # The helper itself goes offline on this later maintenance pass.
            assert set(await nudges(client, 2)) == {'helpers', 'jobs'}
            clock[0] += 60
            worker.reap()
        assert client.queue.empty() and not bus._inbox
    finally:
        await bus.close()
