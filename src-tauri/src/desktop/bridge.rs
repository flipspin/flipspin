//! `bridge_invoke`: the one command behind the renderer's typed `window.krobi`.
//!
//! Each channel is one handler; `bridge_invoke` only dispatches. The channel
//! names are the wire (`renderer/src/lib/ipc.ts`) — byte-identical or
//! the renderer's call answers "unknown desktop channel".

use serde_json::{json, Value};
use std::fs;
use tauri::{AppHandle, Emitter, Manager};

use super::discovery::{device_name, discover_nests, lan_url};
use super::handshake::{network_from_body, probe_address};
use super::prefs::read_env_token;
use super::proxy::normalize_backend;
use super::*;

const APP_GET_BACKEND_ORIGIN: &str = "app:get-backend-origin";
const APP_GET_VERSION: &str = "app:get-version";
const APP_GET_DEVICE_NAME: &str = "app:get-device-name";
const SERVER_GET_STATUS: &str = "server:get-status";
const SERVER_SET_NETWORK: &str = "server:set-network";
const SERVER_DISCOVER: &str = "server:discover";
const SERVER_LOCAL_SETUP_TOKEN: &str = "server:local-setup-token";
const SERVER_PROBE: &str = "server:probe";
const SERVER_RETRY_NOW: &str = "server:retry-now";
const SERVER_REPORT_AUTH: &str = "server:report-auth";
const SERVER_USE: &str = "server:use";
/// Legacy: the pre-`server:*` spelling, still sent by `desktopAPI.getServerUrl`
/// (`renderer/src/desktop/tauri.ts`). Hyphen, not colon — keep it exactly so.
const SERVER_GET_LEGACY: &str = "server-get";
const AUTH_GET: &str = "auth:get";
const AUTH_SET: &str = "auth:set";
const AUTH_CLEAR: &str = "auth:clear";
const LOG_WRITE: &str = "log:write";
const LYRICS_ENGINE_STATUS: &str = "lyrics:engine-status";
const LYRICS_ENGINE_REPAIR: &str = "lyrics:engine-repair";
const LYRICS_ENGINE_INSTALL: &str = "lyrics:engine-install";
const LYRICS_AGENT_START: &str = "lyrics:agent-start";
const LYRICS_AGENT_STOP: &str = "lyrics:agent-stop";

type Reply = ShellResult<Value>;

