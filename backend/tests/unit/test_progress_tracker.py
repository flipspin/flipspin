"""Unit tests for ProgressTracker."""
import pytest
import time
from app.infra.progress import ProgressTracker


@pytest.fixture
def progress_tracker():
    """Create ProgressTracker instance."""
    return ProgressTracker()


def test_create_progress(progress_tracker):
    """Test creating progress entry."""
    progress_id = "test-123"
    
    progress_tracker.create_progress(progress_id, total=10)
    progress = progress_tracker.get_progress(progress_id)
    
    assert progress is not None
    progress_dict = progress.to_dict()
    assert progress_dict["total"] == 10
    assert progress_dict["completed"] == 0
    assert progress_dict["status"] == "in_progress"


def test_update_progress(progress_tracker):
    """Test updating progress."""
    progress_id = "test-123"
    
    progress_tracker.create_progress(progress_id, total=10)
    progress_tracker.update_progress(progress_id, "item1")
    progress_tracker.update_progress(progress_id, "item2")
    
    progress = progress_tracker.get_progress(progress_id)
    progress_dict = progress.to_dict()
    
    assert progress_dict["completed"] == 2
    assert progress_dict["percentage"] == 20.0


def test_complete_progress(progress_tracker):
    """Test completing progress."""
    progress_id = "test-123"
    
    progress_tracker.create_progress(progress_id, total=10)
    progress_tracker.complete_progress(progress_id)
    
    progress = progress_tracker.get_progress(progress_id)
    progress_dict = progress.to_dict()
    
    assert progress_dict["status"] == "done"


def test_get_nonexistent_progress(progress_tracker):
    """Test getting non-existent progress."""
    progress = progress_tracker.get_progress("nonexistent")
    assert progress is None


def test_cleanup_old_progress(progress_tracker):
    """Test cleanup of old progress entries."""
    progress_id = "test-123"
    
    progress_tracker.create_progress(progress_id, total=10)
    progress_tracker.complete_progress(progress_id)
    
    # Manually set old timestamp to trigger cleanup (25 hours ago)
    if progress_id in progress_tracker._progress:
        progress_tracker._progress[progress_id].created_at = time.time() - (25 * 3600)
    
    # Trigger cleanup with default 24 hour threshold
    removed = progress_tracker.cleanup_old_progress()
    
    # Should have removed 1 entry
    assert removed == 1
    
    # Progress should be removed
    progress = progress_tracker.get_progress(progress_id)
    assert progress is None


def test_version_advances_on_observable_changes(progress_tracker):
    """Every observable mutation bumps the change version; no-ops don't."""
    v0 = progress_tracker.current_version()

    progress_tracker.create_progress("p", total=2)
    v1 = progress_tracker.current_version()
    assert v1 > v0

    progress_tracker.update_progress("p", "a")
    v2 = progress_tracker.current_version()
    assert v2 > v1

    # Re-adding the same item is a no-op → no version bump.
    progress_tracker.update_progress("p", "a")
    assert progress_tracker.current_version() == v2

    progress_tracker.complete_progress("p", "done")
    assert progress_tracker.current_version() > v2


def test_wait_for_change_wakes_on_update(progress_tracker):
    """A subscriber blocked in wait_for_change is woken by a mutation."""
    import threading

    progress_tracker.create_progress("p", total=2)
    start = progress_tracker.current_version()

    def do_update():
        time.sleep(0.05)
        progress_tracker.update_progress("p", "a")

    thread = threading.Thread(target=do_update)
    thread.start()
    try:
        # Generous timeout: the update should wake us well before it elapses.
        new_version = progress_tracker.wait_for_change(start, timeout=5.0)
    finally:
        thread.join()

    assert new_version > start


def test_wait_for_change_times_out_without_change(progress_tracker):
    """With no change, wait_for_change returns the same version after the timeout."""
    progress_tracker.create_progress("p", total=2)
    version = progress_tracker.current_version()

    result = progress_tracker.wait_for_change(version, timeout=0.05)

    assert result == version


def test_terminal_flag_in_state_and_dict(progress_tracker):
    """is_terminal / to_dict['terminal'] flips once status leaves 'in_progress'."""
    progress_tracker.create_progress("p", total=1)
    state = progress_tracker.get_progress("p")
    assert state.is_terminal is False
    assert state.to_dict()["terminal"] is False

    # A human summary (not literally "done") still counts as terminal.
    progress_tracker.complete_progress("p", "Downloaded 1/1 tracks")
    state = progress_tracker.get_progress("p")
    assert state.is_terminal is True
    assert state.to_dict()["terminal"] is True


def test_set_total_resizes_entry_and_bumps(progress_tracker):
    """set_total updates an entry created before its size was known (playlist import)."""
    progress_tracker.create_progress("p", total=0)
    v0 = progress_tracker.current_version()

    progress_tracker.set_total("p", 7)

    assert progress_tracker.get_progress("p").total == 7
    assert progress_tracker.current_version() > v0


def test_set_total_noop_when_unchanged_or_unknown(progress_tracker):
    """No bump when the total is identical, and an unknown id is a silent no-op."""
    progress_tracker.create_progress("p", total=5)
    v0 = progress_tracker.current_version()
    progress_tracker.set_total("p", 5)  # same value → no change
    assert progress_tracker.current_version() == v0

    progress_tracker.set_total("nope", 3)  # unknown id → no raise, nothing created
    assert progress_tracker.get_progress("nope") is None


