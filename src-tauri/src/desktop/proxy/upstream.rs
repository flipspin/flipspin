//! Scoped media HTTP requests and validated upstream response buffering.

use super::*;

/// Build the same upstream request for ordinary media and allowlisted stems.
fn media_upstream_request(
    http: &crate::desktop::Client,
    backend_origin: &str,
    token: &str,
    request: &Request<Vec<u8>>,
) -> Result<reqwest::RequestBuilder, (StatusCode, &'static str)> {
    let method = match *request.method() {
        Method::GET => reqwest::Method::GET,
        Method::HEAD => reqwest::Method::HEAD,
        _ => {
            return Err((
                StatusCode::METHOD_NOT_ALLOWED,
                "media protocol only accepts GET and HEAD",
            ))
        }
    };
    let target = media_target(backend_origin, request)
        .ok_or((StatusCode::FORBIDDEN, "blocked media path"))?;
    let mut upstream_request = http
        .request(method, target)
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    if request.method() == Method::GET {
        let value = request
            .headers()
            .get(header::RANGE)
            .map(|v| v.to_str())
            .transpose()
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid media range"))?;
        let range = media_slice_range(value).ok_or((
            StatusCode::BAD_REQUEST,
            "expected a single bytes=start-end range",
        ))?;
        upstream_request = upstream_request.header(
            header::RANGE.as_str(),
            format!("bytes={}-{}", range.start, range.end),
        );
    } else if let Some(value) = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
        // HEAD retains its existing forwarding semantics.
        upstream_request = upstream_request.header(header::RANGE.as_str(), value);
    }
    for name in [header::IF_RANGE, header::ACCEPT] {
        if let Some(value) = request.headers().get(&name) {
            if let Ok(value) = value.to_str() {
                upstream_request = upstream_request.header(name.as_str(), value);
            }
        }
    }
    if !token.is_empty() {
        upstream_request = upstream_request.bearer_auth(token);
    }
    Ok(upstream_request)
}

