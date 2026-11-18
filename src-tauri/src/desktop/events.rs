//! One authenticated change stream for the app, outside all JSON proxy slots.
use super::*;
use serde_json::json;
use tauri::Emitter;
use tokio::sync::watch;

#[derive(Clone, PartialEq, Eq)]
struct Session {
    origin: String,
    token: String,
    auth: u64,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct Config {
    session: Option<Session>,
    auth: u64,
    reset: u64,
    idle: String,
}

pub(super) struct Control {
    config: watch::Sender<Config>,
    snapshot: Mutex<Value>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            config: watch::channel(Config::default()).0,
            snapshot: Mutex::new(
                json!({"hello": null, "stream": {"state": "connecting", "since": epoch_ms()}}),
            ),
        }
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Control {
    pub(super) fn update(&self, runtime: &Runtime) {
        self.config.send_if_modified(|config| {
            let session = (!runtime.shutting_down
                && runtime.server.connection.state == ConnectionState::Connected
                && !runtime.token.is_empty())
            .then(|| Session {
                origin: runtime.backend_origin.clone(),
                token: runtime.token.clone(),
                auth: config.auth,
            });
            let idle = if runtime.token.is_empty()
                || runtime.server.connection.state == ConnectionState::NeedsAuth
            {
                "auth"
            } else if matches!(
                runtime.server.connection.state,
                ConnectionState::Unreachable
                    | ConnectionState::WrongNest
                    | ConnectionState::Unchosen
            ) {
                "lost"
            } else {
                "connecting"
            };
            if config.session == session && config.idle == idle {
                return false;
            }
            config.session = session;
            config.idle = idle.to_owned();
            self.snapshot.lock().unwrap_or_else(|e| e.into_inner())["hello"] = Value::Null;
            true
        });
    }

    pub(super) fn reset(&self) {
        self.config
            .send_modify(|config| config.reset = config.reset.wrapping_add(1));
    }

    pub(super) fn auth_changed(&self, runtime: &Runtime) {
        self.config
            .send_modify(|config| config.auth = config.auth.wrapping_add(1));
        self.update(runtime);
    }

    pub(super) fn snapshot(&self) -> Value {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn publish(&self, app: &AppHandle, channel: &str, payload: Value) {
        let mut snapshot = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        match channel {
            "server:hello" => snapshot["hello"] = payload.clone(),
            "server:changed" => {
                if let Some(revisions) = snapshot["hello"]["revisions"].as_object_mut() {
                    if let Some(area) = payload["area"].as_str() {
                        revisions.insert(area.to_owned(), payload["rev"].clone());
                    }
                }
            }
            "server:stream" => {
                if snapshot["stream"]["state"] == payload["state"] {
                    return;
                }
                snapshot["stream"] = payload.clone();
            }
            _ => {}
        }
        let _ = app.emit(channel, payload);
    }
}

/// Full jitter, including at the cap. A signal starts again at the first step.
fn backoff(attempt: u32, sample: f64) -> Duration {
    let cap = (1u64 << attempt.min(5)).min(30);
    Duration::from_secs_f64(cap as f64 * sample.clamp(0.0, 1.0))
}

#[derive(Default)]
struct Sse {
    line: Vec<u8>,
    event: String,
    data: Vec<String>,
    cr: bool,
    size: usize,
}

impl Sse {
    fn feed(&mut self, bytes: &[u8], emit: &mut impl FnMut(&str, Value)) -> Result<(), ()> {
        for &byte in bytes {
            // Bound an unfinished frame too; a broken peer cannot grow it forever.
            self.size += 1;
            if self.size > 256 * 1024 {
                return Err(());
            }
            if byte == b'\n' && self.cr {
                self.cr = false;
                continue;
            }
            self.cr = byte == b'\r';
            if byte == b'\r' || byte == b'\n' {
                let line = String::from_utf8(std::mem::take(&mut self.line)).map_err(|_| ())?;
                if line.is_empty() {
                    if !self.data.is_empty() {
                        let payload: Value =
                            serde_json::from_str(&self.data.join("\n")).map_err(|_| ())?;
                        match self.event.as_str() {
                            "hello"
                                if payload["bootId"].is_string()
                                    && payload["revisions"].is_object() =>
                            {
                                emit("server:hello", payload)
                            }
                            "change"
                                if payload["area"].is_string()
                                    && (payload["rev"].is_string() || payload["rev"].is_u64()) =>
                            {
                                emit("server:changed", payload)
                            }
                            // Heartbeats (and comments) keep the read deadline alive.
                            "heartbeat" => {}
                            _ => return Err(()),
                        }
                    }
                    self.event.clear();
                    self.data.clear();
                    self.size = 0;
                } else if let Some((field, value)) = line.split_once(':') {
                    let value = value.strip_prefix(' ').unwrap_or(value);
                    match field {
                        "event" => self.event = value.to_owned(),
                        "data" => self.data.push(value.to_owned()),
                        _ => {}
                    }
                }
            } else {
                self.line.push(byte);
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum End {
    Auth,
    Lost,
}

async fn receive(client: &Client, session: &Session, emit: &mut impl FnMut(&str, Value)) -> End {
    let request = client
        .get(format!(
            "{}/api/events",
            session.origin.trim_end_matches('/')
        ))
        .bearer_auth(&session.token)
        .header("Accept", "text/event-stream");
    let Ok(mut response) = request.send().await else {
        return End::Lost;
    };
    if matches!(response.status().as_u16(), 401 | 403) {
        return End::Auth;
    }
    if !response.status().is_success()
        || !response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"))
    {
        return End::Lost;
    }
    let mut parser = Sse::default();
    loop {
        // A total request timeout would kill a healthy long-lived stream.
        match tokio::time::timeout(Duration::from_secs(45), response.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                if parser
                    .feed(&bytes, &mut |channel, payload| {
                        if channel == "server:hello" {
                            emit(
                                "server:stream",
                                json!({"state":"connected", "since":epoch_ms()}),
                            );
                        }
                        emit(channel, payload);
                    })
                    .is_err()
                {
                    return End::Lost;
                }
            }
            _ => return End::Lost,
        }
    }
}

async fn run(
    client: Client,
    mut config: watch::Receiver<Config>,
    mut emit: impl FnMut(&str, Value),
) {
    let mut attempt = 0;
    loop {
        let current = config.borrow_and_update().clone();
        let Some(session) = current.session else {
            emit(
                "server:stream",
                json!({"state":if current.idle.is_empty() {"auth"} else {&current.idle}, "since":epoch_ms()}),
            );
            if config.changed().await.is_err() {
                return;
            }
            attempt = 0;
            continue;
        };
        emit(
            "server:stream",
            json!({"state":"connecting", "since":epoch_ms()}),
        );
        let mut received_hello = false;
        let end = {
            let latest = config.clone();
            let mut publish = |channel: &str, payload: Value| {
                let selected = latest.borrow();
                if selected.session.as_ref() != Some(&session) {
                    return;
                }
                if channel == "server:hello" {
                    received_hello = true;
                }
                emit(channel, payload);
            };
            let stream = receive(&client, &session, &mut publish);
            tokio::pin!(stream);
            loop {
                tokio::select! {
                    biased;
                    changed = config.changed() => {
                        if changed.is_err() { return; }
                        if config.borrow_and_update().session.as_ref() != Some(&session) { break None; }
                        // Focus/network/wake resets retries, without replacing a healthy stream.
                    }
                    end = &mut stream => break Some(end),
                }
            }
        };
        let Some(end) = end else {
            attempt = 0;
            continue;
        };
        emit(
            "server:stream",
            json!({"state":if end == End::Auth {"auth"} else {"lost"}, "since":epoch_ms()}),
        );
        if end == End::Auth {
            // Signals alone cannot repair rejected credentials.
            loop {
                if config.changed().await.is_err() {
                    return;
                }
                if config.borrow_and_update().session.as_ref() != Some(&session) {
                    break;
                }
            }
            attempt = 0;
            continue;
        }
        if received_hello {
            attempt = 0;
        }
        let delay = backoff(attempt, rand::random());
        attempt = attempt.saturating_add(1);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            changed = config.changed() => {
                if changed.is_err() { return; }
                attempt = 0;
            }
        }
    }
}

pub(crate) fn start(app: AppHandle) {
    connection::watch_signals(app.clone());
    let state = app.state::<DesktopState>();
    let client = state.http.event_client().expect("event HTTP client");
    state.events.update(&state.runtime_or_panic());
    let config = state.events.config.subscribe();
    tauri::async_runtime::spawn(async move {
        run(client, config, |channel, payload| {
            app.state::<DesktopState>()
                .events
                .publish(&app, channel, payload);
        })
        .await;
    });
}

#[cfg(test)]
mod tests;
