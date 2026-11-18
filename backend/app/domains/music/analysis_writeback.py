"""Opt-in tag effects, called only after the analysis store commits."""
import math

from mutagen import File as MutagenFile
from mutagen.id3 import ID3, ID3NoHeaderError

from app.domains.metadata import tagwriter

from app.domains.music import analysis_constants as constants
from app.domains.music.analysis_precedence import key_info
from app.domains.music.analysis_tags import analysis_tags
from app.domains.music.loudness import GAIN_FIELDS, replay_gain


def read_file_tags(path):
    if path.suffix.lower() == '.mp3':
        try:
            return ID3(path)
        except ID3NoHeaderError:
            return ID3()
    audio = MutagenFile(path)
    if audio is None:
        raise ValueError('Unreadable audio tags')
    if audio.tags is None:
        audio.add_tags()
    return audio


def owned_tags(row, tags, fields=None, values=None):
    """A subsequent edit relinquishes ownership of the file's analysis tags."""
    if not row or row.get('tag_owner') != 'krobi':
        return tags.get('tag_owner') == 'krobi' and not row
    if fields and set(fields).intersection(GAIN_FIELDS) and tags.get('tag_owner') != 'krobi':
        return False
    if not row.get('analyzed_at') and not values:
        return True  # Step 0 compared these tags against the old cache.
    row = {**row, **(values or {}), **{f: row[f'fixed_{f}'] for f in ('key', 'bpm')
                                     if row.get(f'fixed_{f}') is not None and f not in (values or {})}}
    return all(tags.get(field) is None or (
        row.get(field) is not None and (
            math.isclose(tags[field], row[field], rel_tol=0, abs_tol=.0051 if field.endswith('Gain') else .00000051)
            if field in GAIN_FIELDS else tags[field] == round(row[field], 1) if field == 'bpm' else
            key_info(tags[field])['camelot'] == row[field])) for field in (fields if fields is not None else ('bpm', 'key')))


def reconcile_ownership(repository, rel, row, tags, stat=None):
    """Project per-field ownership without treating a foreign sibling as computed output."""
    tags = tags.copy()
    fields = repository.tag_fields(rel)
    values = repository.tag_record(rel, 'tag_values')
    legacy_changed = (row and not row.get('analyzed_at') and not values and stat and tags.get('tag_owner') is None
                      and (row.get('size'), row.get('mtime_ns')) != (stat.st_size, stat.st_mtime_ns))
    if row and row.get('tag_owner') == 'krobi' and (legacy_changed or not owned_tags(row, tags, fields, values)):
        repository.ownership(rel, None)
        row['tag_owner'] = None
        fields = []
    if row and row.get('analyzed_at') and row.get('tag_owner') is None:
        tags['tag_owner'] = None  # A marker left behind by an external edit.
    if fields is not None:
        tags['owned_fields'] = fields
    return row, tags


def write_tags(path, row, *, fixed=None, owned=None, owned_only=False, originals=None, writer=None, expected=None, principal='analysis'):
    """Decide analysis ownership under the same lock as all editor writes."""
    if path.suffix.lower() not in tagwriter.FORMATS:
        return None
    outcome = []

    def plan(tags, mode):
        current = analysis_tags(tags)
        ownership = owned_tags(row, current) if owned is None else owned
        owned_fields = set(('key', 'bpm') if ownership is True else ownership or ())
        if current.get('tag_owner') != 'krobi':
            owned_fields.difference_update(GAIN_FIELDS)
        written_fields = set(owned_fields)
        fields = {}
        for field, threshold in (('bpm', constants.BPM_CONFIDENCE_THRESHOLD), ('key', constants.KEY_CONFIDENCE_THRESHOLD)):
            if path.suffix.lower() not in ('.mp3', '.flac', '.ogg', '.m4a', '.mp4'):
                continue
            correction = fixed is not None and field in fixed and fixed[field] is not None
            restore = fixed is not None and field in fixed and fixed[field] is None and field in (originals or {}) and field in owned_fields
            if correction:
                value = fixed[field]
            elif restore:
                value = originals[field]
            else:
                if row.get(f'fixed_{field}') is not None or owned_only and field not in owned_fields:
                    continue
                if fixed is not None and field not in fixed:
                    continue
                if current[field] is not None and field not in owned_fields:
                    continue
                value = row.get(field) if (row.get(f'{field}_conf') or 0) >= threshold else None
                if value is None and field not in owned_fields:
                    continue
            written_fields.discard(field)
            fields[field] = round(value, 1) if field == 'bpm' and value is not None else value
            if value is not None and not restore:
                written_fields.add(field)
        # Foreign gain tags are immutable inputs, including R128 tags.
        # Their lifetime is independent of BPM/key ownership and confidence.
        if fixed is None and not owned_only:
            gains = replay_gain(row) or {}
            for field in ('trackGain', 'albumGain', 'trackPeak', 'albumPeak'):
                native = tagwriter.FIELDS[field][mode]
                r128 = 'r128' + field[0].upper() + field[1:]
                present = {key.casefold() for key in tags.keys()}
                existing = native.casefold() in present or (r128 in tagwriter.FIELDS and tagwriter.FIELDS[r128][mode].casefold() in present)
                value = gains.get(field)
                if (existing and field not in owned_fields) or value is None:
                    continue
                if path.suffix.lower() == '.opus':
                    # RFC 7845: Opus comments use signed Q7.8 at −23 LUFS, no RG peaks.
                    if field.endswith('Gain'):
                        encoded = round((value - 5) * 256)
                        if -32768 <= encoded <= 32767:
                            fields[r128] = str(encoded)
                            written_fields.add(field)
                else:
                    fields[field] = f'{value:+.2f} dB' if field.endswith('Gain') else f'{value:.6f}'
                    written_fields.add(field)
        changed = bool(fields) or owned_only and any(row.get(f'fixed_{f}') is None for f in owned_fields)
        if not changed:
            outcome.append((False, row.get('tag_owner'), None))
            return {}
        owner = 'krobi' if written_fields else None
        if fields or owned_only:
            fields['analysisMarker'] = f'{constants.ENGINE}@{constants.ENGINE_VERSION}' if any(
                row.get(f'fixed_{field}') is None for field in written_fields) else None
        outcome.append((True, owner, sorted(written_fields) if owner else []))
        return fields

    with tagwriter.file_lock(path):
        expected = expected if expected is not None else tagwriter.identity(path)
        if writer:
            writer(path, {}, expected=expected, transform=plan, principal=principal,
                   provenance=lambda: {'owner': outcome[0][1], 'fields': outcome[0][2]})
        else:
            tagwriter.write(path, expected=expected, transform=plan)
    return outcome[0]