/// Kept separate from the Tauri responder so the real upstream exchange can be
/// tested without launching the app (and composed with local-first serving).
pub(super) async fn fetch_media_response(
    http: &crate::desktop::Client,
    backend_origin: &str,
    token: &str,
    request: &Request<Vec<u8>>,
    report_failure: impl Fn(Option<crate::desktop::connection::LastError>),
) -> Response<Vec<u8>> {
    let upstream_request = match media_upstream_request(http, backend_origin, token, request) {
        Ok(request) => request,
        Err((status, message)) => return media_error(status, message),
    };
    let path = request.uri().path().to_ascii_lowercase();
    let artwork = [".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|ext| path.ends_with(ext))
        || request.uri().query().is_some_and(|q| q.contains("size="));
    let _slot = if artwork {
        budget::acquire_art(backend_origin).await
    } else {
        budget::acquire(backend_origin, true).await
    };
    let mut upstream = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            report_failure(crate::desktop::handshake::describe_request_error(&error).code);
            crate::desktop::http_log::proxy_failed(
                backend_origin,
                &crate::desktop::http_log::error(&error),
            );
            return media_error(StatusCode::BAD_GATEWAY, "media server unavailable");
        }
    };
    crate::desktop::http_log::proxy_received(
        backend_origin,
        request.method(),
        request.uri().path(),
        &upstream,
    );
    let diagnostic = crate::desktop::http_log::response(&upstream);
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let invalid_response = |message: &str| {
        crate::desktop::http_log::proxy_invalid(
            backend_origin,
            status.as_u16(),
            &format!("media proxy failed: {diagnostic}: {message}"),
        );
        media_error(StatusCode::BAD_GATEWAY, message)
    };
    // A nest that answered 502–504 is restarting or behind a dead proxy: tell
    // the connection owner (one failure is a window, not a verdict).
    if matches!(status.as_u16(), 502..=504) {
        report_failure(None);
    }
    let upstream_headers = upstream.headers().clone();
    let slice = if request.method() == Method::GET && status == StatusCode::PARTIAL_CONTENT {
        let actual = upstream_headers
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(media_content_range);
        let requested = media_slice_range(
            request
                .headers()
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok()),
        )
        .expect("range already validated");
        match actual {
            Some((range, _)) if range.start == requested.start && range.end <= requested.end => {
                Some((range.end - range.start + 1) as usize)
            }
            _ => return invalid_response("invalid media content range"),
        }
    } else {
        None
    };
    let body = if let Some(length) = slice {
        // Check chunks as they arrive: an invalid 206 must not allocate an
        // unbounded body even if the server ignores its own Content-Range.
        let mut body = Vec::with_capacity(length);
        loop {
            match upstream.chunk().await {
                Ok(Some(chunk)) if chunk.len() <= length - body.len() => {
                    body.extend_from_slice(&chunk)
                }
                Ok(None) if body.len() == length => break,
                Err(error) => {
                    crate::desktop::http_log::proxy_body_failed(
                        backend_origin,
                        status.as_u16(),
                        &format!(
                            "media proxy body failed: {diagnostic}: {}",
                            crate::desktop::http_log::error(&error)
                        ),
                    );
                    return media_error(StatusCode::BAD_GATEWAY, "media response failed");
                }
                _ => return invalid_response("invalid media slice length"),
            }
        }
        body
    } else {
        match upstream.bytes().await {
            Ok(bytes) => bytes.to_vec(),
            Err(error) => {
                crate::desktop::http_log::proxy_body_failed(
                    backend_origin,
                    status.as_u16(),
                    &format!(
                        "media proxy body failed: {diagnostic}: {}",
                        crate::desktop::http_log::error(&error)
                    ),
                );
                return media_error(StatusCode::BAD_GATEWAY, "media response failed");
            }
        }
    };
    crate::desktop::http_log::proxy_completed(backend_origin, status.as_u16());
    let mut response = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Length, Content-Range, Content-Type",
        );
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
        header::CACHE_CONTROL,
    ] {
        if slice.is_some() && (name == header::CONTENT_LENGTH || name == header::ACCEPT_RANGES) {
            continue;
        }
        if let Some(value) = upstream_headers.get(name.as_str()) {
            if let Ok(value) = value.to_str() {
                response = response.header(name, value);
            }
        }
    }
    if slice.is_some() {
        response = response
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, body.len());
    }
    response
        .body(body)
        .unwrap_or_else(|_| media_error(StatusCode::BAD_GATEWAY, "invalid media response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn hanging_media_uses_four_sockets_and_dropping_futures_returns_slots() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let server = {
            let (accepted, active) = (accepted.clone(), active.clone());
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    accepted.fetch_add(1, Ordering::SeqCst);
                    active.fetch_add(1, Ordering::SeqCst);
                    let active = active.clone();
                    tokio::spawn(async move {
                        let mut buf = [0; 4096];
                        while socket.read(&mut buf).await.unwrap_or(0) != 0 {}
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            })
        };
        let mut json = Vec::new();
        for _ in 0..16 {
            json.push(budget::acquire(&origin, false).await);
        }
        let mut tasks = Vec::new();
        for _ in 0..40 {
            let origin = origin.clone();
            tasks.push(tokio::spawn(async move {
                let http = Client::builder().no_proxy().build().unwrap();
                let request = Request::builder()
                    .method(Method::HEAD)
                    .uri("krobi-media://localhost/api/media/A/one.mp3")
                    .body(Vec::new())
                    .unwrap();
                fetch_media_response(&http, &origin, "", &request, |_| {}).await
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while accepted.load(Ordering::SeqCst) < 4 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 4);
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            assert!(task.await.unwrap_err().is_cancelled());
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while active.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let mut restored = Vec::new();
        for _ in 0..4 {
            restored.push(
                tokio::time::timeout(Duration::from_secs(1), budget::acquire(&origin, true))
                    .await
                    .unwrap(),
            );
        }
        drop((json, restored));
        server.abort();
    }

    #[test]
    fn custom_headers_reach_media_and_json_builders() {
        let http = Client::new();
        http.restore(&BTreeMap::from([(
            "headers:https://nest.example/krobi".into(),
            Credential {
                token: r#"{"x-proxy-secret":"fixture-proxy-secret"}"#.into(),
                ..Default::default()
            },
        )]))
        .unwrap();
        let media = Request::builder()
            .uri("krobi-media://localhost/api/media/A/one.mp3")
            .body(Vec::new())
            .unwrap();
        let upstream = media_upstream_request(&http, "https://nest.example/krobi", "token", &media)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(upstream.headers()["x-proxy-secret"], "fixture-proxy-secret");
        let json = http
            .request(reqwest::Method::POST, "https://nest.example/krobi/api/me")
            .json(&json!({}))
            .build()
            .unwrap();
        assert_eq!(json.headers()["x-proxy-secret"], "fixture-proxy-secret");
        let other = media_upstream_request(&http, "https://other.example", "token", &media)
            .unwrap()
            .build()
            .unwrap();
        assert!(!other.headers().contains_key("x-proxy-secret"));
    }

    const FAKE_MEDIA_LEN: usize = 5_000_000;

    /// A one-request HTTP server with an independent Range implementation.
    /// Return the raw request so tests also assert what went over the wire.
    fn fake_media_upstream(supports_range: bool) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}/krobi", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut raw = Vec::new();
            while !raw.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                raw.push(byte[0]);
                assert!(raw.len() < 16_384);
            }
            let raw = String::from_utf8(raw).unwrap();
            let head = raw.starts_with("HEAD ");
            let range = raw.lines().skip(1).find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("range").then(|| value.trim())
            });
            let mut status = "200 OK";
            let mut content_range = String::new();
            let (mut start, mut end) = (0, FAKE_MEDIA_LEN - 1);
            if supports_range && !head {
                if let Some(range) = range {
                    let (first, last) = range
                        .strip_prefix("bytes=")
                        .unwrap()
                        .split_once('-')
                        .unwrap();
                    start = first.parse().unwrap();
                    end = last.parse::<usize>().unwrap().min(end);
                    if start >= FAKE_MEDIA_LEN {
                        status = "416 Range Not Satisfiable";
                        content_range = format!("Content-Range: bytes */{FAKE_MEDIA_LEN}\r\n");
                    } else {
                        status = "206 Partial Content";
                        content_range =
                            format!("Content-Range: bytes {start}-{end}/{FAKE_MEDIA_LEN}\r\n");
                    }
                }
            }
            let length = if status.starts_with("416") {
                0
            } else {
                end - start + 1
            };
            write!(socket, "HTTP/1.1 {status}\r\nContent-Type: audio/mpeg\r\nContent-Length: {length}\r\n{content_range}ETag: \"test-media\"\r\nCache-Control: private\r\nConnection: close\r\n\r\n").unwrap();
            // Deliberately omit Accept-Ranges: the proxy supplies it for 206.
            if !head && length > 0 {
                let body: Vec<_> = (start..=end).map(|i| (i % 251) as u8).collect();
                socket.write_all(&body).unwrap();
            }
            raw
        });
        (origin, thread)
    }

    fn fetch_fake_media(
        method: Method,
        range: Option<&str>,
        supports_range: bool,
    ) -> (Response<Vec<u8>>, String) {
        let (origin, server) = fake_media_upstream(supports_range);
        let mut request = Request::builder()
            .method(method)
            .uri("krobi-media://localhost/api/media/Album/Song.mp3")
            .header(header::AUTHORIZATION, "Bearer renderer-token");
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        let request = request.body(Vec::new()).unwrap();
        let response = tauri::async_runtime::block_on(async {
            let client = crate::desktop::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            fetch_media_response(&client, &origin, "rust-token", &request, |_| {}).await
        });
        let wire = server.join().unwrap();
        assert!(wire.starts_with(&format!(
            "{} /krobi/api/media/Album/Song.mp3 HTTP/1.1\r\n",
            request.method()
        )));
        assert!(wire
            .to_ascii_lowercase()
            .contains("authorization: bearer rust-token\r\n"));
        assert!(!wire.contains("renderer-token"));
        (response, wire.to_ascii_lowercase())
    }

    #[test]
    fn media_upstream_returns_bounded_206_slices_and_exact_probe_and_seek_bytes() {
        for (range, start, end, closed) in [
            (None, 0, 1_048_575, "bytes=0-1048575"),
            (Some("bytes=0-"), 0, 1_048_575, "bytes=0-1048575"),
            (Some("bytes=0-1"), 0, 1, "bytes=0-1"),
            (Some("bytes=0-4999999"), 0, 1_048_575, "bytes=0-1048575"),
            (
                Some("bytes=4000000-"),
                4_000_000,
                4_999_999,
                "bytes=4000000-5048575",
            ),
            (
                Some("bytes=4999999-"),
                4_999_999,
                4_999_999,
                "bytes=4999999-6048574",
            ),
        ] {
            let (response, wire) = fetch_fake_media(Method::GET, range, true);
            assert!(wire.contains(&format!("range: {closed}\r\n")));
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes {start}-{end}/{FAKE_MEDIA_LEN}")
            );
            assert_eq!(
                response.headers()[header::CONTENT_LENGTH],
                (end - start + 1).to_string()
            );
            assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
            assert_eq!(response.headers()[header::ETAG], "\"test-media\"");
            assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
            assert_eq!(response.body().len(), end - start + 1);
            assert!(response.body().len() <= MAX_MEDIA_SLICE as usize);
            for (offset, byte) in response.body().iter().enumerate() {
                assert_eq!(*byte, ((start + offset) % 251) as u8);
            }
        }
    }

    #[test]
    fn media_upstream_unsatisfiable_start_preserves_416_and_total() {
        for range in ["bytes=5000000-", "bytes=6000000-"] {
            let (response, _) = fetch_fake_media(Method::GET, Some(range), true);
            assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */5000000");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn media_upstream_without_range_support_keeps_full_body_fallback() {
        let (response, _) = fetch_fake_media(Method::GET, Some("bytes=4000000-"), false);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "5000000");
        assert!(!response.headers().contains_key(header::CONTENT_RANGE));
        assert_eq!(response.body().len(), FAKE_MEDIA_LEN);
        for (offset, byte) in response.body().iter().enumerate() {
            assert_eq!(*byte, (offset % 251) as u8);
        }
    }

    #[test]
    fn media_upstream_head_preserves_range_or_absence_and_returns_no_body() {
        for range in [None, Some("bytes=4000000-")] {
            let (response, wire) = fetch_fake_media(Method::HEAD, range, true);
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_LENGTH], "5000000");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
            assert!(response.body().is_empty());
            match range {
                Some(value) => assert!(wire.contains(&format!("\r\nrange: {value}\r\n"))),
                None => assert!(!wire.contains("\r\nrange:")),
            }
        }
    }

    #[test]
    fn media_upstream_rejects_invalid_partial_metadata_and_body_lengths() {
        for (content_range, body) in [
            ("bytes 0-1048576/5000000", ""), // over the slice cap
            ("bytes 1-2/5000000", "ab"),     // wrong start
            ("bytes 0-1/*", "ab"),           // unknown total
            ("bytes 0-1/5000000", "a"),      // short body
            ("bytes 0-1/5000000", "abc"),    // extra bytes
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut raw = Vec::new();
                while !raw.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    raw.push(byte[0]);
                }
                write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Range: {content_range}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let request = Request::builder()
                .uri("krobi-media://localhost/api/media/A/F")
                .body(Vec::new())
                .unwrap();
            let response = tauri::async_runtime::block_on(async {
                let client = crate::desktop::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap();
                fetch_media_response(&client, &origin, "", &request, |_| {}).await
            });
            server.join().unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_GATEWAY,
                "accepted {content_range} with body {body}"
            );
        }
    }

    #[test]
    fn stems_check_11_get_and_head_forward_ranges_and_inject_bearer() {
        let http = crate::desktop::Client::new();
        for origin in ["https://music.example/krobi", "http://127.0.0.1:8000"] {
            for stem in ["drums", "bass", "vocals", "other"] {
                for method in [Method::GET, Method::HEAD] {
                    let path = format!("/api/stems/An%20Album/Song%20%231.mp3/{stem}");
                    let request = Request::builder()
                        .method(method.clone())
                        .uri(format!("krobi-media://localhost{path}?quality=original"))
                        .header(header::RANGE, "bytes=100-199")
                        .header(header::IF_RANGE, "\"stem-etag\"")
                        .header(header::ACCEPT, "audio/ogg")
                        .header(header::AUTHORIZATION, "Bearer renderer-token")
                        .body(Vec::new())
                        .unwrap();
                    // This is the builder used by proxy_media_request, before send().
                    let upstream = media_upstream_request(&http, origin, "current-token", &request)
                        .unwrap()
                        .build()
                        .unwrap();
                    assert_eq!(upstream.method().as_str(), method.as_str());
                    assert_eq!(
                        upstream.url().as_str(),
                        format!("{origin}{path}?quality=original")
                    );
                    assert!(!upstream.url().as_str().contains("token"));
                    assert_eq!(upstream.headers()[header::RANGE], "bytes=100-199");
                    assert_eq!(upstream.headers()[header::IF_RANGE], "\"stem-etag\"");
                    assert_eq!(upstream.headers()[header::ACCEPT], "audio/ogg");
                    assert_eq!(upstream.headers()[header::ACCEPT_ENCODING], "identity");
                    assert_eq!(
                        upstream.headers()[header::AUTHORIZATION],
                        "Bearer current-token"
                    );
                }
            }
        }
    }

    #[test]
    fn stems_check_11_refuses_non_audio_paths_and_dot_segments() {
        let http = crate::desktop::Client::new();
        for path in [
            "/api/stems",
            "/api/stems/",
            "/api/stems/A/F", // manifest
            "/api/stems/A/F/song.json",
            "/api/stems/jobs",
            "/api/stems/jobs/F/drums",
            "/api/stems/agent/claim",
            "/api/stems/agent/heartbeat",
            "/api/stems/agent/result",
            "/api/stems/agent/F/drums",
            "/api/stems/request",
            "/api/stems/A/F/piano",
            "/api/stems/A/F/Drums",
            "/api/stems/A/F/drums/extra",
            "/api/stems/A/F/drums/",
            "/api/stems//F/drums",
            "/api/stems/A//drums",
            "/api/stems/A/drums",
            "/api/stemsx/A/F/drums",
            "/api/stems/../A/drums",
            "/api/stems/A/../drums",
            "/api/stems/%2e%2e/F/drums",
            "/api/stems/A/%2E%2E/drums",
            "/api/stems/A/.%2e/drums",
            "/api/stems/A/%2e./drums",
            "/api/stems/A/%2e/drums",
            "/api/stems/A/F/%2e%2e/drums",
            "/api/stems/A/F/drums/../bass",
            "/api/stems/../media/A/F",
            "/api/media/../stems/A/F/drums",
            "/api/users",
        ] {
            for origin in ["https://music.example/krobi", "http://127.0.0.1:8000"] {
                for method in [Method::GET, Method::HEAD] {
                    let request = Request::builder()
                        .method(method)
                        .uri(format!("krobi-media://localhost{path}"))
                        .body(Vec::new())
                        .unwrap();
                    assert!(
                        matches!(
                            media_upstream_request(&http, origin, "current-token", &request),
                            Err((StatusCode::FORBIDDEN, _))
                        ),
                        "accepted {path} on {origin}"
                    );
                }
            }
        }
    }

    #[test]
    fn stems_check_11_refuses_methods_other_than_get_and_head() {
        let http = crate::desktop::Client::new();
        for method in [
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
            Method::TRACE,
            Method::CONNECT,
        ] {
            let request = Request::builder()
                .method(method.clone())
                .uri("krobi-media://localhost/api/stems/A/F/drums")
                .body(Vec::new())
                .unwrap();
            assert!(
                matches!(
                    media_upstream_request(&http, "https://music.example/krobi", "token", &request),
                    Err((StatusCode::METHOD_NOT_ALLOWED, _))
                ),
                "accepted {method}"
            );
        }
    }
}
