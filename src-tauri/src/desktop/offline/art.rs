//! Pinned artwork backfill and conditional refresh.

use super::*;

/// How long a cover the nest answered 404 for is trusted before asking again.
const ART_MISSING_RECHECK_SECS: i64 = 24 * 60 * 60;

/// Existing verified pins are the backfill source; no audio request is made here.
pub(super) async fn sync_art(state: &DesktopState, active: &Scope) -> ShellResult<bool> {
    let (files, arts, pins) = {
        let o = lock_store(state, "art::snapshot")?;
        (
            o.store.files(active).map_err(storage_error)?,
            o.store.arts(active).map_err(storage_error)?,
            o.store.pins(active).map_err(storage_error)?,
        )
    };
    let required = pins
        .into_iter()
        .flat_map(|p| p.3)
        .collect::<std::collections::HashSet<_>>();
    let albums = required
        .iter()
        .filter_map(|key| cover_path(key).map(|(album, _)| album))
        .collect::<std::collections::HashSet<_>>();
    let mut candidates = std::collections::BTreeMap::new();
    for file in files {
        if file.pool == "offline" && file.verified_at.is_some() && required.contains(&file.key) {
            if let Some((album, path)) = cover_path(&file.key) {
                candidates.insert(path, album);
            }
        }
    }
    for art in arts {
        if albums.contains(&art.album_key) {
            candidates.insert(art.media_path, art.album_key);
        }
    }
    let mut changed = false;
    for (path, album) in candidates {
        // Keep snapshots and audio usable if a single image cannot be fetched.
        match refresh_art(state, active, &album, &path, true).await {
            Ok(updated) => changed |= updated,
            Err(error) => log::debug!("offline cover: {error}"),
        }
    }
    Ok(changed)
}