def test_set_track_phase_records_phase_and_percent(progress_tracker):
    """set_track_phase records per-item sub-state and surfaces it in to_dict."""
    progress_tracker.create_progress("p", total=2)

    progress_tracker.set_track_phase("p", "Song A", "downloading", percent=47.6)

    state = progress_tracker.get_progress("p")
    assert state.active == {"Song A": {"phase": "downloading", "percent": 48}}
    assert state.to_dict()["active"] == {"Song A": {"phase": "downloading", "percent": 48}}


def test_set_track_phase_only_bumps_on_real_change(progress_tracker):
    """Repeated identical sub-state (e.g. same rounded percent) doesn't bump."""
    progress_tracker.create_progress("p", total=1)

    progress_tracker.set_track_phase("p", "Song A", "downloading", percent=10.2)
    v1 = progress_tracker.current_version()
    # Same rounded percent → no change → no bump.
    progress_tracker.set_track_phase("p", "Song A", "downloading", percent=10.4)
    assert progress_tracker.current_version() == v1
    # A real change does bump.
    progress_tracker.set_track_phase("p", "Song A", "downloading", percent=11.0)
    assert progress_tracker.current_version() > v1


def test_completing_item_clears_it_from_active(progress_tracker):
    """update_progress moves an item out of the in-flight set into done."""
    progress_tracker.create_progress("p", total=2)
    progress_tracker.set_track_phase("p", "Song A", "downloading", percent=80)
    progress_tracker.set_track_phase("p", "Song B", "searching")

    progress_tracker.update_progress("p", "Song A")

    state = progress_tracker.get_progress("p")
    assert "Song A" not in state.active
    assert "Song A" in state.done
    assert "Song B" in state.active  # other in-flight item untouched


def test_set_track_phase_unknown_id_is_noop(progress_tracker):
    """set_track_phase on an unknown id does nothing and doesn't raise."""
    progress_tracker.set_track_phase("nope", "Song A", "downloading", percent=5)
    assert progress_tracker.get_progress("nope") is None


def test_thread_safety(progress_tracker):
    """Test thread-safe operations."""
    import threading
    
    progress_id = "test-123"
    progress_tracker.create_progress(progress_id, total=100)
    
    def update_progress():
        for i in range(10):
            progress_tracker.update_progress(progress_id, f"item{i}")
    
    # Create multiple threads
    threads = [threading.Thread(target=update_progress) for _ in range(5)]
    
    # Start all threads
    for thread in threads:
        thread.start()
    
    # Wait for completion
    for thread in threads:
        thread.join()
    
    # Progress should still be valid
    progress = progress_tracker.get_progress(progress_id)
    assert progress is not None
    progress_dict = progress.to_dict()
    assert progress_dict["total"] == 100


def test_snapshots_are_detached_from_concurrent_updates(progress_tracker):
    from concurrent.futures import ThreadPoolExecutor

    tracker = progress_tracker
    tracker.create_progress('p', 400)
    tracker.set_track_phase('p', 'first', 'fetching', 10)
    tracker.add_failure('p', {'index': 0, 'alternatives': [{'title': 'other'}]})
    frozen = tracker.get_progress('p')
    listing = tracker.list_all_progress()
    before = frozen.to_dict()

    def produce():
        for index in range(400):
            item = str(index)
            tracker.set_track_phase('p', item, 'fetching', index % 100)
            tracker.update_progress('p', item)
        tracker.complete_progress('p', succeeded=400, failed=0)

    with ThreadPoolExecutor(max_workers=1) as pool:
        producer = pool.submit(produce)
        for _ in range(400):
            snapshot = tracker.get_progress('p').to_dict()
            assert snapshot['completed'] == len(snapshot['items'])
            assert snapshot['percentage'] == round(len(snapshot['items']) / 400 * 100, 2)
            assert not set(snapshot['active']).intersection(snapshot['items'])
            if snapshot['terminal']:
                assert (snapshot['succeeded'], snapshot['failed']) == (400, 0)
        producer.result(timeout=3)
    assert frozen.to_dict() == before
    assert listing[0].to_dict() == before
    frozen.failures[0]['alternatives'][0]['title'] = 'changed'
    assert tracker.get_progress('p').failures[0]['alternatives'][0]['title'] == 'other'
    payload = frozen.to_dict()
    payload['items'].append('changed')
    assert frozen.done == []


@pytest.mark.asyncio
async def test_async_wait_wakes_from_thread_and_cleans_up(progress_tracker):
    import asyncio

    tracker = progress_tracker
    tracker.create_progress('p', 1)
    version = tracker.current_version()
    pending = asyncio.create_task(tracker.wait_for_change_async(version, timeout=1))
    await asyncio.sleep(0)
    await asyncio.to_thread(tracker.update_progress, 'p', 'song')
    assert await asyncio.wait_for(pending, 1) > version
    assert not tracker._async_waiters
    # A mutation before registration must not get lost.
    assert await tracker.wait_for_change_async(version, timeout=1) > version
    version = tracker.current_version()
    assert await tracker.wait_for_change_async(version, timeout=0.001) == version
    pending = asyncio.create_task(tracker.wait_for_change_async(version))
    await asyncio.sleep(0)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert not tracker._async_waiters
