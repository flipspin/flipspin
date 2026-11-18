"""Read-only MusicBrainz proposals; disposable after seven days."""


def match_proposals(db):
    db.execute('''CREATE TABLE match_proposal (
        job_id TEXT PRIMARY KEY, principal TEXT NOT NULL, created_at REAL NOT NULL,
        request TEXT NOT NULL, proposal TEXT NOT NULL
    )''')
    db.execute('''CREATE TABLE track_identity (
        rel_path TEXT PRIMARY KEY, mb_recording TEXT, mb_release TEXT, mb_source TEXT NOT NULL
    )''')
