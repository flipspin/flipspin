"""Numbered jobs.sqlite schema history. No runtime DDL lives in consumers."""
from app.infra.migrations import SQLiteStore


def statements(db, sql):
    # Static DDL only; executescript would commit the runner's transaction.
    for statement in sql.split(';'):
        if statement.strip():
            db.execute(statement)


def columns(db, table):
    return {row[1] for row in db.execute(f'PRAGMA table_info("{table}")')}


QUEUE_COLUMNS = {
            'queue_id': 'TEXT', 'queue_kind': 'TEXT', 'queue_key': 'TEXT',
            'queue_payload': "TEXT NOT NULL DEFAULT '{}'", 'queue_visible': 'INTEGER NOT NULL DEFAULT 0',
            'lease': 'TEXT', 'holder': 'TEXT', 'leased_at': 'REAL NOT NULL DEFAULT 0',
            'heartbeat_at': 'REAL NOT NULL DEFAULT 0', 'lease_until': 'REAL',
            'attempts': 'INTEGER NOT NULL DEFAULT 0', 'max_attempts': 'INTEGER NOT NULL DEFAULT 3',
            'offered_at': 'REAL', 'phase': 'TEXT', 'progress': 'REAL', 'error': 'TEXT',
            'failure_applied': 'INTEGER NOT NULL DEFAULT 0',
        }

def base(db):
    statements(db, """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN
                ('download','import','lyrics-search','lyrics-helper','stems','scan')),
                label TEXT NOT NULL CHECK(length(label)<=120), starter_user_id TEXT,
                state TEXT NOT NULL CHECK(state IN
                ('queued','running','succeeded','partial','failed','cancelled','interrupted')),
                attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 20),
                total INTEGER NOT NULL, succeeded INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
                waiting_on TEXT, created_at REAL NOT NULL, started_at REAL, ended_at REAL,
                cleared_at REAL, parent_id TEXT,
                CHECK((state IN ('queued','running')) = (ended_at IS NULL))
            );
            CREATE TABLE IF NOT EXISTS items (
                job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                idx INTEGER NOT NULL, attempt INTEGER NOT NULL, item TEXT NOT NULL,
                rel_path TEXT, state TEXT NOT NULL CHECK(state IN
                ('queued','running','done','failed','skipped','interrupted')),
                reason TEXT, detail TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY(job_id,idx,attempt)
            );
            CREATE TABLE IF NOT EXISTS ledger_version (version INTEGER NOT NULL);
            INSERT INTO ledger_version SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM ledger_version);
            CREATE INDEX IF NOT EXISTS jobs_retention ON jobs(state,ended_at,cleared_at);
        """)


def queue(db):
    for name, declaration in QUEUE_COLUMNS.items():
        if name not in columns(db, "items"):
            db.execute(f"ALTER TABLE items ADD COLUMN {name} {declaration}")
    statements(db, """
            CREATE UNIQUE INDEX IF NOT EXISTS queue_identity ON items(queue_kind,queue_key)
                WHERE queue_visible=1;
            CREATE UNIQUE INDEX IF NOT EXISTS queue_id ON items(queue_id) WHERE queue_visible=1;
            CREATE TABLE IF NOT EXISTS queue_receipts (
                lease TEXT PRIMARY KEY, kind TEXT NOT NULL, receipt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS queue_migrations (path TEXT PRIMARY KEY);
        """)


