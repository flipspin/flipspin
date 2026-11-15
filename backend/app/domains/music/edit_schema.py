"""Durable tag edit plans in the music store."""


def library_edits(db):
    db.execute('''CREATE TABLE library_edit (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        undoes TEXT, principal TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('planned','applying','applied','partial','failed','undone','undo-partial')),
        plan_hash TEXT, created_at REAL NOT NULL, applied_at REAL,
        job_id TEXT, expires_at REAL NOT NULL
    )''')
    db.execute("CREATE UNIQUE INDEX library_edit_batch ON library_edit((1)) WHERE state='applying' AND kind!='tags'")
    db.execute("CREATE UNIQUE INDEX library_edit_undo ON library_edit(undoes) WHERE kind='undo' AND state!='failed'")
    db.execute('''CREATE TABLE library_edit_row (
        edit_id TEXT NOT NULL REFERENCES library_edit(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
        rel_before TEXT NOT NULL, rel_after TEXT NOT NULL,
        identity_before TEXT, identity_after TEXT, fields_before TEXT, fields_after TEXT,
        refs_snapshot TEXT, recycle_path TEXT,
        state TEXT NOT NULL CHECK(state IN ('planned','applied','skipped','failed','undone','undo-skipped')),
        reason TEXT, newer_edit_id TEXT, PRIMARY KEY(edit_id,idx)
    )''')
    db.execute('CREATE INDEX library_edit_path ON library_edit_row(rel_after)')
