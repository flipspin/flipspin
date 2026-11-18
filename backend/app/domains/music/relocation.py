"""Move or replace library tracks and repoint their dependent records.

Repoint every path reference; replacement lyrics must match the new recording.
See docs/library-scanning.md#track-relocation.
"""
from __future__ import annotations

import dataclasses
import logging
import os
import shutil
from pathlib import Path
from collections.abc import Callable

from app.utils.filenames import clean_filename
from app.domains.music.models import AudioMetadata
from app.exceptions import MusicNotFoundError, ValidationError
from app.domains.user_library.acquisition_links import rel_path_for as user_rel_path_for
from app.utils.library_paths import album_dir_of, keys_for, require_unique_path, resolve_album
from app.utils.path_safety import safe_open_path

logger = logging.getLogger(__name__)

#: Lyric sidecars sit beside the audio with these suffixes (lyrics/repositories.py).
SIDECAR_SUFFIXES = (".lrc", ".txt")
COVER_DIR = "cover"


class RelocationConflict(ValidationError):
    """The target already holds a different file of that name (answered as 409)."""


class TrackRelocator:
    def __init__(
        self,
        *,
        base_music_dir,
        music_service,
        user_tracks=None,
        jobs_file=None,
        playlist_repository=None,
        lyrics_service: Callable[[], object | None] | None = None,
        stems_repository: Callable[[], object | None] | None = None,
        logger_: logging.Logger | None = None,
    ):
        self.base = Path(base_music_dir)
        self.music = music_service
        self.user_tracks = user_tracks
        self.jobs_file = jobs_file
        self.playlists = playlist_repository
        # Looked up per call, like `_forget_lyric` in dependencies.py: either
        # service may be rebuilt after this object is.
        self._lyrics = lyrics_service or (lambda: None)
        self._stems = stems_repository or (lambda: None)
        self.logger = logger_ or logger

    # ------------------------------------------------------------------ paths

    def library_file(self, path: str | Path) -> Path:
        """An existing audio file under the music root, or ``ValidationError``."""
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = self.base / candidate
        file_path = safe_open_path(self.base, candidate)
        if not file_path.is_file():
            raise MusicNotFoundError(f"Track not found: {path}")
        require_unique_path(self.base, file_path)
        return file_path

    def target_album_dir(self, album_dir_key: str | None, album_title: str | None) -> Path:
        """The folder a song of this album belongs in.

        An existing library album by its key (the album page knows it), or the
        folder a download of this album would land in — ``clean_filename`` of
        the title under the root, exactly what the download adapter does — so
        a moved song and a downloaded one end up side by side.
        """
        if album_dir_key:
            folder = resolve_album(self.base, album_dir_key)
            if not folder.is_dir():
                raise MusicNotFoundError(f"Album not found: {album_dir_key}")
            return folder
        name = clean_filename(album_title or "").strip()
        if not name or name in {".", ".."}:
            raise ValidationError("Falta el álbum de destino")
        return self.base / name

    # ------------------------------------------------------------------- move

    def move(
        self,
        source: Path,
        target_dir: Path,
        *,
        album_title: str | None = None,
        track_number: int | None = None,
    ) -> Path:
        """Move ``source`` into ``target_dir``, retag it, repoint every key.

        Same file name; a name already taken by another file is a conflict, not
        an overwrite. The tags follow only for MP3 (the tag writer is MP3-only);
        any other format moves untagged rather than not at all.
        """
        source = Path(source)
        target_dir = Path(target_dir)
        destination = target_dir / source.name
        require_unique_path(self.base, source)
        require_unique_path(self.base, destination)
        if source.parent.resolve() == target_dir.resolve():
            self._retag(source, album_title, track_number)
            return source
        if destination.exists():
            raise RelocationConflict(f"«{target_dir.name}» ya tiene un archivo «{source.name}»")

        target_dir.mkdir(parents=True, exist_ok=True)
        old_cover = album_dir_of(self.base, source) / COVER_DIR / "cover.jpg"
        self.music.music_repo.first_seen.get(source)
        os.replace(source, destination)
        for suffix in SIDECAR_SUFFIXES:
            sidecar = source.with_suffix(suffix)
            if sidecar.exists():
                try:
                    os.replace(sidecar, destination.with_suffix(suffix))
                except OSError as e:
                    self.logger.warning("Could not move sidecar %s: %s", sidecar, e)
        # The album's cover, if it has none: a single's art is still this
        # song's art, and a folder with no cover draws initials everywhere.
        new_cover = target_dir / COVER_DIR / "cover.jpg"
        if old_cover.is_file() and not new_cover.exists():
            try:
                new_cover.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(old_cover, new_cover)
            except OSError as e:
                self.logger.warning("Could not copy cover to %s: %s", new_cover, e)

        self.repoint(source, destination, keep_lyric=True)
        # The analysis row must already use the destination key when the shared
        # writer refreshes its tag-only signature.
        self._retag(destination, album_title, track_number)
        self.logger.info("Moved %s to %s", source, destination)
        return destination

    def _retag(self, path: Path, album_title: str | None, track_number: int | None) -> None:
        if not (album_title or track_number):
            return
        try:
            self.music.update_metadata(
                path, AudioMetadata(album=album_title or None, track_number=track_number)
            )
        except Exception as e:  # noqa: BLE001 — the move stands without new tags
            self.logger.warning("Could not retag %s: %s", path, e)

    # ---------------------------------------------------------------- replace

    def replace(self, old: Path, new: Path) -> None:
        """``new`` (a fresh download) takes ``old``'s place, and ``old`` goes.

        Rows and playlists follow the song; the old file's lyric is deleted
        with it (``MusicService.deletion_listeners``) because another version's
        timings do not fit. A download that landed on the very same path
        overwrote the old bytes already, so there is nothing left to do.
        """
        old, new = Path(old), Path(new)
        require_unique_path(self.base, old)
        require_unique_path(self.base, new)
        if old.resolve() == new.resolve():
            return
        self.repoint(old, new, keep_lyric=False)
        if old.is_file():
            self.music.delete_track(old)
        self.logger.info("Replaced %s with %s", old, new)

    # ---------------------------------------------------------------- repoint

    def repoint(self, old: Path, new: Path, *, keep_lyric: bool) -> None:
        """Every store keyed on ``old`` now says ``new``. Never raises."""
        old_rel = user_rel_path_for(self.base, old)
        new_rel = user_rel_path_for(self.base, new)
        steps = [
            ("catalog arrival time", lambda: self.music.music_repo.first_seen.repoint(self.base, old, new)),
            ("play history", lambda: self._repoint_plays(old_rel, new_rel)),
            ("user rows", lambda: self._repoint_user_rows(old_rel, new_rel)),
            ("playlists", lambda: self._repoint_playlists(old, new)),
            ("analysis row", lambda: self.music.music_repo.analysis.repoint(self.base, old, new)),
            ("scan arrival time", lambda: self.music.music_repo.scans.store.repoint(self.base, old, new)),
            ("stems", lambda: self._repoint_stems(old, new)),
        ]
        if keep_lyric:
            steps.append(("lyrics", lambda: self._repoint_lyric(old_rel, new_rel)))
        for name, step in steps:
            try:
                step()
            except Exception:  # noqa: BLE001 — the file has moved; a stale key is not worth a 500
                self.logger.exception("Could not repoint %s for %s", name, old)
        try:
            self.music.music_repo.invalidate_scan()
        except Exception:  # noqa: BLE001
            self.logger.debug("Could not invalidate the scan", exc_info=True)

    def _repoint_plays(self, old_rel: str | None, new_rel: str | None) -> None:
        if self.jobs_file is not None and self.user_tracks is not None and old_rel and new_rel:
            from app.domains.user_library.plays import repoint
            repoint(self.jobs_file, self.user_tracks, old_rel, new_rel)

    def _repoint_user_rows(self, old_rel: str | None, new_rel: str | None) -> None:
        if self.user_tracks is not None and old_rel and new_rel:
            self.user_tracks.repoint(old_rel, new_rel)

    def _repoint_playlists(self, old: Path, new: Path) -> None:
        if self.playlists is None:
            return
        old_s = {str(old), str(old.resolve())}
        new_cover = album_dir_of(self.base, new) / COVER_DIR / "cover.jpg"
        for name in self.playlists.list_playlists():
            playlist = self.playlists.load_playlist(name)
            changed = False
            for track in playlist.tracks:
                if str(track.path) in old_s:
                    track.path = new
                    track.album_cover = str(new_cover) if new_cover.exists() else track.album_cover
                    changed = True
            if changed:
                self.playlists.save_playlist(playlist)

    def _repoint_lyric(self, old_rel: str | None, new_rel: str | None) -> None:
        lyrics = self._lyrics()
        if lyrics is None or not old_rel or not new_rel:
            return
        repo = lyrics.repository
        record = repo.remove_record(old_rel)
        repo.clear_pending(old_rel)
        if record is not None:
            # Same file name, so the sidecar's name is unchanged — it moved
            # beside the audio in `move`.
            repo.put_record(dataclasses.replace(record, rel_path=new_rel))

    def _repoint_stems(self, old: Path, new: Path) -> None:
        stems = self._stems()
        if stems is None:
            return
        old_keys, new_keys = keys_for(self.base, old), keys_for(self.base, new)
        if old_keys is None or new_keys is None:
            return
        source = stems.track_dir(*old_keys)
        if source.is_dir():
            destination = stems.track_dir(*new_keys)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