def kinds(db, *, matching=False, analysis=False, library_edit=False, source_install=False):
    sql = db.execute("SELECT sql FROM sqlite_schema WHERE name='jobs'").fetchone()[0]
    if all(repr(kind) in sql for kind in ('upload', 'acquisition-request', 'acquisition-match',
                                          'acquisition-fetch', 'acquisition-import', 'acquisition-link')) and (not matching or "'match'" in sql) and (not analysis or "'analysis'" in sql) and (not library_edit or "'library-edit'" in sql) and (not source_install or "'source-install'" in sql):
        return
    names = ('id,kind,label,starter_user_id,state,attempt,total,succeeded,failed,skipped,'
             'waiting_on,created_at,started_at,ended_at,cleared_at,parent_id')
    if columns(db, 'jobs') != set(names.split(',')):
        raise ValueError('unrecognized jobs columns; refusing a lossy rebuild')
    # SQLite's 12-step rebuild: FK disabled by runner before BEGIN. Save
    # dependent objects, create the replacement, copy named columns, drop/rename,
    # restore objects, then runner checks FKs before committing.
    objects = list(db.execute("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL "
                              "AND ((tbl_name='jobs' AND type IN ('index','trigger')) OR type='view')"))
    for kind, name, _ in objects:
        if kind == 'view':
            db.execute('DROP VIEW "' + name.replace('"', '""') + '"')
    definition = """CREATE TABLE jobs_new (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN
                ('download','import','lyrics-search','lyrics-helper','stems','scan','upload','acquisition-request','acquisition-match','acquisition-fetch','acquisition-import','acquisition-link')),
                label TEXT NOT NULL CHECK(length(label)<=120), starter_user_id TEXT,
                state TEXT NOT NULL CHECK(state IN
                ('queued','running','succeeded','partial','failed','cancelled','interrupted')),
                attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 20),
                total INTEGER NOT NULL, succeeded INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
                waiting_on TEXT, created_at REAL NOT NULL, started_at REAL, ended_at REAL,
                cleared_at REAL, parent_id TEXT,
                CHECK((state IN ('queued','running')) = (ended_at IS NULL))
            )"""
    if matching:
        definition = definition.replace("('download','import',", "('download','import','match',")
    if analysis:
        definition = definition.replace("('download','import',", "('download','import','analysis',")
    if library_edit:
        definition = definition.replace("('download','import',", "('download','import','library-edit',")
    if source_install:
        definition = definition.replace("('download','import',", "('download','import','source-install',")
    db.execute(definition)
    db.execute(f'INSERT INTO jobs_new ({names}) SELECT {names} FROM jobs')
    db.execute('DROP TABLE jobs')
    db.execute('ALTER TABLE jobs_new RENAME TO jobs')
    for _, _, definition in objects:
        db.execute(definition)


def acquisition(db):
    statements(db, """
                CREATE TABLE IF NOT EXISTS acquisition_requests (
                    id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('song','album','playlist')),
                    provider TEXT NOT NULL, provider_id TEXT NOT NULL, title TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN
                        ('pending','approved','fetching','importing','completo','parcial','fallido','rechazado')),
                    created_at REAL NOT NULL, decided_by TEXT, decided_at REAL,
                    expected_tracks INTEGER NOT NULL, imported_tracks INTEGER NOT NULL DEFAULT 0,
                    dismissed_at REAL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS acquisition_open ON acquisition_requests
                    (account_id,provider,provider_id) WHERE state IN ('pending','approved','fetching','importing');
                CREATE TABLE IF NOT EXISTS idempotency_keys (
                    key TEXT NOT NULL, account_id TEXT NOT NULL, route TEXT NOT NULL,
                    body_hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL,
                    created_at REAL NOT NULL, PRIMARY KEY(key,account_id,route)
                );
                CREATE TABLE IF NOT EXISTS acquisition_work (
                    request_id TEXT PRIMARY KEY REFERENCES acquisition_requests(id),
                    body TEXT NOT NULL, job_id TEXT NOT NULL, principal TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS acquisition_stages (
                    request_id TEXT NOT NULL REFERENCES acquisition_requests(id),
                    stage TEXT NOT NULL, job_id TEXT NOT NULL,
                    PRIMARY KEY(request_id,stage)
                );
                CREATE TABLE IF NOT EXISTS acquisition_transfers (
                    identity TEXT PRIMARY KEY, provider TEXT NOT NULL, job_id TEXT NOT NULL,
                    state TEXT NOT NULL, path TEXT, error TEXT, reason TEXT, owner_request_id TEXT
                );
                CREATE TABLE IF NOT EXISTS acquisition_providers (
                    provider TEXT PRIMARY KEY, until_at REAL NOT NULL DEFAULT 0,
                    next_at REAL NOT NULL DEFAULT 0
                );
            """)
    if "dismissed_at" not in columns(db, "acquisition_requests"):
        db.execute("ALTER TABLE acquisition_requests ADD COLUMN dismissed_at REAL")


def uploads(db):
    statements(db, """
                CREATE TABLE IF NOT EXISTS upload_batches (
                    id TEXT PRIMARY KEY, account TEXT NOT NULL, principal TEXT NOT NULL,
                    phase TEXT NOT NULL, choice TEXT NOT NULL DEFAULT 'use-nest', updated REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS upload_items (
                    account TEXT NOT NULL, sha256 TEXT NOT NULL, batch TEXT NOT NULL,
                    body TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
                    offset INTEGER NOT NULL DEFAULT 0, hit TEXT, duplicate TEXT,
                    request_id TEXT, updated REAL NOT NULL,
                    PRIMARY KEY(account,sha256)
                );
                CREATE TABLE IF NOT EXISTS upload_members (
                    batch TEXT NOT NULL, sha256 TEXT NOT NULL, client_id TEXT NOT NULL,
                    idx INTEGER NOT NULL, PRIMARY KEY(batch,sha256)
                );
                CREATE TABLE IF NOT EXISTS upload_hashes (
                    sha256 TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL
                );
            """)


