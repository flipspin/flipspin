use crate::{
    invalid,
    store::{now, Scope, Store, DOWNLOADED},
    Result,
};
use rusqlite::params;
use std::{fs, path::Path};

pub fn pin_id(kind: &str, reference: &str) -> String {
    format!("{kind}:{reference}")
}
/// One pin as the storage controls see it: id, kind, ref, and its track keys.
pub type PinRow = (String, String, String, Vec<String>);

impl Store {
    /// A complete listing is authoritative for availability, never for pin intent.
    /// The caller compares listing revisions; an unchanged snapshot cannot reset backoff.
    pub fn reconcile_library(
        &self,
        scope: &Scope,
        tracks: &std::collections::BTreeMap<String, bool>,
        new_revision: bool,
    ) -> Result<bool> {
        self.repair_pin_files(scope)?;
        let tx = self.db.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM nest_missing WHERE instance_id=?1 AND account_id=?2",
            params![scope.instance_id, scope.account_id],
        )?;
        let tracks = serde_json::to_string(tracks)?;
        tx.execute("DELETE FROM reconcile_tracks", [])?;
        tx.execute(
            "INSERT INTO reconcile_tracks SELECT key,value FROM json_each(?1)",
            [&tracks],
        )?;
        tx.execute(
            "INSERT INTO nest_missing SELECT ?1,?2,track_key FROM reconcile_tracks WHERE missing=1",
            params![scope.instance_id, scope.account_id],
        )?;
        let missing = tx.execute("UPDATE files SET remote_unavailable=1,state=?1,error='snapshot-file-missing',missing_since=COALESCE(missing_since,?2) WHERE instance_id=?3 AND account_id=?4 AND remote_unavailable=0 AND NOT EXISTS(SELECT 1 FROM reconcile_tracks WHERE track_key=files.track_key AND missing=0)", params![crate::store::MISSING,now(),scope.instance_id,scope.account_id])?;
        let restored = tx.execute("UPDATE files SET remote_unavailable=0,state=CASE WHEN verified_at IS NOT NULL THEN 'desactualizado' ELSE 'en fila' END,error=NULL,missing_since=NULL,missing_attempts=0,retry_at=NULL WHERE instance_id=?1 AND account_id=?2 AND remote_unavailable=1 AND EXISTS(SELECT 1 FROM reconcile_tracks WHERE track_key=files.track_key AND missing=0)", params![scope.instance_id,scope.account_id])?;
        let reset = if new_revision {
            tx.execute("UPDATE files SET retry_at=NULL WHERE instance_id=?1 AND account_id=?2 AND remote_unavailable=0 AND missing_attempts>0 AND retry_at IS NOT NULL", params![scope.instance_id,scope.account_id])?
        } else {
            0
        };
        let changed = missing + restored + reset > 0;
        tx.commit()?;
        Ok(changed)
    }
    /// Apply remembered missing-file flags even to expansions made between syncs.
    pub(crate) fn suppress_known_missing(&self, scope: &Scope) -> Result<()> {
        self.db.execute("UPDATE files SET remote_unavailable=1,state=?1,error='snapshot-file-missing',missing_since=COALESCE(missing_since,?2) WHERE instance_id=?3 AND account_id=?4 AND track_key IN (SELECT track_key FROM nest_missing WHERE instance_id=?3 AND account_id=?4)", params![crate::store::MISSING,now(),scope.instance_id,scope.account_id])?;
        Ok(())
    }
    /// Scoped pin expansions for storage controls; no paths or other accounts.
    pub fn pins(&self, scope: &Scope) -> Result<Vec<PinRow>> {
        let mut stmt = self.db.prepare("SELECT p.id,p.kind,p.ref,t.track_key FROM pins p LEFT JOIN pin_tracks t ON t.instance_id=p.instance_id AND t.account_id=p.account_id AND t.pin_id=p.id WHERE p.instance_id=?1 AND p.account_id=?2 ORDER BY p.id,t.track_key")?;
        let rows = stmt.query_map(params![scope.instance_id, scope.account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut pins: Vec<PinRow> = Vec::new();
        for row in rows {
            let (id, kind, reference, key) = row?;
            if !matches!(pins.last(), Some(pin) if pin.0 == id) {
                pins.push((id, kind, reference, Vec::new()));
            }
            if let Some(key) = key {
                pins.last_mut().unwrap().3.push(key);
            }
        }
        Ok(pins)
    }

    pub fn pin_keys(
        &self,
        scope: &Scope,
        kind: &str,
        reference: &str,
    ) -> Result<Option<Vec<String>>> {
        let id = pin_id(kind, reference);
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pins WHERE instance_id=?1 AND account_id=?2 AND id=?3)",
            params![scope.instance_id, scope.account_id, id],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        Ok(Some(self.db.prepare("SELECT track_key FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND pin_id=?3 ORDER BY track_key")?.query_map(params![scope.instance_id,scope.account_id,id], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<_>>()?))
    }
    /// Explicit pin/retry supplies an expansion; snapshots update it through `refresh_pin`.
    /// Changed children reconcile atomically.
    pub fn pin(
        &mut self,
        scope: &Scope,
        kind: &str,
        reference: &str,
        tracks: &[String],
    ) -> Result<String> {
        self.set_pin(scope, kind, reference, tracks, true)
    }
    /// Grow one collection pin without replacing children or retrying transfers.
    /// `create` records intent before acquisition; later receipts require that
    /// intent to still exist, so an unpin cannot be undone by a late response.
    /// Only newly attached keys are returned for the shell's transfer queue.
    pub fn extend_pin(
        &mut self,
        scope: &Scope,
        kind: &str,
        reference: &str,
        tracks: &[String],
        create: bool,
    ) -> Result<Vec<String>> {
        if !matches!(kind, "album" | "playlist") || reference.is_empty() {
            return Err(invalid("invalid collection pin"));
        }
        let id = pin_id(kind, reference);
        let tx = self.db.transaction()?;
        if create {
            tx.execute(
                "INSERT OR IGNORE INTO pins VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    scope.instance_id,
                    scope.account_id,
                    id,
                    kind,
                    reference,
                    now()
                ],
            )?;
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pins WHERE instance_id=?1 AND account_id=?2 AND id=?3)",
            params![scope.instance_id, scope.account_id, id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(invalid("pin removed"));
        }
        let input = serde_json::to_string(tracks)?;
        let added = tx.prepare("SELECT DISTINCT value FROM json_each(?4) WHERE NOT EXISTS(SELECT 1 FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND pin_id=?3 AND track_key=value)")?.query_map(params![scope.instance_id,scope.account_id,id,input], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let input = serde_json::to_string(&added)?;
        tx.execute(
            "INSERT OR IGNORE INTO pin_tracks SELECT ?1,?2,?3,value FROM json_each(?4)",
            params![scope.instance_id, scope.account_id, id, input],
        )?;
        tx.execute("INSERT OR IGNORE INTO files(instance_id,account_id,track_key,pool,path,state) SELECT ?1,?2,value,'offline','','en fila' FROM json_each(?3)", params![scope.instance_id,scope.account_id,input])?;
        tx.execute("UPDATE files SET path=?1||?4||id||'.audio' WHERE instance_id=?2 AND account_id=?3 AND pool='offline' AND path=''", params![self.pools.offline.to_string_lossy(),scope.instance_id,scope.account_id,std::path::MAIN_SEPARATOR_STR])?;
        tx.commit()?;
        if !added.is_empty() {
            self.suppress_known_missing(scope)?;
        }
        Ok(added)
    }
    /// A refreshed collection updates its expansion without silently retrying failures.
    pub fn refresh_pin(
        &mut self,
        scope: &Scope,
        kind: &str,
        reference: &str,
        tracks: &[String],
    ) -> Result<bool> {
        let id = pin_id(kind, reference);
        let exists: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pins WHERE instance_id=?1 AND account_id=?2 AND id=?3)",
            params![scope.instance_id, scope.account_id, id],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(false);
        }
        let old = self.db.prepare("SELECT track_key FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND pin_id=?3")?.query_map(params![scope.instance_id,scope.account_id,id], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let old: std::collections::BTreeSet<_> = old.iter().collect();
        let new: std::collections::BTreeSet<_> = tracks.iter().collect();
        if old == new {
            return self.repair_pin_files(scope);
        }
        self.set_pin(scope, kind, reference, tracks, false)?;
        Ok(true)
    }
    /// Repair missing offline rows independently of any listening-cache row.
    pub fn repair_pin_files(&self, scope: &Scope) -> Result<bool> {
        let tx = self.db.unchecked_transaction()?;
        let added = tx.execute("INSERT OR IGNORE INTO files(instance_id,account_id,track_key,pool,path,state) SELECT DISTINCT instance_id,account_id,track_key,'offline','','en fila' FROM pin_tracks WHERE instance_id=?1 AND account_id=?2", params![scope.instance_id,scope.account_id])?;
        tx.execute("UPDATE files SET path=?1||?4||id||'.audio' WHERE instance_id=?2 AND account_id=?3 AND pool='offline' AND path=''", params![self.pools.offline.to_string_lossy(),scope.instance_id,scope.account_id,std::path::MAIN_SEPARATOR_STR])?;
        tx.commit()?;
        Ok(added > 0)
    }

    fn set_pin(
        &mut self,
        scope: &Scope,
        kind: &str,
        reference: &str,
        tracks: &[String],
        retry_failed: bool,
    ) -> Result<String> {
        if !matches!(kind, "song" | "album" | "playlist" | "library") || reference.is_empty() {
            return Err(invalid("invalid pin"));
        }
        let id = pin_id(kind, reference);
        let mut sorted = tracks.to_vec();
        sorted.sort();
        sorted.dedup();
        if self.pin_keys(scope, kind, reference)?.as_ref() == Some(&sorted) {
            self.repair_pin_files(scope)?;
            if retry_failed {
                self.db.execute("UPDATE files SET state='en fila',error=NULL WHERE instance_id=?1 AND account_id=?2 AND pool='offline' AND state='fallido' AND track_key IN (SELECT value FROM json_each(?3))", params![scope.instance_id,scope.account_id,serde_json::to_string(tracks)?])?;
            }
            return Ok(id);
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO pins VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                scope.instance_id,
                scope.account_id,
                id,
                kind,
                reference,
                now()
            ],
        )?;
        tx.execute(
            "DELETE FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND pin_id=?3",
            params![scope.instance_id, scope.account_id, id],
        )?;
        let tracks = serde_json::to_string(tracks)?;
        tx.execute(
            "INSERT OR IGNORE INTO pin_tracks SELECT ?1,?2,?3,value FROM json_each(?4)",
            params![scope.instance_id, scope.account_id, id, tracks],
        )?;
        unlink_unused(&tx, scope)?;
        tx.execute("INSERT OR IGNORE INTO files(instance_id,account_id,track_key,pool,path,state) SELECT ?1,?2,value,'offline','','en fila' FROM json_each(?3)", params![scope.instance_id,scope.account_id,tracks])?;
        tx.execute("UPDATE files SET path=?1||?4||id||'.audio' WHERE instance_id=?2 AND account_id=?3 AND pool='offline' AND path=''", params![self.pools.offline.to_string_lossy(),scope.instance_id,scope.account_id,std::path::MAIN_SEPARATOR_STR])?;
        if retry_failed {
            tx.execute("UPDATE files SET state='en fila',error=NULL WHERE instance_id=?1 AND account_id=?2 AND pool='offline' AND state='fallido' AND track_key IN (SELECT value FROM json_each(?3))", params![scope.instance_id,scope.account_id,tracks])?;
        }
        tx.commit()?;
        self.suppress_known_missing(scope)?;
        Ok(id)
    }
    pub fn unpin(&mut self, scope: &Scope, id: Option<&str>) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM pins WHERE instance_id=?1 AND account_id=?2 AND (?3 IS NULL OR id=?3)",
            params![scope.instance_id, scope.account_id, id],
        )?;
        unlink_unused(&tx, scope)?;
        tx.commit()?;
        Ok(()) // The shell sweeps after the commit; startup repairs an interrupted delete.
    }
    /// D3: a library removal releases the track from every collection pin.
    pub fn remove_library_track(&mut self, scope: &Scope, key: &str) -> Result<()> {
        let tx = self.db.transaction()?;
        tx.execute(
            "DELETE FROM pin_tracks WHERE instance_id=?1 AND account_id=?2 AND track_key=?3",
            params![scope.instance_id, scope.account_id, key],
        )?;
        unlink_unused(&tx, scope)?;
        tx.commit()?;
        Ok(())
    }
    /// Legacy exports remain in place and are granted as individual files.
    /// Repair, cache clear, and unpin never remove user documents.
    pub fn import_songs(
        &mut self,
        scope: &Scope,
        source: &str,
        songs: &[(String, String)],
    ) -> Result<()> {
        self.import_prepared_songs(scope, source, &prepare_import_songs(songs)?)
    }
    /// File metadata and canonical paths are prepared by the shell outside its
    /// store mutex; the atomic grant/index update does no filesystem work.
    pub fn import_prepared_songs(
        &mut self,
        scope: &Scope,
        source: &str,
        songs: &[(String, std::path::PathBuf, u64)],
    ) -> Result<()> {
        if self.imported(scope, source)? {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        if tx.execute(
            "INSERT OR IGNORE INTO legacy_imports VALUES(?1,?2,?3)",
            params![source, scope.instance_id, scope.account_id],
        )? == 0
        {
            return Ok(());
        }
        let input = serde_json::to_string(songs)?;
        tx.execute("INSERT OR IGNORE INTO pins SELECT ?1,?2,'song:'||json_extract(value,'$[0]'),'song',json_extract(value,'$[0]'),?3 FROM json_each(?4)", params![scope.instance_id,scope.account_id,now(),input])?;
        tx.execute("INSERT OR IGNORE INTO pin_tracks SELECT ?1,?2,'song:'||json_extract(value,'$[0]'),json_extract(value,'$[0]') FROM json_each(?3)", params![scope.instance_id,scope.account_id,input])?;
        tx.execute("INSERT OR IGNORE INTO files(instance_id,account_id,track_key,pool,path,bytes,state,verified_at,managed) SELECT ?1,?2,json_extract(value,'$[0]'),'offline',json_extract(value,'$[1]'),json_extract(value,'$[2]'),?3,?4,0 FROM json_each(?5)", params![scope.instance_id,scope.account_id,DOWNLOADED,now(),input])?;
        tx.execute(
            "INSERT INTO imports VALUES(?1,?2,?3,1)",
            params![scope.instance_id, scope.account_id, source],
        )?;
        tx.commit()?;
        Ok(())
    }
}
/// This may touch slow external volumes. Call before taking the store lock.
pub fn prepare_import_songs(
    songs: &[(String, String)],
) -> Result<Vec<(String, std::path::PathBuf, u64)>> {
    let mut prepared = Vec::new();
    for (key, path) in songs {
        let Ok(path) = Path::new(path).canonicalize() else {
            continue;
        };
        let metadata = fs::metadata(&path)?;
        if metadata.is_file() {
            prepared.push((key.clone(), path, metadata.len()));
        }
    }
    Ok(prepared)
}

