//! Resumable audio transfers fenced by runtime identity and capacity.

use super::*;

pub(super) async fn download(
    state: &DesktopState,
    scope: &Scope,
    key: &str,
    pool: &str,
) -> ShellResult<()> {
    if pool == "offline" {
        download_pinned_with_capacity(state, scope, key, available_capacity).await
    } else {
        download_pool_with_capacity(state, scope, key, pool, available_capacity).await
    }
}

pub(super) async fn download_pinned_with_capacity(
    state: &DesktopState,
    scope: &Scope,
    key: &str,
    capacity: fn(&Path, bool) -> ShellResult<u64>,
) -> ShellResult<()> {
    download_with_capacity(state, scope, key, capacity).await?;
    let downloaded = lock_store(state, "transfer::download_pinned_with_capacity")?
        .store
        .file(scope, key, "offline")
        .map_err(storage_error)?
        .is_some_and(|f| f.state == DOWNLOADED);
    // Cover failure must never turn a completed audio transfer into a failed one.
    if let Some((album, path)) = cover_path(key).filter(|_| downloaded) {
        let gate = lock_store(state, "transfer::download_pinned_with_capacity")?
            .sync
            .clone();
        let _guard = gate.lock().await;
        if let Err(error) = refresh_art(state, scope, &album, &path, false).await {
            log::debug!("offline cover: {error}");
        }
    }
    Ok(())
}

async fn download_with_capacity(
    state: &DesktopState,
    scope: &Scope,
    key: &str,
    capacity: fn(&Path, bool) -> ShellResult<u64>,
) -> ShellResult<()> {
    download_pool_with_capacity(state, scope, key, "offline", capacity).await
}

pub(super) async fn download_pool_with_capacity(
    state: &DesktopState,
    scope: &Scope,
    key: &str,
    pool: &str,
    capacity: fn(&Path, bool) -> ShellResult<u64>,
) -> ShellResult<()> {
    download_pool_at(state, scope, key, pool, capacity, None).await
}

async fn download_pool_at(
    state: &DesktopState,
    scope: &Scope,
    key: &str,
    pool: &str,
    capacity: fn(&Path, bool) -> ShellResult<u64>,
    at: Option<i64>,
) -> ShellResult<()> {
    lock_store(state, "transfer::download_pool_at")?
        .store
        .worker_transfer(scope, key, pool, true);
    let result = transfer_file(state, scope, key, pool, capacity, at).await;
    let cache_budget = if result.is_ok() && pool == "cache" {
        let path = lock_store(state, "transfer::capacity-path")?
            .store
            .pools
            .cache
            .clone();
        Some(cache_budget(capacity_async(path, false, capacity).await?))
    } else {
        None
    };
    let mut o = lock_store(state, "transfer::download_pool_at")?;
    o.store.worker_transfer(scope, key, pool, false);
    if let Err(error) = &result {
        if matches!(error, ShellError::Guard("transfer-paused")) {
            o.store
                .set_state(scope, key, pool, "en fila", None)
                .map_err(storage_error)?;
        } else if o
            .store
            .file(scope, key, pool)
            .map_err(storage_error)?
            .is_some()
        {
            o.store
                .transfer_failed(scope, key, pool, &error.to_string())
                .map_err(storage_error)?;
        }
    }
    drop(o);
    if let Some(budget) = cache_budget {
        enforce_cache_budget(state, budget, None)?;
    }
    result
}

