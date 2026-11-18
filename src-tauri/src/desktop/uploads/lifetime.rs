//! Upload activity stays independent of persisted receipts and helper activity.
use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

pub(crate) struct UploadLifetime {
    pub(super) control: Mutex<Control>,
    pub(super) changed: tokio::sync::watch::Sender<u64>,
    activity: Arc<crate::keep_awake::Activity>,
    last_scope: Mutex<Option<(String, Scope)>>,
    awake: Arc<AtomicBool>,
    unsupported: Arc<AtomicBool>,
    cancellation_epoch: AtomicU64,
}
#[derive(Default)]
pub(super) struct Control {
    pub asleep: bool,
    pub manual: bool,
    pub hidden: bool,
    pub confirming: bool,
    pub quitting: bool,
    pub sending: Option<(String, u64, u64)>,
}
impl UploadLifetime {
    pub(crate) fn new() -> std::io::Result<Self> {
        Ok(Self::with_activity(crate::keep_awake::Activity::new()?))
    }
    fn with_activity(activity: crate::keep_awake::Activity) -> Self {
        let (changed, _) = tokio::sync::watch::channel(0);
        Self {
            control: Mutex::default(),
            changed,
            activity: Arc::new(activity),
            last_scope: Mutex::default(),
            awake: Arc::new(AtomicBool::new(false)),
            unsupported: Arc::new(AtomicBool::new(false)),
            cancellation_epoch: AtomicU64::new(0),
        }
    }
    fn exit_decision(&self, explicit_quit: bool) -> QuitDecision {
        match self.control.lock() {
            Ok(mut control) => quit_decision(&mut control, explicit_quit),
            Err(poisoned) => {
                // A stale confirmation flag after a panic must not prevent cleanup.
                let mut control = poisoned.into_inner();
                control.quitting = true;
                control.confirming = false;
                self.cancel();
                QuitDecision::Exit
            }
        }
    }
    pub(crate) fn shutdown(&self) {
        self.control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .quitting = true;
        self.cancel();
    }
    pub(super) fn cancellation_epoch(&self) -> u64 {
        self.cancellation_epoch.load(Ordering::SeqCst)
    }
    pub(super) fn cancel(&self) {
        self.cancellation_epoch.fetch_add(1, Ordering::SeqCst);
        self.finish_send();
    }
    fn finish_send(&self) {
        self.changed
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        self.activity.set(false);
        self.awake.store(false, Ordering::SeqCst);
    }
    pub(super) fn awake(&self) -> Value {
        if self.unsupported.load(Ordering::SeqCst) {
            json!("unsupported")
        } else {
            json!(self.awake.load(Ordering::SeqCst))
        }
    }
    pub(super) fn sending(&self, id: String, offset: u64, total: u64) -> Sending<'_> {
        let mut control = self
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !control.asleep && !control.manual && !control.quitting {
            control.sending = Some((id, offset, total));
        }
        Sending(self)
    }
    /// The keep-awake assertion covers body transmission after connection and ends
    /// when the body drains, even while the server response remains pending.
    pub(super) fn body(&self, bytes: Vec<u8>, enabled: bool) -> reqwest::Body {
        let control = self
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let enabled = enabled && !control.asleep && !control.manual && !control.quitting;
        let context = MotionContext {
            activity: self.activity.clone(),
            awake: self.awake.clone(),
            unsupported: self.unsupported.clone(),
            changed: self.changed.subscribe(),
        };
        let stream = futures_util::stream::unfold(
            (Some(bytes), None::<Motion>, context),
            move |(bytes, held, context)| async move {
                match bytes {
                    Some(bytes) => {
                        let held = Motion::start(&context, enabled);
                        Some((Ok::<_, std::io::Error>(bytes), (None, Some(held), context)))
                    }
                    None => {
                        drop(held);
                        None
                    }
                }
            },
        );
        reqwest::Body::wrap_stream(stream)
    }
    #[cfg(test)]
    fn motion(&self, enabled: bool) -> Motion {
        let control = self
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Motion::start(
            &MotionContext {
                activity: self.activity.clone(),
                awake: self.awake.clone(),
                unsupported: self.unsupported.clone(),
                changed: self.changed.subscribe(),
            },
            enabled && !control.asleep && !control.manual && !control.quitting,
        )
    }
}
struct MotionContext {
    activity: Arc<crate::keep_awake::Activity>,
    awake: Arc<AtomicBool>,
    unsupported: Arc<AtomicBool>,
    changed: tokio::sync::watch::Receiver<u64>,
}
struct Motion {
    activity: Arc<crate::keep_awake::Activity>,
    awake: Arc<AtomicBool>,
    changed: tokio::sync::watch::Receiver<u64>,
    generation: u64,
}
impl Motion {
    fn start(context: &MotionContext, enabled: bool) -> Self {
        if enabled && !context.changed.has_changed().unwrap_or(true) {
            let held = context.activity.set(true);
            context.unsupported.store(!held, Ordering::SeqCst);
            context.awake.store(held, Ordering::SeqCst);
            // A pause or sleep during acquisition invalidates the new keep-awake assertion.
            if context.changed.has_changed().unwrap_or(true) {
                context.activity.set(false);
                context.awake.store(false, Ordering::SeqCst);
            }
        }
        Self {
            activity: context.activity.clone(),
            awake: context.awake.clone(),
            changed: context.changed.clone(),
            generation: *context.changed.borrow(),
        }
    }
}
impl Drop for Motion {
    fn drop(&mut self) {
        // A cancelled HTTP task can retain its body until after the next send.
        // Its cleanup must not release that newer send's assertion.
        if *self.changed.borrow() == self.generation && !self.changed.has_changed().unwrap_or(true)
        {
            self.activity.set(false);
            self.awake.store(false, Ordering::SeqCst);
        }
    }
}
pub(super) struct Sending<'a>(&'a UploadLifetime);
impl Drop for Sending<'_> {
    fn drop(&mut self) {
        let mut control = self
            .0
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.0.finish_send();
        control.sending = None;
    }
}
pub(crate) fn keep_awake(app: &AppHandle) -> bool {
    app.state::<DesktopState>()
        .runtime()
        .map(|r| r.preferences.upload_keep_awake.unwrap_or(true))
        .unwrap_or(true)
}
pub(super) fn active(batch: &Batch) -> bool {
    batch.confirmed && !batch.stopped && batch.view["phase"] != "terminado"
}
pub(super) fn queue_scope(app: &AppHandle) -> Option<Scope> {
    let state = app.state::<DesktopState>();
    let runtime = state.runtime().ok()?;
    let lifetime = app.state::<UploadLifetime>();
    let mut last = lifetime
        .last_scope
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Ok(scope) = super::super::offline::scope(&runtime) {
        *last = Some((runtime.configured_origin.clone(), scope.clone()));
        return Some(scope);
    }
    // Sign-out preserves this session's queue visibility; a different nest or
    // signed-in account cannot reuse the previous account's scope.
    last.as_ref()
        .filter(|(origin, _)| origin == &runtime.configured_origin && runtime.token.is_empty())
        .map(|(_, scope)| scope.clone())
}
pub(super) fn batches(app: &AppHandle) -> Vec<Batch> {
    queue_scope(app)
        .and_then(|scope| app.state::<UploadStore>().all(&scope).ok())
        .unwrap_or_default()
}
pub(crate) fn summary(app: &AppHandle) -> Value {
    let batches = batches(app);
    let active = batches.iter().any(active);
    let (mut sent, mut total) = (0u64, 0u64);
    for batch in &batches {
        if !self::active(batch) {
            continue;
        }
        if let Some(files) = batch.view["files"].as_array() {
            for file in files {
                let bytes = file["bytes"].as_u64().unwrap_or(0);
                total = total.saturating_add(bytes);
                sent = sent.saturating_add(
                    if matches!(file["state"].as_str(), Some("agregada" | "ya-estaba")) {
                        bytes
                    } else {
                        file["offset"].as_u64().unwrap_or(0)
                    },
                );
            }
        }
    }
    let lifetime = app.state::<UploadLifetime>();
    let control = lifetime
        .control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    json!({"active":active,"keepAwake":keep_awake(app),"awake":lifetime.awake(),
        "manual":control.manual,"asleep":control.asleep,"percent":sent.saturating_mul(100).checked_div(total).unwrap_or(0)})
}
pub(super) fn snapshot(app: &AppHandle, batch: &Batch) -> Value {
    let mut view = batch.display_view();
    let lifetime = app.state::<UploadLifetime>();
    let control = lifetime
        .control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    view["keepAwake"] = json!(keep_awake(app));
    view["awake"] = if control
        .sending
        .as_ref()
        .is_some_and(|(id, _, _)| id == &batch.id)
    {
        lifetime.awake()
    } else if lifetime.unsupported.load(Ordering::SeqCst) {
        json!("unsupported")
    } else {
        json!(false)
    };
    view["sendingPaused"] = json!(control.manual);
    if active(batch) {
        if control.asleep {
            view["paused"] = json!("asleep");
        } else if let Err(error) = authority(&app.state::<DesktopState>(), batch) {
            view["paused"] = json!(match error.to_string().as_str() {
                "signed-out" | "account-required" => "signed-out",
                "no-network" => "no-network",
                _ => "nest-unreachable",
            });
        }
    }
    view
}
pub(crate) fn pause(app: &AppHandle, paused: bool) {
    let lifetime = app.state::<UploadLifetime>();
    {
        let mut control = lifetime
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        control.manual = paused;
        lifetime.cancel();
    }
    publish(app);
}
pub(super) fn publish(app: &AppHandle) {
    for batch in batches(app) {
        emit(app, &batch);
    }
    crate::worker_tray::refresh(app);
}
/// Native and fake observers share the same lifecycle transition.
#[cfg(any(target_os = "macos", test))]
pub(super) fn sleep_transition(
    control: &mut Control,
    sleeping: bool,
    mut effect: impl FnMut(&str),
) {
    control.asleep = sleeping;
    if sleeping {
        effect("cancel");
        effect("goodbye");
    } else {
        effect("reconnect");
    }
}
#[cfg(target_os = "macos")]
pub(crate) fn sleep(app: &AppHandle, sleeping: bool) {
    let lifetime = app.state::<UploadLifetime>();
    {
        let mut control = lifetime
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sleep_transition(&mut control, sleeping, |effect| match effect {
            "cancel" => lifetime.cancel(),
            "goodbye" => {
                #[cfg(target_os = "macos")]
                crate::lyrics::signal_sleep(app);
            }
            "reconnect" => {
                lifetime.cancel();
                app.state::<DesktopState>().retry_connection();
            }
            _ => unreachable!(),
        });
    }
    publish(app);
}
pub(super) fn should_hide(active: bool, enabled: bool) -> bool {
    active && enabled
}
fn handle_close(
    control: &mut Control,
    active: bool,
    enabled: bool,
    hide: impl FnOnce() -> bool,
) -> bool {
    if should_hide(active, enabled) && hide() {
        control.hidden = true;
        return true;
    }
    false
}
pub(crate) fn close(app: &AppHandle) -> bool {
    let status = summary(app);
    let hidden = handle_close(
        &mut app
            .state::<UploadLifetime>()
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        status["active"] == true,
        status["keepAwake"] == true,
        || {
            app.get_webview_window("main")
                .is_some_and(|window| window.hide().is_ok())
        },
    );
    if hidden {
        crate::worker_tray::refresh(app);
    }
    hidden
}
pub(crate) fn opened(app: &AppHandle) {
    app.state::<UploadLifetime>()
        .control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .hidden = false;
}
pub(super) fn should_exit(control: &Control, active: bool, enabled: bool) -> bool {
    control.hidden && (!active || !enabled) && !control.quitting && !control.confirming
}
pub(crate) fn drain(app: &AppHandle) {
    let status = summary(app);
    let lifetime = app.state::<UploadLifetime>();
    let mut control = lifetime
        .control
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if should_exit(
        &control,
        status["active"] == true,
        status["keepAwake"] == true,
    ) {
        control.quitting = true;
        app.exit(0);
    }
}
#[derive(Debug, PartialEq)]
enum QuitDecision {
    Exit,
    Prevent,
    Confirm { offset: u64, total: u64 },
}
fn quit_decision(control: &mut Control, explicit_quit: bool) -> QuitDecision {
    if !explicit_quit {
        return QuitDecision::Exit;
    }
    if control.quitting {
        return QuitDecision::Exit;
    }
    if control.confirming {
        return QuitDecision::Prevent;
    }
    if let Some((_, offset, total)) = &control.sending {
        control.confirming = true;
        return QuitDecision::Confirm {
            offset: *offset,
            total: *total,
        };
    }
    QuitDecision::Exit
}
/// A true result prevents exit; repeated quit requests share one confirmation prompt.
pub(crate) fn confirm_exit(app: &AppHandle, explicit_quit: bool) -> bool {
    let lifetime = app.state::<UploadLifetime>();
    let decision = lifetime.exit_decision(explicit_quit);
    let (offset, total) = match decision {
        QuitDecision::Exit => return false,
        QuitDecision::Prevent => return true,
        QuitDecision::Confirm { offset, total } => (offset, total),
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = rfd::MessageDialog::new().set_title("Quit Flipspin?")
            .set_description(format!("The upload stops at {offset} of {total} bytes and picks up from there next time you open Flipspin."))
            .set_buttons(rfd::MessageButtons::OkCancelCustom("Keep uploading".into(), "Quit".into())).show();
        let lifetime = app.state::<UploadLifetime>();
        let quit = result == rfd::MessageDialogResult::Custom("Quit".into());
        {
            let mut control = lifetime
                .control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            control.confirming = false;
            control.quitting = quit;
        }
        if quit {
            app.exit(0);
        }
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    struct Held(Arc<AtomicUsize>);
    impl Drop for Held {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    fn fake() -> (UploadLifetime, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let activity = crate::keep_awake::Activity::with_acquire(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(Held(observed.clone())))
        })
        .unwrap();
        (UploadLifetime::with_activity(activity), count)
    }
    #[test]
    fn receipt_survives_completed_chunks_but_not_rapid_pause_and_wake() {
        let (lifetime, _) = fake();
        let epoch = lifetime.cancellation_epoch();
        drop(lifetime.sending("batch".into(), 0, 10));
        assert_eq!(lifetime.cancellation_epoch(), epoch);
        lifetime.cancel(); // Pause while the worker persists the successful chunk.
        lifetime.cancel(); // Wake before its next pass.
        assert_ne!(lifetime.cancellation_epoch(), epoch);
    }

    #[cfg(unix)]
    #[test]
    fn poisoned_upload_lifetime_allows_exit_and_still_stops_owned_child() {
        use crate::desktop::{nest_process::ChildTree, tests::remote_runtime};
        let (lifetime, _) = fake();
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut control = lifetime.control.lock().unwrap();
            control.confirming = true;
            control.sending = Some(("batch".into(), 1, 10));
            panic!("planted upload lifetime poison");
        }));
        assert!(panic.is_err());
        let mut command = std::process::Command::new("sleep");
        command.arg("30");
        let child = ChildTree::spawn(&mut command).unwrap();
        let pid = child.id();
        let mut runtime = remote_runtime("https://nest.example", "https://nest.example");
        runtime.child = Some(child);
        let state = DesktopState {
            app_dir: PathBuf::new(),
            http: Client::new(),
            runtime: Mutex::new(runtime),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(super::super::super::offline::test_store()),
        };
        // The same decision gates the real quit callback before stop_child.
        if lifetime.exit_decision(true) == QuitDecision::Exit {
            lifetime.shutdown();
            state.begin_shutdown();
            assert!(state.is_shutting_down());
            assert!(state.runtime().unwrap().child.is_some());
            state.stop_child();
        }
        assert!(state.runtime().unwrap().shutting_down);
        assert!(state.runtime().unwrap().child.is_none());
        // SAFETY: signal zero only checks whether our former child still exists.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        // Destructors and reporting must recover too, even after exit was accepted.
        drop(lifetime.sending("batch".into(), 1, 10));
        assert!(lifetime.control.is_poisoned());
    }

    #[test]
    fn inhibitor_only_held_while_sending_and_released_for_every_stop() {
        let (lifetime, count) = fake();
        assert_eq!(
            count.load(Ordering::SeqCst),
            0,
            "review/network wait must not inhibit"
        );
        for cause in ["pause", "network-wait", "stop", "done", "quit"] {
            let sending = lifetime.sending("batch".into(), 1, 10);
            let moving = lifetime.motion(true);
            assert_eq!(count.load(Ordering::SeqCst), 1, "{cause}");
            assert_eq!(lifetime.awake(), true);
            if cause != "done" {
                if cause == "quit" {
                    lifetime.shutdown();
                } else {
                    lifetime.cancel();
                }
                assert_eq!(
                    count.load(Ordering::SeqCst),
                    0,
                    "cancel releases before the request ends"
                );
            }
            drop(moving);
            assert_eq!(
                count.load(Ordering::SeqCst),
                0,
                "body drain releases before the reply"
            );
            drop(sending);
            assert_eq!(count.load(Ordering::SeqCst), 0, "{cause}");
            assert_eq!(lifetime.awake(), false);
        }
        let sending = lifetime.sending("batch".into(), 1, 10);
        let moving = lifetime.motion(false);
        assert_eq!(count.load(Ordering::SeqCst), 0, "switch off");
        drop(moving);
        drop(sending);
        for asleep in [true, false] {
            let mut control = lifetime
                .control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            control.asleep = asleep;
            control.manual = !asleep;
            drop(control);
            let sending = lifetime.sending("batch".into(), 1, 10);
            let moving = lifetime.motion(true);
            assert_eq!(count.load(Ordering::SeqCst), 0, "paused must not acquire");
            drop(moving);
            drop(sending);
        }
    }
    #[test]
    fn old_body_cleanup_cannot_release_a_resumed_send() {
        let (lifetime, count) = fake();
        let old = lifetime.motion(true);
        lifetime.cancel();
        let resumed = lifetime.motion(true);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(old);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(resumed);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn body_drain_releases_while_server_withholds_its_reply() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/upload", listener.local_addr().unwrap());
        let (ready, received) = std::sync::mpsc::channel();
        let (finish, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"0\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(String::from_utf8_lossy(&request).contains("bytes"));
            ready.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let (lifetime, count) = fake();
        tauri::async_runtime::block_on(async {
            let http = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let sending = lifetime.sending("batch".into(), 0, 5);
            let body = lifetime.body(b"bytes".to_vec(), true);
            let send = super::super::send_body(
                &http,
                &url,
                "test-token",
                0,
                format!("{:x}", Sha256::digest(b"bytes")),
                body,
            );
            let observe = async {
                tauri::async_runtime::spawn_blocking(move || {
                    received.recv_timeout(Duration::from_secs(5)).unwrap()
                })
                .await
                .unwrap();
                assert_eq!(
                    count.load(Ordering::SeqCst),
                    0,
                    "network reply wait must not inhibit"
                );
                assert_eq!(lifetime.awake(), false);
                assert!(
                    lifetime
                        .control
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .sending
                        .is_some(),
                    "Quit still confirms an unacknowledged send"
                );
                finish.send(()).unwrap();
            };
            let (result, _) = tokio::join!(send, observe);
            result.unwrap();
            drop(sending);
        });
        server.join().unwrap();
    }
    #[test]
    fn cancelling_the_upload_future_releases_before_goodbye() {
        let (lifetime, count) = fake();
        tauri::async_runtime::block_on(async {
            let changed = lifetime.changed.subscribe();
            let work = async {
                let _sending = lifetime.sending("batch".into(), 1, 10);
                let _moving = lifetime.motion(true);
                std::future::pending::<()>().await;
            };
            let sleep = async {
                tokio::task::yield_now().await;
                assert_eq!(count.load(Ordering::SeqCst), 1);
                let mut control = lifetime
                    .control
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                sleep_transition(&mut control, true, |effect| {
                    if effect == "cancel" {
                        lifetime.cancel();
                    }
                    if effect == "goodbye" {
                        assert_eq!(count.load(Ordering::SeqCst), 0);
                    }
                });
            };
            let (result, _) = tokio::join!(super::super::interruptible(changed, work), sleep);
            assert!(result.is_none());
            assert!(lifetime
                .control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .sending
                .is_none());
        });
    }
    #[test]
    fn missing_inhibitor_is_unsupported_and_does_not_stop_upload() {
        let activity =
            crate::keep_awake::Activity::with_acquire(|| Err(std::io::Error::other("no logind")))
                .unwrap();
        let lifetime = UploadLifetime::with_activity(activity);
        let sending = lifetime.sending("batch".into(), 0, 10);
        let moving = lifetime.motion(true);
        assert_eq!(lifetime.awake(), "unsupported");
        drop(moving);
        drop(sending);
    }
    #[test]
    fn fake_sleep_observer_cancels_releases_sends_goodbye_then_reconnects() {
        let (lifetime, count) = fake();
        let sending = lifetime.sending("batch".into(), 1, 10);
        let moving = lifetime.motion(true);
        let mut events = vec![];
        {
            let mut control = lifetime
                .control
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sleep_transition(&mut control, true, |effect| {
                if effect == "cancel" {
                    lifetime.cancel();
                }
                if effect == "goodbye" {
                    assert_eq!(count.load(Ordering::SeqCst), 0);
                }
                events.push(effect.to_string());
            });
            assert!(control.asleep);
            sleep_transition(&mut control, false, |effect| {
                events.push(effect.to_string())
            });
            assert!(!control.asleep);
        }
        assert_eq!(events, ["cancel", "goodbye", "reconnect"]);
        drop(moving);
        drop(sending);
    }
    #[test]
    fn fake_window_hides_only_active_enabled_and_exits_when_drained_hidden() {
        for active in [false, true] {
            for enabled in [false, true] {
                let mut control = Control::default();
                let mut hides = 0;
                let hidden = handle_close(&mut control, active, enabled, || {
                    hides += 1;
                    true
                });
                assert_eq!(hidden, active && enabled);
                assert_eq!(hides, usize::from(active && enabled));
                if hidden {
                    assert!(!should_exit(&control, true, true));
                    assert!(should_exit(&control, false, true));
                    assert!(should_exit(&control, true, false));
                    control.hidden = false; // A visible app prevents automatic exit.
                    assert!(!should_exit(&control, false, true));
                }
            }
        }
        assert!(!handle_close(&mut Control::default(), true, true, || false));
    }
    #[test]
    fn quit_asks_once_only_during_a_send() {
        let mut control = Control::default();
        assert_eq!(quit_decision(&mut control, true), QuitDecision::Exit);
        control.sending = Some(("batch".into(), 3, 10));
        assert_eq!(
            quit_decision(&mut control, false),
            QuitDecision::Exit,
            "closing with the switch off quits immediately"
        );
        assert!(!control.confirming);
        assert_eq!(
            quit_decision(&mut control, true),
            QuitDecision::Confirm {
                offset: 3,
                total: 10
            }
        );
        for _ in 0..3 {
            assert_eq!(quit_decision(&mut control, true), QuitDecision::Prevent);
        }
        control.confirming = false; // "Keep uploading" permits another quit confirmation.
        assert!(matches!(
            quit_decision(&mut control, true),
            QuitDecision::Confirm { .. }
        ));
        control.confirming = false;
        control.quitting = true;
        assert_eq!(quit_decision(&mut control, true), QuitDecision::Exit);
        control.quitting = false;
        control.sending = None;
        assert_eq!(quit_decision(&mut control, true), QuitDecision::Exit);
    }
}