fn unlink_unused(tx: &rusqlite::Transaction<'_>, scope: &Scope) -> Result<()> {
    crate::store::queue_art_deletes(tx, scope, "NOT EXISTS(SELECT 1 FROM pin_tracks p WHERE p.instance_id=art.instance_id AND p.account_id=art.account_id AND substr(p.track_key,1,instr(p.track_key,'/')-1)=art.album_key)")?;
    let predicate="instance_id=?1 AND account_id=?2 AND pool='offline' AND NOT EXISTS(SELECT 1 FROM pin_tracks p WHERE p.instance_id=files.instance_id AND p.account_id=files.account_id AND p.track_key=files.track_key)";
    tx.execute(&format!("INSERT OR IGNORE INTO pending_deletes SELECT path,managed FROM files WHERE {predicate}"),params![scope.instance_id,scope.account_id])?;
    // Partial files use the same stem as the final .audio file.
    tx.execute(&format!("INSERT OR IGNORE INTO pending_deletes SELECT substr(path,1,length(path)-6)||'.part',managed FROM files WHERE managed=1 AND {predicate}"),params![scope.instance_id,scope.account_id])?;
    tx.execute(
        &format!("DELETE FROM files WHERE {predicate}"),
        params![scope.instance_id, scope.account_id],
    )?;
    Ok(())
}
