"""ReplayGain 2.0 at −18 LUFS; album gating stays on the nest, without audio I/O."""
import json
import math

REFERENCE = -18.0
GAIN_FIELDS = ('trackGain', 'albumGain', 'trackPeak', 'albumPeak')


def integrated(blocks):
    """BS.1770 absolute gate followed by the album-wide relative gate.

    Blocks are the helper's 400 ms K-weighted loudness windows, every 100 ms.
    Keeping pre-relative-gate blocks lets quiet passages survive an album pass.
    """
    powers = [10 ** (value / 10) for value in blocks if value >= -70]
    if not powers:
        return None
    threshold = sum(powers) / len(powers) / 10
    gated = [value for value in powers if value >= threshold]
    return 10 * math.log10(sum(gated) / len(gated))


def album_values(rows):
    if not rows or any(not row or row.get('loudness_blocks') is None or row.get('true_peak') is None or row.get('missing_since') or row.get('error') for row in rows):
        return None, None
    lufs = integrated(value for row in rows for value in json.loads(row['loudness_blocks']))
    return (REFERENCE - lufs if lufs is not None else None,
            max(row['true_peak'] for row in rows))


def replay_gain(row=None, tags=None, album=None):
    row, tags = row or {}, tags or {}
    computed = {
        'trackGain': REFERENCE - row['track_lufs'] if row.get('track_lufs') is not None else None,
        'trackPeak': row.get('true_peak'),
        'albumGain': album[0] if album else row.get('album_gain'),
        'albumPeak': album[1] if album else row.get('album_peak'),
    }
    # The marker alone can belong to BPM/key; only the field record claims gains.
    owned = (tags.get('owned_fields') or ()) if tags.get('tag_owner') == 'krobi' else ()
    result = {field: tags[field] if field not in owned and tags.get(field) is not None else value
              for field, value in computed.items()}
    for field in ('trackPeak', 'albumPeak'):
        if result[field] is not None and result[field] <= 0:
            result[field] = None
    return {**result, 'baseGain': tags.get('baseGain', 0.0)} if any(v is not None for v in result.values()) else None
