//! Snapshot refresh, queued intent replay and play history synchronization.

use super::*;

pub(super) fn snapshot_path(kind: &str) -> ShellResult<String> {
    match kind {
        "listing" => Ok("/api/listar-albums-con-metadata?covers=false".into()),
        "library" => Ok("/api/me/library".into()),
        "playlists" => Ok("/api/playlists".into()),
        "home" => Ok("/api/me/home".into()),
        _ => kind
            .strip_prefix("playlist:")
            .filter(|s| !s.is_empty())
            .map(|s| {
                format!(
                    "/api/playlists/{}",
                    url::form_urlencoded::byte_serialize(s.as_bytes())
                        .collect::<String>()
                        .replace('+', "%20")
                )
            })
            .ok_or(ShellError::Guard("invalid-snapshot-kind")),
    }
}

/// True when the nest sent a new body (not a 304).
pub(super) async fn refresh_snapshot(
    state: &DesktopState,
    active: &Scope,
    kind: &str,
) -> ShellResult<bool> {
    let (origin, token) = connected_scope(state, active)?;
    let old = lock_store(state, "sync::refresh_snapshot")?
        .store
        .snapshot(active, kind)
        .map_err(storage_error)?;
    let mut request = state
        .http
        .get(format!("{origin}{}", snapshot_path(kind)?))
        .bearer_auth(token);
    if let Some(etag) = old.as_ref().and_then(|s| s.etag.as_deref()) {
        request = request.header("If-None-Match", etag);
    }
    let response = request
        .send()
        .await
        .inspect_err(|_| state.proxy_failure(None))?;
    let status = response.status();
    let etag = response
        .headers()
        .get("etag")
        .and_then(|s| s.to_str().ok())
        .map(str::to_owned);
    let body = response.text().await?;
    if status.as_u16() == 401 {
        if self::scope(&*state.runtime()?)? == *active {
            lock_store(state, "sync::refresh_snapshot")?
                .store
                .revoke(active)
                .map_err(storage_error)?;
        }
        return Err(ShellError::Guard("account-revoked"));
    }
    connected_scope(state, active)?;
    let revised = old
        .as_ref()
        .map_or(true, |saved| saved.body != body || saved.etag != etag);
    let parsed = if status.as_u16() == 304 {
        old.as_ref()
            .map(|saved| serde_json::from_str::<Value>(&saved.body))
            .transpose()?
    } else if status.is_success() {
        Some(serde_json::from_str::<Value>(&body)?)
    } else {
        None
    };
    let tracks = if kind == "listing" {
        parsed.as_ref().map(listing_tracks).transpose()?
    } else {
        None
    };
    let o = lock_store(state, "sync::snapshot-commit")?;
    if status.as_u16() == 304 || status.is_success() {
        let mut changed = false;
        if let Some(tracks) = tracks {
            changed |= o
                .store
                .reconcile_library(active, &tracks, status.as_u16() != 304 && revised)
                .map_err(storage_error)?;
        }
        if status.as_u16() == 304 {
            o.store
                .touch_snapshot(active, kind)
                .map_err(storage_error)?;
        } else {
            o.store
                .save_snapshot(active, kind, &body, etag.as_deref())
                .map_err(storage_error)?;
        }
        Ok(changed || (status.as_u16() != 304 && revised))
    } else if kind.starts_with("playlist:") && matches!(status.as_u16(), 403 | 404 | 410) {
        o.store
            .delete_snapshot(active, kind)
            .map_err(storage_error)?;
        Ok(old.is_some())
    } else {
        Err(ShellError::Message(format!("snapshot: {status}")))
    }
}

/// Decode the listing at the native boundary using the same canonical keys as playback.
#[cfg(test)]
pub(super) fn reconcile_listing(
    store: &Store,
    active: &Scope,
    listing: &Value,
    revision: bool,
) -> ShellResult<bool> {
    store
        .reconcile_library(active, &listing_tracks(listing)?, revision)
        .map_err(storage_error)
}
fn listing_tracks(listing: &Value) -> ShellResult<std::collections::BTreeMap<String, bool>> {
    let Some(albums) = listing.as_array() else {
        return Err(ShellError::Guard("invalid-library-listing"));
    };
    let mut tracks = std::collections::BTreeMap::new();
    for album in albums {
        for track in album["tracks"].as_array().into_iter().flatten() {
            if let Some(key) = player_track_key(track) {
                tracks.insert(key, track["missingFromNest"].as_bool().unwrap_or(false));
            }
        }
    }
    Ok(tracks)
}

