use super::*;
use serde_json::json;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, Semaphore},
};

type Events = Arc<Mutex<Vec<ServerStatus>>>;

fn shell(origin: &str, expected: Option<&str>) -> (Arc<DesktopState>, Events) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let publish = events.clone();
    let mut preferences = Preferences::default();
    preferences
        .nest_addresses
        .entry(origin.into())
        .or_default()
        .instance_id = expected.map(str::to_owned);
    let state = DesktopState {
        app_dir: {
            let dir =
                std::env::temp_dir().join(format!("krobi-startup-test-{}", rand::random::<u64>()));
            std::fs::create_dir_all(&dir).unwrap();
            dir
        },
        http: Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        runtime: Mutex::new(Runtime {
            preferences,
            credentials: BTreeMap::new(),
            credential_storage: credentials::Storage::test_memory(),
            backfill: BTreeMap::new(),
            child_credentials: None,
            backend_origin: origin.into(),
            configured_origin: origin.into(),
            backend_is_remote: true,
            backend_locked: false,
            token: String::new(),
            server: ServerStatus {
                mode: Some("external".into()),
                base_url: Some(origin.into()),
                port: None,
                pid: None,
                instance_id: None,
                name: None,
                identified: false,
                reachable: false,
                adopted: false,
                problem: None,
                starting: true,
                lan_url: None,
                via: Some(origin.into()),
                connection: Connection::new(ConnectionState::Connecting),
            },
            child: None,
            child_build_id: None,
            adopted_child: None,
            shutting_down: false,
            last_player_state: None,
            retry: Retry::default(),
        }),
        preferences_file: Mutex::new(()),
        offline: Mutex::new(offline::test_store()),
        connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
        // Same publication seam as app.emit("server:status-changed", status).
        status_changed: Box::new(move |status| publish.lock().unwrap().push(status.clone())),
    };
    (Arc::new(state), events)
}

