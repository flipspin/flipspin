use super::downloads::*;
use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

fn request(listener: &TcpListener) -> (TcpStream, String) {
    let (mut socket, _) = listener.accept().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        socket.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
    }
    (socket, String::from_utf8(header).unwrap().to_lowercase())
}
fn paths() -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("krobi-download-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join("song.part");
    let destination = dir.join("song.wav");
    std::fs::write(&destination, b"previous complete copy").unwrap();
    (dir, part, destination)
}
fn target(listener: &TcpListener) -> url::Url {
    media_download_target(
        &format!("http://{}", listener.local_addr().unwrap()),
        "/api/media/Album/Song.wav",
    )
    .unwrap()
}
fn client() -> Client {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
        .download_client()
        .unwrap()
}

#[tokio::test]
async fn download_stream_longer_than_thirty_seconds_completes_atomically() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let target = target(&listener);
    let (dir, part, destination) = paths();
    let final_path = destination.clone();
    let server = std::thread::spawn(move || {
        let (mut socket, headers) = request(&listener);
        assert!(headers.starts_with("get /api/media/Album/Song.wav ".to_lowercase().as_str()));
        assert!(headers.contains("authorization: bearer test-token"));
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 32\r\nETag: \"song-v1\"\r\nConnection: close\r\n\r\n").unwrap();
        for _ in 0..32 {
            std::thread::sleep(Duration::from_secs(1));
            assert_eq!(
                std::fs::read(&final_path).unwrap(),
                b"previous complete copy"
            );
            socket.write_all(b"x").unwrap();
        }
    });
    let started = std::time::Instant::now();
    transfer_media(&client(), target, "test-token", &part, &destination)
        .await
        .unwrap();
    let elapsed = started.elapsed();
    println!(
        "device download: {:.1} seconds, completed",
        elapsed.as_secs_f64()
    );
    assert!(elapsed > Duration::from_secs(30));
    assert_eq!(std::fs::read(&destination).unwrap(), vec![b'x'; 32]);
    assert!(!part.exists());
    server.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn dropped_download_resumes_from_part_offset_with_range_and_if_range() {
    for validator in [
        "ETag: \"song-v1\"",
        "Last-Modified: Wed, 01 Jan 2025 00:00:00 GMT",
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = target(&listener);
        let (dir, part, destination) = paths();
        let part_path = part.clone();
        let final_path = destination.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, headers) = request(&listener);
            assert!(!headers.contains("range:"));
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n{validator}\r\nConnection: close\r\n\r\n0123").unwrap();
            drop(socket); // The declared body is incomplete.
            let (mut socket, headers) = request(&listener);
            assert_eq!(std::fs::metadata(part_path).unwrap().len(), 4);
            assert_eq!(
                std::fs::read(final_path).unwrap(),
                b"previous complete copy"
            );
            assert!(headers.contains("range: bytes=4-\r\n"));
            let value = validator.split_once(": ").unwrap().1.to_lowercase();
            assert!(headers.contains(&format!("if-range: {value}\r\n")));
            write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 4-9/10\r\nContent-Length: 6\r\n{validator}\r\nConnection: close\r\n\r\n456789").unwrap();
        });
        transfer_media(&client(), target, "", &part, &destination)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"0123456789");
        assert!(!part.exists());
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[tokio::test]
async fn changed_if_range_restarts_and_invalid_partial_response_preserves_destination() {
    for valid in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = target(&listener);
        let (dir, part, destination) = paths();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = request(&listener);
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nold!").unwrap();
            drop(socket);
            let (mut socket, headers) = request(&listener);
            assert!(headers.contains("if-range: \"v1\""));
            if valid {
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nETag: \"v2\"\r\nConnection: close\r\n\r\nnew").unwrap();
            } else {
                write!(socket, "HTTP/1.1 206 Partial Content\r\nContent-Length: 6\r\nContent-Range: bytes 3-8/10\r\nETag: \"v1\"\r\nConnection: close\r\n\r\nwrong!").unwrap();
            }
        });
        let result = transfer_media(&client(), target, "", &part, &destination).await;
        assert_eq!(result.is_ok(), valid);
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            if valid {
                b"new".as_slice()
            } else {
                b"previous complete copy".as_slice()
            }
        );
        server.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
