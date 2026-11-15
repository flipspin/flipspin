use crate::Result;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Pools {
    pub offline: PathBuf,
    pub cache: PathBuf,
}
impl Pools {
    pub fn new(offline: PathBuf, cache: PathBuf) -> Result<Self> {
        fs::create_dir_all(&offline)?;
        fs::create_dir_all(&cache)?;
        Ok(Self {
            offline: offline.canonicalize()?,
            cache: cache.canonicalize()?,
        })
    }
    /// Canonicalisation also blocks symlinks escaping a pool.
    pub fn contains(&self, path: &Path) -> bool {
        path.canonicalize()
            .is_ok_and(|p| p.starts_with(&self.offline) || p.starts_with(&self.cache))
    }
    pub fn path(&self, pool: &str, id: i64) -> PathBuf {
        let root = if pool == "offline" {
            &self.offline
        } else {
            &self.cache
        };
        root.join(format!("{id}.audio"))
    }
}
pub fn cache_budget(free_bytes: u64) -> u64 {
    (free_bytes / 10).clamp(50 * 1024 * 1024, 10 * 1024 * 1024 * 1024)
}
