"""The real listing serializer retains phone fields and scopes additive tags."""
import logging
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer, get_library_scope, get_music_service
from app.domains.metadata import tagwriter
from app.domains.music import routes
from app.domains.music.repositories import MusicRepository
from app.domains.music.services import MusicService
from app.domains.user_library.scope import LibraryScope
from tests.unit.test_tagreader import native_tags


@pytest.mark.parametrize('extension', ['mp3', 'flac', 'ogg', 'm4a', 'opus'])
def test_additive_tags_survive_response_model_and_member_scope(config, write_audio, extension):
    folder = config.base_music_dir / 'Album'
    folder.mkdir()
    path = folder / f'song.{extension}'
    write_audio(path, [0.] * 8000, 8000)
    native_tags(path, artists=['Main Artist', 'Guest Artist'])
    hidden = folder / f'hidden.{extension}'
    hidden.write_bytes(path.read_bytes())
    tagwriter.write(hidden, {'artist': 'Hidden Artist', 'artists': ['Private Credit'], 'genre': 'Private Genre'},
                    expected=tagwriter.identity(hidden))
    repo = MusicRepository(config, logging.getLogger('test.tags.http'), background=True)
    repo.refresh()
    service = MusicService(repo, None, config, repo.logger)
    state = SimpleNamespace(scope=LibraryScope())
    app = FastAPI()
    app.state.container = DependencyContainer(config)
    app.state.container._repositories['music_repository'] = repo
    app.state.container._services['analysis_repository'] = repo.analysis
    app.include_router(routes.router)
    app.dependency_overrides[get_music_service] = lambda: service
    app.dependency_overrides[get_library_scope] = lambda: state.scope
    client = TestClient(app)
    url = '/api/listar-albums-con-metadata?covers=false'
    owner = client.get(url)
    assert owner.status_code == 200
    album = owner.json()[0]
    track = next(t for t in album['tracks'] if t['relPath'] == f'Album/{path.name}')
    assert track['artist'] == 'Display Credit'
    assert track['genre'] == 'Rock'
    assert track['track_number'] == 3
    assert track['url_path'] == f'/api/media/Album/{path.name}'
    assert track['artists'] == ['Main Artist', 'Guest Artist']
    assert track['genres'] == ['Rock', 'Electronic']
    assert track['albumArtist'] == 'Album Credit'
    assert track['albumArtists'] == ['Album Credit']
    assert track['discNumber'] == 2 and track['year'] == 2024 and track['compilation'] is True
    assert [track[k] for k in ('titleSort', 'artistSort', 'albumSort', 'albumArtistSort', 'composerSort')] == [
        'Song Sort', 'Artist Sort', 'Album Sort', 'Album Artist Sort', 'Composer Sort']
    assert album['artist'] == 'Album Credit' and album['compilation'] is True
    assert 'Private Genre' in album['genres']
    state.scope = LibraryScope(frozenset({f'Album/{path.name}'}))
    member = client.get(url, headers={'If-None-Match': owner.headers['etag']})
    assert member.status_code == 200
    visible = member.json()[0]
    assert visible['tracks'] == [track]
    assert visible['genres'] == ['Rock', 'Electronic']
    assert 'Private Credit' not in member.text and 'Hidden Artist' not in member.text
    assert client.get(url, headers={'If-None-Match': member.headers['etag']}).status_code == 304
    state.scope = LibraryScope(frozenset())
    assert client.get(url).json() == []
    state.scope = LibraryScope()
    assert client.get(url).json() == owner.json()
