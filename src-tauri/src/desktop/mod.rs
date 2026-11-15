//! The desktop shell: `DesktopState` and the commands `lib.rs` registers.
//! Each submodule is one seam; its header says which.

use crate::error::{lock, ShellError, ShellResult};
use custom_headers::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io,
    path::PathBuf,
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tauri::{AppHandle, Manager};

pub(crate) mod bridge;
pub(crate) mod connection;
pub(crate) mod credentials;
mod custom_headers;
pub(crate) mod discovery;
#[cfg(test)]
mod download_tests;
pub(crate) mod downloads;
pub(crate) mod events;
pub(crate) mod focus;
pub(crate) mod handshake;
mod http_log;
mod logs;
pub(crate) mod mac_worker;
pub(crate) mod migration;
pub(crate) mod nest;
mod nest_key;
mod nest_process;
pub(crate) mod offline;
pub(crate) mod player;
pub(crate) mod prefs;
mod private_file;
pub(crate) mod proxy;
pub(crate) mod system;
pub(crate) mod uploads;

use connection::{Connection, ConnectionState, Retry};
use discovery::lan_url;
use prefs::{atomic_json, decide_server_mode, read_env_token, read_json, Credential, Preferences};
use proxy::{media_proxy_url, normalize_backend};

const DEFAULT_PORT: u16 = 8000;

/// What the renderer has always received when the runtime mutex is poisoned.
const POISONED: &str = "desktop state poisoned";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    mode: Option<String>,
    base_url: Option<String>,
    port: Option<u16>,
    pid: Option<u32>,
    instance_id: Option<String>,
    name: Option<String>,
    identified: bool,
    reachable: bool,
    adopted: bool,
    problem: Option<String>,
    starting: bool,
    /// How *other* devices reach this computer's nest — `http://<LAN IPv4>:8000`.
    /// Only in child mode; `base_url` is loopback there and a pairing QR built
    /// from it sends a phone to itself.
    lan_url: Option<String>,
    /// The address actually in use. `base_url` is the one this install was
    /// set up with; the two differ only when that one did not answer at
    /// startup and an alternate (`pick`) did — Tailscale away from home, say.
    via: Option<String>,
    connection: Connection,
}

#[derive(Clone, Debug, Default)]
struct ServerIdentity {
    body: Value,
    instance_id: Option<String>,
    pid: Option<u32>,
    identified: bool,
    name: Option<String>,
    version: Option<String>,
}

struct Runtime {
    preferences: Preferences,
    credentials: BTreeMap<String, Credential>,
    credential_storage: credentials::Storage,
    /// Process-local backfill outcomes, guarded with the credential they describe.
    backfill: BTreeMap<String, bridge::BackfillAttempt>,
    child_credentials: Option<private_file::CredentialDirectory>,
    /// The *transport*: where requests go right now. `is_backend_url`, the
    /// media proxy, `backend_request` and the renderer's base URL all use it.
    backend_origin: String,
    /// The address this install was set up with — the nest's *identity* here.
    /// Credentials, the `nestAddresses` cache and the device-download
    /// manifest are keyed by this, never by `backend_origin`: a token saved
    /// at home must still be found when the nest is reached over Tailscale,
    /// and signing in away from home must not file it under a transport.
    configured_origin: String,
    backend_is_remote: bool,
    backend_locked: bool,
    token: String,
    server: ServerStatus,
    child: Option<nest_process::ChildTree>,
    child_build_id: Option<String>,
    adopted_child: Option<nest_process::BundleProcess>,
    shutting_down: bool,
    last_player_state: Option<Value>,
    retry: Retry,
}

pub struct DesktopState {
    app_dir: PathBuf,
    http: Client,
    runtime: Mutex<Runtime>,
    /// Held across a `preferences.json` write, so the runtime lock is not
    /// (see `save_preferences`).
    preferences_file: Mutex<()>,
    connection_wake: tokio::sync::Notify,
    events: events::Control,
    status_changed: Box<dyn Fn(&ServerStatus) + Send + Sync>,
    offline: Mutex<offline::Offline>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    backend_url: String,
    backend_is_remote: bool,
    backend_token: String,
    media_proxy_url: String,
}

