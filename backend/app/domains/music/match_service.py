"""Owner matching jobs: persist proposals, approve a plan, use the one tag journal."""
import json
import logging
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from app.domains.metadata import tagwriter
from app.domains.music import match_scoring
from app.domains.music.library_files import AUDIO_EXTENSIONS
from app.exceptions import ExternalAPIError, ValidationError
from app.infra.jobs import JobConflict
from app.utils.library_paths import album_dir_of, rel_path_for, resolve_rel_path

logger = logging.getLogger(__name__)


class MatchService:
    def __init__(self, config, edits, provider, tracker, *, now=time.time):
        self.config, self.edits, self.provider, self.tracker = config, edits, provider, tracker
        self.repository, self.music = edits.repository, edits.music
        self.ledger, self.now, self.lock = tracker.ledger, now, threading.RLock()

    def path(self, rel):
        try:
            path = resolve_rel_path(self.config.base_music_dir, rel)
            if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
                raise ValueError()
            return rel_path_for(self.config.base_music_dir, path), path
        except (OSError, ValueError, ValidationError):
            raise tagwriter.TagError('missing', 404)

    @staticmethod
    def link(value, album):
        url = urlparse(value)
        parts = url.path.strip('/').split('/')
        kind = 'release' if album else 'recording'
        if url.scheme != 'https' or url.netloc != 'musicbrainz.org' or len(parts) != 2 or parts[0] != kind or url.query or url.fragment:
            raise tagwriter.TagError('invalid-musicbrainz-link', 422)
        try:
            return parts[0], str(uuid.UUID(parts[1]))
        except ValueError:
            raise tagwriter.TagError('invalid-musicbrainz-link', 422)

    def start(self, body, principal):
        album = body.get('albumKey') is not None
        paths = body.get('relPaths')
        if album:
            # Keys retain the library's shallow wire shape, including its encoded nested keys.
            key = body['albumKey']
            from app.utils.library_paths import resolve_album
            try:
                folder = resolve_album(self.config.base_music_dir, key)
                paths = [rel_path_for(self.config.base_music_dir, p) for p in folder.rglob('*')
                         if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS
                         and album_dir_of(self.config.base_music_dir.resolve(), p) == folder]
            except (OSError, ValueError, ValidationError):
                raise tagwriter.TagError('missing', 404)
        if paths and any(p is None for p in paths):
            raise tagwriter.TagError('missing', 404)
        if not paths or len(paths) > 200 or len(paths) != len(set(paths)):
            raise tagwriter.TagError('invalid-scope', 422)
        snapshots = []
        for rel in sorted(paths):
            rel, path = self.path(rel)
            with tagwriter.file_lock(path):
                view = tagwriter.read(path)
                if not view['writable']:
                    raise tagwriter.TagError(view.get('reason') or 'unreadable', 422)
                snapshots.append({'relPath': rel, 'rev': view['rev'], 'now': view['fields'],
                                  'duration': self.music.read_tags(path).get('duration')})
        request = {'files': snapshots, 'album': album, 'query': body.get('query'), 'link': body.get('link')}
        if request['link']:
            self.link(request['link'], album)
        with self.lock:
            for job in self.ledger.list():
                if job['kind'] != 'match' or job['state'] not in ('queued', 'running'):
                    continue
                existing = self.stored(job['id'])
                if existing['request'] == request:
                    return job['id'], False
                previous = {f['relPath']: f['rev'] for f in existing['request']['files']}
                if (request['query'] == existing['request']['query'] and request['link'] == existing['request']['link']
                        and all(previous.get(f['relPath']) == f['rev'] for f in snapshots)):
                    return job['id'], False
                overlap = {f['relPath'] for f in existing['request']['files']} & set(paths)
                if job['starter_user_id'] == principal or overlap:
                    raise tagwriter.TagError('busy', current={'jobId': job['id']})
            job_id = uuid.uuid4().hex
            with self.repository.connection() as db:
                db.execute('DELETE FROM match_proposal WHERE created_at<?', (self.now() - 7 * 86400,))
                db.execute('INSERT INTO match_proposal VALUES(?,?,?,?,?)',
                           (job_id, principal, self.now(), json.dumps(request), json.dumps({'candidates': [], 'errors': []})))
            self.tracker.create_progress(job_id, len(snapshots), kind='match', label='MusicBrainz match',
                items=[{'item': f['relPath'], 'rel_path': f['relPath']} for f in snapshots])
            return job_id, True

    def stored(self, job_id):
        with self.repository.connection() as db:
            row = db.execute('SELECT * FROM match_proposal WHERE job_id=? AND created_at>?', (job_id, self.now() - 7 * 86400)).fetchone()
        if not row:
            raise tagwriter.TagError('missing', 404)
        return {**dict(row), 'request': json.loads(row['request']), 'proposal': json.loads(row['proposal'])}

    def store_candidates(self, job_id, candidates, errors):
        with self.repository.connection() as db:
            db.execute('UPDATE match_proposal SET proposal=? WHERE job_id=?',
                       (json.dumps({'candidates': candidates, 'errors': errors}), job_id))

    def active(self, job_id):
        job = self.ledger.get(job_id)
        return job and job['state'] in ('queued', 'running')

    def run(self, job_id):
        request = self.stored(job_id)['request']
        self.tracker.set_status(job_id, 'in_progress')
        candidates, errors = [], []
        files, album = request['files'], request['album']
        units = [list(enumerate(files))] if album else [[(idx, file)] for idx, file in enumerate(files)]
        for indexed in units:
            unit = [file for _, file in indexed]
            if not self.active(job_id):
                break
            try:
                target = match_scoring.wanted(unit[0])
                if request['link']:
                    _, mbid = self.link(request['link'], album)
                    ids = [mbid]
                elif album:
                    ids = [r['id'] for r in self.provider.search_releases(request['query'] or target.album or Path(unit[0]['relPath']).parent.name,
                        target.artist, free_text=bool(request['query'])) if r.get('id')][:5]
                else:
                    found = self.provider.search_candidates(request['query']) if request['query'] else self.provider.search_recordings(target.title, target.artist)
                    ids = [c.recording_mbid for c in found if c.recording_mbid][:5]
                batch = []
                for mbid in dict.fromkeys(ids):
                    if not self.active(job_id):
                        break
                    raw = self.provider.lookup_release(mbid) if album else self.provider.lookup_recording(mbid)
                    batch.append(match_scoring.score(raw, unit, album))
                    self.store_candidates(job_id, candidates + match_scoring.rank(batch), errors)
                candidates.extend(match_scoring.rank(batch))
                for idx, file in indexed:
                    self.ledger.item_transition(job_id, idx, 1, 'done')
                    self.tracker.update_progress(job_id, file['relPath'])
            except Exception as error:
                logger.warning('MusicBrainz match lookup failed: %s', type(error).__name__)
                code = 'provider-busy' if isinstance(error, ExternalAPIError) and error.details.get('status') == 503 else 'provider-failed'
                for idx, file in indexed:
                    errors.append({'relPath': file['relPath'], 'reason': code})
                    self.ledger.item_transition(job_id, idx, 1, 'failed', reason=code)
                    self.tracker.update_progress(job_id, file['relPath'])
            self.store_candidates(job_id, candidates, errors)
        items = self.ledger.items(job_id)
        self.tracker.complete_progress(job_id, 'done' if self.active(job_id) else 'cancelled',
                                       succeeded=sum(i['state'] == 'done' for i in items),
                                       failed=sum(i['state'] == 'failed' for i in items))

    def view(self, job_id):
        stored = self.stored(job_id)
        job = self.ledger.get(job_id)
        candidates = [{k: v for k, v in c.items() if not k.startswith('_')} for c in stored['proposal']['candidates']]
        return {'jobId': job_id, 'state': job['state'] if job else 'interrupted', 'candidates': candidates,
                'errors': stored['proposal']['errors'], 'groups': {
                    band: [idx for idx, c in enumerate(candidates) if c['band'] == label]
                    for band, label in (('strong', 'strong'), ('review', 'review'), ('rejected', 'weak'))}}

    def cancel(self, job_id):
        self.stored(job_id)
        job = self.ledger.get(job_id)
        if job and job['state'] in ('queued', 'running'):
            try:
                self.ledger.cancel(job_id, job['attempt'])
            except JobConflict:
                pass
        return self.view(job_id)

    def plan(self, job_id, selections, principal):
        if self.active(job_id):
            raise tagwriter.TagError('busy')
        proposal = self.stored(job_id)['proposal']['candidates']
        rows, views = [], []
        if len({s['relPath'] for s in selections}) != len(selections):
            raise tagwriter.TagError('duplicate-paths', 422)
        for selection in selections:
            idx, rel, fields = selection['candidate'], selection['relPath'], selection['fields']
            if idx < 0 or idx >= len(proposal):
                raise tagwriter.TagError('invalid-candidate', 422)
            file = next((f for f in proposal[idx]['files'] if f['relPath'] == rel), None)
            if not file or len(fields) != len(set(fields)) or any(f not in file['fields'] for f in fields):
                raise tagwriter.TagError('invalid-fields', 422)
            diff = {f: [file['fields'][f]['now'], file['fields'][f]['new']] for f in fields}
            state = 'ok' if diff else 'no-change'
            try:
                _, path = self.path(rel)
                if tagwriter.read(path)['rev'] != file['rev']:
                    state = 'changed-since'
            except (tagwriter.TagError, OSError):
                state = 'changed-since'
            views.append({'relPath': rel, 'diff': diff, 'state': state})
            if diff:
                rows.append({'relPath': rel, 'rev': file['rev'], 'set': {f: v[1] for f, v in diff.items()}})
        if not rows:
            raise tagwriter.TagError('no-changes', 422)
        edit_id, _ = self.edits.create('match-apply', principal, rows, state='planned', job_id=uuid.uuid4().hex)
        entry = self.edits.get(edit_id)
        return {'planId': edit_id, 'planHash': entry['plan_hash'], 'rows': views}

    def apply(self, plan_id, plan_hash):
        with self.lock:
            entry = self.edits.get(plan_id)
            if entry['kind'] != 'match-apply' or entry['plan_hash'] != plan_hash:
                raise tagwriter.TagError('plan-mismatch')
            if entry['state'] != 'planned':
                return self.result(entry), False
            if self.now() - entry['created_at'] > 900:
                raise tagwriter.TagError('plan-expired')
            try:
                with self.repository.connection() as db:
                    changed = db.execute("UPDATE library_edit SET state='applying' WHERE id=? AND state='planned'", (plan_id,)).rowcount
            except sqlite3.IntegrityError:
                raise tagwriter.TagError('busy')
            if changed:
                self.tracker.create_progress(entry['job_id'], len(entry['rows']), kind='library-edit', label='Apply MusicBrainz match',
                    items=[{'item': r['rel_before'], 'rel_path': r['rel_before']} for r in entry['rows']])
            return self.result(self.edits.get(plan_id)), bool(changed)

    def result(self, entry):
        job = self.ledger.get(entry['job_id'])
        state = entry['state']
        if state == 'applying' and job and job['state'] not in ('queued', 'running'):
            state = 'interrupted'
        return {'editId': entry['id'], 'progressId': entry['job_id'], 'state': state,
                'applied': sum(r['state'] == 'applied' for r in entry['rows']),
                'skipped': sum(r['state'] == 'skipped' for r in entry['rows']),
                'failed': sum(r['state'] == 'failed' for r in entry['rows'])}
