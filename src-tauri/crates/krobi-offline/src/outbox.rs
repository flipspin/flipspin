//! Durable FIFO. Failed/conflicting rows stay available until explicitly resolved.
use crate::{
    invalid, offline_action,
    store::{now, Scope, Store},
    Result,
};
use rusqlite::params;
pub const RETRY_CAP: u32 = 5;
#[derive(Clone, Debug, PartialEq)]
pub struct Intent {
    pub id: String,
    pub idempotency_key: String,
    pub intent: String,
    pub body: String,
    pub created_at: i64,
    pub attempts: u32,
    pub last_error: Option<String>,
}
impl Intent {
    pub fn failed(&self) -> bool {
        self.attempts >= RETRY_CAP
    }
}
#[derive(Clone, Debug)]
pub struct Play {
    pub client_play_id: String,
    pub track_key: String,
    pub listened_at: i64,
}
impl Store {
    pub fn enqueue(&self, scope: &Scope, id: &str, intent: &str, body: &str) -> Result<()> {
        if offline_action(intent) != "queue" || intent == "play" || id.is_empty() {
            return Err(invalid("offline-action-refused"));
        }
        let existing = self.outbox(scope)?.into_iter().find(|r| r.id == id);
        if let Some(row) = existing {
            return if row.intent == intent && row.body == body {
                Ok(())
            } else {
                Err(invalid("idempotency-body-mismatch"))
            };
        }
        self.db.execute("INSERT INTO outbox(instance_id,account_id,id,idempotency_key,intent,body,created_at) VALUES(?1,?2,?3,?3,?4,?5,?6)",params![scope.instance_id,scope.account_id,id,intent,body,now()])?;
        Ok(())
    }
    pub fn outbox(&self, scope: &Scope) -> Result<Vec<Intent>> {
        Ok(self.db.prepare("SELECT id,idempotency_key,intent,body,created_at,attempts,last_error FROM outbox WHERE instance_id=?1 AND account_id=?2 ORDER BY created_at,rowid")?.query_map(params![scope.instance_id,scope.account_id],|r| Ok(Intent {id:r.get(0)?,idempotency_key:r.get(1)?,intent:r.get(2)?,body:r.get(3)?,created_at:r.get(4)?,attempts:r.get(5)?,last_error:r.get(6)?}))?.collect::<rusqlite::Result<_>>()?)
    }
    /// Commit the attempt before network I/O, so a killed process cannot retry forever.
    pub fn attempt(&self, scope: &Scope, id: &str) -> Result<()> {
        self.db.execute("UPDATE outbox SET attempts=attempts+1,last_error='replay-interrupted' WHERE instance_id=?1 AND account_id=?2 AND id=?3 AND attempts<5",params![scope.instance_id,scope.account_id,id])?;
        Ok(())
    }
    pub fn reject_intent(
        &self,
        scope: &Scope,
        id: &str,
        reason: &str,
        terminal: bool,
    ) -> Result<()> {
        self.db.execute("UPDATE outbox SET last_error=?4,attempts=CASE WHEN ?5 THEN 5 ELSE attempts END WHERE instance_id=?1 AND account_id=?2 AND id=?3",params![scope.instance_id,scope.account_id,id,reason,terminal])?;
        Ok(())
    }
    pub fn discard_intent(&self, scope: &Scope, id: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM outbox WHERE instance_id=?1 AND account_id=?2 AND id=?3",
            params![scope.instance_id, scope.account_id, id],
        )?;
        Ok(())
    }
    pub fn retry_intent(&self, scope: &Scope, id: &str) -> Result<()> {
        // A conflict must be resolved with a fresh version/key, never blindly overwritten.
        self.db.execute("UPDATE outbox SET attempts=0,last_error=NULL WHERE instance_id=?1 AND account_id=?2 AND id=?3 AND (last_error IS NULL OR last_error NOT LIKE '412:%')",params![scope.instance_id,scope.account_id,id])?;
        Ok(())
    }
    pub fn queue_play(&self, scope: &Scope, play: &Play) -> Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO plays_outbox VALUES(?1,?2,?3,?4,?5)",
            params![
                scope.instance_id,
                scope.account_id,
                play.client_play_id,
                play.track_key,
                play.listened_at
            ],
        )?;
        Ok(())
    }
    pub fn plays_batch(&self, scope: &Scope) -> Result<Vec<Play>> {
        Ok(self.db.prepare("SELECT client_play_id,track_key,listened_at FROM plays_outbox WHERE instance_id=?1 AND account_id=?2 ORDER BY listened_at,rowid LIMIT 50")?.query_map(params![scope.instance_id,scope.account_id],|r|Ok(Play {client_play_id:r.get(0)?,track_key:r.get(1)?,listened_at:r.get(2)?}))?.collect::<rusqlite::Result<_>>()?)
    }
    pub fn acknowledge_plays(&mut self, scope: &Scope, plays: &[Play]) -> Result<()> {
        let tx = self.db.transaction()?;
        for play in plays {
            tx.execute("DELETE FROM plays_outbox WHERE instance_id=?1 AND account_id=?2 AND client_play_id=?3",params![scope.instance_id,scope.account_id,play.client_play_id])?;
        }
        tx.commit()?;
        Ok(())
    }
}
