"""Finite, standard ReplayGain and R128 tag values in playback units."""
import math

GAIN_FIELDS = ('trackGain', 'albumGain', 'trackPeak', 'albumPeak')


def number(value, *, gain=False):
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    try:
        value = str(value).strip()
        if gain and value.lower().endswith('db'):
            value = value[:-2].strip()
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (ValueError, TypeError):
        return None


def gain_values(fields):
    result = {}
    for field in GAIN_FIELDS:
        value = number(fields.get(field), gain=field.endswith('Gain'))
        # Q7.8 R128 gains target −23 LUFS; ReplayGain 2.0 targets −18 LUFS.
        if value is None and field.endswith('Gain'):
            raw = number(fields.get('r128' + field[0].upper() + field[1:]))
            if raw is not None and raw.is_integer() and -32768 <= raw <= 32767:
                value = raw / 256 + 5
        result[field] = value if value is None or field.endswith('Gain') or value >= 0 else None
    return result