impl Runtime {
    fn set_credential(&mut self, key: String, credential: Credential) {
        self.backfill.remove(&key);
        self.token = credential.token.clone();
        self.credentials.insert(key, credential);
    }

    fn clear_credential(&mut self, key: &str) {
        self.backfill.remove(key);
        self.credential_storage.remove(key);
        self.credentials.remove(key);
    }

    fn save_credentials(&mut self, path: &std::path::Path) -> io::Result<()> {
        self.credential_storage.save(path, &self.credentials)
    }
    fn save_credentials_to_file(&mut self, path: &std::path::Path) -> io::Result<()> {
        self.credential_storage
            .save_to_file(path, &self.credentials)
    }

    /// Which `credentials.json` entry this install presents: the configured
    /// origin when remote, the literal `"local"` otherwise (a local port moves).
    /// Never `backend_origin` — that is only the transport (see the field).
    fn credential_key(&self) -> String {
        if self.backend_is_remote {
            self.configured_origin.clone()
        } else {
            "local".into()
        }
    }
}

impl DesktopState {
    pub(crate) fn helper_headers(&self, origin: &str) -> BTreeMap<String, String> {
        self.http
            .headers_for(origin)
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_owned()))
            })
            .collect()
    }

    pub fn new(app: &AppHandle) -> ShellResult<Self> {
        let app_dir = app.path().app_data_dir()?;
        let preferences: Preferences = read_json(&app_dir.join("preferences.json"));
        let (credentials, credential_storage) =
            credentials::load(&app_dir.join("credentials.json"))?;
        let forced = std::env::var("KROBI_BACKEND_URL")
            .ok()
            .and_then(|value| normalize_backend(&value));
        let saved_url = preferences
            .backend_url
            .as_deref()
            .and_then(normalize_backend);
        let has_local_credential = credentials
            .get("local")
            .is_some_and(|item| !item.token.trim().is_empty());
        let decided = decide_server_mode(
            preferences.server_mode.as_deref(),
            saved_url.as_deref(),
            forced.is_some(),
            has_local_credential,
            crate::lyrics::krobi_home().is_dir(),
        );
        // "remote" without an address to go to (a hand-edited file) is no
        // choice at all — ask again rather than silently host a server.
        let configured = match decided {
            Some("remote") => forced.clone().or(saved_url),
            _ => None,
        };
        let unchosen = decided.is_none() || (decided == Some("remote") && configured.is_none());
        let backend_is_remote = configured.is_some();
        let backend_origin =
            configured.unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
        // Credentials are keyed by the configured address (see `Runtime::configured_origin`);
        // at this point it is also the transport — `initialize_backend` may change that.
        let key = if backend_is_remote {
            backend_origin.clone()
        } else {
            "local".into()
        };
        let token = credentials
            .get(&key)
            .map(|item| item.token.trim().to_string())
            .filter(|item| !item.is_empty())
            .or_else(|| {
                std::env::var("KROBI_API_TOKEN")
                    .ok()
                    .filter(|item| !item.trim().is_empty())
            })
            .unwrap_or_else(|| {
                if backend_is_remote {
                    String::new()
                } else {
                    read_env_token()
                }
            });
        // "unchosen" is first run: nothing is probed or spawned until the
        // person answers "Where is your nest?" (`server:use`), so no port is
        // opened on the LAN by an install that may only ever be a client.
        let mode = if unchosen {
            "unchosen"
        } else if backend_is_remote {
            "external"
        } else {
            "child"
        };
        let hosts_nest = mode == "child";
        let server = ServerStatus {
            mode: Some(mode.into()),
            base_url: (!unchosen).then(|| backend_origin.clone()),
            port: hosts_nest.then_some(DEFAULT_PORT),
            pid: None,
            instance_id: None,
            name: preferences.nest_name(&backend_origin),
            identified: false,
            reachable: false,
            adopted: false,
            problem: None,
            starting: !unchosen,
            lan_url: if hosts_nest { lan_url() } else { None },
            via: (!unchosen).then(|| backend_origin.clone()),
            connection: Connection::new(if unchosen {
                ConnectionState::Unchosen
            } else {
                ConnectionState::Connecting
            }),
        };
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()?;
        http.restore(&credentials)?;
        let offline = offline::Offline::new(&app_dir, app.path().app_cache_dir()?)?;
        Ok(Self {
            offline: Mutex::new(offline),
            app_dir,
            http,
            runtime: Mutex::new(Runtime {
                preferences,
                credentials,
                credential_storage,
                backfill: BTreeMap::new(),
                child_credentials: None,
                configured_origin: backend_origin.clone(),
                backend_origin,
                backend_is_remote,
                backend_locked: forced.is_some(),
                token,
                server,
                child: None,
                child_build_id: None,
                adopted_child: None,
                shutting_down: false,
                last_player_state: None,
                retry: Retry::default(),
            }),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: {
                use tauri::Emitter;
                let app = app.clone();
                let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<ServerStatus>();
                // Queue in runtime order, emit outside its lock: a Rust
                // subscriber may need to read DesktopState in its callback.
                tauri::async_runtime::spawn(async move {
                    while let Some(status) = receive.recv().await {
                        let connected = status.connection.state == ConnectionState::Connected;
                        let _ = app.emit("server:status-changed", status);
                        if connected {
                            bridge::backfill_identity(&app).await;
                        }
                    }
                });
                Box::new(move |status| {
                    let _ = send.send(status.clone());
                })
            },
        })
    }

    fn preferences_path(&self) -> PathBuf {
        self.app_dir.join("preferences.json")
    }
    /// Write `preferences.json` from `runtime` without holding the runtime
    /// lock across the disk I/O: the snapshot is cloned, the file lock is
    /// taken, and only then is the runtime released — so writes land in the
    /// order their snapshots were taken and never share the temp file.
    fn save_preferences(&self, runtime: MutexGuard<'_, Runtime>) -> io::Result<()> {
        let snapshot = runtime.preferences.clone();
        // `()` has no invariant a panic could break, so poison is ignored.
        let _file = self
            .preferences_file
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        drop(runtime);
        atomic_json(&self.preferences_path(), &snapshot, false)
    }

    fn credentials_path(&self) -> PathBuf {
        self.app_dir.join("credentials.json")
    }
    /// The shared runtime, or the error every command has always answered
    /// with when a panic elsewhere poisoned it. Use this wherever the caller
    /// can return an error.
    fn runtime(&self) -> ShellResult<MutexGuard<'_, Runtime>> {
        lock(&self.runtime, "desktop")
    }

    /// For the callers with nowhere to send an error: setup, the backend
    /// watcher, `stop_child` on exit and the fire-and-forget player relay.
    /// A poisoned runtime means a panic already happened while it was held,
    /// so its fields may be half-written; carrying on would act on that.
    fn runtime_or_panic(&self) -> MutexGuard<'_, Runtime> {
        self.runtime.lock().expect(POISONED)
    }

    pub fn should_watch(&self) -> bool {
        self.runtime()
            .map(|runtime| runtime.backend_is_remote || runtime.server.starting)
            .unwrap_or(false)
    }
}

