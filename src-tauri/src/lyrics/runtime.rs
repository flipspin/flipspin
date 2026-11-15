//! Helper paths, bundled source discovery and managed process environment.

use super::*;

pub(crate) fn krobi_home() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join("Krobi")
}

pub(super) fn tools_dir() -> PathBuf {
    let root = std::env::var_os("KROBI_TOOLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| krobi_home().join("tools"));
    helper_tools(&root).unwrap_or_else(|error| {
        log::warn!("helper directory migration failed: {error}");
        root.join("helper")
    })
}

/// Alias the directory rather than moving a venv with absolute launchers.
/// This preserves the lock inode, worker identity and installed dependencies.
fn helper_tools(root: &std::path::Path) -> std::io::Result<PathBuf> {
    let helper = root.join("helper");
    let legacy = root.join("lyrics");
    if legacy.is_dir() && !helper.exists() {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink("lyrics", &helper);
        #[cfg(windows)]
        let result = Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&helper)
            .arg(legacy.canonicalize()?)
            .output()
            .and_then(|output| {
                if output.status.success() || helper.is_dir() {
                    Ok(())
                } else {
                    Err(std::io::Error::other(
                        String::from_utf8_lossy(&output.stderr).to_string(),
                    ))
                }
            });
        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
    }
    Ok(helper)
}

pub(super) fn agent_log(log_dir: &std::path::Path) -> std::io::Result<PathBuf> {
    fs::create_dir_all(log_dir)?;
    let current = log_dir.join("helper-agent.log");
    let legacy = log_dir.join("lyrics-agent.log");
    if legacy.is_file() && !current.exists() {
        #[cfg(unix)]
        std::os::unix::fs::symlink("lyrics-agent.log", &current)?;
        #[cfg(windows)]
        fs::hard_link(&legacy, &current)?;
    }
    if !legacy.exists() {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&current)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink("helper-agent.log", &legacy)?;
        #[cfg(windows)]
        fs::hard_link(&current, &legacy)?;
    }
    if fs::metadata(&current)?.len() > AGENT_LOG_MAX_BYTES {
        let first = log_dir.join("helper-agent.log.1");
        let second = log_dir.join("helper-agent.log.2");
        match fs::remove_file(&second) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        if first.exists() {
            fs::rename(&first, &second)?;
        }
        fs::rename(current.canonicalize()?, &first)?;
        // Windows uses hard links for the legacy alias. Recreate that link
        // against the new active file rather than leaving it on the archive.
        #[cfg(windows)]
        fs::remove_file(log_dir.join("lyrics-agent.log"))?;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current)?;
    #[cfg(windows)]
    if !log_dir.join("lyrics-agent.log").exists() {
        fs::hard_link(&current, log_dir.join("lyrics-agent.log"))?;
    }
    Ok(current)
}

const AGENT_LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;

pub(super) fn venv_dir() -> PathBuf {
    tools_dir().join("venv")
}

pub(super) fn venv_executable(name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        venv_dir().join("Scripts").join(format!("{name}.exe"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        venv_dir().join("bin").join(name)
    }
}

pub(super) fn binary() -> PathBuf {
    let current = venv_executable("krobi-helper");
    let legacy = venv_executable("krobi-lyrics");
    if current.is_file() || !legacy.is_file() {
        current
    } else {
        legacy
    }
}

fn uv_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    }
}

pub(crate) fn supported() -> bool {
    cfg!(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        )
    ))
}

/// Base wheel/source followed by optional plugin packages, installed together.
static BUNDLED_FFMPEG: OnceLock<PathBuf> = OnceLock::new();

pub(super) fn worker_sources(app: &AppHandle) -> Vec<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let executable = if cfg!(target_os = "windows") {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let path = resources.join("backend/ffmpeg").join(executable);
        if path.is_file() {
            let _ = BUNDLED_FFMPEG.set(path);
        }
    }
    // Retain the positive lookup cache: status runs on every progress event.
    static FOUND: OnceLock<Vec<PathBuf>> = OnceLock::new();
    let mut sources = FOUND.get().cloned().unwrap_or_else(|| {
        let found = worker_sources_uncached(app);
        if !found.is_empty() {
            let _ = FOUND.set(found.clone());
        }
        found
    });
    if !sources.is_empty() {
        if let Some(extra) = std::env::var_os("KROBI_LYRICS_PLUGIN_SOURCES") {
            sources.extend(std::env::split_paths(&extra).filter(|p| !p.as_os_str().is_empty()));
        }
    }
    sources
}

