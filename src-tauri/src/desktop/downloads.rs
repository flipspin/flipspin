//! "Download to this computer": a server track saved to a path the person
//! chose, and the manifest of what is on this device.

use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
use tokio::io::AsyncWriteExt;
use url::Url;

use super::prefs::read_json;
use super::proxy::is_media_url;
use super::*;

pub(super) async fn save_key_export(request: Option<&Value>) -> ShellResult<Value> {
    let name = request
        .and_then(|r| r.get("name"))
        .and_then(Value::as_str)
        .ok_or(ShellError::Guard("missing export name"))?;
    let fingerprint = name
        .strip_prefix("krobi-nido-")
        .and_then(|s| s.strip_suffix(".key"))
        .filter(|s| s.len() == 8 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or(ShellError::Guard("invalid export name"))?;
    let contents = request
        .and_then(|r| r.get("contents"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 65536)
        .ok_or(ShellError::Guard("invalid export contents"))?;
    let selected = rfd::AsyncFileDialog::new()
        .set_file_name(format!("krobi-nido-{fingerprint}.key"))
        .save_file()
        .await;
    let Some(selected) = selected else {
        return Ok(json!({"ok": true, "cancelled": true}));
    };
    super::private_file::write_atomic(selected.path(), contents.as_bytes())?;
    Ok(json!({"ok": true, "cancelled": false}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceDownloadRequest {
    media_path: String,
    suggested_name: String,
}

pub(super) fn media_download_target(backend_origin: &str, media_path: &str) -> Option<Url> {
    let relative = media_path.trim();
    if !relative.starts_with("/api/media/") || relative.contains(['\r', '\n']) {
        return None;
    }
    let allowed = Url::parse(backend_origin).ok()?;
    let mut target = Url::parse(&format!(
        "{}{}",
        backend_origin.trim_end_matches('/'),
        relative
    ))
    .ok()?;
    target.set_query(None);
    is_media_url(&target, &allowed).then_some(target)
}

/// The manifest key of a device download: the media path without its query
/// (a stale `access_token` must not split one song into two keys). Kept raw —
/// it is what the renderer matches on — but only when it still names a media
/// route once parsed, the same rule `media_download_target` applies.
pub(super) fn media_download_key(media_path: &str) -> Option<String> {
    let key = media_path.trim().split('?').next()?.to_string();
    if !key.starts_with("/api/media/") || key.contains(['\r', '\n']) {
        return None;
    }
    let base = Url::parse("http://media-key.invalid").ok()?;
    let parsed = Url::parse(&format!("http://media-key.invalid{key}")).ok()?;
    is_media_url(&parsed, &base).then_some(key)
}

#[cfg(test)]
pub(super) fn device_download_manifest_key(backend_origin: &str, media_path: &str) -> String {
    format!("{}\n{media_path}", backend_origin.trim_end_matches('/'))
}

pub(super) fn safe_download_name(suggested_name: &str) -> &str {
    Path::new(suggested_name.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .unwrap_or("cancion.mp3")
}

/// Download one existing server track to a location chosen on this device.
///
/// Only the configured backend's `/api/media/...` namespace is accepted. The
/// renderer never supplies credentials or a destination path: Rust injects the
/// current token and the native save dialog grants the destination explicitly.
/// A sibling `.part` file is written and atomically moved into place only after
/// the complete response arrives, so a failed transfer cannot look playable.
#[tauri::command]
pub async fn download_to_device(
    state: tauri::State<'_, DesktopState>,
    request: DeviceDownloadRequest,
) -> ShellResult<Value> {
    // The file is fetched over the transport but filed under the configured
    // origin, so a song saved over Tailscale is still "on this device" at home.
    let (backend_origin, configured_origin, token, http) = {
        let runtime = state.runtime()?;
        (
            runtime.backend_origin.clone(),
            runtime.configured_origin.clone(),
            runtime.token.clone(),
            state.http.download_client()?,
        )
    };
    let media_key =
        media_download_key(&request.media_path).ok_or(ShellError::Guard("blocked media path"))?;
    let _ = configured_origin;
    let target = media_download_target(&backend_origin, &media_key)
        .ok_or(ShellError::Guard("blocked media path"))?;
    let selected = rfd::AsyncFileDialog::new()
        .set_file_name(safe_download_name(&request.suggested_name))
        .save_file()
        .await;
    let Some(selected) = selected else {
        return Ok(json!({"ok": true, "cancelled": true}));
    };
    let destination = selected.path().to_path_buf();
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cancion.mp3");
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = destination.with_file_name(format!(".{file_name}.krobi-{nonce}.part"));

    let transfer = transfer_media(&http, target, &token, &temporary, &destination).await;

    if let Err(error) = transfer {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    Ok(json!({
        "ok": true,
        "cancelled": false,
        "path": destination.to_string_lossy()
    }))
}

/// Retry from bytes already written only when a validator ties them to the
/// same representation. A server ignoring Range (or changing If-Range) restarts
/// the temporary file; malformed partial responses never reach the destination.
pub(super) async fn transfer_media(
    http: &Client,
    target: Url,
    token: &str,
    temporary: &Path,
    destination: &Path,
) -> ShellResult<()> {
    use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE};
    let mut file = tokio::fs::File::create(temporary).await?;
    let mut offset = 0u64;
    let mut expected = None;
    let mut validator = None;
    for attempt in 0..4 {
        let mut request = http.get(target.clone()).header(ACCEPT_ENCODING, "identity");
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
        let resume = offset > 0 && validator.is_some();
        if resume {
            request = request
                .header(RANGE, format!("bytes={offset}-"))
                .header(IF_RANGE, validator.as_ref().unwrap());
        }
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(_) if attempt < 3 => continue,
            Err(error) => return Err(error.into()),
        };
        let next_validator = response
            .headers()
            .get(ETAG)
            .filter(|v| !v.as_bytes().starts_with(b"W/"))
            .or_else(|| response.headers().get(LAST_MODIFIED))
            .cloned();
        if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_content_range)
                .ok_or(ShellError::Guard("invalid-media-range"))?;
            if !resume
                || range.0 != offset
                || Some(range.2) != expected
                || response.content_length() != Some(range.1 - range.0 + 1)
                || next_validator
                    .as_ref()
                    .is_some_and(|v| Some(v) != validator.as_ref())
            {
                return Err(ShellError::Guard("invalid-media-range"));
            }
        } else if response.status() == reqwest::StatusCode::OK {
            expected = Some(
                response
                    .content_length()
                    .ok_or(ShellError::Guard("missing-server-size"))?,
            );
            validator = next_validator;
            offset = 0;
            file.set_len(0).await?;
            tokio::io::AsyncSeekExt::rewind(&mut file).await?;
        } else {
            return Err(ShellError::Message(format!(
                "media server returned {}",
                response.status()
            )));
        }
        let mut interrupted = None;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if offset + chunk.len() as u64 > expected.unwrap_or(0) {
                        return Err(ShellError::Guard("size-mismatch"));
                    }
                    file.write_all(&chunk).await?;
                    offset += chunk.len() as u64;
                }
                Ok(None) => break,
                Err(error) => {
                    interrupted = Some(error);
                    break;
                }
            }
        }
        file.flush().await?;
        if interrupted.is_none() && Some(offset) == expected {
            file.sync_all().await?;
            drop(file);
            // Never remove a previous complete copy before the atomic rename.
            tokio::fs::rename(temporary, destination).await?;
            return Ok(());
        }
        if attempt == 3 {
            return Err(interrupted
                .map(ShellError::from)
                .unwrap_or(ShellError::Guard("size-mismatch")));
        }
    }
    unreachable!("bounded retries return on their final attempt")
}

fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (start.parse().ok()?, end.parse().ok()?, total.parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

#[tauri::command]
pub fn list_device_downloads(state: tauri::State<'_, DesktopState>) -> Value {
    let configured_origin = state
        .runtime()
        .map(|runtime| runtime.configured_origin.clone())
        .unwrap_or_default();
    let prefix = format!("{}\n", configured_origin.trim_end_matches('/'));
    let downloads: BTreeMap<String, String> =
        read_json(&state.app_dir.join("device-downloads.json"));
    let available = downloads
        .into_iter()
        .filter(|(_, path)| Path::new(path).is_file())
        .filter_map(|(key, path)| {
            // Plain media-path keys were written by the first development
            // build of this feature. Treat them as belonging to the current
            // server so existing local status is not lost.
            let media_path = key
                .strip_prefix(&prefix)
                .map(str::to_owned)
                .or_else(|| key.starts_with("/api/media/").then_some(key))?;
            Some(json!({"mediaPath": media_path, "path": path}))
        })
        .collect::<Vec<_>>();
    json!({"downloads": available})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::proxy::tests::ESCAPES;

    #[test]
    fn device_download_accepts_only_backend_media_paths() {
        assert_eq!(
            media_download_target("https://music.example/krobi", "/api/media/Album/Song.mp3")
                .unwrap()
                .as_str(),
            "https://music.example/krobi/api/media/Album/Song.mp3"
        );
        for blocked in [
            "https://evil.example/api/media/Song.mp3",
            "/api/users",
            "/api/mediax/Song.mp3",
        ] {
            assert!(media_download_target("https://music.example/krobi", blocked).is_none());
        }
    }

    #[test]
    fn device_download_rejects_dot_segment_escapes() {
        for path in ESCAPES {
            for origin in ["https://music.example/krobi", "http://127.0.0.1:8000"] {
                assert!(
                    media_download_target(origin, path).is_none(),
                    "{path} escaped on {origin}"
                );
            }
            assert_eq!(media_download_key(path), None, "{path} kept as a key");
        }
        // A dot segment that stays inside the namespace is still media.
        assert_eq!(
            media_download_target("http://127.0.0.1:8000", "/api/media/A/./B.mp3")
                .unwrap()
                .path(),
            "/api/media/A/B.mp3"
        );
    }

    #[test]
    fn device_download_uses_only_the_suggested_basename() {
        assert_eq!(safe_download_name("../../Song.mp3"), "Song.mp3");
        assert_eq!(safe_download_name(""), "cancion.mp3");
    }

    #[test]
    fn device_download_key_drops_stale_query_credentials() {
        assert_eq!(
            media_download_key("/api/media/Album/Song.mp3?access_token=old"),
            Some("/api/media/Album/Song.mp3".into())
        );
        assert_eq!(media_download_key("/api/users"), None);
        assert_eq!(
            device_download_manifest_key(
                "https://music.example/krobi/",
                "/api/media/Album/Song.mp3"
            ),
            "https://music.example/krobi\n/api/media/Album/Song.mp3"
        );
    }
}
