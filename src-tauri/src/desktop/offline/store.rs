//! Store setup, capacity policy, legacy import and scoped resolution.

use super::*;

impl Offline {
    pub fn new(app_dir: &Path, cache_dir: PathBuf) -> ShellResult<Self> {
        let pools =
            Pools::new(app_dir.join("offline"), cache_dir.join("media")).map_err(storage_error)?;
        exclude_from_backup(&pools.offline)?;
        exclude_from_backup(&pools.cache)?;
        let store = Store::open(&app_dir.join("offline.sqlite"), pools).map_err(storage_error)?;
        Ok(Self {
            store,
            queue: Queue::default(),
            pins_changed: false,
            sync: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            last_sync: None,
            wake: std::sync::Arc::new(tokio::sync::Notify::new()),
        })
    }
}

#[cfg(target_os = "macos")]
fn exclude_from_backup(path: &Path) -> ShellResult<()> {
    use objc2_foundation::{NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    // Only app-owned roots reach this call. Never flag an imported/exported folder.
    unsafe {
        url.setResourceValue_forKey_error(
            Some(&NSNumber::new_bool(true)),
            NSURLIsExcludedFromBackupKey,
        )
    }
    .map_err(storage_error)
}

#[cfg(not(target_os = "macos"))]
fn exclude_from_backup(_path: &Path) -> ShellResult<()> {
    Ok(())
}

type CapacityEntry = std::sync::Arc<std::sync::Mutex<Option<(std::time::Instant, u64)>>>;
#[derive(Default)]
struct CapacityCache {
    entries: std::sync::Mutex<std::collections::HashMap<(PathBuf, bool), CapacityEntry>>,
}
impl CapacityCache {
    fn get(
        &self,
        path: &Path,
        important: bool,
        now: std::time::Instant,
        probe: impl FnOnce() -> ShellResult<u64>,
    ) -> ShellResult<u64> {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry((path.to_path_buf(), important))
            .or_default()
            .clone();
        // Only probes for this path/policy wait for one another. The global map
        // and offline store are free throughout the operating-system call.
        let mut value = entry.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, bytes)) = *value {
            if now.saturating_duration_since(at) < Duration::from_secs(30) {
                return Ok(bytes);
            }
        }
        let bytes = probe()?;
        *value = Some((now, bytes));
        Ok(bytes)
    }
}
/// The shell runs these probes on blocking threads; concurrent misses share one
/// probe per path/policy, and successful values last thirty seconds.
pub(in crate::desktop) fn available_capacity(path: &Path, important: bool) -> ShellResult<u64> {
    static CACHE: std::sync::OnceLock<CapacityCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(CapacityCache::default).get(
        path,
        important,
        std::time::Instant::now(),
        || query_capacity(path, important),
    )
}

/// OS capacity probes may block for seconds; keep Tokio's media workers free.
pub(in crate::desktop) async fn capacity_async(
    path: PathBuf,
    important: bool,
    capacity: fn(&Path, bool) -> ShellResult<u64>,
) -> ShellResult<u64> {
    tauri::async_runtime::spawn_blocking(move || capacity(&path, important))
        .await
        .map_err(storage_error)?
}

#[cfg(target_os = "macos")]
fn query_capacity(path: &Path, important: bool) -> ShellResult<u64> {
    use objc2_foundation::{
        NSNumber, NSString, NSURLVolumeAvailableCapacityForImportantUsageKey,
        NSURLVolumeAvailableCapacityForOpportunisticUsageKey, NSURL,
    };
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let mut value = None;
    let key = unsafe {
        if important {
            NSURLVolumeAvailableCapacityForImportantUsageKey
        } else {
            NSURLVolumeAvailableCapacityForOpportunisticUsageKey
        }
    };
    unsafe { url.getResourceValue_forKey_error(&mut value, key) }.map_err(storage_error)?;
    value
        .as_ref()
        .and_then(|v| v.downcast_ref::<NSNumber>())
        .map(|n| n.unsignedLongLongValue())
        .ok_or(ShellError::Guard("capacity-unavailable"))
}

#[cfg(not(target_os = "macos"))]
fn query_capacity(path: &Path, _important: bool) -> ShellResult<u64> {
    Ok(fs2::available_space(path)?)
}