fn bundled_worker_sources(bundled: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(bundled) else {
        return Vec::new();
    };
    let mut wheels: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "whl").unwrap_or(false))
        .collect();
    wheels.sort();
    let is_base = |p: &PathBuf| {
        p.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("krobi_helper-")
    };
    let Some(base) = wheels.iter().rfind(|p| is_base(p)).cloned() else {
        return Vec::new();
    };
    let mut sources = vec![base];
    sources.extend(wheels.into_iter().filter(|p| !is_base(p)));
    sources
}

fn development_sources(path: PathBuf) -> Vec<PathBuf> {
    let compat = path.join("compat");
    let mut sources = vec![path];
    if compat.join("pyproject.toml").is_file() {
        sources.push(compat);
    }
    sources
}

fn worker_sources_uncached(app: &AppHandle) -> Vec<PathBuf> {
    for name in ["KROBI_HELPER_SRC", "KROBI_LYRICS_WORKER_SRC"] {
        if let Ok(env) = std::env::var(name) {
            let path = PathBuf::from(env);
            if path.exists() {
                return development_sources(path);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let backend = resource_dir.join("backend");
        let mut sources = bundled_worker_sources(&backend.join("helper-worker"));
        if !sources.is_empty() {
            // Existing lab build scripts still stage plugin wheels here.
            if let Ok(entries) = fs::read_dir(backend.join("lyrics-worker")) {
                let mut plugins: Vec<_> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        let name = p.file_name().unwrap_or_default().to_string_lossy();
                        name.ends_with(".whl")
                            && !name.starts_with("krobi_lyrics-")
                            && !name.starts_with("krobi_helper-")
                            && !sources
                                .iter()
                                .any(|source| source.file_name() == p.file_name())
                    })
                    .collect();
                plugins.sort();
                sources.extend(plugins);
            }
            return sources;
        }
    }
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("helper");
        if repo.join("pyproject.toml").exists() {
            return development_sources(repo);
        }
    }
    Vec::new()
}

