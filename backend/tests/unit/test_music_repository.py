"""Unit tests for MusicRepository."""
import pytest
from unittest.mock import Mock, patch
from app.domains.music.repositories import MusicRepository
from app.exceptions import MusicNotFoundError


@pytest.fixture
def mock_config(tmp_path):
    """Create mock config."""
    config = Mock()
    config.base_music_dir = tmp_path / "music"
    config.base_music_dir.mkdir(parents=True, exist_ok=True)
    config.temp_dir = tmp_path / "temp"
    config.temp_dir.mkdir(parents=True, exist_ok=True)
    config.analysis_db = tmp_path / "analysis.sqlite"
    config.jobs_file = tmp_path / "jobs.sqlite"
    config.cover_cache_dir = tmp_path / "cache" / "covers"
    config.cover_cache_mb = 200
    config.analysis_workers = 2
    config.enable_waveform_cache = True
    return config


@pytest.fixture
def mock_logger():
    """Create mock logger."""
    return Mock()


@pytest.fixture
def music_repo(mock_config, mock_logger):
    """Create MusicRepository instance."""
    return MusicRepository(mock_config, mock_logger)


def test_scan_albums_empty_directory(music_repo, mock_config):
    """Test scanning empty music directory."""
    albums = music_repo.scan_albums()
    assert albums == []


def test_scan_albums_with_albums(music_repo, mock_config, tmp_path):
    """Test scanning directory with albums."""
    # Create test album structure
    album_dir = mock_config.base_music_dir / "Test Album"
    album_dir.mkdir()
    
    test_file = album_dir / "test.mp3"
    test_file.write_text("fake audio data")
    
    # Mock mutagen to avoid needing real audio files
    with patch('app.domains.music.repositories.MutagenFile') as mock_mutagen:
        mock_audio = Mock()
        mock_audio.info.length = 180.0
        mock_audio.tags = {
            'TIT2': Mock(text=['Test Song']),
            'TPE1': Mock(text=['Test Artist']),
            'TALB': Mock(text=['Test Album'])
        }
        mock_mutagen.return_value = mock_audio
        
        albums = music_repo.scan_albums()
        
        assert len(albums) == 1
        assert albums[0].name == "Test Album"
        assert len(albums[0].tracks) == 1


def test_get_track_info_file_not_found(music_repo, tmp_path):
    """Test getting track info for non-existent file."""
    non_existent = tmp_path / "nonexistent.mp3"
    
    with pytest.raises(MusicNotFoundError):
        music_repo.get_track_info(non_existent)


def test_file_exists(music_repo, tmp_path):
    """Test file existence check."""
    test_file = tmp_path / "test.mp3"
    test_file.write_text("test")
    
    assert music_repo.file_exists(test_file) is True
    assert music_repo.file_exists(tmp_path / "nonexistent.mp3") is False


def test_delete_file(music_repo, tmp_path):
    """Test file deletion."""
    test_file = tmp_path / "test.mp3"
    test_file.write_text("test")
    
    assert test_file.exists()
    music_repo.delete_file(test_file)
    assert not test_file.exists()


def test_delete_file_not_found(music_repo, tmp_path):
    """Test deleting non-existent file raises error."""
    non_existent = tmp_path / "nonexistent.mp3"
    
    with pytest.raises(MusicNotFoundError):
        music_repo.delete_file(non_existent)


def test_move_file(music_repo, tmp_path):
    """Test moving file."""
    source = tmp_path / "source.mp3"
    destination = tmp_path / "dest" / "moved.mp3"

    source.write_text("test")

    music_repo.move_file(source, destination)

    assert not source.exists()
    assert destination.exists()
    assert destination.read_text() == "test"


# ── Memoized scan ─────────────────────────────────────────────────────────────

def _fake_audio():
    audio = Mock()
    audio.info.length = 180.0
    audio.tags = {
        'TIT2': Mock(text=['Song']),
        'TPE1': Mock(text=['Artist']),
        'TALB': Mock(text=['Album']),
    }
    return audio


def _add_album(base, name, files=("a.mp3",)):
    album = base / name
    album.mkdir(exist_ok=True)
    for f in files:
        (album / f).write_text("fake audio")
    return album


def test_scan_albums_is_memoized_while_the_library_keeps_its_shape(music_repo, mock_config):
    """Two calls with nothing changed open the files once, not twice."""
    _add_album(mock_config.base_music_dir, "One")
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()) as mutagen:
        first = music_repo.scan_albums()
        opens = mutagen.call_count
        second = music_repo.scan_albums()
    assert opens > 0
    assert mutagen.call_count == opens
    assert second is first


def test_scan_albums_rescans_when_an_album_appears(music_repo, mock_config):
    """A new album directory changes the signature and defeats the memo."""
    _add_album(mock_config.base_music_dir, "One")
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()):
        assert len(music_repo.scan_albums()) == 1
        _add_album(mock_config.base_music_dir, "Two")
        assert len(music_repo.scan_albums()) == 2


