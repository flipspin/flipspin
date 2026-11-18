"""Real encoded files: independent native tags in, additive library fields out."""
import logging
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from mutagen import File
from mutagen import id3
from mutagen.mp4 import MP4FreeForm

from app.domains.metadata import tagreader, tagwriter
from app.domains.metadata.repositories import MetadataRepository
from app.domains.music.repositories import MusicRepository
from app.domains.music.scan_store import SCAN_CACHE
from app.domains.music.services import MusicService
from app.domains.subsonic.library import build, filtered_library
from app.domains.subsonic.routes import song_dict
from app.domains.user_library.scope import LibraryScope
from app.infra.migrations import SQLiteStore, open_store


@pytest.fixture(params=['mp3', 'flac', 'ogg', 'm4a', 'opus'])
def audio_file(request, config, write_audio):
    path = config.base_music_dir / 'Album' / f'song.{request.param}'
    path.parent.mkdir(exist_ok=True)
    write_audio(path, [0.] * 8000, 8000)
    return path


def native_tags(path, *, artist=None, artists=None, disc='2/3', compilation=True, album_artist='Album Credit'):
    """Seed a foreign tagger's shapes without consulting the production table."""
    artist = artist or ['Display Credit', 'Second Credit']
    audio = File(path)
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags
    if path.suffix == '.mp3':
        frames = [id3.TIT2(text=['Song']), id3.TPE1(text=artist), id3.TALB(text=['Collection']),
                  id3.TCON(text=['Rock', 'Electronic']), id3.TDRC(text=['2024-03-02']),
                  id3.TRCK(text=['3/12']), id3.TPOS(text=[disc]), id3.TCMP(text=['1' if compilation else '0']),
                  id3.TSOT(text=['Song Sort']), id3.TSOP(text=['Artist Sort']), id3.TSOA(text=['Album Sort']),
                  id3.TSO2(text=['Album Artist Sort']), id3.TSOC(text=['Composer Sort'])]
        if album_artist:
            frames.append(id3.TPE2(text=[album_artist]))
        if artists is not None:
            frames.append(id3.TXXX(desc='ARTISTS', text=artists))
        for frame in frames:
            tags.add(frame)
    elif path.suffix == '.m4a':
        tags.update({'©nam': ['Song'], '©ART': artist, '©alb': ['Collection'], '©gen': ['Rock', 'Electronic'],
                     '©day': ['2024-03-02'], 'trkn': [(3, 12)], 'disk': [tuple(map(int, disc.split('/')))],
                     'cpil': compilation, 'sonm': ['Song Sort'], 'soar': ['Artist Sort'],
                     'soal': ['Album Sort'], 'soaa': ['Album Artist Sort'], 'soco': ['Composer Sort']})
        if album_artist:
            tags['aART'] = [album_artist]
        if artists is not None:
            tags['----:com.apple.iTunes:ARTISTS'] = [MP4FreeForm(s.encode()) for s in artists]
    else:
        tags.update({'TITLE': ['Song'], 'ARTIST': artist, 'ALBUM': ['Collection'], 'GENRE': ['Rock', 'Electronic'],
                     'DATE': ['2024-03-02'], 'TRACKNUMBER': ['3/12'], 'DISCNUMBER': [disc], 'DISCTOTAL': ['3'],
                     'COMPILATION': ['1' if compilation else '0'], 'TITLESORT': ['Song Sort'],
                     'ARTISTSORT': ['Artist Sort'], 'ALBUMSORT': ['Album Sort'],
                     'ALBUMARTISTSORT': ['Album Artist Sort'], 'COMPOSERSORT': ['Composer Sort']})
        if album_artist:
            tags['ALBUMARTIST'] = [album_artist]
        if artists is not None:
            tags['ARTISTS'] = artists
    audio.save()


def repository(config):
    return MusicRepository(config, logging.getLogger('test.tagreader'))


