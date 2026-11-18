"""Offline restore: verify and stage everything, preserve current state, publish."""
import os
import shutil
import tempfile
from pathlib import Path

from app.infra.backups import JSON_STORES, BackupManager, file_record, safe_file, stamp_time, utc_stamp, verify_snapshot
from app.infra.data_lock import DataLock
from app.infra.files import PRIVATE, write_bytes_atomic
from app.infra.migrations import fsync_directory
from app.infra.sqlite_backup import check_integrity


def restore(manager: BackupManager, stamp: str) -> list[Path]:
    stamp_time(stamp)
    with DataLock(manager.data / '.server.lock'), DataLock(manager.data / '.backup.lock'):
        directory = safe_file(manager.directory, stamp)
        manifest = verify_snapshot(directory)
        # The full playlist tree is replaced so playlists created after the
        # snapshot cannot leak into the restored state.
        names = {item['path'] for item in manifest['files'] if not item['path'].startswith('playlists/')}
        names.update(name for name in manager.sources() if not name.startswith('playlists/'))
        names.update((*JSON_STORES, 'jobs.sqlite', 'analysis.sqlite'))
        targets = {name: manager.target(name) for name in names}
        targets['playlists'] = manager.config.playlist_dir
        if any(a == b or a in b.parents or b in a.parents
               for i, a in enumerate(targets.values()) for b in list(targets.values())[i + 1:]):
            raise ValueError('Overlapping restore targets')
        # Stage beside each target: configured stores may use another filesystem.
        staged = {}
        saved = []
        published = []
        aside_dirs = []
        try:
            for name, target in targets.items():
                safe_file(target.parent, target.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                staging = Path(tempfile.mkdtemp(prefix='.restore-', dir=target.parent))
                staged[name] = staging
                if name == 'playlists':
                    (staging / 'value').mkdir(mode=0o700)
            for item in manifest['files']:
                name = item['path']
                if name.startswith('playlists/'):
                    destination = safe_file(staged['playlists'] / 'value', name.removeprefix('playlists/'))
                else:
                    destination = staged[name] / 'value'
                write_bytes_atomic(destination, safe_file(directory, name).read_bytes(), mode=PRIVATE)
                if file_record(destination, name) != item:
                    raise ValueError('Staged backup checksum mismatch')
                if name.endswith('.sqlite'):
                    check_integrity(destination)
            # No current state moves until every staged file has been checked.
            restore_id = utc_stamp(manager.now())
            for name, target in targets.items():
                aside = target.parent / ('.before-restore-' + restore_id)
                if aside not in aside_dirs:
                    aside.mkdir(mode=0o700)
                    aside_dirs.append(aside)
                candidates = [target]
                if name.endswith('.sqlite'):
                    candidates += [Path(str(target) + suffix) for suffix in ('-wal', '-shm', '-journal')]
                for current in candidates:
                    safe_file(current.parent, current.name)
                    if current.exists():
                        destination = aside / current.name
                        os.replace(current, destination)
                        saved.append((current, destination))
            for aside in aside_dirs:
                fsync_directory(aside)
                fsync_directory(aside.parent)
            for name, target in targets.items():
                value = staged[name] / 'value'
                if value.exists():
                    os.replace(value, target)
                    published.append(target)
                fsync_directory(target.parent)
        except BaseException:
            for target in reversed(published):
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            for target, previous in reversed(saved):
                os.replace(previous, target)
            raise
        finally:
            for path in staged.values():
                shutil.rmtree(path, ignore_errors=True)
        return aside_dirs