#[tauri::command]
pub fn desktop_bootstrap(state: tauri::State<'_, DesktopState>) -> ShellResult<Bootstrap> {
    let runtime = state.runtime()?;
    Ok(Bootstrap {
        backend_url: runtime.backend_origin.clone(),
        backend_is_remote: runtime.backend_is_remote,
        backend_token: runtime.token.clone(),
        media_proxy_url: media_proxy_url().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::bridge::auth_identity;
    use crate::desktop::downloads::device_download_manifest_key;
    use crate::desktop::proxy::is_backend_url;
    use url::Url;

    pub(crate) fn remote_runtime(configured: &str, transport: &str) -> Runtime {
        let mut credentials = BTreeMap::new();
        credentials.insert(
            configured.to_string(),
            Credential {
                device_id: None,
                token: "secret".into(),
                user_id: Some("u1".into()),
                label: Some("Ana".into()),
                role: Some("owner".into()),
                saved_at: None,
            },
        );
        Runtime {
            preferences: Preferences::default(),
            credentials,
            credential_storage: credentials::Storage::test_memory(),
            backfill: BTreeMap::new(),
            child_credentials: None,
            backend_origin: transport.into(),
            configured_origin: configured.into(),
            backend_is_remote: true,
            backend_locked: false,
            token: "secret".into(),
            server: ServerStatus {
                mode: Some("external".into()),
                base_url: Some(configured.into()),
                port: None,
                pid: None,
                instance_id: None,
                name: None,
                identified: false,
                reachable: true,
                adopted: false,
                problem: None,
                starting: false,
                lan_url: None,
                via: Some(transport.into()),
                connection: Connection::new(ConnectionState::Connected),
            },
            child: None,
            child_build_id: None,
            adopted_child: None,
            shutting_down: false,
            last_player_state: None,
            retry: Retry::default(),
        }
    }

    #[test]
    fn credentials_follow_the_configured_origin_not_the_transport() {
        let home = "http://192.168.1.20:8000";
        let away = "http://100.101.1.2:8000";
        let runtime = remote_runtime(home, away);
        assert_eq!(runtime.credential_key(), home);
        let identity = auth_identity(&runtime);
        assert_eq!(identity["userId"], "u1");
        assert_eq!(identity["label"], "Ana");
        // A device download made over Tailscale is filed under the home address.
        assert_eq!(
            device_download_manifest_key(&runtime.configured_origin, "/api/media/A/B.mp3"),
            format!("{home}\n/api/media/A/B.mp3")
        );
        // …while the proxy only reaches the transport.
        let target = Url::parse(&format!("{away}/api/me")).unwrap();
        assert!(is_backend_url(
            &target,
            &Url::parse(&runtime.backend_origin).unwrap()
        ));

        let mut local = remote_runtime(home, home);
        local.backend_is_remote = false;
        assert_eq!(local.credential_key(), "local");
    }

    #[test]
    fn preferences_are_saved_from_a_snapshot_after_the_runtime_is_released() {
        let dir = std::env::temp_dir().join(format!("krobi-prefs-{}", std::process::id()));
        let mut runtime = remote_runtime("http://192.168.1.20:8000", "http://192.168.1.20:8000");
        runtime.preferences.theme = Some("matcha".into());
        let state = DesktopState {
            app_dir: dir.clone(),
            http: Client::new(),
            runtime: Mutex::new(runtime),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(offline::test_store()),
        };
        state.save_preferences(state.runtime().unwrap()).unwrap();
        assert!(state.runtime.try_lock().is_ok(), "runtime still held");
        let saved: Preferences = read_json(&state.preferences_path());
        assert_eq!(saved.theme.as_deref(), Some("matcha"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn poisoned_runtime_returns_the_legacy_error_and_still_panics_when_required() {
        let state = DesktopState {
            app_dir: PathBuf::new(),
            http: Client::new(),
            runtime: Mutex::new(remote_runtime("http://nest:8000", "http://nest:8000")),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(offline::test_store()),
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _runtime = state.runtime().unwrap();
            panic!("poison the runtime");
        }));
        let error = state.runtime().err().expect("runtime must remain poisoned");
        assert!(matches!(error, ShellError::Poisoned("desktop")));
        assert_eq!(
            tauri::ipc::InvokeError::from(error).0,
            "desktop state poisoned"
        );

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(state.runtime_or_panic());
        }))
        .expect_err("fire-and-forget callers must still panic");
        assert!(panic
            .downcast_ref::<String>()
            .unwrap()
            .starts_with(POISONED));
    }
}

#[cfg(test)]
mod security_tests;
