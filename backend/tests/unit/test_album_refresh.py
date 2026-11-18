"""Album import scan counts, filesystem hints and atomic publication costs."""
import asyncio
import logging
import os
import json
import threading
from dataclasses import asdict
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from app.domains.acquisition.import_stage import AlbumRefresh, import_file
from app.domains.music.publish_events import ExpectedPublishes
from app.domains.music.repositories import MusicRepository
from app.domains.music.scan_watch import LibraryWatch
from app.domains.music.scan_worker import ScanWorker
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import body, submit

pipeline = fixtures.pipeline


def repository(pipeline):
    return MusicRepository(SimpleNamespace(base_music_dir=pipeline.root,
                           analysis_db=pipeline.data / 'analysis.sqlite'), logging.getLogger('test.refresh'))


def event(watch, path, kind='created', directory=False, destination=''):
    watch.on_any_event(SimpleNamespace(src_path=str(path), dest_path=str(destination),
                                      event_type=kind, is_directory=directory))


def test_thirteen_song_import_refreshes_one_folder_and_reads_each_tag_once(pipeline):
    music = pipeline.music = repository(pipeline)
    music.scans.worker = ScanWorker(music)
    music.refresh()  # Establish the existing empty library before the request.
    worker = Mock()
    watch = LibraryWatch(worker)
    watch.root = pipeline.root
    original = pipeline.engine._finish_staged_file

    async def artwork(path, *args, **options):
        await original(path, *args, **options)
        cover = path.parent / 'cover' / 'cover.jpg'
        cover.parent.mkdir()
        cover.write_bytes(b'artwork')
        event(watch, pipeline.root / 'incoming' / path.name)
        event(watch, pipeline.root / 'staging' / path.name)

    pipeline.engine._finish_staged_file = artwork
    native_replace = os.replace

    def rename(source, target):
        native_replace(source, target)
        event(watch, target, 'moved', destination=target)
        # Client polling during publication must not force a full discovery.
        music.scans.read_fresh()

    request = submit(pipeline, body(13))
    before = music.changes.revision('library')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags, \
         patch.object(music, 'refresh_folders', wraps=music.refresh_folders) as refresh, \
         patch('app.domains.music.writer.os.replace', side_effect=rename), \
         patch('app.domains.music.library_scan.walk_library', side_effect=AssertionError('whole-tree walk')), \
         patch.object(music.analysis, 'sweep', side_effect=AssertionError('whole-tree sweep')):
        results = asyncio.run(pipeline.run(request['id']))
        assert all(result.success for result in results), [(r.error, r.failure_kind) for r in results]
        folder = results[0].file_path.parent
        refresh.assert_called_once_with([folder])
        assert Counter(call.args[0] for call in tags.call_args_list) == Counter(str(r.file_path) for r in results)
        assert tags.call_count == 13
    for result in results:
        event(watch, result.file_path)
        event(watch, result.file_path.parent, directory=True)
    event(watch, folder / 'cover.jpg')
    worker.request.assert_not_called()
    assert music.scans.worker.pending == set()
    assert music.changes.revision('library') == before + 1
    assert len(music.scans.read()[0].tracks) == 13
    assert MusicRepository(music.config, music.logger).scans.read() == music.scans.read()
    # A person's later edit to the same published path must bypass its receipt.
    results[0].file_path.write_bytes(b'outside edit')
    event(watch, results[0].file_path, 'modified')
    worker.request.assert_called_once_with('filesystem')


def test_per_file_scan_baseline_is_thirteen_passes_for_thirteen_songs(pipeline):
    music = repository(pipeline)
    folder = pipeline.root / 'Album'
    folder.mkdir()
    with patch('app.domains.music.repositories.MutagenFile', return_value=None), \
         patch.object(music, 'refresh', wraps=music.refresh) as refresh, \
         patch.object(music, 'build_album', wraps=music.build_album) as build:
        for i in range(13):
            (folder / f'{i}.mp3').write_bytes(b'audio')
            music.refresh(reason='filesystem')
    assert refresh.call_count == build.call_count == 13
    assert sum(len(call.args[1]) for call in build.call_args_list) == 91


