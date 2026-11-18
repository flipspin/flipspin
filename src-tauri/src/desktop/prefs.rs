//! What this install remembers: `preferences.json`, `credentials.json`, and
//! the server-mode decision made from them at startup.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io, path::Path};

use super::*;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preferences {
    #[serde(default)]
    pub(super) offline_mode: bool,
    /// Missing on older installs means enabled.
    pub(super) upload_keep_awake: Option<bool>,
    pub(super) backend_url: Option<String>,
    pub(super) theme: Option<String>,
    /// One decision per configured nest. Missing entries migrate the old agent.
    #[serde(default)]
    pub(super) mac_workers: BTreeMap<String, bool>,
    pub(super) mac_worker_tray: Option<bool>,
    pub(super) language: Option<String>,
    /// Where the nest lives: `"local"` (this computer runs the server) or
    /// `"remote"` (another one does). Absent in every file written before the
    /// first-run chooser existed — `decide_server_mode` migrates those, so an
    /// existing install never sees the chooser. `#[serde(default)]` is implied
    /// by `Option`, and unknown values are ignored there, not rejected here:
    /// an unreadable preferences file would also lose the theme.
    pub(super) server_mode: Option<String>,
    /// What this install knows about each remote nest it was set up with,
    /// keyed by that configured address (`backendUrl` or `KROBI_BACKEND_URL`):
    /// the nest's `instanceId` and its last `GET /api/server/network`. That is
    /// what lets the shell reach the same nest over Tailscale or its domain
    /// when the address it was set up with does not answer (`pick`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub(super) nest_addresses: BTreeMap<String, NestAddresses>,
}

/// The other ways to one nest, as `GET /api/server/network` last reported them.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct NestNetwork {
    #[serde(default)]
    pub(super) lan: Vec<String>,
    /// The tailnet URL only (`tailscale.url` on the wire) — `pick` needs an address.
    pub(super) tailscale: Option<String>,
    pub(super) external_url: Option<String>,
}

