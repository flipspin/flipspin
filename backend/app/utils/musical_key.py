"""Pure musical key notation conversion."""
_MAJOR = dict(zip(('C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F'),
                  ('8B', '9B', '10B', '11B', '12B', '1B', '2B', '3B', '4B', '5B', '6B', '7B'), strict=True))
_MINOR = dict(zip(('A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#', 'F', 'C', 'G', 'D'),
                  ('8A', '9A', '10A', '11A', '12A', '1A', '2A', '3A', '4A', '5A', '6A', '7A'), strict=True))
_FLATS = {'DB': 'C#', 'EB': 'D#', 'GB': 'F#', 'AB': 'G#', 'BB': 'A#', 'CB': 'B', 'FB': 'E', 'E#': 'F', 'B#': 'C'}


def key_info(value: str | None) -> dict[str, str | None]:
    """Read Camelot, compact ID3 keys and spelled-out major/minor keys."""
    empty = dict.fromkeys(('key', 'scale', 'key_name', 'camelot'))
    if not value:
        return empty
    text = value.strip().replace('♯', '#').replace('♭', 'b')
    code = text.upper()
    for scale, wheel in (('major', _MAJOR), ('minor', _MINOR)):
        for tonic, camelot in wheel.items():
            if code == camelot:
                return {'key': tonic, 'scale': scale, 'key_name': f'{tonic} {scale}', 'camelot': camelot}
    minor = text.lower().endswith(('minor', 'min')) or text.endswith('m')
    tonic = text.lower().removesuffix('minor').removesuffix('major').removesuffix('min').removesuffix('maj')
    if minor:
        tonic = tonic.removesuffix('m')
    tonic = tonic.strip().upper()
    tonic = _FLATS.get(tonic, tonic)
    wheel = _MINOR if minor else _MAJOR
    if tonic not in wheel:
        return empty
    scale = 'minor' if minor else 'major'
    return {'key': tonic, 'scale': scale, 'key_name': f'{tonic} {scale}', 'camelot': wheel[tonic]}

