use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, Notify},
};

struct Server {
    origin: String,
    requests: Arc<AtomicUsize>,
    seen: Arc<Notify>,
    replies: mpsc::UnboundedSender<Option<Value>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn new(replies: impl IntoIterator<Item = Option<Value>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let seen = Arc::new(Notify::new());
        let notify = seen.clone();
        let (send, mut receive) = mpsc::unbounded_channel::<Option<Value>>();
        for reply in replies {
            send.send(reply).unwrap();
        }
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(socket.read_u8().await.unwrap());
                }
                assert!(header.starts_with(b"GET /api/me HTTP/1.1\r\n"));
                count.fetch_add(1, Ordering::SeqCst);
                notify.notify_one();
                let Some(reply) = receive.recv().await.unwrap() else {
                    // Close without a response to simulate a transport failure.
                    continue;
                };
                let body = reply.to_string();
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
        });
        Self {
            origin,
            requests,
            seen,
            replies: send,
            task,
        }
    }

    fn count(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn shell(origin: &str) -> DesktopState {
    let mut runtime = super::super::tests::remote_runtime(origin, origin);
    runtime.credentials.get_mut(origin).unwrap().user_id = None;
    DesktopState {
        app_dir: std::env::temp_dir().join(format!("krobi-backfill-{}", rand::random::<u64>())),
        http: Client::builder().no_proxy().build().unwrap(),
        runtime: Mutex::new(runtime),
        preferences_file: Mutex::new(()),
        connection_wake: Notify::new(),
        events: crate::desktop::events::Control::default(),
        status_changed: Box::new(|_| {}),
        offline: Mutex::new(offline::test_store()),
    }
}

type Messages = Mutex<Vec<(log::Level, String)>>;

async fn attempt(state: &DesktopState, messages: &Messages) -> Option<Value> {
    tokio::time::timeout(
        Duration::from_secs(2),
        backfill_identity_for_state(state, |level, message| {
            messages.lock().unwrap().push((level, message));
        }),
    )
    .await
    .expect("backfill did not finish")
}

#[tokio::test]
async fn consecutive_connected_statuses_log_each_skip_once_and_offline_does_not_force_it() {
    for body in [
        json!({"source": "local"}),
        json!({"source": "shared-secret"}),
        json!({"source": "token", "role": "owner"}),
        json!({"source": "token", "id": "account", "role": "unknown"}),
    ] {
        let server = Server::new([Some(body)]).await;
        let state = shell(&server.origin);
        let messages = Messages::default();
        // The emitter invokes this same core after each Connected status.
        for _ in 0..2 {
            assert_eq!(
                state.runtime().unwrap().server.connection.state,
                ConnectionState::Connected
            );
            assert!(attempt(&state, &messages).await.is_none());
        }
        assert!(matches!(
            offline::scope(&state.runtime().unwrap()),
            Err(ShellError::Guard("account-required"))
        ));
        // The account-required caller shares the guard and must not force HTTP.
        assert!(attempt(&state, &messages).await.is_none());
        assert_eq!(server.count(), 1);
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, log::Level::Debug);
        assert!(messages[0].1.contains("account backfill skipped for"));
    }
}

