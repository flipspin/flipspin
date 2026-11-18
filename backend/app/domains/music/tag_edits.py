"""Music-owned edit journal, compensating undo, and non-replaying recovery."""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
import uuid

from app.domains.metadata import tagwriter
from app.domains.music.analysis_repository import AnalysisRepository
from app.domains.music.missing_paths import remembered_path
from app.exceptions import AmbiguousLibraryKeyError, ValidationError
from app.infra.progress import progress_principal
from app.utils.library_paths import rel_path_for, require_unique_path, resolve_rel_path

logger = logging.getLogger(__name__)
RETENTION = 90 * 86400
JSON_COLUMNS = ('identity_before', 'identity_after', 'fields_before', 'fields_after', 'refs_snapshot')


def unpack(row):
    row = dict(row)
    for key in JSON_COLUMNS:
        if row.get(key):
            row[key] = json.loads(row[key])
    return row


class TagEdits:
    def __init__(self, config, repository=None, music=None, tracker=None, *, now=time.time):
        self.config = config
        self.repository = repository or AnalysisRepository(config.analysis_db)
        self.music, self.tracker, self.now = music, tracker, now
        self.missing_files = None

    def get(self, edit_id):
        with self.repository.connection() as db:
            entry = db.execute('SELECT * FROM library_edit WHERE id=?', (edit_id,)).fetchone()
            if not entry:
                raise TagError('missing', 404)
            rows = [unpack(r) for r in db.execute('SELECT * FROM library_edit_row WHERE edit_id=? ORDER BY idx', (edit_id,))]
        return {**dict(entry), 'rows': rows}

    def create(self, kind, principal, rows, *, undoes=None, job_id=None, state='applying'):
        edit_id = uuid.uuid4().hex
        plan_hash = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
        try:
            with self.repository.connection() as db:
                db.execute('BEGIN IMMEDIATE')
                if undoes:
                    if db.execute('SELECT id FROM library_edit WHERE id=?', (undoes,)).fetchone() is None:
                        raise TagError('expired')
                    prior = db.execute("SELECT id FROM library_edit WHERE undoes=? AND state!='failed'", (undoes,)).fetchone()
                    if prior:
                        return prior['id'], False
                db.execute('''INSERT INTO library_edit
                    (id,kind,undoes,principal,state,plan_hash,created_at,expires_at,job_id)
                    VALUES(?,?,?,?,?,?,?,?,?)''',
                    (edit_id, kind, undoes, principal, state, plan_hash, self.now(), self.now() + RETENTION, job_id))
                for idx, row in enumerate(rows):
                    db.execute('''INSERT INTO library_edit_row
                        (edit_id,idx,rel_before,rel_after,identity_before,fields_after,refs_snapshot,state)
                        VALUES(?,?,?,?,?,?,?,'planned')''',
                        (edit_id, idx, row['relPath'], row['relPath'], json.dumps(row.get('rev')), json.dumps(row.get('set', {})), json.dumps({'id3Version': row.get('id3Version', 4)})))
                # History has its own retention, independent of short-lived jobs.
                # An undo's audit id may outlive the entry it referred to.
                for automatic in (True, False):
                    db.execute('''DELETE FROM library_edit WHERE id IN (
                        SELECT id FROM library_edit WHERE (principal='analysis')=? AND state!='applying' AND id NOT IN (
                            SELECT undoes FROM library_edit WHERE state='applying' AND undoes IS NOT NULL)
                        ORDER BY rowid LIMIT max((SELECT count(*) FROM library_edit WHERE (principal='analysis')=?)-5000,0))''',
                               (automatic, automatic))
        except sqlite3.IntegrityError:
            with self.repository.connection() as db:
                busy = db.execute("SELECT id FROM library_edit WHERE state='applying' AND kind!='tags'").fetchone()
            raise TagError('busy', current={'editId': busy['id']} if busy else None)
        return edit_id, True

    def row_state(self, edit_id, idx, state, reason=None, *, source='planned'):
        with self.repository.connection() as db:
            db.execute('UPDATE library_edit_row SET state=?,reason=? WHERE edit_id=? AND idx=? AND state=?',
                       (state, reason, edit_id, idx, source))

    def prepared(self, edit_id, idx, before, after, old, new, snapshot, keys, expected_analysis=None):
        changed = {k for k in old if old[k] != new[k]}
        snapshot = tagwriter.subset(snapshot, keys)
        row = self.get(edit_id)['rows'][idx]
        rel = row['rel_before']
        analysis = self.provenance(rel)
        with self.repository.connection() as db:
            count = db.execute('''UPDATE library_edit_row SET identity_before=?,identity_after=?,
                fields_before=?,fields_after=?,refs_snapshot=? WHERE edit_id=? AND idx=? AND state='planned' ''',
                (json.dumps(before), json.dumps(after), json.dumps({k: old[k] for k in changed}),
                 json.dumps({k: new[k] for k in changed}), json.dumps({'tags': snapshot, 'keys': keys, 'analysis': analysis, 'analysis_after': expected_analysis}), edit_id, idx)).rowcount
            if count != 1:
                raise TagError('invalid-state')

    def provenance(self, rel):
        row = self.repository.get(rel)
        with self.repository.connection() as db:
            identity = db.execute('SELECT * FROM track_identity WHERE rel_path=?', (rel,)).fetchone()
        return {'owner': row.get('tag_owner') if row else None,
                'identity': dict(identity) if identity else None,
                'meta': {kind: self.repository.meta(kind + ':' + rel)
                         for kind in ('tag_fields', 'tag_values', 'tag_originals')}}

    def restore_provenance(self, rel, path, snapshot):
        if snapshot is None:
            return
        self.repository.signature(rel, path.stat(), snapshot['owner'])
        with self.repository.connection() as db:
            db.execute('DELETE FROM track_identity WHERE rel_path=?', (rel,))
            identity = snapshot.get('identity')
            if identity:
                db.execute('INSERT INTO track_identity VALUES(?,?,?,?)',
                           (rel, identity['mb_recording'], identity['mb_release'], identity['mb_source']))
            for key, value in snapshot['meta'].items():
                db.execute('DELETE FROM meta WHERE key=?', (key + ':' + rel,))
                if value is not None:
                    db.execute('INSERT INTO meta(key,value) VALUES(?,?)', (key + ':' + rel, value))

    def synced(self, rel, path, fields=None, expected_analysis=None, identity_source='by-hand'):
        # A tag-only mutation refreshes provenance without reanalyzing audio.
        identity = tagwriter.identity(path)
        self.repository.tag_record(rel, 'file_tag_signature', {
            'sha': identity['tagSha'], 'size': identity['size'], 'mtime': identity['mtimeNs']})
        if fields and {'mbRecording', 'mbRelease'} & set(fields):
            tags = tagwriter.read(path)['fields']
            def primary(field):
                value = tags.get(field)
                return value[0] if isinstance(value, list) and value else value
            with self.repository.connection() as db:
                db.execute('INSERT OR REPLACE INTO track_identity VALUES(?,?,?,?)',
                           (rel, primary('mbRecording'), primary('mbRelease'), identity_source))
        row = self.repository.get(rel)
        if row:
            self.repository.signature(rel, path.stat(), row.get('tag_owner'))
            if fields and {'key', 'bpm'} & set(fields):
                # A hand edit relinquishes just the touched fields.
                owned = self.repository.tag_fields(rel)
                if owned is None:
                    owned = ['key', 'bpm'] if row.get('tag_owner') == 'krobi' else []
                self.repository.signature(rel, path.stat(), row.get('tag_owner'), [f for f in owned if f not in fields])
        if expected_analysis and 'restore' in expected_analysis:
            self.restore_provenance(rel, path, expected_analysis['restore'])
        elif expected_analysis:
            self.repository.signature(rel, path.stat(), expected_analysis['owner'], expected_analysis['fields'])
            if self.music:
                self.repository.tag_record(rel, 'tag_values', self.music.read_tags(path))
        if self.music:
            self.music.invalidate_scan()

    def apply_row(self, edit_id, idx, rel, fields, expected, *, transform=None, snapshot=None, keys=None, id3_version=4, analysis_snapshot=None):
        try:
            path = resolve_rel_path(self.config.base_music_dir, rel)
        except AmbiguousLibraryKeyError:
            self.row_state(edit_id, idx, 'skipped', 'ambiguous-library-key')
            raise TagError('ambiguous-library-key')
        except (ValidationError, ValueError):
            self.row_state(edit_id, idx, 'skipped', 'changed-since')
            raise TagError('changed-since')
        try:
            if self.music:
                self.music.first_seen.get(path)
            _, after, changed = tagwriter.write(path, fields, expected=expected, transform=transform,
                snapshot=snapshot, keys=keys, id3_version=id3_version,
                prepare=lambda *args: self.prepared(edit_id, idx, *args, expected_analysis={'restore': analysis_snapshot} if analysis_snapshot else None),
                complete=lambda after: (self.synced(rel, path, fields, identity_source='match@' + edit_id if self.get(edit_id)['kind'] == 'match-apply' else 'by-hand'), self.restore_provenance(rel, path, analysis_snapshot)))
            self.row_state(edit_id, idx, 'applied' if changed else 'skipped', None if changed else 'no-change')
            return changed, after
        except TagError as error:
            # If replacement happened but a later fsync/store update failed, leave
            # the row unresolved: recovery will compare its durable after identity.
            record = self.get(edit_id)['rows'][idx]
            try:
                replaced = record['identity_after'] and tagwriter.identity(path) == record['identity_after']
            except OSError:
                replaced = False
            if not replaced:
                self.row_state(edit_id, idx, 'skipped' if error.status in (404, 409) else 'failed', error.reason)
            raise
        except (OSError, ValueError) as error:
            reason = 'missing' if isinstance(error, FileNotFoundError) else 'write-failed'
            record = self.get(edit_id)['rows'][idx]
            try:
                replaced = record['identity_after'] and tagwriter.identity(path) == record['identity_after']
            except (OSError, ValueError, TagError):
                replaced = False
            if not replaced:
                self.row_state(edit_id, idx, 'failed', reason)
            raise TagError(reason, 404 if reason == 'missing' else 500) from error

    def finish(self, edit_id):
        entry = self.get(edit_id)
        if any(row['state'] == 'planned' for row in entry['rows']):
            return  # Leave evidence for recovery, never claim completion early.
        state = 'partial' if any(r['state'] in ('failed', 'undo-skipped') or r['reason'] not in (None, 'no-change') for r in entry['rows']) else 'applied'
        with self.repository.connection() as db:
            db.execute("UPDATE library_edit SET state=?,applied_at=? WHERE id=? AND state='applying'", (state, self.now(), edit_id))
            if entry['undoes']:
                db.execute("UPDATE library_edit SET state=? WHERE id=? AND state IN ('applied','partial','undone','undo-partial')",
                           ('undone' if state == 'applied' else 'undo-partial', entry['undoes']))

    def edit(self, path, fields, *, expected=None, principal=None, transform=None, id3_version=4, mutation=None, provenance=None):
        require_unique_path(self.config.base_music_dir, path)
        if principal is None:
            actor = progress_principal.get()
            principal = actor.user_id if actor else 'local'
        with tagwriter.file_lock(path):
            expected = expected if expected is not None else tagwriter.identity(path)
            # Diff first: let the writer decide before minting a journal entry.
            change = []
            rel = rel_path_for(self.config.base_music_dir, path)
            if rel is None:
                # Acquisition staging is outside the library; no undoable shared file yet.
                return tagwriter.write(path, fields, expected=expected, transform=transform, id3_version=id3_version, mutation=mutation)

            def prepare(*args):
                edit_id, _ = self.create('tags', principal, [{'relPath': rel, 'rev': expected, 'set': fields or {}}])
                change.append(edit_id)
                self.prepared(edit_id, 0, *args, expected_analysis=provenance() if provenance else None)
            try:
                if self.music:
                    self.music.first_seen.get(path)
                outcome = tagwriter.write(path, fields, expected=expected, transform=transform, id3_version=id3_version,
                    prepare=prepare, complete=lambda after: self.synced(rel, path, fields, provenance() if provenance else None), mutation=mutation)
                if change:
                    self.row_state(change[0], 0, 'applied')
                    self.finish(change[0])
                    logger.info('tags %s edited by %s', rel, principal)
                return {'editId': change[0] if change else None, 'rev': tagwriter.revision(outcome[1]), 'changed': outcome[2]}
            except TagError as error:
                if change:
                    record = self.get(change[0])['rows'][0]
                    if tagwriter.identity(path) != record['identity_after']:
                        self.row_state(change[0], 0, 'skipped' if error.status == 409 else 'failed', error.reason)
                        self.finish(change[0])
                raise

    def batch(self, items, fields, principal, id3_version=4):
        fields = tagwriter.normalize(fields)
        rows = [{'relPath': i['relPath'], 'rev': i['rev'], 'set': fields, 'id3Version': id3_version} for i in items]
        edit_id, _ = self.create('tags-batch', principal, rows, job_id=uuid.uuid4().hex)
        entry = self.get(edit_id)
        if self.tracker:
            self.tracker.create_progress(entry['job_id'], len(items), kind='library-edit', items=[{'item': i['relPath'], 'rel_path': i['relPath']} for i in items])
            self.tracker.set_status(entry['job_id'], 'in_progress')
        return edit_id, entry['job_id']

    def run_batch(self, edit_id):
        entry = self.get(edit_id)
        job = entry['job_id']
        if self.tracker:
            self.tracker.set_status(job, 'in_progress')
        for row in entry['rows']:
            if row['state'] != 'planned':
                continue
            try:
                self.apply_row(edit_id, row['idx'], row['rel_before'], row['fields_after'], row['identity_before'],
                               id3_version=(row['refs_snapshot'] or {}).get('id3Version', 4))
            except TagError:
                pass
            current = self.get(edit_id)['rows'][row['idx']]
            if self.tracker:
                self.tracker.ledger.item_transition(job, row['idx'], 1, 'done' if current['state'] == 'applied' or current['reason'] == 'no-change' else 'skipped', reason=current['reason'])
                self.tracker.update_progress(job, row['rel_before'])
        self.finish(edit_id)
        if self.tracker:
            rows = self.get(edit_id)['rows']
            ok = sum(r['state'] == 'applied' or r['reason'] == 'no-change' for r in rows)
            self.tracker.complete_progress(job, 'done', succeeded=ok, failed=len(rows) - ok)

    def start_undo(self, edit_id, principal):
        entry = self.get(edit_id)
        if entry['state'] in ('applying', 'planned'):
            raise TagError('busy')
        rows = [{'relPath': r['rel_after'], 'rev': r['identity_after']} for r in reversed(entry['rows']) if r['state'] == 'applied']
        if self.config.base_music_dir.is_dir():
            for row in rows:
                resolve_rel_path(self.config.base_music_dir, row['relPath'])
        return self.create('undo', principal, rows, undoes=edit_id)

    def run_undo(self, undo_id):
        undo = self.get(undo_id)
        original = self.get(undo['undoes'])
        rows = [r for r in reversed(original['rows']) if r['state'] == 'applied']
        for idx, row in enumerate(rows):
            target = undo['rows'][idx]
            if target['state'] != 'planned':
                continue
            rel = row['rel_after']
            try:
                path = remembered_path(self.config.base_music_dir, rel) if (row.get('refs_snapshot') or {}).get('missingReferences') is not None else resolve_rel_path(self.config.base_music_dir, rel)
            except AmbiguousLibraryKeyError:
                self.row_state(undo_id, idx, 'undo-skipped', 'ambiguous-library-key')
                continue
            with tagwriter.file_lock(path):
                with self.repository.connection() as db:
                    newer = db.execute('''SELECT e.id FROM library_edit e JOIN library_edit_row r ON e.id=r.edit_id
                        WHERE r.rel_after=? AND r.state='applied' AND e.rowid >
                        (SELECT rowid FROM library_edit WHERE id=?) AND e.id!=? AND e.state NOT IN ('undone','failed')
                        ORDER BY e.rowid DESC LIMIT 1''', (rel, original['id'], undo_id)).fetchone()
                reason = 'expired' if original['expires_at'] <= self.now() else 'newer-edit' if newer else None
                if reason:
                    if reason == 'newer-edit':
                        with self.repository.connection() as db:
                            db.execute("UPDATE library_edit_row SET newer_edit_id=? WHERE edit_id=? AND idx=? AND state='planned'",
                                       (newer['id'], undo_id, idx))
                    self.row_state(undo_id, idx, 'undo-skipped', reason)
                    continue
                try:
                    if (row.get('refs_snapshot') or {}).get('missingReferences') is not None:
                        self.missing_files.restore_row(undo_id, idx, row)
                        continue
                    if (row.get('refs_snapshot') or {}).get('missingMove'):
                        self.row_state(undo_id, idx, 'undo-skipped', 'file-moved')
                        continue
                    self.apply_row(undo_id, idx, rel, row['fields_before'], row['identity_after'],
                        snapshot=row['refs_snapshot']['tags'], keys=row['refs_snapshot']['keys'],
                        analysis_snapshot=row['refs_snapshot'].get('analysis'))
                except (OSError, ValueError) as error:
                    logger.warning('Reference undo failed: %s', error)
                    self.row_state(undo_id, idx, 'undo-skipped', 'write-failed')
                except TagError as error:
                    self.row_state(undo_id, idx, 'undo-skipped', error.reason, source='skipped')
                    self.row_state(undo_id, idx, 'undo-skipped', error.reason, source='failed')
        self.finish(undo_id)

    def recover_entry(self, edit_id):
        entry = self.get(edit_id)
        if entry['kind'] == 'undo' and entry['undoes'] and self.get(entry['undoes'])['kind'] == 'remove-missing':
            # Restoring references is idempotent, including a crash after the
            # stores were restored but before the journal row was completed.
            self.run_undo(edit_id)
            return
        if entry['kind'] in ('remove-missing', 'move'):
            # Cross-store edits are compensating transactions. Roll back an
            # interrupted removal from its durable snapshot, never replay it.
            for row in entry['rows']:
                if row['state'] != 'planned':
                    continue
                snapshot = (row.get('refs_snapshot') or {}).get('missingReferences')
                if snapshot is not None:
                    self.missing_files.keys.restore(row['rel_before'], snapshot)
                    with self.repository.connection() as db:
                        db.execute('DELETE FROM meta WHERE key=?', ('missing_removed:' + row['rel_before'],))
                self.row_state(edit_id, row['idx'], 'skipped', 'interrupted')
            self.finish(edit_id)
            return
        for row in entry['rows']:
            if row['state'] != 'planned':
                continue
            try:
                path = resolve_rel_path(self.config.base_music_dir, row['rel_after'])
            except AmbiguousLibraryKeyError:
                self.row_state(edit_id, row['idx'], 'failed', 'ambiguous-library-key')
                continue
            except (ValueError, ValidationError):
                self.row_state(edit_id, row['idx'], 'failed', 'unknown-state')
                continue
            with tagwriter.file_lock(path):
                try:
                    current = tagwriter.identity(path)
                except (OSError, ValueError, TagError):
                    self.row_state(edit_id, row['idx'], 'failed', 'unknown-state')
                    continue
                if current == row['identity_after']:
                    # A store failure leaves the row recoverable for the next boot.
                    self.synced(row['rel_after'], path, row['fields_after'], (row.get('refs_snapshot') or {}).get('analysis_after'),
                                identity_source='match@' + edit_id if entry['kind'] == 'match-apply' else 'by-hand')
                    self.row_state(edit_id, row['idx'], 'applied')
                elif current == row['identity_before'] or tagwriter.revision(current) == row['identity_before']:
                    self.row_state(edit_id, row['idx'], 'skipped', 'interrupted')
                else:
                    self.row_state(edit_id, row['idx'], 'failed', 'unknown-state')
        self.finish(edit_id)

    def recover(self):
        with self.repository.connection() as db:
            ids = [r[0] for r in db.execute("SELECT id FROM library_edit WHERE state='applying'")]
        for edit_id in ids:
            self.recover_entry(edit_id)
        root = self.config.base_music_dir
        for path in root.rglob('.krobi-tmp-*'):
            if path.is_file():
                path.unlink(missing_ok=True)


TagError = tagwriter.TagError