def test_all_formats_keep_native_values_and_share_writer_mapping(audio_file, config):
    native_tags(audio_file, artists=['Main Artist', 'Guest Artist'])
    original = audio_file.read_bytes(), audio_file.stat().st_mtime_ns
    repo = repository(config)
    tags = repo.read_tags(audio_file)
    assert tags['artist'] == 'Display Credit'  # Frozen phone field, independent of ARTISTS.
    assert tags['artists'] == ['Main Artist', 'Guest Artist']
    assert tags['genre'] == 'Rock' and tags['genres'] == ['Rock', 'Electronic']
    assert tags['album_artist'] == 'Album Credit'
    assert tags['album_artists'] == ['Album Credit']
    assert (tags['track_number'], tags['disc_number'], tags['year']) == (3, 2, 2024)
    assert tags['compilation'] is True
    assert [tags[attr] for attr in tagreader.SORT_FIELDS.values()] == [
        'Song Sort', 'Artist Sort', 'Album Sort', 'Album Artist Sort', 'Composer Sort']
    native = tagwriter.read(audio_file)['fields']
    assert native['artist'] == ['Display Credit', 'Second Credit']
    assert native['genre'] == tags['genres'] and native['artists'] == tags['artists']
    assert (native['trackNumber'], native['discNumber'], native['year']) == (3, 2, 2024)
    metadata = MetadataRepository(config, repo.logger).read_id3_tags(audio_file)
    assert metadata.artists == tags['artists'] and metadata.genres == tags['genres']
    assert (metadata.artist, metadata.album_artist, metadata.disc_number) == ('Display Credit', 'Album Credit', 2)
    assert metadata.artist_sort == 'Artist Sort' and metadata.compilation is True
    track = repo.get_track_info(audio_file)
    assert track.to_dict()['artists'] == tags['artists']
    assert track.to_dict()['discNumber'] == 2
    assert original == (audio_file.read_bytes(), audio_file.stat().st_mtime_ns)
    # Opus must pass through discovery too, rather than only a direct tag read.
    albums = repo.refresh()
    assert len(albums) == 1 and albums[0].tracks[0].path == audio_file


def test_native_multivalues_are_never_split_again(audio_file, config):
    native_tags(audio_file, artist=['A / B', 'C; D'])
    assert repository(config).read_tags(audio_file)['artists'] == ['A / B', 'C; D']


@pytest.mark.parametrize('credit,expected', [
    ('AC/DC', ['AC/DC']), ('Simon & Garfunkel', ['Simon & Garfunkel']),
    ('AC/DC; Simon & Garfunkel', ['AC/DC', 'Simon & Garfunkel']),
    ('Lead / Guest feat. Singer; Third ft. Fourth', ['Lead', 'Guest', 'Singer', 'Third', 'Fourth']),
])
def test_single_legacy_credit_splits_conservatively(audio_file, config, credit, expected):
    native_tags(audio_file, artist=[credit])
    tags = repository(config).read_tags(audio_file)
    assert tags['artist'] == credit and tags['artists'] == expected


def test_explicit_single_artists_credit_is_authoritative(audio_file, config):
    native_tags(audio_file, artist=['Lead / Guest'], artists=['A; B'])
    assert repository(config).read_tags(audio_file)['artists'] == ['A; B']


@pytest.mark.parametrize('album_artist', ['Album Credit', None])
def test_compilation_groups_track_artists_under_album_credit(audio_file, config, album_artist):
    native_tags(audio_file, artist=['First Track Artist'], album_artist=album_artist)
    second = audio_file.with_name('second' + audio_file.suffix)
    second.write_bytes(audio_file.read_bytes())
    native_tags(second, artist=['Second Track Artist'], album_artist=album_artist)
    repo = repository(config)
    albums = repo.refresh()
    assert len(albums) == 1
    album = albums[0]
    assert album.compilation is True and len(album.tracks) == 2
    assert album.artist == (album_artist or 'Various Artists')
    assert {t.artist for t in album.tracks} == {'First Track Artist', 'Second Track Artist'}
    index = build(config.base_music_dir, albums)
    assert len(index.artists) == 1 and len(index.albums) == 1
    assert next(iter(index.artists.values())).name == album.artist
    service = MusicService(repo, MetadataRepository(config, repo.logger), config, repo.logger)
    assert service.get_album('Album').artist == album.artist


