//! The server this shell talks to: adopt or spawn the local one, pick the
//! transport to a remote one, and watch a child that is starting.

use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{AppHandle, Manager};

use super::handshake::{nest_candidates, pick_address, probe, probe_all, probe_verdict};
use super::nest_process::{BundleProcess, ChildTree};
use super::*;

fn bundled_executable(app: &AppHandle) -> Option<PathBuf> {
    Some(
        app.path()
            .resource_dir()
            .ok()?
            .join("backend")
            .join(if cfg!(windows) {
                "krobi-backend.exe"
            } else {
                "krobi-backend"
            }),
    )
}

fn backend_hash(executable: &Path) -> std::io::Result<String> {
    let mut source = std::fs::File::open(executable)?;
    let mut digest = Sha256::new();
    std::io::copy(&mut source, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Debug, PartialEq, Eq)]
enum Adoption {
    Adopt,
    Replace,
    PortBusy,
}

fn adoption_decision(expected: Option<&str>, found: Option<&str>, bundled: bool) -> Adoption {
    if !bundled || expected.is_none() {
        Adoption::PortBusy
    } else if expected == found {
        Adoption::Adopt
    } else {
        // A pre-identity backend is also an old build. Never infer its build
        // by hashing its executable path, which may already have been replaced.
        Adoption::Replace
    }
}

impl DesktopState {
    pub fn initialize_backend(&self, app: &AppHandle) {
        let (origin, remote, unchosen) = {
            let runtime = self.runtime_or_panic();
            (
                runtime.backend_origin.clone(),
                runtime.backend_is_remote,
                runtime.server.mode.as_deref() == Some("unchosen"),
            )
        };
        if unchosen {
            // Not even a probe: an adopted stranger on :8000 would make the
            // choice for the person. The renderer shows the chooser.
            return;
        }
        if remote {
            self.connect_remote(&origin);
            return;
        }
        // Setup runs before the window exists and outside the async runtime,
        // so the one startup probe blocks here (1.5 s at most); everything
        // after it is asynchronous.
        if let Some(found) = tauri::async_runtime::block_on(probe(&self.http, &origin)) {
            let executable = bundled_executable(app);
            let process = executable
                .as_deref()
                .and_then(|bundled| BundleProcess::listening(found.pid?, DEFAULT_PORT, bundled));
            let expected = executable
                .as_deref()
                .and_then(|path| backend_hash(path).ok());
            let build_id = found
                .body
                .get("buildId")
                .and_then(serde_json::Value::as_str);
            match adoption_decision(expected.as_deref(), build_id, process.is_some()) {
                Adoption::Adopt => {
                    let mut runtime = self.runtime_or_panic();
                    runtime.adopted_child = process;
                    runtime.server.adopted = true;
                    self.accept_probe(&mut runtime, &found);
                    self.cache_nest_identity(runtime);
                    return;
                }
                Adoption::Replace => {
                    if let Err(error) = process.expect("verified bundle process").stop() {
                        log::warn!("Could not stop an old local nest: {error}");
                        self.child_problem("port-busy");
                        return;
                    }
                    log::info!("Stopped an old local nest from a previous version");
                }
                Adoption::PortBusy => {
                    // Dev shells still talk to the separately launched dev
                    // server. Packaged shells never adopt or stop that process.
                    if cfg!(debug_assertions) && expected.is_none() && process.is_none() {
                        let mut runtime = self.runtime_or_panic();
                        runtime.server.adopted = true;
                        self.accept_probe(&mut runtime, &found);
                        self.cache_nest_identity(runtime);
                    } else {
                        self.child_problem("port-busy");
                    }
                    return;
                }
            }
        }
        // The server binds every interface (below), so that is what must be free.
        if TcpListener::bind(("0.0.0.0", DEFAULT_PORT)).is_err() {
            self.child_problem("port-busy");
            return;
        }
        if cfg!(debug_assertions) {
            self.child_problem("not-installed");
            return;
        }
        self.spawn_backend(app);
    }

    fn child_problem(&self, problem: &str) {
        let mut runtime = self.runtime_or_panic();
        runtime.server.problem = Some(problem.into());
        self.set_connection(&mut runtime, ConnectionState::Unreachable, None);
    }