async fn serve(
    listener: TcpListener,
    body: &'static str,
    gate: Option<Arc<Semaphore>>,
) -> (tokio::task::JoinHandle<()>, mpsc::UnboundedReceiver<()>) {
    let (sent, received) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let sent = sent.clone();
            let gate = gate.clone();
            tokio::spawn(async move {
                let mut request = [0; 2048];
                let count = stream.read(&mut request).await.unwrap();
                assert!(String::from_utf8_lossy(&request[..count]).starts_with("GET /api/status "));
                let _ = sent.send(());
                if let Some(gate) = gate {
                    let _permit = gate.acquire().await.unwrap();
                }
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (task, received)
}

async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(4), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition within four seconds");
}

fn state(shell: &DesktopState) -> ConnectionState {
    shell.runtime_or_panic().server.connection.state
}

#[test]
fn os_errors_and_checks_are_machine_readable_and_ordered() {
    use LastError::*;
    let cases = [
        (65, RefusedRoute, "warn", "bad", "idle"),
        (51, NoNetwork, "warn", "bad", "idle"),
        (61, RefusedPort, "ok", "ok", "bad"),
        (60, Timeout, "warn", "bad", "idle"),
        (54, ConnectionLost, "warn", "warn", "idle"),
        (32, ConnectionLost, "warn", "warn", "idle"),
        (53, ConnectionLost, "warn", "warn", "idle"),
        (104, ConnectionLost, "warn", "warn", "idle"),
        (103, ConnectionLost, "warn", "warn", "idle"),
        (10054, ConnectionLost, "warn", "warn", "idle"),
        (10053, ConnectionLost, "warn", "warn", "idle"),
        (113, RefusedRoute, "warn", "bad", "idle"),
        (101, NoNetwork, "warn", "bad", "idle"),
        (111, RefusedPort, "ok", "ok", "bad"),
        (110, Timeout, "warn", "bad", "idle"),
        (10065, RefusedRoute, "warn", "bad", "idle"),
        (10051, NoNetwork, "warn", "bad", "idle"),
        (10061, RefusedPort, "ok", "ok", "bad"),
        (10060, Timeout, "warn", "bad", "idle"),
    ];
    for (errno, code, connecting_route, offline_route, krobi) in cases {
        assert_eq!(
            super::super::handshake::classify_io_error(&io::Error::from_raw_os_error(errno)),
            Some(code)
        );
        for (state, route) in [
            (ConnectionState::Connecting, connecting_route),
            (ConnectionState::Unreachable, offline_route),
        ] {
            let rows = checks(state, Some(code), Some("en0: 192.168.1.2".into()));
            assert_eq!(
                rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
                ["this-computer", "route", "krobi"]
            );
            assert_eq!(rows[0].status, "ok");
            assert_eq!(rows[0].detail.as_deref(), Some("en0: 192.168.1.2"));
            assert_eq!(rows[1].status, route);
            assert_eq!(rows[2].status, krobi);
        }
    }
    assert_eq!(
        checks(ConnectionState::Connecting, Some(NotKrobi), None)[2].status,
        "bad"
    );
    assert_eq!(
        checks(ConnectionState::Connecting, Some(BadBody), None)[2].status,
        "idle"
    );
    assert_eq!(
        checks(ConnectionState::Connected, None, None)[0].status,
        "bad"
    );
    assert!(
        checks(ConnectionState::Connected, None, Some("192.168.1.2".into()))
            .iter()
            .all(|row| row.status == "ok")
    );
    for (kind, code) in [
        (io::ErrorKind::ConnectionRefused, RefusedPort),
        (io::ErrorKind::TimedOut, Timeout),
        (io::ErrorKind::ConnectionReset, ConnectionLost),
        (io::ErrorKind::ConnectionAborted, ConnectionLost),
        (io::ErrorKind::UnexpectedEof, ConnectionLost),
        (io::ErrorKind::BrokenPipe, ConnectionLost),
        (io::ErrorKind::HostUnreachable, RefusedRoute),
        (io::ErrorKind::NetworkUnreachable, NoNetwork),
    ] {
        assert_eq!(
            super::super::handshake::classify_io_error(&io::Error::from(kind)),
            Some(code)
        );
    }
}

#[tokio::test]
async fn refused_first_probe_retries_and_publishes_connected_exactly_once() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let origin = format!("http://{address}");
    drop(listener);
    let (shell, events) = shell(&origin, Some("home"));
    let failure = shell.probe_current().await.unwrap_err();
    assert_eq!(failure.code, Some(LastError::RefusedPort));
    assert!(failure.text.contains("os error"), "{}", failure.text);
    assert_eq!(state(&shell), ConnectionState::Connecting);
    let listener = TcpListener::bind(address).await.unwrap();
    let (server, _) = serve(listener, r#"{"app":"krobi","instanceId":"home"}"#, None).await;
    let run = shell.clone();
    let owner = tokio::spawn(async move {
        run.run_connection().await;
    });
    until(|| state(&shell) == ConnectionState::Connected).await;
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.connection.state == ConnectionState::Connected)
            .count(),
        1
    );
    let status = shell.runtime_or_panic().server.clone();
    assert_eq!(status.connection.attempt, 2);
    assert!(status.reachable && !status.starting);
    owner.abort();
    server.abort();
}

#[tokio::test]
async fn repeated_resets_and_bridge_waiter_join_one_inflight_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let gate = Arc::new(Semaphore::new(0));
    let (server, mut requests) = serve(
        listener,
        r#"{"app":"krobi","instanceId":"home"}"#,
        Some(gate.clone()),
    )
    .await;
    let (shell, events) = shell(&origin, Some("home"));
    let run = shell.clone();
    let owner = tokio::spawn(async move {
        run.run_connection().await;
    });
    requests.recv().await.unwrap();
    for _ in 0..10 {
        shell.retry_connection();
    }
    let join = shell.clone();
    let waiter = tokio::spawn(async move { join.probe_current().await });
    tokio::task::yield_now().await;
    assert!(requests.try_recv().is_err());
    gate.add_permits(1);
    waiter.await.unwrap().unwrap();
    until(|| state(&shell) == ConnectionState::Connected).await;
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert!(requests.try_recv().is_err(), "reset queued a second probe");
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.connection.state == ConnectionState::Connected)
            .count(),
        1
    );
    assert_eq!(shell.runtime_or_panic().server.connection.attempt, 1);
    owner.abort();
    server.abort();
}

