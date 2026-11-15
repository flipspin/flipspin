use crate::{
    store::{Scope, Store, DOWNLOADED, MISSING, QUEUED, STALE},
    Result,
};
use std::{fs, path::PathBuf};
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution {
    Local(PathBuf),
    Cache(PathBuf),
    Remote,
    Unavailable,
}
/// Only unreachable is offline. Authentication and identity failures aren't network verdicts.
pub fn is_offline(connection: &str) -> bool {
    connection == "unreachable"
}
impl Store {
    pub fn resolve(&mut self, scope: &Scope, key: &str, offline: bool) -> Result<Resolution> {
        for pool in ["offline", "cache"] {
            if let Some(file) = self.file(scope, key, pool)? {
                if file.verified_at.is_some()
                    && matches!(file.state.as_str(), DOWNLOADED | STALE | MISSING)
                {
                    if fs::metadata(&file.path).is_ok_and(|m| m.is_file() && m.len() == file.bytes)
                    {
                        return Ok(if pool == "offline" {
                            Resolution::Local(file.path)
                        } else {
                            Resolution::Cache(file.path)
                        });
                    }
                    self.set_state(scope, key, pool, QUEUED, Some("local-file-missing"))?;
                    self.db.execute("UPDATE files SET verified_at=NULL,bytes=0 WHERE instance_id=?1 AND account_id=?2 AND track_key=?3 AND pool=?4",rusqlite::params![scope.instance_id,scope.account_id,key,pool])?;
                }
            }
        }
        Ok(if offline {
            Resolution::Unavailable
        } else {
            Resolution::Remote
        })
    }
}

#[derive(Debug)]
pub enum ArtResolution {
    Local(crate::store::ArtRecord),
    Missing,
    Remote,
    Unavailable,
}
impl Store {
    pub fn resolve_art(
        &self,
        scope: &Scope,
        media_path: &str,
        offline: bool,
    ) -> Result<ArtResolution> {
        if let Some(art) = self.art(scope, media_path)? {
            // A remembered "no cover" answers 404 only offline; online the nest
            // decides, so a cover added later shows at once.
            if art.state == MISSING {
                return Ok(if offline {
                    ArtResolution::Missing
                } else {
                    ArtResolution::Remote
                });
            }
            if art.verified_at.is_some()
                && art.state == DOWNLOADED
                && self.pools.contains(&art.path)
                && fs::metadata(&art.path).is_ok_and(|m| m.is_file() && m.len() == art.bytes)
            {
                return Ok(ArtResolution::Local(art));
            }
        }
        Ok(if offline {
            ArtResolution::Unavailable
        } else {
            ArtResolution::Remote
        })
    }
}
