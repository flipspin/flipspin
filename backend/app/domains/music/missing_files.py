"""Owner review of absent songs. Files are never deleted by this service."""
import json
import os
from collections import Counter, defaultdict
from pathlib import Path

from app.domains.metadata import tagwriter
from app.domains.music.library_files import AUDIO_EXTENSIONS
from app.domains.music.library_scan import discover
from app.domains.music.missing_paths import remembered_path
from app.domains.music.tag_edits import TagError
from app.domains.user_library.store import normalize_batch
from app.exceptions import ValidationError
from app.utils.library_paths import rel_path_for, resolve_rel_path
from app.utils.path_safety import safe_music_subpath, safe_open_path


def identity(tags):
    """Move identity ignores file stamps; it requires size, duration and all tags."""
    if not tags or tags.get('duration') is None or not tags.get('_missingTagSha'):
        return None
    return tags.get('size'), round(tags['duration'] * 1000), tags['_missingTagSha']


class MissingFiles:
    def __init__(self, config, music, edits, keys, users, playlists, plays, relocator, accounts=None):
        self.config, self.music, self.edits, self.keys = config, music, edits, keys
        self.users, self.playlists, self.plays, self.relocator = users, playlists, plays, relocator
        self.accounts = accounts or (lambda: {})
        self.devices = {}
        self.remember_device()

    @property
    def base(self):
        return self.config.base_music_dir

    def remember_device(self):
        try:
            self.devices.setdefault(str(self.base), self.base.stat().st_dev)
        except OSError:
            self.devices.setdefault(str(self.base), None)

    def present(self):
        try:
            if str(self.base) not in self.devices:
                self.remember_device()  # An explicit library-root change starts a new baseline.
            if self.devices.get(str(self.base)) != self.base.stat().st_dev:
                return None
            _, groups, *_ = discover(self.base, AUDIO_EXTENSIONS)
            paths = {rel_path_for(self.base, p): p for files in groups.values() for p in files}
            if not paths or any(not os.access(p, os.R_OK) for p in paths.values()):
                return None
            return paths
        except (OSError, ValidationError):
            return None

    def known(self):
        with self.music.analysis.connection() as db:
            paths = {r[0] for r in db.execute('SELECT rel_path FROM track_analysis')}
            removed = {r[0].removeprefix('missing_removed:') for r in db.execute("SELECT key FROM meta WHERE key LIKE 'missing_removed:%'")}
        paths |= self.users.all_paths() | self.playlists.paths() | self.plays.paths()
        paths |= {rel for path in self.music._tag_cache if (rel := rel_path_for(self.base, Path(path)))}
        lyric = self.keys.participants['lyrics'].repository
        paths |= lyric.all_records().keys()
        return paths - removed

    def tags(self, rel):
        path = remembered_path(self.base, rel)
        hit = self.music._tag_cache.get(str(path))
        if hit:
            return hit[1]
        return next((tags for name, (_, tags) in list(self.music._tag_cache.items())
                     if rel_path_for(self.base, Path(name)) == rel), {})

    def absence(self, rel):
        """Shared absence/grouping rule for the listing and scan-time health."""
        path = remembered_path(self.base, rel)
        if path.is_file():
            return None
        folder = path.parent
        if not folder.is_dir():
            base = self.base.resolve()
            while folder != base and folder.parent != base and not folder.parent.is_dir():
                folder = folder.parent
            return path, 'folder', str(folder.relative_to(base))
        return path, 'file', ''

    def rows(self):
        present = self.present()
        known = self.known()
        missing = []
        signatures = defaultdict(list)
        if present:
            # A target already held by someone is not an unknown moved file.
            for rel, path in present.items():
                if self.users.references_for_path(rel) or self.playlists.snapshot(rel):
                    continue
                try:
                    sig = identity(self.music.read_tags(path))
                    if sig:
                        signatures[sig].append(rel)
                except (OSError, ValueError):
                    continue
        accounts = self.accounts()
        for rel in sorted(known):
            try:
                absent = self.absence(rel)
                if absent is None:
                    continue
                path, cause, group = absent
                row = self.music.analysis.get(rel)
                refs = self.keys.snapshot(rel)
                tags = self.tags(rel)
                moved = signatures.get(identity(tags), [])
                missing.append({'relPath': rel, 'path': str(path.relative_to(self.base.resolve())),
                    'title': tags.get('title') or path.stem, 'size': tags.get('size') or (row or {}).get('size'),
                    'missingSince': (row or {}).get('missing_since'), 'cause': cause, 'folder': group,
                    'references': {'accounts': [{'id': r['user_id'], 'name': accounts.get(r['user_id'], r['user_id'])} for r in refs['accounts']],
                        'playlists': sorted({r['name'] for r in refs['playlists']}),
                        'playlistEntries': len(refs['playlists']),
                        'corrections': [f for f in ('key', 'bpm') if row and row.get('fixed_' + f) is not None],
                        'plays': max(sum(r['play_count'] for r in refs['accounts']), len(refs['plays']['play_events'])),
                        'likes': sum(r['liked'] for r in refs['accounts']), 'lyric': bool(refs['lyrics']['record']),
                        'analysis': row is not None, 'stems': refs['stems']['present']},
                    'movedTo': moved[0] if len(moved) == 1 else None})
            except (OSError, ValueError, ValidationError):
                continue
        return {'rows': missing, 'libraryAvailable': present is not None, 'libraryCount': len(known | set(present or {}))}

    def health(self, present, _folders, as_of):
        """Reuse scan discovery and the listing's absence rule; never walk again."""
        counts = Counter()
        for rel in self.known() - set(present):
            try:
                absent = self.absence(rel)
                if absent is None:
                    continue
                path, _, group = absent
                counts[group or str(path.parent.relative_to(self.base.resolve()))] += 1
            except (ValueError, ValidationError):
                continue
        top = sorted(counts, key=lambda folder: (-counts[folder], folder))
        return {'id': 'missing', 'count': sum(counts.values()), 'folders': len(counts),
                'topFolder': top[0] if top else None,
                'source': {'store': 'music-scan.health / missing-files.known / absence', 'asOf': as_of}}

    def preview(self, rels, folder=None, target=None):
        rels = normalize_batch(rels)
        missing = {r['relPath']: r for r in self.rows()['rows']}
        if folder is not None:
            # Server-relative selection works identically for local and remote nests.
            selected = safe_open_path(self.base, self.base / folder) if folder else safe_music_subpath(self.base, folder)
            if not selected.is_dir():
                raise TagError('folder-not-found', 404)
            _, groups, *_ = discover(selected, AUDIO_EXTENSIONS)
            candidates = defaultdict(list)
            for paths in groups.values():
                for path in paths:
                    safe_open_path(self.base, path)
                    candidates[path.name].append(path)
        rows = []
        for rel in rels:
            old = resolve_rel_path(self.base, rel)
            if folder is not None:
                options = candidates[old.name]
            else:
                options = [resolve_rel_path(self.base, target) if target.count('/') == 1
                           else safe_open_path(self.base, self.base / target)]
            chosen = options[0] if len(options) == 1 else None
            reason = 'not-missing' if rel not in missing else 'ambiguous' if len(options) > 1 else 'file-not-found' if not chosen or not chosen.is_file() else None
            if chosen and chosen.suffix.lower() not in AUDIO_EXTENSIONS:
                reason = 'unsupported-format'
            rows.append({'relPath': rel, 'target': rel_path_for(self.base, chosen) if chosen else None,
                         'rev': tagwriter.revision(tagwriter.identity(chosen)) if chosen and not reason else None,
                         'reason': reason})
        targets = [r['target'] for r in rows if not r['reason']]
        for row in rows:
            if targets.count(row['target']) > 1:
                row['reason'] = 'ambiguous'
        return {'rows': rows}

    def apply(self, rows, principal):
        if self.present() is None:
            raise TagError('library-unavailable')
        rels = normalize_batch([r['relPath'] for r in rows])
        if len(rels) != len(rows):
            raise TagError('duplicate-path', 422)
        for row in rows:
            normalize_batch([row['target']])
            resolve_rel_path(self.base, row['relPath'])
            resolve_rel_path(self.base, row['target'])
        if len({row['target'] for row in rows}) != len(rows):
            raise TagError('ambiguous', 422)
        edit_id, _ = self.edits.create('move', principal, [{'relPath': r} for r in rels])
        for idx, row in enumerate(rows):
            old = resolve_rel_path(self.base, row['relPath'])
            new = resolve_rel_path(self.base, row['target'])
            with tagwriter.file_lock(old), tagwriter.file_lock(new):
                reason = 'not-missing' if old.exists() else 'already' if row['relPath'] not in self.known() else None
                there = self.music.analysis.get(row['target']) or {}
                if self.users.references_for_path(row['target']) or self.playlists.snapshot(row['target']) or any(there.get('fixed_' + f) is not None for f in ('key', 'bpm')):
                    reason = 'collision'
                if not reason:
                    try:
                        if not new.is_file() or tagwriter.revision(tagwriter.identity(new)) != row['rev']:
                            reason = 'changed-since'
                    except (OSError, ValueError, TagError):
                        reason = 'changed-since'
                if reason:
                    self.edits.row_state(edit_id, idx, 'skipped', reason)
                    continue
                with self.music.analysis.connection() as db:
                    db.execute('UPDATE library_edit_row SET rel_after=?,identity_after=?,refs_snapshot=? WHERE edit_id=? AND idx=?',
                               (row['target'], json.dumps(row['rev']), json.dumps({'missingMove': True}), edit_id, idx))
                self.relocator().repoint(old, new, keep_lyric=True)
                with self.music.analysis.connection() as db:
                    db.execute('UPDATE track_analysis SET missing_since=NULL WHERE rel_path=?', (row['target'],))
                self.tombstone(row['relPath'], edit_id)
                self.edits.row_state(edit_id, idx, 'applied')
        self.music.listing_cache.invalidate()
        self.edits.finish(edit_id)
        return self.result(edit_id)

    def tombstone(self, rel, edit_id):
        with self.music.analysis.connection() as db:
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('missing_removed:' + rel, edit_id))

    def remove(self, rels, principal, confirm_large=False):
        rels = normalize_batch(rels)
        with self.music.scans.lock:
            present = self.present()
            if present is None:
                raise TagError('library-unavailable')
            for rel in rels:
                resolve_rel_path(self.base, rel)
            known = self.known()
            moved = {r['relPath'] for r in self.rows()['rows'] if r['movedTo']}
            count = len(known | set(present))
            if len(set(rels) & known) > count * .2 and not confirm_large:
                raise TagError('confirm-large', current={'count': len(rels), 'libraryCount': count})
            edit_id, _ = self.edits.create('remove-missing', principal, [{'relPath': r} for r in rels])
            for idx, rel in enumerate(rels):
                path = resolve_rel_path(self.base, rel)
                with tagwriter.file_lock(path):
                    # Absence is checked inside the write, including after preview.
                    reason = 'not-missing' if path.exists() else 'already' if rel not in known else 'moved' if rel in moved else None
                    if reason:
                        self.edits.row_state(edit_id, idx, 'skipped', reason)
                        continue
                    snapshot = self.keys.snapshot(rel)
                    with self.music.analysis.connection() as db:
                        db.execute('UPDATE library_edit_row SET refs_snapshot=? WHERE edit_id=? AND idx=?',
                                   (json.dumps({'missingReferences': snapshot}), edit_id, idx))
                    try:
                        if path.exists():
                            self.edits.row_state(edit_id, idx, 'skipped', 'not-missing')
                            continue
                        self.keys.drop(rel, snapshot)
                        self.tombstone(rel, edit_id)
                        self.edits.row_state(edit_id, idx, 'applied')
                    except Exception:
                        self.keys.restore(rel, snapshot)
                        self.edits.row_state(edit_id, idx, 'failed', 'write-failed')
            self.music.invalidate_scan()
            self.music.listing_cache.invalidate()
            self.edits.finish(edit_id)
            return self.result(edit_id)

    def result(self, edit_id):
        entry = self.edits.get(edit_id)
        return {'editId': edit_id, 'rows': [{'relPath': r['rel_before'], 'state': r['state'], 'reason': r['reason']} for r in entry['rows']]}

    def restore_row(self, edit_id, idx, row):
        rel = row['rel_before']
        restored = self.keys.restore(rel, row['refs_snapshot']['missingReferences'])
        with self.music.analysis.connection() as db:
            db.execute('DELETE FROM meta WHERE key=?', ('missing_removed:' + rel,))
        self.edits.row_state(edit_id, idx, 'applied', 'playlist-appended' if restored.get('playlists') else None)
        self.music.invalidate_scan()
        self.music.listing_cache.invalidate()
