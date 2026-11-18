"""Owner health from scan publications and stored duplicate preferences only."""
import logging
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.domains.metadata.normalization import has_remaster_suffix
from app.domains.music.duplicate_groups import groups
from app.domains.music.duplicate_repository import DuplicateRepository
from app.utils.library_paths import rel_path_for

logger = logging.getLogger(__name__)


class HealthSource(BaseModel):
    store: str
    asOf: str | None


class HealthSong(BaseModel):
    relPath: str
    title: str
    artist: str


class HealthCheck(BaseModel):
    id: Literal['missing', 'unreadable', 'estimates', 'duplicates', 'unmatched', 'remaster']
    state: Literal['ready', 'unavailable'] = 'ready'
    count: int | None = None
    reason: str | None = None
    source: HealthSource
    folders: int | None = None
    topFolder: str | None = None
    keys: int | None = None
    bpms: int | None = None
    songs: int | None = None
    sameAudio: int | None = None
    sameTags: int | None = None
    tracks: list[HealthSong] = Field(default_factory=list)
    relPaths: list[str] = Field(default_factory=list)
    albumKeys: list[str] = Field(default_factory=list)


class HealthStat(BaseModel):
    value: int | str | None
    state: Literal['ready', 'unavailable'] = 'ready'
    reason: str | None = None
    source: HealthSource


class HealthStats(BaseModel):
    songs: HealthStat
    albums: HealthStat
    addedThisWeek: HealthStat
    lastScanAt: HealthStat
    lastBackupAt: HealthStat


class LibraryHealthResponse(BaseModel):
    checkedAt: str | None
    stats: HealthStats
    checks: list[HealthCheck]


def source(store, as_of):
    return {'store': store, 'asOf': as_of}


def unavailable(check_id, store, reason, as_of=None):
    return {'id': check_id, 'state': 'unavailable', 'reason': reason, 'source': source(store, as_of)}