#[tokio::test]
async fn missing_credentials_and_empty_tokens_skip_once_without_http() {
    let server = Server::new([]).await;
    for (stored, token) in [(false, "env-token"), (false, ""), (true, "")] {
        let state = shell(&server.origin);
        {
            let mut runtime = state.runtime().unwrap();
            runtime.backend_is_remote = false;
            let credential = runtime.credentials.remove(&server.origin).unwrap();
            if stored {
                runtime.credentials.insert("local".into(), credential);
            }
            runtime.token = token.into();
        }
        let messages = Messages::default();
        attempt(&state, &messages).await;
        attempt(&state, &messages).await;
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].0, log::Level::Debug);
        assert!(messages[0]
            .1
            .starts_with("account backfill skipped for local:"));
    }
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn credential_set_and_clear_reset_only_that_keys_outcome() {
    let server = Server::new([
        Some(json!({"source": "local"})),
        Some(json!({"source": "shared-secret"})),
    ])
    .await;
    let state = shell(&server.origin);
    let messages = Messages::default();
    attempt(&state, &messages).await;
    {
        let mut runtime = state.runtime().unwrap();
        runtime
            .backfill
            .entry("other-nest".into())
            .or_default()
            .done = true;
        let mut credential = runtime.credentials[&server.origin].clone();
        credential.token = "new-token".into();
        // This is the mutation used by auth:set.
        runtime.set_credential(server.origin.clone(), credential);
        assert!(runtime.backfill["other-nest"].done);
    }
    attempt(&state, &messages).await;
    attempt(&state, &messages).await;
    assert_eq!(server.count(), 2);
    {
        let mut runtime = state.runtime().unwrap();
        // This is the mutation used by auth:clear.
        runtime.clear_credential(&server.origin);
        assert!(runtime.backfill["other-nest"].done);
    }
    attempt(&state, &messages).await;
    attempt(&state, &messages).await;
    assert_eq!(server.count(), 2);
    assert_eq!(messages.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn network_errors_retry_warn_once_then_record_the_account_once() {
    let server = Server::new([
        None,
        None,
        Some(json!({"source": "token", "id": "account", "role": "member"})),
    ])
    .await;
    let state = shell(&server.origin);
    let messages = Messages::default();
    assert!(attempt(&state, &messages).await.is_none());
    assert!(attempt(&state, &messages).await.is_none());
    assert_eq!(server.count(), 2);
    assert_eq!(messages.lock().unwrap().len(), 1);
    let identity = attempt(&state, &messages).await.unwrap();
    assert_eq!(identity["userId"], "account");
    attempt(&state, &messages).await;
    assert_eq!(server.count(), 3);
    let messages = messages.lock().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].0, log::Level::Warn);
    assert!(messages[0]
        .1
        .starts_with("could not read this desktop's account:"));
    assert_eq!(messages[1].0, log::Level::Info);
    assert!(messages[1]
        .1
        .starts_with("this desktop's account recorded for"));
    std::fs::remove_dir_all(&state.app_dir).unwrap();
}

#[tokio::test]
async fn overlapping_calls_share_an_attempt_and_stale_responses_cannot_finish_new_credentials() {
    let server = Server::new([]).await;
    let state = Arc::new(shell(&server.origin));
    let messages = Arc::new(Messages::default());
    let pending = {
        let state = state.clone();
        let messages = messages.clone();
        tokio::spawn(async move { attempt(&state, &messages).await })
    };
    tokio::time::timeout(Duration::from_secs(2), server.seen.notified())
        .await
        .unwrap();
    assert!(attempt(&state, &messages).await.is_none());
    assert_eq!(server.count(), 1);
    {
        let mut runtime = state.runtime().unwrap();
        // Even a sign-in with the same token must invalidate the old response.
        let credential = runtime.credentials[&server.origin].clone();
        runtime.set_credential(server.origin.clone(), credential);
    }
    server
        .replies
        .send(Some(json!({"source": "local"})))
        .unwrap();
    assert!(pending.await.unwrap().is_none());
    assert!(messages.lock().unwrap().is_empty());
    server
        .replies
        .send(Some(json!({"source": "shared-secret"})))
        .unwrap();
    attempt(&state, &messages).await;
    attempt(&state, &messages).await;
    assert_eq!(server.count(), 2);
    assert_eq!(messages.lock().unwrap().len(), 1);
}

#[test]
fn auth_events_never_contain_the_credential_but_auth_get_does() {
    let state = shell("http://nest.example");
    state.runtime().unwrap().token = "planted-secret-credential".into();
    let identity = auth_identity(&state.runtime().unwrap());
    let mut events = Vec::new();
    auth_change_events(identity.clone(), |channel, payload| {
        assert!(!payload.to_string().contains("planted-secret-credential"));
        assert!(payload.get("token").is_none());
        events.push((channel.to_owned(), payload));
    });
    assert_eq!(
        events,
        vec![
            ("auth:changed".into(), identity),
            ("auth-changed".into(), json!({"changed": true}))
        ]
    );
    assert_eq!(
        auth_get(&state).unwrap()["token"],
        "planted-secret-credential"
    );
    state.runtime().unwrap().token.clear();
    assert_eq!(auth_get(&state).unwrap()["token"], "");
}
