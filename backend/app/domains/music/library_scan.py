"""Incremental disk discovery and atomic publication of the last good listing."""
import hashlib
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from app.domains.music.analysis_listing import AnalysisListing
from app.domains.music.library_files import walk_library
from app.domains.music.scan_store import ScanStore
from app.domains.music.scan_worker import ScanWorker
from app.utils.library_paths import album_dir_of, rel_path_for, is_disc_dir
from app.utils.path_safety import resolve_under
from app.domains.music.publish_events import expected_publishes

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


def discover(root, audio_extensions, *, paths=None):
    """Hash names, sizes, mtimes and ctimes, including legacy cover folders."""
    def fail(error):
        raise error

    signatures, groups, album_signatures, directory_mtimes = {}, {}, {}, {}
    if not root.is_dir():
        raise FileNotFoundError('Music root is unavailable')
    if paths is None:
        listing = walk_library(root, onerror=fail)
    else:
        def selected():
            for folder in sorted(paths):
                if folder.is_dir():
                    yield folder, [], [p.name for p in folder.iterdir() if p.is_file()]
        listing = selected()
    for folder, _dirs, files in listing:
        folder = Path(folder)
        directory_mtimes[str(folder)] = folder.stat().st_mtime_ns
        entries = []
        songs = []
        for name in sorted(files):
            path = folder / name
            if name.startswith('.') or path.suffix.lower() not in audio_extensions | IMAGE_EXTENSIONS:
                continue
            stat = path.stat()
            entries.append((name, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
            if path.suffix.lower() in audio_extensions:
                songs.append(path)
        cover = folder / 'cover'
        if cover.is_dir():
            for path in sorted(cover.iterdir()):
                if not path.name.startswith('.') and path.suffix.lower() in IMAGE_EXTENSIONS and path.is_file():
                    stat = path.stat()
                    entries.append(('cover/' + path.name, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        signature = hashlib.sha256(repr(entries).encode()).hexdigest()
        signatures[str(folder)] = signature
        # Disc folders belong to the parent album, including its cover signature.
        album = album_dir_of(root, folder / (songs[0].name if songs else 'placeholder.mp3'))
        album_signatures.setdefault(album, []).append((str(folder), signature))
        if songs:
            groups.setdefault(album, []).extend(songs)
    return signatures, groups, {p: tuple(v) for p, v in album_signatures.items()}, directory_mtimes


class LibraryScan:
    def __init__(self, repository):
        self.repository = repository
        self.root = repository.config.base_music_dir
        self.store = ScanStore(Path(repository.config.analysis_db).with_name('music-scan.sqlite'))
        self.folders, tags, self.albums, status = self.store.load(self.root)
        self._published = (self.root, self.albums)
        repository._tag_cache.update(tags)
        self.completed_at, self.duration = status
        self.analysis_revision = None
        self.album_signatures = {}
        self.lock = threading.RLock()
        self.dirty = True
        self.worker = None
        self.generation = 0
        self.error = None
        self.allow_empty = False
        self.directory_mtimes = None
        self.health_publisher = None
        self.health_error = None

    def read_fresh(self):
        """Discover structural changes before answering, even without native hints.

        Stat only known directories: unchanged polls do no enumeration or tag I/O.
        A new nested folder changes its known parent; root files change the root.
        In-place retags still belong to the watcher and periodic background pass.
        """
        def changed():
            if self.root != self.repository.config.base_music_dir:
                return True
            if self.directory_mtimes is None:
                return not expected_publishes.contains(self.root)
            try:
                return any(Path(folder).stat().st_mtime_ns != stamp and not expected_publishes.contains(folder)
                           for folder, stamp in self.directory_mtimes.items())
            except OSError:
                return True

        if changed():
            with self.lock:
                if changed():
                    try:
                        self.refresh(reason="listing")
                    except Exception:
                        # A transient read failure retains the last good listing.
                        pass
        return self.read()

    def start(self):
        if self.worker is None:
            self.worker = ScanWorker(self.repository)
        self.worker.start()

    def watching(self):
        return bool(self.worker and self.worker.watch.following(self.repository.config.base_music_dir))

    def read(self):
        # A root change must never leak the old root's library into a request.
        root, albums = self._published
        if root != self.repository.config.base_music_dir:
            if self.worker:
                self.worker.request('root-changed')
            return []
        return albums

    def invalidate(self, reason):
        self.dirty = True
        if self.worker:
            self.worker.request(reason)

    def refresh(self, *, reason='changes', full=False, base_dir=None):
        with self.lock:
            return self._refresh(reason=reason, full=full, root=base_dir or self.repository.config.base_music_dir)

    def refresh_folders(self, paths):
        """Enumerate only affected albums, their discs and newly created parents."""
        root = self.repository.config.base_music_dir
        def configured_path(path):
            resolved = resolve_under(root, *Path(path).resolve().relative_to(root.resolve()).parts)
            return root / resolved.relative_to(root.resolve())
        paths = {album_dir_of(root, configured_path(p) / 'placeholder.mp3') for p in paths}
        if not paths:
            return self.read()
        with self.lock:
            return self._refresh(reason='acquisition', full=False, root=root, paths=paths)

    def _refresh(self, *, reason, full, root, paths=None):
        repo = self.repository
        started = time.perf_counter()
        pending_full, pending_empty = self.store.pending(root)
        full = full or pending_full
        allow_empty = self.allow_empty or pending_empty
        if full:
            self.store.request_full(root)
        # Root changes and explicit recovery intents still require discovery.
        if self.root != root or full or pending_empty:
            paths = None
        try:
            removed_folders = set()
            if paths is None:
                folders, groups, album_signatures, directory_mtimes = discover(root, repo.AUDIO_EXTENSIONS)
            else:
                selected = set(paths)
                for path in paths:
                    if path.is_dir():
                        selected.update(p for p in path.iterdir() if not p.is_symlink() and p.is_dir() and is_disc_dir(p.name))
                    selected.update(p for p in path.parents if p.is_relative_to(root))
                updates, found, signatures, stamps = discover(root, repo.AUDIO_EXTENSIONS, paths=selected)
                removed_folders = {p for p in self.folders if Path(p) in paths or
                                   (Path(p).parent in paths and is_disc_dir(Path(p).name))} - updates.keys()
                folders = {p: sig for p, sig in self.folders.items() if p not in removed_folders} | updates
                groups = {a.path: [t.path for t in a.tracks] for a in self.albums if a.path not in paths}
                groups.update({p: files for p, files in found.items() if p in paths or p not in groups})
                album_signatures = dict(self.album_signatures)
                album_signatures.update(signatures)
                known_mtimes = self.directory_mtimes
                if known_mtimes is None:
                    known_mtimes = {p: Path(p).stat().st_mtime_ns for p in self.folders}
                directory_mtimes = {p: stamp for p, stamp in known_mtimes.items()
                                    if p not in removed_folders} | stamps
        except OSError:
            self.error = 'unavailable'
            repo.logger.warning('Library scan skipped: music root is unavailable; retaining last good snapshot')
            return self.read()
        if not groups and self.albums and self.root == root and not allow_empty:
            # An unplugged/empty mount is not evidence of removal.
            self.error = 'empty'
            return self.read()
        root_changed = self.root != root
        disk_changed = root_changed or folders != self.folders or full
        if disk_changed:
            repo.analysis.clear_removed_present(rel_path_for(root, p) for folder, files in groups.items()
                                                if paths is None or folder in paths for p in files)
        revision = repo.analysis.revision
        project = self.dirty or revision != self.analysis_revision
        if not disk_changed and not project:
            self.directory_mtimes = directory_mtimes
            self.error = None
            if reason != 'periodic':
                self._completed(started, reason, 0)
            self._publish_health(root, self.albums, groups, folders)
            return self.albums
        # Clear before I/O: invalidations arriving during the pass survive it.
        self.dirty = False
        old = {} if root_changed else {a.path: a for a in self.albums}
        repo._scan_context.full = full
        repo._scan_context.loaded = set()
        repo._cover_cache.clear()
        changed = 0
        try:
            repo._scan_context.analysis = AnalysisListing(repo.analysis)
            repo._scan_context.states = repo.analysis_states() if repo.analysis_states else {}
            albums = []
            for path, files in groups.items():
                untouched = paths is not None and path not in paths
                unchanged = all(
                    self.folders.get(folder) == sig for folder, sig in album_signatures.get(path, ())
                ) and path in old and len(files) == len(old[path].tracks)
                reusable = path in old and not full and (untouched or unchanged)
                if reusable:
                    album = old[path]
                    if project and paths is None:
                        album = repo.project_album(album)
                else:
                    changed += 1
                    album = repo.build_album(path, files, root)
                if album:
                    albums.append(album)
            # Keep the retention/grace behavior in its existing owner.
            if disk_changed and paths is None:
                repo.analysis.sweep(root)
            duration = time.perf_counter() - started
            completed = datetime.now(UTC).isoformat()
            with repo._lock:
                dirty_tags = repo._tag_dirty.copy()
            changed_albums = [a for a in albums if old.get(a.path) is not a]
            self.store.save(root, folders if paths is None else updates, dirty_tags,
                            albums if paths is None else changed_albums, completed, duration,
                            full=full, allow_empty=allow_empty, incremental=paths is not None,
                            removed_folders=removed_folders, removed_albums=old.keys() - {a.path for a in albums})
            with repo._lock:
                for path, value in dirty_tags.items():
                    if repo._tag_dirty.get(path) is value:
                        repo._tag_dirty.pop(path, None)
            # No publication until every folder and the durable snapshot succeeded.
            if root != repo.config.base_music_dir:
                self.invalidate('root-changed')
                return self.read()
            self.root, self.folders, self.albums = root, folders, albums
            self._published = (root, albums)
            self.directory_mtimes = directory_mtimes
            self.allow_empty = False
            self.album_signatures = album_signatures
            if paths is None:
                self.analysis_revision = revision
            duration = time.perf_counter() - started
            self.completed_at, self.duration = completed, duration
            self.store.completed(root, completed, duration)
            self.generation += 1
            repo._tag_revision += 1  # published catalog changes only, never memo misses
            repo.changes.bump('library')
            self.error = None
            if disk_changed or reason not in ('periodic', 'mutation'):
                repo.logger.info('Library scan reason=%s full=%s folders=%d duration=%.3fs', reason, full, changed, duration)
            self._publish_health(root, self.albums, groups, folders)
            return self.albums
        except Exception:
            self.dirty = True
            self.error = 'failed'
            repo.logger.error('Library scan reason=%s full=%s result=failed duration=%.3fs',
                             reason, full, time.perf_counter() - started)
            raise
        finally:
            repo._scan_context.full = False
            repo._scan_context.analysis = None
            repo._scan_context.states = None

    def _publish_health(self, root, albums, groups, folders):
        if self.health_publisher:
            try:
                present = {rel_path_for(root, p) for paths in groups.values() for p in paths}
                self.health_publisher(root, albums, present, folders, datetime.now(UTC).isoformat())
                self.health_error = None
            except Exception:
                self.health_error = 'source-failed'
                self.repository.logger.exception('Library health publication failed')

    def _completed(self, started, reason, changed):
        self.completed_at = datetime.now(UTC).isoformat()
        self.duration = time.perf_counter() - started
        self.store.completed(self.root, self.completed_at, self.duration)
        log = self.repository.logger.info if reason.startswith('owner-') else self.repository.logger.debug
        log('Library scan reason=%s full=False folders=%d duration=%.3fs', reason, changed, self.duration)

    def status(self):
        return {**(self.worker.status() if self.worker else {'scanning': False, 'pending': False,
                                                          'intervalSeconds': 300.0}),
                'lastScanAt': self.completed_at, 'durationSeconds': self.duration, 'error': self.error,
                'watching': self.watching()}