pub(super) async fn refresh_art(
    state: &DesktopState,
    active: &Scope,
    album: &str,
    path: &str,
    revalidate: bool,
) -> ShellResult<bool> {
    let (origin, token) = connected_scope(state, active)?;
    if !art_media_path(path).is_some_and(|(key, normalized)| key == album && normalized == path) {
        return Err(ShellError::Guard("invalid-art-path"));
    }
    let old = {
        let o = lock_store(state, "art::refresh_art")?;
        if !o
            .store
            .album_required(active, album)
            .map_err(storage_error)?
        {
            return Ok(false);
        }
        // A remembered "no cover" is asked again once a day, so a cover added
        // on the nest later reaches the offline copy.
        if let Some(art) = o.store.art(active, path).map_err(storage_error)? {
            if art.state == MISSING
                && art
                    .verified_at
                    .is_some_and(|at| krobi_offline::store::now() - at < ART_MISSING_RECHECK_SECS)
            {
                return Ok(false);
            }
        }
        match o
            .store
            .resolve_art(active, path, false)
            .map_err(storage_error)?
        {
            krobi_offline::resolve::ArtResolution::Missing => return Ok(false),
            krobi_offline::resolve::ArtResolution::Local(art) => {
                if !revalidate {
                    return Ok(false);
                }
                Some(art)
            }
            _ => None,
        }
    };
    let allowed = Url::parse(&origin)?;
    let target = Url::parse(&format!("{}{path}", origin.trim_end_matches('/')))?;
    if !crate::desktop::proxy::is_media_url(&target, &allowed) {
        return Err(ShellError::Guard("invalid-art-path"));
    }
    let mut request = state
        .http
        .get(target)
        .bearer_auth(token)
        .header("Accept-Encoding", "identity");
    if let Some(etag) = old.as_ref().and_then(|a| a.etag.as_deref()) {
        request = request.header("If-None-Match", etag);
    }
    let mut response = request
        .send()
        .await
        .inspect_err(|_| state.proxy_failure(None))?;
    connected_scope(state, active)?;
    let status = response.status();
    if status.as_u16() == 401 {
        lock_store(state, "art::refresh_art")?
            .store
            .revoke(active)
            .map_err(storage_error)?;
        return Err(ShellError::Guard("account-revoked"));
    }
    if status.as_u16() == 304 {
        if old.is_none() {
            return Err(ShellError::Guard("invalid-art-304"));
        }
        lock_store(state, "art::refresh_art")?
            .store
            .touch_art(active, path)
            .map_err(storage_error)?;
        return Ok(false);
    }
    if status.as_u16() == 404 {
        let mut o = lock_store(state, "art::refresh_art")?;
        if !o
            .store
            .album_required(active, album)
            .map_err(storage_error)?
        {
            return Ok(false);
        }
        o.store
            .art_missing(active, album, path)
            .map_err(storage_error)?;
        o.store.sweep_pending().map_err(storage_error)?;
        return Ok(true);
    }
    if status.as_u16() != 200 {
        return Err(ShellError::Message(format!("cover-http-{status}")));
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let expected = response.content_length();
    lock_store(state, "art::refresh_art")?
        .store
        .begin_art(active, album, path)
        .map_err(storage_error)?;
    while let Some(chunk) = response.chunk().await? {
        connected_scope(state, active)?;
        lock_store(state, "art::refresh_art")?
            .store
            .append_art(active, path, &chunk)
            .map_err(storage_error)?;
    }
    connected_scope(state, active)?;
    lock_store(state, "art::refresh_art")?
        .store
        .finish_art(
            active,
            path,
            expected,
            etag.as_deref(),
            content_type.as_deref(),
        )
        .map_err(storage_error)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_songs_download_one_full_cover_for_the_folded_album() {
        let (origin, server) = serve_typed(vec![
            (200, "audio one".into(), "audio/mpeg"),
            (200, "PNG bytes".into(), "image/png"),
            (200, "audio two".into(), "audio/mpeg"),
        ]);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        for key in ["Artist∕Album/one.mp3", "Artist∕Album/two.mp3"] {
            lock(&state.offline, "offline")
                .unwrap()
                .store
                .pin(&active, "song", key, &[key.into()])
                .unwrap();
            tauri::async_runtime::block_on(download_pinned_with_capacity(
                &state,
                &active,
                key,
                |_, _| Ok(1024 * 1024 * 1024),
            ))
            .unwrap();
        }
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.contains("/cover.jpg "))
                .count(),
            1
        );
        assert!(requests[1].starts_with("GET /api/media/Artist%E2%88%95Album/cover.jpg "));
        assert!(requests
            .iter()
            .all(|r| r.to_lowercase().contains("authorization: bearer secret")));
        let o = lock(&state.offline, "offline").unwrap();
        let art = o.store.arts(&active).unwrap().pop().unwrap();
        assert_eq!(art.album_key, "Artist∕Album");
        assert_eq!(art.content_type.as_deref(), Some("image/png"));
        assert_eq!(std::fs::read(art.path).unwrap(), b"PNG bytes");
        assert_eq!(o.store.files(&active).unwrap().len(), 2);
    }

    #[test]
    fn cover_404_is_not_refetched_for_another_song_or_the_next_sync() {
        let mut replies = vec![
            (200, "audio".into(), "audio/mpeg"),
            (404, "no cover".into(), "text/plain"),
            (200, "audio".into(), "audio/mpeg"),
        ];
        replies.extend(snapshot_replies());
        let (origin, server) = serve_typed(replies);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        for key in ["A/one.mp3", "A/two.mp3"] {
            lock(&state.offline, "offline")
                .unwrap()
                .store
                .pin(&active, "song", key, &[key.into()])
                .unwrap();
            tauri::async_runtime::block_on(download_pinned_with_capacity(
                &state,
                &active,
                key,
                |_, _| Ok(1024 * 1024 * 1024),
            ))
            .unwrap();
        }
        tauri::async_runtime::block_on(sync(&state, &active)).unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 7);
        assert_eq!(
            requests
                .iter()
                .filter(|r| r.contains("/cover.jpg "))
                .count(),
            1
        );
        assert!(matches!(
            lock(&state.offline, "offline")
                .unwrap()
                .store
                .resolve_art(&active, "/api/media/A/cover.jpg", true)
                .unwrap(),
            krobi_offline::resolve::ArtResolution::Missing
        ));
    }

    #[test]
    fn next_sync_backfills_existing_pins_without_audio_and_later_uses_cover_etag() {
        let mut replies = snapshot_replies();
        replies.push((200, "JPEG bytes".into(), "image/jpeg"));
        replies.extend(snapshot_replies());
        replies.push((304, "".into(), "image/jpeg"));
        let (origin, server) = serve_typed(replies);
        let state = state(&origin);
        let active = scope(&state.runtime().unwrap()).unwrap();
        {
            let mut o = lock(&state.offline, "offline").unwrap();
            o.store
                .pin(
                    &active,
                    "album",
                    "A",
                    &["A/one.mp3".into(), "A/two.mp3".into()],
                )
                .unwrap();
            for key in ["A/one.mp3", "A/two.mp3"] {
                o.store
                    .begin(&active, key, "offline", 5, Some("\"audio-v1\""), 0)
                    .unwrap();
                o.store.append(&active, key, "offline", b"audio").unwrap();
                o.store.finish(&active, key, "offline").unwrap();
            }
        }
        tauri::async_runtime::block_on(sync(&state, &active)).unwrap();
        // `sync` itself fetches no cover: the startup screen waits on it.
        assert!(lock(&state.offline, "offline")
            .unwrap()
            .store
            .art(&active, "/api/media/A/cover.jpg")
            .unwrap()
            .is_none());
        tauri::async_runtime::block_on(sync_art(&state, &active)).unwrap();
        let art = lock(&state.offline, "offline")
            .unwrap()
            .store
            .art(&active, "/api/media/A/cover.jpg")
            .unwrap()
            .unwrap();
        let modified = std::fs::metadata(&art.path).unwrap().modified().unwrap();
        lock(&state.offline, "offline").unwrap().last_sync = None;
        tauri::async_runtime::block_on(sync(&state, &active)).unwrap();
        tauri::async_runtime::block_on(sync_art(&state, &active)).unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 10);
        assert!(requests.iter().all(|r| !r.contains(".mp3")));
        assert!(requests[4].starts_with("GET /api/media/A/cover.jpg "));
        assert!(!requests[4].to_lowercase().contains("if-none-match"));
        assert!(requests[9]
            .to_lowercase()
            .contains("if-none-match: \"server-v2\""));
        let after = lock(&state.offline, "offline")
            .unwrap()
            .store
            .art(&active, "/api/media/A/cover.jpg")
            .unwrap()
            .unwrap();
        assert_eq!(after.id, art.id);
        assert_eq!(after.etag, art.etag);
        assert_eq!(after.bytes, art.bytes);
        assert_eq!(
            std::fs::metadata(&after.path).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(std::fs::read(after.path).unwrap(), b"JPEG bytes");
    }
}