    fn spawn_backend(&self, app: &AppHandle) {
        let Ok(resource_dir) = app.path().resource_dir() else {
            self.child_problem("not-installed");
            return;
        };
        let executable = resource_dir.join("backend").join(if cfg!(windows) {
            "krobi-backend.exe"
        } else {
            "krobi-backend"
        });
        if !executable.is_file() {
            self.child_problem("not-installed");
            return;
        }
        let build_id = match backend_hash(&executable) {
            Ok(build_id) => build_id,
            Err(error) => {
                log::error!("Could not identify the bundled backend: {error}");
                self.child_problem("start-failed");
                return;
            }
        };
        let backend_dir = executable.parent().unwrap_or(&resource_dir);
        let handoff = match nest_key::load(&crate::lyrics::krobi_home(), backend_dir)
            .and_then(|key| private_file::CredentialDirectory::new(&key))
        {
            Ok(handoff) => handoff,
            Err(_) => {
                // No on-disk fallback for a nest key: losing a session-only
                // encryption key would make the library's secrets unreadable.
                self.child_problem("nest-secret-key-unavailable");
                return;
            }
        };
        let port = DEFAULT_PORT.to_string();
        let mut command = Command::new(&executable);
        // A desktop nest is meant to be reached by the household's other
        // devices, so it binds every interface on purpose. That is only safe
        // because the claim is gated: with KROBI_REQUIRE_SETUP_TOKEN the first
        // account needs the token the server writes (0600) to ~/Krobi/setup-token,
        // which this shell reads and hands to "Create account" (`server:local-setup-token`).
        // Without it, anybody on the Wi-Fi could claim a fresh install first.
        command
            .args(["--host", "0.0.0.0", "--port", &port])
            .env("KROBI_REQUIRE_SETUP_TOKEN", "true")
            .env("KROBI_SUPERVISOR", "desktop")
            .env("CREDENTIALS_DIRECTORY", handoff.path())
            .env_remove("KROBI_SECRET_KEY_FILE")
            .current_dir(backend_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let default_songs = resource_dir.join("default-songs");
        if default_songs.is_dir() {
            command.env("KROBI_DEFAULT_SONGS_PATH", default_songs);
        }
        let bin = resource_dir.join("backend/bin");
        if bin.is_dir() {
            let mut paths = vec![bin];
            if cfg!(target_os = "macos") {
                paths.extend([
                    PathBuf::from("/opt/homebrew/bin"),
                    PathBuf::from("/usr/local/bin"),
                ]);
            }
            if let Some(existing) = std::env::var_os("PATH") {
                paths.extend(std::env::split_paths(&existing));
            }
            if let Ok(joined) = std::env::join_paths(paths) {
                command.env("PATH", joined);
            }
        }
        // Share the shutdown lock through spawn and registration. A watcher
        // already committed to restart (exit 75) cannot spawn after stop_child.
        let mut runtime = self.runtime_or_panic();
        if runtime.shutting_down {
            return;
        }
        super::nest_process::source_runtime(&mut command, app);
        match ChildTree::spawn(&mut command) {
            Ok(child) => {
                let pid = child.id();
                runtime.child = Some(child);
                runtime.child_build_id = Some(build_id);
                runtime.child_credentials = Some(handoff);
                runtime.server.pid = Some(pid);
                self.set_connection(&mut runtime, ConnectionState::Connecting, None);
            }
            Err(error) => {
                log::error!("failed to start bundled backend: {error}");
                drop(runtime);
                self.child_problem("start-failed");
            }
        }
    }

    /// Probe cached addresses before exposing one session-wide backend URL.
    /// Match the saved instanceId; learn it only when absent, so a different
    /// server at the same address cannot replace the trusted identity.
    /// Explicit network refresh relearns identity only after authentication.
    pub(super) fn connect_remote(&self, configured: &str) {
        let cached = {
            let runtime = self.runtime_or_panic();
            runtime.preferences.nest_addresses.get(configured).cloned()
        };
        let expected = cached.as_ref().and_then(|entry| entry.instance_id.clone());
        let network = cached.and_then(|entry| entry.network);
        let candidates = match expected {
            Some(_) => nest_candidates(configured, network.as_ref()),
            None => vec![configured.to_string()],
        };
        let answered = tauri::async_runtime::block_on(probe_all(&self.http, &candidates));
        let answers: BTreeMap<String, String> = answered
            .iter()
            .filter_map(|(url, found)| {
                Some((url.clone(), found.as_ref().ok()?.instance_id.clone()?))
            })
            .collect();
        let transport = expected
            .as_deref()
            .and_then(|id| pick_address(configured, network.as_ref(), id, &answers))
            .unwrap_or_else(|| configured.to_string());
        if transport != configured {
            log::info!(
                "nest {} did not answer; using {}",
                super::http_log::url(configured),
                super::http_log::url(&transport)
            );
        } else if let Some(id) = expected
            .as_deref()
            .filter(|id| answers.get(configured).map(String::as_str) != Some(*id))
        {
            // Log each failed address check so remote connection failures retain
            // enough context for diagnosis.
            let verdicts: Vec<String> = answered
                .iter()
                .map(|(url, found)| {
                    let body = found
                        .as_ref()
                        .ok()
                        .map(|found| json!({"app": "krobi", "instanceId": found.instance_id}));
                    match found {
                        Err(reason) => format!(
                            "{}={} ({reason})",
                            super::http_log::url(url),
                            probe_verdict(id, None)
                        ),
                        Ok(_) => format!(
                            "{}={}",
                            super::http_log::url(url),
                            probe_verdict(id, body.as_ref())
                        ),
                    }
                })
                .collect();
            log::warn!(
                "nest {id} not found at any address: {}",
                verdicts.join(", ")
            );
        }
        let found = answered
            .into_iter()
            .find(|(url, _)| *url == transport)
            .map(|(_, found)| found);

        let mut runtime = self.runtime_or_panic();
        runtime.backend_origin = transport.clone();
        runtime.server.via = Some(transport.clone());
        runtime.retry.attempt = 1;
        let found = match found {
            Some(Ok(found)) => found,
            other => {
                let failure = match other {
                    Some(Err(reason)) => Some(reason),
                    _ => None,
                };
                if let Some(reason) = &failure {
                    log::warn!(
                        "nest {} did not answer at startup: {reason}",
                        super::http_log::url(&transport)
                    );
                    runtime.retry.last_reason = Some(reason.text.clone());
                }
                self.set_connection(
                    &mut runtime,
                    ConnectionState::Connecting,
                    failure.and_then(|reason| reason.code),
                );
                return;
            }
        };
        runtime.server.adopted = false;
        self.accept_probe(&mut runtime, &found);
        self.cache_nest_identity(runtime);
    }

    /// Fence watcher restarts while the helper says goodbye to this server.
    pub(crate) fn begin_shutdown(&self) {
        self.runtime
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .shutting_down = true;
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.runtime
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .shutting_down
    }

    pub fn stop_child(&self) {
        // Shutdown must still release OS resources after an unrelated panic.
        self.runtime
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .shutdown();
    }
}

impl Runtime {
    fn shutdown(&mut self) {
        self.shutting_down = true;
        self.stop_nest();
    }

