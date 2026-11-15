//! Offline IPC and compatibility HTTP commands.

use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    key: String,
    bytes: Option<u64>,
    #[serde(default)]
    in_library: bool,
}

#[derive(Deserialize)]
struct PinRequest {
    kind: String,
    #[serde(rename = "ref")]
    reference: String,
    tracks: Vec<Track>,
    mode: Option<String>,
}

/// Compatibility HTTP callers still obey the shell's queue/refuse policy.
pub(in crate::desktop) fn offline_request(
    state: &DesktopState,
    active: &Scope,
    path: &str,
    method: &str,
    raw: Option<&str>,
    headers: &BTreeMap<String, String>,
) -> ShellResult<Value> {
    if method == "GET" {
        let kind = match path {
            "/api/listar-albums-con-metadata" => "listing".into(),
            "/api/me/library" => "library".into(),
            "/api/playlists" => "playlists".into(),
            "/api/me/home" => "home".into(),
            _ if path.starts_with("/api/playlists/") && path.matches('/').count() == 3 => format!(
                "playlist:{}",
                percent_encoding::percent_decode_str(path.rsplit('/').next().unwrap_or(""))
                    .decode_utf8()
                    .map_err(storage_error)?
            ),
            _ => return Err(ShellError::Guard("offline-action-refused")),
        };
        let row = lock_store(state, "request::snapshot")?
            .store
            .snapshot(active, &kind)
            .map_err(storage_error)?;
        return row
            .map(|s| serde_json::from_str(&s.body).map_err(ShellError::from))
            .unwrap_or(Err(ShellError::Guard("snapshot-unavailable")));
    }
    let body: Value = serde_json::from_str(raw.unwrap_or("null"))?;
    let (intent, body, reply) = if path == "/api/me/library" && matches!(method, "POST" | "DELETE")
    {
        let keys = body["relPaths"]
            .as_array()
            .filter(|rows| {
                rows.len() <= 500 && rows.iter().all(|k| k.as_str().is_some_and(valid_key))
            })
            .ok_or(ShellError::Guard("invalid-track-key"))?;
        if method == "DELETE" {
            for key in keys {
                lock_store(state, "request::remove-track")?
                    .store
                    .remove_library_track(active, key.as_str().unwrap_or(""))
                    .map_err(storage_error)?;
            }
            lock_store(state, "request::sweep")?
                .store
                .sweep_pending()
                .map_err(storage_error)?;
        }
        (
            if method == "POST" {
                "library-add"
            } else {
                "library-remove"
            },
            body.clone(),
            if method == "POST" {
                json!({"added":keys,"already":[],"missing":[],"queued":true})
            } else {
                json!({"removed":keys,"queued":true})
            },
        )
    } else if method == "PUT" && path.starts_with("/api/playlists/") && path.ends_with("/tracks") {
        let name = percent_encoding::percent_decode_str(
            path.trim_start_matches("/api/playlists/")
                .trim_end_matches("/tracks"),
        )
        .decode_utf8()
        .map_err(storage_error)?;
        let snapshot = lock_store(state, "request::playlist")?
            .store
            .snapshot(active, &format!("playlist:{name}"))
            .map_err(storage_error)?
            .ok_or(ShellError::Guard("playlist-version-required"))?;
        if !body.is_array() {
            return Err(ShellError::Guard("invalid-playlist"));
        }
        let etag = headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("if-match"))
            .map(|(_, v)| v.clone())
            .or(snapshot.etag)
            .ok_or(ShellError::Guard("playlist-version-required"))?;
        (
            "playlist-edit",
            json!({"name":name,"tracks":body,"etag":etag,"base":serde_json::from_str::<Value>(&snapshot.body)?}),
            json!({"success":true,"queued":true}),
        )
    } else {
        return Err(ShellError::Guard("offline-action-refused"));
    };
    let id = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("idempotency-key"))
        .map(|(_, v)| v.clone())
        .unwrap_or_else(|| format!("desktop-{:032x}", rand::random::<u128>()));
    lock_store(state, "request::enqueue")?
        .store
        .enqueue(active, &id, intent, &body.to_string())
        .map_err(storage_error)?;
    Ok(reply)
}