async fn transfer_file(
    state: &DesktopState,
    scope: &Scope,
    key: &str,
    pool: &str,
    capacity: fn(&Path, bool) -> ShellResult<u64>,
    at: Option<i64>,
) -> ShellResult<()> {
    let (origin, token) = {
        let r = state.runtime()?;
        if offline_now(&r) || self::scope(&r)? != *scope {
            return Err(ShellError::Guard("transfer-paused"));
        }
        (r.backend_origin.clone(), r.token.clone())
    };
    let resume = {
        let mut o = lock_store(state, "transfer::transfer_file")?;
        if pool == "offline" && !o.store.required(scope, key).map_err(storage_error)? {
            return Ok(());
        }
        if !o
            .store
            .transfer_due_at(
                scope,
                key,
                pool,
                at.unwrap_or_else(krobi_offline::store::now),
            )
            .map_err(storage_error)?
        {
            return Ok(());
        }
        if pool == "offline" && o.store.promote_cached(scope, key).map_err(storage_error)? {
            return Ok(());
        }
        let Some(file) = o.store.file(scope, key, pool).map_err(storage_error)? else {
            return Ok(());
        };
        if file.state == DOWNLOADED {
            return Ok(());
        }
        o.store.resume(scope, key, pool).map_err(storage_error)?
    };
    let target = crate::desktop::downloads::media_download_target(&origin, &media_path(key))
        .ok_or(ShellError::Guard("invalid-track-key"))?;
    let mut request = state
        .http
        .get(target)
        .bearer_auth(&token)
        .header("Accept-Encoding", "identity");
    if let Some(etag) = &resume.if_range {
        request = request
            .header("Range", format!("bytes={}-", resume.offset))
            .header("If-Range", etag);
    }
    let mut response = request.send().await?;
    if resume.if_range.is_some()
        && (matches!(response.status().as_u16(), 412 | 416)
            || (response.status() == reqwest::StatusCode::PARTIAL_CONTENT
                && response.headers().get("etag").and_then(|s| s.to_str().ok())
                    != resume.if_range.as_deref()))
    {
        // Some servers reject a stale validator; others answer 200. Both restart.
        connected_scope(state, scope)?;
        response = state
            .http
            .get(
                crate::desktop::downloads::media_download_target(&origin, &media_path(key))
                    .ok_or(ShellError::Guard("invalid-track-key"))?,
            )
            .bearer_auth(&token)
            .header("Accept-Encoding", "identity")
            .send()
            .await?;
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        lock_store(state, "transfer::transfer_file")?
            .store
            .remote_file_missing_at(
                scope,
                key,
                pool,
                at.unwrap_or_else(krobi_offline::store::now),
            )
            .map_err(storage_error)?;
        return Ok(());
    }
    let partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !response.status().is_success() {
        return Err(ShellError::Message(format!(
            "download-http-{}",
            response.status().as_u16()
        )));
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|s| s.to_str().ok())
        .map(str::to_owned);
    let (offset, total) = if partial {
        let (start, end, total) = content_range(
            response
                .headers()
                .get("content-range")
                .and_then(|s| s.to_str().ok())
                .unwrap_or(""),
        )
        .ok_or(ShellError::Guard("invalid-content-range"))?;
        if start != resume.offset || end + 1 != total || etag != resume.if_range {
            return Err(ShellError::Guard("invalid-content-range"));
        }
        (start, total)
    } else {
        (
            0,
            response
                .content_length()
                .ok_or(ShellError::Guard("missing-server-size"))?,
        )
    };
    {
        connected_scope(state, scope)?;
        let important = pool == "offline";
        let path = {
            let o = lock_store(state, "transfer::capacity-path")?;
            if important {
                o.store.pools.offline.clone()
            } else {
                o.store.pools.cache.clone()
            }
        };
        let free = capacity_async(path, important, capacity).await?;
        if total > free.saturating_sub(50 * 1024 * 1024)
            || (!important && total > cache_budget(free))
        {
            return Err(ShellError::Guard("no-space"));
        }
        let o = lock_store(state, "transfer::begin")?;
        connected_scope(state, scope)?;
        if pool == "offline" && !o.store.required(scope, key).map_err(storage_error)? {
            return Err(ShellError::Guard("transfer-cancelled"));
        }
        o.store
            .begin(scope, key, pool, total, etag.as_deref(), offset)
            .map_err(storage_error)?;
    }
    while let Some(chunk) = response.chunk().await? {
        {
            let r = state.runtime()?;
            if offline_now(&r) || self::scope(&r)? != *scope {
                return Err(ShellError::Guard("transfer-paused"));
            }
        }
        let o = lock_store(state, "transfer::transfer_file")?;
        if pool == "offline" && !o.store.required(scope, key).map_err(storage_error)? {
            return Err(ShellError::Guard("transfer-cancelled"));
        }
        o.store
            .append(scope, key, pool, &chunk)
            .map_err(storage_error)?;
    }
    connected_scope(state, scope)?;
    lock_store(state, "transfer::transfer_file")?
        .store
        .finish(scope, key, pool)
        .map_err(storage_error)
}

