//! Agent start, readiness refresh, graceful stop and sleep signaling.

use super::*;

pub(super) struct Agent {
    child: Child,
    ready: [bool; 3],
}

fn ready_addons(check: &Value) -> [bool; 3] {
    ["lyrics", "stems", "analysis"].map(|name| check["addons"][name]["ready"] == true)
}

impl Agent {
    pub(super) fn newly_ready(&self, check: &Value) -> bool {
        ready_addons(check)
            .iter()
            .zip(self.ready)
            .any(|(ready, started_ready)| *ready && !started_ready)
    }

    pub(super) fn running(&mut self) -> bool {
        self.child.try_wait().is_ok_and(|status| status.is_none())
    }
}

// ------------------------------------------------------------------- agent

/// Called with the worker operation lock held; concurrent starts share the
/// same readiness snapshot and cannot restart an already refreshed agent.
fn reuse_agent(state: &LyricsState, check: &Value) -> ShellResult<bool> {
    let mut slot = lock(&state.agent, "lyrics")?;
    if let Some(agent) = slot.as_mut() {
        if agent.running() && !agent.newly_ready(check) {
            return Ok(true);
        }
    }
    drop(slot);
    agent_stop(state);
    Ok(false)
}

pub fn agent_start(
    app: &AppHandle,
    origin: &str,
    token: &str,
    device_id: &str,
) -> ShellResult<Value> {
    if !supported() {
        return Ok(json!({"ok": false, "reason": "unsupported-platform"}));
    }
    if !binary().is_file() {
        return Ok(json!({"ok": false, "reason": "not-installed"}));
    }
    if token.trim().is_empty() {
        return Ok(json!({"ok": false, "reason": "no-token"}));
    }
    let state = app.state::<LyricsState>();
    let check = helper_check(&state);
    if reuse_agent(&state, &check)? {
        return Ok(json!({"ok": true, "already": true}));
    }
    update(app, &state)?;
    // An update may change the helper's capability probe. Capture readiness
    // immediately before spawning, rather than the last UI status snapshot.
    *lock(&state.check_snapshot, "lyrics")? = None;
    let ready = ready_addons(&helper_check(&state));
    let mut slot = lock(&state.agent, "lyrics")?;
    let _ = fs::remove_file(status_path());
    let log_dir = krobi_home().join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let log = agent_log(&log_dir)
        .and_then(|path| fs::OpenOptions::new().create(true).append(true).open(path))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    // The server stays idle until a job opens one connection.
    let mut awake = lock(&state.keep_awake, "lyrics")?;
    *awake = None;
    let server = crate::keep_awake::Server::start();
    #[cfg(not(windows))]
    let mut command = Command::new(binary());
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(venv_executable("python"));
        command.args(["-c", include_str!("agent_launcher.py")]);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command
    };
    match server {
        Ok(server) => {
            command.env("KROBI_KEEP_AWAKE_ADDR", server.address());
            *awake = Some(server);
        }
        Err(error) => {
            log::warn!("keep awake server failed: {error}");
            command.env("KROBI_KEEP_AWAKE_ADDR", "");
        }
    }
    // The token goes in the environment, never argv: `ps` shows every local
    // user the arguments of every process.
    command
        .args(["agent", "--server", origin])
        .env("KROBI_API_TOKEN", token)
        .env("KROBI_CUSTOM_HEADERS", {
            let desktop = app.state::<crate::desktop::DesktopState>();
            serde_json::to_string(&desktop.helper_headers(origin)).unwrap_or_else(|_| "{}".into())
        })
        .env("KROBI_WORKER_ID", device_id)
        .env("KROBI_AGENT_STATUS_PATH", status_path())
        .stdin(if cfg!(windows) {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(log);
    engine_env(&mut command);
    // The agent slot stays locked through this check and spawn. Shutdown takes
    // that same lock, so an in-flight start cannot leave a new helper behind.
    if app
        .state::<crate::desktop::DesktopState>()
        .is_shutting_down()
    {
        *awake = None;
        return Ok(json!({"ok": false, "reason": "shutting-down"}));
    }
    match command.spawn() {
        Ok(child) => {
            log::info!("lyrics agent started (pid {}) for {origin}", child.id());
            *slot = Some(Agent { child, ready });
            Ok(json!({"ok": true}))
        }
        Err(error) => {
            *awake = None;
            Ok(json!({"ok": false, "reason": "spawn-failed", "detail": error.to_string()}))
        }
    }
}

pub fn agent_stop(state: &LyricsState) -> bool {
    let mut slot = state
        .agent
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let child = slot.take();
    *state
        .keep_awake
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    if let Some(Agent { mut child, .. }) = child {
        stop_gracefully(&mut child, Duration::from_secs(1));
        return true;
    }
    false
}

/// Both console-free Windows EOF and Unix TERM enter Agent.stop(), including bye.
trait Stoppable {
    fn request_stop(&mut self);
    fn exited(&mut self) -> bool;
    fn kill_and_reap(&mut self);
}
impl Stoppable for Child {
    fn request_stop(&mut self) {
        self.stdin.take();
        #[cfg(unix)]
        // SAFETY: this is the PID of our owned child, with no pointer arguments.
        unsafe {
            libc::kill(self.id() as i32, libc::SIGTERM);
        }
    }
    fn exited(&mut self) -> bool {
        matches!(self.try_wait(), Ok(Some(_)))
    }
    fn kill_and_reap(&mut self) {
        let _ = self.kill();
        let _ = self.wait();
    }
}
fn stop_gracefully(child: &mut impl Stoppable, grace: Duration) {
    child.request_stop();
    let deadline = Instant::now() + grace.min(Duration::from_secs(1));
    loop {
        if child.exited() {
            return;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(remaining.min(Duration::from_millis(10)));
    }
    child.kill_and_reap();
}

/// Private, model-free local IPC. The worker never writes its credential here.
pub(super) fn status_path() -> PathBuf {
    tools_dir().join(format!("agent-status-{}.json", std::process::id()))
}

#[cfg(target_os = "macos")]
pub(crate) fn signal_sleep(app: &AppHandle) {
    if let Ok(mut slot) = app.state::<LyricsState>().agent.lock() {
        if let Some(agent) = slot.as_mut() {
            if agent.running() {
                let _ = Command::new("kill")
                    .args(["-USR1", &agent.child.id().to_string()])
                    .status();
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn newly_ready_addon_restarts_agent_once_across_concurrent_polls() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        fn fake_agent(check: &Value) -> Agent {
            Agent {
                child: Command::new("sleep").arg("30").spawn().unwrap(),
                ready: ready_addons(check),
            }
        }
        let before = json!({"addons": {"lyrics": {"ready": true}, "stems": {"ready": false}, "analysis": {"ready": false}}});
        let mut after = before.clone();
        after["addons"]["analysis"]["ready"] = json!(true);
        let state = LyricsState::default();
        let old = fake_agent(&before);
        let old_id = old.child.id();
        *state.agent.lock().unwrap() = Some(old);
        // An unsuccessful check or unchanged readiness must leave work running.
        assert!(reuse_agent(&state, &Value::Null).unwrap());
        assert!(reuse_agent(&state, &before).unwrap());
        let restarts = AtomicUsize::new(0);
        thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    let _operation = state.operation.lock().unwrap();
                    if !reuse_agent(&state, &after).unwrap() {
                        restarts.fetch_add(1, Ordering::SeqCst);
                        *state.agent.lock().unwrap() = Some(fake_agent(&after));
                    }
                });
            }
        });
        assert_eq!(restarts.load(Ordering::SeqCst), 1);
        let new_id = state.agent.lock().unwrap().as_ref().unwrap().child.id();
        assert_ne!(new_id, old_id);
        for _ in 0..5 {
            assert!(reuse_agent(&state, &after).unwrap());
        }
        assert_eq!(
            state.agent.lock().unwrap().as_ref().unwrap().child.id(),
            new_id
        );
        assert!(agent_stop(&state));
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn stop_requests_goodbye_before_kill_and_caps_grace_at_one_second() {
        struct Fake {
            cooperative: bool,
            events: Vec<&'static str>,
        }
        impl Stoppable for Fake {
            fn request_stop(&mut self) {
                self.events.push("stop");
            }
            fn exited(&mut self) -> bool {
                if self.cooperative {
                    self.events.push("bye");
                }
                self.cooperative
            }
            fn kill_and_reap(&mut self) {
                self.events.push("kill");
            }
        }
        let mut cooperative = Fake {
            cooperative: true,
            events: vec![],
        };
        stop_gracefully(&mut cooperative, Duration::from_secs(8));
        assert_eq!(cooperative.events, ["stop", "bye"]);
        let mut stubborn = Fake {
            cooperative: false,
            events: vec![],
        };
        let started = Instant::now();
        stop_gracefully(&mut stubborn, Duration::from_secs(8));
        assert!(started.elapsed() < Duration::from_millis(1500));
        assert_eq!(stubborn.events, ["stop", "kill"]);
    }

    #[test]
    fn windows_stdin_bridge_calls_existing_stop_and_bye_without_a_console() {
        let dir = std::env::temp_dir().join(format!("krobi-agent-stop-{}", rand::random::<u64>()));
        let package = dir.join("krobi_helper");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("__init__.py"), "").unwrap();
        fs::write(
            package.join("agent.py"),
            r#"
import signal
import threading
signal.signal(signal.SIGTERM, lambda *_: None)
class Agent:
    def __init__(self):
        self.done = threading.Event()
    def stop(self):
        print('bye', flush=True)
        self.done.set()
    def run(self):
        print('ready', flush=True)
        return 0 if self.done.wait(10) else 1
"#,
        )
        .unwrap();
        fs::write(
            package.join("cli.py"),
            "from .agent import Agent\ndef main():\n    return Agent().run()\n",
        )
        .unwrap();
        let mut child = Command::new(if cfg!(windows) { "python" } else { "python3" })
            .args(["-c", include_str!("agent_launcher.py"), "agent"])
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        let started = Instant::now();
        // This is the actual Windows request_stop operation, exercised on every host.
        child.stdin.take();
        stop_gracefully(&mut child, Duration::from_secs(1));
        assert!(started.elapsed() < Duration::from_millis(1500));
        let mut goodbye = String::new();
        stdout.read_to_string(&mut goodbye).unwrap();
        assert_eq!(goodbye.trim(), "bye");
        assert!(child.wait().unwrap().success());
        fs::remove_dir_all(dir).unwrap();
    }
}