def test_playlist_refreshes_each_album_when_its_last_item_finishes(pipeline):
    pipeline.music = Mock()
    data = body(13)
    data = data.model_copy(update={'kind': 'playlist', 'tracks': [
        t.model_copy(update={'album': 'First' if i < 5 else 'Second'}) for i, t in enumerate(data.tracks)]})
    request = submit(pipeline, data)
    results = asyncio.run(pipeline.run(request['id']))
    assert all(r.success for r in results)
    folders = {r.file_path.parent for r in results}
    assert len(folders) == 2
    assert Counter(call.args[0][0] for call in pipeline.music.refresh_folders.call_args_list) == Counter(folders)
    pipeline.music.invalidate_scan.assert_not_called()


def test_idle_refresh_resets_and_last_failure_flushes_pending_album(tmp_path):
    music = Mock()
    folder = tmp_path / 'Album'
    with patch('app.domains.acquisition.import_stage.threading.Timer') as timers:
        timers.side_effect = lambda *args, **kwargs: Mock()
        batch = AlbumRefresh(music, tmp_path, [folder] * 3)
        batch.landed(folder / 'one.mp3')
        old_callback = timers.call_args.args[1]
        first_timer = batch.timers[folder]
        batch.done(0)
        batch.landed(folder / 'two.mp3')
        first_timer.cancel.assert_called_once()
        old_callback()  # A cancelled timer racing with another publication.
        music.refresh_folders.assert_not_called()
        assert timers.call_args.args[0] == 5.0
        timers.call_args.args[1]()
        music.refresh_folders.assert_called_once_with([folder])
        batch.landed(folder / 'three.mp3')
        batch.done(1)
        batch.done(2)  # A failed last fetch also settles the folder.
        assert music.refresh_folders.call_count == 2
        batch.close()
        assert music.refresh_folders.call_count == 2


def test_expected_receipts_expire_and_do_not_hide_outside_changes(tmp_path):
    receipts = ExpectedPublishes(ttl=10)
    path = tmp_path / 'song.mp3'
    with patch('app.domains.music.publish_events.time.monotonic', return_value=100):
        receipts.expect(path)
        path.write_bytes(b'audio')
        receipts.landed(path)
        assert receipts.contains(path)
    with patch('app.domains.music.publish_events.time.monotonic', return_value=111):
        assert not receipts.contains(path)


def test_idle_timer_flushes_without_waiting_for_the_request_to_finish(tmp_path):
    flushed = threading.Event()
    music = Mock()
    music.refresh_folders.side_effect = lambda paths: flushed.set()
    folder = tmp_path / 'Album'
    batch = AlbumRefresh(music, tmp_path, [folder] * 13, idle=0.01)
    try:
        batch.landed(folder / 'one.mp3')
        batch.done(0)
        assert flushed.wait(5)
        music.refresh_folders.assert_called_once_with([folder])
        assert batch.remaining[folder] == 12
    finally:
        batch.close()


@pytest.mark.parametrize('overwrite', [False, True])
@pytest.mark.parametrize('cross_device', [False, True])
def test_publish_renames_on_same_device_and_only_copies_and_fsyncs_across_devices(tmp_path, cross_device, overwrite, monkeypatch):
    monkeypatch.setattr('app.domains.acquisition.import_stage.validate', lambda *args, **kwargs: {})
    root, incoming = tmp_path / 'Music', tmp_path / 'incoming'
    incoming.mkdir()
    staged = incoming / 'song.mp3'
    staged.write_bytes(b'complete audio')
    staged.chmod(0o600)
    native_stat = Path.stat

    def stat(path, *args, **kwargs):
        value = native_stat(path, *args, **kwargs)
        if cross_device and path == staged:
            return SimpleNamespace(**{name: getattr(value, name) for name in dir(value) if name.startswith('st_')}
                                   | {'st_dev': value.st_dev + 1})
        return value

    with patch.object(Path, 'stat', stat), \
         patch('app.domains.music.writer.os.replace', wraps=os.replace) as rename, \
         patch('app.domains.music.writer.shutil.copyfileobj', wraps=__import__('shutil').copyfileobj) as copy, \
         patch('app.domains.music.writer.os.fsync', wraps=os.fsync) as fsync:
        final = import_file(staged, root / 'Artist' / 'Album', root=root, incoming=incoming,
                            recycle=tmp_path / 'recycle', overwrite=overwrite)
    assert final.read_bytes() == b'complete audio'
    assert not staged.exists()
    assert final.stat().st_mode & 0o777 == 0o644
    assert copy.call_count == fsync.call_count == int(cross_device)
    assert rename.call_count == int(not cross_device) + int(overwrite)
    if overwrite:
        assert rename.call_args.args[0].name.startswith('.import-')
    if not cross_device:
        assert rename.call_args_list[0].args[0] == staged
    worker = Mock()
    watch = LibraryWatch(worker)
    watch.root = root
    event(watch, final)
    event(watch, final.parent, directory=True)
    event(watch, final.parent.parent, directory=True)
    worker.request.assert_not_called()


