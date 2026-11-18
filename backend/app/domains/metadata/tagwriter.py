"""The sole audio-tag mutation boundary: lock, compare, copy, sync and replace.

Callers must retain the identity they read. The prepare hook persists the undo
record and the exact expected identity of the synced sibling before replacement.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import shutil
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from mutagen import File as MutagenFile, MutagenError
from mutagen import id3
from mutagen.mp4 import MP4FreeForm

from app.utils.musical_key import key_info
from app.infra.migrations import fsync_directory

# Logical field -> ID3 hash, Vorbis key, MP4 atom. Only these explicit keys are owned.
FIELDS = {
    'title': ('TIT2', 'TITLE', '©nam'),
    'artist': ('TPE1', 'ARTIST', '©ART'),
    'artists': ('TXXX:ARTISTS', 'ARTISTS', '----:com.apple.iTunes:ARTISTS'),
    'album': ('TALB', 'ALBUM', '©alb'),
    'albumArtist': ('TPE2', 'ALBUMARTIST', 'aART'),
    'albumArtists': ('TXXX:ALBUMARTISTS', 'ALBUMARTISTS', '----:com.apple.iTunes:ALBUMARTISTS'),
    'titleSort': ('TSOT', 'TITLESORT', 'sonm'),
    'artistSort': ('TSOP', 'ARTISTSORT', 'soar'),
    'albumSort': ('TSOA', 'ALBUMSORT', 'soal'),
    'albumArtistSort': ('TSO2', 'ALBUMARTISTSORT', 'soaa'),
    'composerSort': ('TSOC', 'COMPOSERSORT', 'soco'),
    'composer': ('TCOM', 'COMPOSER', '©wrt'),
    'genre': ('TCON', 'GENRE', '©gen'),
    'year': ('TDRC', 'DATE', '©day'),
    'trackNumber': ('TRCK', 'TRACKNUMBER', 'trkn'),
    'trackTotal': ('TRCK', 'TRACKTOTAL', 'trkn'),
    'discNumber': ('TPOS', 'DISCNUMBER', 'disk'),
    'discTotal': ('TPOS', 'DISCTOTAL', 'disk'),
    'compilation': ('TCMP', 'COMPILATION', 'cpil'),
    'bpm': ('TBPM', 'BPM', 'tmpo'),
    'key': ('TKEY', 'INITIALKEY', '----:com.apple.iTunes:initialkey'),
    'camelot': ('TXXX:KROBI_CAMELOT', 'KROBI_CAMELOT', '----:com.apple.iTunes:KROBI_CAMELOT'),
    'isrc': ('TSRC', 'ISRC', '----:com.apple.iTunes:ISRC'),
    'mbRecording': ('UFID:http://musicbrainz.org', 'MUSICBRAINZ_TRACKID', '----:com.apple.iTunes:MusicBrainz Track Id'),
    'mbRelease': ('TXXX:MusicBrainz Album Id', 'MUSICBRAINZ_ALBUMID', '----:com.apple.iTunes:MusicBrainz Album Id'),
    'mbReleaseGroup': ('TXXX:MusicBrainz Release Group Id', 'MUSICBRAINZ_RELEASEGROUPID', '----:com.apple.iTunes:MusicBrainz Release Group Id'),
    'mbArtist': ('TXXX:MusicBrainz Artist Id', 'MUSICBRAINZ_ARTISTID', '----:com.apple.iTunes:MusicBrainz Artist Id'),
    'mbAlbumArtist': ('TXXX:MusicBrainz Album Artist Id', 'MUSICBRAINZ_ALBUMARTISTID', '----:com.apple.iTunes:MusicBrainz Album Artist Id'),
    'comment': ('COMM::eng', 'COMMENT', '©cmt'),
    'trackGain': ('TXXX:REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_GAIN', '----:com.apple.iTunes:REPLAYGAIN_TRACK_GAIN'),
    'albumGain': ('TXXX:REPLAYGAIN_ALBUM_GAIN', 'REPLAYGAIN_ALBUM_GAIN', '----:com.apple.iTunes:REPLAYGAIN_ALBUM_GAIN'),
    'trackPeak': ('TXXX:REPLAYGAIN_TRACK_PEAK', 'REPLAYGAIN_TRACK_PEAK', '----:com.apple.iTunes:REPLAYGAIN_TRACK_PEAK'),
    'albumPeak': ('TXXX:REPLAYGAIN_ALBUM_PEAK', 'REPLAYGAIN_ALBUM_PEAK', '----:com.apple.iTunes:REPLAYGAIN_ALBUM_PEAK'),
    'r128TrackGain': ('TXXX:R128_TRACK_GAIN', 'R128_TRACK_GAIN', '----:com.apple.iTunes:R128_TRACK_GAIN'),
    'r128AlbumGain': ('TXXX:R128_ALBUM_GAIN', 'R128_ALBUM_GAIN', '----:com.apple.iTunes:R128_ALBUM_GAIN'),
    'analysisMarker': ('TXXX:KROBI_ANALYSIS', 'KROBI_ANALYSIS', '----:com.apple.iTunes:KROBI_ANALYSIS'),
}
GAIN_TAG_FIELDS = frozenset(('trackGain', 'albumGain', 'trackPeak', 'albumPeak', 'r128TrackGain', 'r128AlbumGain'))
ALIASES = {('mbRecording', 0): ('TXXX:MusicBrainz Track Id',), ('year', 0): ('TYER',), ('key', 0): ('TXXX:INITIALKEY',),
           ('key', 1): ('key',), ('trackTotal', 1): ('totaltracks',),
           ('discTotal', 1): ('totaldiscs', 'discc'), ('year', 1): ('year',),
           ('albumArtist', 1): ('album artist', 'album_artist'),
           ('albumArtistSort', 1): ('album artist sort', 'album_artist_sort')}
FORMATS = {'.mp3': 0, '.flac': 1, '.ogg': 1, '.opus': 1, '.m4a': 2, '.mp4': 2}
_locks_guard = threading.Lock()
_locks = {}


class TagError(Exception):
    def __init__(self, reason, status=409, current=None):
        self.reason, self.status, self.current = reason, status, current
        super().__init__(reason)


@contextmanager
def file_lock(path):
    key = str(Path(path).resolve())
    with _locks_guard:
        entry = _locks.setdefault(key, [threading.RLock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _locks_guard:
            entry[1] -= 1
            if not entry[1]:
                del _locks[key]


def load(path):
    mode = FORMATS.get(path.suffix.lower())
    if mode is None:
        raise TagError('unsupported-format', 422)
    if mode == 0:
        try:
            tags = id3.ID3(path, translate=False)
        except id3.ID3NoHeaderError:
            tags = id3.ID3()
        return tags, tags, mode
    audio = MutagenFile(path)
    if audio is None:
        raise TagError('unreadable', 422)
    if audio.tags is None:
        audio.add_tags()
    return audio, audio.tags, mode


def encode(value):
    if isinstance(value, bytes):
        return {'bytes': base64.b64encode(value).decode(), 'format': getattr(value, 'dataformat', None)}
    if isinstance(value, (list, tuple)):
        return [encode(v) for v in value]
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value


def decode(value):
    if isinstance(value, dict) and 'bytes' in value:
        data = base64.b64decode(value['bytes'])
        return MP4FreeForm(data, dataformat=value['format']) if value['format'] is not None else data
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def native(tags, mode):
    if mode == 0:
        output = io.BytesIO()
        tags.save(output, v2_version=4)
        return {'id3': base64.b64encode(output.getvalue()).decode()}
    return encode(dict(tags))


def restore(tags, mode, snapshot, keys):
    source = id3.ID3(io.BytesIO(base64.b64decode(snapshot['id3'])), translate=False) if mode == 0 else {
        k: decode(v) for k, v in snapshot.items()}
    for key in keys:
        if key in tags:
            del tags[key]
        if key in source:
            tags[key] = source[key]


def tag_block(path, tags, mode):
    """Hash the serialized metadata, including vendor atoms and FLAC pictures."""
    with path.open('rb') as handle:
        if mode == 0:
            head = handle.read(10)
            size = syncsafe(head[6:10]) if head[:3] == b'ID3' else 0
            return head + handle.read(size) if size else b''
        if path.suffix.lower() == '.flac' and handle.read(4) == b'fLaC':
            blocks = []
            while True:
                header = handle.read(4)
                if len(header) != 4:
                    raise TagError('unreadable', 422)
                blocks.append(header + handle.read(int.from_bytes(header[1:], 'big')))
                if header[0] & 128:
                    return b''.join(blocks)
        if mode == 2:
            def atoms(start, end):
                offset = start
                while offset + 8 <= end:
                    handle.seek(offset)
                    header = handle.read(8)
                    size, name = int.from_bytes(header[:4], 'big'), header[4:]
                    width = 8
                    if size == 1:
                        size = int.from_bytes(handle.read(8), 'big')
                        width = 16
                    if size == 0:
                        size = end - offset
                    if size < width or offset + size > end:
                        return None
                    if name == b'ilst':
                        handle.seek(offset)
                        return handle.read(size)
                    if name in (b'moov', b'udta', b'meta'):
                        found = atoms(offset + width + (4 if name == b'meta' else 0), offset + size)
                        if found is not None:
                            return found
                    offset += size
                return None
            block = atoms(0, path.stat().st_size)
            return block or b''
        if mode == 1 and path.suffix.lower() in ('.ogg', '.opus'):
            handle.seek(0)
            packet = bytearray()
            while True:
                header = handle.read(27)
                if len(header) != 27 or header[:4] != b'OggS':
                    break
                sizes = handle.read(header[26])
                for size in sizes:
                    packet.extend(handle.read(size))
                    if size < 255:
                        if packet.startswith((b'\x03vorbis', b'OpusTags')):
                            return bytes(packet)
                        packet.clear()
    return json.dumps(native(tags, mode), sort_keys=True, ensure_ascii=False).encode()


def identity(path, tags=None, mode=None, observed=None):
    before = observed or path.stat()
    if tags is None:
        _, tags, mode = load(path)
    raw = tag_block(path, tags, mode)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise TagError('changed-since')
    return {'size': after.st_size, 'mtimeNs': after.st_mtime_ns, 'tagSha': hashlib.sha256(raw).hexdigest()}


def revision(sig):
    return f'"t1-{sig["size"]}-{sig["mtimeNs"]}-{sig["tagSha"][:8]}"'


def values(tags, mode):
    result = {}
    for field, names in FIELDS.items():
        value = tags.get(names[mode])
        if value is None and field in GAIN_TAG_FIELDS:
            native = next((key for key in tags.keys() if key.casefold() == names[mode].casefold()), None)
            value = tags.get(native) if native is not None else None
        if field == 'year' and mode == 0 and value is None:
            value = tags.get('TYER')
        if value is None:
            for alias in ALIASES.get((field, mode), ()):
                if alias in tags:
                    value = tags[alias]
                    break
        if value is None:
            result[field] = None
            continue
        if hasattr(value, 'text'):
            value = [str(v) for v in value.text]
        elif hasattr(value, 'data'):
            value = [value.data.decode('utf-8', errors='replace')]
        if isinstance(value, (list, tuple)):
            value = list(value)
            if not value:
                result[field] = None
                continue
            if value and isinstance(value[0], bytes):
                value = [v.decode('utf-8', errors='replace') for v in value]
        if field in ('trackNumber', 'trackTotal', 'discNumber', 'discTotal'):
            try:
                pair = value[0] if mode == 2 else str(value[0]).split('/')
                index = int(field.endswith('Total')) if mode in (0, 2) else 0
                value = int(pair[index]) if len(pair) > index and pair[index] else None
            except (ValueError, TypeError, IndexError):
                value = None
        elif field in ('year', 'bpm'):
            try:
                value = float(str(value[0])[:4]) if field == 'year' else float(value[0])
                value = (int(value) if value.is_integer() else value) if math.isfinite(value) else None
            except (ValueError, TypeError):
                value = None
        elif field == 'compilation':
            value = bool(value) if mode == 2 else str(value[0]).strip().lower() in ('1', 'true', 'yes')
        else:
            value = value[0] if len(value) == 1 else value
        result[field] = value
    return result


def read(path):
    with file_lock(path):
        observed = path.stat()
        try:
            _, tags, mode = load(path)
            sig = identity(path, tags, mode, observed)
        except (MutagenError, OSError, ValueError, TagError) as error:
            if isinstance(error, TagError) and error.reason == 'changed-since':
                raise
            return {'fields': {}, 'format': path.suffix[1:], 'writable': False,
                    'reason': error.reason if isinstance(error, TagError) else 'unreadable', 'rev': ''}
        reason = None
        if mode == 0:
            try:
                raw_frames(path)
            except (TagError, MutagenError, ValueError):
                reason = 'unsupported-format'
        return {'fields': {k: v for k, v in values(tags, mode).items() if k not in GAIN_TAG_FIELDS | {'analysisMarker', 'camelot'}},
                'format': ('mp3' if mode == 0 else 'm4a' if mode == 2 else path.suffix[1:]),
                'writable': reason is None, 'rev': revision(sig), **({'reason': reason} if reason else {})}


def normalize(fields):
    result = {}
    for field, value in fields.items():
        if field not in FIELDS:
            raise TagError('invalid-field', 422)
        if value == '' or value == []:
            value = None
        if value is not None:
            if field in ('trackNumber', 'trackTotal', 'discNumber', 'discTotal', 'year', 'bpm'):
                limit = 9999 if field == 'year' else 65535 if field == 'bpm' else 999
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= limit:
                    raise TagError('invalid-value', 422)
                if field != 'bpm' and int(value) != value:
                    raise TagError('invalid-value', 422)
            elif field == 'compilation':
                if not isinstance(value, bool):
                    raise TagError('invalid-value', 422)
            else:
                strings = value if isinstance(value, list) else [value]
                if not strings or any(not isinstance(v, str) or len(v) > 1000 or any(
                        (ord(c) < 32 or 127 <= ord(c) < 160) and not (field == 'comment' and c == '\n') for c in v)
                        for v in strings):
                    raise TagError('invalid-value', 422)
                if field == 'key':
                    info = key_info(value) if isinstance(value, str) else {}
                    if not info.get('key'):
                        raise TagError('invalid-key', 422)
                    value = info['key'] + ('m' if info['scale'] == 'minor' else '')
        result[field] = value
    if 'key' in result:
        result['camelot'] = key_info(result['key'])['camelot']
    return result


# Model names only; all native frame/atom names live in FIELDS above.
METADATA_FIELDS = {
    'title': 'title', 'artist': 'artist', 'album': 'album', 'albumArtist': 'album_artist',
    'composer': 'composer', 'genre': 'genre', 'year': 'year', 'bpm': 'bpm', 'isrc': 'isrc',
    'trackNumber': 'track_number', 'trackTotal': 'track_total',
    'discNumber': 'disc_number', 'discTotal': 'disc_total', 'compilation': 'compilation',
    'mbRecording': 'recording_mbid', 'mbRelease': 'release_mbid',
    'mbReleaseGroup': 'release_group_mbid', 'mbArtist': 'artist_mbid',
}


def metadata_fields(metadata):
    fields = {key: getattr(metadata, attr) for key, attr in METADATA_FIELDS.items()
              if getattr(metadata, attr) is not None and getattr(metadata, attr) != ''}
    for prefix in ('track', 'disc'):
        if not fields.get(prefix + 'Number'):
            fields.pop(prefix + 'Number', None)
    if 'bpm' in fields:
        fields['bpm'] = float(fields['bpm'])
    return fields


def empty(value):
    if hasattr(value, 'text'):
        value = value.text
    elif hasattr(value, 'data'):
        value = value.data
    if isinstance(value, (list, tuple)):
        return not value or all(empty(v) for v in value)
    return value is None or value == '' or value == b''


def fill_gaps(tags, mode, fields, *, overwrite=False):
    """Choose fields under the writer lock, respecting occupied native pairs/aliases."""
    selected = {}
    for field, value in fields.items():
        # ID3/MP4 store a pair; Vorbis totals are independent comments.
        if mode in (0, 2) and field in ('trackTotal', 'discTotal') and not fields.get(field[:-5] + 'Number'):
            continue
        if overwrite or all(empty(tags.get(key)) for key in (FIELDS[field][mode], *ALIASES.get((field, mode), ()))):
            selected[field] = value
    return selected


def patch(tags, mode, fields):
    existing = values(tags, mode)
    keys = set()
    for field, value in fields.items():
        key = FIELDS[field][mode]
        if mode == 1:
            key = key.lower()
        keys.add(key)
        for alias in ALIASES.get((field, mode), ()):
            keys.add(alias)
            if alias in tags:
                del tags[alias]
        if field in ('trackTotal', 'discTotal', 'trackNumber', 'discNumber') and mode in (0, 2):
            prefix = 'track' if field.startswith('track') else 'disc'
            number = fields.get(prefix + 'Number', existing[prefix + 'Number'])
            total = fields.get(prefix + 'Total', existing[prefix + 'Total'])
            value = (number, total or 0) if number else None
        if key in tags:
            del tags[key]
        if value is None:
            continue
        if mode == 0:
            if isinstance(value, tuple):
                value = str(value[0]) + (f'/{value[1]}' if value[1] else '')
            if key.startswith('UFID:'):
                frame = id3.UFID(owner=key[5:], data=str(value).encode())
            else:
                text = [str(v) for v in value] if isinstance(value, list) else [str(int(value)) if isinstance(value, bool) else str(value)]
                name, _, desc = key.partition(':')
                extras = {'desc': desc} if name == 'TXXX' else {'desc': '', 'lang': 'eng'} if name == 'COMM' else {}
                frame = getattr(id3, name)(encoding=3, text=text, **extras)
            tags.add(frame)
        elif mode == 1:
            tags[key] = [str(v) for v in value] if isinstance(value, list) else [str(int(value)) if isinstance(value, bool) else str(value)]
        elif key == 'cpil':
            tags[key] = value
        elif key in ('trkn', 'disk'):
            tags[key] = [value]
        elif key == 'tmpo':
            tags[key] = [int(round(float(value)))]
        else:
            items = value if isinstance(value, list) else [str(value)]
            tags[key] = [MP4FreeForm(v.encode()) for v in items] if key.startswith('----:') else items
    return keys


def syncsafe(data):
    return sum(v << (7 * (len(data) - i - 1)) for i, v in enumerate(data))


def packed_size(size):
    return bytes((size >> shift) & 127 for shift in (21, 14, 7, 0))


def raw_frames(path):
    """Retain untouched ID3 frames as serialized bytes, including vendor payloads."""
    with path.open('rb') as handle:
        header = handle.read(10)
        if header[:3] != b'ID3':
            return None, []
        if len(header) != 10 or header[3] not in (3, 4) or header[4:6] != b'\x00\x00' or any(b & 128 for b in header[6:10]):
            raise TagError('unsupported-format')
        block = handle.read(syncsafe(header[6:10]))
    if len(block) != syncsafe(header[6:10]):
        raise TagError('unsupported-format')
    frames, offset = [], 0
    while offset + 10 <= len(block) and block[offset]:
        head = block[offset:offset + 10]
        if head[8:10] != b'\x00\x00' or not all(65 <= b <= 90 or 48 <= b <= 57 for b in head[:4]):
            raise TagError('unsupported-format')
        if header[3] == 4 and any(b & 128 for b in head[4:8]):
            raise TagError('unsupported-format')
        size = syncsafe(head[4:8]) if header[3] == 4 else int.from_bytes(head[4:8], 'big')
        raw = block[offset:offset + 10 + size]
        if len(raw) != size + 10:
            raise TagError('unsupported-format')
        isolated = b'ID3' + bytes((header[3], 0, 0)) + packed_size(len(raw)) + raw
        try:
            parsed = id3.ID3(io.BytesIO(isolated), translate=False)
        except (MutagenError, ValueError) as error:
            raise TagError('unsupported-format') from error
        key = next(iter(parsed), head[:4].decode('ascii'))
        frames.append((key, raw))
        offset += 10 + size
    if any(block[offset:]):
        # Only zero padding may follow the last complete frame.
        raise TagError('unsupported-format')
    return header[3], frames


def preserve_frames(original, temporary, changed, snapshot=None):
    old_version, old = raw_frames(original)
    version, new = raw_frames(temporary)
    if old_version is None:
        return
    switching = old_version != version
    if switching:
        # Unknown binary frames retain their payload when size encoding changes.
        converted = []
        for key, raw in old:
            size = len(raw) - 10
            encoded = packed_size(size) if version == 4 else size.to_bytes(4, 'big')
            converted.append((key, raw[:4] + encoded + raw[8:]))
        old = converted
    if snapshot and snapshot.get('frames'):
        restored = {key: base64.b64decode(raw) for key, raw in snapshot['frames']}
        new = [(key, restored.get(key, raw)) for key, raw in new]
        new.extend((key, raw) for key, raw in restored.items() if key not in {key for key, _ in new})
    converted = dict(new)
    retained = [(key, converted.get(key, raw) if switching else raw) for key, raw in old if key not in changed]
    payload = b''.join(raw for key, raw in new if key in changed) + b''.join(raw for _, raw in retained)
    # Replacing the tag on the disposable copy also preserves its audio bytes.
    with temporary.open('rb') as handle:
        header = handle.read(10)
        handle.seek(10 + syncsafe(header[6:10]))
        audio = handle.read()
    temporary.write_bytes(b'ID3' + bytes((version, 0, 0)) + packed_size(len(payload)) + payload + audio)


def write(path, fields=None, *, expected, prepare=None, complete=None, transform=None, snapshot=None, keys=None, id3_version=4, mutation=None):
    """Return (before identity, after identity, changed), never saving the original.

    transform receives detached tags while the file lock is held. Analysis uses
    it to make its ownership decision against the same state that gets written.
    """
    path = Path(path)
    with file_lock(path):
        observed = path.stat()
        try:
            audio, tags, mode = load(path)
        except MutagenError as error:
            raise TagError('unreadable', 422) from error
        before = identity(path, tags, mode, observed)
        if expected != before and expected != revision(before) and expected != (before['size'], before['mtimeNs']):
            raise TagError('changed-since', current=read(path))
        if path.stat().st_nlink > 1:
            raise TagError('hardlinked')
        if mode == 0:
            version, frames = raw_frames(path)
        previous = native(tags, mode)
        if mode == 0:
            previous['version'] = version or 4
            previous['frames'] = [(key, base64.b64encode(raw).decode()) for key, raw in frames]
        before_values = values(tags, mode)
        if transform:
            fields = transform(tags, mode)
        fields = normalize(fields or {})
        if snapshot is not None:
            restore(tags, mode, snapshot, keys)
            id3_version = snapshot.get('version', id3_version) if mode == 0 else id3_version
            changed_keys = set(keys)
        elif mutation:
            changed_keys = set(mutation(tags, mode))
            if native(tags, mode) == {k: v for k, v in previous.items() if k not in ('version', 'frames')}:
                return before, before, False
        else:
            if all(before_values[k] == v for k, v in fields.items()):
                return before, before, False
            changed_keys = patch(tags, mode, fields)
            # A skipped total-only pair or MP4 tempo rounded to the existing
            # integer is also a no-op: do not replace the file or journal it.
            if native(tags, mode) == {k: v for k, v in previous.items() if k not in ('version', 'frames')}:
                return before, before, False
        if id3_version not in (3, 4):
            raise TagError('invalid-id3-version', 422)
        if shutil.disk_usage(path.parent).free < 2 * before['size']:
            raise TagError('no-space', 507)
        fd, filename = tempfile.mkstemp(prefix='.krobi-tmp-', suffix=path.suffix, dir=path.parent)
        os.close(fd)
        temporary = Path(filename)
        replaced = False
        try:
            shutil.copy2(path, temporary)
            if mode == 0:
                # translate=False prevents automatic dropping of older/unknown frames.
                if id3_version == 3 and 'TDRC' in changed_keys and 'TDRC' in tags:
                    tags.add(id3.TYER(encoding=1, text=[str(tags['TDRC'])[:4]]))
                    del tags['TDRC']
                    changed_keys.add('TYER')
                tags.save(temporary, v2_version=id3_version, v23_sep='; ')
                preserve_frames(path, temporary, changed_keys, snapshot)
            else:
                audio.save(temporary)
            with temporary.open('r+b') as handle:
                os.fsync(handle.fileno())
            os.utime(temporary, ns=(observed.st_atime_ns, observed.st_mtime_ns))
            after = identity(temporary)
            if identity(path) != before:
                raise TagError('changed-since', current=read(path))
            if prepare:
                prepare(before, after, before_values, values(tags, mode), previous, sorted(changed_keys))
            # A durable journal commit can block: check again immediately before rename.
            if identity(path) != before:
                raise TagError('changed-since', current=read(path))
            os.replace(temporary, path)
            replaced = True
            fsync_directory(path.parent)
            if complete:
                complete(after)
            return before, after, True
        except TagError:
            raise
        except OSError as error:
            if replaced:
                raise
            raise TagError('no-space' if error.errno == 28 else 'write-failed', 507 if error.errno == 28 else 500) from error
        except Exception as error:
            raise TagError('write-failed', 500) from error
        finally:
            if replaced:
                os.utime(path, ns=(observed.st_atime_ns, observed.st_mtime_ns))
            else:
                temporary.unlink(missing_ok=True)


def subset(snapshot, keys):
    if 'id3' in snapshot:
        tags = id3.ID3(io.BytesIO(base64.b64decode(snapshot['id3'])), translate=False)
        for key in list(tags):
            if key not in keys:
                del tags[key]
        output = io.BytesIO()
        tags.save(output, v2_version=4)
        snapshot = {**snapshot, 'id3': base64.b64encode(output.getvalue()).decode(),
                    'frames': [(key, raw) for key, raw in snapshot.get('frames', []) if key in keys]}
    else:
        snapshot = {key: value for key, value in snapshot.items() if key in keys}
    return snapshot
