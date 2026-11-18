"""Conservative, pairwise grouping; preferences never change audio or references."""
import hashlib
import json
from collections import defaultdict
from itertools import combinations

from app.domains.metadata.normalization import normalize_key, qualifier_mismatch

LOSSLESS = {'flac', 'wav', 'alac'}


def quality(file):
    return (file['format'].lower() in LOSSLESS, file['bitrate'] or 0, file['relPath'])


def tag_key(file):
    # Separate components also avoid ambiguous artist/title concatenations.
    return (normalize_key(file['artist'], ''), normalize_key('', file['title']), normalize_key('', file['album']))


def close(left, right):
    return (left['duration'] is not None and right['duration'] is not None
            and abs(left['duration'] - right['duration']) <= 2
            and not qualifier_mismatch(left['title'], right['title']))


def groups(files, pairs, *, root=''):
    """Partition cliques, never transitive chains that exceed the length tolerance.

    Audio takes precedence. A rejected pair cannot reappear via a third file or
    the other match level. Files with unavailable tags cannot form tag groups.
    """
    audio, tags = defaultdict(list), defaultdict(list)
    for file in files:
        if file.get('fingerprint'):
            audio[file['fingerprint']].append(file)
        if all(tag_key(file)):
            tags[tag_key(file)].append(file)
    result, claimed = [], set()
    for basis, buckets in (('audio', audio), ('tags', tags)):
        for bucket in buckets.values():
            partitions = []
            for file in sorted(bucket, key=lambda f: (f['duration'] or 0, f['relPath'])):
                if file['relPath'] in claimed:
                    continue
                target = next((part for part in partitions if all(
                    close(file, other) and not pairs.get(tuple(sorted((file['relPath'], other['relPath']))), {}).get('dismissed')
                    for other in part)), None)
                if target is None:
                    partitions.append([file])
                else:
                    target.append(file)
            for part in partitions:
                if len(part) < 2 or not any(not f['missing'] for f in part):
                    continue
                available = [f for f in part if not f['missing']]
                votes = defaultdict(int)
                for left, right in combinations(part, 2):
                    preference = pairs.get(tuple(sorted((left['relPath'], right['relPath']))), {}).get('keeper')
                    votes[preference] += 1
                keeper = max(available, key=lambda f: (votes[f['relPath']], *quality(f)))
                identity = [(f['relPath'], f['signature']) for f in sorted(part, key=lambda f: f['relPath'])]
                group_id = hashlib.sha256(json.dumps([root, identity]).encode()).hexdigest()[:32]
                rows = []
                for file in sorted(part, key=lambda f: (f is not keeper, f['relPath'])):
                    difference = {
                        'format': file['format'] != keeper['format'],
                        'bitrate': None if file['bitrate'] is None or keeper['bitrate'] is None else file['bitrate'] - keeper['bitrate'],
                        'duration': None if file['duration'] is None or keeper['duration'] is None else round(file['duration'] - keeper['duration'], 3),
                        'plays': file['plays'] - keeper['plays'],
                    }
                    rows.append({k: v for k, v in file.items() if k not in ('fingerprint', 'signature')} | {'difference': difference})
                result.append({'groupId': group_id, 'basis': basis, 'keeper': keeper['relPath'],
                               'title': keeper['title'], 'artist': keeper['artist'], 'files': rows})
                claimed.update(f['relPath'] for f in part)
    return sorted(result, key=lambda g: (g['title'].casefold(), g['groupId']))
