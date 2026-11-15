"""Committed track removals prune playlist rows, across the right ownership scope."""
import pytest
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer
from app.domains.playlists.models import Playlist, PlaylistTrack
from app.main import app
from tests.integration.test_member_library_scope import write_song
from tests.integration.test_wire_snapshots import assert_matches_snapshot


@pytest.fixture
def nest(config, monkeypatch):
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, 'config', config)
    monkeypatch.setattr(app.state, 'container', container)
    owner, owner_token = container.get_token_store().mint('Admin', 'owner')
    member, member_token = container.get_token_store().mint('Member', 'member')
    song = config.base_music_dir.resolve() / 'Artist/Album/song.mp3'
    other = song.with_name('other.mp3')
    write_song(song, 'Song', 'Artist', 'Album')
    write_song(other, 'Other', 'Artist', 'Album')
    store = container.get_user_track_store()
    service = container.get_playlist_service()
    for account in (owner, member):
        store.add_many(account.user_id, ['Artist∕Album/song.mp3'])
        service.playlist_repo.save_playlist(Playlist(
            name=account.role, owner_id=account.user_id,
            tracks=[PlaylistTrack(song, 'Song'), PlaylistTrack(other, 'Other'),
                    PlaylistTrack(song.relative_to(config.base_music_dir.resolve()), 'Song')],
        ))
    client = TestClient(app, client=('192.0.2.42', 51000))
    return container, client, song, other, owner, member, owner_token, member_token


def test_nest_delete_prunes_every_owner_after_unlink(nest, monkeypatch):
    container, client, song, other, _, _, token, _ = nest
    service = container.get_playlist_service()
    original = service.remove_library_tracks

    def after_commit(paths):
        assert not song.exists()
        return original(paths)

    monkeypatch.setattr(service, 'remove_library_tracks', after_commit)
    response = client.post('/api/delete-track', json={'path': str(song)}, headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    body = response.json()
    assert body == {'success': True, 'path': str(song), 'playlistsUpdated': [
        {'name': 'member', 'removed': 2}, {'name': 'owner', 'removed': 2},
    ]}
    for name in ('member', 'owner'):
        assert [t.path for t in service.get_playlist(name).tracks] == [other]
    body['path'] = '<music>/Artist/Album/song.mp3'
    assert_matches_snapshot('delete-track-playlists', body)


@pytest.mark.parametrize('role', ['owner', 'member'])
def test_library_removal_only_prunes_callers_playlists_and_keeps_audio(nest, role, monkeypatch):
    container, client, song, other, owner, member, owner_token, member_token = nest
    account, token = (owner, owner_token) if role == 'owner' else (member, member_token)
    service = container.get_playlist_service()
    other_role = 'member' if role == 'owner' else 'owner'
    untouched = service.playlist_repo._playlist_path(other_role).read_bytes()
    audio = song.read_bytes()
    original = service.remove_library_tracks

    def after_commit(paths, **kwargs):
        assert container.get_user_track_store().get(account.user_id, 'Artist∕Album/song.mp3') is None
        return original(paths, **kwargs)

    monkeypatch.setattr(service, 'remove_library_tracks', after_commit)
    response = client.request('DELETE', '/api/me/library', json={'relPaths': ['Artist∕Album/song.mp3']},
                              headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    assert response.json() == {'removed': ['Artist∕Album/song.mp3'], 'playlistsUpdated': [{'name': role, 'removed': 2}]}
    assert [t.path for t in service.get_playlist(role).tracks] == [other]
    assert service.playlist_repo._playlist_path(other_role).read_bytes() == untouched
    assert song.read_bytes() == audio
    if role == 'member':
        assert_matches_snapshot('remove-library-playlists', response.json())
    retry = client.request('DELETE', '/api/me/library', json={'relPaths': ['Artist∕Album/song.mp3']},
                           headers={'Authorization': f'Bearer {token}'})
    assert retry.json() == {'removed': [], 'playlistsUpdated': []}
