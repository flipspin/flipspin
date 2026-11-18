use crate::{
    invalid,
    store::{now, Scope, Store, DOWNLOADED, DOWNLOADING, FAILED, STALE},
    Result,
};
use rusqlite::params;
use std::{
    cmp::Reverse,
    collections::{BTreeMap, BinaryHeap},
    fs::{self, OpenOptions},
    io::Write,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Priority {
    Pin,
    Prefetch,
    Play,
}
#[derive(Default)]
pub struct Queue {
    entries: BinaryHeap<(Priority, Reverse<u64>, Scope, String, String)>,
    next: u64,
    queued: BTreeMap<(Scope, String, String), Priority>,
}
impl Queue {
    pub fn push(&mut self, priority: Priority, scope: Scope, key: String) {
        self.push_pool(priority, scope, key, "offline");
    }
    pub fn push_pool(&mut self, priority: Priority, scope: Scope, key: String, pool: &str) {
        let id = (scope.clone(), key.clone(), pool.to_owned());
        if self.queued.get(&id).is_some_and(|p| *p >= priority) {
            return;
        }
        self.queued.insert(id, priority);
        self.entries
            .push((priority, Reverse(self.next), scope, key, pool.to_owned()));
        self.next += 1;
    }
    pub fn pop(&mut self) -> Option<(Scope, String, String)> {
        while let Some((priority, _, scope, key, pool)) = self.entries.pop() {
            let id = (scope, key, pool);
            if self.queued.get(&id) == Some(&priority) {
                self.queued.remove(&id);
                return Some(id);
            }
        }
        None
    }
}
pub fn strong_etag(etag: &str) -> bool {
    etag.starts_with('"') && etag.ends_with('"') && etag.len() >= 2
}
#[derive(Debug, PartialEq, Eq)]
pub struct Resume {
    pub offset: u64,
    pub if_range: Option<String>,
}
pub fn missing_retry_seconds(previous_attempts: u32) -> i64 {
    [30, 120, 600, 3600, 21600][previous_attempts.min(4) as usize]
}
impl Store {
    /// Publication races retry on a durable schedule, including across restarts.
    pub fn remote_file_missing(&self, scope: &Scope, key: &str, pool: &str) -> Result<()> {
        self.remote_file_missing_at(scope, key, pool, now())
    }
    pub fn remote_file_missing_at(
        &self,
        scope: &Scope,
        key: &str,
        pool: &str,
        at: i64,
    ) -> Result<()> {
        let Some(file) = self.file(scope, key, pool)? else {
            return Ok(());
        };
        let delay = missing_retry_seconds(file.missing_attempts);
        self.db.execute("UPDATE files SET state=?1,error='remote-file-missing',missing_since=COALESCE(missing_since,?2),missing_attempts=missing_attempts+1,retry_at=?3 WHERE id=?4",
            params![if file.verified_at.is_some() || file.remote_unavailable { crate::store::MISSING } else { crate::store::QUEUED }, at, at.saturating_add(delay), file.id])?;
        Ok(())
    }
    /// Recheck at dispatch as well: a queued entry can predate a snapshot or 404.
    pub fn transfer_due(&self, scope: &Scope, key: &str, pool: &str) -> Result<bool> {
        self.transfer_due_at(scope, key, pool, now())
    }
    pub fn transfer_due_at(&self, scope: &Scope, key: &str, pool: &str, at: i64) -> Result<bool> {
        Ok(self
            .file(scope, key, pool)?
            .is_some_and(|f| !f.remote_unavailable && !f.retry_at.is_some_and(|retry| retry > at)))
    }
    /// Recover durable intent in both pools; a failed transfer needs an explicit retry.
    pub fn queue_transfers(&self, scope: &Scope, queue: &mut Queue) -> Result<()> {
        self.queue_transfers_at(scope, queue, now())
    }
    pub fn queue_transfers_at(&self, scope: &Scope, queue: &mut Queue, at: i64) -> Result<()> {
        self.repair_pin_files(scope)?;
        self.queue_due_transfers_at(scope, queue, at)
    }
    /// Idle dispatch reads only due file rows. Full pin repair is reserved for
    /// startup/snapshot reconciliation and explicit recovery callers.
    pub fn queue_due_transfers_at(&self, scope: &Scope, queue: &mut Queue, at: i64) -> Result<()> {
        // Pins create their rows transactionally; repair runs on snapshot changes,
        // not on the idle tick. Only due rows enter this bounded dispatch batch.
        let mut stmt = self.db.prepare("SELECT track_key,pool FROM files f WHERE instance_id=?1 AND account_id=?2 AND remote_unavailable=0 AND (retry_at IS NULL OR retry_at<=?3) AND (state IN ('en fila','descargando') OR (state='ya no está en el nido' AND error='remote-file-missing') OR (state='desactualizado' AND (error IS NULL OR error='local-file-missing'))) AND (pool='cache' OR EXISTS(SELECT 1 FROM pin_tracks p WHERE p.instance_id=f.instance_id AND p.account_id=f.account_id AND p.track_key=f.track_key)) ORDER BY id LIMIT 32")?;
        for row in stmt.query_map(params![scope.instance_id, scope.account_id, at], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (key, pool) = row?;
            queue.push_pool(
                if pool == "offline" {
                    Priority::Pin
                } else {
                    Priority::Prefetch
                },
                scope.clone(),
                key,
                &pool,
            );
        }
        Ok(())
    }
    pub fn worker_transfer(&mut self, scope: &Scope, key: &str, pool: &str, active: bool) {
        let id = (scope.clone(), key.to_owned(), pool.to_owned());
        if active {
            self.transferring.insert(id);
        } else {
            self.transferring.remove(&id);
        }
    }
    pub fn resume(&self, scope: &Scope, key: &str, pool: &str) -> Result<Resume> {
        let file = self.ensure_file(scope, key, pool)?;
        let etag: Option<String>=self.db.query_row("SELECT partial_etag FROM files WHERE instance_id=?1 AND account_id=?2 AND track_key=?3 AND pool=?4",params![scope.instance_id,scope.account_id,key,pool],|r|r.get(0))?;
        let etag = etag.filter(|s| strong_etag(s));
        let offset = if etag.is_some() {
            fs::metadata(self.writable_path(&file).with_extension("part"))
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };
        Ok(Resume {
            offset,
            if_range: etag.filter(|_| offset > 0),
        })
    }
    pub fn observe_etag(&self, scope: &Scope, key: &str, pool: &str, etag: &str) -> Result<()> {
        if let Some(file) = self.file(scope, key, pool)? {
            if file.verified_at.is_some() && file.etag.as_deref() != Some(etag) {
                self.set_state(scope, key, pool, STALE, None)?;
            }
        }
        Ok(())
    }
    /// Start/reset only the staging file; the last verified copy is untouched.
    pub fn begin(
        &self,
        scope: &Scope,
        key: &str,
        pool: &str,
        total: u64,
        etag: Option<&str>,
        offset: u64,
    ) -> Result<()> {
        let file = self.ensure_file(scope, key, pool)?;
        if let Some(etag) = etag {
            self.observe_etag(scope, key, pool, etag)?;
        }
        let resume = self.resume(scope, key, pool)?;
        if offset > 0 && (resume.offset != offset || resume.if_range.as_deref() != etag) {
            return Err(invalid("invalid resume validator"));
        }
        let mut options = OpenOptions::new();
        options.create(true).write(true);
        if offset == 0 {
            options.truncate(true);
        } else {
            options.append(true);
        }
        options.open(self.writable_path(&file).with_extension("part"))?;
        self.db.execute("UPDATE files SET expected_bytes=?1,partial_etag=?2,state=CASE WHEN verified_at IS NULL THEN ?3 ELSE state END,error=NULL WHERE instance_id=?4 AND account_id=?5 AND track_key=?6 AND pool=?7",params![total,etag,DOWNLOADING,scope.instance_id,scope.account_id,key,pool])?;
        Ok(())
    }
    pub fn append(&self, scope: &Scope, key: &str, pool: &str, bytes: &[u8]) -> Result<()> {
        let file = self
            .file(scope, key, pool)?
            .ok_or_else(|| invalid("transfer cancelled"))?;
        let mut part = OpenOptions::new()
            .append(true)
            .open(self.writable_path(&file).with_extension("part"))?;
        part.write_all(bytes)?;
        Ok(())
    }
    pub fn finish(&self, scope: &Scope, key: &str, pool: &str) -> Result<()> {
        let file = self
            .file(scope, key, pool)?
            .ok_or_else(|| invalid("transfer cancelled"))?;
        let (expected,etag):(u64,Option<String>)=self.db.query_row("SELECT expected_bytes,partial_etag FROM files WHERE instance_id=?1 AND account_id=?2 AND track_key=?3 AND pool=?4",params![scope.instance_id,scope.account_id,key,pool],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let part = self.writable_path(&file).with_extension("part");
        if fs::metadata(&part)?.len() != expected {
            self.transfer_failed(scope, key, pool, "size-mismatch")?;
            return Err(invalid("size-mismatch"));
        }
        OpenOptions::new().write(true).open(&part)?.sync_all()?;
        let destination = self.writable_path(&file);
        #[cfg(target_os = "windows")]
        let destination = if destination.exists() {
            destination.with_file_name(format!(
                "{}-{}.audio",
                destination.file_stem().unwrap().to_string_lossy(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))
        } else {
            destination
        };
        fs::rename(&part, &destination)?;
        #[cfg(unix)]
        fs::File::open(
            destination
                .parent()
                .ok_or_else(|| invalid("missing parent"))?,
        )?
        .sync_all()?;
        let tx = self.db.unchecked_transaction()?;
        if file.managed && file.path != destination {
            tx.execute(
                "INSERT OR IGNORE INTO pending_deletes VALUES(?1,1)",
                [file.path.to_string_lossy()],
            )?;
        }
        tx.execute("UPDATE files SET bytes=?1,etag=?2,state=?3,verified_at=?4,missing_since=NULL,missing_attempts=0,retry_at=NULL,partial_etag=NULL,expected_bytes=NULL,error=NULL,path=?9,managed=1 WHERE instance_id=?5 AND account_id=?6 AND track_key=?7 AND pool=?8",params![expected,etag,DOWNLOADED,now(),scope.instance_id,scope.account_id,key,pool,destination.to_string_lossy()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn transfer_failed(
        &self,
        scope: &Scope,
        key: &str,
        pool: &str,
        reason: &str,
    ) -> Result<()> {
        let file = self
            .file(scope, key, pool)?
            .ok_or_else(|| invalid("transfer cancelled"))?;
        self.set_state(
            scope,
            key,
            pool,
            if file.verified_at.is_some() {
                STALE
            } else {
                FAILED
            },
            Some(reason),
        )
    }
    /// A pin adopts an already verified cache copy without contacting the nest.
    /// Staging survives crashes; only the committed offline copy retires cache.
    pub fn promote_cached(&mut self, scope: &Scope, key: &str) -> Result<bool> {
        let Some(cache) = self.file(scope, key, "cache")? else {
            return Ok(false);
        };
        if cache.verified_at.is_none()
            || cache.state != DOWNLOADED
            || !self.allowed(&cache)
            || fs::metadata(&cache.path).map(|m| m.len()).ok() != Some(cache.bytes)
        {
            return Ok(false);
        }
        if self
            .file(scope, key, "offline")?
            .is_some_and(|f| f.verified_at.is_some())
        {
            return Ok(false);
        }
        self.begin(scope, key, "offline", cache.bytes, cache.etag.as_deref(), 0)?;
        let offline = self
            .file(scope, key, "offline")?
            .ok_or_else(|| invalid("pin missing"))?;
        let part = self.writable_path(&offline).with_extension("part");
        fs::remove_file(&part)?;
        // Across volumes fall back to the normal bounded download path.
        if fs::hard_link(&cache.path, &part).is_err() {
            return Ok(false);
        }
        self.finish(scope, key, "offline")?;
        self.delete_file(scope, &cache)?;
        self.sweep_pending()?;
        Ok(true)
    }
    /// Tee closed media ranges in order. Gaps/seeks are never advertised complete.
    pub fn tee(
        &self,
        scope: &Scope,
        key: &str,
        start: u64,
        total: u64,
        etag: Option<&str>,
        bytes: &[u8],
    ) -> Result<bool> {
        // A background resume owns this staging file until it completes or fails.
        if self
            .transferring
            .contains(&(scope.clone(), key.to_owned(), "cache".into()))
        {
            return Ok(false);
        }
        let file = self.ensure_file(scope, key, "cache")?;
        if file.verified_at.is_some() && file.etag.as_deref() == etag {
            return Ok(false);
        }
        let resume = self.resume(scope, key, "cache")?;
        if start == 0 {
            self.begin(scope, key, "cache", total, etag, 0)?;
        } else if start != resume.offset || etag.is_none() || resume.if_range.as_deref() != etag {
            return Ok(false);
        }
        self.append(scope, key, "cache", bytes)?;
        let size = fs::metadata(self.writable_path(&file).with_extension("part"))?.len();
        if size == total {
            self.finish(scope, key, "cache")?;
            return Ok(true);
        }
        if size > total {
            self.transfer_failed(scope, key, "cache", "size-mismatch")?;
        } else {
            // This media response is over. The durable worker owns the remainder.
            self.set_state(scope, key, "cache", crate::store::QUEUED, None)?;
        }
        Ok(false)
    }
}

impl Store {
    /// Art is staged independently of audio and never consumes its cache budget.
    pub fn begin_art(&self, scope: &Scope, album: &str, media_path: &str) -> Result<()> {
        let art = self.ensure_art(scope, album, media_path)?;
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(art.path.with_extension("part"))?;
        Ok(())
    }
    pub fn append_art(&self, scope: &Scope, media_path: &str, bytes: &[u8]) -> Result<()> {
        let art = self
            .art(scope, media_path)?
            .ok_or_else(|| invalid("transfer cancelled"))?;
        OpenOptions::new()
            .append(true)
            .open(art.path.with_extension("part"))?
            .write_all(bytes)?;
        Ok(())
    }
    pub fn finish_art(
        &self,
        scope: &Scope,
        media_path: &str,
        expected: Option<u64>,
        etag: Option<&str>,
        content_type: Option<&str>,
    ) -> Result<()> {
        let art = self
            .art(scope, media_path)?
            .ok_or_else(|| invalid("transfer cancelled"))?;
        let part = art.path.with_extension("part");
        let bytes = fs::metadata(&part)?.len();
        if expected.is_some_and(|n| n != bytes) {
            return Err(invalid("size-mismatch"));
        }
        OpenOptions::new().write(true).open(&part)?.sync_all()?;
        let destination = art.path.clone();
        #[cfg(target_os = "windows")]
        let destination = if destination.exists() {
            destination.with_file_name(format!(
                "{}-{}.image",
                art.id,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ))
        } else {
            destination
        };
        fs::rename(&part, &destination)?;
        #[cfg(unix)]
        fs::File::open(
            destination
                .parent()
                .ok_or_else(|| invalid("missing parent"))?,
        )?
        .sync_all()?;
        let tx = self.db.unchecked_transaction()?;
        if art.path != destination {
            tx.execute(
                "INSERT OR IGNORE INTO pending_deletes VALUES(?1,1)",
                [art.path.to_string_lossy()],
            )?;
        }
        tx.execute("UPDATE art SET path=?1,bytes=?2,etag=?3,content_type=?4,state=?5,verified_at=?6 WHERE id=?7",params![destination.to_string_lossy(),bytes,etag,content_type,DOWNLOADED,now(),art.id])?;
        tx.commit()?;
        Ok(())
    }
}
