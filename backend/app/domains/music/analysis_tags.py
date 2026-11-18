"""Read analysis tags without decoding audio or writing metadata."""
import math

from app.domains.metadata.replaygain import gain_values

from app.domains.music.analysis_precedence import key_info


def tag_value(tags, names):
    for name in names:
        native = name if name in tags else next((key for key in tags.keys() if key.casefold() == name.casefold()), None)
        if native is None:
            continue
        value = tags[native]
        if hasattr(value, 'text'):
            value = value.text
        if isinstance(value, (list, tuple)):
            value = value[0] if value else None
        if isinstance(value, bytes):
            value = value.decode('utf-8', errors='replace')
        if value is not None:
            return str(value)
    return None


def analysis_tags(tags) -> dict:
    """Read the marker; gain ownership also needs the store's per-field record."""
    raw_bpm = tag_value(tags, ('TBPM', 'bpm', 'tmpo'))
    try:
        bpm = float(raw_bpm)
        if not math.isfinite(bpm) or bpm <= 0:
            bpm = None
    except (TypeError, ValueError):
        bpm = None
    key = None
    for name in ('TKEY', 'TXXX:INITIALKEY', 'initialkey', 'key', '----:com.apple.iTunes:initialkey'):
        value = tag_value(tags, (name,))
        if key_info(value)['camelot']:
            key = key_info(value)['camelot']
            break
    gains = {}
    for field, native in (('trackGain', 'REPLAYGAIN_TRACK_GAIN'), ('albumGain', 'REPLAYGAIN_ALBUM_GAIN'),
                          ('trackPeak', 'REPLAYGAIN_TRACK_PEAK'), ('albumPeak', 'REPLAYGAIN_ALBUM_PEAK'),
                          ('r128TrackGain', 'R128_TRACK_GAIN'), ('r128AlbumGain', 'R128_ALBUM_GAIN')):
        gains[field] = tag_value(tags, (f'TXXX:{native}', native, native.lower(), f'----:com.apple.iTunes:{native}'))
    return {
        **{field: value for field, value in gain_values(gains).items() if value is not None},
        'bpm': bpm, 'key': key,
        'tag_owner': 'krobi' if tag_value(tags, ('TXXX:KROBI_ANALYSIS', 'KROBI_ANALYSIS',
                                               '----:com.apple.iTunes:KROBI_ANALYSIS')) is not None else None,
    }
