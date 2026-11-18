"""Persistent incremental discovery, publication and bounded work."""
import logging
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.domains.music.repositories import MusicRepository
from app.domains.music.scan_worker import ScanWorker
from app.domains.music.scan_watch import LibraryWatch


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / 'Music'
    root.mkdir()
    config = SimpleNamespace(base_music_dir=root, analysis_db=tmp_path / 'analysis.sqlite')
    return MusicRepository(config, logging.getLogger('test.library.scan'))


def song(repo, folder='Album', name='song.mp3'):
    path = repo.config.base_music_dir / folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'audio')
    return path


def test_restart_reuses_folder_signatures_and_tag_memos(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags:
        first = repo.refresh()
        assert tags.call_count == 1
        first_seen = repo.scans.store.first_seen([path])
        assert len(first_seen) == 1
        restarted = MusicRepository(repo.config, repo.logger)
        assert restarted.scans.read() == first
        with patch.object(restarted, 'build_album', wraps=restarted.build_album) as build:
            assert restarted.refresh() == first
        assert build.call_count == 0
        assert tags.call_count == 1
        assert restarted.scans.store.first_seen([path]) == first_seen
        # A direct file read after restart also uses the durable memo.
        restarted.read_tags(path)
        assert tags.call_count == 1
    with restarted.scans.store.connection() as db:
        assert db.execute('SELECT count(*) FROM folders').fetchone()[0] == 2
        assert db.execute('SELECT count(*) FROM tags').fetchone()[0] == 1


def test_in_place_retag_only_rebuilds_its_folder(repo):
    changed = song(repo, 'One')
    song(repo, 'Two')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags:
        before = repo.refresh()
        changed.write_bytes(b'changed in place')
        with patch.object(repo, 'build_album', wraps=repo.build_album) as build:
            after = repo.refresh()
        assert build.call_count == 1
        assert tags.call_count == 3
        assert after[1] is before[1]


def test_image_changes_and_discs_invalidate_the_owning_album(repo):
    song(repo, 'Album/CD1')
    song(repo, 'Other')
    cover = repo.config.base_music_dir / 'Album' / 'cover' / 'cover.jpg'
    cover.parent.mkdir()
    cover.write_bytes(b'image')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags:
        repo.refresh()
        cover.write_bytes(b'new image')
        with patch.object(repo, 'build_album', wraps=repo.build_album) as build:
            assert repo.refresh()[0].cover_art == cover
        assert build.call_count == 1
        assert tags.call_count == 2
        (repo.config.base_music_dir / 'Album' / 'CD1' / 'song.mp3').unlink()
        assert [a.path.name for a in repo.refresh()] == ['Other']


def test_full_rescan_ignores_persisted_signatures_and_file_memos(repo):
    song(repo, 'One')
    song(repo, 'Two')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags:
        repo.refresh()
        restarted = MusicRepository(repo.config, repo.logger)
        restarted.refresh(full=True, reason='owner-full')
        assert tags.call_count == 4


def test_unrelated_db_writes_and_single_file_reads_do_not_invalidate_listing(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        first = repo.refresh()
        revision = repo.analysis.revision
        with repo.analysis.connection() as db:
            db.execute("INSERT INTO meta VALUES ('background-bookkeeping', 'one')")
        other = path.parent / 'sample.txt'
        other.write_bytes(b'not audio')
        repo.read_tags(other)
        assert repo.analysis.revision == revision
        assert repo.refresh() is first
        assert repo.tag_revision == 1
        assert path.exists()


def test_analysis_projection_is_batched_and_keeps_file_reads_out(repo):
    song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    before = repo.analysis.revision
    with repo.analysis.connection() as db:
        db.execute("INSERT INTO track_analysis (rel_path, fixed_bpm) VALUES ('Album/song.mp3', 123)")
    assert repo.analysis.revision > before
    with patch.object(repo.analysis, 'get', side_effect=AssertionError('per-track query')), \
         patch.object(repo.analysis, 'tag_fields', side_effect=AssertionError('per-track query')), \
         patch.object(repo, 'read_tags', side_effect=AssertionError('file read')):
        assert repo.refresh()[0].tracks[0].bpm == 123
    before = repo.analysis.revision
    with repo.analysis.connection() as db:
        db.execute("UPDATE track_analysis SET fixed_bpm=123")
    assert repo.analysis.revision == before
    with repo.analysis.connection() as db:
        db.execute("UPDATE track_analysis SET missing_since='2026-01-01'")
    assert repo.analysis.revision > before


def test_absent_empty_and_unreadable_roots_keep_snapshot_and_corrections(repo):
    path = song(repo)
    repo.analysis.fix('Album/song.mp3', 0, {'bpm': 123}, 'owner')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        first = repo.refresh()
    path.unlink()
    assert repo.refresh() is first
    assert repo.scans.error == 'empty'
    root = repo.config.base_music_dir
    root.rename(root.with_name('offline'))
    assert repo.refresh() is first
    assert repo.scans.error == 'unavailable'
    assert repo.analysis.get('Album/song.mp3')['fixed_bpm'] == 123
    root.with_name('offline').rename(root)
    path.write_bytes(b'returned')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        assert repo.refresh()[0].tracks[0].bpm == 123


def test_failed_folder_read_retains_the_last_good_snapshot(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        first = repo.refresh()
    path.write_bytes(b'changed')
    with patch.object(repo, 'build_album', side_effect=OSError('transient')):
        with pytest.raises(Exception, match='transient'):
            repo.refresh()
    assert repo.scans.read() is first
    assert repo.scans.error == 'failed'
    restarted = MusicRepository(repo.config, repo.logger)
    assert restarted.scans.read() == first


def test_one_info_line_per_real_scan_includes_reason_and_duration(repo, caplog):
    song(repo)
    with caplog.at_level(logging.INFO), patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh(reason='startup')
        for _ in range(3):
            repo.refresh(reason='periodic')
            repo.refresh(reason='mutation')
        repo.refresh(reason='owner-changes')
    lines = [r.message for r in caplog.records if r.message.startswith('Library scan ')]
    assert len(lines) == 2
    assert 'reason=startup' in lines[0] and 'duration=' in lines[0]
    assert 'reason=owner-changes' in lines[1] and 'folders=0' in lines[1]


def test_requests_read_snapshot_without_calling_discovery(repo):
    song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        first = repo.refresh()
    repo.scans.worker = ScanWorker(repo)
    repo.scans.worker.watch.root = repo.config.base_music_dir
    repo.scans.worker.watch.observer = SimpleNamespace(is_alive=lambda: True, emitters=())
    with patch.object(repo.scans, 'read_fresh', side_effect=AssertionError('request freshness check')), \
         patch('app.domains.music.library_scan.discover', side_effect=AssertionError('request scan')):
        for _ in range(100):
            assert repo.scan_albums() is first
            repo.invalidate_scan()
    assert repo.scans.worker.status()['pending']


def test_worker_coalesces_bursts_and_full_rescan_wins(repo):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def refresh(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
    worker = ScanWorker(repo, interval=60, debounce=0.01)
    with patch.object(repo, 'refresh', side_effect=refresh), patch.object(worker.watch, 'follow'):
        worker.start()
        try:
            assert entered.wait(5)
            for _ in range(100):
                worker.request('mutation')
            worker.request('owner-full', full=True)
            release.set()
            with worker.condition:
                assert worker.condition.wait_for(lambda: len(calls) == 2 and not worker.running, 5)
            assert calls[1]['full'] is True
            assert 'owner-full' in calls[1]['reason']
        finally:
            release.set()
            worker.stop()
    assert len(calls) == 2
    assert calls[0]['reason'] == 'startup' and calls[0]['full'] is True


def test_watch_filters_read_events_and_detects_moved_audio(repo):
    worker = Mock()
    watch = LibraryWatch(worker)
    for kind in ('opened', 'closed', 'closed_no_write'):
        watch.on_any_event(SimpleNamespace(event_type=kind, is_directory=False, src_path='song.mp3'))
    watch.on_any_event(SimpleNamespace(event_type='modified', is_directory=False, src_path='lyrics.lrc'))
    worker.request.assert_not_called()
    watch.on_any_event(SimpleNamespace(event_type='moved', is_directory=False, src_path='temp.part', dest_path='song.mp3'))
    worker.request.assert_called_once_with('filesystem')


def test_root_change_never_serves_previous_root(repo, tmp_path):
    song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    repo.scans.worker = ScanWorker(repo)
    repo.config.base_music_dir = tmp_path / 'Other'
    repo.config.base_music_dir.mkdir()
    assert repo.scan_albums() == []
    assert repo.scans.root == repo.config.base_music_dir
    assert repo.scan_albums() == []


def test_explicit_delete_of_last_song_publishes_an_empty_library(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    path.unlink()
    repo.forget_file(path)
    assert repo.refresh() == []
    assert repo.scans.error is None


def test_interrupted_full_rescan_resumes_as_full_after_restart(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    worker = ScanWorker(repo)
    worker.request('owner-full', full=True)
    assert repo.scans.store.full_pending(repo.config.base_music_dir)
    restarted = MusicRepository(repo.config, repo.logger)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as reads:
        restarted.refresh(reason='startup')
        assert reads.call_count == 1
        assert restarted.scans.read()[0].tracks[0].path == path
    assert not restarted.scans.store.full_pending(repo.config.base_music_dir)


def test_watch_failure_falls_back_without_failing_a_scan(repo, caplog):
    worker = ScanWorker(repo)
    with patch('app.domains.music.scan_watch.Observer', side_effect=OSError('not supported')):
        worker.watch.follow(repo.config.base_music_dir)
    assert worker.watch.observer is None
    assert 'checking for changes every five minutes' in caplog.text


@pytest.mark.parametrize('stage', ['construct', 'schedule', 'start'])
def test_system_error_in_watcher_keeps_startup_and_periodic_scans(repo, caplog, stage):
    worker = ScanWorker(repo, interval=0.01, debounce=0.001)
    calls = []

    def refresh(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            with worker.condition:
                worker.stopping = True

    observer = Mock()
    factory = Mock(return_value=observer)
    failing = factory if stage == 'construct' else getattr(observer, stage)
    failing.side_effect = SystemError('native watcher failed')
    with patch('app.domains.music.scan_watch.Observer', factory), patch.object(repo, 'refresh', side_effect=refresh):
        worker.start()
        try:
            with worker.condition:
                assert worker.condition.wait_for(lambda: worker.stopping and not worker.running, 2)
            assert calls == [{'reason': 'startup', 'full': True}, {'reason': 'periodic', 'full': False}]
            assert worker.interval == worker.fallback_interval
            assert worker.watch.observer is None
            assert worker.watch.failures not in logging.getLogger('watchdog').handlers
            assert 'native watcher failed' in caplog.text
            if stage != 'construct':
                assert observer.stop.called
        finally:
            worker.stop()


def test_periodic_timer_runs_without_filesystem_events(repo):
    completed = threading.Event()
    calls = []
    def refresh(**kwargs):
        calls.append(kwargs['reason'])
        if len(calls) == 2:
            completed.set()
    worker = ScanWorker(repo, interval=0.01, debounce=0.001)
    with patch.object(repo, 'refresh', side_effect=refresh), patch.object(worker.watch, 'follow'):
        worker.start()
        try:
            assert completed.wait(5)
        finally:
            worker.stop()
    assert calls[:2] == ['startup', 'periodic']


@pytest.mark.parametrize('alive,current,interval', [(True, True, 1800), (False, True, 300), (True, False, 300)])
def test_effective_interval_follows_observer_liveness_and_root_without_stats(repo, alive, current, interval):
    worker = repo.scans.worker = ScanWorker(repo)
    worker.watch.root = repo.config.base_music_dir if current else repo.config.base_music_dir / 'old'
    worker.watch.observer = SimpleNamespace(is_alive=lambda: alive, emitters=())
    with patch('pathlib.Path.stat', side_effect=AssertionError('liveness must not stat')):
        assert worker.interval == interval
        assert repo.scans.status()['intervalSeconds'] == interval
        assert repo.scans.status()['watching'] is (alive and current)


def test_dead_emitter_uses_fallback_even_if_dispatcher_is_alive(repo):
    worker = repo.scans.worker = ScanWorker(repo)
    worker.watch.root = repo.config.base_music_dir
    worker.watch.observer = SimpleNamespace(is_alive=lambda: True,
                                           emitters=(SimpleNamespace(is_alive=lambda: False),))
    assert worker.interval == 300
    assert not repo.scans.watching()


@pytest.mark.parametrize('alive,elapsed', [(True, 1800), (False, 300)])
def test_periodic_wait_uses_effective_interval(repo, alive, elapsed):
    worker = ScanWorker(repo)
    worker.watch.root = repo.config.base_music_dir
    worker.watch.observer = SimpleNamespace(is_alive=lambda: alive, emitters=())
    clock, passes = [0.0], []

    def refresh(**kwargs):
        passes.append((clock[0], kwargs))
        worker.stopping = True

    def wait(seconds):
        clock[0] += seconds

    with patch('app.domains.music.scan_worker.time.monotonic', side_effect=lambda: clock[0]), \
         patch.object(worker.condition, 'wait', side_effect=wait), \
         patch.object(worker.watch, 'follow'), patch.object(repo, 'refresh', side_effect=refresh):
        worker.run()
    assert passes == [(elapsed, {'reason': 'periodic', 'full': False})]


@pytest.mark.parametrize('message,reason', [('Inotify queue overflowed; reconciling recursive watches', 'watcher-overflow'),
                                         ('Unable to rebuild recursive inotify watches', 'watcher-failed')])
def test_watchdog_reports_force_a_full_pass_and_unregister_on_stop(repo, message, reason):
    worker = ScanWorker(repo, debounce=.001)
    calls, done = [], threading.Event()
    logger = logging.getLogger('watchdog.observers.inotify')

    def refresh(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            logger.log(logging.WARNING if reason == 'watcher-overflow' else logging.ERROR, message)
        else:
            done.set()

    # Exercise the pinned watchdog's actual reporting channel, including lifecycle.
    with patch('app.domains.music.scan_watch.Observer'), patch.object(repo, 'refresh', side_effect=refresh):
        worker.start()
        try:
            assert done.wait(5)
        finally:
            worker.stop()
    assert calls == [{'reason': 'startup', 'full': True}, {'reason': reason, 'full': True}]
    assert worker.watch.failures not in logging.getLogger('watchdog').handlers


def test_watchdog_recovery_does_not_depend_on_application_log_level(repo):
    worker = ScanWorker(repo)
    logger = logging.getLogger('watchdog')
    original_level = logger.level
    with patch.object(logging.getLogger(), 'level', logging.CRITICAL):
        worker.watch.failures.start()
        try:
            logging.getLogger('watchdog.observers.inotify').warning('Inotify queue overflowed')
            assert worker.pending == {'watcher-overflow'}
            assert worker.full
        finally:
            worker.watch.failures.stop()
    assert logger.level == original_level


def test_dead_observer_triggers_a_full_recovery_pass(repo):
    worker = ScanWorker(repo)
    alive, passes = [True], []
    worker.pending.add('startup')
    worker.full = True
    worker.watch.root = repo.config.base_music_dir
    worker.watch.observer = SimpleNamespace(is_alive=lambda: alive[0], emitters=())

    def refresh(**kwargs):
        passes.append(kwargs)
        if len(passes) == 2:
            worker.stopping = True

    def wait(seconds):
        alive[0] = False

    with patch.object(worker.condition, 'wait', side_effect=wait), \
         patch.object(worker.watch, 'follow'), patch.object(repo, 'refresh', side_effect=refresh):
        worker.run()
    assert passes == [{'reason': 'startup', 'full': True}, {'reason': 'watcher-failed', 'full': True}]


def test_manual_copy_is_published_by_native_watcher_with_existing_debounce(repo):
    published = threading.Event()
    original = repo.refresh

    def refresh(**kwargs):
        albums = original(**kwargs)
        if any(t.path.name == 'manual.mp3' for a in albums for t in a.tracks):
            published.set()
        return albums

    worker = repo.scans.worker = ScanWorker(repo, debounce=.001)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None), \
         patch.object(repo, 'refresh', side_effect=refresh):
        worker.start()
        try:
            with worker.condition:
                assert worker.condition.wait_for(lambda: repo.scans.generation == 1 and not worker.running, 5)
            assert worker.watch.following(repo.config.base_music_dir)
            path = song(repo, name='manual.mp3')
            assert published.wait(10)
            assert repo.scan_albums()[0].tracks[0].path == path
        finally:
            worker.stop()


def test_cold_ownership_waits_for_background_snapshot_instead_of_missing_existing_files(repo):
    from app.domains.music.ownership import OwnershipIndex
    song(repo)
    repo.scans.worker = ScanWorker(repo, debounce=0.001)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None), \
         patch.object(repo.scans.worker.watch, 'follow'):
        repo.start_scanner()
        try:
            index = OwnershipIndex(repo, repo.config, repo.logger)
            assert index.lookup('Unknown Artist', 'song').owned is True
        finally:
            repo.stop_scanner()


def test_filesystem_hints_debounce_from_the_last_event_and_owner_actions_are_prompt(repo):
    worker = ScanWorker(repo, debounce=0.1)
    with patch('app.domains.music.scan_worker.time.monotonic', return_value=10):
        worker.request('filesystem')
        assert worker.deadline == 15
    with patch('app.domains.music.scan_worker.time.monotonic', return_value=14):
        worker.request('filesystem')
        assert worker.deadline == 19
        worker.request('owner-changes')
        assert worker.deadline == 14.1


def test_analysis_connections_are_constant_for_a_whole_listing_refresh(repo):
    for index in range(20):
        song(repo, name=f'{index}.mp3')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    repo.analysis.fix('Album/0.mp3', 0, {'bpm': 123}, 'owner')
    with patch.object(repo.analysis, 'connection', wraps=repo.analysis.connection) as connections:
        assert len(repo.refresh()[0].tracks) == 20
    assert connections.call_count == 2  # One revision read and one batched values/ownership read.


def test_watch_ignores_hidden_temp_and_directory_mtime_noise(repo):
    worker = Mock()
    watch = LibraryWatch(worker)
    watch.root = repo.config.base_music_dir
    for relative, directory in [('Album', True), ('Album/lyrics.lrc', False),
                                ('.cache/audio.mp3', False), ('temp/song.mp3', False)]:
        watch.on_any_event(SimpleNamespace(event_type='modified', is_directory=directory,
                                          src_path=str(watch.root / relative)))
    worker.request.assert_not_called()
    watch.on_any_event(SimpleNamespace(event_type='created', is_directory=True,
                                      src_path=str(watch.root / 'New album')))
    worker.request.assert_called_once_with('filesystem')


def test_watch_reconnects_after_the_music_root_returns(repo):
    worker = ScanWorker(repo)
    old = Mock()
    old.is_alive.return_value = True
    worker.watch.root = repo.config.base_music_dir
    worker.watch.observer = old
    root = repo.config.base_music_dir
    root.rename(root.with_name('offline'))
    worker.watch.follow(root)
    old.stop.assert_called_once()
    assert worker.watch.observer is None
    root.with_name('offline').rename(root)
    with patch('app.domains.music.scan_watch.Observer') as factory:
        worker.watch.follow(root)
        factory.return_value.schedule.assert_called_once_with(worker.watch, str(root), recursive=True)
        factory.return_value.start.assert_called_once()
        worker.watch.stop()


def test_explicit_last_song_deletion_survives_restart_before_publication(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    path.unlink()
    repo.forget_file(path)
    restarted = MusicRepository(repo.config, repo.logger)
    assert str(path) not in restarted._tag_cache
    assert restarted.refresh() == []
    assert restarted.scans.error is None
    assert restarted.scans.store.pending(repo.config.base_music_dir) == (False, False)


def test_deletion_and_full_rescan_intents_coalesce_without_overwriting_each_other(repo):
    path = song(repo)
    repo.scans.store.forget_file(repo.config.base_music_dir, path)
    repo.scans.store.request_full(repo.config.base_music_dir)
    assert repo.scans.store.pending(repo.config.base_music_dir) == (True, True)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    assert repo.scans.store.pending(repo.config.base_music_dir) == (False, False)


def test_explicit_delete_discards_unpublished_tag_memos(repo):
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.read_tags(path)
    assert str(path) in repo._tag_dirty
    path.unlink()
    repo.forget_file(path)
    assert str(path) not in repo._tag_dirty
    repo.refresh()
    with repo.scans.store.connection() as db:
        assert db.execute('SELECT count(*) FROM tags').fetchone()[0] == 0


def test_cache_upgrade_keeps_full_intent_and_invalidates_old_tag_memos(tmp_path):
    from app.domains.music.scan_store import SCAN_CACHE, ScanStore
    from app.infra.migrations import SQLiteStore, open_store
    path = tmp_path / 'music-scan.sqlite'
    root = tmp_path / 'Music'
    old = open_store(path, SQLiteStore(SCAN_CACHE.name, SCAN_CACHE.steps[:2]))
    with old:
        old.execute('INSERT INTO requests VALUES (?,1)', (str(root),))
        old.execute("INSERT INTO tags VALUES ('song.mp3',1,2,'{}')")
    old.close()
    upgraded = ScanStore(path)
    assert upgraded.pending(root) == (True, False)
    assert upgraded.load(root)[1]['song.mp3'] == ((-1, 2), {})


def test_first_seen_upgrade_leaves_existing_rows_untracked(repo):
    from app.domains.music.scan_store import SCAN_CACHE, ScanStore
    from app.infra.migrations import SQLiteStore, open_store
    path = song(repo)
    store_path = repo.scans.store.path
    store_path.unlink()
    old = open_store(store_path, SQLiteStore(SCAN_CACHE.name, SCAN_CACHE.steps[:7]))
    with old:
        old.execute('INSERT INTO tags VALUES (?,1,2,?)', (str(path), '{}'))
    old.close()
    repo.scans.store = ScanStore(store_path)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh(full=True)
        path.write_bytes(b'retagged')
        repo.refresh()
    with repo.scans.store.connection() as db:
        assert db.execute('SELECT first_seen FROM tags').fetchone() == (None,)


@pytest.mark.parametrize('old_version', [3, 7])
def test_first_seen_step_can_be_replayed_without_resetting_arrivals(repo, old_version):
    from app.domains.music.scan_store import ScanStore
    path = song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
    with repo.scans.store.connection() as db:
        first_seen = db.execute('SELECT first_seen FROM tags').fetchone()[0]
        assert first_seen is not None
        db.execute('INSERT INTO tags (path,first_seen) VALUES (?,NULL)', ('before-tracking.mp3',))
        db.execute(f'PRAGMA user_version={old_version}')
    upgraded = ScanStore(repo.scans.store.path)
    with upgraded.connection() as db:
        assert dict(db.execute('SELECT path,first_seen FROM tags')) == {
            str(path): first_seen, 'before-tracking.mp3': None,
        }


@pytest.mark.parametrize('persisted', [False, True])
def test_first_hosted_listing_refreshes_cold_or_stale_snapshot(repo, persisted):
    if persisted:
        song(repo, 'Existing')
        with patch('app.domains.music.repositories.MutagenFile', return_value=None):
            repo.refresh()
    song(repo, 'Artist/New')
    hosted = MusicRepository(repo.config, repo.logger, background=True)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags:
        albums = hosted.scan_albums()
        assert sum(len(album.tracks) for album in albums) == 1 + int(persisted)
        assert tags.call_count == 1  # Existing persisted tag memos are reused.
        with patch('app.domains.music.library_scan.discover', side_effect=AssertionError('warm poll')):
            assert hosted.scan_albums() is albums


def test_listing_retains_snapshot_on_failed_new_folder_read_and_retries(repo):
    song(repo)
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        first = repo.refresh()
        song(repo, 'New')
        repo.scans.worker = ScanWorker(repo)
        with patch.object(repo, 'build_album', side_effect=OSError('transient')):
            assert repo.scan_albums() is first
        assert repo.scans.error == 'failed'
        assert len(repo.scan_albums()) == 2
        assert repo.scans.error is None


def test_scanner_logs_each_collision_pair_once(repo, caplog):
    first = song(repo, 'Artist/Album')
    second = song(repo, 'Artist∕Album')
    with caplog.at_level(logging.WARNING), patch('app.domains.music.repositories.MutagenFile', return_value=None):
        repo.refresh()
        repo.refresh(full=True)
        repo.refresh_folders([first.parent, second.parent])
    collisions = [record for record in caplog.records if 'Ambiguous library key' in record.message]
    assert len(collisions) == 1
    assert 'Artist/Album/song.mp3' in collisions[0].message
    assert 'Artist∕Album/song.mp3' in collisions[0].message
    assert first.exists() and second.exists()
