"""Store complete splits outside the music tree so library scans cannot see them.

Stage manifests and four Opus files in .incoming, then publish with renames.
Validate request paths and reject dot segments to keep staging inaccessible.
The old queue path exists only for the SQLite migration.
"""
from __future__ import annotations

import json
import logging
import shutil
import stat
import threading
import uuid
from pathlib import Path
from typing import Any

from app.config import ConfigManager
from app.infra.files import write_json_atomic
from app.domains.stems.models import MANIFEST_NAME, STEM_SUFFIX, STEMS
from app.exceptions import KrobiException, ValidationError
from app.utils.library_paths import ROOT_ALBUM_DIR, ROOT_ALBUM_KEY, album_storage_name, resolve_track
from app.utils.path_safety import resolve_under

INCOMING = ".incoming"


class StemsNotFoundError(KrobiException):
    def __init__(self, message: str):
        super().__init__(message, "STEMS_NOT_FOUND")


def _check_segments(*segments: str) -> None:
    for segment in segments:
        if not segment or segment.startswith("."):
            raise ValidationError("Path segment cannot be empty or start with '.'")


class StemsRepository:
    def __init__(self, config: ConfigManager, logger: logging.Logger):
        self.config = config
        self.logger = logger
        self._list_lock = threading.Lock()
        self._list_stamp: tuple | None = None
        self._manifests: list[tuple[str, str, dict[str, Any]]] = []

    # ------------------------------------------------------------- paths

    @property
    def root(self) -> Path:
        # Read from config every time: tests (and a relocated data dir) change it.
        root = Path(self.config.stems_dir)
        root.mkdir(parents=True, exist_ok=True)
        return root

    @property
    def queue_file(self) -> Path:
        return Path(self.config.lyrics_file).parent / "stems-queue.json"

    def audio_path(self, album: str, file: str) -> Path:
        """The library file. Raises :class:`StemsNotFoundError` when it is not one."""
        try:
            _check_segments(album, file)
            path = resolve_track(Path(self.config.base_music_dir), album, file)
            if not path.is_file():
                raise StemsNotFoundError(f"Track not found: {album}/{file}")
        except (ValidationError, OSError) as e:
            raise StemsNotFoundError(str(e)) from e
        return path

    def track_dir(self, album: str, file: str) -> Path:
        """Raises ``ValidationError`` on a traversal attempt."""
        _check_segments(album, file)
        try:
            return resolve_under(self.root, album_storage_name(album), file)
        except OSError as e:
            raise StemsNotFoundError(f"No stems requested for {album}/{file}") from e

    # -------------------------------------------------------------- read

    def manifests(self) -> list[tuple[str, str, dict[str, Any]]]:
        """Memoize the manifest walk on directory mtimes at all three levels.

        Checking album and track directories catches additions to an existing
        album and atomic replacements even when the root mtime is unchanged.
        Staging and symlinks are excluded from the shared listing and bulk delete.
        """
        with self._list_lock:
            root = self.root
            stamps = [(str(root), root.stat().st_mtime_ns)]
            tracks = []
            for album in sorted(root.iterdir()):
                if album.name.startswith(".") and album.name != ROOT_ALBUM_DIR:
                    continue
                if album.is_symlink() or not album.is_dir():
                    continue
                album_key = ROOT_ALBUM_KEY if album.name == ROOT_ALBUM_DIR else album.name
                try:
                    stamps.append((str(album), album.stat().st_mtime_ns))
                    for track in sorted(album.iterdir()):
                        if track.name.startswith(".") or track.is_symlink() or not track.is_dir():
                            continue
                        try:
                            stamps.append((str(track), track.stat().st_mtime_ns))
                            tracks.append((album_key, track.name))
                        except FileNotFoundError:
                            continue  # a concurrent publish/delete; the next stamp will differ
                except FileNotFoundError:
                    continue
            stamp = tuple(stamps)
            if stamp != self._list_stamp:
                manifests = []
                for album, file in tracks:
                    manifest = self.manifest(album, file)
                    if manifest is not None:
                        manifests.append((album, file, manifest))
                self._manifests = manifests
                self._list_stamp = stamp
            return list(self._manifests)

    def manifest(self, album: str, file: str) -> dict[str, Any] | None:
        path = self.track_dir(album, file) / MANIFEST_NAME
        try:
            if not path.is_file():
                return None
        except OSError as e:
            raise StemsNotFoundError(f"No stems requested for {album}/{file}") from e
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            self.logger.warning("stems manifest %s unreadable: %s", path, e)
            return None
        return data if isinstance(data, dict) else None

    def stem_path(self, album: str, file: str, stem: str) -> Path | None:
        if stem not in STEMS:
            return None
        path = self.track_dir(album, file) / f"{stem}{STEM_SUFFIX}"
        try:
            return path if path.is_file() else None
        except OSError:
            return None

    def size_bytes(self, album: str, file: str) -> int:
        """Stat only the five stored split files; refresh independently of manifests."""
        directory = self.track_dir(album, file)
        total = 0
        for name in (MANIFEST_NAME, *(f"{stem}{STEM_SUFFIX}" for stem in STEMS)):
            try:
                info = (directory / name).stat(follow_symlinks=False)
            except FileNotFoundError:
                continue  # a concurrent publish/delete; missing files contribute zero
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
        return total

    # ------------------------------------------------------------- write

    def publish(self, album: str, file: str, manifest: dict[str, Any], files: dict[str, Path]) -> Path:
        """Move ``files`` (stem → source path) and the manifest into place, atomically per track."""
        target = self.track_dir(album, file)
        missing = [s for s in STEMS if s not in files]
        if missing:
            raise ValueError(f"missing stems: {', '.join(missing)}")
        incoming = self.root / INCOMING
        staging = incoming / uuid.uuid4().hex
        staging.mkdir(parents=True)
        try:
            for stem in STEMS:
                shutil.move(str(files[stem]), str(staging / f"{stem}{STEM_SUFFIX}"))
            write_json_atomic(staging / MANIFEST_NAME, manifest)
            target.parent.mkdir(parents=True, exist_ok=True)
            old = None
            if target.exists():
                old = incoming / f"old-{uuid.uuid4().hex}"
                target.rename(old)
            staging.rename(target)
            if old is not None:
                shutil.rmtree(old, ignore_errors=True)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        return target

    def delete(self, album: str, file: str) -> bool:
        target = self.track_dir(album, file)
        if not target.exists():
            return False
        shutil.rmtree(target)
        try:
            target.parent.rmdir()  # the album dir, when it was the last track
        except OSError:
            pass
        return True
