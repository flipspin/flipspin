"""The sole acquisition stage permitted to publish household files."""
import logging
import threading
import json
from collections import Counter

from app.domains.music.writer import publish
from app.domains.music.public import invalidate_scan, refresh_folders
from app.utils.library_paths import album_dir_of
from app.utils.path_safety import safe_open_path
from app.exceptions import SourceFailure
from .audio import validate, receipt


class AlbumRefresh:
    """Flush an album on its last request item or after an idle import window."""
    def __init__(self, music, root, destinations, idle=5.0):
        self.music, self.root, self.idle = music, root.resolve(), idle
        self.folders = [album_dir_of(self.root, p.resolve() / 'placeholder.m4a') for p in destinations]
        self.remaining = Counter(self.folders)
        self.completed = set()
        self.dirty = set()
        self.timers = {}
        self.lock = threading.RLock()

    def landed(self, path):
        if self.music is None:
            return
        folder = album_dir_of(self.root, path.resolve())
        with self.lock:
            self.dirty.add(folder)
            if timer := self.timers.pop(folder, None):
                timer.cancel()
            def idle_flush():
                with self.lock:
                    if self.timers.get(folder) is timer:
                        self.flush(folder)
            timer = threading.Timer(self.idle, idle_flush)
            timer.daemon = True
            self.timers[folder] = timer
            timer.start()

    def done(self, index):
        with self.lock:
            if index in self.completed:
                return
            self.completed.add(index)
            folder = self.folders[index]
            self.remaining[folder] -= 1
            if not self.remaining[folder]:
                self.flush(folder)

    def flush(self, folder):
        with self.lock:
            if timer := self.timers.pop(folder, None):
                timer.cancel()
            if folder not in self.dirty:
                return
            try:
                refresh_folders(self.music, [folder])
            except Exception:
                # Publication succeeded. Retain the intent for final cleanup;
                # the regular scanner also recovers it after a process stop.
                logging.getLogger(__name__).exception('Album refresh failed')
            else:
                self.dirty.remove(folder)

    def close(self):
        with self.lock:
            for folder in list(self.dirty):
                self.flush(folder)


def import_file(staged, destination, *, root, incoming, recycle, expected_duration=None,
                ffmpeg='ffmpeg', timeout=300, format_report=None, **options):
    staged = safe_open_path(incoming, staged)
    try:
        report = validate(staged, expected_duration=expected_duration, ffmpeg=ffmpeg, timeout=timeout)
        provenance = receipt(staged)
        if provenance.is_file():
            saved = json.loads(safe_open_path(incoming, provenance).read_text())
            report.update({key: saved[key] for key in ('source_codec', 'transcoded', 'normalization') if key in saved})
        if format_report is not None:
            format_report.update(report)
    except SourceFailure:
        staged.unlink(missing_ok=True)
        receipt(staged).unlink(missing_ok=True)
        raise
    return publish(staged, destination, root=root, incoming=incoming, recycle=recycle, **options)


def finish_batch(music):
    if music is not None:
        invalidate_scan(music)


def replace_landed(relocator, old, new, *, recycle):
    """An explicit version replacement keeps a recoverable copy too."""
    import shutil
    import uuid
    if old.resolve() == new.resolve():
        return
    recycle.mkdir(parents=True, exist_ok=True)
    if old.is_file():
        shutil.copy2(old, recycle / f'{uuid.uuid4().hex}-{old.name}')
    relocator.replace(old, new)
