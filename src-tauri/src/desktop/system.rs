//! Native pickers and `open`.

use super::{offline, DesktopState};
use crate::error::{ShellError, ShellResult};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use url::Url;

#[tauri::command]
pub fn select_base_dir() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_external(url: String) -> Value {
    let allowed = Url::parse(&url)
        .ok()
        .is_some_and(|parsed| matches!(parsed.scheme(), "http" | "https"));
    if !allowed {
        return json!({"ok": false, "error": "blocked-non-http-url"});
    }
    match open::that(url) {
        Ok(()) => json!({"ok": true}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

#[tauri::command]
pub fn open_path(state: tauri::State<'_, DesktopState>, path: String) -> ShellResult<()> {
    let roots = {
        let offline = offline::lock_store(&state, "open-path::roots")?;
        vec![
            state.app_dir.clone(),
            offline.store.pools.offline.clone(),
            offline.store.pools.cache.clone(),
        ]
    };
    let target = guarded_path(&path, &roots)?;
    open::that(target).map_err(ShellError::from)
}

/// Only absolute, existing local paths within native-owned roots reach the OS.
/// Pass the canonical path to the opener, never the renderer's original string.
fn guarded_path(value: &str, roots: &[PathBuf]) -> ShellResult<PathBuf> {
    let path = Path::new(value);
    // Reject UNC/device paths too: an OS network share is not a local download.
    let drive_path = cfg!(windows)
        && value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && !value[2..].contains(':');
    if value.chars().any(char::is_control)
        || value.starts_with(['\\'])
        || value.starts_with("//")
        || !path.is_absolute()
        || (!drive_path && Url::parse(value).is_ok())
    {
        return Err(ShellError::Guard("blocked-local-path"));
    }
    let target = path
        .canonicalize()
        .map_err(|_| ShellError::Guard("missing-local-path"))?;
    if !target.is_file() && !target.is_dir() {
        return Err(ShellError::Guard("blocked-local-path"));
    }
    if !roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| target.starts_with(root))
    {
        return Err(ShellError::Guard("path-outside-app-directories"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_path_refuses_urls_missing_relative_and_outside_paths() {
        let temp = std::env::temp_dir().join(format!("krobi-open-path-{}", rand::random::<u64>()));
        let root = temp.join("downloads");
        std::fs::create_dir_all(&root).unwrap();
        let song = root.join("song.mp3");
        let outside = temp.join("outside.mp3");
        let sibling = temp.join("downloads-other");
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::write(&song, b"audio").unwrap();
        std::fs::write(&outside, b"outside").unwrap();
        let roots = vec![root.clone()];
        assert_eq!(
            guarded_path(song.to_str().unwrap(), &roots).unwrap(),
            song.canonicalize().unwrap()
        );
        assert_eq!(
            guarded_path(root.to_str().unwrap(), &roots).unwrap(),
            root.canonicalize().unwrap()
        );
        for value in [
            "https://example.test",
            "file:///tmp/song.mp3",
            "mailto:test@example.test",
            "krobi-media://localhost/song",
            "javascript:alert(1)",
            "relative.mp3",
            "../song.mp3",
            "//server/share/song",
            r"\\server\share\song",
            "",
            "song\n.mp3",
        ] {
            assert!(guarded_path(value, &roots).is_err(), "accepted {value:?}");
        }
        for path in [
            outside.clone(),
            sibling,
            root.join("missing.mp3"),
            root.join("../outside.mp3"),
        ] {
            assert!(
                guarded_path(path.to_str().unwrap(), &roots).is_err(),
                "accepted {path:?}"
            );
        }
        #[cfg(unix)]
        {
            let link = root.join("escape.mp3");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(guarded_path(link.to_str().unwrap(), &roots).is_err());
            let directory = root.join("escape-dir");
            std::os::unix::fs::symlink(&temp, &directory).unwrap();
            assert!(guarded_path(directory.join("outside.mp3").to_str().unwrap(), &roots).is_err());
        }
        std::fs::remove_dir_all(temp).unwrap();
    }
}
