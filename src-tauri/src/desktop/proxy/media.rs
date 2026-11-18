//! Media scheme dispatch, local-first lookup and verified cache tee.

use super::*;

pub(super) fn media_error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .expect("static media error response is valid")
}

/// Serve backend media through a Tauri-owned URL.
///
/// WebKit enforces CORS on `<audio crossorigin="anonymous">`. Older Flipspin
/// servers do not know Tauri's origin, so direct media URLs fail even though
/// ordinary JSON calls work through `backend_request`. This protocol keeps the
/// credential in Rust. Tauri custom schemes require a complete response body;
/// closed upstream ranges bound each GET to 1 MiB on range-capable servers.
pub fn proxy_media_request(
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<DesktopState>();
        serve_media_request(
            &state,
            request,
            crate::desktop::offline::available_capacity,
            |response| responder.respond(response),
            |change| crate::desktop::offline::changed(&app, change),
            read_open_response,
        )
        .await;
    });
}

/// Window-free transport seam: tests exercise the same early offline return,
/// HTTP request, range handling, and cache tee as the URI scheme.
async fn serve_media_request(
    state: &DesktopState,
    request: Request<Vec<u8>>,
    capacity: fn(&std::path::Path, bool) -> ShellResult<u64>,
    respond: impl FnOnce(Response<Vec<u8>>),
    mut on_change: impl FnMut(crate::desktop::offline::Change),
    read_local: impl Fn(
        &Request<Vec<u8>>,
        std::fs::File,
        Response<Vec<u8>>,
    ) -> ShellResult<Response<Vec<u8>>>,
) {
    let (http, backend_origin, token, request_scope, unreachable) = {
        let runtime = match state.runtime() {
            Ok(runtime) => runtime,
            Err(_) => {
                respond(media_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "desktop state unavailable",
                ));
                return;
            }
        };
        (
            state.http.clone(),
            runtime.backend_origin.clone(),
            runtime.token.clone(),
            crate::desktop::offline::scope(&runtime).ok(),
            crate::desktop::offline::offline_now(&runtime),
        )
    };

    // Apply the transport's method and URL guards before any local lookup.
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        respond(media_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "media protocol only accepts GET and HEAD",
        ));
        return;
    }
    if media_target(&backend_origin, &request).is_none() {
        respond(media_error(StatusCode::FORBIDDEN, "blocked media path"));
        return;
    }
    if let Some((scope, (_, path))) = request_scope.as_ref().zip(
        request
            .uri()
            .path_and_query()
            .and_then(|p| crate::desktop::offline::art_media_path(p.as_str())),
    ) {
        let local = (|| -> ShellResult<Option<Response<Vec<u8>>>> {
            let o = crate::desktop::offline::lock_store(state, "media::serve_media_request")?;
            use krobi_offline::resolve::ArtResolution;
            match o
                .store
                .resolve_art(scope, &path, unreachable)
                .map_err(|e| ShellError::Message(e.to_string()))?
            {
                ArtResolution::Local(art) => {
                    let file = open_local(&art.path)?;
                    let reply = serve_art(&head_request(&request), &art)?;
                    drop(o);
                    read_local(&request, file, reply).map(Some)
                }
                ArtResolution::Missing => Ok(Some(
                    Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::CONTENT_LENGTH, "0")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Vec::new())
                        .expect("static response"),
                )),
                _ => Ok(None),
            }
        })();
        match local {
            Ok(Some(response)) => {
                respond(response);
                return;
            }
            Ok(None) => {}
            Err(error) => {
                log::warn!("offline art read failed: {error}");
                respond(media_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "local-read-failed",
                ));
                return;
            }
        }
    }
    let key = crate::desktop::offline::key_from_media(request.uri().path())
        .filter(|key| crate::desktop::offline::is_audio_key(key));
    let scope = request_scope;
    use krobi_offline::resolve::Resolution;
    type OpenResponse = (std::fs::File, Response<Vec<u8>>);
    let local = (|| -> ShellResult<(Resolution, Option<OpenResponse>, bool)> {
        let Some((scope, key)) = scope.as_ref().zip(key.as_deref()) else {
            return Ok((
                if unreachable {
                    Resolution::Unavailable
                } else {
                    Resolution::Remote
                },
                None,
                false,
            ));
        };
        let mut o = crate::desktop::offline::lock_store(state, "media::resolve-open")?;
        let revision = o.store.revision();
        let resolution = o
            .store
            .resolve(scope, key, unreachable)
            .map_err(|e| ShellError::Message(e.to_string()))?;
        let evicted = o.store.revision() != revision;
        let path = match &resolution {
            Resolution::Local(path) | Resolution::Cache(path) => path,
            _ => return Ok((resolution, None, evicted)),
        };
        let pool = if matches!(resolution, Resolution::Local(_)) {
            "offline"
        } else {
            "cache"
        };
        let record = o
            .store
            .file(scope, key, pool)
            .map_err(|e| ShellError::Message(e.to_string()))?
            .ok_or(ShellError::Guard("local-file-missing"))?;
        if !o.store.allowed(&record) {
            return Err(ShellError::Guard("blocked-local-path"));
        }
        // File::open shares DELETE on Windows explicitly. Unpin may unlink after
        // this guard drops; the handle still owns the bytes on every platform.
        let file = open_local(path)?;
        let reply = serve_local(&head_request(&request), path, key, record.etag.as_deref())?;
        o.store.set_playing(scope, key);
        Ok((resolution, Some((file, reply)), evicted))
    })();
    let (resolution, file, evicted) = match local {
        Ok(value) => value,
        Err(ShellError::Guard("blocked-local-path")) => {
            respond(media_error(StatusCode::FORBIDDEN, "blocked-local-path"));
            return;
        }
        Err(error) => {
            log::warn!("offline open failed: {error}");
            respond(media_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local-read-failed",
            ));
            return;
        }
    };
    if evicted {
        on_change(crate::desktop::offline::Change::CACHE);
    }
    match resolution {
        Resolution::Local(_) | Resolution::Cache(_) => {
            let (file, reply) = file.expect("local resolution owns an open handle");
            let local = read_local(&request, file, reply);
            respond(local.unwrap_or_else(|_| {
                media_error(StatusCode::INTERNAL_SERVER_ERROR, "local-read-failed")
            }));
            return;
        }
        Resolution::Unavailable => {
            respond(
                Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("X-Krobi-Offline-Status", "unavailable")
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(
                        header::ACCESS_CONTROL_EXPOSE_HEADERS,
                        "X-Krobi-Offline-Status",
                    )
                    .body(br#"{"status":"unavailable","reason":"offline-no-copy"}"#.to_vec())
                    .expect("static response"),
            );
            return;
        }
        Resolution::Remote => {}
    }
    let response = fetch_media_response(&http, &backend_origin, &token, &request, |error| {
        state.proxy_failure(error)
    })
    .await;
    let active_scope = state
        .runtime()
        .ok()
        .and_then(|r| crate::desktop::offline::scope(&r).ok());
    if active_scope != scope {
        respond(media_error(StatusCode::FORBIDDEN, "account-changed"));
        return;
    }
    let status = response.status();
    let upstream_headers = response.headers().clone();
    let body = response.body().clone();
    respond(response);
    // Tee only validated, contiguous bytes. A short/failed response never
    // becomes a verified cache entry and never prevents ordinary playback.
    if request.method() == Method::GET && status.is_success() {
        if let Some((scope, key)) = scope.as_ref().zip(key.as_deref()) {
            let range = upstream_headers
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .and_then(crate::desktop::offline::content_range);
            let span = if status == StatusCode::PARTIAL_CONTENT {
                range
            } else if status == StatusCode::OK {
                upstream_headers
                    .get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|n| *n > 0)
                    .map(|n| (0, n - 1, n))
            } else {
                None
            };
            if let Some((start, end, total)) =
                span.filter(|(start, end, _)| end - start + 1 == body.len() as u64)
            {
                let _ = end;
                let path = crate::desktop::offline::lock_store(state, "media::capacity-path")
                    .map(|o| o.store.pools.cache.clone());
                let free = match path {
                    Ok(path) => {
                        crate::desktop::offline::capacity_async(path, false, capacity).await
                    }
                    Err(error) => Err(error),
                };
                if let Ok(free) = free {
                    if state
                        .runtime()
                        .ok()
                        .and_then(|r| crate::desktop::offline::scope(&r).ok())
                        .as_ref()
                        != Some(scope)
                    {
                        return;
                    }
                    let budget = krobi_offline::pools::cache_budget(free);
                    if let Ok(mut o) = crate::desktop::offline::lock_store(state, "media::tee") {
                        let etag = upstream_headers.get("etag").and_then(|v| v.to_str().ok());
                        o.store.set_playing(scope, key);
                        let inserted = o.store.file(scope, key, "cache").ok().flatten().is_none();
                        let mut added = false;
                        if total <= budget && free > body.len() as u64 + 50 * 1024 * 1024 {
                            match o.store.tee(scope, key, start, total, etag, &body) {
                                Ok(complete) => added = complete,
                                Err(e) => log::warn!("cache write failed: {e}"),
                            }
                        }
                        o.wake_for_cache();
                        drop(o);
                        let evicted = if added || inserted {
                            crate::desktop::offline::enforce_cache_budget(state, budget, None)
                                .unwrap_or(false)
                        } else {
                            false
                        };
                        if added || evicted {
                            on_change(crate::desktop::offline::Change::CACHE);
                        }
                    }
                }
            }
        }
    }
}

