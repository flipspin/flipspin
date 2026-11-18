"""Numbered, additive analysis.sqlite upgrades through the shared store runner."""
from app.domains.music.duplicate_repository import duplicate_schema
from app.infra.migrations import SQLiteStore
from app.domains.music.analysis_listing import listing_revision, missing_listing_revision
from app.domains.music.edit_schema import library_edits
from app.domains.music.match_schema import match_proposals
from app.domains.music.first_seen import first_seen_schema


def base(db):
    db.execute('''CREATE TABLE IF NOT EXISTS track_analysis (
        rel_path TEXT PRIMARY KEY,
        size INTEGER, mtime_ns INTEGER,
        engine TEXT, engine_version INTEGER,
        key TEXT, key_conf REAL, bpm REAL, bpm_conf REAL,
        energy REAL, brightness REAL, pulse REAL, mood TEXT,
        analyzed_at TEXT,
        fixed_key TEXT, fixed_bpm REAL, fixed_by TEXT, fixed_at TEXT,
        rev INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        tag_owner TEXT CHECK(tag_owner IS NULL OR tag_owner = 'krobi')
    )''')
    db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')


def missing_since(db):
    if 'missing_since' not in {row[1] for row in db.execute('PRAGMA table_info(track_analysis)')}:
        db.execute('ALTER TABLE track_analysis ADD COLUMN missing_since TEXT')


def baseline(db):
    columns = {row[1] for row in db.execute('PRAGMA table_info(track_analysis)')}
    return 2 if 'missing_since' in columns else int(bool(columns))


def run_controls(db):
    for column in ('checked_at', 'analyzed_by', 'accel'):
        db.execute(f'ALTER TABLE track_analysis ADD COLUMN {column} TEXT')
    db.execute('UPDATE track_analysis SET checked_at=analyzed_at')
    db.execute('''CREATE TABLE analysis_run (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK(mode IN ('new','outdated','all')),
        scope TEXT NOT NULL CHECK(scope IN ('library','selection','song')),
        size INTEGER NOT NULL, job_id TEXT NOT NULL,
        requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
        nest_allowed INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('live','done','cancelled')),
        ended_at TEXT, counts TEXT NOT NULL, response TEXT NOT NULL
    )''')
    db.execute("CREATE UNIQUE INDEX analysis_one_library_run ON analysis_run(scope) WHERE scope='library' AND state='live'")
    db.execute('''CREATE TABLE analysis_run_track (
        run_id TEXT NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL, idx INTEGER NOT NULL, payload TEXT NOT NULL,
        owned INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY(run_id,rel_path)
    )''')
    db.execute('CREATE INDEX analysis_run_path ON analysis_run_track(rel_path)')
    db.execute('''CREATE TABLE analysis_request (
        request_id TEXT PRIMARY KEY, response TEXT NOT NULL
    )''')
    db.execute('''CREATE TABLE analysis_history (
        run_id TEXT NOT NULL REFERENCES analysis_run(id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL, before TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(run_id,rel_path)
    )''')


def arousal_schema(db):
    db.execute('ALTER TABLE track_analysis ADD COLUMN arousal REAL CHECK(arousal BETWEEN 0 AND 1)')
    db.execute("INSERT INTO meta (key,value) VALUES ('arousal_dirty','1')")
    # Dirty intent survives a crash between applying a helper batch and ranking it.
    changed = ' OR '.join(f'OLD.{f} IS NOT NEW.{f}' for f in ('energy', 'pulse', 'bpm', 'missing_since'))
    for event, guard in [('INSERT', ''), ('DELETE', ''), ('UPDATE', f'WHEN {changed}')]:
        db.execute(f'''CREATE TRIGGER arousal_dirty_{event.lower()} AFTER {event} ON track_analysis
            {guard} BEGIN INSERT OR REPLACE INTO meta (key,value) VALUES ('arousal_dirty','1'); END''')
    db.execute('''CREATE TRIGGER listing_arousal_update AFTER UPDATE OF arousal ON track_analysis
        WHEN OLD.arousal IS NOT NEW.arousal
        BEGIN UPDATE listing_revision SET revision=revision+1 WHERE id=1; END''')


def loudness(db):
    for column in ('track_lufs REAL', 'true_peak REAL', 'lra REAL', 'decode_seconds REAL',
                   'loudness_blocks TEXT', 'album_gain REAL', 'album_peak REAL'):
        db.execute(f'ALTER TABLE track_analysis ADD COLUMN {column}')
    db.execute("""CREATE TRIGGER listing_loudness_update AFTER UPDATE ON track_analysis
        WHEN OLD.track_lufs IS NOT NEW.track_lufs OR OLD.true_peak IS NOT NEW.true_peak
          OR OLD.album_gain IS NOT NEW.album_gain OR OLD.album_peak IS NOT NEW.album_peak
        BEGIN UPDATE listing_revision SET revision=revision+1 WHERE id=1; END""")


ANALYSIS = SQLiteStore('analysis', (base, missing_since, listing_revision, library_edits, match_proposals, run_controls, duplicate_schema, arousal_schema, loudness, missing_listing_revision, first_seen_schema), baseline)
