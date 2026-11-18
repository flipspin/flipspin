"""Visible analysis revision and a batched, scan-local ownership read port."""
import json


def listing_revision(db):
    db.execute('CREATE TABLE listing_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL)')
    db.execute('INSERT INTO listing_revision VALUES (1,0)')
    fields = ('key', 'key_conf', 'bpm', 'bpm_conf', 'energy', 'brightness', 'pulse', 'mood',
              'analyzed_at', 'fixed_key', 'fixed_bpm', 'error', 'tag_owner')
    changed = ' OR '.join(f'OLD.{f} IS NOT NEW.{f}' for f in fields)
    for event, guard in [('INSERT', ''), ('DELETE', ''), ('UPDATE', f'WHEN {changed}')]:
        db.execute(f'''CREATE TRIGGER listing_track_{event.lower()} AFTER {event} ON track_analysis
            {guard} BEGIN UPDATE listing_revision SET revision=revision+1 WHERE id=1; END''')
    for event in ('INSERT', 'UPDATE', 'DELETE'):
        ref = 'OLD' if event == 'DELETE' else 'NEW'
        changed = 'AND OLD.value IS NOT NEW.value' if event == 'UPDATE' else ''
        db.execute(f'''CREATE TRIGGER listing_meta_{event.lower()} AFTER {event} ON meta
            WHEN ({ref}.key LIKE 'tag_fields:%' OR {ref}.key LIKE 'tag_values:%') {changed}
            BEGIN UPDATE listing_revision SET revision=revision+1 WHERE id=1; END''')


def missing_listing_revision(db):
    db.execute('''CREATE TRIGGER listing_missing_update AFTER UPDATE OF missing_since ON track_analysis
        WHEN OLD.missing_since IS NOT NEW.missing_since
        BEGIN UPDATE listing_revision SET revision=revision+1 WHERE id=1; END''')
    for event in ('INSERT', 'UPDATE', 'DELETE'):
        ref = 'OLD' if event == 'DELETE' else 'NEW'
        guard = f"{ref}.key LIKE 'missing_removed:%'"
        if event == 'UPDATE':
            guard = "(OLD.key LIKE 'missing_removed:%' OR NEW.key LIKE 'missing_removed:%') AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value)"
        db.execute(f'''CREATE TRIGGER listing_removed_{event.lower()} AFTER {event} ON meta
            WHEN {guard}
            BEGIN UPDATE listing_revision SET revision=revision+1 WHERE id=1; END''')


class AnalysisListing:
    def __init__(self, repository):
        self.repository = repository
        with repository.connection() as db:
            # One query, one connection, including the per-file ownership records.
            rows = db.execute('''SELECT a.*,
                (SELECT value FROM meta WHERE key='tag_fields:'||a.rel_path) AS fields_json,
                (SELECT value FROM meta WHERE key='tag_values:'||a.rel_path) AS values_json
                FROM track_analysis a''').fetchall()
        self.rows = {r['rel_path']: dict(r) for r in rows}

    def get(self, rel):
        row = self.rows.get(rel)
        return row.copy() if row else None

    def tag_fields(self, rel):
        raw = (self.rows.get(rel) or {}).get('fields_json')
        return json.loads(raw) if raw is not None else None

    def tag_record(self, rel, kind):
        raw = (self.rows.get(rel) or {}).get('values_json')
        return json.loads(raw) if raw else {}

    def ownership(self, rel, owner):
        self.repository.ownership(rel, owner)
        if rel in self.rows:
            self.rows[rel].update(tag_owner=owner, fields_json=None, values_json=None)