/// True when something changed: a queued change was replayed or a snapshot
/// came back different. The 30 s tick announces only then — announcing every
/// tick reloaded the whole library and re-rendered every row twice a minute.
pub(super) async fn sync(state: &DesktopState, active: &Scope) -> ShellResult<bool> {
    let gate = lock_store(state, "sync::sync")?.sync.clone();
    let _guard = gate.lock().await;
    connected_scope(state, active)?;
    {
        let o = lock_store(state, "sync::sync")?;
        if o.last_sync
            .as_ref()
            .is_some_and(|(scope, at)| scope == active && at.elapsed() < Duration::from_secs(1))
            && !o
                .store
                .outbox(active)
                .map_err(storage_error)?
                .iter()
                .any(|r| !r.failed())
            && o.store
                .plays_batch(active)
                .map_err(storage_error)?
                .is_empty()
        {
            return Ok(false);
        }
    }

    let mut changed_anything = false;
    loop {
        let row = lock_store(state, "sync::sync")?
            .store
            .outbox(active)
            .map_err(storage_error)?
            .into_iter()
            .find(|r| !r.failed());
        let Some(row) = row else { break };
        changed_anything = true;
        let (origin, token) = connected_scope(state, active)?;
        let body: Value = serde_json::from_str(&row.body)?;
        let (method, path, payload) = match row.intent.as_str() {
            "library-add" => (
                reqwest::Method::POST,
                "/api/me/library".into(),
                body.clone(),
            ),
            "library-remove" => (
                reqwest::Method::DELETE,
                "/api/me/library".into(),
                body.clone(),
            ),
            "playlist-edit" => {
                let name = body["name"]
                    .as_str()
                    .ok_or(ShellError::Guard("invalid-playlist"))?;
                (
                    reqwest::Method::PUT,
                    format!("{}/tracks", snapshot_path(&format!("playlist:{name}"))?),
                    body["tracks"].clone(),
                )
            }
            _ => return Err(ShellError::Guard("offline-action-refused")),
        };
        lock_store(state, "sync::sync")?
            .store
            .attempt(active, &row.id)
            .map_err(storage_error)?;
        let mut request = state
            .http
            .request(method, format!("{origin}{path}"))
            .bearer_auth(token)
            .header("Idempotency-Key", &row.idempotency_key)
            .json(&payload);
        if row.intent == "playlist-edit" {
            request = request.header(
                "If-Match",
                body["etag"]
                    .as_str()
                    .ok_or(ShellError::Guard("playlist-version-required"))?,
            );
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                let result = response.text().await?;
                if status.as_u16() == 401 {
                    if self::scope(&*state.runtime()?)? == *active {
                        lock_store(state, "sync::sync")?
                            .store
                            .revoke(active)
                            .map_err(storage_error)?;
                    }
                    return Err(ShellError::Guard("account-revoked"));
                }
                connected_scope(state, active)?;
                let o = lock_store(state, "sync::sync")?;
                if status.is_success() {
                    o.store
                        .discard_intent(active, &row.id)
                        .map_err(storage_error)?;
                } else {
                    o.store
                        .reject_intent(
                            active,
                            &row.id,
                            &format!("{}:{result}", status.as_u16()),
                            matches!(status.as_u16(), 412 | 422 | 403 | 404),
                        )
                        .map_err(storage_error)?;
                    if !matches!(status.as_u16(), 412 | 422 | 403 | 404) {
                        return Err(ShellError::Message(format!("outbox: {status}")));
                    }
                }
            }
            Err(error) => {
                state.proxy_failure(None);
                lock_store(state, "sync::sync")?
                    .store
                    .reject_intent(active, &row.id, &error.to_string(), false)
                    .map_err(storage_error)?;
                return Err(error.into());
            }
        }
    }
    let mut kinds = lock_store(state, "sync::sync")?
        .store
        .snapshot_kinds(active)
        .map_err(storage_error)?;
    let pins = lock_store(state, "sync::pin-snapshot")?
        .store
        .pins(active)
        .map_err(storage_error)?;
    for (_, kind, reference, _) in pins {
        let snapshot = format!("playlist:{reference}");
        if kind == "playlist" && !kinds.contains(&snapshot) {
            kinds.push(snapshot);
        }
    }
    for kind in ["listing", "library", "playlists", "home"] {
        if !kinds.iter().any(|k| k == kind) {
            kinds.push(kind.into());
        }
    }
    for kind in kinds {
        changed_anything |= refresh_snapshot(state, active, &kind).await?;
    }
    let pins_changed = refresh_playlist_pins(state, active)?;
    changed_anything |= pins_changed;
    loop {
        let plays = lock_store(state, "sync::sync")?
            .store
            .plays_batch(active)
            .map_err(storage_error)?;
        if plays.is_empty() {
            break;
        }
        let (origin, token) = connected_scope(state, active)?;
        let batch=plays.iter().map(|p|json!({"trackKey":p.track_key,"listenedAt":p.listened_at,"clientPlayId":p.client_play_id})).collect::<Vec<_>>();
        let response = state
            .http
            .post(format!("{origin}/api/me/plays"))
            .bearer_auth(token)
            .json(&json!({"plays":batch}))
            .send()
            .await?;
        let status = response.status();
        if status.as_u16() == 401 {
            lock_store(state, "sync::sync")?
                .store
                .revoke(active)
                .map_err(storage_error)?;
            return Err(ShellError::Guard("account-revoked"));
        }
        connected_scope(state, active)?;
        if !status.is_success() {
            return Err(ShellError::Message(format!("plays: {status}")));
        }
        lock_store(state, "sync::sync")?
            .store
            .acknowledge_plays(active, &plays)
            .map_err(storage_error)?;
    }
    lock_store(state, "sync::sync")?.last_sync = Some((active.clone(), std::time::Instant::now()));
    Ok(changed_anything)
}

