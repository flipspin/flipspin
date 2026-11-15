"""Optional catalog metadata for export imports and maintenance tools."""
import logging

from app.domains.metadata.genres import fill_tracks
from app.utils.images import full_size_image_url

logger = logging.getLogger(__name__)


def album_cover(album):
    return full_size_image_url(next((album.get(key) for key in
        ('cover_xl', 'cover_big', 'cover_medium', 'cover', 'cover_small') if album.get(key)), None))


def enrich_tracks(tracks, lookup):
    """Reuse browse's genre lookup and artwork ladder; provider trouble never blocks acquisition."""
    fill_tracks(tracks, [t.get('isrc') for t in tracks], lookup)
    for track in tracks:
        if track.get('album_images'):
            continue
        try:
            deezer = lookup.deezer
            raw = None
            if track.get('provider') == 'deezer' and track.get('provider_id'):
                raw = deezer.fetch_track(track['provider_id'])
            if raw:
                album = raw.get('album') or {}
                cover = album_cover(album)
                album_id = album.get('id')
            else:
                album_id = lookup.album_id(track.get('artist'), track.get('album'),
                                           track.get('name'), track.get('isrc'))
                cover = None
            if not cover and album_id is not None:
                cover = album_cover(deezer.fetch_album(album_id))
            if cover:
                track['album_images'] = [{'url': cover}]
        except Exception:
            logger.info('Export artwork lookup skipped', exc_info=True)
