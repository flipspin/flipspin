"""Music-owned analysis records, separate from the job ledger and temporary files."""
import json
import logging
import sqlite3
import stat
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.domains.music.loudness import album_values
from app.domains.music.analysis_constants import MISSING_GRACE_DAYS
from app.domains.music.analysis_arousal import AROUSAL_RULE_VERSION, library_arousals
from app.domains.music.analysis_mood import MOOD_RULE_VERSION, _classify_mood
from app.domains.music.analysis_schema import ANALYSIS
from app.domains.music.analysis_run_repository import record_outcome, timestamp
from app.domains.music.library_files import AUDIO_EXTENSIONS, walk_library
from app.infra.changes import Changes
from app.infra.migrations import open_store
from app.utils.library_paths import rel_path_for, resolve_rel_path
from app.exceptions import ValidationError

logger = logging.getLogger(__name__)


class AnalysisRepository:
    def __init__(self, path: Path, *, changes: Changes | None = None):
        self.changes = changes
        self.path = Path(path)
        open_store(self.path, ANALYSIS).close()

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA synchronous=FULL')
        try:
            # Observe the visible revision around the repository transaction,
            # then notify only after a successful commit (including bulk writes).
            before = db.execute('SELECT revision FROM listing_revision WHERE id=1').fetchone()[0]
            with db:
                yield db
                changed = db.total_changes and before != db.execute(
                    'SELECT revision FROM listing_revision WHERE id=1').fetchone()[0]
            if changed and self.changes:
                self.changes.bump('analysis')
        finally:
            db.close()

    @property
    def revision(self) -> int:
        """Only commits that change visible values advance the listing revision."""
        with self.connection() as db:
            return db.execute('SELECT revision FROM listing_revision WHERE id=1').fetchone()[0]

    def get(self, rel_path: str | None) -> dict | None:
        if rel_path is None:
            return None
        with self.connection() as db:
            row = db.execute('SELECT * FROM track_analysis WHERE rel_path = ?', (rel_path,)).fetchone()
        return dict(row) if row else None

    def meta(self, key: str) -> str | None:
        with self.connection() as db:
            row = db.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
        return row['value'] if row else None

    def mark_legacy_tags(self, rows: list[tuple], summary: str) -> None:
        """Ownership only: never migrate an old computed value or alter corrections."""
        with self.connection() as db:
            db.executemany('''INSERT INTO track_analysis (rel_path, size, mtime_ns, tag_owner)
                VALUES (?, ?, ?, 'krobi') ON CONFLICT(rel_path) DO UPDATE SET tag_owner = 'krobi' ''', rows)
            db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('legacy_tags_checked', ?)", (summary,))

    def owned_tag_paths(self):
        """Page through ownership without keeping a read transaction open during I/O."""
        after = ''
        while True:
            with self.connection() as db:
                rows = db.execute('''SELECT rel_path FROM track_analysis
                    WHERE tag_owner = 'krobi' AND rel_path > ? ORDER BY rel_path LIMIT 100''', (after,)).fetchall()
            if not rows:
                return
            for row in rows:
                after = row['rel_path']
                yield after

    def writeback_rules_applied(self, version: str) -> None:
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO meta (key,value) VALUES ('writeback_rules_version', ?)", (version,))

    def key_tags_rewritten(self, version: str) -> None:
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO meta (key,value) VALUES ('key_tag_version', ?)", (version,))

    def recompute_moods(self) -> None:
        """Upgrade stored moods and their version atomically, without reanalysis."""
        with self.connection() as db:
            # Lock before checking the version so concurrent startups run once.
            db.execute('BEGIN IMMEDIATE')
            version = db.execute("SELECT value FROM meta WHERE key = 'mood_rule_version'").fetchone()
            if version and int(version['value']) >= MOOD_RULE_VERSION:
                return
            rows = db.execute('''SELECT rel_path, bpm, energy, brightness, pulse FROM track_analysis
                WHERE energy IS NOT NULL AND brightness IS NOT NULL AND pulse IS NOT NULL''').fetchall()
            db.executemany('UPDATE track_analysis SET mood = ? WHERE rel_path = ?', [
                (_classify_mood(row['bpm'], row['energy'], row['brightness'], row['pulse']), row['rel_path'])
                for row in rows
            ])
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('mood_rule_version', ?)",
                       (str(MOOD_RULE_VERSION),))

    def forget(self, rel_path: str | None) -> None:
        with self.connection() as db:
            db.execute('DELETE FROM track_analysis WHERE rel_path = ?', (rel_path,))
            db.executemany('DELETE FROM meta WHERE key=?', [(f'{kind}:{rel_path}',) for kind in ('tag_fields', 'tag_values', 'tag_originals', 'file_tag_signature')])

    def recompute_arousals(self) -> None:
        """Refresh the library ranks once per rule upgrade or dirty population."""
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            version = db.execute("SELECT value FROM meta WHERE key='arousal_rule_version'").fetchone()
            dirty = db.execute("SELECT value FROM meta WHERE key='arousal_dirty'").fetchone()
            current = int(version['value']) if version else 0
            if current > AROUSAL_RULE_VERSION or current == AROUSAL_RULE_VERSION and not dirty:
                return
            rows = db.execute('SELECT rel_path, energy, pulse, bpm, missing_since, arousal FROM track_analysis').fetchall()
            values = library_arousals(rows)
            db.executemany('UPDATE track_analysis SET arousal=? WHERE rel_path=?', [
                (values[row['rel_path']], row['rel_path']) for row in rows if row['arousal'] != values[row['rel_path']]
            ])
            db.execute("INSERT OR REPLACE INTO meta (key,value) VALUES ('arousal_rule_version',?)", (str(AROUSAL_RULE_VERSION),))
            db.execute("DELETE FROM meta WHERE key='arousal_dirty'")

    def forget_file(self, base: Path, path: Path) -> None:
        self.forget(rel_path_for(base, path))

    def clear_removed_present(self, rels):
        with self.connection() as db:
            db.executemany('DELETE FROM meta WHERE key=?', [('missing_removed:' + rel,) for rel in rels if rel])

    def snapshot(self, rel):
        with self.connection() as db:
            identity = db.execute('SELECT * FROM track_identity WHERE rel_path=?', (rel,)).fetchone()
            meta = dict(db.execute('SELECT key,value FROM meta WHERE key IN (?,?,?,?)',
                        tuple(f'{kind}:{rel}' for kind in ('tag_fields', 'tag_values', 'tag_originals', 'file_tag_signature'))))
        return {'row': self.get(rel), 'identity': dict(identity) if identity else None, 'meta': meta}

    def drop(self, rel, snapshot):
        self.forget(rel)
        with self.connection() as db:
            db.execute('DELETE FROM track_identity WHERE rel_path=?', (rel,))

    def restore(self, rel, snapshot):
        with self.connection() as db:
            for table, row in [('track_analysis', snapshot['row']), ('track_identity', snapshot['identity'])]:
                if row:
                    db.execute(f'INSERT OR IGNORE INTO {table} ({",".join(row)}) VALUES ({",".join("?" for _ in row)})', tuple(row.values()))
            db.executemany('INSERT OR IGNORE INTO meta VALUES (?,?)', snapshot['meta'].items())

    def sweep(self, base: Path) -> int:
        """Keep ghosts and their provenance; purge only old, uncorrected rows.

        An incomplete or empty library is never evidence of file removal.
        Validate the whole walk before making any changes, including purges.
        """
        def unreadable(error):
            raise error

        try:
            if not base.is_dir():
                logger.warning('Analysis sweep skipped: music root is absent or unreadable')
                return 0
            has_audio = False
            for root, _dirs, files in walk_library(base, onerror=unreadable):
                for name in files:
                    if not name.startswith('.') and Path(name).suffix.lower() in AUDIO_EXTENSIONS:
                        if stat.S_ISREG((Path(root) / name).stat().st_mode):
                            has_audio = True
            if not has_audio:
                logger.warning('Analysis sweep skipped: music root has no audio files')
                return 0
        except OSError:
            logger.warning('Analysis sweep skipped: music root is unreadable')
            return 0

        now = datetime.now(UTC)
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            missing, present = [], []
            for row in db.execute('SELECT rel_path FROM track_analysis'):
                try:
                    exists = stat.S_ISREG(resolve_rel_path(base, row['rel_path']).stat().st_mode)
                except (ValidationError, ValueError, FileNotFoundError, NotADirectoryError):
                    exists = False
                except OSError:
                    logger.warning('Analysis sweep skipped: music files are unreadable')
                    return 0
                (present if exists else missing).append((row['rel_path'],))
            db.executemany('UPDATE track_analysis SET missing_since = NULL '
                           'WHERE rel_path = ? AND missing_since IS NOT NULL', present)
            db.executemany('UPDATE track_analysis SET missing_since = ? '
                           'WHERE rel_path = ? AND missing_since IS NULL',
                           [(now.isoformat(), rel) for (rel,) in missing])
            purged = db.execute('''DELETE FROM track_analysis
                WHERE fixed_key IS NULL AND fixed_bpm IS NULL
                AND julianday(missing_since) <= julianday(?) RETURNING rel_path''',
                ((now - timedelta(days=MISSING_GRACE_DAYS)).isoformat(),)).fetchall()
            db.executemany('DELETE FROM meta WHERE key=?', [(kind + ':' + rel,) for (rel,) in purged
                                                             for kind in ('tag_fields', 'tag_values', 'tag_originals', 'file_tag_signature')])
        return len(purged)

    def repoint(self, base: Path, old: Path, new: Path) -> None:
        old_key, new_key = rel_path_for(base, old), rel_path_for(base, new)
        if old_key == new_key:
            return
        with self.connection() as db:
            db.execute('DELETE FROM track_analysis WHERE rel_path = ?', (new_key,))
            for kind in ('tag_fields', 'tag_values', 'tag_originals', 'file_tag_signature'):
                db.execute('DELETE FROM meta WHERE key=?', (f'{kind}:{new_key}',))
            if new_key is not None and new.is_file():
                db.execute('UPDATE track_analysis SET rel_path = ? WHERE rel_path = ?', (new_key, old_key))
                for kind in ('tag_fields', 'tag_values', 'tag_originals', 'file_tag_signature'):
                    db.execute('UPDATE meta SET key=? WHERE key=?', (f'{kind}:{new_key}', f'{kind}:{old_key}'))
            else:
                db.execute('DELETE FROM track_analysis WHERE rel_path = ?', (old_key,))
                for kind in ('tag_fields', 'tag_values', 'tag_originals', 'file_tag_signature'):
                    db.execute('DELETE FROM meta WHERE key=?', (f'{kind}:{old_key}',))

    def apply(self, rel_path: str, result: dict, mood: str, *, analyzed_by=None, accel=None) -> bool:
        """Computed columns only: a helper can never overwrite a correction."""
        fields = ('size', 'mtime_ns', 'engine', 'engine_version', 'key', 'key_conf', 'bpm',
                  'bpm_conf', 'energy', 'brightness', 'pulse')
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM track_analysis WHERE rel_path=?', (rel_path,)).fetchone()
            before = dict(row) if row else {}
            computed = {**{f: result[f] for f in fields}, 'mood': mood,
                        **{f: result.get(f) for f in ('track_lufs', 'true_peak', 'lra', 'decode_seconds')},
                        'loudness_blocks': json.dumps(result['loudness_blocks']) if result.get('loudness_blocks') is not None else None}
            fields = (*fields, 'track_lufs', 'true_peak', 'lra', 'decode_seconds', 'loudness_blocks')
            visible = (*(field for field in fields[4:] if field != 'decode_seconds'), 'mood')
            changed = any(before.get(f) != computed[f] for f in visible)
            now = timestamp()
            updates = {**computed, 'checked_at': now, 'analyzed_by': analyzed_by, 'accel': accel, 'error': None}
            if changed:
                updates.update(analyzed_at=now, rev=before.get('rev', -1) + 1)
            db.execute('INSERT OR IGNORE INTO track_analysis (rel_path) VALUES (?)', (rel_path,))
            db.execute(f"UPDATE track_analysis SET {','.join(f'{f}=?' for f in updates)} WHERE rel_path=?",
                       (*updates.values(), rel_path))
            # Audit excludes bookkeeping, but retains fixed values to explain flips.
            audit_fields = (*visible, 'fixed_key', 'fixed_bpm')
            previous = {f: before.get(f) for f in audit_fields}
            after = {**previous, **{f: computed[f] for f in visible}}
            record_outcome(db, rel_path, previous, after)
            return changed

    def album_loudness(self, members):
        """Publish only a complete album whose current file signatures still match."""
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = [db.execute('SELECT * FROM track_analysis WHERE rel_path=?', (rel,)).fetchone()
                    for rel in members]
            valid = [dict(row) if row and (row['size'], row['mtime_ns']) == members[rel] else None
                     for rel, row in zip(members, rows, strict=True)]
            gain, peak = album_values(valid)
            db.executemany('UPDATE track_analysis SET album_gain=?,album_peak=? WHERE rel_path=?',
                           [(gain, peak, rel) for rel in members])
        return gain, peak

    def error(self, rel_path: str, reason: str, signature=None) -> None:
        with self.connection() as db:
            db.execute("""INSERT INTO track_analysis (rel_path,error) VALUES (?,?)
                ON CONFLICT(rel_path) DO UPDATE SET error=excluded.error""", (rel_path, reason))
            db.execute('UPDATE track_analysis SET checked_at=? WHERE rel_path=?', (timestamp(), rel_path))
            if signature:
                db.execute('UPDATE track_analysis SET size=?,mtime_ns=? WHERE rel_path=?', (*signature, rel_path))
            record_outcome(db, rel_path, failed=True)

    def signature(self, rel_path: str, stat, owner, fields=None) -> None:
        with self.connection() as db:
            db.execute('UPDATE track_analysis SET size=?,mtime_ns=?,tag_owner=? WHERE rel_path=?',
                       (stat.st_size, stat.st_mtime_ns, owner, rel_path))
            if fields is not None:
                db.execute('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)',
                           ('tag_fields:' + rel_path, json.dumps(fields)))

    def ownership(self, rel_path: str, owner) -> None:
        with self.connection() as db:
            db.execute('UPDATE track_analysis SET tag_owner=? WHERE rel_path=?', (owner, rel_path))
            if owner is None:
                db.executemany('DELETE FROM meta WHERE key=?', [(f'{kind}:{rel_path}',)
                               for kind in ('tag_fields', 'tag_values', 'tag_originals')])

    def tag_fields(self, rel_path):
        if rel_path is None:
            return None
        value = self.meta('tag_fields:' + rel_path)
        return json.loads(value) if value is not None else None

    def tag_record(self, rel_path, kind, value=None):
        """Per-field file provenance, independent of the current correction."""
        key = f'{kind}:{rel_path}'
        if value is None:
            raw = self.meta(key)
            return json.loads(raw) if raw else {}
        with self.connection() as db:
            db.execute('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)', (key, json.dumps(value)))

    def fix(self, rel_path: str, rev: int, fields: dict, principal: str) -> bool:
        from datetime import UTC, datetime
        with self.connection() as db:
            db.execute('INSERT OR IGNORE INTO track_analysis (rel_path) VALUES (?)', (rel_path,))
            updates = {f'fixed_{k}': v for k, v in fields.items()}
            updates.update(fixed_by=principal, fixed_at=datetime.now(UTC).isoformat())
            return bool(db.execute(f"""UPDATE track_analysis SET
                {', '.join(f'{key}=?' for key in updates)}, rev=rev+1
                WHERE rel_path=? AND rev=?""", (*updates.values(), rel_path, rev)).rowcount)