pub(crate) fn find_uv(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("backend/bin").join(uv_name());
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if cfg!(debug_assertions) {
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/backend/bin")
            .join(uv_name());
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    // A positive answer is cached: the lookup walks every PATH entry, and it
    // ran on every progress tick of a model download. A miss is retried, so
    // installing uv mid-session is still noticed.
    static FOUND: OnceLock<PathBuf> = OnceLock::new();
    if let Some(found) = FOUND.get() {
        return Some(found.clone());
    }
    let found = find_uv_uncached()?;
    let _ = FOUND.set(found.clone());
    Some(found)
}

fn find_uv_uncached() -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/uv"),
        PathBuf::from("/usr/local/bin/uv"),
        home.join(".local/bin").join(uv_name()),
        home.join(".cargo/bin").join(uv_name()),
    ];
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(uv_name());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Models beside the other state, and Homebrew on PATH for ffmpeg — the same
/// environment the backend's `engine.py` builds.
pub(super) fn engine_env(command: &mut Command) {
    let models = krobi_home().join("models");
    command.env("HF_HOME", models.join("hf"));
    command.env("TORCH_HOME", models.join("torch"));
    command.env("PYTHONUNBUFFERED", "1");
    if std::env::var_os("KROBI_FFMPEG_PATH").is_none() {
        if let Some(ffmpeg) = BUNDLED_FFMPEG.get() {
            command.env("KROBI_FFMPEG_PATH", ffmpeg);
        }
    }
    command.env("HF_HUB_DISABLE_PROGRESS_BARS", "1");
    command.env("HF_HUB_DISABLE_TELEMETRY", "1");
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        command.env("PATH", joined);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_install_alias_preserves_venv_lock_and_models() {
        let root = std::env::temp_dir().join(format!(
            "krobi-helper-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tools = root.join("tools");
        let legacy = tools.join("lyrics");
        fs::create_dir_all(legacy.join("venv/bin")).unwrap();
        fs::create_dir_all(root.join("models")).unwrap();
        fs::write(
            legacy.join("venv/bin/krobi-lyrics"),
            "old absolute launcher",
        )
        .unwrap();
        fs::write(legacy.join("agent.lock"), "12345").unwrap();
        fs::write(legacy.join("worker-id"), "same-helper").unwrap();
        let model = root.join("models/cached-model");
        fs::write(&model, "cached model").unwrap();
        let before = fs::metadata(&model).unwrap().modified().unwrap();
        let helper = helper_tools(&tools).unwrap();
        assert_eq!(helper, tools.join("helper"));
        assert_eq!(
            helper.canonicalize().unwrap(),
            legacy.canonicalize().unwrap()
        );
        assert_eq!(
            fs::read_to_string(helper.join("agent.lock")).unwrap(),
            "12345"
        );
        assert_eq!(
            helper.join("agent.lock").canonicalize().unwrap(),
            legacy.join("agent.lock").canonicalize().unwrap()
        );
        fs::write(helper.join("venv/bin/krobi-helper"), "upgraded launcher").unwrap();
        assert!(legacy.join("venv/bin/krobi-helper").is_file());
        assert_eq!(helper_tools(&tools).unwrap(), helper);
        assert_eq!(fs::read_to_string(&model).unwrap(), "cached model");
        assert_eq!(fs::metadata(&model).unwrap().modified().unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agent_log_rotates_above_two_mib_and_keeps_two_archives() {
        use std::io::Write;
        for legacy_install in [false, true] {
            let root = std::env::temp_dir().join(format!(
                "krobi-log-rotation-{}-{}-{legacy_install}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            let original = root.join(if legacy_install {
                "lyrics-agent.log"
            } else {
                "helper-agent.log"
            });
            let current = root.join("helper-agent.log");
            let first = root.join("helper-agent.log.1");
            let second = root.join("helper-agent.log.2");
            fs::write(&original, "at limit").unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(&original)
                .unwrap()
                .set_len(2 * 1024 * 1024)
                .unwrap();
            assert_eq!(agent_log(&root).unwrap(), current);
            assert!(!first.exists(), "exactly 2 MiB must stay active");
            for generation in 1..=4 {
                let mut log = fs::OpenOptions::new().append(true).open(&current).unwrap();
                writeln!(log, "generation {generation}").unwrap();
                drop(log);
                assert_eq!(agent_log(&root).unwrap(), current);
                assert_eq!(fs::metadata(&current).unwrap().len(), 0);
                assert!(fs::read_to_string(&first)
                    .unwrap()
                    .ends_with(&format!("generation {generation}\n")));
                if generation > 1 {
                    assert!(fs::read_to_string(&second)
                        .unwrap()
                        .ends_with(&format!("generation {}\n", generation - 1)));
                }
                assert!(!root.join("helper-agent.log.3").exists());
                // Every new agent still appends through both supported names.
                fs::write(&current, format!("active {generation}\n")).unwrap();
                assert_eq!(
                    fs::read_to_string(root.join("lyrics-agent.log")).unwrap(),
                    format!("active {generation}\n")
                );
                fs::OpenOptions::new()
                    .write(true)
                    .open(&current)
                    .unwrap()
                    .set_len(2 * 1024 * 1024)
                    .unwrap();
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn helper_log_keeps_the_old_name_readable_for_old_and_fresh_installs() {
        for old in [true, false] {
            let root =
                std::env::temp_dir().join(format!("krobi-helper-log-{}-{old}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            let legacy = root.join("lyrics-agent.log");
            if old {
                fs::write(&legacy, "old log").unwrap();
            }
            let current = agent_log(&root).unwrap();
            assert_eq!(
                current.canonicalize().unwrap(),
                legacy.canonicalize().unwrap()
            );
            use std::io::Write;
            writeln!(
                fs::OpenOptions::new().append(true).open(&current).unwrap(),
                "new log"
            )
            .unwrap();
            let text = fs::read_to_string(&legacy).unwrap();
            assert!(text.ends_with("new log\n"));
            assert_eq!(text.starts_with("old log"), old);
            assert_eq!(agent_log(&root).unwrap(), current);
            fs::remove_dir_all(root).unwrap();
        }
    }
}
