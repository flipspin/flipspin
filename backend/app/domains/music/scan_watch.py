"""Native filesystem hints, backed by the scanner's timer on every filesystem."""
import logging
import threading
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from app.domains.music.library_files import AUDIO_EXTENSIONS, SKIP_DIRS
from app.domains.music.publish_events import expected_publishes

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp'}


class WatchFailures(logging.Handler):
    """watchdog 7.1 reports inotify overflow/recovery failures through logging.

    It repairs recursive watches after IN_Q_OVERFLOW, but emits no file event
    for the lost changes. Request a catalog recovery as well, without patching
    watchdog's process-wide inotify implementation.
    """
    _lock = threading.RLock()
    _previous_level = None

    def __init__(self, watch):
        super().__init__(logging.WARNING)
        self.watch = watch

    def start(self):
        logger = logging.getLogger('watchdog')
        with self._lock:
            if not any(isinstance(handler, WatchFailures) for handler in logger.handlers):
                WatchFailures._previous_level = logger.level
                # Recovery must still run when application output is ERROR-only.
                # Output handlers retain their own configured severity filters.
                logger.setLevel(min(logger.getEffectiveLevel(), logging.WARNING))
            logger.addHandler(self)

    def stop(self):
        logger = logging.getLogger('watchdog')
        with self._lock:
            logger.removeHandler(self)
            if self._previous_level is not None and not any(isinstance(h, WatchFailures) for h in logger.handlers):
                logger.setLevel(self._previous_level)
                WatchFailures._previous_level = None

    def emit(self, record):
        if not record.name.startswith('watchdog.observers.'):
            return
        if 'overflow' in record.getMessage().lower():
            self.watch.worker.request('watcher-overflow', full=True)
        elif record.levelno >= logging.ERROR:
            self.watch.failed = True
            self.watch.worker.request('watcher-failed', full=True)


class LibraryWatch(FileSystemEventHandler):
    def __init__(self, worker):
        self.worker = worker
        self.observer = None
        self.root = None
        self.failed = False
        self.failures = WatchFailures(self)

    def following(self, root):
        """Liveness only: safe to call on every request, with no filesystem I/O."""
        observer = self.observer
        return bool(self.root == root and not self.failed and observer and observer.is_alive()
                    and all(emitter.is_alive() for emitter in tuple(observer.emitters)))

    def on_any_event(self, event):
        # Reads emit inotify open/close events too: those must never cause scans.
        if event.event_type not in ('created', 'modified', 'deleted', 'moved'):
            return
        # Directory mtime events also describe sidecars, caches and SQLite files.
        # File events carry the useful change; structural directory events cover
        # whole folders moving in or out. The timer covers missed native hints.
        if event.is_directory and event.event_type == 'modified':
            return
        paths = [event.src_path, getattr(event, 'dest_path', '')]
        for value in paths:
            if not value:
                continue
            path = Path(value)
            try:
                parts = path.relative_to(self.root).parts if self.root else path.parts
            except ValueError:
                continue
            if any(part.startswith('.') or part in SKIP_DIRS - {'cover'} for part in parts):
                continue
            if expected_publishes.contains(path):
                continue
            if event.is_directory or path.suffix.lower() in AUDIO_EXTENSIONS | IMAGE_EXTENSIONS:
                self.worker.request('filesystem')
                break

    def follow(self, root):
        if not root.is_dir():
            self.stop()
            self.root = None
            return
        if self.following(root):
            return
        self.stop()
        self.failed = False
        self.failures.start()
        observer = None
        try:
            observer = Observer()
            observer.schedule(self, str(root), recursive=True)
            observer.start()
            self.observer, self.root = observer, root
        except OSError:
            if observer:
                observer.stop()
            self.failures.stop()
            self.worker.repository.logger.warning('Library watcher unavailable; checking for changes every five minutes')

    def stop(self):
        self.failures.stop()
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=5)
            self.observer = None
