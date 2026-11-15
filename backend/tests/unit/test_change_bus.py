"""Source debounce, privacy, bounded fanout and idle-work guarantees."""
import asyncio
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.infra.change_bus import ChangeBus, ChangeEvent, HelloEvent, SHARED_AREAS, revision_token, visible
from app.infra.changes import Changes
from app.infra.identity import Principal

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/change-events.json').read_text())
OWNER = Principal('owner-account', 'Owner', 'owner')
MEMBER = Principal('account-a', 'Member')


async def take(client, timeout=1):
    return await asyncio.wait_for(client.queue.get(), timeout)


@pytest.mark.asyncio
async def test_fifty_writes_are_one_nudge_after_first_write_window():
    changes = Changes()
    bus = ChangeBus(changes)
    client = bus.subscribe(OWNER)
    started = asyncio.get_running_loop().time()
    try:
        for i in range(50):
            changes.bump('playlists', [str(i)])
        seq, event = await take(client)
        elapsed = asyncio.get_running_loop().time() - started
        assert .45 <= elapsed < .9
        assert seq == 1 and event.rev == 50 and len(event.ids) == 50
        assert client.queue.empty()
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_window_never_extends_and_areas_debounce_independently():
    changes = Changes()
    bus = ChangeBus(changes, debounce=.12)
    client = bus.subscribe(OWNER)
    try:
        changes.bump('playlists')
        await asyncio.sleep(.08)
        changes.bump('playlists')
        changes.bump('config')
        _, event = await take(client, .08)
        assert event.area == 'playlists' and event.rev == 2
        _, event = await take(client)
        assert event.area == 'config'
    finally:
        await bus.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('count', [4, 5, 100])
async def test_id_cap_flushes_early_and_never_sends_partial_ids(count):
    changes = Changes()
    bus = ChangeBus(changes, debounce=10, id_cap=4)
    client = bus.subscribe(OWNER)
    try:
        changes.bump('playlists', (str(i) for i in range(count)))
        _, event = await take(client, .2)
        assert event.ids == ['0', '1', '2', '3'] if count == 4 else event.ids is None
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_merged_ids_hit_size_cap_and_unknown_ids_invalidate_whole_area():
    changes = Changes()
    bus = ChangeBus(changes, debounce=.03, id_cap=4)
    client = bus.subscribe(OWNER)
    try:
        changes.bump('playlists', ['a', 'b'])
        await asyncio.sleep(.005)
        changes.bump('playlists', ['c', 'd'])
        assert (await take(client))[1].ids == ['a', 'b', 'c', 'd']
        changes.bump('playlists', ['a'])
        changes.bump('playlists')
        assert (await take(client))[1].ids is None
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_member_hello_and_events_never_expose_another_account():
    changes = Changes()
    changes.bump('me:account-b')
    bus = ChangeBus(changes, debounce=.01)
    member, owner = bus.subscribe(MEMBER), bus.subscribe(OWNER, ['me:account-c'])
    try:
        assert 'me:account-b' not in member.hello.revisions
        assert member.hello.revisions['me:account-a'] == 0
        assert owner.hello.revisions['me:account-b'] == 1
        assert owner.hello.revisions['me:account-c'] == 0
        for area in ('me:account-b', 'me:account-a', 'library'):
            changes.bump(area)
        events = [(await take(member))[1].area for _ in range(2)]
        assert set(events) == {'me:account-a', 'library'}
        assert member.queue.empty()
        assert {(await take(owner))[1].area for _ in range(3)} == {'me:account-a', 'me:account-b', 'library'}
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_overflow_drops_only_slow_client_and_releases_queue():
    changes = Changes()
    bus = ChangeBus(changes, debounce=.001, queue_size=2)
    slow, fast = bus.subscribe(OWNER), bus.subscribe(MEMBER)
    try:
        ids = []
        for _ in range(4):
            changes.bump('library')
            ids.append((await take(fast))[0])
        assert slow.closed.is_set() and slow.queue.empty()
        assert not fast.closed.is_set() and bus.client_count == 1
        assert ids == sorted(set(ids))
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_oldest_connections_evicted_per_account_across_devices_then_globally():
    bus = ChangeBus(Changes(), principal_limit=2, total_limit=3)
    first = bus.subscribe(Principal('account-a', 'Device one', device_id='one'))
    second = bus.subscribe(Principal('account-a', 'Device two', device_id='two'))
    third = bus.subscribe(MEMBER)
    assert first.closed.is_set() and not second.closed.is_set()
    other = bus.subscribe(OWNER)
    last = bus.subscribe(Principal('account-b', 'Other'))
    assert second.closed.is_set()
    assert not any(c.closed.is_set() for c in (third, other, last))
    assert bus.client_count == 3
    await bus.close()
    assert all(c.closed.is_set() for c in (third, other, last))