#[tokio::test]
async fn wrong_instance_never_connects_or_relearns_the_household() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (server, _) = serve(listener, r#"{"app":"krobi","instanceId":"stranger"}"#, None).await;
    let (shell, events) = shell(&origin, Some("home"));
    shell.probe_current().await.unwrap();
    assert_eq!(state(&shell), ConnectionState::WrongNest);
    assert!(!shell.runtime_or_panic().server.reachable);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .all(|s| s.connection.state != ConnectionState::Connected));
    assert_eq!(
        shell.runtime_or_panic().preferences.nest_addresses[&origin]
            .instance_id
            .as_deref(),
        Some("home")
    );
    assert_eq!(shell.runtime_or_panic().server.instance_id, None);
    // Resetting does not waive identity validation.
    shell.retry_connection();
    shell.probe_current().await.unwrap();
    assert_eq!(state(&shell), ConnectionState::WrongNest);
    server.abort();
}

#[tokio::test]
async fn needs_auth_ignores_inflight_success_and_resets_until_credentials_change() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let gate = Arc::new(Semaphore::new(0));
    let (server, mut requests) = serve(
        listener,
        r#"{"app":"krobi","instanceId":"home"}"#,
        Some(gate.clone()),
    )
    .await;
    let (shell, _) = shell(&origin, Some("home"));
    let run = shell.clone();
    let owner = tokio::spawn(async move {
        run.run_connection().await;
    });
    requests.recv().await.unwrap();
    assert!(shell.report_auth(500).is_err());
    shell.report_auth(401).unwrap();
    gate.add_permits(1);
    until(|| shell.runtime_or_panic().retry.flight.is_none()).await;
    for _ in 0..5 {
        shell.retry_connection();
    }
    assert!(shell.probe_current().await.is_err());
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(state(&shell), ConnectionState::NeedsAuth);
    assert!(requests.try_recv().is_err());
    shell.auth_changed(); // same hook invoked by auth:set/auth:clear before auth:changed
    requests.recv().await.unwrap();
    until(|| state(&shell) == ConnectionState::Connected).await;
    shell.report_auth(403).unwrap();
    assert_eq!(state(&shell), ConnectionState::NeedsAuth);
    owner.abort();
    server.abort();
}

#[test]
fn backoff_growth_and_jitter_remain_within_bounds_including_the_cap() {
    let mut base: f64 = 1.0;
    let expected = [
        1.0, 1.6, 2.56, 4.096, 6.5536, 10.48576, 16.777216, 26.8435456, 30.0,
    ];
    for next in expected {
        assert!((base - next).abs() < 0.000001);
        base = (base * 1.6).min(MAX_BACKOFF);
    }
    for base in expected.into_iter().chain([30.0; 100]) {
        for sample in [0.0, 0.1, 0.5, 0.9, 1.0] {
            let seconds = backoff(base, sample).as_secs_f64();
            assert!(seconds >= base * 0.8 - 1e-9 && seconds <= base * 1.2 + 1e-9);
            assert!(seconds <= 30.0);
        }
        assert_ne!(backoff(base, 0.0), backoff(base, 1.0));
    }
}

