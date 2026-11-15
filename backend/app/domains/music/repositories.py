"""Music repository for file system operations."""
import logging
import os
import threading
from dataclasses import replace
from types import SimpleNamespace
from pathlib import Path
from typing import Any
from mutagen import File as MutagenFile, MutagenError

from app.config import ConfigManager
from app.infra.changes import Changes
from app.exceptions import MusicNotFoundError, FileSystemError
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.analysis_precedence import precedence, listing_analysis
from app.domains.metadata import tagreader, tagwriter
from app.domains.music.analysis_writeback import reconcile_ownership
from app.domains.music.models import Album, Track
from app.domains.music.loudness import album_values, replay_gain
from app.domains.music.embedded_art import EmbeddedArtCache
from app.domains.music.library_scan import LibraryScan
from app.domains.music.listing_cache import ListingCache
from app.domains.music.library_files import AUDIO_EXTENSIONS, walk_library as _walk_library
from app.utils.library_paths import ROOT_ALBUM_NAME, album_dir_of, disc_number, is_disc_dir, rel_path_for

def library_signature(base_dir: Path) -> tuple[Any, ...]:
    """A cheap fingerprint of the library's shape.

    Every folder under the root with its mtime — no file reads and no tag
    parsing, so it stays orders of magnitude cheaper than the scan it guards.
    A song added to ``Artist/Album/`` changes ``Album``'s mtime, which is why
    this walks the whole tree rather than the root's children: a library may
    be nested (``Artist/Album/CD1``), see ``app/utils/library_paths.py``.
    Shared with the browse ownership index.
    """
    if not base_dir.exists():
        return ()
    entries = []
    try:
        for root, _dirs, _files in _walk_library(base_dir):
            try:
                entries.append((root, os.stat(root).st_mtime_ns))
            except OSError:
                # A folder that vanished mid-walk simply is not in the
                # signature; the next call will produce a different one.
                continue
    except OSError:
        return ()
    return tuple(entries)


