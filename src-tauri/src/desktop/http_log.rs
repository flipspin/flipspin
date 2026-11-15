//! The single HTTP diagnostic boundary. Never format raw requests or errors.
use reqwest::{header::HeaderMap, Response};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use url::Url;

struct Outage {
    since: Instant,
    failed: u64,
}

// Shared by media/JSON and every window, scoped to the configured backend prefix.
static OUTAGES: OnceLock<Mutex<HashMap<String, Outage>>> = OnceLock::new();

fn outages() -> std::sync::MutexGuard<'static, HashMap<String, Outage>> {
    OUTAGES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

/// One call per failed request. Callers pass only sanitized diagnostics.
pub(super) fn proxy_failed(backend: &str, reason: &str) {
    let mut outages = outages();
    let outage = outages.entry(backend.to_owned()).or_insert_with(|| {
        log::warn!("nest unreachable: {}", one_line(reason));
        Outage {
            since: Instant::now(),
            failed: 0,
        }
    });
    outage.failed += 1;
    log::debug!("HTTP proxy failed: {}", one_line(reason));
}

/// Recover only after a complete response; a dead gateway is still unreachable.
pub(super) fn proxy_completed(backend: &str, status: u16) {
    if matches!(status, 502..=504) {
        return;
    }
    if let Some(outage) = outages().remove(backend) {
        log::info!(
            "nest reachable again after {:.1} s; {} requests failed meanwhile",
            outage.since.elapsed().as_secs_f64(),
            outage.failed
        );
    }
}

pub(super) fn proxy_received(
    backend: &str,
    method: &reqwest::Method,
    path: &str,
    response: &Response,
) {
    if matches!(response.status().as_u16(), 502..=504) {
        proxy_failed(backend, &self::response(response));
    } else if outages().contains_key(backend) {
        log::debug!("HTTP {}", self::response(response));
    } else {
        received(method, path, response);
    }
}

/// A gateway response has already counted this request; keep its body detail at debug.
pub(super) fn proxy_body_failed(backend: &str, status: u16, reason: &str) {
    if matches!(status, 502..=504) {
        log::debug!("HTTP proxy body failed: {}", one_line(reason));
    } else {
        proxy_failed(backend, reason);
    }
}

/// Invalid media framing is a protocol error, not evidence of a network outage.
pub(super) fn proxy_invalid(backend: &str, status: u16, reason: &str) {
    if let Some(outage) = outages().get_mut(backend) {
        if !matches!(status, 502..=504) {
            outage.failed += 1;
        }
        log::debug!("HTTP proxy invalid response: {}", one_line(reason));
    } else {
        log::error!("HTTP proxy invalid response: {}", one_line(reason));
    }
}

pub(super) fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

pub(super) fn url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else {
        return "[invalid URL]".into();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let pairs: Vec<_> = url
        .query_pairs()
        .map(|(key, value)| {
            let secret = matches!(
                key.to_ascii_lowercase().as_str(),
                "access_token"
                    | "token"
                    | "key"
                    | "secret"
                    | "password"
                    | "apikey"
                    | "api_key"
                    | "t"
                    | "s"
            );
            (
                key.into_owned(),
                if secret {
                    "[redacted]".into()
                } else {
                    value.into_owned()
                },
            )
        })
        .collect();
    if url.query().is_some() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    one_line(url.as_str())
}

/// Mask all values, including unknown/configured custom headers. Header names
/// still identify transport behavior without ever needing a secret-name registry.
pub(super) fn headers(headers: &HeaderMap) -> String {
    headers
        .keys()
        .map(|name| format!("{name}=[redacted]"))
        .collect::<Vec<_>>()
        .join(", ")
}

pub(super) fn response(response: &Response) -> String {
    let id = response
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("absent");
    format!(
        "{} status={} request_id={} headers=[{}] body_bytes={}",
        url(response.url().as_str()),
        response.status().as_u16(),
        one_line(id).chars().take(200).collect::<String>(),
        headers(response.headers()),
        response
            .content_length()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "unknown".into())
    )
}

/// Small allowlist of optional read templates. `path` is relative to the
/// configured backend prefix, with query/fragment removed by the URL parser.
fn expected_absence(method: &reqwest::Method, path: &str, status: u16) -> bool {
    if status != 404 || !matches!(*method, reqwest::Method::GET | reqwest::Method::HEAD) {
        return false;
    }
    match path.split('/').collect::<Vec<_>>().as_slice() {
        ["", "api", "lyrics" | "stems", album, file] => !album.is_empty() && !file.is_empty(),
        ["", "api", "media", album, "cover.jpg"] => !album.is_empty(),
        _ => false,
    }
}