    fn stop_nest(&mut self) {
        if let Some(mut child) = self.child.take() {
            match child.stop() {
                Ok(()) => log::info!("Stopped the local nest and its child processes"),
                Err(error) => log::warn!("Could not stop the local nest: {error}"),
            }
        }
        if let Some(child) = self.adopted_child.take() {
            match child.stop() {
                Ok(()) => log::info!("Stopped the adopted local nest"),
                Err(error) => log::warn!("Could not stop the adopted local nest: {error}"),
            }
        }
        self.child_credentials = None;
        self.child_build_id = None;
        self.server.pid = None;
    }
}

/// Respawn a child only after an explicit restart request.
pub(super) fn restart_requested(status: std::process::ExitStatus) -> bool {
    status.code() == Some(75)
}

pub fn watch_backend(app: AppHandle) {
    let remote = app
        .state::<DesktopState>()
        .runtime_or_panic()
        .backend_is_remote;
    if remote {
        super::connection::watch_remote(app);
    } else {
        watch_child(app);
    }
}

fn watch_child(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut attempts = 0;
        loop {
            let respawn = {
                let state = app.state::<DesktopState>();
                let mut runtime = state.runtime_or_panic();
                if runtime.shutting_down {
                    return;
                }
                let exited = runtime
                    .child
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten());
                if let Some(status) = exited {
                    runtime.child = None;
                    runtime.child_build_id = None;
                    runtime.child_credentials = None;
                    runtime.server.pid = None;
                    runtime.server.problem = if restart_requested(status) {
                        None
                    } else {
                        Some("start-failed".into())
                    };
                    state.set_connection(
                        &mut runtime,
                        if restart_requested(status) {
                            ConnectionState::Connecting
                        } else {
                            ConnectionState::Unreachable
                        },
                        None,
                    );
                    restart_requested(status)
                } else {
                    false
                }
            };
            if respawn {
                attempts = 0;
                app.state::<DesktopState>().spawn_backend(&app);
            }
            let (origin, starting, owns_child, http) = {
                let state = app.state::<DesktopState>();
                let runtime = state.runtime_or_panic();
                (
                    runtime.backend_origin.clone(),
                    runtime.server.starting || runtime.child_credentials.is_some(),
                    runtime.child.is_some(),
                    state.http.clone(),
                )
            };
            if starting {
                if let Some(found) = probe(&http, &origin).await {
                    {
                        let state = app.state::<DesktopState>();
                        let mut runtime = state.runtime_or_panic();
                        if runtime.shutting_down {
                            return;
                        }
                        if runtime.child.is_some()
                            && runtime.child_build_id.as_deref()
                                != found
                                    .body
                                    .get("buildId")
                                    .and_then(serde_json::Value::as_str)
                        {
                            // A process won the bind race, or the archive was
                            // replaced while starting. Never accept its probe.
                            runtime.stop_nest();
                            runtime.server.problem = Some("port-busy".into());
                            state.set_connection(&mut runtime, ConnectionState::Unreachable, None);
                            return;
                        }
                        state.accept_probe(&mut runtime, &found);
                        state.cache_nest_identity(runtime);
                    }
                    attempts = 0;
                } else {
                    attempts += 1;
                    if attempts >= 180 {
                        {
                            let state = app.state::<DesktopState>();
                            let mut runtime = state.runtime_or_panic();
                            // A timed-out child must not read a deleted handoff
                            // later and generate its own data-directory key.
                            runtime.stop_nest();
                            runtime.server.problem = Some("start-failed".into());
                            state.set_connection(&mut runtime, ConnectionState::Unreachable, None);
                        }
                    }
                }
            }
            if !starting && !owns_child {
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_bundle_build_is_adopted() {
        assert_eq!(
            adoption_decision(Some("current"), Some("current"), true),
            Adoption::Adopt
        );
    }

    #[test]
    fn previous_bundle_build_is_replaced_even_without_an_identity() {
        for build in [Some("previous"), None] {
            assert_eq!(
                adoption_decision(Some("current"), build, true),
                Adoption::Replace
            );
        }
    }

    #[test]
    fn foreign_process_is_port_busy_even_if_it_claims_the_same_build() {
        for build in [Some("current"), Some("previous"), None] {
            assert_eq!(
                adoption_decision(Some("current"), build, false),
                Adoption::PortBusy
            );
        }
        assert_eq!(adoption_decision(None, None, true), Adoption::PortBusy);
    }

    #[test]
    fn only_backend_executables_in_bundle_resources_are_owned() {
        use super::super::nest_process::is_bundle_executable;
        let bundled =
            Path::new("/Applications/Flipspin.app/Contents/Resources/backend/krobi-backend");
        for path in [
            bundled,
            Path::new("/Applications/Other/Flipspin.app/Contents/Resources/backend/krobi-backend"),
            Path::new("/Applications/Old/Krobi.app/Contents/Resources/backend/krobi-backend"),
        ] {
            assert!(is_bundle_executable(path, bundled));
        }
        for path in [
            "/usr/bin/python3",
            "/tmp/krobi-backend",
            "/tmp/not-Krobi.app/Contents/Resources/backend/krobi-backend",
            "/Applications/Krobi.app/Contents/MacOS/krobi-backend",
        ] {
            assert!(!is_bundle_executable(Path::new(path), bundled));
        }
    }

    #[test]
    fn backend_identity_is_the_archive_hash() {
        let path = std::env::temp_dir().join(format!("krobi-build-{}", rand::random::<u64>()));
        std::fs::write(&path, "abc").unwrap();
        assert_eq!(
            backend_hash(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_hook_stops_the_child_and_disables_restarts_idempotently() {
        let mut runtime =
            super::super::tests::remote_runtime("http://127.0.0.1:8000", "http://127.0.0.1:8000");
        let mut command = Command::new("sh");
        command.args(["-c", "exec sleep 60"]);
        let child = ChildTree::spawn(&mut command).unwrap();
        let pid = child.id();
        runtime.child = Some(child);
        runtime.shutdown();
        runtime.shutdown();
        assert!(runtime.shutting_down);
        assert!(runtime.child.is_none());
        // SAFETY: signal zero only checks that shutdown reaped the direct child.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }

    #[cfg(unix)]
    #[test]
    fn child_restart_only_on_exit_75() {
        for code in [0, 1, 75] {
            let status = std::process::Command::new("sh")
                .args(["-c", &format!("exit {code}")])
                .status()
                .expect("run test child");
            assert_eq!(restart_requested(status), code == 75);
        }
    }
}