def plays(db):
    statements(db, """CREATE TABLE IF NOT EXISTS plays(
    account_id TEXT NOT NULL, track_key TEXT NOT NULL, listened_at TEXT NOT NULL,
    client_play_id TEXT NOT NULL, UNIQUE(account_id, track_key, listened_at));
    CREATE TABLE IF NOT EXISTS plays_baselines(account_id TEXT NOT NULL,track_key TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(account_id,track_key));""")


def baseline(db):
    """Stamp only the contiguous history already present in an unversioned file."""
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
    required = (
        {'jobs', 'items', 'ledger_version'}, {'queue_receipts', 'queue_migrations'}, set(),
        {'acquisition_requests', 'idempotency_keys', 'acquisition_work', 'acquisition_stages',
         'acquisition_transfers', 'acquisition_providers'},
        {'upload_batches', 'upload_items', 'upload_members', 'upload_hashes'},
        {'plays', 'plays_baselines'},
    )
    # These fields predate the numbered history. Unknown partial legacy schemas
    # cannot safely be stamped as current merely because their table names match.
    base_columns = {
        'jobs': set('id kind label starter_user_id state attempt total succeeded failed skipped waiting_on '
                    'created_at started_at ended_at cleared_at parent_id'.split()),
        'items': set('job_id idx attempt item rel_path state reason detail'.split()),
        'ledger_version': {'version'},
        'queue_receipts': set('lease kind receipt'.split()),
        'queue_migrations': {'path'},
        'acquisition_requests': set('id account_id kind provider provider_id title state created_at decided_by '
                                    'decided_at expected_tracks imported_tracks'.split()),
        'idempotency_keys': set('key account_id route body_hash status response created_at'.split()),
        'acquisition_work': set('request_id body job_id principal'.split()),
        'acquisition_stages': set('request_id stage job_id'.split()),
        'acquisition_transfers': set('identity provider job_id state path error reason owner_request_id'.split()),
        'acquisition_providers': set('provider until_at next_at'.split()),
        'upload_batches': set('id account principal phase choice updated'.split()),
        'upload_items': set('account sha256 batch body state reason offset hit duplicate request_id updated'.split()),
        'upload_members': set('batch sha256 client_id idx'.split()),
        'upload_hashes': set('sha256 path size mtime'.split()),
        'plays': set('account_id track_key listened_at client_play_id'.split()),
        'plays_baselines': set('account_id track_key count'.split()),
    }
    for table, expected in base_columns.items():
        if table in tables and not expected <= columns(db, table):
            raise ValueError(f'unrecognized legacy {table} columns')
    indexes = {r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='index'")}
    version = 0
    for number, names in enumerate(required, 1):
        if not names <= tables:
            break
        if number == 1 and 'jobs_retention' not in indexes:
            break
        if number == 2 and (not set(QUEUE_COLUMNS) <= columns(db, 'items')
                            or not {'queue_identity', 'queue_id'} <= indexes):
            break
        if number == 3:
            sql = db.execute("SELECT sql FROM sqlite_schema WHERE name='jobs'").fetchone()[0]
            if not all(repr(k) in sql for k in ('upload', 'acquisition-request', 'acquisition-match',
                                              'acquisition-fetch', 'acquisition-import', 'acquisition-link')):
                break
        if number == 4 and ('dismissed_at' not in columns(db, 'acquisition_requests')
                            or 'acquisition_open' not in indexes):
            break
        version = number
    return version


def match_kind(db):
    kinds(db, matching=True)


def analysis_kind(db):
    kinds(db, matching=True, analysis=True)



def play_events(db):
    statements(db, """
        CREATE TABLE IF NOT EXISTS play_events (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, track_key TEXT NOT NULL,
            started_at TEXT NOT NULL, listened_at TEXT NOT NULL,
            duration_played_s REAL CHECK(duration_played_s >= 0),
            completed INTEGER NOT NULL CHECK(completed IN (0,1)),
            source TEXT NOT NULL CHECK(source IN ('desktop','phone','subsonic')),
            device_id TEXT
        );
        CREATE INDEX IF NOT EXISTS play_events_user_started ON play_events(user_id, started_at);
        INSERT INTO play_events
            SELECT lower(hex(randomblob(16))), account_id, track_key, listened_at, listened_at,
                   NULL, 1, 'desktop', NULL FROM plays p
            WHERE NOT EXISTS (SELECT 1 FROM play_events e WHERE e.user_id=p.account_id
                AND e.track_key=p.track_key AND e.listened_at=p.listened_at);
    """)


def library_edit_kind(db):
    kinds(db, matching=True, analysis=True, library_edit=True)


def queue_turns(db):
    db.execute('CREATE TABLE IF NOT EXISTS queue_turns (lane TEXT PRIMARY KEY, kind TEXT NOT NULL)')


def upload_followups(db):
    statements(db, """
        CREATE TABLE IF NOT EXISTS upload_followups (
            batch TEXT PRIMARY KEY REFERENCES upload_batches(id), total INTEGER NOT NULL,
            refreshed_at REAL, refresh_pending INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS upload_completions (
            batch TEXT NOT NULL REFERENCES upload_batches(id), path TEXT NOT NULL,
            PRIMARY KEY(batch,path)
        );
        INSERT OR IGNORE INTO upload_followups(batch,total)
            SELECT b.id,count(m.sha256) FROM upload_batches b
            LEFT JOIN upload_members m ON m.batch=b.id GROUP BY b.id;
    """)


def upload_paths(db):
    if 'published_path' not in columns(db, 'upload_items'):
        db.execute('ALTER TABLE upload_items ADD COLUMN published_path TEXT')


def upload_receipt_time(db):
    if 'received_at' not in columns(db, 'upload_items'):
        db.execute('ALTER TABLE upload_items ADD COLUMN received_at REAL')
    db.execute("""UPDATE upload_items SET received_at=coalesce(
        (SELECT created_at FROM jobs WHERE id=upload_items.batch),
        (SELECT created_at FROM acquisition_requests WHERE id=upload_items.request_id), updated) WHERE received_at IS NULL""")


def acquisition_search(db):
    db.execute("""CREATE TABLE IF NOT EXISTS acquisition_search (
        query TEXT PRIMARY KEY, results TEXT NOT NULL, expires_at REAL NOT NULL
    )""")
    db.execute('CREATE INDEX IF NOT EXISTS acquisition_search_expires ON acquisition_search(expires_at)')


def source_health(db):
    for name, declaration in (('level', 'INTEGER NOT NULL DEFAULT 0'), ('kind', 'TEXT'), ('since', 'REAL')):
        if name not in columns(db, 'acquisition_providers'):
            db.execute(f'ALTER TABLE acquisition_providers ADD COLUMN {name} {declaration}')
    # Existing cooldowns were exclusively caused by rate limits.
    db.execute("UPDATE acquisition_providers SET kind='rate-limited',level=1 WHERE until_at>0 AND kind IS NULL")


def source_facts(db):
    for name in ('first_failure_at', 'last_failure_at'):
        if name not in columns(db, 'acquisition_providers'):
            db.execute(f'ALTER TABLE acquisition_providers ADD COLUMN {name} REAL')
    db.execute('UPDATE acquisition_providers SET first_failure_at=since WHERE first_failure_at IS NULL')
    if 'published_format' not in columns(db, 'acquisition_providers'):
        db.execute('ALTER TABLE acquisition_providers ADD COLUMN published_format TEXT')


def acquisition_item_stages(db):
    if 'stage' not in columns(db, 'items'):
        db.execute('ALTER TABLE items ADD COLUMN stage TEXT')
    if 'stage_at' not in columns(db, 'items'):
        db.execute('ALTER TABLE items ADD COLUMN stage_at REAL')
    db.execute('CREATE INDEX IF NOT EXISTS items_stage ON items(job_id,stage,idx) WHERE stage IS NOT NULL')


def source_install_kind(db):
    kinds(db, matching=True, analysis=True, library_edit=True, source_install=True)
    db.execute('CREATE TABLE IF NOT EXISTS source_status (id TEXT PRIMARY KEY, data TEXT NOT NULL)')


JOBS = SQLiteStore('jobs', (base, queue, kinds, acquisition, uploads, plays, match_kind, analysis_kind, play_events, library_edit_kind, queue_turns, upload_followups, upload_paths, upload_receipt_time, acquisition_search, source_health, source_facts, acquisition_item_stages, source_install_kind), baseline,
                   application_id=0x4B524A42, rebuild_steps=frozenset({3, 7, 8, 10, 19}))