impl Preferences {
    /// Read at startup, before a probe can answer.
    pub(super) fn nest_name(&self, configured: &str) -> Option<String> {
        self.nest_addresses
            .get(configured)
            .and_then(|entry| entry.name.clone())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct NestAddresses {
    /// Require alternate addresses to prove this instance identity.
    /// A Flipspin handshake alone cannot establish that it is the chosen server.
    pub(super) instance_id: Option<String>,
    pub(super) name: Option<String>,
    pub(super) network: Option<NestNetwork>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Credential {
    #[serde(default, skip_serializing)]
    pub(super) token: String,
    pub(super) device_id: Option<String>,
    pub(super) user_id: Option<String>,
    pub(super) label: Option<String>,
    pub(super) role: Option<String>,
    pub(super) saved_at: Option<String>,
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(crate) fn atomic_json(path: &Path, value: &impl Serialize, secret: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    #[cfg(unix)]
    if secret {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    let _ = secret;
    fs::rename(temp, path)
}

/// Resolve server choice from the environment lock, saved mode, legacy URL,
/// then a local credential; otherwise leave it unchosen. A leftover data
/// directory alone must not start or adopt a server.
pub(super) fn decide_server_mode(
    prefs_mode: Option<&str>,
    prefs_backend_url: Option<&str>,
    env_backend_url_set: bool,
    has_local_credential: bool,
    _krobi_home_exists: bool,
) -> Option<&'static str> {
    if env_backend_url_set {
        return Some("remote");
    }
    match prefs_mode {
        Some("local") => return Some("local"),
        Some("remote") => return Some("remote"),
        _ => {}
    }
    if prefs_backend_url.is_some_and(|url| !url.trim().is_empty()) {
        return Some("remote");
    }
    if has_local_credential {
        return Some("local");
    }
    None
}

pub(super) fn read_env_token() -> String {
    let path = crate::lyrics::krobi_home().join(".env");
    let Ok(contents) = fs::read_to_string(path) else {
        return String::new();
    };
    contents
        .lines()
        .filter_map(|line| line.trim().split_once('='))
        .find(|(key, _)| key.trim() == "KROBI_API_TOKEN")
        .map(|(_, value)| value.trim().trim_matches(['\'', '"']).to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_theme(state: tauri::State<'_, DesktopState>) -> Option<String> {
    state
        .runtime()
        .ok()
        .and_then(|runtime| runtime.preferences.theme.clone())
}

#[tauri::command]
pub fn set_theme(state: tauri::State<'_, DesktopState>, theme: String) -> Value {
    let mut runtime = match state.runtime() {
        Ok(runtime) => runtime,
        Err(error) => return json!({"ok": false, "error": error}),
    };
    runtime.preferences.theme = Some(theme);
    match state.save_preferences(runtime) {
        Ok(()) => json!({"ok": true}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_keep_awake_defaults_on_and_round_trips_off() {
        let old: Preferences = serde_json::from_str("{}").unwrap();
        assert!(old.upload_keep_awake.unwrap_or(true));
        assert!(Preferences::default().upload_keep_awake.unwrap_or(true));
        let off: Preferences = serde_json::from_str(r#"{"uploadKeepAwake":false}"#).unwrap();
        assert!(!off.upload_keep_awake.unwrap_or(true));
        assert!(serde_json::to_string(&off)
            .unwrap()
            .contains(r#""uploadKeepAwake":false"#));
    }
    #[test]
    fn server_mode_follows_env_then_choice_then_migration() {
        let url = Some("http://192.0.2.15:8000");
        // (prefs_mode, prefs_backend_url, env set, local credential, ~/Krobi exists) → mode
        type Case<'a> = (
            Option<&'a str>,
            Option<&'a str>,
            bool,
            bool,
            bool,
            Option<&'a str>,
        );
        let cases: &[Case] = &[
            // KROBI_BACKEND_URL locks it, whatever the file says.
            (Some("local"), None, true, true, true, Some("remote")),
            // The person's own answer beats every inference.
            (Some("local"), url, false, false, false, Some("local")),
            (Some("remote"), None, false, true, true, Some("remote")),
            // Migration: a saved address predates the chooser → remote.
            (None, url, false, true, true, Some("remote")),
            (None, Some("  "), false, false, false, None),
            // Migration: this computer already hosted a server → local.
            (None, None, false, true, false, Some("local")),
            // A folder left by an old install is not a local choice.
            (None, None, false, false, true, None),
            (None, None, false, true, true, Some("local")),
            // An unknown value is no answer, not a crash.
            (Some("cloud"), None, false, false, true, None),
            // Fresh install: ask.
            (None, None, false, false, false, None),
            (Some("cloud"), None, false, false, false, None),
        ];
        for &(mode, backend, env, credential, home, expected) in cases {
            assert_eq!(
                decide_server_mode(mode, backend, env, credential, home),
                expected,
                "mode={mode:?} url={backend:?} env={env} cred={credential} home={home}"
            );
        }
    }

    #[test]
    fn preferences_written_before_the_chooser_still_load() {
        let old: Preferences =
            serde_json::from_str(r#"{"backendUrl":"http://192.0.2.15:8000","theme":"dark"}"#)
                .unwrap();
        assert_eq!(old.server_mode, None);
        assert_eq!(old.theme.as_deref(), Some("dark"));
        let new: Preferences = serde_json::from_str(r#"{"serverMode":"local"}"#).unwrap();
        assert_eq!(new.server_mode.as_deref(), Some("local"));
        assert!(serde_json::to_string(&new)
            .unwrap()
            .contains("\"serverMode\":\"local\""));
    }

    #[test]
    fn nest_addresses_round_trip_and_stay_out_of_old_files() {
        let empty = serde_json::to_string(&Preferences::default()).unwrap();
        assert!(!empty.contains("nestAddresses"));
        let saved: Preferences = serde_json::from_str(
            r#"{"backendUrl":"http://192.168.1.20:8000","nestAddresses":{"http://192.168.1.20:8000":
                {"instanceId":"abc","network":{"lan":[],"tailscale":"http://100.101.1.2:8000","externalUrl":null}}}}"#,
        )
        .unwrap();
        let entry = &saved.nest_addresses["http://192.168.1.20:8000"];
        assert_eq!(entry.instance_id.as_deref(), Some("abc"));
        assert_eq!(
            entry.network.as_ref().unwrap().tailscale.as_deref(),
            Some("http://100.101.1.2:8000")
        );
    }
}