#[tauri::command]
pub async fn bridge_invoke(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    channel: String,
    request: Option<Value>,
) -> Reply {
    let state = state.inner();
    let request = request.as_ref();
    match channel.as_str() {
        "playback:activity" => {
            let active = request
                .and_then(|r| r["active"].as_bool())
                .ok_or(ShellError::Guard("missing-activity-state"))?;
            let reason = field(request, "reason")
                .filter(|reason| !reason.is_empty() && reason.len() <= 256)
                .ok_or(ShellError::Guard("invalid-activity-reason"))?;
            if !app.state::<crate::playback_activity::Activity>().set(
                window.label(),
                reason,
                active,
            ) {
                return Err(ShellError::Guard("activity-stopped"));
            }
            Ok(json!({"ok": true}))
        }
        "window:get-focus" => Ok(json!(super::focus::current(&app))),
        "proxy:open" => Ok(json!({"requestId": super::proxy::cancel::open(window.label())})),
        "proxy:cancel" => {
            let id = field(request, "requestId").ok_or(ShellError::Guard("missing-request-id"))?;
            super::proxy::cancel::cancel(window.label(), id);
            Ok(json!({"ok": true}))
        }
        "files:save-key-export" => super::downloads::save_key_export(request).await,
        APP_GET_BACKEND_ORIGIN => get_backend_origin(state),
        APP_GET_VERSION => Ok(json!({"version": env!("CARGO_PKG_VERSION")})),
        APP_GET_DEVICE_NAME => get_device_name().await,
        "server:stream-snapshot" => Ok(state.events.snapshot()),
        SERVER_GET_STATUS => get_status(state),
        SERVER_SET_NETWORK => set_network(state, request),
        // `http` is borrowed, never the lock: a browse lasts two seconds.
        SERVER_DISCOVER => Ok(discover_nests(&state.http).await),
        SERVER_LOCAL_SETUP_TOKEN => local_setup_token(state),
        SERVER_PROBE => probe_server(&app, state, request).await,
        SERVER_RETRY_NOW => {
            state.retry_connection();
            Ok(json!({"ok": true}))
        }
        SERVER_REPORT_AUTH => {
            let status = request
                .and_then(|r| r["status"].as_u64())
                .ok_or(ShellError::Guard("invalid-auth-status"))?;
            state.report_auth(status)?;
            Ok(json!({"ok": true}))
        }
        SERVER_USE => use_server(&app, state, request),
        SERVER_GET_LEGACY => get_server_legacy(state),
        "offline:pin" | "offline:unpin" | "offline:status" | "offline:pools"
        | "offline:snapshot" | "offline:outbox" | "offline:mode" | "offline:play"
        | "offline:sync" => super::offline::invoke(&app, state, &channel, request).await,
        "upload:start"
        | "upload:status"
        | "upload:stop"
        | "upload:retry-failed"
        | "upload:keep-awake"
        | "upload:pause" => super::uploads::invoke(&app, state, &channel, request).await,
        "credentials:describe" => describe_credentials(state).await,
        "credentials:save-to-file" => {
            state
                .runtime()?
                .save_credentials_to_file(&state.credentials_path())?;
            Ok(json!({"ok": true, "store": "file"}))
        }
        "headers:get" => super::custom_headers::describe(state, request),
        "headers:set" => {
            let result = super::custom_headers::save(state, request)?;
            let configured = state.runtime()?.configured_origin.clone();
            let active = field(request, "origin")
                .and_then(normalize_backend)
                .map_or(true, |origin| origin == configured);
            if active {
                let helper_app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    crate::lyrics::agent_stop(&helper_app.state::<crate::lyrics::LyricsState>());
                    let _ = super::mac_worker::resume(&helper_app);
                });
            }
            let _ = app.emit("headers:changed", ());
            Ok(result)
        }
        AUTH_GET => auth_get(state),
        AUTH_SET => auth_set(&app, state, request).await,
        AUTH_CLEAR => auth_clear(&app, state),
        LOG_WRITE => Ok(log_write(state, request)),
        "log:sources" => super::logs::sources(&app),
        "log:read" => super::logs::read(&app, request).await,
        "log:clear" => super::logs::clear(&app, request).await,
        "log:open-folder" => super::logs::open_folder(&app, request),
        "system:login-item-get" => {
            tauri::async_runtime::spawn_blocking(|| {
                serde_json::to_value(crate::login_item::get()).map_err(ShellError::from)
            })
            .await?
        }
        "system:login-item-set" => {
            let enabled = request
                .and_then(|r| r["enabled"].as_bool())
                .ok_or(ShellError::Guard("invalid-request"))?;
            tauri::async_runtime::spawn_blocking(move || {
                serde_json::to_value(crate::login_item::set(enabled)).map_err(ShellError::from)
            })
            .await?
        }
        // The lyrics engine on this Mac — see lyrics.rs. The shell owns install
        // and the agent so the person never meets a terminal.
        LYRICS_ENGINE_STATUS => Ok(crate::lyrics::status(
            &app,
            &app.state::<crate::lyrics::LyricsState>(),
        )),
        LYRICS_ENGINE_REPAIR => crate::lyrics::repair(app.clone()),
        LYRICS_ENGINE_INSTALL => crate::lyrics::install_target(
            app.clone(),
            request
                .and_then(|r| r["target"].as_str())
                .unwrap_or("engine"),
        ),
        "lyrics:engine-remove" => {
            let target = request
                .and_then(|r| r["target"].as_str())
                .unwrap_or("engine")
                .to_string();
            tauri::async_runtime::spawn_blocking(move || crate::lyrics::remove(&app, &target))
                .await?
        }
        LYRICS_AGENT_START | "lyrics:worker-resume" | "lyrics:worker-set" => {
            let enabled = if channel == "lyrics:worker-set" {
                request.and_then(|r| r["enabled"].as_bool())
            } else if channel == LYRICS_AGENT_START {
                Some(true)
            } else {
                None
            };
            tauri::async_runtime::spawn_blocking(move || {
                let result = super::mac_worker::change(&app, enabled);
                if let Err(error) = &result {
                    super::mac_worker::set_error(&app, Some(error.to_string()));
                }
                result
            })
            .await?
        }
        "lyrics:worker-configure" => {
            super::mac_worker::configure(&app, request.unwrap_or(&Value::Null))
        }
        LYRICS_AGENT_STOP => {
            tauri::async_runtime::spawn_blocking(move || {
                Ok(json!({"stopped": super::mac_worker::stop(&app)?}))
            })
            .await?
        }
        _ => Err(ShellError::Message(format!(
            "unknown desktop channel: {channel}"
        ))),
    }
}