/// Join absolute playlist paths to the listing's canonical media keys. No filename guessing.
fn refresh_playlist_pins(state: &DesktopState, active: &Scope) -> ShellResult<bool> {
    connected_scope(state, active)?;
    let (saved_listing, pins) = {
        let o = lock_store(state, "sync::playlist-snapshot")?;
        (
            o.store.snapshot(active, "listing").map_err(storage_error)?,
            o.store.pins(active).map_err(storage_error)?,
        )
    };
    let listing: Value = saved_listing
        .map(|s| serde_json::from_str(&s.body))
        .transpose()?
        .unwrap_or(Value::Null);
    let mut keys_by_path = std::collections::BTreeMap::new();
    for album in listing.as_array().into_iter().flatten() {
        for track in album["tracks"].as_array().into_iter().flatten() {
            if let (Some(path), Some(key)) = (track["path"].as_str(), player_track_key(track)) {
                keys_by_path.insert(path.to_owned(), key);
            }
        }
    }
    let mut changed = lock_store(state, "sync::repair-pins")?
        .store
        .repair_pin_files(active)
        .map_err(storage_error)?;
    for (_, kind, reference, _) in pins {
        if kind != "playlist" {
            continue;
        }
        let Some(snapshot) = lock_store(state, "sync::playlist-row")?
            .store
            .snapshot(active, &format!("playlist:{reference}"))
            .map_err(storage_error)?
        else {
            continue;
        };
        let body: Value = serde_json::from_str(&snapshot.body)?;
        let Some(tracks) = body["tracks"].as_array() else {
            continue;
        };
        let keys: Option<Vec<_>> = tracks
            .iter()
            .map(|t| {
                player_track_key(t).or_else(|| {
                    t["path"]
                        .as_str()
                        .and_then(|path| keys_by_path.get(path).cloned())
                })
            })
            .collect();
        // A stale listing must not accidentally release existing downloads.
        if let Some(keys) = keys {
            let mut o = lock_store(state, "sync::refresh-pin")?;
            let before = o
                .store
                .pin_keys(active, &kind, &reference)
                .map_err(storage_error)?;
            changed |= o
                .store
                .refresh_pin(active, &kind, &reference, &keys)
                .map_err(storage_error)?;
            if before
                != o.store
                    .pin_keys(active, &kind, &reference)
                    .map_err(storage_error)?
            {
                o.pins_changed = true;
            }
        }
    }
    if listing.is_array() {
        let tracks = listing_tracks(&listing)?;
        changed |= lock_store(state, "sync::reconcile")?
            .store
            .reconcile_library(active, &tracks, false)
            .map_err(storage_error)?;
    }
    lock_store(state, "sync::sweep")?
        .store
        .sweep_pending()
        .map_err(storage_error)?;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_revision_nudges_missing_once_but_304_and_repeated_bodies_do_not() {
        let key = "A/landing.mp3";
        let first = json!([{"tracks":[{"relPath":key,"title":"First"}]}]).to_string();
        let next = json!([{"tracks":[{"relPath":key,"title":"Next"}]}]).to_string();
        let (origin, server) = serve(vec![
            (200, first.clone()),
            (304, String::new()),
            (200, first),
            (200, next),
        ]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store.pin(&active, "song", key, &[key.into()]).unwrap();
            o.store
                .remote_file_missing_at(&active, key, "offline", 1000)
                .unwrap();
        }
        for (index, expected) in [true, false, false, true].into_iter().enumerate() {
            tauri::async_runtime::block_on(refresh_snapshot(&state, &active, "listing")).unwrap();
            let o = lock(&state.offline, "offline").unwrap();
            assert_eq!(
                o.store
                    .transfer_due_at(&active, key, "offline", 1001)
                    .unwrap(),
                expected,
                "refresh {index}"
            );
            if index == 0 {
                o.store
                    .remote_file_missing_at(&active, key, "offline", 1001)
                    .unwrap();
            }
        }
        assert_eq!(server.join().unwrap().len(), 4);
    }

    #[test]
    fn sync_refreshes_the_tracks_of_an_existing_playlist_pin() {
        let first = "Collection/First.mp3";
        let new = "Collection∕Artist's Album  Edition/Second.mp3";
        let path = "/library/Collection/Artist's Album  Edition/Second.mp3";
        let playlist = json!({"tracks":[{"relPath": first}, {"path": path}]}).to_string();
        let listing = json!([{"tracks":[{"path": path, "url_path": media_path(new)}]}]).to_string();
        let (origin, server) = serve(vec![
            (200, playlist),
            (200, listing),
            (200, "{\"tracks\":[]}".into()),
            (200, "[]".into()),
            (200, "{}".into()),
            (200, "complete audio".into()),
        ]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store
                .pin(&active, "playlist", "Collection", &[first.into()])
                .unwrap();
            o.store
                .begin(&active, first, "offline", 5, Some("\"v1\""), 0)
                .unwrap();
            o.store.append(&active, first, "offline", b"first").unwrap();
            o.store.finish(&active, first, "offline").unwrap();
            o.store
                .tee(&active, new, 0, 100, Some("\"old\""), &[b'X'; 20])
                .unwrap();
        }
        assert!(tauri::async_runtime::block_on(sync(&state, &active)).unwrap());
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            assert_eq!(
                o.store
                    .file(&active, new, "offline")
                    .unwrap()
                    .unwrap()
                    .state,
                "en fila"
            );
            let Offline { store, queue, .. } = &mut *o;
            store.queue_transfers(&active, queue).unwrap();
        }
        // Cache resumes first; the pin then adopts the verified copy without another GET.
        for expected_pool in ["cache", "offline"] {
            let (owner, key, pool) = lock(&state.offline, "offline")
                .unwrap()
                .queue
                .pop()
                .unwrap();
            assert_eq!(pool, expected_pool);
            tauri::async_runtime::block_on(download_pool_with_capacity(
                &state,
                &owner,
                &key,
                &pool,
                |_, _| Ok(1024 * 1024 * 1024),
            ))
            .unwrap();
        }
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 6);
        assert!(requests[0].starts_with("GET /api/playlists/Collection "));
        let o = lock(&state.offline, "offline").unwrap();
        assert_eq!(
            o.store.pins(&active).unwrap()[0].3,
            vec![first.to_owned(), new.to_owned()]
        );
        assert_eq!(
            o.store
                .file(&active, new, "offline")
                .unwrap()
                .unwrap()
                .state,
            DOWNLOADED
        );
        assert!(o.store.file(&active, new, "cache").unwrap().is_none());
        let files = o.store.files(&active).unwrap();
        assert_eq!(files.iter().filter(|f| f.pool == "offline").count(), 2);
    }

    #[test]
    fn a_playlist_snapshot_the_nest_no_longer_serves_is_dropped_and_the_sync_goes_on() {
        for gone in [404u16, 403] {
            // snapshot_kinds is ordered by kind: listing, playlist:Gone, then
            // the defaults the sync adds: library, playlists, home.
            let (origin, server) = serve(vec![
                (200, "[]".into()),
                (gone, "{\"detail\":\"no\"}".into()),
                (200, "{\"tracks\":[]}".into()),
                (200, "[]".into()),
                (200, "{}".into()),
            ]);
            let state = state(&origin);
            let active = scope(&state.runtime().unwrap()).unwrap();
            {
                let o = lock(&state.offline, "offline").unwrap();
                o.store
                    .save_snapshot(&active, "listing", "[]", Some("\"v1\""))
                    .unwrap();
                o.store
                    .save_snapshot(&active, "playlist:Gone", "{}", Some("\"v1\""))
                    .unwrap();
            }
            tauri::async_runtime::block_on(sync(&state, &active)).unwrap();
            let requests = server.join().unwrap();
            assert_eq!(
                requests.len(),
                5,
                "every snapshot is still refreshed after {gone}"
            );
            let o = lock(&state.offline, "offline").unwrap();
            assert!(
                o.store
                    .snapshot(&active, "playlist:Gone")
                    .unwrap()
                    .is_none(),
                "{gone} drops the copy"
            );
            assert!(o.store.snapshot(&active, "home").unwrap().is_some());
        }
    }

    #[test]
    fn replay_fifo_surfaces_412_preserves_both_versions_then_snapshots_then_plays() {
        let conflict = r#"{"detail":{"code":"playlist-changed","etag":"\"v2\"","current":{"tracks":[{"title":"Remote"}]}}}"#;
        let (origin, server) = serve(vec![
            (412, conflict.into()),
            (200, "{}".into()),
            (304, "".into()),
            (200, "{\"tracks\":[]}".into()),
            (200, "[]".into()),
            (200, "{\"albums\":[]}".into()),
            (200, "{}".into()),
            (200, "{}".into()),
        ]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        let local=json!({"name":"List","tracks":[{"title":"Local"}],"etag":"\"v1\"","base":{"tracks":[]}}).to_string();
        {
            let o = lock(&state.offline, "offline").unwrap();
            o.store
                .enqueue(&active, "z-first", "playlist-edit", &local)
                .unwrap();
            o.store
                .enqueue(
                    &active,
                    "a-second",
                    "library-add",
                    r#"{"relPaths":["A/one.mp3"]}"#,
                )
                .unwrap();
            o.store
                .save_snapshot(&active, "listing", "[]", Some("\"v1\""))
                .unwrap();
            for n in (0..51).rev() {
                o.store
                    .queue_play(
                        &active,
                        &krobi_offline::outbox::Play {
                            client_play_id: n.to_string(),
                            track_key: "A/one.mp3".into(),
                            listened_at: n,
                        },
                    )
                    .unwrap();
            }
        }
        tauri::async_runtime::block_on(sync(&state, &active)).unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("PUT /api/playlists/List/tracks"));
        assert!(requests[0]
            .to_lowercase()
            .contains("idempotency-key: z-first"));
        assert!(requests[0].to_lowercase().contains("if-match: \"v1\""));
        assert!(requests[1].starts_with("POST /api/me/library"));
        assert!(requests[2].starts_with("GET /api/listar-albums-con-metadata?covers=false"));
        assert!(requests[2].to_lowercase().contains("if-none-match: \"v1\""));
        let first: Value =
            serde_json::from_str(requests[6].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(first["plays"].as_array().unwrap().len(), 50);
        assert_eq!(first["plays"][0]["listenedAt"], 0);
        let second: Value =
            serde_json::from_str(requests[7].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(second["plays"].as_array().unwrap().len(), 1);
        let o = lock(&state.offline, "offline").unwrap();
        let rows = o.store.outbox(&active).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].failed());
        assert_eq!(rows[0].body, local);
        assert_eq!(
            rows[0].last_error.as_deref(),
            Some(format!("412:{conflict}").as_str())
        );
        assert_eq!(
            o.store.snapshot(&active, "listing").unwrap().unwrap().body,
            "[]"
        );
        assert!(o.store.snapshot(&active, "home").unwrap().is_some());
        assert!(o.store.plays_batch(&active).unwrap().is_empty());
    }

    #[test]
    fn retries_keep_the_same_key_and_stop_after_five_with_the_reason() {
        let (origin, server) = serve(vec![(503, "busy".into()); 5]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        lock(&state.offline, "offline")
            .unwrap()
            .store
            .enqueue(
                &active,
                "stable",
                "library-add",
                r#"{"relPaths":["A/one.mp3"]}"#,
            )
            .unwrap();
        for _ in 0..5 {
            assert!(tauri::async_runtime::block_on(sync(&state, &active)).is_err());
        }
        for request in server.join().unwrap() {
            assert!(request.to_lowercase().contains("idempotency-key: stable"));
        }
        let o = lock(&state.offline, "offline").unwrap();
        let rows = o.store.outbox(&active).unwrap();
        assert!(rows[0].failed());
        assert_eq!(rows[0].attempts, 5);
        assert_eq!(rows[0].last_error.as_deref(), Some("503:busy"));
    }
}
