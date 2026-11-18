"""Library projections of the safe writer's native field mapping.

Display credits retain their first native value for existing clients. Separate
lists carry every credit; only a lone legacy artist string needs splitting.
"""
import re

from app.domains.metadata.replaygain import gain_values
from app.domains.metadata.tagwriter import METADATA_FIELDS, values
from app.utils.musical_key import key_info

ARTIST_SPLIT_EXCEPTIONS = frozenset({'ac/dc', 'simon & garfunkel'})
# Conservative legacy separators: a bare slash or ampersand can be a band name.
_ARTIST_SEPARATOR = re.compile(r'\s+/\s+|\s+(?:feat\.|ft\.)\s+|;\s*', re.IGNORECASE)
SORT_FIELDS = {
    'titleSort': 'title_sort', 'artistSort': 'artist_sort', 'albumSort': 'album_sort',
    'albumArtistSort': 'album_artist_sort', 'composerSort': 'composer_sort',
}


def strings(value):
    if value is None:
        return []
    return [str(v) for v in (value if isinstance(value, list) else [value]) if str(v).strip()]


def credits(explicit, display):
    names = strings(explicit)
    if names:
        return names
    names = strings(display)
    if len(names) != 1 or names[0].strip().casefold() in ARTIST_SPLIT_EXCEPTIONS:
        return names
    return [part.strip() for part in _ARTIST_SEPARATOR.split(names[0]) if part.strip()]


def read(tags, mode):
    """Return the complete JSON-safe memo, using native lists before heuristics."""
    fields = values(tags, mode)
    result = {attr: fields[name] for name, attr in METADATA_FIELDS.items()}
    for name in ('title', 'artist', 'album', 'albumArtist', 'composer', 'genre', 'isrc'):
        items = strings(fields[name])
        result[METADATA_FIELDS[name]] = items[0] if items else None
    result['artists'] = credits(fields['artists'], fields['artist'])
    result['album_artists'] = credits(fields['albumArtists'], fields['albumArtist'])
    result['genres'] = strings(fields['genre'])
    for attr in ('track_number', 'disc_number'):
        if result[attr] is not None and result[attr] <= 0:
            result[attr] = None
    for name, attr in SORT_FIELDS.items():
        items = strings(fields[name])
        result[attr] = items[0] if items else None
    result['key'] = key_info(next(iter(strings(fields['key'])), None))['camelot']
    result['bpm'] = fields['bpm'] if fields['bpm'] and fields['bpm'] > 0 else None
    result['tag_owner'] = 'krobi' if fields['analysisMarker'] is not None else None
    result.update(gain_values(fields))
    return result