#[tokio::test(start_paused = true)]
async fn gate_expires_but_retries_have_no_give_up_and_wake_credits_sleep() {
    let (shell, _) = shell("http://127.0.0.1:1", Some("home"));
    tokio::time::advance(GATE).await;
    shell.tick_connection();
    assert_eq!(state(&shell), ConnectionState::Unreachable);
    // Inject the probe result at the shared-flight seam, avoiding real sockets
    // under a frozen clock. The actual retry scheduler is exercised above.
    tokio::time::advance(Duration::from_secs(600)).await;
    {
        let mut runtime = shell.runtime_or_panic();
        runtime.retry.flight = Some((
            7,
            async {
                Err(ProbeFailure {
                    code: Some(LastError::RefusedRoute),
                    text: "No route to host (os error 65)".into(),
                })
            }
            .boxed()
            .shared(),
        ));
    }
    shell.probe_current().await.unwrap_err();
    assert_eq!(state(&shell), ConnectionState::Unreachable);
    assert!(shell.runtime_or_panic().retry.next.is_some());
    {
        let mut runtime = shell.runtime_or_panic();
        let now = runtime.retry.last_tick + Duration::from_secs(6);
        shell.credit_sleep(&mut runtime, now);
        assert_eq!(runtime.server.connection.state, ConnectionState::Connecting);
        assert!(runtime.server.starting);
        assert_eq!(runtime.retry.window, Instant::now());
        assert_eq!(runtime.retry.backoff, 1.0);
        assert_eq!(runtime.retry.next, Some(Instant::now()));
    }
}

#[test]
fn legacy_flags_and_additive_wire_fields_follow_every_state() {
    let (shell, _) = shell("http://127.0.0.1:1", None);
    for state in [
        ConnectionState::Connecting,
        ConnectionState::Connected,
        ConnectionState::Unreachable,
        ConnectionState::NeedsAuth,
        ConnectionState::WrongNest,
        ConnectionState::Unchosen,
    ] {
        let mut runtime = shell.runtime_or_panic();
        shell.set_connection(&mut runtime, state, None);
        assert_eq!(
            runtime.server.reachable,
            state == ConnectionState::Connected
        );
        assert_eq!(
            runtime.server.starting,
            state == ConnectionState::Connecting
        );
        let wire = serde_json::to_value(&runtime.server).unwrap();
        for key in [
            "mode",
            "baseUrl",
            "port",
            "pid",
            "instanceId",
            "name",
            "identified",
            "reachable",
            "adopted",
            "problem",
            "starting",
            "lanUrl",
            "via",
            "connection",
        ] {
            assert!(wire.get(key).is_some(), "{key}");
        }
        assert_eq!(wire["connection"]["state"], json!(state));
        assert!(wire["connection"]["since"].as_u64().unwrap() > 1_700_000_000_000);
        assert!(wire["connection"].get("lastError").is_some());
    }
}

#[test]
fn proxy_failure_opens_one_window_and_does_not_sign_out_or_extend_it() {
    let (shell, _) = shell("http://127.0.0.1:1", None);
    {
        let mut runtime = shell.runtime_or_panic();
        shell.set_connection(&mut runtime, ConnectionState::Connected, None);
    }
    shell.proxy_failure(Some(LastError::Timeout));
    assert_eq!(state(&shell), ConnectionState::Connecting);
    let window = shell.runtime_or_panic().retry.window;
    shell.proxy_failure(Some(LastError::RefusedPort));
    assert_eq!(shell.runtime_or_panic().retry.window, window);
    shell.report_auth(403).unwrap();
    shell.proxy_failure(Some(LastError::NoNetwork));
    assert_eq!(state(&shell), ConnectionState::NeedsAuth);
}

