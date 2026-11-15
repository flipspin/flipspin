//! The shell owns the switch and its separate device. No worker secret crosses IPC.
use super::*;
use serde_json::json;
use tauri::{Emitter, Manager};

fn key(origin: &str) -> String {
    format!("worker:{origin}")
}

pub(crate) fn settings(app: &AppHandle) -> Value {
    let state = app.state::<DesktopState>();
    let Ok(runtime) = state.runtime() else {
        return Value::Null;
    };
    let credential = runtime.credentials.get(&key(&runtime.configured_origin));
    json!({"enabled": runtime.preferences.mac_workers.get(&runtime.configured_origin).copied().unwrap_or(false),
        "eligible": crate::lyrics::supported() && runtime.backend_is_remote && !runtime.token.is_empty(),
        "tray": runtime.preferences.mac_worker_tray.unwrap_or(true),
        "workerId": credential.and_then(|c| c.device_id.clone())})
}

pub(crate) fn set_error(app: &AppHandle, error: Option<String>) {
    if let Ok(mut slot) = app
        .state::<crate::lyrics::LyricsState>()
        .worker_error
        .lock()
    {
        *slot = error;
    }
    let _ = app.emit("lyrics:worker-changed", ());
}

/// All provisioning/start/stop operations are serialized, including tray actions.
pub(crate) fn change(app: &AppHandle, enabled: Option<bool>) -> ShellResult<Value> {
    if !crate::lyrics::supported() {
        return Ok(json!({"ok": false, "reason": "unsupported-platform"}));
    }
    let lyrics = app.state::<crate::lyrics::LyricsState>();
    let _operation = lock(&lyrics.operation, "lyrics")?;
    let state = app.state::<DesktopState>();
    let (origin, address, token, was_enabled) = {
        let runtime = state.runtime()?;
        if !runtime.backend_is_remote {
            return Ok(json!({"ok": false, "reason": "local-backend"}));
        }
        (
            runtime.configured_origin.clone(),
            runtime.backend_origin.clone(),
            runtime.token.clone(),
            runtime
                .preferences
                .mac_workers
                .get(&runtime.configured_origin)
                .copied(),
        )
    };
    // Migration: the previous app automatically ran every installed remote engine.
    let on = enabled.unwrap_or_else(|| was_enabled.unwrap_or(crate::lyrics::installed()));
    if !on {
        let mut runtime = state.runtime()?;
        runtime
            .preferences
            .mac_workers
            .insert(origin.clone(), false);
        state.save_preferences(runtime)?;
        // Opting out stops work; removing the device belongs to Cuentas/devices.
        crate::lyrics::agent_stop(&lyrics);
        set_error(app, None);
        return Ok(json!({"ok": true}));
    }
    if token.is_empty() {
        return Err(ShellError::Guard("token-rejected"));
    }
    // Restoring an already provisioned worker must work while the nest is
    // unreachable: the agent owns retries. Only reuse a credential previously
    // minted for the desktop's current account and configured nest.
    if enabled.is_none() {
        let credential = {
            let runtime = state.runtime()?;
            resume_credential(&runtime.credentials, &runtime.configured_origin)
        };
        if let Some(credential) = credential {
            return start(app, &lyrics, &address, &credential);
        }
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    let stored = state.runtime()?.credentials.get(&key(&origin)).cloned();
    let old_token = stored.as_ref().map(|c| c.token.clone()).unwrap_or_default();
    let provisioned = enrol(
        |method, path, body| {
            let deleting = method == reqwest::Method::DELETE;
            if deleting {
                crate::lyrics::agent_stop(&lyrics);
            }
            let mut request = client
                .request(method, format!("{address}{path}"))
                .headers(state.http.headers_for(&format!("{address}{path}")))
                .bearer_auth(if deleting { &old_token } else { &token });
            if let Some(body) = body {
                request = request.json(&body);
            }
            let response = request.send().map_err(request_error)?;
            if deleting && matches!(response.status().as_u16(), 200..=299 | 401 | 403 | 404) {
                return Ok(Value::Null);
            }
            checked(Ok(response), path == "/api/me/devices")?
                .json()
                .map_err(ShellError::from)
        },
        stored,
        &discovery::device_name(),
    );
    let (credential, minted) = match provisioned {
        Err(ShellError::Guard("not-owner")) => {
            crate::lyrics::agent_stop(&lyrics);
            let mut runtime = state.runtime()?;
            runtime
                .preferences
                .mac_workers
                .insert(origin.clone(), false);
            state.save_preferences(runtime)?;
            set_error(app, Some("not-owner".into()));
            return Ok(json!({"ok": false, "reason": "not-owner"}));
        }
        other => other?,
    };
    if minted {
        let mut runtime = state.runtime()?;
        runtime.credentials.insert(key(&origin), credential.clone());
        runtime.save_credentials(&state.credentials_path())?;
        log::info!(
            "helper enrolled id={}",
            credential.device_id.as_deref().unwrap_or_default()
        );
    }
    let mut runtime = state.runtime()?;
    runtime.preferences.mac_workers.insert(origin, true);
    state.save_preferences(runtime)?;
    start(app, &lyrics, &address, &credential)
}

/// HTTP is injected so membership is tested at the same boundary as minting.
fn enrol(
    mut http: impl FnMut(reqwest::Method, &str, Option<Value>) -> ShellResult<Value>,
    stored: Option<Credential>,
    computer: &str,
) -> ShellResult<(Credential, bool)> {
    let me = http(reqwest::Method::GET, "/api/me", None)?;
    if me["role"] == "member" {
        return Err(ShellError::Guard("not-owner"));
    }
    if me["role"] != "owner" || me["source"] != "token" {
        return Err(ShellError::Guard("account-required"));
    }
    let user = me["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or(ShellError::Guard("account-required"))?
        .to_string();
    if let Some(old) = stored {
        if old.user_id.as_deref() == Some(&user)
            && !old.token.is_empty()
            && old.device_id.as_ref().is_some_and(|id| !id.is_empty())
        {
            return Ok((old, false));
        }
        // An account switch retires the previous account's helper before replacing it.
        if let Some(id) = old.device_id {
            http(
                reqwest::Method::DELETE,
                &format!("/api/me/devices/{id}"),
                None,
            )?;
        }
    }
    let label = computer.chars().take(80).collect::<String>();
    let body = http(
        reqwest::Method::POST,
        "/api/me/devices",
        Some(json!({"label": label, "helper": true})),
    )?;
    let credential = Credential {
        token: body["token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(ShellError::Guard("invalid-device-response"))?
            .into(),
        device_id: Some(
            body["device"]["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or(ShellError::Guard("invalid-device-response"))?
                .into(),
        ),
        user_id: Some(user),
        label: Some(label),
        role: Some("owner".into()),
        saved_at: None,
    };
    Ok((credential, true))
}

fn resume_credential(
    credentials: &BTreeMap<String, Credential>,
    origin: &str,
) -> Option<Credential> {
    let account = credentials.get(origin)?;
    let worker = credentials.get(&key(origin))?;
    (worker.role.as_deref() == Some("owner")
        && account.role.as_deref() == Some("owner")
        && account.user_id.is_some()
        && account.user_id == worker.user_id
        && !worker.token.is_empty()
        && worker.device_id.as_ref().is_some_and(|id| !id.is_empty()))
    .then(|| worker.clone())
}

fn start(
    app: &AppHandle,
    lyrics: &crate::lyrics::LyricsState,
    address: &str,
    credential: &Credential,
) -> ShellResult<Value> {
    set_error(app, None);
    if crate::lyrics::installing(lyrics) {
        return Ok(json!({"ok": true}));
    }
    if !crate::lyrics::installed() {
        let result = crate::lyrics::install(app.clone())?;
        if result["started"] != true {
            return Err(result["reason"].as_str().unwrap_or("install-failed").into());
        }
        return Ok(json!({"ok": true}));
    }
    let result = crate::lyrics::agent_start(
        app,
        address,
        &credential.token,
        credential
            .device_id
            .as_deref()
            .ok_or(ShellError::Guard("invalid-worker-id"))?,
    )?;
    let _ = app.emit("lyrics:worker-changed", ());
    Ok(result)
}

pub(crate) fn resume(app: &AppHandle) -> ShellResult<Value> {
    change(app, None)
}

pub(crate) fn stop(app: &AppHandle) -> ShellResult<bool> {
    let lyrics = app.state::<crate::lyrics::LyricsState>();
    let _operation = lock(&lyrics.operation, "lyrics")?;
    Ok(crate::lyrics::agent_stop(&lyrics))
}

fn checked(
    result: Result<reqwest::blocking::Response, reqwest::Error>,
    minting: bool,
) -> ShellResult<reqwest::blocking::Response> {
    let response = result.map_err(request_error)?;
    match response.status().as_u16() {
        200..=299 => Ok(response),
        403 if minting => Err(ShellError::Guard("not-owner")),
        401 | 403 => Err(ShellError::Guard("token-rejected")),
        code => Err(ShellError::Message(format!("worker-request-{code}"))),
    }
}

fn request_error(error: reqwest::Error) -> ShellError {
    // macOS Local Network denial is EHOSTUNREACH, buried in the transport's
    // source chain. It can occur while minting, before any agent exists.
    #[cfg(target_os = "macos")]
    {
        let mut cause: &dyn std::error::Error = &error;
        loop {
            if cause
                .to_string()
                .to_lowercase()
                .contains("no route to host")
            {
                return ShellError::Guard("network-denied");
            }
            match cause.source() {
                Some(next) => cause = next,
                None => break,
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = error;
    ShellError::Guard("nest-unreachable")
}

pub(crate) fn configure(app: &AppHandle, request: &Value) -> ShellResult<Value> {
    let state = app.state::<DesktopState>();
    let mut runtime = state.runtime()?;
    if let Some(tray) = request["tray"].as_bool() {
        runtime.preferences.mac_worker_tray = Some(tray);
    }
    if let Some(language) = request["language"]
        .as_str()
        .filter(|s| matches!(*s, "es" | "en"))
    {
        runtime.preferences.language = Some(language.into());
    }
    state.save_preferences(runtime)?;
    crate::worker_tray::refresh(app);
    let _ = app.emit("lyrics:worker-changed", ());
    Ok(json!({"ok": true}))
}

/// Status polling also feeds the tray while the window is closed or hidden.
pub(crate) fn start_monitor(app: AppHandle) {
    // Poll each supported helper platform; worker_tray remains macOS-only.
    if !crate::lyrics::supported() {
        return;
    }
    std::thread::spawn(move || loop {
        let snapshot = {
            let state = app.state::<DesktopState>();
            state.runtime().ok().and_then(|r| {
                let enabled = r
                    .preferences
                    .mac_workers
                    .get(&r.configured_origin)
                    .copied()
                    .unwrap_or(false);
                enabled
                    .then(|| {
                        r.credentials
                            .get(&key(&r.configured_origin))
                            .map(|c| (r.backend_origin.clone(), c.token.clone()))
                    })
                    .flatten()
            })
        };
        if let Some((origin, token)) = snapshot {
            if let Ok(client) = reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(3))
                .build()
            {
                if let Ok(response) = client
                    .get(format!("{origin}/api/lyrics/jobs"))
                    .headers(
                        app.state::<DesktopState>()
                            .http
                            .headers_for(&format!("{origin}/api/lyrics/jobs")),
                    )
                    .bearer_auth(token)
                    .send()
                {
                    if let Ok(body) = response.json::<Value>() {
                        if let Ok(mut worker) =
                            app.state::<crate::lyrics::LyricsState>().nest_worker.lock()
                        {
                            *worker = body["engine"]["worker"].clone();
                        }
                    }
                }
            }
        }
        crate::worker_tray::refresh(&app);
        let _ = app.emit("lyrics:worker-changed", ());
        std::thread::sleep(Duration::from_secs(5));
    });
}

pub(crate) fn language(app: &AppHandle) -> String {
    app.state::<DesktopState>()
        .runtime()
        .ok()
        .and_then(|r| r.preferences.language.clone())
        .unwrap_or_else(|| "es".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn member_is_not_owner_and_never_mints_even_with_a_stored_token() {
        for stored in [
            None,
            Some(Credential {
                token: "old".into(),
                ..Default::default()
            }),
        ] {
            let mut calls = Vec::new();
            let result = enrol(
                |method, path, _| {
                    calls.push((method, path.to_string()));
                    Ok(json!({"id": "ana", "role": "member", "source": "token"}))
                },
                stored,
                "Equipo de Ana",
            );
            assert!(matches!(result, Err(ShellError::Guard("not-owner"))));
            assert_eq!(calls, vec![(reqwest::Method::GET, "/api/me".into())]);
        }
    }

    #[test]
    fn owner_mints_helper_once_and_reuses_it_on_repeat() {
        let mut posts = 0;
        let mut http = |method, path: &str, body: Option<Value>| {
            if method == reqwest::Method::GET {
                assert_eq!(path, "/api/me");
                return Ok(json!({"id": "ana", "role": "owner", "source": "token"}));
            }
            assert_eq!(method, reqwest::Method::POST);
            assert_eq!(path, "/api/me/devices");
            assert_eq!(
                body.unwrap(),
                json!({"label": "Equipo de Ana", "helper": true})
            );
            posts += 1;
            Ok(json!({"token": "helper-secret", "device": {"id": "helper-device"}}))
        };
        let (credential, minted) = enrol(&mut http, None, "Equipo de Ana").unwrap();
        assert!(minted);
        let (again, minted) = enrol(&mut http, Some(credential), "Equipo de Ana").unwrap();
        assert!(!minted);
        assert_eq!(again.token, "helper-secret");
        assert_eq!(posts, 1);
    }

    #[test]
    fn server_refusal_during_mint_remains_not_owner() {
        let result = enrol(
            |method, _, _| {
                if method == reqwest::Method::GET {
                    Ok(json!({"id": "ana", "role": "owner", "source": "token"}))
                } else {
                    Err(ShellError::Guard("not-owner"))
                }
            },
            None,
            "Equipo",
        );
        assert!(matches!(result, Err(ShellError::Guard("not-owner"))));
    }

    #[test]
    fn offline_restore_uses_only_the_current_accounts_worker_for_that_nest() {
        let origin = "http://nest:8000";
        let mut credentials = BTreeMap::from([
            (
                origin.into(),
                Credential {
                    token: "desktop".into(),
                    role: Some("owner".into()),
                    user_id: Some("ana".into()),
                    ..Default::default()
                },
            ),
            (
                key(origin),
                Credential {
                    token: "worker".into(),
                    user_id: Some("ana".into()),
                    device_id: Some("worker-device".into()),
                    role: Some("owner".into()),
                    ..Default::default()
                },
            ),
        ]);
        let resumed = resume_credential(&credentials, origin).unwrap();
        assert_eq!(resumed.token, "worker");
        assert_eq!(resumed.device_id.as_deref(), Some("worker-device"));
        assert!(resume_credential(&credentials, "http://other:8000").is_none());
        credentials.get_mut(origin).unwrap().role = None;
        assert!(resume_credential(&credentials, origin).is_none());
        credentials.get_mut(origin).unwrap().role = Some("member".into());
        assert!(resume_credential(&credentials, origin).is_none());
        credentials.get_mut(origin).unwrap().role = Some("owner".into());
        credentials.get_mut(origin).unwrap().user_id = Some("bea".into());
        assert!(resume_credential(&credentials, origin).is_none());
        credentials.get_mut(origin).unwrap().user_id = None;
        credentials.get_mut(&key(origin)).unwrap().user_id = None;
        assert!(resume_credential(&credentials, origin).is_none());
        credentials.remove(origin);
        assert!(resume_credential(&credentials, origin).is_none());
    }

    #[test]
    fn worker_credentials_are_separate_for_every_origin() {
        assert_ne!(key("http://nest:8000"), "http://nest:8000");
        assert_ne!(key("http://nest:8000"), key("http://other:8000"));
        let mut credentials = BTreeMap::new();
        credentials.insert(
            "http://nest:8000".to_string(),
            Credential {
                token: "desktop".into(),
                ..Default::default()
            },
        );
        credentials.insert(
            key("http://nest:8000"),
            Credential {
                token: "worker".into(),
                device_id: Some("device".into()),
                ..Default::default()
            },
        );
        let decoded: BTreeMap<String, Credential> =
            serde_json::from_str(&serde_json::to_string(&credentials).unwrap()).unwrap();
        assert!(decoded["http://nest:8000"].token.is_empty());
        assert!(decoded[&key("http://nest:8000")].token.is_empty());
        assert_eq!(
            decoded[&key("http://nest:8000")].device_id.as_deref(),
            Some("device")
        );
    }
}
