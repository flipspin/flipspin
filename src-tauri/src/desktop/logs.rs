//! Local log access accepts source keys, never renderer-supplied paths.
use super::*;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy)]
enum Source {
    Desktop,
    Helper,
}
impl Source {
    fn parse(name: &str) -> ShellResult<Self> {
        match name {
            "desktop" => Ok(Self::Desktop),
            "helper" => Ok(Self::Helper),
            _ => Err(ShellError::Guard("unknown-log-source")),
        }
    }
    fn path(self, desktop: &Path, home: &Path) -> PathBuf {
        match self {
            Self::Desktop => desktop.join("KROBI.log"),
            Self::Helper => home.join("Krobi/logs/helper-agent.log"),
        }
    }
}
fn source_path(app: &AppHandle, request: Option<&Value>) -> ShellResult<PathBuf> {
    let source = Source::parse(request.and_then(|r| r["source"].as_str()).unwrap_or(""))?;
    Ok(source.path(&app.path().app_log_dir()?, &app.path().home_dir()?))
}
// Older installations use this exact relative link during helper log migration.
fn legacy_helper_link(path: &Path) -> Option<PathBuf> {
    if path.file_name()? != "helper-agent.log"
        || fs::read_link(path).ok()? != Path::new("lyrics-agent.log")
    {
        return None;
    }
    let legacy = path.with_file_name("lyrics-agent.log");
    fs::symlink_metadata(&legacy)
        .ok()?
        .file_type()
        .is_file()
        .then_some(legacy)
}
fn tail(path: &Path, limit: usize, query: &str) -> ShellResult<Value> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => metadata,
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return match legacy_helper_link(path) {
                Some(legacy) => tail(&legacy, limit, query),
                None => Err(ShellError::Guard("invalid-log-file")),
            };
        }
        Ok(_) => return Err(ShellError::Guard("invalid-log-file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(
                json!({"path": "", "lines": [], "sizeBytes": 0, "scanned": 0, "matched": 0, "truncated": false}),
            )
        }
        Err(error) => return Err(error.into()),
    };
    let mut file = fs::File::open(path)?;
    let size = metadata.len();
    // Bound reads even if an external helper writes a huge unrotated file.
    let start = size.saturating_sub(5 * 1024 * 1024);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(5 * 1024 * 1024).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<_> = text.lines().skip(usize::from(start > 0)).collect();
    let limit = limit.clamp(1, 2000);
    let offset = all.len().saturating_sub(limit);
    let scanned = all.len() - offset;
    let query = query.to_lowercase();
    let lines: Vec<_> = all[offset..]
        .iter()
        .filter(|line| line.to_lowercase().contains(&query))
        .copied()
        .collect();
    Ok(
        json!({"path": "", "sizeBytes": size, "scanned": scanned, "matched": lines.len(), "lines": lines, "truncated": start > 0 || offset > 0}),
    )
}
pub(super) fn sources(app: &AppHandle) -> ShellResult<Value> {
    let helper = Source::Helper.path(&app.path().app_log_dir()?, &app.path().home_dir()?);
    Ok(
        json!({"helper": fs::symlink_metadata(&helper).is_ok_and(|m| m.file_type().is_file()) || legacy_helper_link(&helper).is_some()}),
    )
}
pub(super) async fn read(app: &AppHandle, request: Option<&Value>) -> ShellResult<Value> {
    let path = source_path(app, request)?;
    let limit = request
        .and_then(|r| r["lines"].as_u64())
        .unwrap_or(2000)
        .min(2000) as usize;
    let query = request
        .and_then(|r| r["q"].as_str())
        .unwrap_or("")
        .to_owned();
    tauri::async_runtime::spawn_blocking(move || tail(&path, limit, &query)).await?
}
fn clear_file(path: &Path) -> ShellResult<u64> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return match legacy_helper_link(path) {
            Some(legacy) => clear_file(&legacy),
            None => Err(ShellError::Guard("invalid-log-file")),
        };
    }
    if !metadata.file_type().is_file() {
        return Err(ShellError::Guard("invalid-log-file"));
    }
    let file = fs::OpenOptions::new().write(true).open(path)?;
    let cleared = file.metadata()?.len();
    file.set_len(0)?;
    Ok(cleared)
}
fn clear_source(name: &str, desktop: &Path, home: &Path) -> ShellResult<Value> {
    let path = Source::parse(name)?.path(desktop, home);
    Ok(json!({"source": name, "clearedBytes": clear_file(&path)?}))
}
pub(super) async fn clear(app: &AppHandle, request: Option<&Value>) -> ShellResult<Value> {
    let source = request
        .and_then(|r| r["source"].as_str())
        .unwrap_or("")
        .to_owned();
    let desktop = app.path().app_log_dir()?;
    let home = app.path().home_dir()?;
    tauri::async_runtime::spawn_blocking(move || clear_source(&source, &desktop, &home)).await?
}
pub(super) fn open_folder(app: &AppHandle, request: Option<&Value>) -> ShellResult<Value> {
    let path = source_path(app, request)?;
    let dir = path
        .parent()
        .ok_or(ShellError::Guard("invalid-log-source"))?;
    open::that(dir)?;
    Ok(json!({"ok": true}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clear_truncates_only_allowlisted_current_files_and_keeps_open_writers() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("krobi-clear-log-{}", rand::random::<u64>()));
        fs::create_dir_all(dir.join("Krobi/logs")).unwrap();
        let desktop = dir.join("KROBI.log");
        let helper = dir.join("Krobi/logs/helper-agent.log");
        let backup = dir.join("KROBI.log.1");
        fs::write(&desktop, "desktop\n").unwrap();
        fs::write(&helper, "helper\n").unwrap();
        fs::write(&backup, "backup\n").unwrap();
        for source in ["", "../KROBI.log", "KROBI.log.1", "app", "errors"] {
            assert!(clear_source(source, &dir, &dir).is_err());
        }
        assert_eq!(fs::read_to_string(&desktop).unwrap(), "desktop\n");
        let mut writer = fs::OpenOptions::new().append(true).open(&desktop).unwrap();
        assert_eq!(
            clear_source("desktop", &dir, &dir).unwrap()["clearedBytes"],
            8
        );
        assert_eq!(fs::metadata(&desktop).unwrap().len(), 0);
        assert_eq!(fs::read_to_string(&helper).unwrap(), "helper\n");
        writer.write_all(b"still writing\n").unwrap();
        assert_eq!(fs::read_to_string(&desktop).unwrap(), "still writing\n");
        assert_eq!(
            clear_source("helper", &dir, &dir).unwrap()["clearedBytes"],
            7
        );
        assert_eq!(fs::metadata(&helper).unwrap().len(), 0);
        assert_eq!(fs::read_to_string(&backup).unwrap(), "backup\n");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn only_source_keys_can_choose_a_file_or_folder() {
        for name in [
            "",
            "../KROBI.log",
            "/tmp/private",
            "desktop/../helper",
            "KROBI.log",
            "helper-agent.log",
        ] {
            assert!(Source::parse(name).is_err());
        }
        assert_eq!(
            Source::parse("desktop")
                .unwrap()
                .path(Path::new("logs"), Path::new("home")),
            Path::new("logs/KROBI.log")
        );
        assert_eq!(
            Source::parse("helper")
                .unwrap()
                .path(Path::new("logs"), Path::new("home")),
            Path::new("home/Krobi/logs/helper-agent.log")
        );
    }
    #[test]
    fn tails_then_searches_and_bounds_the_window() {
        let path = std::env::temp_dir().join(format!("krobi-log-test-{}", rand::random::<u64>()));
        fs::write(&path, "old\nINFO one\nERROR two\nINFO THREE\n").unwrap();
        let page = tail(&path, 3, "info").unwrap();
        assert_eq!(page["lines"], json!(["INFO one", "INFO THREE"]));
        assert_eq!(page["scanned"], 3);
        assert_eq!(page["truncated"], true);
        fs::remove_file(&path).unwrap();
        assert_eq!(tail(&path, 2000, "").unwrap()["lines"], json!([]));
    }
    #[cfg(unix)]
    #[test]
    fn reads_the_fixed_legacy_helper_link_but_not_a_link_to_another_file() {
        let dir = std::env::temp_dir().join(format!("krobi-helper-log-{}", rand::random::<u64>()));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("lyrics-agent.log"), "helper connected\n").unwrap();
        let path = dir.join("helper-agent.log");
        std::os::unix::fs::symlink("lyrics-agent.log", &path).unwrap();
        assert_eq!(
            tail(&path, 20, "").unwrap()["lines"],
            json!(["helper connected"])
        );
        assert_eq!(clear_file(&path).unwrap(), 17);
        assert_eq!(fs::metadata(dir.join("lyrics-agent.log")).unwrap().len(), 0);
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", &path).unwrap();
        assert!(tail(&path, 20, "").is_err());
        assert!(clear_file(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_files() {
        let path = std::env::temp_dir().join(format!("krobi-log-link-{}", rand::random::<u64>()));
        std::os::unix::fs::symlink("/etc/hosts", &path).unwrap();
        assert!(tail(&path, 20, "").is_err());
        assert!(clear_file(&path).is_err());
        fs::remove_file(path).unwrap();
    }
}