#[tokio::test]
async fn invalid_handshakes_are_not_krobi_or_bad_body() {
    for (body, code) in [
        (r#"{"app":"other"}"#, LastError::NotKrobi),
        ("{broken", LastError::BadBody),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (server, _) = serve(listener, body, None).await;
        let (shell, _) = shell(&origin, None);
        assert_eq!(shell.probe_current().await.unwrap_err().code, Some(code));
        assert_eq!(
            shell.runtime_or_panic().server.connection.last_error,
            Some(code)
        );
        server.abort();
    }
}

#[tokio::test]
async fn startup_rejects_a_stranger_and_still_picks_a_matching_alternate() {
    let primary = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let configured = format!("http://{}", primary.local_addr().unwrap());
    let (server, _) = serve(primary, r#"{"app":"krobi","instanceId":"stranger"}"#, None).await;
    let (shell, events) = shell(&configured, Some("home"));
    let run = shell.clone();
    let origin = configured.clone();
    tokio::task::spawn_blocking(move || run.connect_remote(&origin))
        .await
        .unwrap();
    assert_eq!(state(&shell), ConnectionState::WrongNest);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .all(|status| !status.reachable));
    assert_eq!(
        shell.runtime_or_panic().preferences.nest_addresses[&configured]
            .instance_id
            .as_deref(),
        Some("home")
    );
    let alternate = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let via = format!("http://{}", alternate.local_addr().unwrap());
    let (other, _) = serve(alternate, r#"{"app":"krobi","instanceId":"home"}"#, None).await;
    shell
        .runtime_or_panic()
        .preferences
        .nest_addresses
        .get_mut(&configured)
        .unwrap()
        .network = Some(super::super::prefs::NestNetwork {
        lan: vec![via.clone()],
        ..Default::default()
    });
    let run = shell.clone();
    tokio::task::spawn_blocking(move || run.connect_remote(&configured))
        .await
        .unwrap();
    assert_eq!(state(&shell), ConnectionState::Connected);
    assert_eq!(shell.runtime_or_panic().backend_origin, via);
    server.abort();
    other.abort();
}

#[tokio::test]
async fn a_stalled_probe_is_a_network_timeout_and_never_needs_auth() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let gate = Arc::new(Semaphore::new(0));
    let (server, _) = serve(
        listener,
        r#"{"app":"krobi","instanceId":"home"}"#,
        Some(gate),
    )
    .await;
    let (shell, _) = shell(&origin, Some("home"));
    assert_eq!(
        shell.probe_current().await.unwrap_err().code,
        Some(LastError::Timeout)
    );
    assert_eq!(state(&shell), ConnectionState::Connecting);
    let status = shell.runtime_or_panic().server.clone();
    assert_eq!(status.connection.last_error, Some(LastError::Timeout));
    assert_eq!(status.connection.checks[1].status, "warn");
    server.abort();
}

#[tokio::test]
async fn validated_name_is_learned_cached_before_the_next_answer_and_can_be_renamed() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (server, _) = serve(
        listener,
        r#"{"app":"krobi","instanceId":"home","name":"  Nido de casa  "}"#,
        None,
    )
    .await;
    let (shell, events) = shell(&origin, None);
    shell.probe_current().await.unwrap();
    assert_eq!(
        shell.runtime_or_panic().server.name.as_deref(),
        Some("Nido de casa")
    );
    assert_eq!(
        events.lock().unwrap().last().unwrap().name.as_deref(),
        Some("Nido de casa")
    );
    let cached: Preferences = read_json(&shell.preferences_path());
    assert_eq!(cached.nest_name(&origin).as_deref(), Some("Nido de casa"));
    assert_eq!(
        cached.nest_addresses[&origin].instance_id.as_deref(),
        Some("home")
    );
    assert_eq!(cached.nest_name("http://other.test"), None);
    // This is the startup read, with no probe response or live server.
    server.abort();
    {
        let mut runtime = shell.runtime_or_panic();
        runtime.server.name = cached.nest_name(&origin);
        runtime.server.connection = Connection::new(ConnectionState::Connecting);
        assert_eq!(runtime.server.name.as_deref(), Some("Nido de casa"));
        shell.accept_probe(
            &mut runtime,
            &ServerIdentity {
                instance_id: Some("stranger".into()),
                name: Some("Other household".into()),
                ..Default::default()
            },
        );
        assert_eq!(runtime.server.connection.state, ConnectionState::WrongNest);
        assert_eq!(runtime.server.name.as_deref(), Some("Nido de casa"));
        shell.cache_nest_identity(runtime);
    }
    assert_eq!(
        read_json::<Preferences>(&shell.preferences_path())
            .nest_name(&origin)
            .as_deref(),
        Some("Nido de casa")
    );
    {
        let mut runtime = shell.runtime_or_panic();
        shell.accept_probe(
            &mut runtime,
            &ServerIdentity {
                instance_id: Some("home".into()),
                name: Some("Nido nuevo".into()),
                ..Default::default()
            },
        );
        shell.cache_nest_identity(runtime);
    }
    assert_eq!(
        read_json::<Preferences>(&shell.preferences_path())
            .nest_name(&origin)
            .as_deref(),
        Some("Nido nuevo")
    );
    {
        let mut runtime = shell.runtime_or_panic();
        shell.accept_probe(
            &mut runtime,
            &ServerIdentity {
                instance_id: Some("home".into()),
                ..Default::default()
            },
        );
        assert_eq!(runtime.server.name.as_deref(), Some("Nido nuevo"));
    }
    std::fs::remove_dir_all(&shell.app_dir).unwrap();
}