class MusicRepository:
    """Repository for music file system operations."""

    AUDIO_EXTENSIONS = AUDIO_EXTENSIONS

    def __init__(
        self,
        config: ConfigManager,
        logger: logging.Logger,
        analysis: AnalysisRepository | None = None,
        *, background: bool = False, changes: Changes | None = None,
    ):
        """
        Initialize music repository.

        Args:
            config: Configuration manager
            logger: Logger instance
            analysis: Music-owned analysis records; no computation runs here.
        """
        self.config = config
        self.logger = logger
        self._lock = threading.RLock()
        self.analysis_state = None
        self.analysis = analysis or AnalysisRepository(config.analysis_db)
        from app.domains.music.first_seen import FirstSeen
        self.first_seen = FirstSeen(self.analysis, config)
        self._cover_cache: dict[Path, tuple[tuple[int, int], Path | None]] = {}
        self._embedded_art = EmbeddedArtCache()
        self._tag_cache: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
        self._tag_dirty = {}
        self._tag_revision = 0
        self._owner_ghosts = None
        self._scan_context = threading.local()
        self.analysis_states = None
        self.listing_cache = ListingCache()
        self.scans = LibraryScan(self)
        self.changes = changes or Changes({
            'analysis': lambda: self.analysis.revision,
        })
        if background:
            from app.domains.music.scan_worker import ScanWorker
            self.scans.worker = ScanWorker(self)

    @property
    def tag_revision(self) -> int:
        """The published snapshot version, independent of per-file memo misses."""
        return self._tag_revision

    def invalidate_scan(self, reason='mutation') -> None:
        """Queue a refresh; retain the published snapshot while it runs."""
        self._cover_cache.clear()
        self.scans.invalidate(reason)

    def start_scanner(self):
        self.scans.start()

    def stop_scanner(self):
        if self.scans.worker:
            worker = self.scans.worker
            worker.stop()
            if not worker.thread or not worker.thread.is_alive():
                self.scans.worker = None

    def refresh(self, *, reason='changes', full=False):
        """Worker/offline entry point. Never called by a request handler."""
        return self.scans.refresh(reason=reason, full=full)

    def refresh_folders(self, paths):
        return self.scans.refresh_folders(paths)

    def scan_albums(self, base_dir=None, *, signature=None) -> list[Album]:
        """Read the published snapshot while native hints cover the current root.

        The application starts the worker in its lifespan. Standalone repository
        consumers (maintenance tools) can still run a synchronous incremental pass.
        """
        if base_dir is not None and base_dir != self.config.base_music_dir:
            return self.scans.refresh(base_dir=base_dir)
        if self.scans.watching():
            return self.scans.read()
        if self.scans.worker:
            return self.scans.read_fresh()
        return self.scans.refresh(base_dir=base_dir)

    def album_files(self, scan_dir: Path) -> dict[Path, list[Path]]:
        """Every album folder under the root and its audio files, at any depth.

        An album is a folder that holds songs. A disc folder (``CD1``) is part
        of the album above it (``library_paths.album_dir_of``). Songs loose at
        the root form one album whose physical path is the root itself.
        """
        groups: dict[Path, list[Path]] = {}
        for root, _dirs, files in _walk_library(scan_dir):
            root_path = Path(root)
            songs = sorted(
                f for f in files
                if not f.startswith(".") and Path(f).suffix.lower() in self.AUDIO_EXTENSIONS
            )
            if not songs:
                continue
            album_dir = album_dir_of(scan_dir, root_path / songs[0])
            groups.setdefault(album_dir, []).extend(root_path / f for f in songs)
        return groups

    def build_album(self, album_dir, files, scan_dir):
        tracks = self._tracks_for(album_dir, files)
        if not tracks:
            return None
        first = tracks[0]
        tags = self.read_tags(first.path)
        compilation = any(t.compilation is True for t in tracks)
        album_artist = next((t.album_artist for t in tracks if t.album_artist), None)
        return self.project_album(Album(
            name=first.album if first.album and first.album != "Unknown Album" else (
                ROOT_ALBUM_NAME if album_dir == scan_dir else album_dir.name),
            artist=album_artist or ('Various Artists' if compilation else first.artist),
            path=album_dir, tracks=tracks, cover_art=self._find_cover_art(album_dir),
            year=tags.get("year"), genre=tags.get("genre"),
            total_duration=sum(t.duration or 0 for t in tracks),
            album_artist=album_artist, compilation=compilation,
            genres=list(dict.fromkeys(g for t in tracks for g in t.genres)),
            album_sort=first.album_sort,
            album_artist_sort=next((t.album_artist_sort for t in tracks if t.album_artist_sort), None),
        ))

    def project_album(self, album):
        repository = getattr(self._scan_context, 'analysis', None) or self.analysis
        rows = []
        for track in album.tracks:
            row = repository.get(rel_path_for(self.config.base_music_dir, track.path))
            stamp = self._tag_cache[str(track.path)][0]
            rows.append(row if row and (row['mtime_ns'], row['size']) == stamp else None)
        gains = album_values(rows)
        return replace(album, tracks=[self.project_track(t, self._tag_cache[str(t.path)][1], album=gains)
                                      for t in album.tracks])

    def project_track(self, track, tags, *, album=(None, None)):
        repository = getattr(self._scan_context, 'analysis', None) or self.analysis
        rel = rel_path_for(self.config.base_music_dir, track.path)
        track = replace(track, date_added=self.first_seen.get(track.path, fallback=track.date_added))
        row = repository.get(rel)
        stamp = SimpleNamespace(st_size=tags['size'], st_mtime_ns=self._tag_cache[str(track.path)][0][0])
        row, tags = reconcile_ownership(repository, rel, row, tags, stamp)
        analysis = listing_analysis(precedence(row, tags), row)
        measured = row if row and not row.get('error') and (row['size'], row['mtime_ns']) == (stamp.st_size, stamp.st_mtime_ns) else None
        gain = replay_gain(measured, tags, album)
        if gain is not None:
            analysis['replayGain'] = gain
        states = getattr(self._scan_context, 'states', None)
        analysis['analysisState'] = (
            'analyzed' if row and row.get('analyzed_at') else
            states.get(rel, 'failed' if row and row.get('error') else 'none') if states is not None else
            self.analysis_state(rel, track.path, row) if self.analysis_state else
            'failed' if row and row.get('error') else 'none')
        return replace(track, bpm=analysis['bpm'], key=analysis['key_name'], mood=analysis['mood'], analysis=analysis)

    def _tracks_for(self, album_dir: Path, files: list[Path]) -> list[Track]:
        tracks = []
        for file_path in files:
            try:
                tracks.append(self.get_track_info(file_path))
            except Exception as e:
                self.logger.warning(f"Could not read track {file_path}: {e}")

        def order(t: Track):
            return (t.disc_number or 1, t.track_number if t.track_number is not None else 9999, t.title)

        tracks.sort(key=order)
        return tracks

    def get_album_tracks(self, album_path: Path) -> list[Track]:
        """All tracks of one album folder, its disc folders included."""
        if not album_path.exists() or not album_path.is_dir():
            raise MusicNotFoundError(f"Album directory not found: {album_path}")
        files: list[Path] = []
        for child in sorted(album_path.iterdir()):
            if child.name.startswith("."):
                continue
            if child.is_file() and child.suffix.lower() in self.AUDIO_EXTENSIONS:
                files.append(child)
            elif (
                album_path.resolve() != self.config.base_music_dir.resolve()
                and child.is_dir()
                and album_dir_of(album_path.parent, child / "x") == album_path
            ):
                files.extend(
                    f for f in sorted(child.iterdir())
                    if f.is_file() and not f.name.startswith(".") and f.suffix.lower() in self.AUDIO_EXTENSIONS
                )
        return self._tracks_for(album_path, files)

    def read_tags(self, track_path: Path) -> dict[str, Any]:
        """The tags this app reads from one file, memoized on mtime, size and ctime."""
        stat = track_path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
        key = str(track_path)
        hit = self._tag_cache.get(key)
        force = getattr(self._scan_context, 'full', False)
        loaded = getattr(self._scan_context, 'loaded', set())
        if hit is not None and hit[0] == stamp and hit[1].get('_ctime_ns') == stat.st_ctime_ns and (not force or key in loaded):
            return hit[1]
        tags: dict[str, Any] = {"mtime": stat.st_mtime, "size": stat.st_size, "_ctime_ns": stat.st_ctime_ns}
        audio = MutagenFile(str(track_path))
        if audio is not None:
            tags["duration"] = audio.info.length if audio.info else None
            if audio.tags:
                # WAV's optional ID3 tags use the same table, though it is not writable.
                mode = tagwriter.FORMATS.get(track_path.suffix.lower(), 0)
                tags.update(tagreader.read(audio.tags, mode))
            if track_path.suffix.lower() == '.opus':
                with track_path.open('rb') as stream:
                    header = stream.read(64)
                offset = header.find(b'OpusHead')
                if offset >= 0 and len(header) >= offset + 18:
                    tags['baseGain'] = int.from_bytes(header[offset + 16:offset + 18], 'little', signed=True) / 256
        if track_path.suffix.lower() in tagwriter.FORMATS:
            try:
                tags['_missingTagSha'] = tagwriter.identity(track_path)['tagSha']
            except (MutagenError, tagwriter.TagError):
                # A missing move signature must not hide an otherwise readable
                # song. Manual location remains available without guessing.
                self.logger.debug('Move identity unavailable for %s', track_path)
        with self._lock:
            self._tag_cache[key] = (stamp, tags)
            self._tag_dirty[key] = self._tag_cache[key]
            if force:
                loaded.add(key)
        return tags

    def get_track_info(self, track_path: Path) -> Track:
        """
        Get information about a specific track.
        
        Args:
            track_path: Path to track file
            
        Returns:
            Track object
        """
        if not track_path.exists():
            raise MusicNotFoundError(f"Track not found: {track_path}")
        
        try:
            tags = self.read_tags(track_path)
            title = tags.get("title") or track_path.stem
            artist = tags.get("artist") or "Unknown Artist"
            album = tags.get("album") or "Unknown Album"
            track_number = tags.get("track_number")
            duration = tags.get("duration")
            genre = tags.get("genre")
            file_size = tags["size"]
            date_added = self.first_seen.get(track_path)

            track = Track(
                title=title,
                artist=artist,
                album=album,
                path=track_path,
                track_number=track_number,
                duration=duration,
                file_size=file_size,
                date_added=date_added,
                genre=genre,
                isrc=tags.get("isrc"),
                artists=tags.get('artists', []), genres=tags.get('genres', []),
                album_artist=tags.get('album_artist'), album_artists=tags.get('album_artists', []),
                disc_number=tags.get('disc_number') or (
                    disc_number(track_path.parent.name)
                    if track_path.parent != album_dir_of(self.config.base_music_dir, track_path) else None),
                compilation=tags.get('compilation'), year=tags.get('year'),
                **{attr: tags.get(attr) for attr in tagreader.SORT_FIELDS.values()},
            )
            return self.project_track(track, tags)
            
        except Exception as e:
            self.logger.error(f"Error reading track info: {e}")
            raise FileSystemError(f"Failed to read track info: {str(e)}")
    
    def file_exists(self, path: Path) -> bool:
        """Check if a file exists."""
        return path.exists() and path.is_file()
    
    def forget_file(self, path: Path) -> None:
        """Discard cached tags, analysis and listings for a deleted file."""
        with self._lock:
            for key in {str(path), str(path.resolve())}:
                self._tag_cache.pop(key, None)
                self._tag_dirty.pop(key, None)
        self.analysis.forget_file(self.config.base_music_dir, path)
        self.scans.allow_empty = True
        self.scans.store.forget_file(self.config.base_music_dir, path)
        self.invalidate_scan()

    def delete_file(self, path: Path) -> None:
        """Delete a file."""
        if not path.exists():
            raise MusicNotFoundError(f"File not found: {path}")
        
        try:
            path.unlink()
            self.logger.info(f"Deleted file: {path}")
        except Exception as e:
            self.logger.error(f"Error deleting file {path}: {e}")
            raise FileSystemError(f"Failed to delete file: {str(e)}")
    
    def move_file(self, source: Path, destination: Path) -> None:
        """Move a file to a new location."""
        if not source.exists():
            raise MusicNotFoundError(f"Source file not found: {source}")
        
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            self.first_seen.get(source)
            source.rename(destination)
            self.first_seen.repoint(self.config.base_music_dir, source, destination)
            self.logger.info(f"Moved file from {source} to {destination}")
        except Exception as e:
            self.logger.error(f"Error moving file: {e}")
            raise FileSystemError(f"Failed to move file: {str(e)}")
    
    def _find_cover_art(self, album_dir: Path) -> Path | None:
        """Find cover art in album directory.

        Memoized per directory: the lookup is up to eight ``glob`` calls (each a
        full ``scandir``), and the cover route runs it once per cover request —
        a 181-album grid was ~1,400 directory scans. The stamp is the mtime of
        the album directory and of its ``cover/`` subdirectory, which is what
        changes when a cover file is added, removed or renamed in either.
        """
        cover_dir = album_dir / "cover"
        try:
            stamp = (album_dir.stat().st_mtime_ns, cover_dir.stat().st_mtime_ns if cover_dir.is_dir() else 0)
        except OSError:
            stamp = None
        found = None
        if stamp is not None:
            hit = self._cover_cache.get(album_dir)
            if hit is not None and hit[0] == stamp:
                found = hit[1]
            else:
                found = self._find_cover_art_uncached(album_dir)
                self._cover_cache[album_dir] = (stamp, found)
        if found is not None:
            return found
        # Directory mtimes do not notice an in-place tag edit. Always check
        # candidate audio revisions when no folder image exists.
        base = self.config.base_music_dir
        cache_dir = getattr(self.config, 'cover_cache_dir', None)
        if cache_dir is None:
            return None  # A config without a cover cache (tests, older setups) skips embedded art.
        for root, dirs, files in _walk_library(album_dir):
            dirs[:] = [d for d in dirs if is_disc_dir(d)]
            for name in sorted(files):
                source = Path(root) / name
                if name.startswith(".") or source.suffix.lower() not in self.AUDIO_EXTENSIONS:
                    continue
                if album_dir_of(base, source) != album_dir or rel_path_for(base, source) is None:
                    continue
                cached = self._embedded_art.extract(
                    source, cache_dir / "embedded", getattr(self.config, "cover_cache_mb", 200) * 1024 * 1024,
                )
                if cached is not None:
                    return cached
        return None

    def _find_cover_art_uncached(self, album_dir: Path) -> Path | None:
        cover_dir = album_dir / "cover"
        if cover_dir.exists():
            for ext in [".jpg", ".jpeg", ".png", ".webp"]:
                for cover_file in cover_dir.glob(f"*{ext}"):
                    return cover_file
        
        for ext in [".jpg", ".jpeg", ".png", ".webp"]:
            for cover_file in album_dir.glob(f"*{ext}"):
                return cover_file
        
        return None
