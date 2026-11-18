//! Helper environment installation, add-ons and child-process lifetime.
//! Managed Python and model caches survive upgrades; agent credentials stay in Rust.
use crate::error::{lock, ShellError, ShellResult};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

mod extras;
mod hardware;
mod install;
mod runtime;
mod status;
mod supervise;

use extras::{
    package_requirements, prefetch_models, repair_target, selected_extras, torch_backend,
};
use hardware::{hardware, probe_output};
use install::{
    install_log, install_runtime_target, installed_version, log_install_error, run, set_install,
    update,
};
use runtime::{
    agent_log, binary, engine_env, tools_dir, venv_dir, venv_executable, worker_sources,
};
use status::helper_check;
use supervise::{status_path, Agent};

pub(crate) use extras::remove_observed;
pub use extras::{remove, repair};
pub(crate) use install::install_target_observed;
pub use install::{install, install_target};
pub(crate) use runtime::find_uv;
pub(crate) use runtime::{krobi_home, supported};
pub use status::status;
pub(crate) use status::{installed, installing};
#[cfg(target_os = "macos")]
pub(crate) use supervise::signal_sleep;
pub use supervise::{agent_start, agent_stop};

const ENGINE_PYTHON: &str = "3.12";

const PROGRESS_EVENT: &str = "lyrics:engine-progress";

/// Per-operation terminal feedback; UI events still use the same emitter.
pub(crate) enum AddonEvent {
    Progress(Value),
    Finished(ShellResult<()>),
}

#[derive(Clone, Default)]
pub(crate) struct Feedback(pub Option<std::sync::mpsc::Sender<AddonEvent>>);

impl Feedback {
    fn progress(&self, app: &AppHandle, payload: Value) {
        let _ = app.emit(PROGRESS_EVENT, &payload);
        if let Some(sender) = &self.0 {
            let _ = sender.send(AddonEvent::Progress(payload));
        }
    }

    fn finish(&self, result: ShellResult<()>) {
        if let Some(sender) = &self.0 {
            let _ = sender.send(AddonEvent::Finished(result));
        }
    }
}

#[derive(Default)]
pub struct LyricsState {
    install: Mutex<InstallState>,
    check_hint: Mutex<Option<(Instant, String)>>,
    check_snapshot: Mutex<Option<(Instant, Value)>>,
    addon_errors: Mutex<std::collections::BTreeMap<String, String>>,
    agent: Mutex<Option<Agent>>,
    keep_awake: Mutex<Option<crate::keep_awake::Server>>,
    pub(crate) operation: Mutex<()>,
    pub(crate) worker_error: Mutex<Option<String>>,
    pub(crate) nest_worker: Mutex<Value>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    running: bool,
    repairing: bool,
    target: Option<String>,
    phase: Option<String>,
    percent: Option<u8>,
    error: Option<String>,
}