#[tokio::test]
async fn connect_error_without_errno_and_a_closed_connection_have_a_code_and_safe_log_text() {
    for tls in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!(
            "{}://{}",
            if tls { "https" } else { "http" },
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).await;
            if tls {
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                    .await;
            }
            // Plain HTTP closes before headers; TLS gets a non-TLS answer.
        });
        let http = Client::builder().no_proxy().build().unwrap();
        let error = http
            .get(format!("{origin}/?token=fixture-request-secret"))
            .send()
            .await
            .unwrap_err();
        let failure = super::super::handshake::describe_request_error(&error);
        assert_eq!(failure.code, Some(LastError::ConnectionLost), "{error:?}");
        assert!(!failure.text.is_empty());
        if tls {
            assert!(error.is_connect());
        }
        if tls {
            assert!(failure.text.contains("InvalidContentType"));
        } else {
            assert!(failure.text.starts_with("request"));
            assert!(!failure.text.contains("fixture-request-secret"));
            assert!(failure.text.contains("redacted"));
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn child_handoff_lives_until_a_valid_status_response_including_renderer_probes() {
    for (body, ready) in [
        (r#"{"app":"krobi","instanceId":"local-nest"}"#, true),
        (r#"{"app":"other"}"#, false),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let gate = Arc::new(Semaphore::new(0));
        let (server, mut requests) = serve(listener, body, Some(gate.clone())).await;
        let (shell, _) = shell(&origin, None);
        let handoff =
            super::super::private_file::CredentialDirectory::new("fixture-child-key").unwrap();
        let path = handoff.path().to_owned();
        {
            let mut runtime = shell.runtime_or_panic();
            runtime.backend_is_remote = false;
            runtime.child_credentials = Some(handoff);
        }
        let request = shell.clone();
        let probe = tokio::spawn(async move { request.probe_current().await });
        requests.recv().await.unwrap();
        assert!(
            path.join("krobi-key").exists(),
            "retain until a valid response"
        );
        gate.add_permits(1);
        assert_eq!(probe.await.unwrap().is_ok(), ready);
        assert_eq!(path.exists(), !ready);
        // No Tauri app and no OS vault: the same accept_probe path is shared
        // by the renderer's server:probe and the child watcher.
        shell.runtime_or_panic().child_credentials = None;
        server.abort();
        std::fs::remove_dir_all(&shell.app_dir).unwrap();
    }
}

#[test]
fn child_handoff_is_released_on_status_acceptance_even_when_auth_is_needed() {
    for needs_auth in [false, true] {
        let (shell, _) = shell("http://127.0.0.1:8000", None);
        let handoff =
            super::super::private_file::CredentialDirectory::new("fixture-child-key").unwrap();
        let path = handoff.path().to_owned();
        let mut runtime = shell.runtime_or_panic();
        runtime.backend_is_remote = false;
        runtime.child_credentials = Some(handoff);
        if needs_auth {
            runtime.server.connection.state = ConnectionState::NeedsAuth;
        }
        assert!(path.join("krobi-key").exists());
        shell.accept_probe(&mut runtime, &ServerIdentity::default());
        assert!(!path.exists());
        assert!(runtime.child_credentials.is_none());
        if needs_auth {
            assert_eq!(runtime.server.connection.state, ConnectionState::NeedsAuth);
        }
        drop(runtime);
        std::fs::remove_dir_all(&shell.app_dir).unwrap();
    }
}
