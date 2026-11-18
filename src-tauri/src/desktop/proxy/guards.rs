//! Backend origin and media namespace validation.

use super::*;

pub(in crate::desktop) fn normalize_backend(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.as_str().trim_end_matches('/').to_string())
}

pub(in crate::desktop) fn is_backend_url(target: &Url, allowed: &Url) -> bool {
    if target.origin() != allowed.origin()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return false;
    }
    let base_path = allowed.path().trim_end_matches('/');
    base_path.is_empty()
        || target.path() == base_path
        || target
            .path()
            .strip_prefix(base_path)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub(in crate::desktop) fn media_proxy_url() -> &'static str {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://krobi-media.localhost"
    } else {
        "krobi-media://localhost"
    }
}

/// Is `target` on the backend *and* inside its media namespace?
///
/// Judged on the parsed URL, never on the raw string: `Url::parse` resolves
/// dot segments (`..`, `%2e%2e`, `%2E%2E`, `./`) and, for http(s), treats `\`
/// as `/`, so `/api/media/../me` *becomes* `/api/me`. A prefix check on the raw
/// path passed exactly that, and the caller then attached the bearer token.
pub(in crate::desktop) fn is_media_url(target: &Url, allowed: &Url) -> bool {
    if !is_backend_url(target, allowed) {
        return false;
    }
    let base_path = allowed.path().trim_end_matches('/');
    let Some(rest) = target.path().strip_prefix(base_path) else {
        return false;
    };
    rest == MEDIA_ROUTE
        || rest
            .strip_prefix(MEDIA_ROUTE)
            .is_some_and(|tail| tail.starts_with('/'))
}

pub(super) fn media_target(backend_origin: &str, request: &Request<Vec<u8>>) -> Option<Url> {
    let path = request.uri().path();
    let stem_audio = is_stem_audio_path(path);
    if path != MEDIA_ROUTE && !path.starts_with("/api/media/") && !stem_audio {
        return None;
    }
    let suffix = request.uri().path_and_query()?.as_str();
    let allowed = Url::parse(backend_origin).ok()?;
    let target = Url::parse(&format!("{}{suffix}", backend_origin.trim_end_matches('/'))).ok()?;
    if stem_audio {
        // Check both the raw route shape and the parsed URL: dot segments must
        // never normalise a request into a different, otherwise allowed route.
        let relative = target
            .path()
            .strip_prefix(allowed.path().trim_end_matches('/'))?;
        (is_backend_url(&target, &allowed) && relative == path).then_some(target)
    } else {
        is_media_url(&target, &allowed).then_some(target)
    }
}

fn is_stem_audio_path(path: &str) -> bool {
    let Some(tail) = path.strip_prefix("/api/stems/") else {
        return false;
    };
    let mut segments = tail.split('/');
    matches!(
        (segments.next(), segments.next(), segments.next(), segments.next()),
        (Some(album), Some(file), Some("drums" | "bass" | "vocals" | "other"), None)
            if !album.is_empty() && !file.is_empty() && !matches!(album, "jobs" | "agent")
    )
}

#[cfg(test)]
pub(in crate::desktop) mod tests {
    use super::*;

    #[test]
    fn backend_normalization_accepts_http_and_removes_non_origin_parts() {
        assert_eq!(
            normalize_backend(" https://music.example:8443/krobi/?x=1#top "),
            Some("https://music.example:8443/krobi".into())
        );
    }

    #[test]
    fn backend_normalization_rejects_unsafe_urls() {
        for value in [
            "file:///tmp/backend",
            "http://",
            "https://user@example.test",
            "https://user:secret@example.test",
        ] {
            assert_eq!(normalize_backend(value), None, "accepted {value}");
        }
    }

    #[test]
    fn proxy_url_must_stay_on_origin_and_path_boundary() {
        let allowed = Url::parse("https://music.example/krobi").unwrap();
        for value in [
            "https://music.example/krobi",
            "https://music.example/krobi/api/health",
            "https://music.example/krobi?screen=home",
        ] {
            assert!(is_backend_url(&Url::parse(value).unwrap(), &allowed));
        }
        for value in [
            "https://music.example/krobi-evil/api/health",
            "https://other.example/krobi/api/health",
            "https://user@music.example/krobi/api/health",
        ] {
            assert!(!is_backend_url(&Url::parse(value).unwrap(), &allowed));
        }
    }

    #[test]
    fn media_target_preserves_thumbnail_revision_and_rejects_query_traversal() {
        for origin in ["https://music.example/krobi", "http://127.0.0.1:8000"] {
            let request = Request::builder()
                .uri("krobi-media://localhost/api/media/Album/cover.jpg?size=96&v=abc")
                .body(Vec::new())
                .unwrap();
            assert_eq!(
                media_target(origin, &request).unwrap().as_str(),
                format!("{origin}/api/media/Album/cover.jpg?size=96&v=abc")
            );
            let blocked = Request::builder()
                .uri("krobi-media://localhost/api/media/../me?size=96")
                .body(Vec::new())
                .unwrap();
            assert!(media_target(origin, &blocked).is_none());
        }
    }

    #[test]
    fn media_protocol_only_maps_media_routes_under_the_configured_backend() {
        let request = Request::builder()
            .uri("krobi-media://localhost/api/media/Album/Song.mp3?quality=original")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            media_target("https://music.example/krobi", &request)
                .unwrap()
                .as_str(),
            "https://music.example/krobi/api/media/Album/Song.mp3?quality=original"
        );

        let blocked = Request::builder()
            .uri("krobi-media://localhost/api/users")
            .body(Vec::new())
            .unwrap();
        assert!(media_target("https://music.example/krobi", &blocked).is_none());
    }

    /// Every spelling of "leave the media namespace" that `Url::parse`
    /// normalises back onto another route.
    pub(crate) const ESCAPES: &[&str] = &[
        "/api/media/../me",
        "/api/media/%2e%2e/me",
        "/api/media/%2E%2E/me",
        "/api/media/.%2e/me",
        "/api/media/%2e./users",
        "/api/media/./../me",
        "/api/media/a/../../me",
        "/api/media/..\\me",
        "/api/media\\..\\me",
        "/api/media/%2e%2e\\users",
        "/api/media/..",
    ];

    #[test]
    fn media_protocol_rejects_dot_segment_escapes() {
        for path in ESCAPES {
            // `http::Uri` refuses some of these outright (a backslash), which
            // is also a block.
            let Ok(request) = Request::builder()
                .uri(format!("krobi-media://localhost{path}"))
                .body(Vec::new())
            else {
                continue;
            };
            for origin in ["https://music.example/krobi", "http://127.0.0.1:8000"] {
                assert!(
                    media_target(origin, &request).is_none(),
                    "{path} escaped on {origin}"
                );
            }
        }
    }
}