def test_invalidation_projects_without_rereading_unchanged_folders(music_repo, mock_config):
    _add_album(mock_config.base_music_dir, "One")
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()), \
         patch.object(music_repo, 'build_album', wraps=music_repo.build_album) as build:
        music_repo.scan_albums()
        music_repo.invalidate_scan()
        music_repo.scan_albums()
    assert build.call_count == 1


def test_analysis_changes_project_without_a_disk_rescan(music_repo, mock_config):
    _add_album(mock_config.base_music_dir, "One")
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()), \
         patch.object(music_repo, 'build_album', wraps=music_repo.build_album) as build:
        music_repo.scan_albums()
        with music_repo.analysis.connection() as db:
            db.execute("INSERT INTO track_analysis (rel_path, bpm) VALUES ('One/a.mp3', 128)")
        assert music_repo.scan_albums()[0].tracks[0].bpm == 128
    assert build.call_count == 1


def test_unchanged_snapshot_does_not_expire(music_repo, mock_config):
    _add_album(mock_config.base_music_dir, "One")
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()):
        first = music_repo.scan_albums()
        with patch('app.domains.music.library_scan.time.perf_counter', return_value=1_000_000):
            assert music_repo.scan_albums() is first


# ── Any library layout ───────────────────────────────────────────────────────

def test_a_nested_library_is_found_at_any_depth(music_repo, mock_config):
    """``Artist/Album/song`` — the layout most existing libraries have."""
    base = mock_config.base_music_dir
    (base / "Daft Punk").mkdir()
    _add_album(base / "Daft Punk", "Discovery", files=("01.mp3", "02.mp3"))
    _add_album(base, "Flat", files=("a.mp3",))
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()):
        albums = {a.path.name: a for a in music_repo.scan_albums()}
    assert set(albums) == {"Discovery", "Flat"}
    assert len(albums["Discovery"].tracks) == 2


def test_disc_folders_belong_to_the_album_above(music_repo, mock_config):
    base = mock_config.base_music_dir
    album = base / "Pink Floyd" / "The Wall"
    album.mkdir(parents=True)
    for disc in ("CD1", "CD2"):
        _add_album(album, disc, files=("01.flac", "02.flac"))
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()):
        albums = music_repo.scan_albums()
    assert [a.path for a in albums] == [album]
    assert [t.path.parent.name for t in albums[0].tracks] == ["CD1", "CD1", "CD2", "CD2"]


def test_a_song_added_deep_in_the_tree_defeats_the_memo(music_repo, mock_config):
    base = mock_config.base_music_dir
    (base / "Artist").mkdir()
    album = _add_album(base / "Artist", "Album")
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()):
        assert len(music_repo.scan_albums()[0].tracks) == 1
        (album / "b.mp3").write_text("fake audio")
        assert len(music_repo.scan_albums()[0].tracks) == 2


def test_a_rescan_reads_only_the_files_that_changed(music_repo, mock_config):
    """The tag cache: what makes a 100k-song rescan affordable."""
    album = _add_album(mock_config.base_music_dir, "One", files=("a.mp3", "b.mp3"))
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()) as mutagen:
        music_repo.scan_albums()
        first = mutagen.call_count
        music_repo.invalidate_scan()
        music_repo.scan_albums()
        assert mutagen.call_count == first
        # A retag rewrites the file: new mtime and size, read again.
        (album / "a.mp3").write_text("retagged audio")
        music_repo.invalidate_scan()
        music_repo.scan_albums()
    assert mutagen.call_count > first


# ── Cover lookup memo ────────────────────────────────────────────────────────

def test_find_cover_art_is_memoized_per_directory_stamp(music_repo, mock_config):
    album = _add_album(mock_config.base_music_dir, "One")
    (album / "cover.jpg").write_bytes(b"x")
    with patch.object(music_repo, '_find_cover_art_uncached', wraps=music_repo._find_cover_art_uncached) as inner:
        assert music_repo._find_cover_art(album).name == "cover.jpg"
        assert music_repo._find_cover_art(album).name == "cover.jpg"
        assert inner.call_count == 1
        music_repo.invalidate_scan()
        music_repo._find_cover_art(album)
        assert inner.call_count == 2


def test_legacy_cover_directories_are_not_albums(music_repo, mock_config):
    base = mock_config.base_music_dir
    for name in ('Album One', 'Album Two', 'Album Three'):
        album = _add_album(base, name)
        (album / 'cover').mkdir()
        (album / 'cover' / 'cover.jpg').write_bytes(b'artwork')
        (album / 'cover.jpg').write_bytes(b'artwork')
    before = {path.relative_to(base): path.read_bytes() for path in base.rglob('*') if path.is_file()}
    legacy = list(base.rglob('cover'))
    print(f'Legacy cover folders in temporary library: {len(legacy)}')
    assert len(legacy) == 3
    with patch('app.domains.music.repositories.MutagenFile', side_effect=lambda *_: _fake_audio()):
        albums = music_repo.scan_albums()
    assert {album.path.name for album in albums} == {'Album One', 'Album Two', 'Album Three'}
    assert all(len(album.tracks) == 1 for album in albums)
    assert {path.relative_to(base): path.read_bytes() for path in base.rglob('*') if path.is_file()} == before
