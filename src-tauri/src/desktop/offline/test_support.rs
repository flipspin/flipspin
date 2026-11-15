//! Shared loopback HTTP and isolated store fixtures.

use super::*;
use std::io::{Read, Write};

pub(super) fn state(origin: &str) -> DesktopState {
    let mut r = crate::desktop::tests::remote_runtime(origin, origin);
    r.server.instance_id = Some("test-nido".into());
    DesktopState {
        app_dir: PathBuf::new(),
        http: Client::new(),
        runtime: Mutex::new(r),
        preferences_file: Mutex::new(()),
        connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
        status_changed: Box::new(|_| {}),
        offline: Mutex::new(test_store()),
    }
}

pub(super) fn serve(replies: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    serve_typed(
        replies
            .into_iter()
            .map(|(s, b)| (s, b, "application/json"))
            .collect(),
    )
}

pub(super) fn serve_typed(
    replies: Vec<(u16, String, &'static str)>,
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body, content_type) in replies {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            let mut byte = [0; 1];
            while !header.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
            }
            let header = String::from_utf8(header).unwrap();
            let len = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            let mut payload = vec![0; len];
            socket.read_exact(&mut payload).unwrap();
            requests.push(format!("{header}{}", String::from_utf8(payload).unwrap()));
            let status_line = if status == 304 {
                "Not Modified"
            } else if status == 412 {
                "Precondition Failed"
            } else if status == 503 {
                "Unavailable"
            } else {
                "OK"
            };
            write!(socket,"HTTP/1.1 {status} {status_line}\r\nContent-Length: {}\r\nContent-Type: {content_type}\r\nETag: \"server-v2\"\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        requests
    });
    (origin, thread)
}

pub(super) fn snapshot_replies() -> Vec<(u16, String, &'static str)> {
    vec![
        (200, "[]".into(), "application/json"),
        (200, "{\"tracks\":[]}".into(), "application/json"),
        (200, "[]".into(), "application/json"),
        (200, "{}".into(), "application/json"),
    ]
}
