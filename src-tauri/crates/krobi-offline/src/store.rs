use crate::{invalid, pools::Pools, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const QUEUED: &str = "en fila";
pub const DOWNLOADING: &str = "descargando";
pub const DOWNLOADED: &str = "descargado";
pub const STALE: &str = "desactualizado";
pub const FAILED: &str = "fallido";
pub const MISSING: &str = "ya no está en el nido";

#[derive(Clone, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct Scope {
    pub instance_id: String,
    pub account_id: String,
}
impl Scope {
    pub fn new(instance_id: &str, account_id: &str) -> Result<Self> {
        if instance_id.is_empty() || account_id.is_empty() {
            return Err(invalid("account-required"));
        }
        Ok(Self {
            instance_id: instance_id.into(),
            account_id: account_id.into(),
        })
    }
}
#[derive(Clone, Debug)]
pub struct FileRecord {
    pub id: i64,
    pub key: String,
    pub pool: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub etag: Option<String>,
    pub state: String,
    pub verified_at: Option<i64>,
    pub last_played_at: Option<i64>,
    pub error: Option<String>,
    pub managed: bool,
    pub missing_since: Option<i64>,
    pub missing_attempts: u32,
    pub retry_at: Option<i64>,
    pub remote_unavailable: bool,
}
pub struct Store {
    pub(crate) db: Connection,
    pub pools: Pools,
    pub(crate) playing: HashSet<(Scope, String)>,
    pub(crate) transferring: HashSet<(Scope, String, String)>,
    active_paths: HashSet<PathBuf>,
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
impl Store {
    pub fn open(path: &Path, pools: Pools) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        )?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 3 {
            return Err(invalid("unsupported offline schema"));
        }
        if version == 0 {
            db.execute_batch(include_str!("schema.sql"))?;
        }
        if version == 1 {
            db.execute_batch(concat!(
                "BEGIN IMMEDIATE;",
                "CREATE TABLE art(id INTEGER PRIMARY KEY AUTOINCREMENT,instance_id TEXT NOT NULL,account_id TEXT NOT NULL,album_key TEXT NOT NULL,media_path TEXT NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,etag TEXT,content_type TEXT,state TEXT NOT NULL,verified_at INTEGER,UNIQUE(instance_id,account_id,media_path));",
                "PRAGMA user_version=2; COMMIT;"
            ))?;
        }
        if matches!(version, 1 | 2) {
            db.execute_batch(
                include_str!("schema.sql")
                    .split_once("-- migration: 3")
                    .unwrap()
                    .1,
            )?;
        }
        // Indexed membership and due-work probes keep idle dispatch independent
        // of the number of completed pins. Safe for existing schema versions.
        db.execute_batch("CREATE INDEX IF NOT EXISTS pin_tracks_key ON pin_tracks(instance_id,account_id,track_key); CREATE INDEX IF NOT EXISTS files_due ON files(instance_id,account_id,state,remote_unavailable,retry_at);")?;
        // Windows pools are verbatim (\\?\) paths, where '/' is not a separator; rows
        // written with one never opened. Rewrite them and let their failed pins retry.
        if cfg!(windows) {
            db.execute("UPDATE files SET path=replace(path,'/','\\'), state=CASE WHEN state=?1 THEN ?2 ELSE state END, error=CASE WHEN state=?1 THEN NULL ELSE error END WHERE pool='offline' AND managed=1 AND instr(path,'/')>0", params![FAILED, QUEUED])?;
        }
        db.execute_batch("CREATE TEMP TABLE reconcile_tracks(track_key TEXT PRIMARY KEY, missing INTEGER NOT NULL);")?;
        fs::create_dir_all(pools.offline.join("art"))?;
        let mut store = Self {
            db,
            pools,
            playing: HashSet::new(),
            transferring: HashSet::new(),
            active_paths: HashSet::new(),
        };
        store.sweep()?;
        // A killed transfer remains resumable, never complete.
        store.db.execute(
            "UPDATE files SET state='en fila' WHERE state='descargando'",
            [],
        )?;
        Ok(store)
    }
    pub fn revision(&self) -> u64 {
        self.db.total_changes()
    }
    pub fn files(&self, scope: &Scope) -> Result<Vec<FileRecord>> {
        let mut stmt = self.db.prepare("SELECT track_key,pool,path,bytes,etag,state,verified_at,last_played_at,error,managed,id,missing_since,missing_attempts,retry_at,remote_unavailable FROM files WHERE instance_id=?1 AND account_id=?2")?;
        let rows = stmt.query_map(params![scope.instance_id, scope.account_id], |r| {
            Ok(FileRecord {
                id: r.get(10)?,
                key: r.get(0)?,
                pool: r.get(1)?,
                path: PathBuf::from(r.get::<_, String>(2)?),
                bytes: r.get(3)?,
                etag: r.get(4)?,
                state: r.get(5)?,
                verified_at: r.get(6)?,
                last_played_at: r.get(7)?,
                error: r.get(8)?,
                managed: r.get(9)?,
                missing_since: r.get(11)?,
                missing_attempts: r.get(12)?,
                retry_at: r.get(13)?,
                remote_unavailable: r.get(14)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn file(&self, scope: &Scope, key: &str, pool: &str) -> Result<Option<FileRecord>> {
        Ok(self.db.query_row("SELECT track_key,pool,path,bytes,etag,state,verified_at,last_played_at,error,managed,id,missing_since,missing_attempts,retry_at,remote_unavailable FROM files WHERE instance_id=?1 AND account_id=?2 AND track_key=?3 AND pool=?4",params![scope.instance_id,scope.account_id,key,pool],|r|Ok(FileRecord {id:r.get(10)?,key:r.get(0)?,pool:r.get(1)?,path:PathBuf::from(r.get::<_,String>(2)?),bytes:r.get(3)?,etag:r.get(4)?,state:r.get(5)?,verified_at:r.get(6)?,last_played_at:r.get(7)?,error:r.get(8)?,managed:r.get(9)?,missing_since:r.get(11)?,missing_attempts:r.get(12)?,retry_at:r.get(13)?,remote_unavailable:r.get(14)?})).optional()?)
    }

    pub fn ensure_file(&self, scope: &Scope, key: &str, pool: &str) -> Result<FileRecord> {
        if !matches!(pool, "offline" | "cache") {
            return Err(invalid("invalid pool"));
        }
        self.db.execute("INSERT OR IGNORE INTO files(instance_id,account_id,track_key,pool,path,state) VALUES(?1,?2,?3,?4,'',?5)",params![scope.instance_id,scope.account_id,key,pool,QUEUED])?;
        let id: i64 = self.db.query_row("SELECT id FROM files WHERE instance_id=?1 AND account_id=?2 AND track_key=?3 AND pool=?4",params![scope.instance_id,scope.account_id,key,pool],|r|r.get(0))?;
        self.db.execute(
            "UPDATE files SET path=?1 WHERE id=?2 AND path=''",
            params![self.pools.path(pool, id).to_string_lossy(), id],
        )?;
        self.db.execute("UPDATE files SET remote_unavailable=1,state=?1,error='snapshot-file-missing',missing_since=COALESCE(missing_since,?2) WHERE id=?3 AND EXISTS(SELECT 1 FROM nest_missing WHERE instance_id=?4 AND account_id=?5 AND track_key=?6)",params![MISSING,now(),id,scope.instance_id,scope.account_id,key])?;
        self.file(scope, key, pool)?
            .ok_or_else(|| invalid("file missing"))
    }
    pub(crate) fn writable_path(&self, file: &FileRecord) -> PathBuf {
        if file.managed {
            file.path.clone()
        } else {
            self.pools.path(&file.pool, file.id)
        }
    }
    pub fn set_state(
        &self,
        scope: &Scope,
        key: &str,
        pool: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.db.execute("UPDATE files SET state=?1,error=?2 WHERE instance_id=?3 AND account_id=?4 AND track_key=?5 AND pool=?6",params![state,error,scope.instance_id,scope.account_id,key,pool])?;
        Ok(())
    }
    pub fn pin_count(&self, scope: &Scope) -> Result<u64> {
        Ok(self.db.query_row(
            "SELECT count(*) FROM pins WHERE instance_id=?1 AND account_id=?2",
            params![scope.instance_id, scope.account_id],
            |r| r.get(0),
        )?)
    }
    pub fn required(&self, scope: &Scope, key: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND track_key=?3)", params![scope.instance_id,scope.account_id,key],|r|r.get(0))?)
    }
    /// Exact imported file grants, never the user's entire folder.
    pub fn allowed(&self, file: &FileRecord) -> bool {
        if file.managed {
            self.pools.contains(&file.path)
        } else {
            file.path.is_absolute() && file.path.canonicalize().is_ok_and(|p| p == file.path)
        }
    }
    pub fn set_playing(&mut self, scope: &Scope, key: &str) {
        self.playing.clear();
        self.playing.insert((scope.clone(), key.into()));
        self.active_paths.clear();
        for pool in ["offline", "cache"] {
            if let Ok(Some(file)) = self.file(scope, key, pool) {
                self.active_paths.insert(file.path.clone());
                self.active_paths.insert(file.path.with_extension("part"));
            }
        }
        let _ = self.db.execute("UPDATE files SET last_played_at=?1 WHERE instance_id=?2 AND account_id=?3 AND track_key=?4",params![now(),scope.instance_id,scope.account_id,key]);
    }
    pub fn stop_playing(&mut self) {
        self.playing.clear();
        self.active_paths.clear();
    }
    pub fn sweep(&mut self) -> Result<()> {
        self.sweep_pending()?;
        for root in [&self.pools.offline, &self.pools.cache] {
            for entry in fs::read_dir(root)? {
                let path = entry?.path();
                if !path.is_file()
                    || self.active_paths.contains(&path)
                    || !self.pools.contains(&path)
                {
                    continue;
                }
                let base = if path.extension().is_some_and(|e| e == "part") {
                    path.with_extension("audio")
                } else {
                    path.clone()
                };
                let id = base
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(-1);
                let exists: bool = self.db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM files WHERE path=?1 OR (managed=0 AND id=?2))",
                    params![base.to_string_lossy(), id],
                    |r| r.get(0),
                )?;
                if !exists {
                    fs::remove_file(path)?;
                }
            }
        }
        // Art has its own directory and index; it never enters audio accounting.
        for entry in fs::read_dir(self.pools.offline.join("art"))? {
            let path = entry?.path();
            if !path.is_file() || self.active_paths.contains(&path) || !self.pools.contains(&path) {
                continue;
            }
            let base = path.with_extension("image");
            let exists: bool = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM art WHERE path=?1)",
                [base.to_string_lossy()],
                |r| r.get(0),
            )?;
            if !exists {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }
    pub fn evict_cache(&mut self, scope: &Scope, budget: u64) -> Result<()> {
        let entries = self
            .files(scope)?
            .into_iter()
            .filter(|f| f.pool == "cache")
            .map(|f| (scope.clone(), f))
            .collect();
        self.evict_entries(entries, budget)
    }
    /// Snapshot scopes only; the shell copies each scope's rows under a short
    /// guard, then computes eviction order and partial sizes without that guard.
    pub fn cache_scopes(&self) -> Result<Vec<Scope>> {
        Ok(self
            .db
            .prepare("SELECT DISTINCT instance_id,account_id FROM files WHERE pool='cache'")?
            .query_map([], |r| {
                Ok(Scope {
                    instance_id: r.get(0)?,
                    account_id: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
    /// Recheck protection at deletion, since a pin/play/transfer may have started
    /// after the caller's snapshot. One candidate per shell lock acquisition.
    pub fn evict_cached_file(&mut self, scope: &Scope, key: &str) -> Result<bool> {
        let Some(file) = self.file(scope, key, "cache")? else {
            return Ok(false);
        };
        if self.required(scope, key)?
            || self.playing.contains(&(scope.clone(), key.to_owned()))
            || self
                .transferring
                .contains(&(scope.clone(), key.to_owned(), "cache".into()))
        {
            return Ok(false);
        }
        self.delete_file(scope, &file)?;
        self.sweep_pending()?;
        Ok(true)
    }
    pub fn enforce_cache_budget(&mut self, budget: u64) -> Result<()> {
        let scopes: Vec<Scope> = self
            .db
            .prepare("SELECT DISTINCT instance_id,account_id FROM files WHERE pool='cache'")?
            .query_map([], |r| {
                Ok(Scope {
                    instance_id: r.get(0)?,
                    account_id: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut entries = Vec::new();
        for scope in scopes {
            entries.extend(
                self.files(&scope)?
                    .into_iter()
                    .filter(|f| f.pool == "cache")
                    .map(|f| (scope.clone(), f)),
            );
        }
        self.evict_entries(entries, budget)
    }
    fn evict_entries(&mut self, mut entries: Vec<(Scope, FileRecord)>, budget: u64) -> Result<()> {
        entries.sort_by_key(|(_, f)| f.last_played_at.unwrap_or(0));
        let size = |f: &FileRecord| {
            f.bytes.saturating_add(
                fs::metadata(f.path.with_extension("part"))
                    .map(|m| m.len())
                    .unwrap_or(0),
            )
        };
        let mut bytes: u64 = entries.iter().map(|(_, f)| size(f)).sum();
        for (scope, file) in entries {
            if bytes <= budget {
                break;
            }
            if self.required(&scope, &file.key)?
                || self.playing.contains(&(scope.clone(), file.key.clone()))
                || self
                    .transferring
                    .contains(&(scope.clone(), file.key.clone(), file.pool.clone()))
            {
                continue;
            }
            self.delete_file(&scope, &file)?;
            bytes = bytes.saturating_sub(size(&file));
        }
        self.sweep_pending()
    }
    pub(crate) fn delete_file(&mut self, scope: &Scope, file: &FileRecord) -> Result<()> {
        let tx = self.db.transaction()?;
        for path in [&file.path, &file.path.with_extension("part")] {
            tx.execute(
                "INSERT OR IGNORE INTO pending_deletes(path,managed) VALUES(?1,?2)",
                params![path.to_string_lossy(), file.managed],
            )?;
        }
        tx.execute(
            "DELETE FROM files WHERE instance_id=?1 AND account_id=?2 AND track_key=?3 AND pool=?4",
            params![scope.instance_id, scope.account_id, file.key, file.pool],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn sweep_pending(&mut self) -> Result<()> {
        let pending: Vec<(String, bool)> = self
            .db
            .prepare("SELECT path,managed FROM pending_deletes LIMIT 32")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (path, managed) in pending {
            if self.active_paths.contains(Path::new(&path)) {
                continue;
            }
            // Exported documents are unindexed, never deleted by repair/eviction.
            if managed && self.pools.contains(Path::new(&path)) {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                }
            }
            self.db
                .execute("DELETE FROM pending_deletes WHERE path=?1", [path])?;
        }
        Ok(())
    }
    /// Revocation drops future server work and views, never the person's files.
    pub fn revoke(&mut self, scope: &Scope) -> Result<()> {
        let tx = self.db.transaction()?;
        for table in ["snapshot", "outbox", "plays_outbox", "nest_missing"] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE instance_id=?1 AND account_id=?2"),
                params![scope.instance_id, scope.account_id],
            )?;
        }
        queue_art_deletes(&tx, scope, "1=1")?;
        tx.commit()?;
        self.sweep_pending()
    }
    pub fn imported(&self, scope: &Scope, source: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT done FROM imports WHERE instance_id=?1 AND account_id=?2 AND source=?3",
                params![scope.instance_id, scope.account_id, source],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
}

/// Schedule physical deletion in the same transaction that removes the rows.
pub(crate) fn queue_art_deletes(
    tx: &rusqlite::Transaction<'_>,
    scope: &Scope,
    predicate: &str,
) -> Result<()> {
    let filter = format!("instance_id=?1 AND account_id=?2 AND ({predicate})");
    tx.execute(
        &format!("INSERT OR IGNORE INTO pending_deletes SELECT path,1 FROM art WHERE {filter}"),
        params![scope.instance_id, scope.account_id],
    )?;
    tx.execute(&format!("INSERT OR IGNORE INTO pending_deletes SELECT substr(path,1,length(path)-6)||'.part',1 FROM art WHERE {filter}"), params![scope.instance_id, scope.account_id])?;
    tx.execute(
        &format!("DELETE FROM art WHERE {filter}"),
        params![scope.instance_id, scope.account_id],
    )?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct ArtRecord {
    pub id: i64,
    pub album_key: String,
    pub media_path: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub etag: Option<String>,
    pub content_type: Option<String>,
    pub state: String,
    pub verified_at: Option<i64>,
}
impl Store {
    pub fn art(&self, scope: &Scope, media_path: &str) -> Result<Option<ArtRecord>> {
        Ok(self.db.query_row("SELECT id,album_key,media_path,path,bytes,etag,content_type,state,verified_at FROM art WHERE instance_id=?1 AND account_id=?2 AND media_path=?3",params![scope.instance_id,scope.account_id,media_path],art_row).optional()?)
    }
    pub fn arts(&self, scope: &Scope) -> Result<Vec<ArtRecord>> {
        let mut stmt = self.db.prepare("SELECT id,album_key,media_path,path,bytes,etag,content_type,state,verified_at FROM art WHERE instance_id=?1 AND account_id=?2 ORDER BY media_path")?;
        let rows = stmt.query_map(params![scope.instance_id, scope.account_id], art_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
    pub fn album_required(&self, scope: &Scope, album: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND substr(track_key,1,instr(track_key,'/')-1)=?3)", params![scope.instance_id,scope.account_id,album], |r| r.get(0))?)
    }
    pub fn ensure_art(&self, scope: &Scope, album: &str, media_path: &str) -> Result<ArtRecord> {
        if !media_path.starts_with("/api/media/") || !self.album_required(scope, album)? {
            return Err(invalid("art-not-required"));
        }
        self.db.execute("INSERT OR IGNORE INTO art(instance_id,account_id,album_key,media_path,path,state) VALUES(?1,?2,?3,?4,'',?5)", params![scope.instance_id,scope.account_id,album,media_path,QUEUED])?;
        let id: i64 = self.db.query_row(
            "SELECT id FROM art WHERE instance_id=?1 AND account_id=?2 AND media_path=?3",
            params![scope.instance_id, scope.account_id, media_path],
            |r| r.get(0),
        )?;
        let path = self.pools.offline.join("art").join(format!("{id}.image"));
        self.db.execute(
            "UPDATE art SET path=?1 WHERE id=?2 AND path=''",
            params![path.to_string_lossy(), id],
        )?;
        self.art(scope, media_path)?
            .ok_or_else(|| invalid("art missing"))
    }
    pub fn touch_art(&self, scope: &Scope, media_path: &str) -> Result<()> {
        self.db.execute("UPDATE art SET verified_at=?1 WHERE instance_id=?2 AND account_id=?3 AND media_path=?4",params![now(),scope.instance_id,scope.account_id,media_path])?;
        Ok(())
    }
    pub fn art_missing(&self, scope: &Scope, album: &str, media_path: &str) -> Result<()> {
        let art = self.ensure_art(scope, album, media_path)?;
        let tx = self.db.unchecked_transaction()?;
        for path in [&art.path, &art.path.with_extension("part")] {
            tx.execute(
                "INSERT OR IGNORE INTO pending_deletes VALUES(?1,1)",
                [path.to_string_lossy()],
            )?;
        }
        tx.execute("UPDATE art SET bytes=0,etag=NULL,content_type=NULL,state=?1,verified_at=?2 WHERE id=?3",params![MISSING,now(),art.id])?;
        tx.commit()?;
        Ok(())
    }
}

fn art_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ArtRecord> {
    Ok(ArtRecord {
        id: r.get(0)?,
        album_key: r.get(1)?,
        media_path: r.get(2)?,
        path: PathBuf::from(r.get::<_, String>(3)?),
        bytes: r.get(4)?,
        etag: r.get(5)?,
        content_type: r.get(6)?,
        state: r.get(7)?,
        verified_at: r.get(8)?,
    })
}