pub(super) fn auth_identity(runtime: &Runtime) -> Value {
    let stored = runtime.credentials.get(&runtime.credential_key());
    json!({
        "userId": stored.and_then(|item| item.user_id.clone()),
        "label": stored.and_then(|item| item.label.clone()),
        "role": stored.and_then(|item| item.role.clone()),
        "hasToken": !runtime.token.is_empty()
    })
}

/// A string field of the request body, if the renderer sent one.
fn field<'a>(request: Option<&'a Value>, key: &str) -> Option<&'a str> {
    request
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
}

fn get_backend_origin(state: &DesktopState) -> Reply {
    let runtime = state.runtime()?;
    Ok(backend_origin_metadata(&runtime))
}

/// Local metadata only: an alternate route never changes the credential key.
fn backend_origin_metadata(runtime: &Runtime) -> Value {
    let instance = runtime
        .preferences
        .nest_addresses
        .get(&runtime.configured_origin)
        .and_then(|entry| entry.instance_id.as_deref());
    json!({"origin": runtime.backend_origin, "backendKey": runtime.credential_key(), "instanceId": instance})
}

async fn get_device_name() -> Reply {
    let name = tauri::async_runtime::spawn_blocking(device_name)
        .await
        .unwrap_or_else(|_| "Flipspin".into());
    Ok(json!({"name": name}))
}

fn get_status(state: &DesktopState) -> Reply {
    // Re-read the LAN address on every ask: a laptop that changed
    // Wi-Fi since launch has a new one, and a stale QR fails silently.
    state.tick_connection();
    let lan = lan_url();
    let mut runtime = state.runtime()?;
    if runtime.server.mode.as_deref() == Some("child") {
        runtime.server.lan_url = lan;
    }
    let connection = &runtime.server.connection;
    let (status, error) = (connection.state, connection.last_error);
    state.set_connection(&mut runtime, status, error);
    serde_json::to_value(&runtime.server).map_err(ShellError::from)
}

/// The renderer hands over `GET /api/server/network` after each successful
/// connection; the next launch can then reach this nest by an alternate
/// (`connect_remote`). Remote only: a nest this computer hosts is always
/// loopback.
fn set_network(state: &DesktopState, request: Option<&Value>) -> Reply {
    let network = network_from_body(request.unwrap_or(&Value::Null));
    let mut runtime = state.runtime()?;
    if !runtime.backend_is_remote {
        return Ok(json!({"ok": false, "reason": "local-backend"}));
    }
    // An authenticated response authorizes learning the active handshake's id,
    // including a reinstalled server that connect_remote cannot relearn alone.
    let instance_id = runtime
        .server
        .reachable
        .then(|| runtime.server.instance_id.clone())
        .flatten();
    let key = runtime.configured_origin.clone();
    let entry = runtime.preferences.nest_addresses.entry(key).or_default();
    let mut updated = entry.clone();
    updated.network = Some(network);
    if instance_id.is_some() {
        updated.instance_id = instance_id;
    }
    if updated != *entry {
        *entry = updated;
        state.save_preferences(runtime)?;
    }
    Ok(json!({"ok": true}))
}

