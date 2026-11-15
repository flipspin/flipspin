//! A killed subprocess uses the same durable record and transport as the sender.
use super::*;
use std::io::Write;

fn request(socket: &mut std::net::TcpStream) -> (String, Vec<u8>) {
    socket.set_nonblocking(false).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut header = Vec::new();
    let mut byte = [0];
    while !header.ends_with(b"\r\n\r\n") {
        socket.read_exact(&mut byte).unwrap();
        header.push(byte[0]);
    }
    let header = String::from_utf8(header).unwrap().to_lowercase();
    let length = header
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap_or("0")
        .parse()
        .unwrap();
    let mut body = vec![0; length];
    socket.read_exact(&mut body).unwrap();
    (header, body)
}
fn response(socket: &mut std::net::TcpStream, status: &str, offset: usize, body: &str) {
    write!(socket, "HTTP/1.1 {status}\r\nUpload-Offset: {offset}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}
#[test]
#[ignore = "subprocess entry point; invoked by killed_worker_resumes_from_server_offset_and_final_sha_matches"]
fn upload_worker_process() {
    let Ok(db) = std::env::var("KROBI_UPLOAD_TEST_DB") else {
        return;
    };
    let url = std::env::var("KROBI_UPLOAD_TEST_URL").unwrap();
    let batch = UploadStore::open(Path::new(&db))
        .unwrap()
        .get(&Scope::new("nest", "account").unwrap(), "batch")
        .unwrap();
    tauri::async_runtime::block_on(async {
        let http = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        loop {
            let offset = head_offset(&http, &url, "test-token").await.unwrap();
            let content = read_chunk(&batch.sources[0], offset).unwrap();
            let end = offset + content.len() as u64;
            send_piece(&http, &url, "test-token", offset, content)
                .await
                .unwrap();
            if end == batch.sources[0].bytes {
                break;
            }
        }
    });
}
#[test]
fn killed_worker_resumes_from_server_offset_and_final_sha_matches() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let expected = (0..CHUNK * 2 + 31)
        .map(|i| (i % 251) as u8)
        .collect::<Vec<_>>();
    let bytes = expected.len();
    let (mid_send, killed) = std::sync::mpsc::sync_channel(1);
    let (continue_server, continued) = std::sync::mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut stored = Vec::new();
        let mut patches = 0;
        let mut resumed = false;
        while stored.len() < bytes {
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "worker failed to reconnect"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            let (headers, content) = request(&mut socket);
            assert!(headers.contains("authorization: bearer test-token"));
            if headers.starts_with("head ") {
                if patches == 2 {
                    assert_eq!(stored.len(), CHUNK + 137);
                    resumed = true;
                }
                response(&mut socket, "200 OK", stored.len(), "");
            } else {
                assert!(headers.starts_with("patch "));
                assert!(headers.contains(&format!("upload-offset: {}\r\n", stored.len())));
                assert!(
                    headers.contains(&format!("upload-checksum: {:x}", Sha256::digest(&content)))
                );
                patches += 1;
                if patches == 2 {
                    // The server retains a partial chunk while the client awaits its PATCH
                    // response, so process death leaves SQLite behind the server offset.
                    stored.extend_from_slice(&content[..137]);
                    mid_send.send(()).unwrap();
                    continued.recv_timeout(Duration::from_secs(10)).unwrap();
                } else {
                    stored.extend_from_slice(&content);
                    response(&mut socket, "204 No Content", stored.len(), "");
                }
            }
        }
        assert!(resumed, "restart must HEAD the committed server offset");
        stored
    });
    let dir = std::env::temp_dir().join(format!("krobi-upload-kill-{}", rand::random::<u64>()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("source.wav");
    let db = dir.join("offline.sqlite");
    fs::write(&path, &expected).unwrap();
    let batch = Batch {
        id: "batch".into(),
        instance: "nest".into(),
        account: "account".into(),
        sources: vec![Source {
            path,
            id: "file".into(),
            name: "source.wav".into(),
            sha256: format!("{:x}", Sha256::digest(&expected)),
            bytes: bytes as u64,
            metadata: Value::Null,
            modified: None,
            reason: None,
            selected: true,
        }],
        view: json!({"phase":"subiendo","files":[]}),
        confirmed: true,
        started: true,
        choice: "use-nest".into(),
        stopped: false,
        revision: 0,
        folder: None,
        server_id: None,
        retrying: false,
    };
    UploadStore::open(&db).unwrap().save(&batch).unwrap();
    let spawn = || {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "desktop::uploads::recovery_tests::upload_worker_process",
                "--ignored",
            ])
            .env("KROBI_UPLOAD_TEST_DB", &db)
            .env("KROBI_UPLOAD_TEST_URL", &url)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap()
    };
    let mut first = spawn();
    killed.recv_timeout(Duration::from_secs(15)).unwrap();
    first.kill().unwrap(); // Unix SIGKILL leaves recovery dependent on durable state.
    assert!(!first.wait().unwrap().success());
    continue_server.send(()).unwrap();
    let mut restarted = spawn();
    assert!(restarted.wait().unwrap().success());
    let received = server.join().unwrap();
    assert_eq!(Sha256::digest(&received), Sha256::digest(&expected));
    assert_eq!(received, expected);
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn wake_rechecks_space_before_resuming_with_old_and_new_nests() {
    for legacy in [true, false] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, _) = request(&mut socket);
            assert!(headers.starts_with("head /upload "));
            response(&mut socket, "200 OK", 3, "");
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, _) = request(&mut socket);
            assert!(headers.starts_with("get /api/uploads/space "));
            response(
                &mut socket,
                if legacy { "404 Not Found" } else { "200 OK" },
                0,
                if legacy {
                    "{}"
                } else {
                    r#"{"freeBytes":9999999,"floorBytes":1}"#
                },
            );
            if legacy {
                let (mut socket, _) = listener.accept().unwrap();
                let (headers, content) = request(&mut socket);
                assert!(headers.starts_with("patch /upload "));
                assert!(headers.contains("upload-offset: 3\r\n"));
                assert!(
                    content.is_empty(),
                    "space check must not advance the offset"
                );
                response(&mut socket, "204 No Content", 3, "");
            }
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, content) = request(&mut socket);
            assert!(headers.starts_with("patch /upload "));
            assert_eq!(content, b"remaining");
            response(&mut socket, "204 No Content", 12, "");
        });
        tauri::async_runtime::block_on(async {
            let http = Client::builder().no_proxy().build().unwrap();
            let url = format!("{origin}/upload");
            assert_eq!(
                resume_offset(&http, &origin, &url, "test-token")
                    .await
                    .unwrap(),
                3
            );
            send_piece(&http, &url, "test-token", 3, b"remaining".to_vec())
                .await
                .unwrap();
        });
        server.join().unwrap();
    }
}

