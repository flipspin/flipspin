//! Verbatim server bodies, scoped to the authenticated account and nest.
use crate::{
    invalid,
    store::{now, Scope, Store},
    Result,
};
use rusqlite::{params, OptionalExtension};

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub kind: String,
    pub body: String,
    pub etag: Option<String>,
    pub fetched_at: i64,
}
pub fn valid_kind(kind: &str) -> bool {
    matches!(kind, "listing" | "library" | "playlists" | "home")
        || kind
            .strip_prefix("playlist:")
            .is_some_and(|s| !s.is_empty())
}
impl Store {
    pub fn snapshot(&self, scope: &Scope, kind: &str) -> Result<Option<Snapshot>> {
        if !valid_kind(kind) {
            return Err(invalid("invalid-snapshot-kind"));
        }
        Ok(self.db.query_row("SELECT kind,body,etag,fetched_at FROM snapshot WHERE instance_id=?1 AND account_id=?2 AND kind=?3", params![scope.instance_id,scope.account_id,kind], |r| Ok(Snapshot {kind:r.get(0)?,body:r.get(1)?,etag:r.get(2)?,fetched_at:r.get(3)?})).optional()?)
    }
    pub fn save_snapshot(
        &self,
        scope: &Scope,
        kind: &str,
        body: &str,
        etag: Option<&str>,
    ) -> Result<()> {
        if !valid_kind(kind) {
            return Err(invalid("invalid-snapshot-kind"));
        }
        self.db.execute("INSERT INTO snapshot VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(instance_id,account_id,kind) DO UPDATE SET body=excluded.body,etag=excluded.etag,fetched_at=excluded.fetched_at", params![scope.instance_id,scope.account_id,kind,body,etag,now()])?;
        Ok(())
    }
    pub fn touch_snapshot(&self, scope: &Scope, kind: &str) -> Result<()> {
        self.db.execute(
            "UPDATE snapshot SET fetched_at=?1 WHERE instance_id=?2 AND account_id=?3 AND kind=?4",
            params![now(), scope.instance_id, scope.account_id, kind],
        )?;
        Ok(())
    }
    /// Forget one saved copy (a playlist the nest no longer has under that name).
    pub fn delete_snapshot(&self, scope: &Scope, kind: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM snapshot WHERE instance_id=?1 AND account_id=?2 AND kind=?3",
            params![scope.instance_id, scope.account_id, kind],
        )?;
        Ok(())
    }
    pub fn snapshot_kinds(&self, scope: &Scope) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare(
                "SELECT kind FROM snapshot WHERE instance_id=?1 AND account_id=?2 ORDER BY kind",
            )?
            .query_map(params![scope.instance_id, scope.account_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
}