fn local_setup_token(state: &DesktopState) -> Reply {
    let local = {
        let runtime = state.runtime()?;
        runtime.server.mode.as_deref() == Some("child")
    };
    // Only for the nest this computer hosts: the file is this
    // machine's, and a remote server's token is never on this disk.
    let token = local
        .then(|| fs::read_to_string(crate::lyrics::krobi_home().join("setup-token")).ok())
        .flatten()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(json!({"token": token}))
}

async fn probe_server(_app: &AppHandle, state: &DesktopState, request: Option<&Value>) -> Reply {
    let address = field(request, "address").unwrap_or("");
    let current = {
        let runtime = state.runtime()?;
        runtime.server.mode.as_deref() != Some("unchosen")
            && normalize_backend(address).as_deref() == Some(&runtime.backend_origin)
    };
    // Selected-server probes join the owner's in-flight attempt. Chooser
    // probes do not change the selected household or its connection record.
    let result = if current {
        match state.probe_current().await {
            Ok(found) => {
                json!({"ok": true, "url": normalize_backend(address), "handshake": found.body})
            }
            Err(_) => json!({"ok": false, "reason": "unreachable"}),
        }
    } else {
        probe_address(state, address).await
    };

    Ok(result)
}

/// The chooser's answer. On success the app relaunches and this never returns.
fn use_server(app: &AppHandle, state: &DesktopState, request: Option<&Value>) -> Reply {
    let normalized = match field(request, "address") {
        Some(value) if !value.trim().is_empty() => {
            Some(normalize_backend(value).ok_or(ShellError::Guard("invalid-address"))?)
        }
        _ => None,
    };
    {
        let mut runtime = state.runtime()?;
        if runtime.backend_locked {
            return Ok(json!({"ok": false, "reason": "locked"}));
        }
        // The chooser's answer is recorded explicitly, so the migration
        // rules in `decide_server_mode` never have to guess again.
        runtime.preferences.server_mode = Some(
            if normalized.is_some() {
                "remote"
            } else {
                "local"
            }
            .into(),
        );
        // Choosing an address again is also how a person tells the
        // shell to forget what it learned about the nest behind it.
        if let Some(url) = normalized.as_ref() {
            runtime.preferences.nest_addresses.remove(url);
        }
        let current_key = runtime.credential_key();
        runtime.backfill.remove(&current_key);
        runtime
            .backfill
            .remove(normalized.as_deref().unwrap_or("local"));
        runtime.preferences.backend_url = normalized;
        state.save_preferences(runtime)?;
    }
    app.restart();
}

fn get_server_legacy(state: &DesktopState) -> Reply {
    let runtime = state.runtime()?;
    Ok(json!({"url": runtime.preferences.backend_url, "locked": runtime.backend_locked}))
}

/// An allowlisted DTO: neither a Credential nor an arbitrary backend body is
/// ever serialized into the session view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialDescription {
    store: credentials::StoreKind,
    reason: Option<&'static str>,
    nest: CredentialNest,
    device_name: Option<String>,
    linked_at: Option<String>,
    last_used: Option<String>,
    state: &'static str,
}
#[derive(Serialize)]
struct CredentialNest {
    name: Option<String>,
    address: String,
}

fn credential_description(runtime: &Runtime, name: String) -> CredentialDescription {
    let stored = runtime.credentials.get(&runtime.credential_key());
    CredentialDescription {
        store: runtime.credential_storage.kind,
        reason: runtime.credential_storage.reason,
        nest: CredentialNest {
            name: runtime.server.name.clone(),
            address: runtime.backend_origin.clone(),
        },
        device_name: Some(name),
        linked_at: stored.and_then(|c| c.saved_at.clone()),
        last_used: None,
        state: if runtime.server.connection.state == ConnectionState::NeedsAuth
            || runtime.token.is_empty()
        {
            "rechazada"
        } else if runtime.server.reachable {
            "activa"
        } else {
            "sin-conexion"
        },
    }
}