pub(super) fn received(method: &reqwest::Method, path: &str, response: &Response) {
    if (response.status().is_client_error() || response.status().is_server_error())
        && !expected_absence(method, path, response.status().as_u16())
    {
        log::warn!("HTTP failure {}", self::response(response));
    } else {
        log::debug!("HTTP {}", self::response(response));
    }
}

/// reqwest Display/source can contain the original credential-bearing URL.
/// Keep the category and OS error only; never the arbitrary remote body.
pub(super) fn error(error: &reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_decode() {
        "decode"
    } else if error.is_body() {
        "body"
    } else {
        "request"
    };
    let mut tls_record = false;
    let mut os_error = None;
    let mut source = std::error::Error::source(error);
    while let Some(current) = source {
        tls_record |= current.to_string().contains("InvalidContentType");
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            os_error = Some((io.kind(), io.raw_os_error()));
        }
        source = current.source();
    }
    let diagnostic = if tls_record {
        format!("{category} failed: invalid TLS record (InvalidContentType)")
    } else if let Some((kind, code)) = os_error {
        format!("{category}: {kind:?} (os error {code:?})")
    } else {
        format!("{category} failed")
    };
    let endpoint = error
        .url()
        .map(|value| format!(" url={}", url(value.as_str())))
        .unwrap_or_default();
    format!("{diagnostic}{endpoint}")
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    thread_local! {
        static LEVELS: std::cell::RefCell<Vec<log::Level>> = const { std::cell::RefCell::new(Vec::new()) };
        static LINES: std::cell::RefCell<Vec<(log::Level, String)>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    pub(in crate::desktop) fn init_logger() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            log::set_logger(&TestLogger).unwrap();
            log::set_max_level(log::LevelFilter::Debug);
        });
        LINES.with(|lines| lines.borrow_mut().clear());
    }

    pub(in crate::desktop) fn take_lines() -> Vec<(log::Level, String)> {
        LINES.with(|lines| lines.take())
    }

    struct TestLogger;

    impl log::Log for TestLogger {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }

        fn log(&self, record: &log::Record<'_>) {
            if record.target() == module_path!().trim_end_matches("::tests") {
                LEVELS.with(|levels| levels.borrow_mut().push(record.level()));
                LINES.with(|lines| {
                    lines
                        .borrow_mut()
                        .push((record.level(), record.args().to_string()))
                });
            }
        }

        fn flush(&self) {}
    }

    #[test]
    fn optional_absence_is_debug_but_other_http_failures_warn() {
        init_logger();
        let paths = [
            ("/api/lyrics/A/song.mp3", true),
            ("/api/stems/A/song.mp3", true),
            ("/api/media/A/cover.jpg", true),
            ("/api/lyrics/A%E2%88%95B/song%20one.mp3", true),
            ("/api/media/A/song.mp3", false),
            ("/api/stems/A/song.mp3/vocals", false),
            ("/api/lyrics/A/song.mp3/offset", false),
            ("/api/lyrics/A/song.mp3/extra", false),
            ("/api/lyrics/A/", false),
            ("/api/lyrics//song.mp3", false),
            ("/api/lyrics/jobs", false),
            ("/api/other/A/song.mp3", false),
            ("/else/api/lyrics/A/song.mp3", false),
        ];
        for (path, optional) in paths {
            for method in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] {
                for status in [200, 404, 401, 403, 422, 500, 503] {
                    let response: Response = tauri::http::Response::builder()
                        .status(status)
                        .body("No lyrics for song")
                        .unwrap()
                        .into();
                    LEVELS.with(|levels| levels.borrow_mut().clear());
                    received(&method.parse().unwrap(), path, &response);
                    let expected = if status == 200
                        || (optional && status == 404 && matches!(method, "GET" | "HEAD"))
                    {
                        log::Level::Debug
                    } else {
                        log::Level::Warn
                    };
                    LEVELS.with(|levels| {
                        assert_eq!(*levels.borrow(), [expected], "{method} {path} {status}");
                    });
                    assert_eq!(response.status().as_u16(), status);
                }
            }
        }
    }

    #[test]
    fn fifty_concurrent_failed_requests_emit_one_state_line_and_one_summary() {
        init_logger();
        let backend = "https://outage.example.test/krobi";
        let threads: Vec<_> = (0..50)
            .map(|_| {
                std::thread::spawn(move || {
                    init_logger();
                    proxy_failed(backend, "connection refused\nfixture detail");
                    LINES.with(|lines| lines.take())
                })
            })
            .collect();
        let mut lines: Vec<_> = threads
            .into_iter()
            .flat_map(|thread| thread.join().unwrap())
            .collect();
        outages().get_mut(backend).unwrap().since =
            Instant::now() - std::time::Duration::from_millis(4200);
        proxy_completed("https://other.example.test", 200);
        proxy_completed(backend, 503);
        proxy_completed(backend, 200);
        proxy_completed(backend, 200);
        lines.extend(LINES.with(|lines| lines.take()));
        let visible: Vec<_> = lines
            .iter()
            .filter(|(level, _)| *level != log::Level::Debug)
            .collect();
        assert_eq!(visible.len(), 2, "{visible:?}");
        assert_eq!(visible[0].0, log::Level::Warn);
        assert_eq!(
            visible[0].1,
            "nest unreachable: connection refused fixture detail"
        );
        assert_eq!(visible[1].0, log::Level::Info);
        assert_eq!(
            visible[1].1,
            "nest reachable again after 4.2 s; 50 requests failed meanwhile"
        );
        assert_eq!(
            lines
                .iter()
                .filter(|(level, _)| *level == log::Level::Debug)
                .count(),
            50
        );
        assert!(!outages().contains_key(backend));
        proxy_failed(backend, "timeout");
        proxy_completed(backend, 401);
        LINES.with(|lines| {
            let lines = lines.borrow();
            assert_eq!(lines[0].1, "nest unreachable: timeout");
            assert!(lines[2].1.ends_with("1 requests failed meanwhile"));
        });
    }

    #[test]
    fn gateway_and_body_errors_count_each_request_once_without_false_recovery() {
        init_logger();
        let backend = "https://gateway.example.test/prefix";
        for _ in 0..50 {
            let response: Response = tauri::http::Response::builder()
                .status(503)
                .body("")
                .unwrap()
                .into();
            proxy_received(
                backend,
                &reqwest::Method::GET,
                "/api/media/A/one.mp3",
                &response,
            );
            proxy_body_failed(backend, 503, "truncated gateway body");
            proxy_completed(backend, 503);
        }
        let response: Response = tauri::http::Response::builder()
            .status(401)
            .body("")
            .unwrap()
            .into();
        proxy_received(backend, &reqwest::Method::GET, "/api/me", &response);
        proxy_completed(backend, 401);
        LINES.with(|lines| {
            let lines = lines.borrow();
            assert_eq!(
                lines
                    .iter()
                    .filter(|(level, _)| *level == log::Level::Warn)
                    .count(),
                1
            );
            assert_eq!(
                lines
                    .iter()
                    .filter(|(level, _)| *level == log::Level::Info)
                    .count(),
                1
            );
            assert!(lines
                .last()
                .unwrap()
                .1
                .ends_with("50 requests failed meanwhile"));
        });
    }

    #[test]
    fn masks_headers_including_configured_custom_values() {
        let mut values = HeaderMap::new();
        for name in [
            "authorization",
            "cookie",
            "set-cookie",
            "x-api-key",
            "x-krobi-token",
            "x-custom-login",
        ] {
            values.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                "fixture-secret".parse().unwrap(),
            );
        }
        let safe = headers(&values);
        assert!(!safe.contains("fixture-secret"));
        for name in values.keys() {
            assert!(safe.contains(name.as_str()));
        }
    }
    #[test]
    fn masks_query_credentials_including_subsonic_and_encoded_names() {
        let safe = url("https://user:pass@example.test/rest?access_token=a&token=b&key=c&secret=d&password=e&apiKey=f&t=g&s=h&%74=i&album=ok#secret");
        let parsed = Url::parse(&safe).unwrap();
        assert!(parsed.username().is_empty());
        assert!(parsed.password().is_none());
        assert!(parsed.fragment().is_none());
        for (key, value) in parsed.query_pairs() {
            assert_eq!(value, if key == "album" { "ok" } else { "[redacted]" });
        }
    }
    #[test]
    fn failure_diagnostic_has_request_id_and_body_length_without_body_or_headers() {
        let response: Response = tauri::http::Response::builder()
            .status(503)
            .header("x-request-id", "fixture-request-id")
            .header("x-custom-login", "fixture-header-secret")
            .header("content-length", "19")
            .body("fixture-body-secret")
            .unwrap()
            .into();
        let line = self::response(&response);
        assert!(line.contains("status=503"));
        assert!(line.contains("request_id=fixture-request-id"));
        assert!(line.contains("body_bytes=19"));
        assert!(!line.contains("fixture-header-secret"));
        assert!(!line.contains("fixture-body-secret"));
    }

    #[tokio::test]
    async fn request_errors_never_print_the_original_url() {
        let error = reqwest::Client::new()
            .get("http://127.0.0.1:0/?token=fixture-secret")
            .send()
            .await
            .unwrap_err();
        assert!(!self::error(&error).contains("fixture-secret"));
    }
}