fn open_local(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x1 | 0x2 | 0x4); // READ | WRITE | DELETE
    }
    options.open(path)
}

fn head_request(request: &Request<Vec<u8>>) -> Request<Vec<u8>> {
    let mut head = Request::builder()
        .method(Method::HEAD)
        .uri(request.uri())
        .body(Vec::new())
        .expect("validated request");
    *head.headers_mut() = request.headers().clone();
    head
}

/// Metadata helpers run with HEAD under the guard. The already-open handle is
/// the only source of bytes after release, including if the path is unlinked.
fn read_open_response(
    request: &Request<Vec<u8>>,
    mut file: std::fs::File,
    mut reply: Response<Vec<u8>>,
) -> ShellResult<Response<Vec<u8>>> {
    use std::io::{Read, Seek, SeekFrom};
    if reply.status().is_success() {
        reply
            .headers_mut()
            .insert("X-Krobi-Cache-Hit", "true".parse().unwrap());
        if let Some(expose) = reply
            .headers()
            .get(header::ACCESS_CONTROL_EXPOSE_HEADERS)
            .and_then(|v| v.to_str().ok())
        {
            let expose = format!("{expose}, X-Krobi-Cache-Hit");
            reply.headers_mut().insert(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                expose.parse().unwrap(),
            );
        }
        if request.method() != Method::HEAD {
            let size = reply
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .ok_or(ShellError::Guard("local-size-missing"))?;
            let start = reply
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(crate::desktop::offline::content_range)
                .map_or(0, |(start, _, _)| start);
            file.seek(SeekFrom::Start(start))?;
            file.take(size).read_to_end(reply.body_mut())?;
            if reply.body().len() as u64 != size {
                return Err(ShellError::Guard("local-file-truncated"));
            }
        }
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn media_test_state(origin: &str, reachable: bool) -> DesktopState {
        let mut runtime = crate::desktop::tests::remote_runtime(origin, origin);
        runtime.server.connection.state = if reachable {
            ConnectionState::Connected
        } else {
            ConnectionState::Unreachable
        };
        runtime.server.instance_id = Some("test-nido".into());
        DesktopState {
            app_dir: PathBuf::new(),
            http: Client::new(),
            runtime: Mutex::new(runtime),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(crate::desktop::offline::test_store()),
        }
    }

    fn media_reply(state: &DesktopState, range: Option<&str>) -> Response<Vec<u8>> {
        let mut request = Request::builder().uri("krobi-media://localhost/api/media/A/one.mp3");
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        let mut reply = None;
        tauri::async_runtime::block_on(serve_media_request(
            state,
            request.body(Vec::new()).unwrap(),
            |_, _| Ok(1024 * 1024 * 1024),
            |response| reply = Some(response),
            |_| {},
            read_open_response,
        ));
        reply.unwrap()
    }

    fn art_reply(state: &DesktopState, method: Method, path: &str) -> Response<Vec<u8>> {
        let mut reply = None;
        tauri::async_runtime::block_on(serve_media_request(
            state,
            Request::builder()
                .method(method)
                .uri(format!("krobi-media://localhost{path}"))
                .header(header::RANGE, "bytes=0-1")
                .body(Vec::new())
                .unwrap(),
            |_, _| Ok(1024 * 1024 * 1024),
            |response| reply = Some(response),
            |_| {},
            read_open_response,
        ));
        reply.unwrap()
    }

    #[test]
    fn pools_slow_capacity_never_holds_up_cached_media_with_2000_pins() {
        let state = std::sync::Arc::new(media_test_state("http://127.0.0.1:9", false));
        let active = crate::desktop::offline::scope(&state.runtime().unwrap()).unwrap();
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            // Many independent pins and file rows exercise the pool snapshot.
            for index in 0..2000 {
                o.store
                    .pin(
                        &active,
                        "song",
                        &format!("A/song-{index}.mp3"),
                        &[format!("A/song-{index}.mp3")],
                    )
                    .unwrap();
            }
            o.store
                .begin(&active, "A/one.mp3", "cache", 5, Some("\"v1\""), 0)
                .unwrap();
            o.store
                .append(&active, "A/one.mp3", "cache", b"audio")
                .unwrap();
            o.store.finish(&active, "A/one.mp3", "cache").unwrap();
        }
        let (entered, ready) = std::sync::mpsc::channel();
        let worker = state.clone();
        let pools = std::thread::spawn(move || {
            crate::desktop::offline::pools_get(&worker, &active, |_, _| {
                assert!(
                    worker.offline.try_lock().is_ok(),
                    "capacity called under offline mutex"
                );
                entered.send(()).unwrap();
                std::thread::sleep(Duration::from_secs(2));
                Ok(1024 * 1024 * 1024)
            })
            .unwrap()
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        for _ in 0..20 {
            let start = std::time::Instant::now();
            let reply = media_reply(&state, Some("bytes=0-4"));
            assert_eq!(reply.body(), b"audio");
            assert!(
                start.elapsed() < Duration::from_millis(50),
                "media blocked: {:?}",
                start.elapsed()
            );
        }
        assert_eq!(
            pools.join().unwrap()["pins"].as_array().unwrap().len(),
            2000
        );
    }

    #[test]
    fn cached_read_emits_no_change_and_open_handle_survives_sweep() {
        let state = media_test_state("http://127.0.0.1:9", false);
        let active = crate::desktop::offline::scope(&state.runtime().unwrap()).unwrap();
        let (file, reply, path) = {
            let o = lock(&state.offline, "offline").unwrap();
            o.store
                .begin(&active, "A/one.mp3", "cache", 5, None, 0)
                .unwrap();
            o.store
                .append(&active, "A/one.mp3", "cache", b"audio")
                .unwrap();
            o.store.finish(&active, "A/one.mp3", "cache").unwrap();
            let path = o
                .store
                .file(&active, "A/one.mp3", "cache")
                .unwrap()
                .unwrap()
                .path;
            let request = Request::builder()
                .method(Method::HEAD)
                .body(Vec::new())
                .unwrap();
            let reply = serve_local(&request, &path, "A/one.mp3", None).unwrap();
            (open_local(&path).unwrap(), reply, path)
        };
        let mut changes = 0;
        tauri::async_runtime::block_on(serve_media_request(
            &state,
            Request::builder()
                .uri("krobi-media://localhost/api/media/A/one.mp3")
                .body(Vec::new())
                .unwrap(),
            |_, _| panic!("cached read must not probe capacity"),
            |reply| assert_eq!(reply.body(), b"audio"),
            |_| changes += 1,
            |request, file, reply| {
                assert!(
                    state.offline.try_lock().is_ok(),
                    "local bytes read under offline mutex"
                );
                read_open_response(request, file, reply)
            },
        ));
        assert_eq!(
            changes, 0,
            "a plain cached read must not emit offline:changed"
        );
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store.stop_playing();
            o.store.evict_cache(&active, 0).unwrap();
        }
        assert!(!path.exists());
        assert!(state.offline.try_lock().is_ok());
        let request = Request::builder().body(Vec::new()).unwrap();
        assert_eq!(
            read_open_response(&request, file, reply).unwrap().body(),
            b"audio"
        );
    }

    #[test]
    fn stored_art_is_local_first_online_and_offline_with_mime_length_and_head() {
        let state = media_test_state("http://127.0.0.1:9", false);
        let active = crate::desktop::offline::scope(&state.runtime().unwrap()).unwrap();
        let full = "/api/media/A/cover.jpg";
        let small = "/api/media/A/cover.jpg?size=96";
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store
                .pin(&active, "album", "A", &["A/one.mp3".into()])
                .unwrap();
            for (path, body, mime) in [
                (full, b"full image".as_slice(), Some("image/png")),
                (small, b"small".as_slice(), None),
            ] {
                o.store.begin_art(&active, "A", path).unwrap();
                o.store.append_art(&active, path, body).unwrap();
                o.store
                    .finish_art(
                        &active,
                        path,
                        Some(body.len() as u64),
                        Some("\"art-v1\""),
                        mime,
                    )
                    .unwrap();
            }
        }
        for online in [false, true] {
            state.runtime().unwrap().server.connection.state = if online {
                ConnectionState::Connected
            } else {
                ConnectionState::Unreachable
            };
            let full_reply = art_reply(&state, Method::GET, full);
            assert_eq!(full_reply.status(), StatusCode::OK);
            assert_eq!(full_reply.body(), b"full image");
            assert_eq!(full_reply.headers()[header::CONTENT_TYPE], "image/png");
            assert_eq!(full_reply.headers()[header::CONTENT_LENGTH], "10");
            assert_eq!(full_reply.headers()[header::ETAG], "\"art-v1\"");
            let head = art_reply(&state, Method::HEAD, full);
            assert_eq!(head.status(), StatusCode::OK);
            assert!(head.body().is_empty());
            assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
            let small_reply =
                art_reply(&state, Method::GET, "/api/media/%41/cover.jpg?size=%39%36");
            assert_eq!(small_reply.body(), b"small");
            assert_eq!(small_reply.headers()[header::CONTENT_TYPE], "image/jpeg");
        }
    }

    #[test]
    fn remembered_cover_404_is_served_offline_and_missing_copy_stays_503() {
        let state = media_test_state("http://127.0.0.1:9", false);
        let active = crate::desktop::offline::scope(&state.runtime().unwrap()).unwrap();
        let path = "/api/media/A/cover.jpg";
        assert_eq!(
            art_reply(&state, Method::GET, path).status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store
                .pin(&active, "song", "A/one.mp3", &["A/one.mp3".into()])
                .unwrap();
            o.store.art_missing(&active, "A", path).unwrap();
        }
        assert_eq!(
            art_reply(&state, Method::GET, path).status(),
            StatusCode::NOT_FOUND
        );
        let head = art_reply(&state, Method::HEAD, path);
        assert_eq!(head.status(), StatusCode::NOT_FOUND);
        assert!(head.body().is_empty());
        let unavailable = art_reply(&state, Method::GET, "/api/media/A/cover.jpg?size=96");
        assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(String::from_utf8_lossy(unavailable.body()).contains("offline-no-copy"));
    }

    #[test]
    fn check_11_scheme_offline_without_copy_never_contacts_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let state = media_test_state(&format!("http://{}", listener.local_addr().unwrap()), false);
        let reply = media_reply(&state, Some("bytes=0-"));
        assert_eq!(reply.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(reply.headers()["X-Krobi-Offline-Status"], "unavailable");
        assert_eq!(
            serde_json::from_slice::<Value>(reply.body()).unwrap()["reason"],
            "offline-no-copy"
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    fn media_fixture_response(
        wire: Vec<u8>,
        before_response: impl FnOnce(&DesktopState) + Send,
    ) -> (DesktopState, Response<Vec<u8>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let state = media_test_state(&format!("http://{}", listener.local_addr().unwrap()), true);
        let reply = std::thread::scope(|threads| {
            let state = &state;
            let server = threads.spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                before_response(state);
                socket.write_all(&wire).unwrap();
                listener.set_nonblocking(true).unwrap();
                assert_eq!(
                    listener.accept().unwrap_err().kind(),
                    std::io::ErrorKind::WouldBlock
                );
            });
            let reply = media_reply(state, Some("bytes=0-"));
            server.join().unwrap();
            reply
        });
        (state, reply)
    }

    #[test]
    fn returned_full_body_fallback_is_cached_then_served_in_local_slices() {
        let body = vec![42; MAX_MEDIA_SLICE as usize + 1];
        let mut wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        wire.extend_from_slice(&body);
        let (state, reply) = media_fixture_response(wire, |_| {});
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(reply.body(), &body);
        state.runtime().unwrap().server.connection.state = ConnectionState::Unreachable;
        let local = media_reply(&state, Some("bytes=1048576-"));
        assert_eq!(local.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(local.body(), &[42]);
    }

    #[test]
    fn invalid_returned_slice_never_enters_the_cache() {
        let (state, reply) = media_fixture_response(
            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-5/6\r\nContent-Length: 5\r\nETag: \"v1\"\r\nConnection: close\r\n\r\naudio".to_vec(),
            |_| {},
        );
        assert_eq!(reply.status(), StatusCode::BAD_GATEWAY);
        let scope = crate::desktop::offline::scope(&state.runtime().unwrap()).unwrap();
        assert!(lock(&state.offline, "offline")
            .unwrap()
            .store
            .file(&scope, "A/one.mp3", "cache")
            .unwrap()
            .is_none());
    }

    #[test]
    fn account_change_during_fetch_blocks_response_and_cache_tee() {
        let (state, reply) = media_fixture_response(
            b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-4/5\r\nContent-Length: 5\r\nETag: \"v1\"\r\nConnection: close\r\n\r\naudio".to_vec(),
            |state| state.runtime().unwrap().credentials.clear(),
        );
        assert_eq!(reply.status(), StatusCode::FORBIDDEN);
        assert_eq!(reply.body(), b"account-changed");
        let scope = krobi_offline::store::Scope::new("test-nido", "u1").unwrap();
        assert!(lock(&state.offline, "offline")
            .unwrap()
            .store
            .file(&scope, "A/one.mp3", "cache")
            .unwrap()
            .is_none());
    }

    #[test]
    fn remote_media_failure_reaches_the_connection_owner() {
        let (state, reply) = media_fixture_response(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_vec(),
            |_| {},
        );
        assert_eq!(reply.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            state.runtime().unwrap().server.connection.state,
            ConnectionState::Connecting
        );
    }

    #[test]
    fn remote_media_injects_token_caps_range_tees_cache_then_plays_offline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut byte = [0u8; 1];
            while !bytes.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                bytes.push(byte[0]);
            }
            let headers = String::from_utf8(bytes).unwrap().to_lowercase();
            assert!(headers.contains("range: bytes=0-1048575"));
            assert_eq!(
                headers.lines().filter(|l| l.starts_with("range:")).count(),
                1
            );
            assert!(headers.contains("authorization: bearer secret"));
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 0-4/5\r\nETag: \"v1\"\r\nConnection: close\r\n\r\naudio").unwrap();
        });
        let state = media_test_state(&origin, true);
        assert_eq!(media_reply(&state, Some("bytes=0-")).body(), b"audio");
        server.join().unwrap();
        state.runtime().unwrap().server.connection.state = ConnectionState::Unreachable;
        let local = media_reply(&state, Some("bytes=0-1"));
        assert_eq!(local.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(local.headers()[header::CONTENT_RANGE], "bytes 0-1/5");
        assert_eq!(local.body(), b"au");
        assert_eq!(
            media_reply(&state, Some("bytes=99-")).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
    }

    #[test]
    fn local_ranges_are_capped_and_scope_escape_returns_403() {
        let state = media_test_state("http://127.0.0.1:1", false);
        let scope = crate::desktop::offline::scope(&state.runtime().unwrap()).unwrap();
        let file = {
            let o = lock(&state.offline, "offline").unwrap();
            o.store
                .begin(
                    &scope,
                    "A/one.mp3",
                    "offline",
                    2 * MAX_MEDIA_SLICE,
                    Some("\"v1\""),
                    0,
                )
                .unwrap();
            o.store
                .append(
                    &scope,
                    "A/one.mp3",
                    "offline",
                    &vec![1; 2 * MAX_MEDIA_SLICE as usize],
                )
                .unwrap();
            o.store.finish(&scope, "A/one.mp3", "offline").unwrap();
            o.store
                .file(&scope, "A/one.mp3", "offline")
                .unwrap()
                .unwrap()
        };
        let reply = media_reply(&state, Some("bytes=0-"));
        assert_eq!(reply.body().len(), MAX_MEDIA_SLICE as usize);
        assert_eq!(
            reply.headers()[header::CONTENT_RANGE],
            format!("bytes 0-{}/{}", MAX_MEDIA_SLICE - 1, 2 * MAX_MEDIA_SLICE)
        );
        #[cfg(unix)]
        {
            let external = file
                .path
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("outside.mp3");
            std::fs::rename(&file.path, &external).unwrap();
            std::os::unix::fs::symlink(external, &file.path).unwrap();
            assert_eq!(
                media_reply(&state, Some("bytes=0-1")).status(),
                StatusCode::FORBIDDEN
            );
        }
    }
}
