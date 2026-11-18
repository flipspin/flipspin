"""Pure per-field selection and projection into the existing analysis shape."""
from collections.abc import Mapping
from typing import Any

from app.domains.music import analysis_constants as constants

from app.utils.musical_key import key_info as key_info


def precedence(
    row: Mapping[str, Any] | None = None,
    tags: Mapping[str, Any] | None = None,
    *, bpm_threshold: float | None = None,
    key_threshold: float | None = None,
) -> dict[str, Any]:
    """Corrections > foreign tags > computed; confidence applies only to computed."""
    bpm_threshold = constants.BPM_CONFIDENCE_THRESHOLD if bpm_threshold is None else bpm_threshold
    key_threshold = constants.KEY_CONFIDENCE_THRESHOLD if key_threshold is None else key_threshold
    row, tags = row or {}, tags or {}
    owned = row.get('tag_owner') == 'krobi' or tags.get('tag_owner') == 'krobi'
    result = {}
    for field, threshold in (('bpm', bpm_threshold), ('key', key_threshold)):
        estimated = False
        if row.get(f'fixed_{field}') is not None:
            value, source = row[f'fixed_{field}'], 'fixed'
        elif not (field in tags['owned_fields'] if 'owned_fields' in tags else owned) and tags.get(field) is not None:
            value, source = tags[field], 'tag'
        elif row.get(field) is not None:
            value, source = row[field], 'computed'
            estimated = (row.get(f'{field}_conf') or 0.0) < threshold
        else:
            value, source = None, None
        result[field] = {'value': value, 'source': source, 'estimated': estimated}
    for field in ('mood', 'energy', 'brightness', 'pulse', 'arousal'):
        result[field] = row.get(field)
    return result


def effective_confidences(row: Mapping[str, Any], effective: Mapping[str, Any]) -> dict[str, float | None]:
    """A confidence describes only the computed value that is currently shown."""
    return {f'{field}Confidence': row.get(f'{field}_conf') if effective[field]['source'] == 'computed' else None
            for field in ('key', 'bpm')}


def listing_analysis(effective: Mapping[str, Any], row: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Keep existing wire keys and expose additive per-field provenance."""
    source = effective['bpm']['source']
    computed = any(effective[f]['source'] == 'computed' for f in ('bpm', 'key')) or any(
        effective[f] is not None for f in ('mood', 'energy', 'brightness', 'pulse', 'arousal'))
    return {
        **effective_confidences(row or {}, effective),
        'bpmEstimated': effective['bpm']['estimated'],
        'keyEstimated': effective['key']['estimated'],
        'bpmFixed': effective['bpm']['source'] == 'fixed',
        'keyFixed': effective['key']['source'] == 'fixed',
        'keySource': effective['key']['source'],
        'bpmSource': effective['bpm']['source'],
        'bpm': round(effective['bpm']['value']) if effective['bpm']['value'] is not None else None,
        'bpm_source': 'estimated' if source == 'computed' else source,
        'analysis_source': 'audio' if computed else None,
        **key_info(effective['key']['value']),
        **{field: effective[field] for field in ('mood', 'energy', 'brightness', 'pulse', 'arousal')},
    }