fn snapshot_json(row: Option<krobi_offline::snapshot::Snapshot>) -> Value {
    row.map(|s| json!({"kind":s.kind,"body":s.body,"etag":s.etag,"fetchedAt":s.fetched_at}))
        .unwrap_or(Value::Null)
}

fn intent_json(row: krobi_offline::outbox::Intent) -> Value {
    json!({"id":row.id,"idempotencyKey":row.idempotency_key,"intent":row.intent,"body":row.body,"createdAt":row.created_at,"attempts":row.attempts,"lastError":row.last_error,"state":if row.failed(){"failed"}else{"queued"}})
}

/// Take the runtime lock once; re-locking a held guard deadlocks offline reads.
fn offline_mode(state: &DesktopState, forced: Option<bool>) -> ShellResult<(bool, bool)> {
    let mut runtime = state.runtime()?;
    match forced {
        Some(value) => {
            if runtime.preferences.offline_mode == value {
                return Ok((value, false));
            }
            runtime.preferences.offline_mode = value;
            state.save_preferences(runtime)?;
            Ok((value, true))
        }
        None => Ok((runtime.preferences.offline_mode, false)),
    }
}

pub(in crate::desktop) async fn invoke(
    app: &AppHandle,
    state: &DesktopState,
    channel: &str,
    request: Option<&Value>,
) -> ShellResult<Value> {
    if channel == "offline:mode" {
        let (forced, did_change) =
            offline_mode(state, request.and_then(|v| v["forced"].as_bool()))?;
        if did_change {
            changed(app, Change::STATE);
        }
        return Ok(json!({ "forced": forced }));
    }
    if channel == "offline:sync" {
        let active = {
            let r = state.runtime()?;
            if connection_state(&r.server) != "connected" || offline_now(&r) {
                return Err(ShellError::Guard("offline"));
            }
            // An unsigned desktop can browse and authenticate. It has no
            // account snapshot/outbox to replay before its network queries.
            scope(&r).ok()
        };
        if let Some(active) = active {
            let result = sync(state, &active).await?;
            if result {
                let reason = lock_store(state, "sync::change")?.take_change();
                changed(app, reason);
            }
        }
        let _ = app.emit("offline:synced", ());
        return Ok(json!({"ok":true}));
    }
    // A credential saved before the shell kept the account id has none; read it
    // once from the nest before refusing with account-required.
    let missing_account = {
        let r = state.runtime()?;
        matches!(scope(&r), Err(ShellError::Guard("account-required")))
    };
    if missing_account {
        crate::desktop::bridge::backfill_identity(app).await;
    }
    let (scope, origin, token, unreachable, configured) = {
        let r = state.runtime()?;
        (
            scope(&r)?,
            r.backend_origin.clone(),
            r.token.clone(),
            offline_now(&r),
            r.configured_origin.clone(),
        )
    };
    if import_legacy(state, &scope, &configured)? {
        changed(app, Change::PINS);
    }
    match channel {
        "offline:snapshot" => {
            let kind = request
                .and_then(|v| v["kind"].as_str())
                .ok_or(ShellError::Guard("invalid-snapshot-kind"))?;
            snapshot_path(kind)?;
            if !unreachable && connection_state(&state.runtime()?.server) == "connected" {
                if sync(state, &scope).await? {
                    let reason = lock_store(state, "snapshot::change")?.take_change();
                    changed(app, reason);
                }
                let exists = lock_store(state, "commands::invoke")?
                    .store
                    .snapshot(&scope, kind)
                    .map_err(storage_error)?
                    .is_some();
                if !exists && refresh_snapshot(state, &scope, kind).await? {
                    changed(app, Change::STATE);
                }
            }
            let o = lock_store(state, "commands::invoke")?;
            Ok(snapshot_json(
                o.store.snapshot(&scope, kind).map_err(storage_error)?,
            ))
        }
        "offline:play" => {
            let v = request.ok_or(ShellError::Guard("invalid-play"))?;
            let play = krobi_offline::outbox::Play {
                client_play_id: v["clientPlayId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or(ShellError::Guard("invalid-play"))?
                    .into(),
                track_key: v["trackKey"]
                    .as_str()
                    .filter(|s| valid_key(s))
                    .ok_or(ShellError::Guard("invalid-track-key"))?
                    .into(),
                listened_at: v["listenedAt"]
                    .as_i64()
                    .ok_or(ShellError::Guard("invalid-play"))?,
            };
            let saved = lock_store(state, "play::snapshot")?
                .store
                .snapshot(&scope, "library")
                .map_err(storage_error)?;
            let library = saved.and_then(|s| serde_json::from_str::<Value>(&s.body).ok());
            let member = library
                .as_ref()
                .and_then(|v| v["tracks"].as_array())
                .is_some_and(|rows| {
                    rows.iter()
                        .any(|r| r["relPath"].as_str() == Some(&play.track_key))
                });
            if !member {
                return Err(ShellError::Guard("not-in-library"));
            }
            lock_store(state, "play::enqueue")?
                .store
                .queue_play(&scope, &play)
                .map_err(storage_error)?;
            changed(app, Change::STATE);
            Ok(json!({"ok":true}))
        }
        "offline:outbox" => {
            let action = request.and_then(|v| v["action"].as_str()).unwrap_or("list");
            let mut pins_changed = false;
            if action == "enqueue" {
                let v = request.ok_or(ShellError::Guard("invalid-intent"))?;
                let intent = v["intent"]
                    .as_str()
                    .ok_or(ShellError::Guard("invalid-intent"))?;
                let body = &v["body"];
                if intent == "playlist-edit"
                    && (body["etag"].as_str().is_none()
                        || body["base"].is_null()
                        || body["name"].as_str().is_none()
                        || !body["tracks"].is_array())
                {
                    return Err(ShellError::Guard("playlist-version-required"));
                }
                if matches!(intent, "library-add" | "library-remove")
                    && !body["relPaths"].as_array().is_some_and(|rows| {
                        !rows.is_empty() && rows.iter().all(|k| k.as_str().is_some_and(valid_key))
                    })
                {
                    return Err(ShellError::Guard("invalid-track-key"));
                }
                if intent == "library-remove" {
                    if let Some(keys) = body["relPaths"].as_array() {
                        // These rows are device state; the account intent remains durable.
                        for key in keys.iter().filter_map(Value::as_str) {
                            let mut o = lock_store(state, "outbox::remove-track")?;
                            o.store
                                .remove_library_track(&scope, key)
                                .map_err(storage_error)?;
                        }
                        lock_store(state, "outbox::sweep")?
                            .store
                            .sweep_pending()
                            .map_err(storage_error)?;
                        pins_changed = true;
                    }
                }
                let id = v["id"]
                    .as_str()
                    .ok_or(ShellError::Guard("invalid-intent"))?;
                lock_store(state, "outbox::enqueue")?
                    .store
                    .enqueue(&scope, id, intent, &body.to_string())
                    .map_err(storage_error)?;
            } else if action == "retry" || action == "discard" {
                let id = request
                    .and_then(|v| v["id"].as_str())
                    .ok_or(ShellError::Guard("invalid-intent"))?;
                if action == "retry" {
                    lock_store(state, "outbox::retry")?
                        .store
                        .retry_intent(&scope, id)
                        .map_err(storage_error)?;
                } else {
                    lock_store(state, "outbox::discard")?
                        .store
                        .discard_intent(&scope, id)
                        .map_err(storage_error)?;
                }
            } else if action != "list" {
                return Err(ShellError::Guard("invalid-outbox-action"));
            }
            let rows = lock_store(state, "outbox::snapshot")?
                .store
                .outbox(&scope)
                .map_err(storage_error)?;
            let rows = rows.into_iter().map(intent_json).collect::<Vec<_>>();
            if action != "list" {
                changed(
                    app,
                    if pins_changed {
                        Change::PINS
                    } else {
                        Change::STATE
                    },
                );
            }
            Ok(json!(rows))
        }
        "offline:pin" => {
            let pin: PinRequest = serde_json::from_value(request.cloned().unwrap_or(Value::Null))?;
            if pin.tracks.len() > 100_000 || pin.tracks.iter().any(|t| !valid_key(&t.key)) {
                return Err(ShellError::Guard("invalid-track-key"));
            }
            if !matches!(pin.kind.as_str(), "song" | "album" | "playlist" | "library")
                || pin.reference.is_empty()
                || pin.mode.as_deref().is_some_and(|mode| {
                    !matches!(mode, "ensure" | "append")
                        || !matches!(pin.kind.as_str(), "album" | "playlist")
                })
                || (pin.kind == "song"
                    && (pin.tracks.len() != 1 || pin.tracks[0].key != pin.reference))
            {
                return Err(ShellError::Guard("invalid-pin"));
            }
            let missing = pin
                .tracks
                .iter()
                .filter(|t| !t.in_library)
                .map(|t| t.key.clone())
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                if unreachable {
                    for batch in missing.chunks(500) {
                        let o = lock_store(state, "pin::enqueue-library")?;
                        let id = format!("desktop-{:032x}", rand::random::<u128>());
                        o.store
                            .enqueue(
                                &scope,
                                &id,
                                "library-add",
                                &json!({"relPaths":batch}).to_string(),
                            )
                            .map_err(storage_error)?;
                    }
                } else {
                    for batch in missing.chunks(500) {
                        let reply = state
                            .http
                            .post(format!("{origin}/api/me/library"))
                            .header(
                                "Idempotency-Key",
                                format!("desktop-{:032x}", rand::random::<u128>()),
                            )
                            .bearer_auth(&token)
                            .json(&json!({"relPaths":batch}))
                            .send()
                            .await?;
                        if !reply.status().is_success() {
                            return Ok(json!({"ok":false,"reason":"library-add-failed"}));
                        }
                        let body: Value = reply.json().await?;
                        if body["missing"].as_array().is_some_and(|s| !s.is_empty()) {
                            return Ok(json!({"ok":false,"reason":"track-missing"}));
                        }
                    }
                }
            }
            // Account switches during a request cannot commit into the new scope.
            if scope != self::scope(&*state.runtime()?)? {
                return Err(ShellError::Guard("account-changed"));
            }
            let path = lock_store(state, "pin::capacity-path")?
                .store
                .pools
                .offline
                .clone();
            let free = capacity_async(path, true, available_capacity).await?;
            let mut needed = 0u64;
            for track in &pin.tracks {
                let exists = lock_store(state, "pin::needed")?
                    .store
                    .file(&scope, &track.key, "offline")
                    .map_err(storage_error)?
                    .is_some();
                if !exists {
                    needed = needed
                        .checked_add(track.bytes.unwrap_or(0))
                        .ok_or(ShellError::Guard("no-space"))?;
                }
            }
            if free < needed.saturating_add(50 * 1024 * 1024) {
                return Ok(json!({"ok":false,"reason":"no-space"}));
            }
            if scope != self::scope(&*state.runtime()?)? {
                return Err(ShellError::Guard("account-changed"));
            }
            let mut o = lock_store(state, "pin::commit")?;
            let before_keys = o
                .store
                .pin_keys(&scope, &pin.kind, &pin.reference)
                .map_err(storage_error)?;
            let revision = o.store.revision();
            let mut keys = pin.tracks.iter().map(|t| t.key.clone()).collect::<Vec<_>>();
            let id = if let Some(mode) = pin.mode.as_deref() {
                keys = o
                    .store
                    .extend_pin(&scope, &pin.kind, &pin.reference, &keys, mode == "ensure")
                    .map_err(storage_error)?;
                krobi_offline::pins::pin_id(&pin.kind, &pin.reference)
            } else {
                o.store
                    .pin(&scope, &pin.kind, &pin.reference, &keys)
                    .map_err(storage_error)?
            };
            let pins_changed = before_keys
                != o.store
                    .pin_keys(&scope, &pin.kind, &pin.reference)
                    .map_err(storage_error)?;
            drop(o);
            for key in keys {
                let mut o = lock_store(state, "pin::queue-track")?;
                if !o
                    .store
                    .transfer_due(&scope, &key, "offline")
                    .map_err(storage_error)?
                {
                    continue;
                }
                o.store
                    .promote_cached(&scope, &key)
                    .map_err(storage_error)?;
                o.queue.push(Priority::Pin, scope.clone(), key);
            }
            let mut o = lock_store(state, "pin::sweep")?;
            o.store.sweep_pending().map_err(storage_error)?;
            o.wake.notify_one();
            let did_change = revision != o.store.revision();
            drop(o);
            if pins_changed {
                changed(app, Change::PINS);
            } else if did_change {
                changed(app, Change::CACHE);
            }
            Ok(json!({"ok":true,"pinId":id}))
        }
        "offline:unpin" => {
            let id = request
                .and_then(|r| r["pinId"].as_str())
                .ok_or(ShellError::Guard("invalid-pin"))?;
            let mut o = lock_store(state, "commands::invoke")?;
            let count = o.store.pin_count(&scope).map_err(storage_error)?;
            o.store.unpin(&scope, Some(id)).map_err(storage_error)?;
            let removed = o.store.pin_count(&scope).map_err(storage_error)? != count;
            o.store.sweep_pending().map_err(storage_error)?;
            drop(o);
            if removed {
                changed(app, Change::PINS);
            }
            Ok(json!({"ok":true}))
        }
        "offline:status" => {
            let keys: Vec<String> = serde_json::from_value(
                request
                    .and_then(|r| r.get("keys"))
                    .cloned()
                    .unwrap_or(json!([])),
            )?;
            for key in &keys {
                lock_store(state, "status::resolve")?
                    .store
                    .resolve(&scope, key, true)
                    .map_err(storage_error)?;
            }
            let (files, pins) = {
                let o = lock_store(state, "status::snapshot")?;
                (
                    o.store.files(&scope).map_err(storage_error)?,
                    o.store.pin_count(&scope).map_err(storage_error)?,
                )
            };
            let count = files.iter().filter(|f| f.verified_at.is_some()).count();
            let bytes: u64 = files
                .iter()
                .filter(|f| f.verified_at.is_some())
                .map(|f| f.bytes)
                .sum();
            let rows=keys.iter().map(|key| {
                let file=files.iter().filter(|f|&f.key==key).min_by_key(|f|(f.verified_at.is_none() || !matches!(f.state.as_str(),DOWNLOADED|"desactualizado"|MISSING),f.pool!="offline"));
                match file {Some(f)=>json!({"key":key,"pool":f.pool,"state":f.state,"bytes":f.bytes,"etag":f.etag,"verifiedAt":f.verified_at,"lastPlayedAt":f.last_played_at,"error":f.error}),None=>json!({"key":key,"pool":null,"state":"no descargado","bytes":0,"etag":null,"verifiedAt":null,"lastPlayedAt":null,"error":null})}
            }).collect::<Vec<_>>();
            Ok(json!({"pins":pins,"files":count,"bytes":bytes,"tracks":rows}))
        }
        "offline:pools" => {
            let action = request.and_then(|r| r["action"].as_str()).unwrap_or("get");
            let did_change = match action {
                "clear-cache" => enforce_cache_budget(state, 0, Some(&scope))?,
                "remove-downloads" => {
                    let mut o = lock_store(state, "pools::remove-downloads")?;
                    let before = o.store.pin_count(&scope).map_err(storage_error)?;
                    o.store.unpin(&scope, None).map_err(storage_error)?;
                    o.store.sweep_pending().map_err(storage_error)?;
                    before > 0
                }
                "get" => false,
                _ => return Err(ShellError::Guard("invalid-pool-action")),
            };
            let handle = app.clone();
            let active = scope.clone();
            let reply = tauri::async_runtime::spawn_blocking(move || {
                pools_get(&handle.state::<DesktopState>(), &active, available_capacity)
            })
            .await
            .map_err(storage_error)??;
            if did_change {
                changed(
                    app,
                    if action == "remove-downloads" {
                        Change::PINS
                    } else {
                        Change::CACHE
                    },
                );
            }
            Ok(reply)
        }
        _ => Err(ShellError::Guard("unknown-offline-channel")),
    }
}