def test_nested_album_and_disc_refresh_does_not_walk_or_rebuild_unrelated_album(pipeline):
    music = repository(pipeline)
    other = pipeline.root / 'Other' / 'song.mp3'
    other.parent.mkdir()
    other.write_bytes(b'audio')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        before = music.refresh()
    with music.scans.store.connection() as db:
        db.execute('CREATE TABLE changed_albums (path TEXT)')
        db.execute('CREATE TRIGGER record_album_update AFTER INSERT ON album_snapshots '
                   'BEGIN INSERT INTO changed_albums VALUES (NEW.path); END')
    folder = pipeline.root / 'Artist' / 'New' / 'Album'
    disc = folder / 'CD1'
    disc.mkdir(parents=True)
    for i in range(13):
        (disc / f'{i}.mp3').write_bytes(b'audio')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None) as tags, \
         patch.object(music, 'build_album', wraps=music.build_album) as build, \
         patch('app.domains.music.library_scan.walk_library', side_effect=AssertionError('full discovery')), \
         patch.object(music.analysis, 'sweep', side_effect=AssertionError('full sweep')):
        after = music.refresh_folders([disc])
    assert build.call_count == 1
    assert tags.call_count == 13
    assert next(a for a in after if a.path == other.parent) is before[0]
    assert len(next(a for a in after if a.path == folder).tracks) == 13
    assert {str(p) for p in [pipeline.root, folder.parent.parent, folder.parent, folder, disc]} <= music.scans.directory_mtimes.keys()
    restarted = MusicRepository(music.config, music.logger)
    assert {a.path for a in restarted.scans.read()} == {folder, other.parent}
    with music.scans.store.connection() as db:
        assert db.execute('SELECT path FROM changed_albums').fetchall() == [(str(folder),)]
    worker = Mock()
    watch = LibraryWatch(worker)
    watch.root = pipeline.root
    manual = folder.parent / 'Manual' / 'song.mp3'
    manual.parent.mkdir()
    manual.write_bytes(b'audio')
    event(watch, manual)
    worker.request.assert_called_once_with('filesystem')


def test_snapshot_migration_preserves_the_last_good_catalog(pipeline):
    from app.domains.music.scan_store import SCAN_CACHE, ScanStore
    from app.infra.migrations import SQLiteStore, open_store
    music = repository(pipeline)
    path = pipeline.root / 'Album' / 'song.mp3'
    path.parent.mkdir()
    path.write_bytes(b'audio')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        albums = music.refresh()
    old_path = pipeline.data / 'old-scan.sqlite'
    old = open_store(old_path, SQLiteStore(SCAN_CACHE.name, SCAN_CACHE.steps[:-1]))
    with old:
        old.execute('INSERT INTO snapshots VALUES (?,?,?,?)',
                    (str(pipeline.root), json.dumps([asdict(a) for a in albums], default=str), music.scans.completed_at, 1.0))
    old.close()
    upgraded = ScanStore(old_path)
    assert upgraded.load(pipeline.root)[2] == albums
    with upgraded.connection() as db:
        assert db.execute('SELECT value FROM snapshots').fetchone() == ('[]',)


def test_targeted_refresh_preserves_configured_symlink_root_spelling(pipeline):
    alias = pipeline.data / 'Alias'
    alias.symlink_to(pipeline.root, target_is_directory=True)
    music = repository(pipeline)
    music.config.base_music_dir = alias
    folder = pipeline.root / 'Artist' / 'Album'
    folder.mkdir(parents=True)
    (folder / 'one.mp3').write_bytes(b'audio')
    with patch('app.domains.music.repositories.MutagenFile', return_value=None):
        music.refresh()
        (folder / 'two.mp3').write_bytes(b'audio')
        albums = music.refresh_folders([folder])
    assert len(albums) == 1
    assert albums[0].path == alias / 'Artist' / 'Album'
    assert len(albums[0].tracks) == 2
