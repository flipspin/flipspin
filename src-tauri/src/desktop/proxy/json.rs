//! Raw backend IPC replies and authenticated JSON or multipart forwarding.

use super::*;

/// Return raw bytes to avoid double JSON encoding and preserve binary bodies.
/// Frame with a four-byte big-endian header length, JSON status/headers, then
/// body bytes; decodeBackendReply reads this layout in the renderer.
fn backend_reply(
    ok: bool,
    status: u16,
    status_text: &str,
    headers: Map<String, Value>,
    body: &[u8],
) -> tauri::ipc::Response {
    let header = serde_json::to_vec(&json!({
        "ok": ok,
        "status": status,
        "statusText": status_text,
        "headers": headers,
    }))
    .unwrap_or_default();
    let mut out = Vec::with_capacity(4 + header.len() + body.len());
    out.extend_from_slice(&(header.len() as u32).to_be_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(body);
    tauri::ipc::Response::new(out)
}

#[tauri::command]
pub async fn backend_request(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    request: BackendRequest,
) -> ShellResult<tauri::ipc::Response> {
    use tauri::Emitter;
    execute(window.label(), &state, request, || {
        let _ = app.emit("offline:changed", ());
    })
    .await
}

async fn execute(
    window: &str,
    state: &DesktopState,
    request: BackendRequest,
    changed: impl Fn(),
) -> ShellResult<tauri::ipc::Response> {
    let mut cancellation = request
        .request_id
        .as_deref()
        .map(|id| cancel::Request::take(window, id))
        .transpose()?;
    let future = forward(state, request, changed);
    match cancellation.as_mut() {
        Some(cancellation) => cancellation.run(future).await,
        None => future.await,
    }
}

async fn forward(
    state: &DesktopState,
    request: BackendRequest,
    changed: impl Fn(),
) -> ShellResult<tauri::ipc::Response> {
    let (allowed_origin, token) = {
        let runtime = state.runtime()?;
        (runtime.backend_origin.clone(), runtime.token.clone())
    };
    let target = Url::parse(&request.url)?;
    let allowed = Url::parse(&allowed_origin)?;
    if !is_backend_url(&target, &allowed) {
        return Ok(backend_reply(
            false,
            0,
            "blocked-non-backend-url",
            Map::new(),
            b"",
        ));
    }
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|error| ShellError::Message(error.to_string()))?;
    let offline_scope = {
        let runtime = state.runtime()?;
        crate::desktop::offline::scope(&runtime).ok()
    };
    let local = {
        let runtime = state.runtime()?;
        if crate::desktop::offline::connection_state(&runtime.server) == "wrong-nest" {
            return Err(ShellError::Guard("wrong-nest"));
        }
        crate::desktop::offline::offline_now(&runtime)
    };
    if local {
        let scope = offline_scope
            .as_ref()
            .ok_or(ShellError::Guard("account-required"))?;
        let path = target
            .path()
            .strip_prefix(allowed.path().trim_end_matches('/'))
            .unwrap_or("");
        let response = crate::desktop::offline::offline_request(
            state,
            scope,
            path,
            method.as_str(),
            request.body.as_deref(),
            &request.headers,
        )?;
        if method != reqwest::Method::GET {
            changed();
        }
        let bytes = serde_json::to_vec(&response)?;
        return Ok(backend_reply(true, 200, "OK", Map::new(), &bytes));
    }
    let library_delete = method == reqwest::Method::DELETE
        && target
            .path()
            .strip_prefix(allowed.path().trim_end_matches('/'))
            == Some("/api/me/library");
    let removed_keys = if library_delete {
        request
            .body
            .as_deref()
            .and_then(|b| serde_json::from_str::<Value>(b).ok())
            .and_then(|v| v["relPaths"].as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let session_request = target
        .path()
        .strip_prefix(allowed.path().trim_end_matches('/'))
        == Some("/api/me");
    let log_path = target
        .path()
        .strip_prefix(allowed.path().trim_end_matches('/'))
        .unwrap_or("")
        .to_owned();
    let mut builder = state.http.request(method.clone(), target);
    let mut has_auth = false;
    for (name, value) in request.headers {
        if name.eq_ignore_ascii_case("authorization") {
            has_auth = true;
        }
        builder = builder.header(&name, &value);
    }
    if !has_auth && !token.is_empty() {
        builder = builder.bearer_auth(token);
    }
    if let Some(bytes) = request.body_bytes {
        builder = builder.body(bytes);
    } else if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let _slot = budget::acquire(&allowed_origin, false).await;
    match builder.send().await {
        Ok(response) => {
            crate::desktop::http_log::proxy_received(
                &allowed_origin,
                &method,
                &log_path,
                &response,
            );
            let status = response.status();
            if matches!(status.as_u16(), 502..=504) {
                state.proxy_failure(None);
            }
            if let Some(scope) = offline_scope.as_ref() {
                if let Ok(mut offline) = lock(&state.offline, "offline") {
                    if status.is_success() && library_delete {
                        for key in &removed_keys {
                            offline
                                .store
                                .remove_library_track(scope, key)
                                .map_err(|e| ShellError::Message(e.to_string()))?;
                        }
                        offline
                            .store
                            .sweep_pending()
                            .map_err(|e| ShellError::Message(e.to_string()))?;
                    }
                    if session_request && matches!(status.as_u16(), 401 | 403) {
                        offline
                            .store
                            .revoke(scope)
                            .map_err(|e| ShellError::Message(e.to_string()))?;
                    }
                }
            }
            let headers: Map<String, Value> = response
                .headers()
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (key.to_string(), Value::String(value.to_string())))
                })
                .collect();
            let diagnostic = crate::desktop::http_log::response(&response);
            let body = match response.bytes().await {
                Ok(body) => body,
                Err(error) => {
                    crate::desktop::http_log::proxy_body_failed(
                        &allowed_origin,
                        status.as_u16(),
                        &format!(
                            "HTTP body failed: {diagnostic}: {}",
                            crate::desktop::http_log::error(&error)
                        ),
                    );
                    return Ok(backend_reply(false, 0, "BODY_ERROR", headers, b""));
                }
            };
            crate::desktop::http_log::proxy_completed(&allowed_origin, status.as_u16());
            Ok(backend_reply(
                status.is_success(),
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                headers,
                &body,
            ))
        }
        Err(error) => {
            crate::desktop::http_log::proxy_failed(
                &allowed_origin,
                &crate::desktop::http_log::error(&error),
            );
            state.proxy_failure(crate::desktop::handshake::describe_request_error(&error).code);
            Ok(backend_reply(
                false,
                0,
                "NETWORK_ERROR",
                Map::new(),
                error.to_string().as_bytes(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn state(origin: &str) -> DesktopState {
        DesktopState {
            app_dir: PathBuf::new(),
            http: Client::builder().no_proxy().build().unwrap(),
            runtime: Mutex::new(crate::desktop::tests::remote_runtime(origin, origin)),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(crate::desktop::offline::test_store()),
        }
    }

    async fn until(check: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !check() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("socket state did not converge");
    }

    fn request(origin: &str, id: &str) -> BackendRequest {
        serde_json::from_value(
            json!({"url": format!("{origin}/api/lyrics/A/song.mp3"), "requestId": id}),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn local_proxy_sends_the_loopback_host_authority() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let origin = format!("http://{authority}");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
            }
            let raw = String::from_utf8(bytes).unwrap().to_ascii_lowercase();
            assert!(raw.contains(&format!("\r\nhost: {authority}\r\n")));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        forward(&state(&origin), request(&origin, "host-check"), || {})
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn json_and_media_share_one_outage_and_recovery_summary() {
        crate::desktop::http_log::tests::init_logger();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for _ in 0..50 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).await.unwrap() > 0);
                // Close without a response, as when a nest loses its network.
            }
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });
        let client = Client::builder().no_proxy().build().unwrap();
        for index in 0..50 {
            if index % 2 == 0 {
                // Independent window state keeps requests arriving during the outage.
                forward(&state(&origin), request(&origin, "outage"), || {})
                    .await
                    .unwrap();
            } else {
                let request = Request::builder()
                    .method(Method::HEAD)
                    .uri("krobi-media://localhost/api/media/A/song.mp3")
                    .body(Vec::new())
                    .unwrap();
                assert_eq!(
                    fetch_media_response(&client, &origin, "", &request, |_| {})
                        .await
                        .status(),
                    StatusCode::BAD_GATEWAY
                );
            }
        }
        forward(&state(&origin), request(&origin, "recovered"), || {})
            .await
            .unwrap();
        server.await.unwrap();
        let lines = crate::desktop::http_log::tests::take_lines();
        let visible: Vec<_> = lines
            .iter()
            .filter(|(level, _)| *level != log::Level::Debug)
            .collect();
        assert_eq!(visible.len(), 2, "{visible:?}");
        assert!(visible[0].1.starts_with("nest unreachable: "));
        assert!(visible[1].1.ends_with("50 requests failed meanwhile"));
    }

    #[tokio::test]
    async fn two_hundred_hanging_requests_open_at_most_sixteen_sockets_and_cancel_closes_them() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(state(&origin));
        let active = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let server = {
            let (active, accepted, peak) = (active.clone(), accepted.clone(), peak.clone());
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    accepted.fetch_add(1, Ordering::SeqCst);
                    let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(n, Ordering::SeqCst);
                    let active = active.clone();
                    tokio::spawn(async move {
                        let mut buf = [0; 4096];
                        while socket.read(&mut buf).await.unwrap_or(0) != 0 {}
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            })
        };
        let mut tasks = Vec::new();
        let mut ids = Vec::new();
        for i in 0..200 {
            // Different windows must share the same origin budget.
            let window = if i % 2 == 0 { "main" } else { "player" };
            let id = cancel::open(window);
            ids.push((window, id.clone()));
            let state = state.clone();
            let request = request(&origin, &id);
            tasks.push(tokio::spawn(async move {
                execute(window, &state, request, || {}).await
            }));
        }
        until(|| accepted.load(Ordering::SeqCst) >= 16).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            accepted.load(Ordering::SeqCst),
            16,
            "queued requests must not open sockets"
        );
        assert_eq!(peak.load(Ordering::SeqCst), 16);
        assert!(
            tasks.iter().all(|task| !task.is_finished()),
            "no request may fail early, including with EMFILE"
        );
        // Cancel both queued and active requests; no timed-out transport remains alive.
        for (window, id) in &ids {
            cancel::cancel(window, id);
        }
        for task in tasks {
            let result = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(
                result,
                Err(ShellError::Guard("proxy-request-cancelled"))
            ));
        }
        until(|| active.load(Ordering::SeqCst) == 0).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 16);
        // All permits were returned, and other origins have independent budgets.
        let permits = (0..16).map(|_| budget::acquire(&origin, false));
        let mut held = Vec::new();
        for permit in permits {
            held.push(permit.await);
        }
        let other = budget::acquire("http://example.com", false).await;
        drop((held, other));
        server.abort();
    }

    #[tokio::test]
    async fn cancel_before_dispatch_and_another_windows_cancel_are_safe() {
        let state = state("http://127.0.0.1:9");
        let id = cancel::open("main");
        cancel::cancel("player", &id);
        assert!(cancel::Request::take("main", &id).is_ok());
        // The preceding guard's drop removes its registration.
        let id = cancel::open("main");
        cancel::cancel("main", &id);
        assert!(
            execute("main", &state, request("http://127.0.0.1:9", &id), || {})
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancel_drops_a_hanging_response_body_too() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(state(&origin));
        let (ready, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0; 1];
            let mut bytes = Vec::new();
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut buf).await.unwrap();
                bytes.push(buf[0]);
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nx")
                .await
                .unwrap();
            ready.send(()).unwrap();
            match socket.read(&mut buf).await {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                other => panic!("cancelled body socket stayed open: {other:?}"),
            }
        });
        let id = cancel::open("main");
        let request = request(&origin, &id);
        let task = tokio::spawn(async move { execute("main", &state, request, || {}).await });
        received.await.unwrap();
        cancel::cancel("main", &id);
        assert!(tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap();
    }
}
