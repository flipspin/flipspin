BEGIN IMMEDIATE;
CREATE TABLE pins(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('song','album','playlist','library')),ref TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(instance_id,account_id,id),UNIQUE(instance_id,account_id,kind,ref));
CREATE TABLE pin_tracks(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,pin_id TEXT NOT NULL,track_key TEXT NOT NULL,PRIMARY KEY(instance_id,account_id,pin_id,track_key),FOREIGN KEY(instance_id,account_id,pin_id) REFERENCES pins(instance_id,account_id,id) ON DELETE CASCADE);
CREATE TABLE files(id INTEGER PRIMARY KEY AUTOINCREMENT,instance_id TEXT NOT NULL,account_id TEXT NOT NULL,track_key TEXT NOT NULL,pool TEXT NOT NULL CHECK(pool IN ('offline','cache')),path TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,etag TEXT,state TEXT NOT NULL,verified_at INTEGER,last_played_at INTEGER,error TEXT,managed INTEGER NOT NULL DEFAULT 1,partial_etag TEXT,expected_bytes INTEGER,UNIQUE(instance_id,account_id,track_key,pool));
CREATE TABLE pending_deletes(path TEXT PRIMARY KEY,managed INTEGER NOT NULL);
CREATE TABLE snapshot(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,etag TEXT,fetched_at INTEGER NOT NULL,PRIMARY KEY(instance_id,account_id,kind));
CREATE TABLE outbox(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,id TEXT NOT NULL,idempotency_key TEXT NOT NULL,intent TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(instance_id,account_id,id));
CREATE TABLE plays_outbox(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,client_play_id TEXT NOT NULL,track_key TEXT NOT NULL,listened_at INTEGER NOT NULL,PRIMARY KEY(instance_id,account_id,client_play_id));
CREATE TABLE imports(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,source TEXT NOT NULL,done INTEGER NOT NULL,PRIMARY KEY(instance_id,account_id,source));
CREATE TABLE legacy_imports(source TEXT PRIMARY KEY,instance_id TEXT NOT NULL,account_id TEXT NOT NULL);
CREATE TABLE art(id INTEGER PRIMARY KEY AUTOINCREMENT,instance_id TEXT NOT NULL,account_id TEXT NOT NULL,album_key TEXT NOT NULL,media_path TEXT NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,etag TEXT,content_type TEXT,state TEXT NOT NULL,verified_at INTEGER,UNIQUE(instance_id,account_id,media_path));
PRAGMA user_version=2;
COMMIT;

-- migration: 3
BEGIN IMMEDIATE;
ALTER TABLE files ADD COLUMN missing_since INTEGER;
ALTER TABLE files ADD COLUMN missing_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN retry_at INTEGER;
ALTER TABLE files ADD COLUMN remote_unavailable INTEGER NOT NULL DEFAULT 0;
CREATE TABLE nest_missing(instance_id TEXT NOT NULL,account_id TEXT NOT NULL,track_key TEXT NOT NULL,PRIMARY KEY(instance_id,account_id,track_key));
PRAGMA user_version=3;
COMMIT;