async fn describe_credentials(state: &DesktopState) -> Reply {
    let name = tauri::async_runtime::spawn_blocking(device_name).await?;
    let (mut description, origin, token, reachable) = {
        let runtime = state.runtime()?;
        (
            credential_description(&runtime, name),
            runtime.backend_origin.clone(),
            runtime.token.clone(),
            runtime.server.reachable,
        )
    };
    if reachable && !token.is_empty() {
        match state
            .http
            .get(format!("{origin}/api/me/devices"))
            .bearer_auth(&token)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(response) if matches!(response.status().as_u16(), 401 | 403) => {
                super::http_log::received(&reqwest::Method::GET, "/api/me/devices", &response);
                description.state = "rechazada"
            }
            Ok(response) if response.status().is_success() => {
                super::http_log::received(&reqwest::Method::GET, "/api/me/devices", &response);
                if let Ok(body) = response.json::<Value>().await {
                    apply_current_device(&mut description, &body);
                }
            }
            Err(error) => {
                log::debug!(
                    "credential request failed: {}",
                    super::http_log::error(&error)
                );
                description.state = "sin-conexion";
            }
            Ok(response) => {
                super::http_log::received(&reqwest::Method::GET, "/api/me/devices", &response)
            }
        }
    }
    // A concurrent sign-in/out must not return metadata about the old token.
    let runtime = state.runtime()?;
    if runtime.backend_origin != origin || runtime.token != token {
        return Err(ShellError::Guard("credential-context-changed"));
    }
    serde_json::to_value(description).map_err(ShellError::from)
}

fn apply_current_device(description: &mut CredentialDescription, body: &Value) {
    let current = body["devices"].as_array().and_then(|devices| {
        devices
            .iter()
            .find(|device| device["isCurrent"].as_bool() == Some(true))
    });
    if let Some(current) = current {
        let text = |field: &str| current[field].as_str().map(str::to_owned);
        description.device_name = text("label").or_else(|| description.device_name.take());
        description.linked_at = text("createdAt").or_else(|| description.linked_at.take());
        description.last_used = text("lastSeenAt");
    }
}

fn auth_get(state: &DesktopState) -> Reply {
    let runtime = state.runtime()?;
    let mut reply = auth_identity(&runtime);
    reply["token"] = json!(runtime.token);
    Ok(reply)
}

fn auth_change_events(identity: Value, mut emit: impl FnMut(&str, Value)) {
    emit("auth:changed", identity);
    emit("auth-changed", json!({"changed": true}));
}

/// Notify every window without broadcasting credentials. Read secrets with auth:get.
fn emit_auth_changed(app: &AppHandle, identity: Value) {
    app.state::<DesktopState>().auth_changed();
    auth_change_events(identity, |channel, payload| {
        let _ = app.emit(channel, payload);
    });
}

/// A generation survives retries but is replaced on credential/nest changes, so
/// an old HTTP response cannot finish a new credential's backfill.
#[derive(Default)]
pub(super) struct BackfillAttempt {
    generation: std::sync::Arc<()>,
    in_flight: bool,
    done: bool,
    warned: bool,
}

/// A credential saved before the shell recorded the account id (September
/// 2026) holds a token and `userId: null`. Every offline operation needs that id
/// (`offline::scope`), so downloads failed with `account-required` while the
/// renderer, which asks `/api/me`, showed a signed-in person. Once connected,
/// read `/api/me` with the stored token and record the account — only for a real
/// account row (`source: "token"`), never a shared secret.
pub(super) async fn backfill_identity(app: &AppHandle) {
    // try_state: the first status can be emitted before setup manages the
    // state, and a panic here would kill the task that emits every status.
    let Some(state) = app.try_state::<DesktopState>() else {
        return;
    };
    if let Some(identity) = backfill_identity_for_state(&state, |level, message| {
        log::log!(level, "{message}");
    })
    .await
    {
        emit_auth_changed(app, identity);
    }
}

