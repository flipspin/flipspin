use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const HELLO: &str = "event: hello\ndata: {\"bootId\":\"boot\",\"revisions\":{\"library\":1}}\n\n";
type Message = (String, Value);

async fn server(
    status: u16,
) -> (
    String,
    mpsc::UnboundedReceiver<String>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    if socket.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                let stream = request.starts_with("GET /api/events ");
                tx.send(request).unwrap();
                if stream {
                    let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{HELLO}");
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        return;
                    }
                }
                let mut byte = [0];
                let _ = socket.read(&mut byte).await;
                let _ = tx.send("closed".into());
            });
        }
    });
    (origin, rx, task)
}
fn config(origin: &str) -> Config {
    Config {
        session: Some(Session {
            origin: origin.into(),
            token: "fixture-token".into(),
            auth: 0,
        }),
        ..Config::default()
    }
}
fn holder(
    origin: &str,
) -> (
    watch::Sender<Config>,
    mpsc::UnboundedReceiver<Message>,
    tokio::task::JoinHandle<()>,
) {
    let (tx, rx) = watch::channel(config(origin));
    let (events, messages) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        Client::new().event_client().unwrap(),
        rx,
        move |channel, value| {
            let _ = events.send((channel.into(), value));
        },
    ));
    (tx, messages, task)
}
async fn message(rx: &mut mpsc::UnboundedReceiver<Message>, channel: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (name, value) = rx.recv().await.unwrap();
            if name == channel {
                return value;
            }
        }
    })
    .await
    .unwrap()
}

#[test]
fn backoff_is_full_jitter_exponential_and_capped() {
    assert_eq!(backoff(0, 0.0), Duration::ZERO);
    assert_eq!(backoff(0, 0.5), Duration::from_millis(500));
    assert_eq!(backoff(2, 0.5), Duration::from_secs(2));
    assert_ne!(backoff(5, 0.2), backoff(5, 0.8));
    assert_eq!(backoff(u32::MAX, 1.0), Duration::from_secs(30));
}

#[test]
fn parser_handles_split_utf8_crlf_comments_and_contract_frames() {
    let cases: Value =
        serde_json::from_str(include_str!("../../../../contracts/change-events.json")).unwrap();
    let frame = format!("event: hello\r\ndata: {}\r\n\r\n: heartbeat\r\n\r\nevent: heartbeat\ndata: {{}}\n\nevent: change\ndata: {}\n\nevent: change\ndata: {{\"area\":\"lyrics\",\"rev\":2,\"ids\":[\"canción\"]}}\n\n", cases["hello"]["data"], cases["change"]["data"]);
    let mut parser = Sse::default();
    let mut events = Vec::new();
    for byte in frame.bytes() {
        parser
            .feed(&[byte], &mut |channel, value| {
                events.push((channel.to_owned(), value))
            })
            .unwrap();
    }
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0],
        ("server:hello".into(), cases["hello"]["data"].clone())
    );
    assert_eq!(
        events[1],
        ("server:changed".into(), cases["change"]["data"].clone())
    );
    assert_eq!(events[2].1["ids"][0], "canción");
}

#[test]
fn parser_bounds_unfinished_frames() {
    assert!(Sse::default()
        .feed(&vec![b'x'; 256 * 1024 + 1], &mut |_, _| {})
        .is_err());
}

#[tokio::test]
async fn stream_receives_with_sixteen_json_requests_in_flight() {
    let (origin, mut requests, server) = server(200).await;
    let mut json = Vec::new();
    for _ in 0..16 {
        let origin = origin.clone();
        json.push(tokio::spawn(async move {
            let _permit = super::super::proxy::budget::acquire(&origin, false).await;
            let _response = Client::new().get(format!("{origin}/api/jobs")).send().await;
        }));
    }
    for _ in 0..16 {
        assert!(requests.recv().await.unwrap().starts_with("GET /api/jobs "));
    }
    let (config, mut messages, stream) = holder(&origin);
    assert_eq!(
        message(&mut messages, "server:hello").await["bootId"],
        "boot"
    );
    assert!(requests
        .recv()
        .await
        .unwrap()
        .contains("authorization: Bearer fixture-token"));
    assert!(json.iter().all(|request| !request.is_finished()));
    // Stream lifetime holds no JSON slot: releasing one admits another JSON request.
    json.pop().unwrap().abort();
    let slot = tokio::time::timeout(
        Duration::from_secs(1),
        super::super::proxy::budget::acquire(&origin, false),
    )
    .await
    .unwrap();
    drop(slot);
    drop(config);
    stream.abort();
    server.abort();
    for request in json {
        request.abort();
    }
}

#[tokio::test]
async fn auth_failure_never_retries_on_focus_or_network_signals() {
    for status in [401, 403] {
        let (origin, mut requests, server) = server(status).await;
        let (config, mut messages, stream) = holder(&origin);
        assert_eq!(
            message(&mut messages, "server:stream").await["state"],
            "connecting"
        );
        assert_eq!(
            message(&mut messages, "server:stream").await["state"],
            "auth"
        );
        assert!(requests
            .recv()
            .await
            .unwrap()
            .starts_with("GET /api/events "));
        while requests.try_recv().is_ok() {}
        for _ in 0..3 {
            config.send_modify(|config| config.reset += 1);
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        while let Ok(request) = requests.try_recv() {
            assert!(!request.starts_with("GET"));
        }
        config.send_modify(|config| config.session.as_mut().unwrap().token = "new-token".into());
        assert_eq!(
            message(&mut messages, "server:stream").await["state"],
            "connecting"
        );
        stream.abort();
        server.abort();
    }
}

#[tokio::test]
async fn signout_closes_stream_and_server_switch_replaces_it() {
    let (origin, mut requests, server) = server(200).await;
    let (config, mut messages, stream) = holder(&origin);
    message(&mut messages, "server:hello").await;
    requests.recv().await.unwrap();
    config.send_modify(|config| config.session = None);
    assert_eq!(
        message(&mut messages, "server:stream").await["state"],
        "auth"
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), requests.recv())
            .await
            .unwrap()
            .unwrap(),
        "closed"
    );
    let (other, mut other_requests, other_server) = self::server(200).await;
    config.send_replace(self::config(&other));
    message(&mut messages, "server:hello").await;
    assert!(other_requests
        .recv()
        .await
        .unwrap()
        .starts_with("GET /api/events "));
    stream.abort();
    server.abort();
    other_server.abort();
}

#[tokio::test]
async fn three_missed_heartbeats_drop_stream_and_a_signal_resets_backoff() {
    let (origin, mut requests, server) = server(200).await;
    let (config, mut messages, stream) = holder(&origin);
    message(&mut messages, "server:hello").await;
    requests.recv().await.unwrap();
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(46)).await;
    assert_eq!(
        message(&mut messages, "server:stream").await["state"],
        "lost"
    );
    config.send_modify(|config| config.reset += 1);
    tokio::task::yield_now().await;
    assert_eq!(
        message(&mut messages, "server:stream").await["state"],
        "connecting"
    );
    stream.abort();
    server.abort();
}
