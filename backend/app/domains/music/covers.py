"""On-demand JPEG thumbnails and playlist tiles. One cache per server, shared by sync route threads."""
import hashlib
import json
import logging
import os
import subprocess
import threading
from collections.abc import Callable
from contextlib import contextmanager
from enum import IntEnum
from pathlib import Path
from weakref import WeakValueDictionary

from app.exceptions import ConfigurationError, ValidationError
from app.infra.ffmpeg import resolve_ffmpeg
from app.infra.files import write_bytes_atomic
from app.utils.path_safety import resolve_under

logger = logging.getLogger(__name__)
_RESIZES = threading.Semaphore(os.cpu_count() or 1)


class CoverSize(IntEnum):
    SMALL = 64
    ROW = 96
    MEDIUM = 128
    LARGE = 300


def source_version(stat: os.stat_result) -> str:
    """A URL-safe revision shared by the listing and media route."""
    return hashlib.sha1(f"{stat.st_mtime_ns}:{stat.st_size}".encode()).hexdigest()[:12]


def cover_version(path: str | Path | None) -> str | None:
    if path is None:
        return None
    try:
        return source_version(Path(path).stat())
    except OSError:
        return None


class CoverCache:
    def __init__(self, directory: Path, max_bytes: int):
        self.directory = directory
        self.max_bytes = max_bytes
        self._guard = threading.RLock()
        # Waiters keep a strong reference; idle locks disappear automatically.
        self._locks: WeakValueDictionary = WeakValueDictionary()
        self._failed: set[str] = set()
        self._active: dict[Path, int] = {}

    def _key_lock(self, key: str):
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def thumbnail(self, source: Path, size: int, stat: os.stat_result):
        """Lease a cached file until FileResponse finishes opening/streaming it.

        An undecodable revision falls back for every size without repeated logs
        or subprocesses. A replacement (mtime/size change) is tried again.
        """
        identity = f"{source}:{stat.st_mtime_ns}:{stat.st_size}"
        key = hashlib.sha1(f"{identity}:{size}:jpeg-q4-v1".encode()).hexdigest()
        return self._cached(identity, key, lambda: self._resize(source, size), source)

    def mosaic(self, sources: list[Path], size: int):
        """A square 2×2 JPEG, keyed by ordered source paths, revisions and size."""
        identity = json.dumps([(str(p), cover_version(p)) for p in sources])
        key = hashlib.sha1(f"{identity}:{size}:mosaic-jpeg-q4-v1".encode()).hexdigest()
        return self._cached(identity, key, lambda: self._mosaic(sources, size), "playlist tile")

    @contextmanager
    def _cached(self, identity: str, key: str, generate: Callable[[], bytes], label: str | Path):
        target = None
        leased = False
        try:
            with self._key_lock(key):
                with self._guard:
                    failed = identity in self._failed
                if not failed:
                    try:
                        self.directory.mkdir(parents=True, exist_ok=True)
                        target = resolve_under(self.directory, f"{key}.jpg")
                        with self._guard:
                            exists = target.is_file()
                            if exists:
                                self._pin(target)
                                leased = True
                        if not exists:
                            data = generate()
                            with self._guard:
                                write_bytes_atomic(target, data)
                                self._pin(target)
                                leased = True
                                # Only a write can push the cache past its cap, so only a
                                # write pays for the directory walk (a hit stays O(1)).
                                self._evict()
                    except (OSError, ValueError, subprocess.SubprocessError, ConfigurationError, ValidationError) as exc:
                        with self._guard:
                            if identity not in self._failed:
                                logger.warning("Could not resize cover %s; serving original: %s", label, exc)
                                self._failed.add(identity)
            yield (target, f'"{key}"') if leased else None
        finally:
            if leased:
                with self._guard:
                    self._active[target] -= 1
                    if not self._active[target]:
                        del self._active[target]

    @staticmethod
    def _resize(source: Path, size: int) -> bytes:
        # q:v 4 is roughly JPEG quality 80. A single frame and map_metadata -1
        # drop animations/EXIF; 444 supports odd dimensions without rounding up.
        factor = f"min(1,{size}/max(iw,ih))"
        scale = f"scale=w='max(1,round(iw*{factor}))':h='max(1,round(ih*{factor}))'"
        with _RESIZES:
            result = subprocess.run(
                [resolve_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error",
                 "-threads", "1", "-i", str(source), "-vf", scale, "-frames:v", "1",
                 "-map_metadata", "-1", "-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj444p",
                 "-threads", "1", "-f", "image2pipe", "pipe:1"],
                capture_output=True, timeout=15, check=True,
            )
        if not result.stdout.startswith(b"\xff\xd8") or not result.stdout.endswith(b"\xff\xd9"):
            raise ValueError("ffmpeg produced no JPEG")
        return result.stdout

    @staticmethod
    def _mosaic(sources: list[Path], size: int) -> bytes:
        # Crop like the desktop's object-cover; scale once more for odd sizes.
        cell = (size + 1) // 2
        filters = [
            f"[{i}:v]scale={cell}:{cell}:force_original_aspect_ratio=increase,"
            f"crop={cell}:{cell},setsar=1[c{i}]" for i in range(4)
        ]
        filters.append(
            f"[c0][c1][c2][c3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale={size}:{size}[out]"
        )
        inputs = [arg for source in sources for arg in ("-threads", "1", "-i", str(source))]
        with _RESIZES:
            result = subprocess.run(
                [resolve_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", *inputs,
                 "-filter_complex_threads", "1", "-filter_complex", ";".join(filters), "-map", "[out]",
                 "-frames:v", "1", "-map_metadata", "-1", "-c:v", "mjpeg", "-q:v", "4",
                 "-pix_fmt", "yuvj444p", "-threads", "1", "-f", "image2pipe", "pipe:1"],
                capture_output=True, timeout=15, check=True,
            )
        if not result.stdout.startswith(b"\xff\xd8") or not result.stdout.endswith(b"\xff\xd9"):
            raise ValueError("ffmpeg produced no JPEG")
        return result.stdout

    def _pin(self, target: Path) -> None:
        # Explicitly touch hits: relatime/noatime mounts must still evict LRU.
        os.utime(target, None)
        self._active[target] = self._active.get(target, 0) + 1

    def _evict(self) -> None:
        """Called under _guard. Active responses may exceed the cap until close."""
        entries = []
        for path in self.directory.glob("*.jpg"):
            try:
                stat = path.stat()
                entries.append((max(stat.st_atime_ns, stat.st_mtime_ns), path, stat.st_size))
            except OSError:
                continue
        total = sum(entry[2] for entry in entries)
        for _, path, size in sorted(entries):
            if total <= self.max_bytes:
                break
            if path in self._active:
                continue
            try:
                path.unlink()
                total -= size
            except OSError:
                continue