class LibraryHealth:
    def __init__(self, music, missing, backups):
        self.music, self._missing, self.backups = music, missing, backups
        self.duplicates = DuplicateRepository(music.analysis)

    @property
    def missing(self):
        # Missing-file composition may inspect the mount. Only the scanner's
        # publication needs it, never the first health request after a restart.
        return self._missing()

    def publish(self, root, albums, present, folders, as_of):
        """Called by the existing scanner, using its discovery (no second walk)."""
        snapshot = {'checkedAt': as_of, 'checks': [], 'duplicateRoot': str(root.resolve())}
        tracks = [t for a in albums for t in a.tracks]
        scan_source = source('music-scan.snapshots / tags', as_of)
        snapshot['stats'] = {key: {'value': value, 'source': scan_source} for key, value in (
            ('songs', len(tracks)), ('albums', len(albums)),
        )}
        # Keep stamps so the rolling seven-day window stays correct between scans.
        snapshot['firstSeen'] = self.music.scans.store.first_seen(t.path for t in tracks)
        try:
            snapshot['checks'].append(self.missing.health(present, folders, as_of))
        except Exception:
            logger.exception('Missing health publication failed')
            snapshot['checks'].append(unavailable('missing', 'music-scan.health / missing-files.known / absence', 'source-failed', as_of))
        estimates = [t.analysis or {} for t in tracks]
        snapshot['checks'].append({'id': 'estimates', 'count': sum(bool(t.get('keyEstimated') or t.get('bpmEstimated')) for t in estimates),
            'keys': sum(bool(t.get('keyEstimated')) for t in estimates), 'bpms': sum(bool(t.get('bpmEstimated')) for t in estimates),
            'source': source('track_analysis / music-scan.tags (analysis precedence)', as_of)})
        unmatched, remasters = [], []
        unmatched_albums = set()
        for track in tracks:
            rel = rel_path_for(root, track.path)
            tags = self.music._tag_cache.get(str(track.path), (None, {}))[1]
            if not tags.get('recording_mbid'):
                unmatched.append(rel)
                unmatched_albums.add(rel.split('/')[0])
            if not tags.get('release_mbid'):
                unmatched_albums.add(rel.split('/')[0])
            if has_remaster_suffix(tags.get('title', '')):
                remasters.append({'relPath': rel, 'title': track.title, 'artist': track.artist})
        snapshot['checks'].extend([
            {'id': 'unmatched', 'count': len(unmatched_albums), 'songs': len(unmatched), 'albumKeys': sorted(unmatched_albums),
             'relPaths': unmatched, 'source': source('music-scan.tags.recording_mbid / release_mbid', as_of)},
            {'id': 'remaster', 'count': len(remasters), 'tracks': remasters, 'source': source('music-scan.tags.title / metadata.normalization', as_of)},
        ])
        if root == self.music.config.base_music_dir:
            self.music.scans.store.save_health(root, snapshot)

    def snapshot(self, now=None):
        now = now or datetime.now(UTC)
        root = self.music.config.base_music_dir
        cache_reason = 'not-scanned'
        try:
            cached = self.music.scans.store.health(root)
        except Exception:
            logger.exception('Library health snapshot read failed')
            cached, cache_reason = None, 'source-failed'
        if self.music.scans.health_error:
            cached, cache_reason = None, 'source-failed'
        as_of = cached['checkedAt'] if cached else None
        scan = self.music.scans.status()
        scan_error = scan['error'] if self.music.scans.root == root else 'not-scanned'
        stats = cached['stats'] if cached else {}
        for key in ('songs', 'albums'):
            stats.setdefault(key, {'value': None, 'state': 'unavailable', 'reason': cache_reason, 'source': source('music-scan.snapshots', None)})
        stats['addedThisWeek'] = {'value': sum(now.timestamp() - 7 * 86400 <= stamp <= now.timestamp() for stamp in cached.get('firstSeen', [])) if cached else None,
            'state': 'ready' if cached else 'unavailable', 'reason': None if cached else cache_reason,
            'source': source('music-scan.tags.first_seen', as_of)}
        stats['lastScanAt'] = {'value': scan['lastScanAt'] if self.music.scans.root == root else None,
            'source': source('music-scan.snapshots.completed_at', as_of)}
        stats['lastBackupAt'] = self.backups.health
        checks = cached['checks'] if cached else [unavailable(id, store, cache_reason) for id, store in (
            ('missing', 'music-scan.health / missing-files.known / absence'), ('estimates', 'track_analysis / music-scan.tags'),
            ('unmatched', 'music-scan.tags.recording_mbid / release_mbid'), ('remaster', 'music-scan.tags.title / metadata.normalization'))]
        if scan_error:
            checks = [unavailable(c['id'], c['source']['store'], 'scan-' + scan_error, c['source']['asOf']) for c in checks]
        try:
            duplicate_root = cached.get('duplicateRoot', str(root)) if cached else str(root)
            _, result = self.duplicates.scan(duplicate_root)
            if not result.get('checked'):
                duplicate = unavailable('duplicates', 'duplicate_scan / duplicate_pair', 'not-scanned')
            else:
                pairs = self.duplicates.pairs(duplicate_root)
                found = [g for candidate in result['candidates'] for g in groups(candidate, pairs, root=duplicate_root)]
                duplicate = {'id': 'duplicates', 'count': len(found), 'sameAudio': sum(g['basis'] == 'audio' for g in found),
                    'sameTags': sum(g['basis'] == 'tags' for g in found),
                    'source': source('duplicate_scan / duplicate_pair', result.get('checkedAt'))}
            checks.append(duplicate)
        except Exception:
            logger.exception('Duplicate health read failed')
            checks.append(unavailable('duplicates', 'duplicate_scan / duplicate_pair', 'source-failed'))
        order = ('missing', 'unreadable', 'estimates', 'duplicates', 'unmatched', 'remaster')
        checks.sort(key=lambda check: order.index(check['id']))
        return {'checkedAt': as_of, 'stats': stats, 'checks': checks}
