//! Canonical audio and artwork keys; media paths are decoded once.

use super::*;

pub(in crate::desktop) fn key_from_media(path: &str) -> Option<String> {
    let path = crate::desktop::downloads::media_download_key(path)?;
    let tail = path.strip_prefix("/api/media/")?;
    let key = percent_encoding::percent_decode_str(tail)
        .decode_utf8()
        .ok()?
        .into_owned();
    valid_key(&key).then_some(key)
}

pub(in crate::desktop) fn is_audio_key(key: &str) -> bool {
    matches!(
        key.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp3"
            | "flac"
            | "m4a"
            | "mp4"
            | "m4b"
            | "wav"
            | "ogg"
            | "oga"
            | "opus"
            | "aac"
            | "aiff"
            | "aif"
            | "alac"
            | "wma"
            | "webm"
            | "ape"
            | "wv"
    )
}

pub(in crate::desktop) fn player_track_key(track: &Value) -> Option<String> {
    track["url_path"]
        .as_str()
        .and_then(|media| {
            Url::parse(media)
                .ok()
                .and_then(|u| key_from_media(u.path()))
                .or_else(|| key_from_media(media))
        })
        .or_else(|| {
            track["relPath"]
                .as_str()
                .filter(|k| valid_key(k))
                .map(str::to_owned)
        })
}

pub(super) fn valid_key(key: &str) -> bool {
    !key.contains(['\\', '\0', '\r', '\n'])
        && key.split('/').count() == 2
        && key
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

pub(super) fn media_path(key: &str) -> String {
    const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    format!(
        "/api/media/{}",
        key.split('/')
            .map(|s| percent_encoding::utf8_percent_encode(s, SEGMENT).to_string())
            .collect::<Vec<_>>()
            .join("/")
    )
}

/// Canonical encoded segments and query pairs form one scoped art identity.
/// Decode only once: a folded ∕ remains part of the album segment.
pub(in crate::desktop) fn art_media_path(raw: &str) -> Option<(String, String)> {
    let (path, query) = raw
        .split_once('?')
        .map_or((raw, None), |(p, q)| (p, Some(q)));
    let key = key_from_media(path)?;
    let (album, name) = key.split_once('/')?;
    if !matches!(
        name.rsplit('.').next()?.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "avif"
    ) {
        return None;
    }
    let mut normalized = media_path(&key);
    if let Some(query) = query {
        let pairs = url::form_urlencoded::parse(query.as_bytes());
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(pairs)
            .finish();
        if !query.is_empty() {
            normalized.push('?');
            normalized.push_str(&query);
        }
    }
    Some((album.into(), normalized))
}

pub(super) fn cover_path(key: &str) -> Option<(String, String)> {
    valid_key(key).then(|| {
        let album = key.split('/').next().unwrap();
        (album.into(), media_path(&format!("{album}/cover.jpg")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_keys_decode_once_and_refuse_traversal() {
        assert_eq!(
            key_from_media("/api/media/An%20Album/song%23.mp3"),
            Some("An Album/song#.mp3".into())
        );
        for p in [
            "/api/media/../me",
            "/api/media/a/%2e%2e",
            "/api/media/a%2fb/c",
            "/api/media/a/%00",
        ] {
            assert_eq!(key_from_media(p), None);
        }
    }

    #[test]
    fn art_paths_normalize_encoding_keep_query_variants_and_refuse_traversal() {
        assert_eq!(
            art_media_path("/api/media/A%20B/cover.jpg?size=%39%36"),
            Some(("A B".into(), "/api/media/A%20B/cover.jpg?size=96".into()))
        );
        assert_eq!(
            art_media_path("/api/media/A%E2%88%95B/cover.jpg")
                .unwrap()
                .0,
            "A∕B"
        );
        for path in [
            "/api/media/A/%2e%2e",
            "/api/media/A%2fB/cover.jpg",
            "/api/media/../cover.jpg",
            "/api/media/A/%00.jpg",
            "/api/else/A/cover.jpg",
        ] {
            assert!(art_media_path(path).is_none(), "{path}");
        }
    }
}
