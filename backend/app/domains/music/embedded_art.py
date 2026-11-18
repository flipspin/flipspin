"""Read-only embedded pictures, materialized outside the music library."""
import base64
import binascii
import hashlib
import os
import threading
import time
from pathlib import Path

from mutagen import File as MutagenFile, MutagenError
from mutagen.flac import Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4Tags

from app.infra.files import write_bytes_atomic

MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_SUFFIXES = (".jpg", ".png", ".webp", ".gif")


def image_suffix(data: bytes) -> str | None:
    """Use bytes, never a tag's untrusted MIME label (or an APIC URL)."""
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return ".webp"
    return None


def read_picture(path: Path) -> tuple[bytes, str] | None:
    """Prefer a front cover within the file, then its first usable picture."""
    try:
        audio = MutagenFile(path)
        if audio is None:
            return None
        tags = audio.tags
        pictures = list(getattr(audio, "pictures", ()))
        if isinstance(tags, ID3):
            pictures.extend(p for p in tags.getall("APIC") if p.mime != "-->")
        elif isinstance(tags, MP4Tags):
            pictures.extend(tags.get("covr", ()))
        elif tags is not None:
            for encoded in tags.get("metadata_block_picture", ()):
                if len(encoded) > (MAX_IMAGE_BYTES + 65536) * 4 // 3 + 4:
                    continue
                try:
                    pictures.append(Picture(base64.b64decode(encoded, validate=True)))
                except (ValueError, binascii.Error, MutagenError):
                    continue
        for picture in sorted(pictures, key=lambda p: getattr(p, "type", 0) != 3):
            data = picture if isinstance(picture, bytes) else picture.data
            if not data or len(data) > MAX_IMAGE_BYTES:
                continue
            suffix = image_suffix(data)
            if suffix is not None:
                return bytes(data), suffix
    except (OSError, ValueError, MutagenError):
        # A broken tag/file must not hide the next song's picture.
        return None
    return None


class EmbeddedArtCache:
    """Revision-keyed disk cache, with bounded images and LRU disk usage."""

    def __init__(self):
        self._lock = threading.RLock()
        self._misses: dict[Path, tuple[int, int]] = {}

    def extract(self, source: Path, directory: Path, max_bytes: int) -> Path | None:
        try:
            stat = source.stat()
            stamp = (stat.st_mtime_ns, stat.st_size)
            key = hashlib.sha256(f"{source.resolve()}:{stamp}:art-v1".encode()).hexdigest()
            with self._lock:
                if self._misses.get(source) == stamp:
                    return None
                for suffix in IMAGE_SUFFIXES:
                    cached = directory / f"{key}{suffix}"
                    if cached.is_file():
                        cached_stat = cached.stat()
                        if cached_stat.st_size > min(MAX_IMAGE_BYTES, max_bytes):
                            continue
                        # LRU access must not change the public cover revision.
                        os.utime(cached, ns=(time.time_ns(), cached_stat.st_mtime_ns))
                        return cached
                picture = read_picture(source)
                if picture is None:
                    self._misses[source] = stamp
                    return None
                data, suffix = picture
                if len(data) > max_bytes:
                    return None
                # Do not publish bytes read across an external retag.
                after = source.stat()
                if (after.st_mtime_ns, after.st_size) != stamp:
                    return None
                target = directory / f"{key}{suffix}"
                write_bytes_atomic(target, data)
                self._evict(directory, max_bytes, target)
                return target
        except OSError:
            # An unavailable cache never prevents browsing the album.
            return None

    @staticmethod
    def _evict(directory: Path, max_bytes: int, current: Path) -> None:
        entries = []
        for path in directory.iterdir():
            if path.suffix not in IMAGE_SUFFIXES:
                continue
            try:
                stat = path.stat()
                entries.append((max(stat.st_atime_ns, stat.st_mtime_ns), path, stat.st_size))
            except OSError:
                continue
        total = sum(size for _, _, size in entries)
        for _, path, size in sorted(entries):
            if total <= max_bytes:
                break
            if path == current:
                continue
            try:
                path.unlink()
                total -= size
            except OSError:
                continue