@pytest.mark.asyncio
async def test_replacing_only_stream_keeps_listener():
    changes = Changes({'jobs': lambda: 1})
    bus = ChangeBus(changes, principal_limit=1, debounce=.01)
    first = bus.subscribe(OWNER)
    second = bus.subscribe(OWNER)
    try:
        changes.bump('config')
        assert first.closed.is_set()
        assert (await take(second))[1].area == 'config'
        assert changes._listeners
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_provider_change_requires_a_writer_bump():
    revision = [1, 2]
    changes = Changes({'library': lambda: tuple(revision)})
    bus = ChangeBus(changes, debounce=.01)
    client = bus.subscribe(OWNER)
    try:
        assert client.hello.revisions['library'] == revision_token((1, 2))
        revision[0] += 1
        await asyncio.sleep(.03)
        assert client.queue.empty()
        changes.bump('library', ['key'])
        event = (await take(client))[1]
        assert event.rev == revision_token((2, 2)) and event.ids == ['key']
        await asyncio.sleep(.03)
        assert client.queue.empty()
    finally:
        await bus.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('count', [1, 4, 32])
async def test_connected_idle_streams_call_no_providers_or_library_stats_for_five_minutes(config, monkeypatch, count):
    from app.dependencies import DependencyContainer

    container = DependencyContainer(config)
    changes, bus = container.changes, container.change_bus
    providers = {area: Mock(wraps=provider) for area, provider in changes._providers.items()}
    monkeypatch.setattr(changes, '_providers', providers)
    scans = container.get_music_repository().scans
    read_fresh = Mock(wraps=scans.read_fresh)
    monkeypatch.setattr(scans, 'read_fresh', read_fresh)
    clients = [bus.subscribe(Principal(f'account-{i}', 'Account')) for i in range(count)]
    # Hello snapshots read current revisions. Finish any startup publications
    # before measuring work caused by merely holding the streams open.
    await asyncio.sleep(.55)
    for client in clients:
        while not client.queue.empty():
            client.queue.get_nowait()
    for provider in providers.values():
        provider.reset_mock()
    read_fresh.reset_mock()
    original_stat = Path.stat
    stats = Mock()

    def stat(path, *args, **kwargs):
        # Helper binary discovery can finish on another thread after hello.
        # Count every probe of the music tree, independently of that setup I/O.
        if path.is_relative_to(config.base_music_dir):
            stats(path)
        return original_stat(path, *args, **kwargs)

    loop = asyncio.get_running_loop()
    started = loop.time()
    try:
        with monkeypatch.context() as clock:
            clock.setattr(Path, 'stat', stat)
            for seconds in range(1, 301):
                clock.setattr(loop, 'time', lambda seconds=seconds: started + seconds)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
            for provider in providers.values():
                provider.assert_not_called()
            read_fresh.assert_not_called()
            stats.assert_not_called()
            assert all(client.queue.empty() and not client.closed.is_set() for client in clients)
    finally:
        await bus.close()
        container.get_jobs().close()
    assert not changes._listeners


