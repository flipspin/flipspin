"""Startup repair respects recording normalization, existing rows and atomic writes."""
import json
import logging

import pytest

from app.dependencies import DependencyContainer
from app.domains.playlists.dangling_migration import META_NAME, migrate_dangling_rows
from app.domains.playlists.models import Playlist, PlaylistTrack
from tests.integration.test_member_library_scope import write_song


def test_startup_repairs_duplicates_lost_rows_once(config, caplog, monkeypatch):
    from app.main import app, _playlist_cleanup_startup

    service = DependencyContainer(config).get_playlist_service()
    monkeypatch.setattr(app.state.container, 'get_playlist_service', lambda: service)
    base = config.base_music_dir.resolve()
    preferred = base / 'Album/copy.mp3'
    artist_match = base / 'Other/copy.mp3'
    wrong_artist = base / 'Another/copy.mp3'
    for path, artist in ((preferred, 'Other Artist'), (artist_match, 'Artist'), (wrong_artist, 'Other Artist')):
        write_song(path, 'Café - Remastered 2020', artist, 'Album')
    existing = {'path': str(preferred), 'title': 'Stored title', 'extra': {'untouched': True}}
    rows = [
        existing,
        {'path': str(base / 'Album/missing.mp3'), 'title': 'CAFE', 'artist': 'Artist'},
        {'path': str(base / 'Lost/missing.mp3'), 'title': 'Café', 'artist': 'Artist'},
        {'path': str(base / 'Lost/live.mp3'), 'title': 'Café (Live)', 'artist': 'Artist'},
        {'path': str(base / 'Lost/gone.mp3'), 'title': 'Gone'},
    ]
    playlist = service.playlist_repo._playlist_path('Repair')
    playlist.write_text(json.dumps({'name': 'Repair', 'owner': 'account', 'tracks': rows, 'custom': True}))
    service.playlist_repo.save_playlist(Playlist('Intact', [PlaylistTrack(preferred, 'Stored title')]))
    intact = service.playlist_repo._playlist_path('Intact')
    intact_bytes = intact.read_bytes()
    with caplog.at_level(logging.INFO):
        _playlist_cleanup_startup()
    result = json.loads(playlist.read_text())
    assert result['tracks'] == [existing, {**rows[1], 'path': str(preferred)}, {**rows[2], 'path': str(artist_match)}]
    assert result['owner'] == 'account' and result['custom'] is True
    assert intact.read_bytes() == intact_bytes
    assert 'Playlist dangling rows: repointed=2 removed=2 playlists=1' in caplog.text
    assert len([r for r in caplog.records if r.message.startswith('Playlist dangling rows:')]) == 1
    before = playlist.read_bytes()
    assert migrate_dangling_rows(service) is None
    assert playlist.read_bytes() == before
    assert json.loads((config.playlist_dir.parent / META_NAME).read_text())['danglingRowsVersion'] == 1


def test_cleanup_defers_empty_library_and_retries_failed_atomic_write(config, monkeypatch):
    service = DependencyContainer(config).get_playlist_service()
    marker = config.playlist_dir.parent / META_NAME
    assert migrate_dangling_rows(service) is None
    assert not marker.exists()
    song = config.base_music_dir / 'Album/song.mp3'
    write_song(song, 'Song', 'Artist', 'Album')
    repo = service.playlist_repo
    repo.save_playlist(Playlist('Repair', [PlaylistTrack(song.with_name('lost.mp3'), 'Lost')]))
    playlist = repo._playlist_path('Repair')
    before = playlist.read_bytes()
    from app.infra import files
    replace = files.os.replace

    def failed_replace(source, target):
        assert playlist.read_bytes() == before
        raise OSError('disk full')

    monkeypatch.setattr(files.os, 'replace', failed_replace)
    with pytest.raises(OSError, match='disk full'):
        migrate_dangling_rows(service)
    assert not marker.exists() and playlist.read_bytes() == before
    assert not list(config.playlist_dir.glob('*.tmp'))
    monkeypatch.setattr(files.os, 'replace', replace)
    assert migrate_dangling_rows(service) == {'repointed': 0, 'removed': 1, 'playlists': 1}