pub(in crate::desktop) fn content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use krobi_offline::resolve::Resolution;
    use std::io::{Read, Write};

    #[test]
    fn byte_range_metadata_is_validated() {
        assert_eq!(content_range("bytes 0-9/10"), Some((0, 9, 10)));
        for s in ["bytes 10-9/10", "bytes 0-10/10", "bytes 0-9/*", "garbage"] {
            assert_eq!(content_range(s), None);
        }
    }

    #[test]
    fn check_7_http_short_body_resumes_with_range_and_strong_if_range() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for attempt in 0..2 {
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
                let request = String::from_utf8(bytes).unwrap().to_lowercase();
                assert!(request.contains("authorization: bearer secret"));
                if attempt == 0 {
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n12345").unwrap();
                    std::thread::sleep(Duration::from_millis(30));
                } else {
                    assert!(request.contains("range: bytes=5-"));
                    assert!(request.contains("if-range: \"v1\""));
                    socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 5-9/10\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n67890").unwrap();
                }
            }
        });
        let mut runtime = crate::desktop::tests::remote_runtime(&origin, &origin);
        runtime.server.instance_id = Some("test-nido".into());
        let state = DesktopState {
            app_dir: PathBuf::new(),
            http: Client::new(),
            runtime: Mutex::new(runtime),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(test_store()),
        };
        let scope = scope(&state.runtime().unwrap()).unwrap();
        lock(&state.offline, "offline")
            .unwrap()
            .store
            .pin(&scope, "song", "A/one.mp3", &["A/one.mp3".into()])
            .unwrap();
        assert!(tauri::async_runtime::block_on(download_with_capacity(
            &state,
            &scope,
            "A/one.mp3",
            |_, _| Ok(1024 * 1024 * 1024)
        ))
        .is_err());
        let file = lock(&state.offline, "offline")
            .unwrap()
            .store
            .file(&scope, "A/one.mp3", "offline")
            .unwrap()
            .unwrap();
        assert_ne!(file.state, DOWNLOADED);
        assert!(!file.path.exists());
        tauri::async_runtime::block_on(download_with_capacity(
            &state,
            &scope,
            "A/one.mp3",
            |_, _| Ok(1024 * 1024 * 1024),
        ))
        .unwrap();
        server.join().unwrap();
        let file = lock(&state.offline, "offline")
            .unwrap()
            .store
            .file(&scope, "A/one.mp3", "offline")
            .unwrap()
            .unwrap();
        assert_eq!(file.state, DOWNLOADED);
        assert_eq!(std::fs::read(file.path).unwrap(), b"1234567890");
    }

    #[test]
    fn media_404_while_landing_waits_then_downloads_on_the_next_attempt() {
        let (origin, server) = serve(vec![(404, "landing".into()), (200, "audio".into())]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        let key = "A/landing.mp3";
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store
                .extend_pin(&active, "album", "A", &[], true)
                .unwrap();
            o.store
                .extend_pin(&active, "album", "A", &[key.into()], false)
                .unwrap();
        }
        for (at, expected) in [(1000, "en fila"), (1029, "en fila"), (1030, DOWNLOADED)] {
            tauri::async_runtime::block_on(download_pool_at(
                &state,
                &active,
                key,
                "offline",
                |_, _| Ok(1024 * 1024 * 1024),
                Some(at),
            ))
            .unwrap();
            let mut o = lock(&state.offline, "offline").unwrap();
            assert_eq!(
                o.store
                    .file(&active, key, "offline")
                    .unwrap()
                    .unwrap()
                    .state,
                expected
            );
            let Offline { store, queue, .. } = &mut *o;
            store.queue_transfers_at(&active, queue, at).unwrap();
            assert!(queue.pop().is_none(), "404 waits; success retires the work");
        }
        assert_eq!(server.join().unwrap().len(), 2);
    }

    #[test]
    fn worker_three_404_pins_make_nine_requests_over_ten_minutes() {
        let (origin, server) = serve(vec![(404, "gone".into()); 9]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        for key in ["A/one.mp3", "A/two.mp3", "A/three.mp3"] {
            lock(&state.offline, "offline")
                .unwrap()
                .store
                .pin(&active, "song", key, &[key.into()])
                .unwrap();
        }
        let mut times = Vec::new();
        for second in 0..=600 {
            {
                let mut o = lock(&state.offline, "offline").unwrap();
                let Offline { store, queue, .. } = &mut *o;
                store
                    .queue_transfers_at(&active, queue, 1000 + second)
                    .unwrap();
            }
            loop {
                let next = lock(&state.offline, "offline").unwrap().queue.pop();
                let Some((owner, key, pool)) = next else {
                    break;
                };
                times.push(second);
                tauri::async_runtime::block_on(download_pool_at(
                    &state,
                    &owner,
                    &key,
                    &pool,
                    |_, _| Ok(1024 * 1024 * 1024),
                    Some(1000 + second),
                ))
                .unwrap();
                // A second drain in the same tick cannot spin on the 404.
                let mut o = lock(&state.offline, "offline").unwrap();
                let Offline { store, queue, .. } = &mut *o;
                store
                    .queue_transfers_at(&active, queue, 1000 + second)
                    .unwrap();
            }
        }
        assert_eq!(times, [0, 0, 0, 30, 30, 30, 150, 150, 150]);
        assert_eq!(server.join().unwrap().len(), 9);
    }

    #[test]
    fn verified_404_keeps_local_playback_and_obeys_the_same_backoff() {
        let (origin, server) = serve(vec![(404, "gone".into()); 2]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        let key = "A/verified.mp3";
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store.pin(&active, "song", key, &[key.into()]).unwrap();
            o.store
                .begin(&active, key, "offline", 5, Some("\"v1\""), 0)
                .unwrap();
            o.store.append(&active, key, "offline", b"audio").unwrap();
            o.store.finish(&active, key, "offline").unwrap();
            o.store
                .set_state(&active, key, "offline", "desactualizado", None)
                .unwrap();
        }
        for at in [1000, 1001, 1029, 1030, 1031, 1149] {
            tauri::async_runtime::block_on(download_pool_at(
                &state,
                &active,
                key,
                "offline",
                |_, _| Ok(1024 * 1024 * 1024),
                Some(at),
            ))
            .unwrap();
            let mut o = lock(&state.offline, "offline").unwrap();
            assert_eq!(
                o.store
                    .file(&active, key, "offline")
                    .unwrap()
                    .unwrap()
                    .state,
                MISSING
            );
            assert!(matches!(
                o.store.resolve(&active, key, true).unwrap(),
                Resolution::Local(_)
            ));
        }
        assert_eq!(server.join().unwrap().len(), 2);
    }

    #[test]
    fn snapshot_unavailable_tracks_never_reach_http_even_from_a_stale_queue() {
        // No server is listening: an accidental request fails this test.
        for gone in [false, true] {
            let state = state("http://127.0.0.1:1");
            let active = scope(&state.runtime().unwrap()).unwrap();
            let key = "A/unavailable.mp3";
            let available = json!([{"tracks":[{"relPath":key}]}]);
            let missing = if gone {
                json!([])
            } else {
                json!([{"tracks":[{"relPath":key,"missingFromNest":true,"missingSince":123}]}])
            };
            {
                let mut o = lock(&state.offline, "offline").unwrap();
                // Flagged rows are known before pin expansion; gone rows disappear later.
                super::super::sync::reconcile_listing(&o.store, &active, &missing, true).unwrap();
                o.store
                    .pin(&active, "library", "all", &[key.into()])
                    .unwrap();
                super::super::sync::reconcile_listing(&o.store, &active, &missing, false).unwrap();
                let Offline { store, queue, .. } = &mut *o;
                store.queue_transfers_at(&active, queue, i64::MAX).unwrap();
                assert!(queue.pop().is_none());
                assert_eq!(
                    store.file(&active, key, "offline").unwrap().unwrap().state,
                    MISSING
                );
            }
            tauri::async_runtime::block_on(download_pool_at(
                &state,
                &active,
                key,
                "offline",
                |_, _| Ok(1024 * 1024 * 1024),
                Some(i64::MAX),
            ))
            .unwrap();
            let mut o = lock(&state.offline, "offline").unwrap();
            assert_eq!(o.store.pins(&active).unwrap()[0].3, vec![key]);
            super::super::sync::reconcile_listing(&o.store, &active, &available, true).unwrap();
            let Offline { store, queue, .. } = &mut *o;
            store.queue_transfers(&active, queue).unwrap();
            assert_eq!(
                queue.pop(),
                Some((active.clone(), key.into(), "offline".into()))
            );
        }
    }

    #[test]
    fn recovered_cache_is_fetched_and_opaque_keys_survive_the_url_guard() {
        let key = "Collection∕Artist's Album  Edition/Track.mp3";
        let (origin, server) = serve(vec![(200, "complete audio".into())]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store
                .tee(&active, key, 0, 100, Some("\"old\""), &[b'X'; 20])
                .unwrap();
            let pools = o.store.pools.clone();
            let database = pools.offline.parent().unwrap().join("offline.sqlite");
            // Close and reopen the actual SQLite file, discarding the in-memory queue.
            let temporary = test_store();
            let old = std::mem::replace(&mut *o, temporary);
            drop(old);
            o.store = Store::open(&database, pools).unwrap();
            let Offline { store, queue, .. } = &mut *o;
            store.queue_transfers(&active, queue).unwrap();
        }
        let (owner, queued_key, pool) = lock(&state.offline, "offline")
            .unwrap()
            .queue
            .pop()
            .unwrap();
        assert_eq!(pool, "cache");
        assert_eq!(queued_key, key);
        let target =
            crate::desktop::downloads::media_download_target(&origin, &media_path(key)).unwrap();
        assert!(crate::desktop::proxy::is_backend_url(
            &target,
            &Url::parse(&origin).unwrap()
        ));
        assert_eq!(key_from_media(target.path()).as_deref(), Some(key));
        tauri::async_runtime::block_on(download_pool_with_capacity(
            &state,
            &owner,
            &queued_key,
            &pool,
            |_, _| Ok(1024 * 1024 * 1024),
        ))
        .unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with(
            "GET /api/media/Collection%E2%88%95Artist%27s%20Album%20%20Edition/Track.mp3 "
        ));
        assert!(requests[0].to_lowercase().contains("range: bytes=20-"));
        assert!(requests[0].to_lowercase().contains("if-range: \"old\""));
        let file = lock(&state.offline, "offline")
            .unwrap()
            .store
            .file(&active, key, "cache")
            .unwrap()
            .unwrap();
        assert_eq!(file.state, DOWNLOADED);
        assert_eq!(std::fs::read(file.path).unwrap(), b"complete audio");
    }

    #[test]
    fn stale_if_range_rejection_restarts_without_range_in_both_pools() {
        for pool in ["cache", "offline"] {
            for status in [200, 412, 416, 206] {
                let replies = if status == 200 {
                    vec![(200, "complete audio".into())]
                } else {
                    vec![(status, "changed".into()), (200, "complete audio".into())]
                };
                let (origin, server) = serve(replies);
                let state = state(&origin);
                let active = scope(&state.runtime().unwrap()).unwrap();
                let key = "Collection/Track.mp3";
                {
                    let mut o = lock(&state.offline, "offline").unwrap();
                    if pool == "offline" {
                        o.store.pin(&active, "song", key, &[key.into()]).unwrap();
                    }
                    o.store
                        .begin(&active, key, pool, 100, Some("\"old\""), 0)
                        .unwrap();
                    o.store.append(&active, key, pool, &[b'X'; 20]).unwrap();
                }
                tauri::async_runtime::block_on(download_pool_with_capacity(
                    &state,
                    &active,
                    key,
                    pool,
                    |_, _| Ok(1024 * 1024 * 1024),
                ))
                .unwrap();
                let requests = server.join().unwrap();
                assert!(requests[0].to_lowercase().contains("range: bytes=20-"));
                if status != 200 {
                    assert_eq!(requests.len(), 2);
                    assert!(!requests[1].to_lowercase().contains("range:"));
                }
                let file = lock(&state.offline, "offline")
                    .unwrap()
                    .store
                    .file(&active, key, pool)
                    .unwrap()
                    .unwrap();
                assert_eq!(file.state, DOWNLOADED);
                assert_eq!(file.etag.as_deref(), Some("\"server-v2\""));
                assert_eq!(std::fs::read(file.path).unwrap(), b"complete audio");
            }
        }
    }

    #[test]
    fn failed_cache_transfer_has_a_reason_instead_of_an_ownerless_spinner() {
        let (origin, server) = serve(vec![(503, "busy".into())]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        let key = "Collection/Track.mp3";
        lock(&state.offline, "offline")
            .unwrap()
            .store
            .ensure_file(&active, key, "cache")
            .unwrap();
        assert!(tauri::async_runtime::block_on(download_pool_with_capacity(
            &state,
            &active,
            key,
            "cache",
            |_, _| Ok(1024 * 1024 * 1024),
        ))
        .is_err());
        server.join().unwrap();
        let file = lock(&state.offline, "offline")
            .unwrap()
            .store
            .file(&active, key, "cache")
            .unwrap()
            .unwrap();
        assert_eq!(file.state, "fallido");
        assert!(file.error.unwrap().contains("download-http-503"));
    }
}
