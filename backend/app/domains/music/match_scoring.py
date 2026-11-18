"""MusicBrainz field proposals and conservative, explainable match bands."""
from app.domains.metadata.matching import (
    WantedTrack, match_track, STRONG_MAX_DISTANCE, REVIEW_MAX_DISTANCE, REQUIRED_GAP,
)
from app.domains.metadata.musicbrainz_repository import MusicBrainzRepository, artist_credit_text
from app.domains.metadata.normalization import string_distance
from app.domains.metadata import tagwriter


def wanted(file):
    fields = file['now']
    return WantedTrack(fields.get('title') or file['relPath'].rsplit('/', 1)[-1].rsplit('.', 1)[0],
                       fields.get('artist'), fields.get('album'), file.get('duration'))


def recording_fields(raw):
    fields = {'title': raw.get('title'), 'artist': artist_credit_text(raw.get('artist-credit')),
              'mbRecording': raw.get('id')}
    if raw.get('isrcs'):
        fields['isrc'] = raw['isrcs'][0]
    return fields


def release_tracks(raw):
    tracks = []
    media = raw.get('media') or []
    for disc, medium in enumerate(media, 1):
        for number, track in enumerate(medium.get('tracks') or [], 1):
            recording = track.get('recording') or {}
            if not recording.get('id'):
                continue
            recording = {**recording, 'title': track.get('title') or recording.get('title'),
                         'length': track.get('length') or recording.get('length'),
                         'artist-credit': track.get('artist-credit') or recording.get('artist-credit') or raw.get('artist-credit')}
            fields = {**recording_fields(recording), 'album': raw.get('title'),
                      'albumArtist': artist_credit_text(raw.get('artist-credit')),
                      'mbRelease': raw.get('id'), 'mbReleaseGroup': (raw.get('release-group') or {}).get('id'),
                      'trackNumber': track.get('position') or number, 'trackTotal': len(medium.get('tracks') or []),
                      'discNumber': medium.get('position') or disc, 'discTotal': len(media)}
            year = str(raw.get('date') or '')[:4]
            if year.isdigit():
                fields['year'] = int(year)
            tracks.append((recording, fields))
    return tracks


def preview(file, fields):
    # Missing provider facts do not erase a person's tags.
    fields = tagwriter.normalize({k: v for k, v in fields.items() if v is not None})
    return {'relPath': file['relPath'], 'rev': file['rev'],
            'fields': {k: {'now': file['now'].get(k), 'new': v} for k, v in fields.items() if file['now'].get(k) != v},
            'same': sum(file['now'].get(k) == v for k, v in fields.items())}


def score(raw, files, album=False):
    tracks = release_tracks(raw) if album else [(raw, recording_fields(raw))]
    pairs, distances, vetoes, reasons, hits = [], [], [], [], 0
    remaining = list(tracks)
    for file in files:
        target = wanted(file)
        candidates = [(r, f, MusicBrainzRepository._to_candidate(r)) for r, f in remaining]
        candidates = [(r, f, c) for r, f, c in candidates if c]
        if not candidates:
            continue
        # Match across the complete release rather than trusting local filename order.
        result = match_track(target, [c for _, _, c in candidates])
        best = result.best
        raw_track, fields, _ = next((r, f, c) for r, f, c in candidates if c is best.candidate)
        remaining.remove((raw_track, fields))
        distance = best.distance
        isrcs = raw_track.get('isrcs') or []
        if file['now'].get('isrc') and file['now']['isrc'] in isrcs:
            hits += 1
        elif file['now'].get('isrc') and isrcs:
            vetoes.append(True)
            reasons.append('ISRC differs')
        if file['now'].get('mbRecording') and file['now']['mbRecording'] != raw_track.get('id'):
            vetoes.append(True)
            reasons.append('MusicBrainz recording ID differs')
        distances.append(distance)
        vetoes.append(best.vetoed)
        # Equal local tracks cannot silently claim the same remote recording.
        if result.confidence.value == 'review' and result.runner_up and not result.runner_up.vetoed and result.runner_up.distance - distance < REQUIRED_GAP:
            vetoes.append(True)
            reasons.append('Track assignment needs review')
        if file.get('duration') is not None and best.candidate.duration_s is not None:
            reasons.append(f"Duration differs by {abs(file['duration'] - best.candidate.duration_s):.1f} s")
        reasons.extend(best.reasons)
        pairs.append(preview(file, fields))
    count_diff = abs(len(files) - len(tracks))
    if album:
        reasons.insert(0, f"{len(tracks)} tracks · {len(files)} files" + (f' · {count_diff} different' if count_diff else ' · same track count'))
    reasons.append(f'{hits} ISRC hits')
    distance = sum(distances) / len(distances) if distances else 1.0
    if album:
        distance = (distance * 3 + string_distance(wanted(files[0]).album or '', raw.get('title') or '')) / 4
    band = 'weak' if distance > REVIEW_MAX_DISTANCE or not pairs else 'review' if any(vetoes) or count_diff or distance > STRONG_MAX_DISTANCE else 'strong'
    return {'id': raw['id'], 'title': raw.get('title') or '',
            'subtitle': ' · '.join(str(v) for v in (artist_credit_text(raw.get('artist-credit')), raw.get('date'), raw.get('country')) if v),
            'band': band, 'reasons': list(dict.fromkeys(reasons)), 'files': pairs,
            '_distance': distance, '_vetoed': any(vetoes)}


def rank(candidates):
    candidates.sort(key=lambda c: (c['_vetoed'], c['_distance']))
    # Only the unambiguous winner is eligible for a preselection.
    for idx, candidate in enumerate(candidates):
        if candidate['band'] == 'strong' and (idx > 0 or len(candidates) > 1 and not candidates[1]['_vetoed'] and candidates[1]['_distance'] - candidate['_distance'] < REQUIRED_GAP):
            candidate['band'] = 'review'
            candidate['reasons'].append('Similar candidates need review')
    return candidates