// The status emitter and offline account-required path share this guard. The
// reporter lets tests observe the actual messages without a process-wide logger.
async fn backfill_identity_for_state(
    state: &DesktopState,
    report: impl Fn(log::Level, String),
) -> Option<Value> {
    let (origin, key, token, generation) = {
        let mut runtime = state.runtime().ok()?;
        let key = runtime.credential_key();
        let stored = runtime.credentials.get(&key);
        let has_credential = stored.is_some();
        let has_account = stored.is_some_and(|stored| stored.user_id.is_some());
        let has_token = !runtime.token.is_empty();
        let attempt = runtime.backfill.entry(key.clone()).or_default();
        if attempt.done || attempt.in_flight {
            return None;
        }
        if has_account {
            attempt.done = true;
            return None;
        }
        if !has_credential || !has_token {
            attempt.done = true;
            report(
                log::Level::Debug,
                format!(
                    "account backfill skipped for {key}: credential {}, token {}",
                    if has_credential { "present" } else { "absent" },
                    if has_token { "present" } else { "empty" }
                ),
            );
            return None;
        }
        attempt.in_flight = true;
        let generation = attempt.generation.clone();
        (
            runtime.backend_origin.clone(),
            key,
            runtime.token.clone(),
            generation,
        )
    };
    let me = async {
        let response = state
            .http
            .get(format!("{}/api/me", origin.trim_end_matches('/')))
            .bearer_auth(&token)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;
        super::http_log::received(&reqwest::Method::GET, "/api/me", &response);
        response.error_for_status()?.json::<Value>().await
    }
    .await;
    let mut runtime = state.runtime().ok()?;
    let attempt = runtime.backfill.get_mut(&key)?;
    if !std::sync::Arc::ptr_eq(&attempt.generation, &generation) {
        return None;
    }
    attempt.in_flight = false;
    if runtime.backend_origin != origin || runtime.credential_key() != key || runtime.token != token
    {
        return None;
    }
    let attempt = runtime.backfill.get_mut(&key)?;
    let me = match me {
        Ok(me) => me,
        Err(error) => {
            if !attempt.warned {
                attempt.warned = true;
                report(
                    log::Level::Warn,
                    format!(
                        "could not read this desktop's account: {}",
                        super::http_log::error(&error)
                    ),
                );
            }
            return None;
        }
    };
    attempt.warned = false;
    attempt.done = true;
    let text = |name: &str| {
        me[name]
            .as_str()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let role = text("role").filter(|r| r == "owner" || r == "member");
    let (Some("token"), Some(id), Some(role)) = (me["source"].as_str(), text("id"), role) else {
        report(
            log::Level::Debug,
            format!(
                "account backfill skipped for {key}: /api/me answered source {:?}",
                me["source"].as_str()
            ),
        );
        return None;
    };
    let stored = runtime.credentials.get_mut(&key)?;
    if stored.user_id.is_some() {
        return None;
    }
    stored.user_id = Some(id);
    stored.role = Some(role);
    if stored.label.is_none() {
        stored.label = text("label");
    }
    if let Err(error) = runtime.save_credentials(&state.credentials_path()) {
        report(
            log::Level::Warn,
            format!("could not save this desktop's account: {error}"),
        );
        return None;
    }
    report(
        log::Level::Info,
        format!("this desktop's account recorded for {origin}"),
    );
    Some(auth_identity(&runtime))
}

async fn auth_set(app: &AppHandle, state: &DesktopState, request: Option<&Value>) -> Reply {
    let token = field(request, "token").unwrap_or("").trim();
    if token.is_empty() {
        return Ok(json!({"ok": false, "reason": "empty-token"}));
    }
    let (origin, key) = {
        let runtime = state.runtime()?;
        (runtime.backend_origin.clone(), runtime.credential_key())
    };
    let credential = super::credentials::verified(
        &state.http,
        &origin,
        request.ok_or(ShellError::Guard("empty-token"))?,
    )
    .await?;
    let (identity, persisted, reason) = {
        let mut runtime = state.runtime()?;
        if runtime.backend_origin != origin || runtime.credential_key() != key {
            return Err(ShellError::Guard("credential-context-changed"));
        }
        runtime.set_credential(key, credential);
        runtime.save_credentials(&state.credentials_path())?;
        (
            auth_identity(&runtime),
            runtime.credential_storage.kind != credentials::StoreKind::Memory,
            runtime.credential_storage.reason,
        )
    };
    emit_auth_changed(app, identity);
    Ok(json!({"ok": true, "persisted": persisted, "reason": reason}))
}

fn auth_clear(app: &AppHandle, state: &DesktopState) -> Reply {
    let identity = {
        let mut runtime = state.runtime()?;
        let key = runtime.credential_key();
        runtime.clear_credential(&key);
        runtime.save_credentials(&state.credentials_path())?;
        runtime.token = std::env::var("KROBI_API_TOKEN").unwrap_or_else(|_| {
            if runtime.backend_is_remote {
                String::new()
            } else {
                read_env_token()
            }
        });
        auth_identity(&runtime)
    };
    emit_auth_changed(app, identity);
    Ok(json!({"ok": true}))
}

fn log_write(state: &DesktopState, request: Option<&Value>) -> Value {
    let level = field(request, "level").unwrap_or("info");
    let text = field(request, "message").unwrap_or("");
    // The context carries the actual error (name, message, stack); without it an
    // error line read "[renderer] " and nothing else.
    let context = request
        .and_then(|r| r.get("context"))
        .filter(|c| !c.is_null())
        .map(|c| {
            let mut s = state.http.redact(&c.to_string());
            if s.len() > 2000 {
                let mut cut = 2000;
                while !s.is_char_boundary(cut) {
                    cut -= 1;
                }
                s.truncate(cut);
                s.push('…');
            }
            format!(" {s}")
        })
        .unwrap_or_default();
    let message = super::http_log::one_line(&state.http.redact(&format!("{text}{context}")));
    match level {
        "error" => log::error!("[renderer] {message}"),
        "warn" => log::warn!("[renderer] {message}"),
        "debug" => log::debug!("[renderer] {message}"),
        _ => log::info!("[renderer] {message}"),
    }
    Value::Null
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn backend_metadata_keeps_persisted_identity_without_a_live_status() {
        let mut runtime =
            super::super::tests::remote_runtime("https://example.com", "https://example.org");
        runtime.preferences.nest_addresses.insert(
            runtime.configured_origin.clone(),
            prefs::NestAddresses {
                instance_id: Some("remembered-instance".into()),
                ..Default::default()
            },
        );
        runtime.server.instance_id = None;
        runtime.server.connection.state = ConnectionState::Unreachable;
        let body = backend_origin_metadata(&runtime);
        assert_eq!(body["origin"], "https://example.org");
        assert_eq!(body["backendKey"], "https://example.com");
        assert_eq!(body["instanceId"], "remembered-instance");
        runtime.backend_is_remote = false;
        assert_eq!(backend_origin_metadata(&runtime)["backendKey"], "local");
    }

    #[test]
    fn describe_allowlists_metadata_and_never_serializes_a_token() {
        let mut runtime =
            super::super::tests::remote_runtime("http://nest:8000", "http://away:8000");
        runtime.token = "fixture-description-secret".into();
        runtime
            .credentials
            .get_mut("http://nest:8000")
            .unwrap()
            .token = runtime.token.clone();
        let mut description = credential_description(&runtime, "This computer".into());
        apply_current_device(
            &mut description,
            &json!({"devices": [
                {"isCurrent": false, "label": "Other", "token": "another-fixture-secret"},
                {"isCurrent": true, "label": "Laptop", "createdAt": "2026-01-01", "lastSeenAt": "2026-11-10", "token": "fixture-description-secret"}
            ]}),
        );
        let serialized = serde_json::to_string(&description).unwrap();
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("fixture-description-secret"));
        assert!(!serialized.contains("another-fixture-secret"));
        let body: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(body["store"], "memory");
        assert_eq!(body["reason"], "os-keystore-unavailable");
        assert_eq!(body["nest"]["address"], "http://away:8000");
        assert_eq!(body["deviceName"], "Laptop");
        assert_eq!(body["linkedAt"], "2026-01-01");
        assert_eq!(body["lastUsed"], "2026-11-10");
        assert_eq!(body["state"], "activa");
        runtime.server.reachable = false;
        assert_eq!(
            credential_description(&runtime, String::new()).state,
            "sin-conexion"
        );
        runtime.server.connection.state = ConnectionState::NeedsAuth;
        assert_eq!(
            credential_description(&runtime, String::new()).state,
            "rechazada"
        );
    }
}

#[cfg(test)]
#[path = "backfill_tests.rs"]
mod backfill_tests;
