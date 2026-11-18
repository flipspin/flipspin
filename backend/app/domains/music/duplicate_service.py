"""Nest-local, read-only duplicate jobs. fpcalc is optional, bounded and cached."""
import hashlib
import json
import logging
import math
import shutil
import subprocess
import threading
import uuid
from datetime import UTC, datetime
from itertools import combinations

from mutagen import File as MutagenFile, MutagenError

from app.domains.music.duplicate_groups import groups
from app.domains.music.duplicate_repository import DuplicateRepository
from app.exceptions import ValidationError
from app.utils.library_paths import rel_path_for, resolve_rel_path

logger = logging.getLogger(__name__)


class DuplicateError(ValueError):
    def __init__(self, reason, status=409):
        self.reason, self.status = reason, status


class DuplicateService:
    def __init__(self, config, music, repository, tracker, user_tracks):
        self.config, self.music, self.tracker = config, music, tracker
        self.repository = DuplicateRepository(repository)
        self.user_tracks, self.lock = user_tracks, threading.RLock()

    @property
    def root(self):
        return str(self.config.base_music_dir.resolve())

    def start(self):
        with self.lock:
            root = self.root
            previous, result = self.repository.scan(root)
            job = self.tracker.ledger.get(previous) if previous else None
            if job and job['state'] in ('queued', 'running'):
                return previous, root, False
            job_id = uuid.uuid4().hex
            self.tracker.create_progress(job_id, 1, kind='scan', label='Find duplicates', items=['Library'])
            self.repository.store_scan(root, job_id, result)
            return job_id, root, True

    def fingerprint(self, root, rel, path, signature, executable):
        found, value = self.repository.fingerprint(root, rel, signature)
        if found:
            return value
        try:
            # A short signature only; never decode the entire song or fetch an engine.
            output = subprocess.run([executable, '-json', '-length', '120', str(path)],
                                    capture_output=True, timeout=30, check=True)
            raw = json.loads(output.stdout)
            value = raw.get('fingerprint') if isinstance(raw, dict) else None
            if not isinstance(value, str) or not value or len(value) > 65536:
                value = None
            else:
                value = hashlib.sha256(value.encode()).hexdigest()
        except (OSError, ValueError, subprocess.SubprocessError):
            value = None
        if value:
            self.repository.save_fingerprint(root, rel, signature, value)
        return value

    def active(self, job_id):
        job = self.tracker.ledger.get(job_id)
        return job and job['state'] in ('queued', 'running')

    def run(self, job_id, root):
        self.tracker.set_status(job_id, 'in_progress')
        try:
            if not self.active(job_id):
                self.tracker.complete_progress(job_id, 'cancelled')
                return
            if self.root != root or not self.config.base_music_dir.is_dir():
                raise DuplicateError('library-unavailable')
            executable = shutil.which('fpcalc')
            files, skipped = [], 0
            # Enumerate through the music repository's discovery rules. No scan,
            # analysis, tag write, or playlist mutation is triggered by this job.
            for paths in self.music.album_files(self.config.base_music_dir).values():
                for candidate in paths:
                    if not self.active(job_id):
                        self.tracker.complete_progress(job_id, 'cancelled')
                        return
                    try:
                        rel = rel_path_for(self.config.base_music_dir, candidate)
                        if rel is None:
                            skipped += 1
                            continue
                        path = resolve_rel_path(self.config.base_music_dir, rel)
                        stat = path.stat()
                        if not path.is_file():
                            continue
                        tags = self.music.read_tags(path)
                        audio = MutagenFile(path)
                        bitrate = getattr(getattr(audio, 'info', None), 'bitrate', None)
                        codec = type(audio).__name__.lower()
                        fmt = 'ALAC' if 'alac' in codec or (path.suffix.lower() == '.m4a' and
                            getattr(getattr(audio, 'info', None), 'codec', '') == 'alac') else path.suffix[1:].upper()
                        duration = tags.get('duration')
                        if duration is None or not math.isfinite(duration) or duration <= 0:
                            duration = None
                        signature = f'{stat.st_size}:{stat.st_mtime_ns}'
                        fingerprint = self.fingerprint(root, rel, path, signature, executable) if executable else None
                        # Discard an observation whose source changed while it was read.
                        after = path.stat()
                        if (after.st_size, after.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
                            skipped += 1
                            continue
                        skipped += int(bool(executable) and not fingerprint)
                        files.append({'relPath': rel, 'title': tags.get('title') or '', 'artist': tags.get('artist') or '',
                                      'album': tags.get('album') or '', 'format': fmt, 'bitrate': round(bitrate / 1000) if bitrate else None,
                                      'duration': duration, 'plays': 0, 'missing': False, 'signature': signature,
                                      'fingerprint': fingerprint})
                    except (OSError, ValueError, ValidationError, MutagenError):
                        skipped += 1
            with self.lock:
                if not self.active(job_id):
                    self.tracker.complete_progress(job_id, 'cancelled')
                    return
                if self.root != root:
                    raise DuplicateError('library-changed')
                by_path = {file['relPath']: file for file in files}
                candidates = [[by_path[file['relPath']] for file in group['files']] for group in groups(files, {}, root=root)]
                self.repository.store_scan(root, job_id, {'checked': True, 'checkedAt': datetime.now(UTC).isoformat(), 'candidates': candidates, 'audio': 'available' if executable else 'unavailable', 'audioSkipped': skipped})
            self.tracker.update_progress(job_id, 'Library')
            self.tracker.complete_progress(job_id, succeeded=1, failed=0)
        except Exception as error:
            logger.warning('Duplicate scan failed (%s); retaining the previous result', type(error).__name__)
            self.tracker.complete_progress(job_id, 'failed', succeeded=0, failed=1)

    def view(self):
        with self.lock:
            root = self.root
            job_id, result = self.repository.scan(root)
            job = self.tracker.ledger.get(job_id) if job_id else None
            files = [file for candidate in result['candidates'] for file in candidate]
            for file in files:
                try:
                    path = resolve_rel_path(self.config.base_music_dir, file['relPath'])
                    stat = path.stat()
                    file['missing'] = not path.is_file() or file['signature'] != f'{stat.st_size}:{stat.st_mtime_ns}'
                except (OSError, ValueError, ValidationError):
                    file['missing'] = True
                file['plays'] = sum(row.play_count for row in self.user_tracks.references_for_path(file['relPath']))
            pairs = self.repository.pairs(root)
            return {'jobId': job_id, 'state': job['state'] if job else 'succeeded' if result.get('checked') else 'idle',
                    'audio': result['audio'], 'audioSkipped': result['audioSkipped'],
                    'groups': [group for candidate in result['candidates']
                               for group in groups(candidate, pairs, root=root)]}

    def preference(self, group_id, keep=None, dismiss=False):
        with self.lock:
            group = next((g for g in self.view()['groups'] if g['groupId'] == group_id), None)
            if not group and dismiss:
                _, stored = self.repository.scan(self.root)
                group = next((g for candidate in stored['candidates'] for g in groups(candidate, {}, root=self.root)
                              if g['groupId'] == group_id), None)
            if not group:
                raise DuplicateError('group-changed')
            if keep is not None and not any(f['relPath'] == keep and not f['missing'] for f in group['files']):
                raise DuplicateError('keeper-unavailable')
            paths = [f['relPath'] for f in group['files']]
            for left, right in combinations(paths, 2):
                if dismiss or keep in (left, right):
                    self.repository.prefer(self.root, left, right, dismissed=dismiss, keeper=keep)
            return self.view()
