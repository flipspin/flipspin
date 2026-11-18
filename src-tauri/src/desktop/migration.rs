//! Copy the previous install before opening stores or creating any webview.
//! A durable pending marker permits retry after interruption or a locked vault.
use super::{
    credentials::{LegacyVault, OsVault, Vault, OLD_SERVICE, SERVICE},
    private_file,
};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const PENDING: &str = ".flipspin-migration-pending";
const DONE: &str = ".flipspin-migrated";

struct Completed(bool);

/// Install before the log plugin, which creates app-local data on Windows.
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("desktop-migration")
        .setup(|app, _| {
            app.manage(Completed(run(app)?));
            Ok(())
        })
        .build()
}

pub(crate) fn log_completion(app: &AppHandle) {
    if app.state::<Completed>().0 {
        log::info!("Flipspin desktop migration completed; previous data retained");
    }
}

fn run(app: &AppHandle) -> io::Result<bool> {
    let resolve = || -> tauri::Result<_> {
        Ok((
            app.path().app_data_dir()?,
            app.path().app_local_data_dir()?,
            app.path().app_cache_dir()?,
            app.path().home_dir()?,
        ))
    };
    let (data, local, cache, home) = resolve().map_err(io::Error::other)?;
    let mut roots = vec![(previous(&data)?, data.clone())];
    for destination in [local, cache] {
        if !roots.iter().any(|(_, new)| *new == destination) {
            roots.push((previous(&destination)?, destination));
        }
    }
    if cfg!(target_os = "macos") {
        // WKWebView's default persistent store is outside Tauri's app data.
        roots.push((
            home.join("Library/WebKit").join(OLD_SERVICE),
            home.join("Library/WebKit").join(SERVICE),
        ));
    }
    migrate(&roots, &LegacyVault, &OsVault).map_err(|_| {
        // Vault providers and file paths can contain private information.
        io::Error::other("Flipspin could not copy the previous desktop store. Close both apps, unlock the system keychain, check free disk space, and retry. Old data is unchanged.")
    })
}

fn previous(path: &Path) -> io::Result<PathBuf> {
    let mut old = PathBuf::new();
    let mut replaced = false;
    for component in path.components() {
        if component.as_os_str() == SERVICE {
            old.push(OLD_SERVICE);
            replaced = true;
        } else {
            old.push(component);
        }
    }
    if !replaced {
        return Err(io::Error::other("unexpected desktop data directory"));
    }
    Ok(old)
}

fn empty(path: &Path) -> io::Result<bool> {
    match fs::read_dir(path) {
        Ok(mut entries) => Ok(entries.next().transpose()?.is_none()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.is_dir() {
        // Only Unix sets a mode on the builder.
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        // Stream large offline files; create privately before writing any bytes.
        private_file::create(destination, &[])?;
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new().write(true).open(destination)?;
        io::copy(&mut input, &mut output)?;
        output.sync_all()?;
    } else {
        return Err(io::Error::other(
            "unsupported entry in previous desktop store",
        ));
    }
    Ok(())
}

fn copy_empty(source: &Path, destination: &Path, pending: bool) -> io::Result<()> {
    if !source.is_dir() || !empty(destination)? {
        return Ok(());
    }
    let stage = destination.with_extension("flipspin-copy");
    // Only this migration owns this sibling staging directory. Never touch source.
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(
        destination
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?;
    copy_tree(source, &stage)?;
    if pending {
        private_file::create(&stage.join(PENDING), b"1")?;
    }
    if destination.exists() {
        fs::remove_dir(destination)?;
    }
    fs::rename(stage, destination)
}

fn migrate(roots: &[(PathBuf, PathBuf)], old: &dyn Vault, new: &dyn Vault) -> io::Result<bool> {
    let (source, data) = &roots[0];
    if data.join(DONE).exists() {
        return Ok(false);
    }
    if !data.join(PENDING).exists() {
        if !source.is_dir() || !empty(data)? {
            return Ok(false);
        }
        copy_empty(source, data, true)?;
    }
    for (source, destination) in &roots[1..] {
        copy_empty(source, destination, false)?;
    }
    let metadata: BTreeMap<String, serde_json::Value> =
        match fs::read(data.join("credentials.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(error),
        };
    // Includes device, worker and headers:* accounts, plus the nest encryption key
    // which deliberately has no credentials.json metadata row.
    for key in metadata
        .keys()
        .map(String::as_str)
        .chain(["nest-secret-key:local"])
    {
        if let Some(value) = old.get(key)? {
            match new.get(key)? {
                Some(existing) if existing != value => {
                    return Err(io::Error::other("credential migration conflict"))
                }
                Some(_) => {}
                None => new.set(key, &value)?,
            }
            if new.get(key)?.as_deref() != Some(value.as_str()) {
                return Err(io::Error::other("credential migration verification failed"));
            }
        }
    }
    rebase_offline(&data.join("offline.sqlite"), roots)?;
    fs::rename(data.join(PENDING), data.join(DONE))?;
    Ok(true)
}

fn rebase_offline(path: &Path, roots: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let apply = || -> rusqlite::Result<()> {
        let mut db = rusqlite::Connection::open(path)?;
        let tx = db.transaction()?;
        // Table names and predicates are constants, never external SQL input.
        // Older offline schemas may not have artwork or deferred deletions yet.
        for (table, predicate) in [
            ("files", "managed=1"),
            ("art", "1"),
            ("pending_deletes", "managed=1"),
        ] {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )?;
            if !exists {
                continue;
            }
            let rows = {
                let mut query =
                    tx.prepare(&format!("SELECT rowid,path FROM {table} WHERE {predicate}"))?;
                let rows =
                    query.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (id, path) in rows {
                for (old, new) in roots {
                    if let Ok(relative) = Path::new(&path).strip_prefix(old) {
                        tx.execute(
                            &format!("UPDATE {table} SET path=?1 WHERE rowid=?2"),
                            rusqlite::params![new.join(relative).to_string_lossy(), id],
                        )?;
                        break;
                    }
                }
            }
        }
        tx.commit()
    };
    apply().map_err(io::Error::other)
}

#[cfg(test)]
mod tests;
