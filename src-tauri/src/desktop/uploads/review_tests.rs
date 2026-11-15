use super::*;
use std::io::Write;

fn source(path: PathBuf, id: &str) -> Source {
    Source {
        path,
        id: id.into(),
        name: format!("{id}.wav"),
        sha256: String::new(),
        bytes: 0,
        metadata: Value::Null,
        modified: None,
        reason: None,
        selected: true,
    }
}
fn batch(sources: Vec<Source>) -> Batch {
    Batch {
        id: "local-batch".into(),
        instance: "nest".into(),
        account: "account".into(),
        sources,
        view: json!({"phase":"revisando","files":[]}),
        confirmed: false,
        started: false,
        choice: "keep-both".into(),
        stopped: false,
        revision: 0,
        folder: Some("~/Music/Library".into()),
        server_id: None,
        retrying: false,
    }
}
fn temp() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("krobi-upload-review-{}", rand::random::<u64>()));
    fs::create_dir_all(&dir).unwrap();
    dir
}
fn audio() -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend(40_u32.to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(44100_u32.to_le_bytes());
    bytes.extend(88200_u32.to_le_bytes());
    bytes.extend(2_u16.to_le_bytes());
    bytes.extend(16_u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(4_u32.to_le_bytes());
    bytes.extend([0; 4]);
    bytes
}
fn request(socket: &mut std::net::TcpStream) -> (String, Vec<u8>) {
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let mut headers = Vec::new();
    let mut byte = [0];
    while !headers.ends_with(b"\r\n\r\n") {
        socket.read_exact(&mut byte).unwrap();
        headers.push(byte[0]);
    }
    let headers = String::from_utf8(headers).unwrap().to_lowercase();
    let size = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .unwrap_or("0")
        .parse()
        .unwrap();
    let mut body = vec![0; size];
    socket.read_exact(&mut body).unwrap();
    (headers, body)
}
fn respond(socket: &mut std::net::TcpStream, status: u16, value: &Value) {
    let body = value.to_string();
    write!(socket, "HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}

#[test]
fn folder_label_shows_at_most_two_components_and_abbreviates_home() {
    let home = Path::new("/home/listener");
    assert_eq!(
        review::folder_label(&home.join("Music/Library"), Some(home)),
        "~/Music/Library"
    );
    assert_eq!(review::folder_label(home, Some(home)), "~");
    assert_eq!(
        review::folder_label(&home.join("Music/Albums/Library"), Some(home)),
        "Albums/Library"
    );
    assert_eq!(
        review::folder_label(Path::new("/media/disk/Music/Library"), Some(home)),
        "Music/Library"
    );
    assert_eq!(review::folder_label(Path::new("Library"), None), "Library");
    let mut old = batch(vec![]);
    old.folder = None;
    assert_eq!(old.display_view()["folder"], Value::Null);
}

#[test]
fn local_sniff_read_errors_and_size_or_mtime_changes_have_distinct_reasons() {
    let dir = temp();
    let path = dir.join("song.wav");
    fs::write(&path, b"a text document with an audio extension").unwrap();
    assert_eq!(
        review::inspect(source(path.clone(), "text"))
            .reason
            .as_deref(),
        Some("not-audio")
    );
    fs::write(&path, audio()).unwrap();
    let original = review::inspect(source(path.clone(), "song"));
    assert!(original.reason.is_none());
    fs::write(&path, [audio(), vec![0; 2]].concat()).unwrap();
    assert_eq!(
        review::read_reason(&read_chunk(&original, 0).unwrap_err()),
        "changed"
    );
    fs::write(&path, audio()).unwrap();
    let original = review::inspect(source(path.clone(), "song"));
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(original.modified.unwrap() + Duration::from_secs(2))
        .unwrap();
    assert_eq!(
        review::read_reason(&read_chunk(&original, 0).unwrap_err()),
        "changed"
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        review::read_reason(&read_chunk(&original, 0).unwrap_err()),
        "unreadable"
    );
    assert_eq!(
        review::inspect(source(path.clone(), "missing"))
            .reason
            .as_deref(),
        Some("unreadable")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::write(&path, audio()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        let denied = review::inspect(source(path.clone(), "denied"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(denied.reason.as_deref(), Some("unreadable"));
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn server_rejections_map_to_not_audio_damaged_and_keep_no_space() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        for (status, body) in [
            (422, json!({"detail":{"reason":"no-es-audio"}})),
            (422, json!({"detail":{"reason":"archivo-danado"}})),
            (422, json!({})),
            (507, json!({"detail":{"reason":"sin-espacio"}})),
        ] {
            let (mut socket, _) = listener.accept().unwrap();
            request(&mut socket);
            respond(&mut socket, status, &body);
        }
    });
    tauri::async_runtime::block_on(async {
        let http = Client::builder().no_proxy().build().unwrap();
        for expected in ["not-audio", "damaged", "damaged", "no-space"] {
            assert_eq!(
                send_piece(&http, &url, "test-token", 0, audio())
                    .await
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
    });
    server.join().unwrap();
    let mut batch = batch(vec![]);
    batch.update_view(json!({"phase":"terminado","files":[
        {"id":"1","state":"fallida","reason":"no-es-audio"},
        {"id":"2","state":"fallida","reason":"archivo-danado"},
        {"id":"3","state":"fallida","reason":"sin-espacio"}]}));
    let files = batch.view["files"].as_array().unwrap();
    assert_eq!(files[0]["reason"], "not-audio");
    assert_eq!(files[1]["reason"], "damaged");
    assert_eq!(files[2]["reason"], "sin-espacio");
    assert!(!review::retryable(&files[0]) && !review::retryable(&files[1]));
    assert!(review::retryable(&files[2]));
}

#[test]
fn retry_rehashes_selected_sources_and_preserves_permanent_outcomes_after_restart() {
    let dir = temp();
    let mut sources = Vec::new();
    for reason in ["changed", "unreadable", "not-audio", "damaged"] {
        let path = dir.join(format!("{reason}.wav"));
        fs::write(&path, audio()).unwrap();
        let mut file = review::inspect(source(path, reason));
        if reason != "damaged" {
            file.reason = Some(reason.into());
        }
        sources.push(file);
    }
    let mut batch = batch(sources);
    batch.update_view(json!({"phase":"terminado","files":[
        {"id":"damaged","name":"damaged.wav","state":"fallida","reason":"archivo-danado"}
    ]}));
    let db = dir.join("uploads.sqlite");
    UploadStore::open(&db).unwrap().save(&batch).unwrap();
    let mut recovered = UploadStore::open(&db)
        .unwrap()
        .get(&Scope::new("nest", "account").unwrap(), &batch.id)
        .unwrap();
    assert_eq!(
        recovered.display_view()["files"],
        batch.display_view()["files"]
    );
    assert!(review::prepare_retry(&mut recovered));
    assert_ne!(recovered.remote_id(), batch.id);
    assert_eq!(
        recovered
            .sources
            .iter()
            .filter(|s| s.selected)
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["changed", "unreadable"]
    );
    for index in 0..2 {
        assert!(recovered.sources[index].sha256.is_empty());
        let mut new_audio = audio();
        new_audio[44] = 1;
        fs::write(&recovered.sources[index].path, &new_audio).unwrap();
        recovered.sources[index] = review::inspect(recovered.sources[index].clone());
        assert!(recovered.sources[index].reason.is_none());
        assert_ne!(recovered.sources[index].sha256, batch.sources[index].sha256);
        assert_eq!(read_chunk(&recovered.sources[index], 0).unwrap(), new_audio);
    }
    recovered.update_view(
        json!({"phase":"subiendo","files":[{"id":"changed","state":"por-subir","reason":null}]}),
    );
    assert!(recovered.view["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f["reason"] == "damaged"));
    batch
        .sources
        .retain(|s| matches!(s.id.as_str(), "not-audio" | "damaged"));
    batch.view["files"] = json!([{"id":"damaged","state":"fallida","reason":"damaged"}]);
    assert!(!review::prepare_retry(&mut batch));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn folder_is_in_durable_view_but_absent_from_every_actual_request_body() {
    let dir = temp();
    let path = dir.join("song.wav");
    fs::write(&path, audio()).unwrap();
    let mut batch = batch(vec![review::inspect(source(path, "song"))]);
    let mut rejected = source(dir.join("rejected.wav"), "rejected");
    rejected.reason = Some("not-audio".into());
    let mut completed = source(dir.join("completed.wav"), "completed");
    completed.selected = false;
    batch.sources.extend([rejected, completed]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let expected_bytes = audio();
    let server = std::thread::spawn(move || {
        for endpoint in [
            "check",
            "batches",
            "batches/local-batch/start",
            "batches/local-batch/files/sha/fail",
            "batches/local-batch/stop",
            "batches/local-batch/retry",
            "batches/local-batch/files/sha",
        ] {
            let (mut socket, _) = listener.accept().unwrap();
            let (headers, body) = request(&mut socket);
            assert!(headers.contains("authorization: bearer test-token"));
            let method = if endpoint.ends_with("/sha") {
                "patch"
            } else {
                "post"
            };
            assert!(headers.starts_with(&format!("{method} /api/uploads/{endpoint} ")));
            let text = String::from_utf8_lossy(&body);
            for private in [
                "folder",
                "~/Music/Library",
                "modified",
                "selected",
                "reason",
                "path",
                "server_id",
            ] {
                assert!(
                    !text.contains(private),
                    "private field in {endpoint}: {private}"
                );
            }
            if method == "patch" {
                assert_eq!(body, expected_bytes);
                socket
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .unwrap();
            } else {
                let value: Value = serde_json::from_slice(&body).unwrap();
                if endpoint == "check" || endpoint == "batches" {
                    assert_eq!(value["files"].as_array().unwrap().len(), 1);
                    assert_eq!(value["files"][0]["name"], "song.wav");
                    assert_eq!(value["files"][0]["bytes"], expected_bytes.len());
                }
                respond(
                    &mut socket,
                    200,
                    &json!({"id":"local-batch","phase":"resumen","files":[]}),
                );
            }
        }
    });
    tauri::async_runtime::block_on(async {
        let http = Client::builder().no_proxy().build().unwrap();
        let view = review_remote(&http, &origin, "test-token", &batch, || Ok(()))
            .await
            .unwrap();
        batch.update_view(view);
        assert_eq!(batch.display_view()["folder"], "~/Music/Library");
        for (suffix, body) in [
            ("start", json!({"duplicates":batch.choice})),
            ("files/sha/fail", json!({})),
            ("stop", json!({})),
            ("retry", json!({})),
        ] {
            json_request(
                &http,
                &origin,
                "test-token",
                &format!("batches/local-batch/{suffix}"),
                Some(body),
            )
            .await
            .unwrap();
        }
        send_piece(
            &http,
            &format!("{origin}/api/uploads/batches/local-batch/files/sha"),
            "test-token",
            0,
            read_chunk(&batch.sources[0], 0).unwrap(),
        )
        .await
        .unwrap();
    });
    server.join().unwrap();
    let db = dir.join("uploads.sqlite");
    UploadStore::open(&db).unwrap().save(&batch).unwrap();
    let recovered = UploadStore::open(&db)
        .unwrap()
        .get(&Scope::new("nest", "account").unwrap(), &batch.id)
        .unwrap();
    assert_eq!(recovered.display_view()["folder"], "~/Music/Library");
    fs::remove_dir_all(dir).unwrap();
}