pub(super) fn import_legacy(
    state: &DesktopState,
    scope: &Scope,
    origin: &str,
) -> ShellResult<bool> {
    let source = format!("device-downloads.json:{origin}");
    if lock_store(state, "legacy::check")?
        .store
        .imported(scope, &source)
        .map_err(storage_error)?
    {
        return Ok(false);
    }
    let before = lock_store(state, "legacy::pins-before")?
        .store
        .pin_count(scope)
        .map_err(storage_error)?;
    let manifest: BTreeMap<String, String> =
        read_json(&state.app_dir.join("device-downloads.json"));
    let prefix = format!("{}\n", origin.trim_end_matches('/'));
    for unscoped in [false, true] {
        let source = if unscoped {
            "device-downloads.json:unscoped".to_owned()
        } else {
            source.clone()
        };
        let songs = manifest
            .iter()
            .filter_map(|(key, path)| {
                let media = if unscoped {
                    key.starts_with("/api/media/").then_some(key.as_str())?
                } else {
                    key.strip_prefix(&prefix)?
                };
                Some((key_from_media(media)?, path.clone()))
            })
            .collect::<Vec<_>>();
        let prepared = krobi_offline::pins::prepare_import_songs(&songs).map_err(storage_error)?;
        // Import does its own one-time grant check. Empty imports are marked too.
        lock_store(state, "legacy::import")?
            .store
            .import_prepared_songs(scope, &source, &prepared)
            .map_err(storage_error)?;
    }
    Ok(lock_store(state, "legacy::pins-after")?
        .store
        .pin_count(scope)
        .map_err(storage_error)?
        != before)
}

pub(in crate::desktop) fn enforce_cache_budget(
    state: &DesktopState,
    budget: u64,
    scope: Option<&Scope>,
) -> ShellResult<bool> {
    let scopes = if let Some(scope) = scope {
        vec![scope.clone()]
    } else {
        lock_store(state, "evict::scopes")?
            .store
            .cache_scopes()
            .map_err(storage_error)?
    };
    let mut entries = Vec::new();
    for scope in scopes {
        let files = lock_store(state, "evict::snapshot")?
            .store
            .files(&scope)
            .map_err(storage_error)?;
        for file in files.into_iter().filter(|f| f.pool == "cache") {
            let bytes = file.bytes.saturating_add(
                std::fs::metadata(file.path.with_extension("part"))
                    .map(|m| m.len())
                    .unwrap_or(0),
            );
            entries.push((scope.clone(), file, bytes));
        }
    }
    entries.sort_by_key(|(_, file, _)| file.last_played_at.unwrap_or(0));
    let mut total = entries.iter().map(|(_, _, bytes)| bytes).sum::<u64>();
    let mut changed = false;
    for (scope, file, bytes) in entries {
        if total <= budget {
            break;
        }
        if lock_store(state, "evict::candidate")?
            .store
            .evict_cached_file(&scope, &file.key)
            .map_err(storage_error)?
        {
            total = total.saturating_sub(bytes);
            changed = true;
        }
    }
    Ok(changed)
}

#[cfg(test)]
pub(in crate::desktop) fn test_store() -> Offline {
    // A counter, not only the clock: tests run in parallel and two stores
    // created in the same millisecond must never share one SQLite file.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "krobi-offline-test-{}-{}-{}",
        std::process::id(),
        timestamp(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let pools = Pools::new(path.join("offline"), path.join("cache")).unwrap();
    Offline {
        store: Store::open(&path.join("offline.sqlite"), pools).unwrap(),
        queue: Queue::default(),
        pins_changed: false,
        sync: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        last_sync: None,
        wake: std::sync::Arc::new(tokio::sync::Notify::new()),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;
    fn excluded(path: &Path) -> bool {
        // NSURL's getter reports false in this host even with the persisted
        // backup marker present. Check what the setter wrote on disk.
        let result = std::process::Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.metadata:com_apple_backup_excludeItem"])
            .arg(path)
            .output()
            .unwrap();
        result.status.success()
            && result
                .stdout
                .windows(b"com.apple.backupd".len())
                .any(|v| v == b"com.apple.backupd")
    }
    #[test]
    fn app_pools_are_excluded_from_backup_without_flagging_chosen_folders() {
        let dir = std::env::current_dir()
            .unwrap()
            .join(format!(".krobi-backup-test-{}", timestamp()));
        let chosen = dir.join("chosen");
        std::fs::create_dir_all(&chosen).unwrap();
        let before = excluded(&chosen);
        let o = Offline::new(&dir.join("app"), dir.join("cache")).unwrap();
        assert!(excluded(&o.store.pools.offline));
        assert!(excluded(&o.store.pools.cache));
        assert_eq!(excluded(&chosen), before);
        drop(o);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod capacity_tests {
    use super::*;
    #[test]
    fn capacity_is_cached_for_30_seconds_per_path_and_policy() {
        let cache = CapacityCache::default();
        let now = std::time::Instant::now();
        let path = Path::new("cache-volume");
        assert_eq!(cache.get(path, false, now, || Ok(10)).unwrap(), 10);
        assert_eq!(
            cache
                .get(path, false, now + Duration::from_secs(29), || panic!(
                    "capacity queried before expiry"
                ))
                .unwrap(),
            10
        );
        assert_eq!(
            cache
                .get(path, false, now + Duration::from_secs(30), || Ok(20))
                .unwrap(),
            20
        );
        assert_eq!(cache.get(path, true, now, || Ok(30)).unwrap(), 30);
        assert_eq!(
            cache
                .get(Path::new("other-volume"), false, now, || Ok(40))
                .unwrap(),
            40
        );
    }
}