@pytest.mark.asyncio
async def test_threaded_writers_coalesce_before_waking_the_loop():
    changes = Changes()
    bus = ChangeBus(changes, debounce=.01)
    client = bus.subscribe(OWNER)
    try:
        await asyncio.to_thread(lambda: [changes.bump('config', ['key']) for _ in range(50)])
        assert (await take(client))[1].rev == 50
        assert client.queue.empty()
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_restart_changes_boot_id_and_reconnect_has_current_revision():
    changes = Changes()
    bus = ChangeBus(changes)
    client = bus.subscribe(MEMBER)
    boot_id = client.hello.bootId
    bus.unsubscribe(client)
    changes.bump('playlists')
    reconnected = bus.subscribe(MEMBER)
    assert reconnected.hello.bootId == boot_id
    assert reconnected.hello.revisions['playlists'] == 1
    await bus.close()
    restarted = ChangeBus(Changes())
    assert restarted.subscribe(MEMBER).hello.bootId != boot_id
    await restarted.close()


@pytest.mark.parametrize('case', CONTRACT['scope_cases'])
def test_shared_scope_cases(case):
    assert visible(Principal(case['user_id'], 'Account', case['role']), case['area']) == case['visible']


def test_contract_shapes_and_defaults():
    assert list(SHARED_AREAS) == CONTRACT['shared_areas']
    assert HelloEvent.model_validate(CONTRACT['hello']['data']).model_dump() == CONTRACT['hello']['data']
    for name in ('change', 'change_without_ids'):
        data = CONTRACT[name]['data']
        assert ChangeEvent.model_validate(data).model_dump(exclude_none=True) == data
    bus = ChangeBus(Changes())
    limits = CONTRACT['limits']
    assert (bus.debounce, bus.id_cap, bus.queue_size, bus.principal_limit, bus.total_limit) == (
        limits['debounce_seconds'], limits['id_cap'], limits['client_queue'], limits['streams_per_principal'],
        limits['streams_total'])


@pytest.mark.asyncio
async def test_default_total_limit_closes_oldest_of_thirty_three_accounts():
    bus = ChangeBus(Changes())
    clients = [bus.subscribe(Principal(f'account-{i}', 'Account')) for i in range(33)]
    assert clients[0].closed.is_set() and bus.client_count == 32
    assert not any(c.closed.is_set() for c in clients[1:])
    await bus.close()


@pytest.mark.asyncio
async def test_cap_overflow_with_duplicate_ids_does_not_send_an_incomplete_hint():
    changes = Changes()
    bus = ChangeBus(changes, id_cap=4, debounce=10)
    client = bus.subscribe(OWNER)
    try:
        changes.bump('library', ['same'] * 10 + ['different'])
        assert (await take(client, .2))[1].ids is None
    finally:
        await bus.close()


@pytest.mark.asyncio
async def test_snapshot_failure_unregisters_listener_and_allows_new_connection():
    provider = Mock(side_effect=ValueError('unavailable'))
    changes = Changes({'library': provider})
    bus = ChangeBus(changes)
    with pytest.raises(ValueError):
        bus.subscribe(OWNER)
    assert bus.client_count == 0 and not changes._listeners
    provider.side_effect = None
    provider.return_value = 1
    bus.subscribe(OWNER)
    await bus.close()


@pytest.mark.asyncio
async def test_flush_revision_failure_drops_clients_to_force_resync():
    provider = Mock(return_value=1)
    changes = Changes({'library': provider})
    bus = ChangeBus(changes, debounce=.01)
    client = bus.subscribe(OWNER)
    provider.side_effect = ValueError('unavailable')
    changes.bump('library')
    await asyncio.wait_for(client.closed.wait(), .2)
    assert bus.client_count == 0


@pytest.mark.asyncio
async def test_provider_projections_never_expose_secrets_or_state_in_hello_or_nudges():
    source = {'secret': 'test-only-private-value', 'setting': 1}
    changes = Changes({'config': lambda: (4, source)})
    bus = ChangeBus(changes, debounce=.01)
    client = bus.subscribe(MEMBER)
    try:
        first = client.hello.revisions['config']
        assert isinstance(first, str) and len(first) == 64
        assert 'test-only-private-value' not in client.hello.model_dump_json()
        source['setting'] = 2
        changes.bump('config')
        event = (await take(client))[1]
        assert event.rev != first and len(event.rev) == 64
        assert 'test-only-private-value' not in event.model_dump_json()
    finally:
        await bus.close()