#[test]
fn adaptive_upload_loopback_throughput_and_one_head_per_file() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let total = 64 * CHUNK;
    let server = std::thread::spawn(move || {
        let mut offset = 0;
        let mut chunks = Vec::new();
        let mut heads = 0;
        let mut spaces = 0;
        while offset < total {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, body) = request(&mut socket);
            if headers.starts_with("head ") {
                heads += 1;
                response(&mut socket, "200 OK", offset, "");
            } else if headers.starts_with("get /api/uploads/space ") {
                spaces += 1;
                response(
                    &mut socket,
                    "200 OK",
                    0,
                    r#"{"freeBytes":999999999,"floorBytes":1}"#,
                );
            } else {
                assert!(headers.starts_with("patch "));
                assert!(headers.contains(&format!("upload-offset: {offset}\r\n")));
                assert!(body.iter().all(|b| *b == 42));
                chunks.push(body.len());
                offset += body.len();
                response(&mut socket, "204 No Content", offset, "");
            }
        }
        assert_eq!(heads, 1, "successful chunks must not HEAD again");
        assert_eq!(spaces, 1, "space is checked once for the file");
        assert_eq!(&chunks[..4], &[CHUNK, 2 * CHUNK, 4 * CHUNK, MAX_CHUNK]);
    });
    let dir = std::env::temp_dir().join(format!("krobi-throughput-{}", rand::random::<u64>()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("source.wav");
    fs::write(&path, vec![42; total]).unwrap();
    let source = Source {
        path,
        id: "file".into(),
        name: "source.wav".into(),
        sha256: String::new(),
        bytes: total as u64,
        metadata: Value::Null,
        modified: None,
        reason: None,
        selected: true,
    };
    tauri::async_runtime::block_on(async {
        let http = Client::builder().no_proxy().build().unwrap();
        let started = std::time::Instant::now();
        let mut cursor =
            UploadCursor::resume(&http, &origin, format!("{origin}/upload"), "test-token", 0)
                .await
                .unwrap();
        while cursor.offset < source.bytes {
            let bytes = read_chunk_sized(&source, cursor.offset, cursor.chunk).unwrap();
            cursor
                .send(&http, &origin, "test-token", bytes, None)
                .await
                .unwrap();
            wait_for_queue(true).await;
        }
        let mib_per_second = (total / CHUNK) as f64 / started.elapsed().as_secs_f64();
        println!("upload loopback: {mib_per_second:.1} MiB/s (floor: 20 MiB/s)");
        assert!(
            mib_per_second >= 20.0,
            "upload throughput: {mib_per_second:.1} MiB/s"
        );
    });
    server.join().unwrap();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn patch_507_rechecks_space_and_preserves_no_space_pause_and_offset() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for method in ["head ", "get ", "patch ", "get "] {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, _) = request(&mut socket);
            assert!(headers.starts_with(method));
            match method {
                "head " => response(&mut socket, "200 OK", 7, ""),
                "patch " => response(&mut socket, "507 Insufficient Storage", 7, "{}"),
                _ => response(
                    &mut socket,
                    "200 OK",
                    0,
                    r#"{"freeBytes":99999,"floorBytes":1}"#,
                ),
            }
        }
    });
    tauri::async_runtime::block_on(async {
        let http = Client::builder().no_proxy().build().unwrap();
        let mut cursor =
            UploadCursor::resume(&http, &origin, format!("{origin}/upload"), "test-token", 0)
                .await
                .unwrap();
        let error = cursor
            .send(&http, &origin, "test-token", vec![42; CHUNK], None)
            .await
            .unwrap_err();
        assert_eq!(pause_cause(&error), "no-space");
        assert_eq!(cursor.offset, 7);
        assert_eq!(cursor.chunk, CHUNK);
    });
    server.join().unwrap();
}