def test_disc_tags_override_folders_and_order_numerically(audio_file, config):
    native_tags(audio_file, disc='10/10', compilation=False)
    folder = audio_file.parent
    second = folder / 'CD1' / ('other' + audio_file.suffix)
    second.parent.mkdir()
    second.write_bytes(audio_file.read_bytes())
    native_tags(second, disc='2/10', compilation=False)
    third = folder / 'CD2' / ('first' + audio_file.suffix)
    third.parent.mkdir()
    third.write_bytes(audio_file.read_bytes())
    native_tags(third, disc='1/10', compilation=False)
    repo = repository(config)
    album = repo.refresh()[0]
    assert [(t.disc_number, t.path) for t in album.tracks] == [(1, third), (2, second), (10, audio_file)]
    assert album.compilation is False
    library = build(config.base_music_dir, [album])
    ctx = SimpleNamespace(rows={})
    assert [song_dict(ctx, s)['discNumber'] for s in library.songs.values()] == [1, 2, 10]


def test_missing_disc_uses_only_a_recognized_folder(audio_file, config):
    native_tags(audio_file)
    tagwriter.write(audio_file, {'discNumber': None}, expected=tagwriter.identity(audio_file))
    folder = audio_file.parent / 'CD12'
    folder.mkdir()
    moved = folder / audio_file.name
    audio_file.rename(moved)
    repo = repository(config)
    assert repo.get_track_info(moved).disc_number == 12
    assert 'disc_number' not in repo.read_tags(moved) or repo.read_tags(moved)['disc_number'] is None
    other = audio_file.parent / 'Album 2024'
    other.mkdir()
    plain = other / audio_file.name
    plain.write_bytes(moved.read_bytes())
    assert repo.get_track_info(plain).disc_number is None


@pytest.mark.parametrize('suffix', ['mp3', 'flac', 'm4a'])
def test_malformed_numbers_do_not_hide_other_fields(suffix):
    if suffix == 'mp3':
        tags = id3.ID3()
        tags.add(id3.TRCK(text=['not a number']))
        tags.add(id3.TPOS(text=['?']))
        tags.add(id3.TIT2(text=['Readable']))
    elif suffix == 'flac':
        tags = {'TRACKNUMBER': ['?'], 'DISCNUMBER': ['?'], 'TITLE': ['Readable']}
    else:
        tags = {'trkn': [()], 'disk': [('?', 2)], '©nam': ['Readable']}
    result = tagreader.read(tags, tagwriter.FORMATS['.' + suffix])
    assert result['track_number'] is None and result['disc_number'] is None
    assert result['title'] == 'Readable'


@pytest.mark.parametrize('key', ['ALBUM ARTIST', 'ALBUM_ARTIST'])
def test_vorbis_album_artist_aliases_and_year_fallback(key):
    # A real Vorbis mapping is case insensitive; model that explicitly here.
    from mutagen._vorbis import VCommentDict
    tags = VCommentDict()
    tags[key] = ['Album Credit']
    tags['YEAR'] = ['1998']
    result = tagreader.read(tags, 1)
    assert result['album_artist'] == 'Album Credit' and result['year'] == 1998


def test_v23_legacy_year_and_artist_separator(config, write_audio):
    audio_file = config.base_music_dir / 'song.mp3'
    write_audio(audio_file, [0.] * 8000, 8000)
    native_tags(audio_file, artist=['AC/DC', 'Simon & Garfunkel'])
    tags = id3.ID3(audio_file)
    tags.save(audio_file, v2_version=3, v23_sep='; ')
    result = repository(config).read_tags(audio_file)
    assert result['artist'] == 'AC/DC; Simon & Garfunkel'
    assert result['artists'] == ['AC/DC', 'Simon & Garfunkel']
    assert result['year'] == 2024


