//! The shell's connection owner. Transport is chosen once at startup; signals
//! reset its retry window, never infer reachability. One shared probe can be
//! awaited by both the retry task and the legacy bridge handshake.

use futures_util::{future::BoxFuture, FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::Instant;

use super::handshake::{probe_detailed, ProbeFailure};
use super::*;

pub(super) const GATE: Duration = Duration::from_secs(20);
const FAST: Duration = Duration::from_millis(500);
const MAX_BACKOFF: f64 = 30.0;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Unreachable,
    NeedsAuth,
    WrongNest,
    Unchosen,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LastError {
    RefusedRoute,
    NoNetwork,
    RefusedPort,
    ConnectionLost,
    Timeout,
    NotKrobi,
    BadBody,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Check {
    id: String,
    status: String,
    detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub(super) state: ConnectionState,
    /// Unix epoch milliseconds, changed only when entering a different state.
    since: u64,
    pub(super) attempt: u32,
    pub(super) last_error: Option<LastError>,
    checks: Vec<Check>,
}

impl Connection {
    pub(super) fn new(state: ConnectionState) -> Self {
        Self {
            state,
            since: epoch_ms(),
            attempt: 0,
            last_error: None,
            checks: checks(state, None, discovery::private_lan_ip()),
        }
    }
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn checks(state: ConnectionState, error: Option<LastError>, ip: Option<String>) -> Vec<Check> {
    use ConnectionState::*;
    use LastError::*;
    let answered = matches!(state, Connected | NeedsAuth | WrongNest);
    let route = match error {
        Some(ConnectionLost) => "warn",
        Some(RefusedRoute | NoNetwork | Timeout) if state == Connecting => "warn",
        Some(RefusedRoute | NoNetwork | Timeout) => "bad",
        Some(RefusedPort | NotKrobi | BadBody) => "ok",
        _ if answered => "ok",
        _ => "idle",
    };
    let krobi = match error {
        Some(RefusedPort | NotKrobi) => "bad",
        _ if answered => "ok",
        _ => "idle",
    };
    vec![
        Check {
            id: "this-computer".into(),
            status: if ip.is_some() { "ok" } else { "bad" }.into(),
            detail: ip,
        },
        Check {
            id: "route".into(),
            status: route.into(),
            detail: None,
        },
        Check {
            id: "krobi".into(),
            status: krobi.into(),
            detail: None,
        },
    ]
}

type Flight =
    futures_util::future::Shared<BoxFuture<'static, Result<ServerIdentity, ProbeFailure>>>;

pub(super) struct Retry {
    window: Instant,
    last_tick: SystemTime,
    pub(super) attempt: u32,
    next: Option<Instant>,
    backoff: f64,
    flight: Option<(u64, Flight)>,
    serial: u64,
    pub(super) last_reason: Option<String>,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            window: Instant::now(),
            last_tick: SystemTime::now(),
            attempt: 0,
            next: Some(Instant::now()),
            backoff: 1.0,
            flight: None,
            serial: 0,
            last_reason: None,
        }
    }
}

/// Jitter the capped base and clamp the actual sleep too (the cap is 30 s,
/// including jitter). `sample` is uniform in [0, 1).
fn backoff(base: f64, sample: f64) -> Duration {
    Duration::from_secs_f64((base.min(MAX_BACKOFF) * (0.8 + sample * 0.4)).min(MAX_BACKOFF))
}

enum Reset {
    Signal,
    AuthChanged,
    Failure(Option<LastError>),
}

impl DesktopState {
    /// The only writer of connection and its legacy projections. Publish under
    /// the runtime lock so concurrent reports cannot reorder status events.
    /// The production publisher queues them for emission outside this lock.
    pub(super) fn set_connection(
        &self,
        runtime: &mut Runtime,
        state: ConnectionState,
        error: Option<LastError>,
    ) {
        let state = if runtime.backend_is_remote
            && state == ConnectionState::Connecting
            && runtime.retry.window.elapsed() >= GATE
        {
            ConnectionState::Unreachable
        } else {
            state
        };
        let previous = runtime.server.connection.clone();
        let connection = &mut runtime.server.connection;
        if connection.state != state {
            log::debug!("nest connection {:?} -> {:?}", connection.state, state);
            connection.since = epoch_ms();
        }
        connection.attempt = runtime.retry.attempt;
        connection.state = state;
        connection.last_error = error;
        connection.checks = checks(state, error, discovery::private_lan_ip());
        runtime.server.reachable = state == ConnectionState::Connected;
        runtime.server.starting = state == ConnectionState::Connecting;
        self.events.update(runtime);
        if previous != runtime.server.connection {
            (self.status_changed)(&runtime.server);
        }
    }

    fn reset_locked(&self, runtime: &mut Runtime, reason: Reset) {
        use ConnectionState::*;
        if runtime.server.mode.as_deref() == Some("unchosen")
            || (runtime.server.connection.state == NeedsAuth
                && !matches!(reason, Reset::AuthChanged))
        {
            return;
        }
        runtime.retry.window = Instant::now();
        runtime.retry.backoff = 1.0;
        // A reset during a probe joins it; it must not queue another request.
        runtime.retry.next = runtime.retry.flight.is_none().then(Instant::now);
        runtime.retry.attempt = u32::from(runtime.retry.flight.is_some());
        let state = if runtime.server.connection.state == Connected
            && !matches!(reason, Reset::Failure(_))
        {
            Connected
        } else {
            Connecting
        };
        let error = match reason {
            Reset::Failure(error) => error,
            _ => runtime.server.connection.last_error,
        };
        self.set_connection(runtime, state, error);
        self.connection_wake.notify_one();
    }

    pub(crate) fn retry_connection(&self) {
        self.events.reset();
        let mut runtime = self.runtime_or_panic();
        if runtime.backend_is_remote {
            self.reset_locked(&mut runtime, Reset::Signal);
        }
    }

    pub(super) fn auth_changed(&self) {
        let mut runtime = self.runtime_or_panic();
        self.events.auth_changed(&runtime);
        self.reset_locked(&mut runtime, Reset::AuthChanged);
    }

    pub(super) fn report_auth(&self, status: u64) -> ShellResult<()> {
        if !matches!(status, 401 | 403) {
            return Err(ShellError::Guard("invalid-auth-status"));
        }
        let mut runtime = self.runtime()?;
        if runtime.server.connection.state != ConnectionState::Unchosen {
            runtime.retry.next = None;
            self.set_connection(&mut runtime, ConnectionState::NeedsAuth, None);
            self.connection_wake.notify_one();
        }
        Ok(())
    }

    pub(super) fn proxy_failure(&self, error: Option<LastError>) {
        let mut runtime = self.runtime_or_panic();
        if runtime.backend_is_remote
            && runtime.server.connection.state == ConnectionState::Connected
        {
            self.reset_locked(&mut runtime, Reset::Failure(error));
        }
    }

    /// Identity validation applies to *every* success path, including the
    /// legacy renderer probe. Never learn another household's instance id.
    pub(super) fn accept_probe(&self, runtime: &mut Runtime, found: &ServerIdentity) {
        // Every successful local /api/status path releases the handoff, even
        // a renderer probe that reaches the child before its startup watcher.
        // The backend resolves its secret store before serving this route.
        if !runtime.backend_is_remote {
            runtime.child_credentials = None;
        }
        if runtime.server.connection.state == ConnectionState::NeedsAuth {
            return;
        }
        let expected = runtime
            .preferences
            .nest_addresses
            .get(&runtime.configured_origin)
            .and_then(|entry| entry.instance_id.as_deref())
            .or(runtime.server.instance_id.as_deref());
        if runtime.backend_is_remote
            && expected.is_some_and(|id| Some(id) != found.instance_id.as_deref())
        {
            // Keep checking the selected transport: the expected nest may
            // return to this address. A mismatching answer is never learned.
            runtime.retry.next =
                Some(Instant::now() + backoff(runtime.retry.backoff, rand::random()));
            runtime.retry.backoff = (runtime.retry.backoff * 1.6).min(MAX_BACKOFF);
            self.set_connection(runtime, ConnectionState::WrongNest, None);
            return;
        }
        runtime.server.instance_id = found.instance_id.clone();
        runtime.server.name = found.name.clone().or_else(|| runtime.server.name.clone());
        runtime.server.pid = found.pid;
        runtime.server.identified = found.identified;
        runtime.server.problem = None;
        runtime.retry.next = None;
        self.set_connection(runtime, ConnectionState::Connected, None);
    }

    pub(super) async fn probe_current(&self) -> Result<ServerIdentity, ProbeFailure> {
        let (serial, flight) = {
            let mut runtime = self.runtime_or_panic();
            if matches!(
                runtime.server.connection.state,
                ConnectionState::NeedsAuth | ConnectionState::Unchosen
            ) {
                return Err(ProbeFailure {
                    code: None,
                    text: "probe paused".into(),
                });
            }
            if let Some(flight) = &runtime.retry.flight {
                flight.clone()
            } else {
                let http = self.http.clone();
                let origin = runtime.backend_origin.clone();
                let flight = async move { probe_detailed(&http, &origin).await }
                    .boxed()
                    .shared();
                runtime.retry.serial += 1;
                let serial = runtime.retry.serial;
                runtime.retry.flight = Some((serial, flight.clone()));
                runtime.retry.next = None;
                runtime.retry.attempt = runtime.retry.attempt.saturating_add(1);
                let current = runtime.server.connection.state;
                let error = runtime.server.connection.last_error;
                if current != ConnectionState::Connected {
                    self.set_connection(&mut runtime, current, error);
                }
                (serial, flight)
            }
        };
        let result = flight.await;
        let mut runtime = self.runtime_or_panic();
        // Only the first waiter publishes and schedules the next attempt.
        if runtime.retry.flight.as_ref().map(|(id, _)| *id) != Some(serial) {
            return result;
        }
        if SystemTime::now()
            .duration_since(runtime.retry.last_tick)
            .unwrap_or_default()
            >= Duration::from_secs(6)
        {
            self.credit_sleep(&mut runtime, SystemTime::now());
        }
        runtime.retry.flight = None;
        if runtime.server.connection.state == ConnectionState::NeedsAuth {
            return result;
        }
        match &result {
            Ok(found) => {
                let recovering = runtime.server.connection.state != ConnectionState::Connected;
                self.accept_probe(&mut runtime, found);
                if recovering && runtime.server.connection.state == ConnectionState::Connected {
                    log::info!(
                        "nest {} answered after {} ms",
                        super::http_log::url(&runtime.backend_origin),
                        runtime.retry.window.elapsed().as_millis()
                    );
                    runtime.retry.last_reason = None;
                }
            }
            Err(reason) => {
                if runtime.server.connection.state == ConnectionState::Connected {
                    self.reset_locked(&mut runtime, Reset::Failure(reason.code));
                    runtime.retry.attempt = 1;
                }
                if runtime.retry.last_reason.as_deref() != Some(&reason.text) {
                    log::warn!(
                        "nest {} still not answering after {} ms: {reason}",
                        super::http_log::url(&runtime.backend_origin),
                        runtime.retry.window.elapsed().as_millis()
                    );
                    runtime.retry.last_reason = Some(reason.text.clone());
                }
                let elapsed = runtime.retry.window.elapsed();
                let (state, delay) = if elapsed < GATE {
                    (ConnectionState::Connecting, FAST.min(GATE - elapsed))
                } else {
                    let delay = backoff(runtime.retry.backoff, rand::random());
                    runtime.retry.backoff = (runtime.retry.backoff * 1.6).min(MAX_BACKOFF);
                    (ConnectionState::Unreachable, delay)
                };
                runtime.retry.next = Some(Instant::now() + delay);
                self.set_connection(&mut runtime, state, reason.code);
            }
        }
        self.connection_wake.notify_one();
        self.cache_nest_identity(runtime);
        result
    }

    /// Only a validated answer can update the name beside the configured identity.
    pub(super) fn cache_nest_identity(&self, mut runtime: MutexGuard<'_, Runtime>) {
        if runtime.server.connection.state != ConnectionState::Connected {
            return;
        }
        let id = runtime.server.instance_id.clone();
        let name = runtime.server.name.clone();
        let key = runtime.configured_origin.clone();
        let entry = runtime.preferences.nest_addresses.entry(key).or_default();
        let changed = (id.is_some() && entry.instance_id != id) || entry.name != name;
        if changed {
            entry.instance_id = id;
            entry.name = name;
            if let Err(error) = self.save_preferences(runtime) {
                log::warn!("could not record the nest's identity: {error}");
            }
        }
    }

    fn credit_sleep(&self, runtime: &mut Runtime, now: SystemTime) {
        if now
            .duration_since(runtime.retry.last_tick)
            .unwrap_or_default()
            >= Duration::from_secs(6)
        {
            self.events.reset();
            self.reset_locked(runtime, Reset::Signal);
        }
        runtime.retry.last_tick = now;
    }

    pub(super) fn tick_connection(&self) {
        let mut runtime = self.runtime_or_panic();
        self.credit_sleep(&mut runtime, SystemTime::now());
        if !runtime.backend_is_remote {
            return;
        }
        if runtime.server.connection.state == ConnectionState::Connecting
            && runtime.retry.window.elapsed() >= GATE
        {
            let error = runtime.server.connection.last_error;
            self.set_connection(&mut runtime, ConnectionState::Unreachable, error);
        }
    }

    async fn run_connection(&self) {
        loop {
            let (next, gate) = {
                let mut runtime = self.runtime_or_panic();
                if SystemTime::now()
                    .duration_since(runtime.retry.last_tick)
                    .unwrap_or_default()
                    >= Duration::from_secs(6)
                {
                    self.credit_sleep(&mut runtime, SystemTime::now());
                }
                if runtime.server.connection.state == ConnectionState::Connecting
                    && runtime.retry.window.elapsed() >= GATE
                {
                    let error = runtime.server.connection.last_error;
                    self.set_connection(&mut runtime, ConnectionState::Unreachable, error);
                }
                (
                    runtime.retry.next,
                    (runtime.server.connection.state == ConnectionState::Connecting)
                        .then_some(runtime.retry.window + GATE),
                )
            };
            let deadline = match (next, gate) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            if let Some(deadline) = deadline {
                tokio::select! {
                    _ = self.connection_wake.notified() => continue,
                    _ = tokio::time::sleep_until(deadline) => {}
                }
                let due = self
                    .runtime_or_panic()
                    .retry
                    .next
                    .is_some_and(|at| at <= Instant::now());
                if due {
                    let _ = self.probe_current().await;
                }
            } else {
                self.connection_wake.notified().await;
            }
        }
    }
}

pub(super) fn watch_remote(app: AppHandle) {
    let owner = app.clone();
    tauri::async_runtime::spawn(async move {
        owner.state::<DesktopState>().run_connection().await;
    });
}

pub(super) fn watch_signals(app: AppHandle) {
    let wake = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            wake.state::<DesktopState>().tick_connection();
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            match if_watch::tokio::IfWatcher::new() {
                Ok(mut watcher) => {
                    while let Some(event) = watcher.next().await {
                        match event {
                            Ok(_) => app.state::<DesktopState>().retry_connection(),
                            Err(error) => {
                                log::warn!("network watcher failed: {error}");
                                break;
                            }
                        }
                    }
                }
                Err(error) => log::warn!("could not watch network changes: {error}"),
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

#[cfg(test)]
mod tests;
