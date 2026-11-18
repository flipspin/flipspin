//! Default server/helper data paths. Resolution has no filesystem side effects.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[allow(clippy::disallowed_methods)] // This module owns server data-root resolution.
pub(crate) fn data_root() -> Result<PathBuf, String> {
    static ROOT: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        let home = dirs::home_dir().ok_or("Cannot resolve the home directory")?;
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "win32"
        } else {
            "linux"
        };
        resolve(None, &std::env::vars().collect(), &home, platform).map(|(path, _)| path)
    })
    .clone()
}

// Display-only home abbreviation for upload review; never a state path.
#[allow(clippy::disallowed_methods)]
pub(crate) fn user_home_for_display() -> Option<PathBuf> {
    dirs::home_dir()
}

fn absolute(value: &str, home: &Path) -> PathBuf {
    let path = if value == "~" {
        home.to_path_buf()
    } else if value.starts_with("~/") || value.starts_with("~\\") {
        home.join(&value[2..])
    } else {
        PathBuf::from(value)
    };
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

fn resolve(
    flag: Option<&str>,
    env: &HashMap<String, String>,
    home: &Path,
    platform: &str,
) -> Result<(PathBuf, &'static str), String> {
    if let Some(flag) = flag {
        return Ok((absolute(flag, home), "--data-dir"));
    }
    let primary = env.get("FLIPSPIN_DATA_DIR").filter(|s| !s.is_empty());
    let alias = env.get("KROBI_DATA_DIR").filter(|s| !s.is_empty());
    if let (Some(primary), Some(alias)) = (primary, alias) {
        if absolute(primary, home) != absolute(alias, home) {
            return Err(
                "FLIPSPIN_DATA_DIR and KROBI_DATA_DIR differ; set one root or matching values"
                    .into(),
            );
        }
    }
    if let Some(primary) = primary {
        return Ok((absolute(primary, home), "FLIPSPIN_DATA_DIR"));
    }
    if let Some(alias) = alias {
        return Ok((absolute(alias, home), "KROBI_DATA_DIR"));
    }
    let legacy = home.join("Krobi");
    // A helper-only computer holds just its engine (tools, models) and settings.
    if ["users.json", "instance.json", "jobs.sqlite", ".env"]
        .iter()
        .any(|name| legacy.join(name).is_file())
        || ["playlists", "tools", "models"]
            .iter()
            .any(|name| legacy.join(name).is_dir())
    {
        return Ok((legacy, "legacy data"));
    }
    let path = match platform {
        "darwin" => home.join("Library/Application Support/Flipspin"),
        "win32" => env
            .get("LOCALAPPDATA")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("Flipspin"),
        _ => env
            .get("XDG_DATA_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("flipspin"),
    };
    Ok((path, "OS default"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_data_root_contract() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/data-root.json")).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("home");
            std::fs::create_dir(&home).unwrap();
            let expand = |value: &str| {
                value
                    .replace("$HOME", &home.to_string_lossy())
                    .replace("$CASE", &temp.path().to_string_lossy())
            };
            for entry in case["legacy"].as_array().unwrap() {
                let entry = entry.as_str().unwrap();
                let path = home.join("Krobi").join(entry);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                if entry.ends_with('/') {
                    std::fs::create_dir_all(path).unwrap();
                } else {
                    std::fs::write(path, "").unwrap();
                }
            }
            let env = case["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), expand(value.as_str().unwrap())))
                .collect();
            let flag = case["flag"].as_str().map(expand);
            let result = resolve(
                flag.as_deref(),
                &env,
                &home,
                case["platform"].as_str().unwrap(),
            );
            if let Some(error) = case["error"].as_str() {
                assert!(result.unwrap_err().contains(error), "{}", case["id"]);
            } else {
                let (path, source) = result.unwrap();
                assert_eq!(
                    path,
                    std::path::absolute(expand(case["expected"].as_str().unwrap())).unwrap(),
                    "{}",
                    case["id"]
                );
                assert_eq!(source, case["source"].as_str().unwrap());
            }
        }
    }
}
