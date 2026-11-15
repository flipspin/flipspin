"""Import metadata uses the existing catalog genre lookup and download adapter."""
from types import SimpleNamespace
from unittest.mock import Mock

from app.domains.acquisition.adapters import SpotifyAdapter
from app.domains.metadata.deezer_repository import DeezerRepository
from app.domains.metadata.genres import AlbumGenres
from app.domains.metadata.import_enrichment import enrich_tracks
from app.domains.metadata.matching import WantedTrack, match_track

COVER = 'https://cdn-images.dzcdn.net/images/cover/abc123/500x500-000000-80-0-0.jpg'


def test_deezer_match_preserves_artwork_on_the_wire():
    candidate = DeezerRepository._to_candidate({
        'id': 123, 'title': 'Track', 'artist': {'name': 'Artist'}, 'duration': 180,
        'isrc': 'USAAA2600001', 'album': {'title': 'Album', 'cover_big': COVER},
    })
    assert match_track(WantedTrack('Track', 'Artist'), [candidate]).to_dict()['match']['coverUrl'] == COVER


def test_enriched_tracks_reach_the_same_tagger_as_browse(tmp_path):
    deezer = Mock()
    deezer.fetch_track_by_isrc.return_value = {'album': {'id': 12}}
    deezer.fetch_track.return_value = {'album': {'id': 12, 'cover_big': COVER}}
    deezer.fetch_album_tags.return_value = ([('Rock', 'Rock')], 2020)
    tracks = [{'name': 'Track', 'artist': 'Artist', 'album': 'Album',
               'isrc': 'USAAA2600001', 'provider': 'deezer', 'provider_id': '123'}]
    enrich_tracks(tracks, AlbumGenres(deezer))
    request = SpotifyAdapter(SimpleNamespace(), Mock())._build_track_requests(tracks, tmp_path, False, 'none', 0)[0]
    assert request.cover_url == COVER.replace('500x500', '1000x1000')
    assert (request.metadata.genre, request.metadata.year) == ('Rock', 2020)


def test_cover_falls_back_to_the_same_album_lookup_and_failure_is_optional():
    lookup = Mock()
    lookup.lookup.return_value = (None, None, [])
    lookup.album_id.return_value = 12
    lookup.deezer.fetch_album.return_value = {'cover_xl': COVER}
    tracks = [{'name': 'Track', 'artist': 'Artist', 'album': 'Album'}]
    enrich_tracks(tracks, lookup)
    assert tracks[0]['album_images'][0]['url'] == COVER.replace('500x500', '1000x1000')
    tracks[0].pop('album_images')
    lookup.deezer.fetch_album.side_effect = OSError('provider unavailable')
    enrich_tracks(tracks, lookup)
    assert 'album_images' not in tracks[0]


def test_published_cover_has_an_album_sidecar_and_never_blocks_audio(tmp_path, monkeypatch):
    from app.domains.music import writer
    root, incoming = tmp_path / 'Music', tmp_path / 'incoming'
    staged = incoming / 'stage' / 'Track.mp3'
    staged.parent.mkdir(parents=True)
    staged.write_bytes(b'audio')
    cover = staged.parent / 'cover' / 'cover.jpg'
    cover.parent.mkdir()
    cover.write_bytes(b'cover')
    destination = root / 'Album'
    final = writer.publish(staged, destination, root=root, incoming=incoming, recycle=tmp_path / 'recycle')
    assert final.read_bytes() == b'audio'
    assert (destination / 'cover.jpg').read_bytes() == b'cover'
    # cover/ is the staging layout for embedding; albums use one root sidecar.
    assert not (destination / 'cover').exists()
    staged.write_bytes(b'more audio')
    # Existing artwork is preserved, and a broken optional sidecar is harmless.
    (destination / 'cover.jpg').write_bytes(b'person-edited cover')
    writer.publish(staged, destination, root=root, incoming=incoming, recycle=tmp_path / 'recycle')
    assert (destination / 'cover.jpg').read_bytes() == b'person-edited cover'
    staged.write_bytes(b'final audio')
    (destination / 'cover.jpg').unlink()
    monkeypatch.setattr(writer.shutil, 'copy2', Mock(side_effect=OSError('artwork storage unavailable')))
    # Avoid replacement recycling so only optional artwork copies fail.
    final.unlink()
    assert writer.publish(staged, destination, root=root, incoming=incoming, recycle=tmp_path / 'recycle').read_bytes() == b'final audio'


def test_shared_adapter_upgrades_catalog_artwork_without_changing_other_hosts(tmp_path):
    tracks = [{'name': 'Track', 'album_images': [{'url': COVER}]},
              {'name': 'Other', 'album_images': [{'url': 'https://images.example/640.jpg'}]}]
    requests = SpotifyAdapter(SimpleNamespace(), Mock())._build_track_requests(tracks, tmp_path, False, 'none', 0)
    assert requests[0].cover_url == COVER.replace('500x500', '1000x1000')
    assert requests[1].cover_url == 'https://images.example/640.jpg'