def test_discs_in_one_folder_do_not_interleave_tracks(audio_file, config):
    native_tags(audio_file, disc='2/2')
    other = audio_file.with_name('other' + audio_file.suffix)
    other.write_bytes(audio_file.read_bytes())
    native_tags(other, disc='1/2')
    tagwriter.write(other, {'trackNumber': 12}, expected=tagwriter.identity(other))
    tracks = repository(config).refresh()[0].tracks
    assert [(t.disc_number, t.track_number) for t in tracks] == [(1, 12), (2, 3)]


def test_upgrade_rereads_once_preserves_offline_snapshot_and_full_memo(audio_file, config):
    native_tags(audio_file, artists=['Main Artist', 'Guest Artist'])
    repo = repository(config)
    repo.refresh()
    # Seed the previous schema head and a first-only cache with unchanged files.
    with repo.scans.store.connection() as db:
        db.execute('PRAGMA user_version=3')
        db.execute("UPDATE tags SET value=json_remove(value, '$.artists', '$.disc_number')")
    restarted = repository(config)
    with patch('app.domains.music.library_scan.discover', side_effect=FileNotFoundError):
        assert restarted.refresh()[0].tracks[0].path == audio_file
    with patch('app.domains.music.repositories.MutagenFile', wraps=File) as reads:
        refreshed = restarted.refresh()
        assert reads.call_count == 1
        assert refreshed[0].tracks[0].artists == ['Main Artist', 'Guest Artist']
    again = repository(config)
    with patch('app.domains.music.repositories.MutagenFile', side_effect=AssertionError('memo miss')):
        restored = again.refresh()
        memo = again.read_tags(audio_file)
        assert memo['artists'] == ['Main Artist', 'Guest Artist']
        assert memo['genres'] == ['Rock', 'Electronic']
        assert memo['disc_number'] == 2 and memo['album_artist_sort'] == 'Album Artist Sort'
        assert restored[0].tracks[0].disc_number == 2


@pytest.mark.parametrize('old_steps', [3, 5])
def test_migration_retains_pending_full_scan_and_row_counts(tmp_path, old_steps):
    path = tmp_path / 'scan.sqlite'
    old = open_store(path, SQLiteStore(SCAN_CACHE.name, SCAN_CACHE.steps[:old_steps]))
    with old:
        old.execute("INSERT INTO tags VALUES ('song.mp3',1,2,'{}')")
        old.execute("INSERT INTO folders VALUES ('root','Album','old')")
        old.execute("INSERT INTO requests VALUES ('root',1,0)")
    old.close()
    upgraded = open_store(path, SCAN_CACHE)
    assert upgraded.execute('PRAGMA user_version').fetchone()[0] == SCAN_CACHE.head
    assert tuple(upgraded.execute('SELECT mtime_ns,size,value FROM tags').fetchone()) == (-1, 2, '{}')
    assert upgraded.execute('SELECT signature FROM folders').fetchone()[0] == ''
    assert upgraded.execute('SELECT full FROM requests').fetchone()[0] == 1
    upgraded.close()


def test_member_genres_come_only_from_visible_tracks(audio_file, config):
    native_tags(audio_file)
    hidden = audio_file.with_name('hidden' + audio_file.suffix)
    hidden.write_bytes(audio_file.read_bytes())
    tagwriter.write(hidden, {'genre': 'Private Genre'}, expected=tagwriter.identity(hidden))
    repo = repository(config)
    albums = repo.refresh()
    scope = LibraryScope(frozenset({f'Album/{audio_file.name}'}))
    for visible in (scope.filter_albums(albums, config.base_music_dir),
                    [a.album for a in filtered_library(build(config.base_music_dir, albums), scope).albums.values()]):
        assert len(visible[0].tracks) == 1
        assert visible[0].genres == ['Rock', 'Electronic']
    assert 'Private Genre' in albums[0].genres
