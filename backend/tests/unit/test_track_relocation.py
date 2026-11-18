"""TrackRelocator: a song moved or replaced takes every path-keyed store along.

Real stores on a tmp library — user rows, playlists, the lyrics index and its
sidecar — because the whole point of this module is that nothing is left
pointing at a path that no longer exists, and a mock would only prove the
calls were made.
"""
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.lyrics.models import LyricsRecord
from app.domains.lyrics.repositories import LyricsRepository
from app.domains.music.relocation import RelocationConflict, TrackRelocator
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.domains.playlists.repositories import PlaylistRepository
from app.domains.user_library.store import UserTrackStore

LOG = logging.getLogger("test.relocation")
ANA, LUIS = "u-ana", "u-luis"


@pytest.fixture
def lib(tmp_path):
    music = tmp_path / "Music"
    single = music / "Dientes De Fierro"
    album = music / "Mil Problemas"
    (single / "cover").mkdir(parents=True)
    album.mkdir(parents=True)
    song = single / "01 - Dientes De Fierro.mp3"
    song.write_bytes(b"ID3 single")
    (single / "cover" / "cover.jpg").write_bytes(b"jpg")
    song.with_suffix(".lrc").write_text("[00:01.00] hola\n", encoding="utf-8")

    config = SimpleNamespace(
        base_music_dir=music,
        playlist_dir=tmp_path / "playlists",
        lyrics_file=tmp_path / "lyrics.json",
    )
    users = UserTrackStore(tmp_path / "user_tracks.json")
    playlists = PlaylistRepository(config, LOG)
    lyrics = SimpleNamespace(repository=LyricsRepository(config, LOG))
    music_repo = Mock()
    music_service = Mock(music_repo=music_repo)
    music_service.delete_track.side_effect = lambda p: Path(p).unlink()
    relocator = TrackRelocator(
        base_music_dir=music,
        music_service=music_service,
        user_tracks=users,
        playlist_repository=playlists,
        lyrics_service=lambda: lyrics,
        logger_=LOG,
    )
    return SimpleNamespace(
        music=music, single=single, album=album, song=song, users=users,
        playlists=playlists, lyrics=lyrics.repository, music_service=music_service,
        relocator=relocator,
    )


def _seed(lib, path: Path, rel: str):
    lib.users.add_many(ANA, [rel])
    lib.users.add_many(LUIS, [rel])
    lib.users.record_play(ANA, rel)
    lib.playlists.save_playlist(
        Playlist(name="Fiesta", tracks=[PlaylistTrack(path=path, title="Dientes De Fierro")])
    )


def test_move_takes_rows_playlists_lyric_and_cover(lib):
    old_rel = "Dientes De Fierro/01 - Dientes De Fierro.mp3"
    _seed(lib, lib.song, old_rel)
    lib.lyrics.put_record(LyricsRecord(rel_path=old_rel, kind="synced", source="lrclib",
                                       sidecar="01 - Dientes De Fierro.lrc"))

    moved = lib.relocator.move(lib.song, lib.album, album_title="Mil Problemas", track_number=3)

    new_rel = "Mil Problemas/01 - Dientes De Fierro.mp3"
    assert moved == lib.album / lib.song.name and moved.read_bytes() == b"ID3 single"
    assert not lib.song.exists()
    assert moved.with_suffix(".lrc").exists(), "the sidecar travels beside the audio"
    assert (lib.album / "cover" / "cover.jpg").exists(), "an album without art borrows the single's"
    assert lib.users.get(ANA, old_rel) is None
    assert lib.users.get(ANA, new_rel).play_count == 1
    assert lib.users.get(LUIS, new_rel) is not None, "every user's row follows, not just the caller's"
    assert lib.playlists.load_playlist("Fiesta").tracks[0].path == moved
    assert lib.lyrics.get_record(old_rel) is None
    assert lib.lyrics.get_record(new_rel).sidecar == "01 - Dientes De Fierro.lrc"
    lib.music_service.update_metadata.assert_called_once()


def test_move_refuses_to_overwrite_another_file(lib):
    (lib.album / lib.song.name).write_bytes(b"other")
    with pytest.raises(RelocationConflict):
        lib.relocator.move(lib.song, lib.album, album_title="Mil Problemas")
    assert lib.song.exists()


def test_move_by_title_lands_where_a_download_would(lib):
    target = lib.relocator.target_album_dir(None, "Mil Problemas: Deluxe?")
    assert target == lib.music / "Mil Problemas Deluxe"


def test_replace_repoints_then_deletes_the_old_version(lib):
    old_rel = "Dientes De Fierro/01 - Dientes De Fierro.mp3"
    _seed(lib, lib.song, old_rel)
    new = lib.album / "03 - Dientes De Fierro.mp3"
    new.write_bytes(b"ID3 album cut")
    lib.users.add_many(ANA, ["Mil Problemas/03 - Dientes De Fierro.mp3"])

    lib.relocator.replace(lib.song, new)

    new_rel = "Mil Problemas/03 - Dientes De Fierro.mp3"
    assert not lib.song.exists()
    lib.music_service.delete_track.assert_called_once_with(lib.song)
    merged = lib.users.get(ANA, new_rel)
    assert merged.play_count == 1, "a user holding both keeps one row with the plays summed"
    assert lib.users.get(LUIS, new_rel) is not None
    assert lib.playlists.load_playlist("Fiesta").tracks[0].path == new


def test_replace_onto_the_same_path_deletes_nothing(lib):
    lib.relocator.replace(lib.song, lib.song)
    assert lib.song.exists()
    lib.music_service.delete_track.assert_not_called()


def test_acquire_replaces_only_what_landed(lib):
    from app.domains.browse.acquisition import AcquireTrack, _replace_landed
    from app.domains.downloads.models import DownloadResult

    new = lib.album / "03 - Dientes De Fierro.mp3"
    new.write_bytes(b"ID3 album cut")
    wanted = [
        AcquireTrack(title="Dientes De Fierro", replaces=str(lib.song)),
        AcquireTrack(title="Otra", replaces=str(lib.song)),
    ]
    results = [DownloadResult(success=False), DownloadResult(success=True, file_path=new)]
    # Only the second landed, and it is positional: the first's failure must
    # not delete anything on its behalf.
    _replace_landed(lib.relocator, wanted[:1], results[:1])
    assert lib.song.exists(), "a failed download deletes nothing"
    _replace_landed(lib.relocator, wanted, results)
    assert not lib.song.exists()