/// Copy rows while locked; aggregation, JSON and capacity probes own no guard.
pub(in crate::desktop) fn pools_get(
    state: &DesktopState,
    scope: &Scope,
    capacity: impl FnOnce(&Path, bool) -> ShellResult<u64>,
) -> ShellResult<Value> {
    let (files, pins, pools) = {
        let o = lock_store(state, "pools::snapshot")?;
        (
            o.store.files(scope).map_err(storage_error)?,
            o.store.pins(scope).map_err(storage_error)?,
            o.store.pools.clone(),
        )
    };
    let pool = |name: &str, path: &Path| json!({"bytes":files.iter().filter(|f|f.pool==name).map(|f|f.bytes).sum::<u64>(),"files":files.iter().filter(|f|f.pool==name && f.verified_at.is_some()).count(),"location":path.to_string_lossy()});
    let pins = pins.into_iter().map(|(id,kind,reference,tracks)| json!({"id":id,"kind":kind,"ref":reference,"tracks":tracks})).collect::<Vec<_>>();
    Ok(
        json!({"pins":pins,"offline":pool("offline",&pools.offline),"cache":pool("cache",&pools.cache),"cacheBudget":cache_budget(capacity(&pools.cache,false)?)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_and_setting_the_offline_mode_never_relocks_the_runtime() {
        // A plain read must release its guard before any later runtime access.
        let dir = std::env::temp_dir().join(format!(
            "krobi-offline-mode-{}-{}",
            std::process::id(),
            timestamp()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut state = state("http://127.0.0.1:9");
        state.app_dir = dir.clone();
        let state = std::sync::Arc::new(state);
        let (send, receive) = std::sync::mpsc::channel();
        let worker = state.clone();
        std::thread::spawn(move || {
            let read = offline_mode(&worker, None).unwrap();
            let set = offline_mode(&worker, Some(true)).unwrap();
            let again = offline_mode(&worker, None).unwrap();
            send.send((read, set, again)).unwrap();
        });
        let result = receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("offline_mode deadlocked");
        assert_eq!(result, ((false, false), (true, true), (true, false)));
        assert!(
            state.runtime().is_ok(),
            "the runtime lock must be free afterwards"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn wrong_nest_cannot_read_any_snapshot_and_forced_mode_is_persisted() {
        let state = state("http://nest");
        let active = scope(&state.runtime().unwrap()).unwrap();
        lock(&state.offline, "offline")
            .unwrap()
            .store
            .save_snapshot(&active, "home", "{}", None)
            .unwrap();
        let mut r = state.runtime().unwrap();
        r.preferences.offline_mode = true;
        let bytes = serde_json::to_vec(&r.preferences).unwrap();
        let saved: Preferences = serde_json::from_slice(&bytes).unwrap();
        assert!(saved.offline_mode);
        assert!(offline_now(&r));
        r.server.connection.state = ConnectionState::WrongNest;
        assert!(scope(&r).is_err());
    }
}
