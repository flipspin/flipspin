//! One-time copies: paths, hashing, bytes, receipts and bearer tokens stay here.
use super::*;
use krobi_offline::store::Scope;
use lofty::prelude::{Accessor, AudioFile, TaggedFileExt};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use tauri::{Emitter, Manager};

mod lifetime;
#[cfg(test)]
mod recovery_tests;
mod review;
#[cfg(test)]
mod review_tests;
#[cfg(target_os = "macos")]
pub(crate) use lifetime::sleep;
pub(crate) use lifetime::{close, confirm_exit, drain, opened, pause, summary, UploadLifetime};

const CHUNK: usize = 1024 * 1024;
const MAX_CHUNK: usize = 8 * CHUNK;

/// Volatile receipt: discarded on cancellation, errors, intent or authority changes.
struct UploadCursor {
    url: String,
    revision: u64,
    offset: u64,
    chunk: usize,
}
impl UploadCursor {
    async fn resume(
        http: &Client,
        origin: &str,
        url: String,
        token: &str,
        revision: u64,
    ) -> ShellResult<Self> {
        let offset = resume_offset(http, origin, &url, token).await?;
        Ok(Self {
            url,
            revision,
            offset,
            chunk: CHUNK,
        })
    }
    async fn send(
        &mut self,
        http: &Client,
        origin: &str,
        token: &str,
        content: Vec<u8>,
        lifetime: Option<(&UploadLifetime, bool)>,
    ) -> ShellResult<()> {
        let started = std::time::Instant::now();
        let length = content.len() as u64;
        let checksum = format!("{:x}", Sha256::digest(&content));
        let body = match lifetime {
            Some((lifetime, enabled)) => lifetime.body(content, enabled),
            None => content.into(),
        };
        if let Err(error) = send_body(http, &self.url, token, self.offset, checksum, body).await {
            if error.to_string() == "no-space" {
                // A 507 is authoritative even if capacity changes during this probe.
                let _ = check_space(http, origin, &self.url, token, self.offset).await;
            }
            return Err(error);
        }
        self.offset += length;
        if started.elapsed() < Duration::from_millis(500) {
            self.chunk = (self.chunk * 2).min(MAX_CHUNK);
        } else {
            self.chunk = (self.chunk / 2).max(CHUNK);
        }
        Ok(())
    }
}
fn storage(e: impl std::fmt::Display) -> ShellError {
    ShellError::Message(e.to_string())
}

#[derive(Clone, Serialize, Deserialize)]
struct Source {
    path: PathBuf,
    id: String,
    name: String,
    sha256: String,
    bytes: u64,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    modified: Option<std::time::SystemTime>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default = "review::selected")]
    selected: bool,
}
impl Source {
    fn manifest(&self) -> Value {
        json!({"id":self.id,"name":self.name,"sha256":self.sha256,"bytes":self.bytes,"title":self.metadata["title"],"artist":self.metadata["artist"],"duration_s":self.metadata["duration_s"]})
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Batch {
    id: String,
    instance: String,
    account: String,
    sources: Vec<Source>,
    view: Value,
    confirmed: bool,
    started: bool,
    choice: String,
    stopped: bool,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    retrying: bool,
}
/// Same durable index as offline, separate connection and feature-owned tables.
pub(crate) struct UploadStore {
    db: Mutex<Connection>,
}
impl UploadStore {
    pub fn open(path: &Path) -> ShellResult<Self> {
        let db = Connection::open(path).map_err(storage)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS desktop_uploads(id TEXT PRIMARY KEY, instance TEXT NOT NULL, account TEXT NOT NULL, body TEXT NOT NULL);").map_err(storage)?;
        Ok(Self { db: Mutex::new(db) })
    }
    fn save(&self, batch: &Batch) -> ShellResult<()> {
        lock(&self.db, "uploads")?
            .execute(
                "INSERT OR REPLACE INTO desktop_uploads VALUES(?1,?2,?3,?4)",
                params![
                    batch.id,
                    batch.instance,
                    batch.account,
                    serde_json::to_string(batch)?
                ],
            )
            .map_err(storage)?;
        Ok(())
    }
    fn save_worker(&self, batch: &Batch) -> ShellResult<bool> {
        let db = lock(&self.db, "uploads")?;
        let current: String = db
            .query_row(
                "SELECT body FROM desktop_uploads WHERE id=?1",
                params![batch.id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        let current: Batch = serde_json::from_str(&current)?;
        if current.revision != batch.revision {
            return Ok(false);
        }
        db.execute(
            "UPDATE desktop_uploads SET body=?1 WHERE id=?2",
            params![serde_json::to_string(batch)?, batch.id],
        )
        .map_err(storage)?;
        Ok(true)
    }
    fn all(&self, scope: &Scope) -> ShellResult<Vec<Batch>> {
        let db = lock(&self.db, "uploads")?;
        let mut statement = db.prepare("SELECT body FROM desktop_uploads WHERE instance=?1 AND account=?2 ORDER BY rowid DESC").map_err(storage)?;
        let rows = statement
            .query_map(params![scope.instance_id, scope.account_id], |r| {
                r.get::<_, String>(0)
            })
            .map_err(storage)?;
        rows.map(|r| serde_json::from_str(&r.map_err(storage)?).map_err(ShellError::from))
            .collect()
    }
    fn get(&self, scope: &Scope, id: &str) -> ShellResult<Batch> {
        self.all(scope)?
            .into_iter()
            .find(|b| b.id == id)
            .ok_or(ShellError::Guard("upload-not-found"))
    }
}
fn emit(app: &AppHandle, batch: &Batch) {
    let state = app.state::<DesktopState>();
    let scope = state
        .runtime()
        .ok()
        .and_then(|r| super::offline::scope(&r).ok());
    if scope.is_some_and(|s| s.instance_id == batch.instance && s.account_id == batch.account) {
        let _ = app.emit("upload:changed", lifetime::snapshot(app, batch));
    }
}
fn persist(app: &AppHandle, batch: &Batch) -> ShellResult<()> {
    app.state::<UploadStore>().save(batch)?;
    emit(app, batch);
    Ok(())
}
fn persist_worker(app: &AppHandle, batch: &Batch) -> ShellResult<bool> {
    let saved = app.state::<UploadStore>().save_worker(batch)?;
    if saved {
        emit(app, batch);
    }
    Ok(saved)
}
fn hash_file(path: &Path) -> ShellResult<(String, u64)> {
    let mut source = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
        bytes += count as u64;
    }
    Ok((format!("{:x}", hash.finalize()), bytes))
}
fn collect(path: &Path, files: &mut Vec<PathBuf>) -> ShellResult<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            collect(&entry?.path(), files)?;
        }
    } else if meta.is_file() {
        files.push(path.to_owned());
    }
    Ok(())
}
fn enqueue(app: &AppHandle, paths: Vec<PathBuf>) -> ShellResult<Value> {
    let state = app.state::<DesktopState>();
    let scope = super::offline::scope(&*state.runtime()?)?;
    let id = format!("upload-{:016x}", rand::random::<u64>());
    let folder = (paths.len() == 1 && paths[0].is_dir()).then(|| {
        review::folder_label(
            &paths[0],
            crate::data_paths::user_home_for_display().as_deref(),
        )
    });
    let mut files = Vec::new();
    for path in paths {
        collect(&path, &mut files)?;
    }
    files.sort();
    files.dedup();
    if files.is_empty() {
        return Err(ShellError::Guard("no-files"));
    }
    let sources = files
        .into_iter()
        .enumerate()
        .map(|(i, path)| Source {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path,
            id: i.to_string(),
            sha256: String::new(),
            bytes: 0,
            metadata: Value::Null,
            modified: None,
            reason: None,
            selected: true,
        })
        .collect::<Vec<_>>();
    let batch = Batch {
        id: id.clone(),
        instance: scope.instance_id,
        account: scope.account_id,
        view: json!({"id":id,"phase":"revisando","reviewed":0,"total":sources.len(),"files":[]}),
        sources,
        confirmed: false,
        started: false,
        choice: "use-nest".into(),
        stopped: false,
        revision: 0,
        folder,
        server_id: None,
        retrying: false,
    };
    persist(app, &batch)?;
    Ok(lifetime::snapshot(app, &batch))
}
/// A native drop supplies filesystem paths directly. No browser File/ArrayBuffer.
pub(crate) fn drop_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = enqueue(&app, paths) {
            let _ = app.emit("upload:error", error.to_string());
        }
    });
}
pub(crate) async fn invoke(
    app: &AppHandle,
    state: &DesktopState,
    channel: &str,
    request: Option<&Value>,
) -> ShellResult<Value> {
    if channel == "upload:keep-awake" {
        if let Some(enabled) = request.and_then(|v| v["enabled"].as_bool()) {
            let mut runtime = state.runtime()?;
            runtime.preferences.upload_keep_awake = Some(enabled);
            state.save_preferences(runtime)?;
            app.state::<UploadLifetime>().cancel();
            lifetime::publish(app);
            drain(app);
        }
        return Ok(json!({"enabled":lifetime::keep_awake(app)}));
    }
    if channel == "upload:pause" {
        pause(
            app,
            request.and_then(|v| v["paused"].as_bool()).unwrap_or(true),
        );
        return Ok(
            json!({"paused":app.state::<UploadLifetime>().control.lock().unwrap_or_else(std::sync::PoisonError::into_inner).manual}),
        );
    }
    if channel == "upload:status" {
        let batches = lifetime::batches(app);
        return Ok(
            json!({"batches":batches.iter().map(|b|lifetime::snapshot(app, b)).collect::<Vec<_>>()}),
        );
    }
    let scope = super::offline::scope(&*state.runtime()?)?;
    let id = request.and_then(|v| v["id"].as_str());
    if channel == "upload:start" && id.is_none() {
        let folder = request.and_then(|v| v["pick"].as_str()) == Some("folder");
        let paths = tauri::async_runtime::spawn_blocking(move || {
            let dialog = rfd::FileDialog::new();
            if folder {
                dialog.pick_folder().map(|p| vec![p])
            } else {
                dialog.pick_files()
            }
        })
        .await
        .map_err(storage)?;
        return match paths {
            Some(paths) => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || enqueue(&app, paths))
                    .await
                    .map_err(storage)?
            }
            None => Ok(Value::Null),
        };
    }
    let id = id.ok_or(ShellError::Guard("upload-id-required"))?;
    let mut batch = app.state::<UploadStore>().get(&scope, id)?;
    match channel {
        "upload:start" => {
            if batch.view["phase"] != "resumen" {
                return Err(ShellError::Guard("upload-not-ready"));
            }
            batch.choice = request
                .and_then(|v| v["duplicates"].as_str())
                .filter(|c| matches!(*c, "use-nest" | "keep-both"))
                .unwrap_or("use-nest")
                .into();
            batch.confirmed = true;
            batch.view["phase"] = json!("subiendo");
        }
        "upload:stop" => {
            batch.stopped = true;
            batch.view["phase"] = json!("terminado");
        }
        "upload:retry-failed" => {
            if !review::prepare_retry(&mut batch) {
                return Ok(lifetime::snapshot(app, &batch));
            }
        }
        _ => return Err(ShellError::Guard("unknown-upload-channel")),
    }
    app.state::<UploadLifetime>().cancel();
    batch.revision += 1;
    persist(app, &batch)?;
    Ok(lifetime::snapshot(app, &batch))
}
fn authority(state: &DesktopState, batch: &Batch) -> ShellResult<(String, String)> {
    let runtime = state.runtime()?;
    if runtime.token.is_empty() {
        return Err(ShellError::Guard("signed-out"));
    }
    let scope = super::offline::scope(&runtime)?;
    if scope.instance_id != batch.instance
        || scope.account_id != batch.account
        || runtime.server.connection.state != ConnectionState::Connected
    {
        return Err(ShellError::Guard(
            if runtime.token.is_empty()
                || runtime.server.connection.state == ConnectionState::NeedsAuth
            {
                "signed-out"
            } else if runtime.server.connection.last_error
                == Some(super::connection::LastError::NoNetwork)
            {
                "no-network"
            } else {
                "nest-unreachable"
            },
        ));
    }
    Ok((runtime.backend_origin.clone(), runtime.token.clone()))
}
async fn reply(response: reqwest::Response) -> ShellResult<Value> {
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
        return Err(ShellError::Guard("signed-out"));
    }
    if response.status().is_success() {
        return Ok(response.json().await?);
    }
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    Err(ShellError::Message(
        value["detail"]["reason"]
            .as_str()
            .unwrap_or(if status.as_u16() == 507 {
                "sin-espacio"
            } else {
                "fallo-subida"
            })
            .to_owned(),
    ))
}
async fn json_call(
    state: &DesktopState,
    batch: &Batch,
    suffix: &str,
    body: Option<Value>,
) -> ShellResult<Value> {
    let (origin, token) = authority(state, batch)?;
    json_request(&state.http, &origin, &token, suffix, body).await
}
async fn json_request(
    http: &Client,
    origin: &str,
    token: &str,
    suffix: &str,
    body: Option<Value>,
) -> ShellResult<Value> {
    let url = format!("{origin}/api/uploads/{suffix}");
    let request = if let Some(body) = body {
        http.post(url).json(&body)
    } else {
        http.get(url)
    };
    reply(request.bearer_auth(token).send().await?).await
}
/// Only whitelisted manifest fields cross the server boundary.
async fn review_remote(
    http: &Client,
    origin: &str,
    token: &str,
    batch: &Batch,
    before_request: impl Fn() -> ShellResult<()>,
) -> ShellResult<Value> {
    let files = batch
        .sources
        .iter()
        .filter(|s| s.selected && s.reason.is_none())
        .map(Source::manifest)
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Ok(
            json!({"phase": if batch.confirmed { "terminado" } else { "resumen" }, "files": []}),
        );
    }
    // Prechecks are bounded to 5,000; a batch retains one decision.
    for part in files.chunks(5000) {
        before_request()?;
        json_request(http, origin, token, "check", Some(json!({"files": part}))).await?;
    }
    before_request()?;
    json_request(
        http,
        origin,
        token,
        "batches",
        Some(json!({"id": batch.remote_id(), "files": files})),
    )
    .await
}
/// Hashes on the blocking pool; sends one bounded chunk per turn. HEAD is the
/// authority after every restart or ambiguous PATCH response.
async fn step(
    app: &AppHandle,
    state: &DesktopState,
    mut batch: Batch,
    cursor: &mut Option<UploadCursor>,
) -> ShellResult<()> {
    authority(state, &batch)?;
    {
        let lifetime = app.state::<UploadLifetime>();
        let control = lifetime
            .control
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if control.asleep || control.manual || control.quitting {
            *cursor = None;
            return Ok(());
        }
    }
    if batch.stopped {
        if batch.started {
            json_call(
                state,
                &batch,
                &format!("batches/{}/stop", batch.remote_id()),
                Some(json!({})),
            )
            .await?;
            batch.started = false;
            if !persist_worker(app, &batch)? {
                return Ok(());
            }
        }
        return Ok(());
    }
    if batch.view["phase"] == "revisando" {
        for i in 0..batch.sources.len() {
            if batch.sources[i].selected
                && batch.sources[i].sha256.is_empty()
                && batch.sources[i].reason.is_none()
            {
                let source = batch.sources[i].clone();
                batch.sources[i] =
                    tauri::async_runtime::spawn_blocking(move || review::inspect(source))
                        .await
                        .map_err(storage)?;
                batch.view["reviewed"] = json!(i + 1);
                if !persist_worker(app, &batch)? {
                    return Ok(());
                }
            }
        }
        let (origin, token) = authority(state, &batch)?;
        let view = review_remote(&state.http, &origin, &token, &batch, || {
            authority(state, &batch).map(|_| ())
        })
        .await?;
        batch.update_view(view);
        if batch.confirmed && batch.view["phase"] == "resumen" {
            batch.view["phase"] = json!("subiendo");
        }
        if !persist_worker(app, &batch)? {
            return Ok(());
        }
        return Ok(());
    }
    if !batch.confirmed || batch.view["phase"] == "terminado" {
        return Ok(());
    }
    if !batch.started {
        if !batch
            .sources
            .iter()
            .any(|s| s.selected && s.reason.is_none())
        {
            batch.view["phase"] = json!("terminado");
            persist_worker(app, &batch)?;
            return Ok(());
        }
        let view = json_call(
            state,
            &batch,
            &format!("batches/{}/start", batch.remote_id()),
            Some(json!({"duplicates":batch.choice})),
        )
        .await?;
        batch.update_view(view);
        // A fresh manifest can reference a previously failed receipt. Reset
        // only its selected members; permanent failures are not in this manifest.
        if batch.retrying
            && batch.view["files"].as_array().is_some_and(|files| {
                files
                    .iter()
                    .any(|f| f["state"] == "fallida" && review::retryable(f))
            })
        {
            json_call(
                state,
                &batch,
                &format!("batches/{}/stop", batch.remote_id()),
                Some(json!({})),
            )
            .await?;
            let view = json_call(
                state,
                &batch,
                &format!("batches/{}/retry", batch.remote_id()),
                Some(json!({})),
            )
            .await?;
            batch.update_view(view);
        }
        batch.retrying = false;
        batch.started = true;
        if !persist_worker(app, &batch)? {
            return Ok(());
        }
    }
    let view = json_call(
        state,
        &batch,
        &format!("batches/{}", batch.remote_id()),
        None,
    )
    .await?;
    if batch.view["paused"] == "no-space" && view["phase"] == "terminado" {
        // Older nests turn a 507 into a failed item. Probe capacity before
        // retrying it; a full disk must not consume their bounded retry budget.
        if let Some(file) = view["files"]
            .as_array()
            .and_then(|files| files.iter().find(|f| f["reason"] == "sin-espacio"))
        {
            let (origin, token) = authority(state, &batch)?;
            let sha = file["sha256"]
                .as_str()
                .ok_or(ShellError::Guard("invalid-upload-reply"))?;
            let url = format!(
                "{origin}/api/uploads/batches/{}/files/{sha}",
                batch.remote_id()
            );
            let offset = head_offset(&state.http, &url, &token).await?;
            check_space(&state.http, &origin, &url, &token, offset).await?;
            batch.update_view(view);
            review::prepare_retry(&mut batch);
            persist_worker(app, &batch)?;
            return Ok(());
        }
    }
    if let Some(file) = view["files"].as_array().and_then(|files| {
        files.iter().find(|f| {
            matches!(f["state"].as_str(), Some("por-subir" | "subiendo"))
                && batch
                    .sources
                    .iter()
                    .any(|s| f["id"] == s.id && s.reason.is_some())
        })
    }) {
        let sha = file["sha256"]
            .as_str()
            .ok_or(ShellError::Guard("invalid-upload-reply"))?;
        let view = json_call(
            state,
            &batch,
            &format!("batches/{}/files/{sha}/fail", batch.remote_id()),
            Some(json!({})),
        )
        .await?;
        batch.update_view(view);
        persist_worker(app, &batch)?;
        return Ok(());
    }
    batch.update_view(view);
    if batch.view["phase"] == "terminado" {
        persist_worker(app, &batch)?;
        return Ok(());
    }
    let next = batch.view["files"]
        .as_array()
        .and_then(|files| {
            files
                .iter()
                .find(|f| matches!(f["state"].as_str(), Some("por-subir" | "subiendo")))
        })
        .cloned();
    if let Some(file) = next {
        let sha = file["sha256"]
            .as_str()
            .ok_or(ShellError::Guard("invalid-upload-reply"))?;
        let source = batch
            .sources
            .iter()
            .find(|s| s.selected && s.sha256 == sha)
            .ok_or(ShellError::Guard("upload-source-missing"))?
            .clone();
        let (origin, token) = authority(state, &batch)?;
        let url = format!(
            "{origin}/api/uploads/batches/{}/files/{sha}",
            batch.remote_id()
        );
        if cursor
            .as_ref()
            .map_or(true, |c| c.url != url || c.revision != batch.revision)
        {
            *cursor = Some(
                UploadCursor::resume(&state.http, &origin, url.clone(), &token, batch.revision)
                    .await?,
            );
        }
        let receipt = cursor.as_mut().expect("receipt initialized");
        let offset = receipt.offset;
        let chunk = receipt.chunk;
        let source_id = source.id.clone();
        let content = match tauri::async_runtime::spawn_blocking(move || {
            read_chunk_sized(&source, offset, chunk)
        })
        .await
        .map_err(storage)?
        {
            Ok(content) => content,
            Err(error) => {
                batch.set_reason(&source_id, review::read_reason(&error));
                if !persist_worker(app, &batch)? {
                    return Ok(());
                }
                let view = json_call(
                    state,
                    &batch,
                    &format!("batches/{}/files/{sha}/fail", batch.remote_id()),
                    Some(json!({})),
                )
                .await?;
                batch.update_view(view);
                persist_worker(app, &batch)?;
                return Ok(());
            }
        };
        // Re-read local intent and authority before sending a piece. Stop wins
        // against a sleeping/in-flight worker, and cannot be overwritten by it.
        let scope = Scope::new(&batch.instance, &batch.account).map_err(storage)?;
        let current = app.state::<UploadStore>().get(&scope, &batch.id)?;
        if current.stopped || current.revision != batch.revision {
            return Ok(());
        }
        authority(state, &batch)?;
        let length = content.len() as u64;
        let lifetime = app.state::<UploadLifetime>();
        let sending = lifetime.sending(
            batch.id.clone(),
            offset,
            file["bytes"].as_u64().unwrap_or(0),
        );
        batch.view["paused"] = Value::Null;
        batch.view["error"] = Value::Null;
        emit(app, &batch);
        crate::worker_tray::refresh(app);
        if let Err(error) = receipt
            .send(
                &state.http,
                &origin,
                &token,
                content,
                Some((&lifetime, lifetime::keep_awake(app))),
            )
            .await
        {
            if matches!(error.to_string().as_str(), "damaged" | "not-audio") {
                batch.set_reason(&source_id, &error.to_string());
                if !persist_worker(app, &batch)? {
                    return Ok(());
                }
                let view = json_call(
                    state,
                    &batch,
                    &format!("batches/{}/files/{sha}/fail", batch.remote_id()),
                    Some(json!({})),
                )
                .await?;
                batch.update_view(view);
                persist_worker(app, &batch)?;
                return Ok(());
            }
            return Err(error);
        }
        drop(sending);
        if let Some(files) = batch.view["files"].as_array_mut() {
            if let Some(item) = files.iter_mut().find(|f| f["sha256"] == sha) {
                item["offset"] = json!(offset + length);
            }
        }
        batch.view["current"] = file["name"].clone();
    }
    let scope = Scope::new(&batch.instance, &batch.account).map_err(storage)?;
    if !app.state::<UploadStore>().get(&scope, &batch.id)?.stopped && !persist_worker(app, &batch)?
    {
        return Ok(());
    }
    Ok(())
}
/// New sessions reconnect through HEAD and recheck capacity, including after
/// sleep, pause or an ambiguous PATCH. Successful chunks retain their receipt.
async fn resume_offset(http: &Client, origin: &str, url: &str, token: &str) -> ShellResult<u64> {
    let offset = head_offset(http, url, token).await?;
    check_space(http, origin, url, token, offset).await?;
    Ok(offset)
}
/// Older nests check space at the beginning of PATCH. An empty piece checks
/// without advancing the receipt; the next real piece still starts at HEAD.
async fn check_space(
    http: &Client,
    origin: &str,
    url: &str,
    token: &str,
    offset: u64,
) -> ShellResult<()> {
    let response = http
        .get(format!("{origin}/api/uploads/space"))
        .bearer_auth(token)
        .send()
        .await?;
    if response.status().as_u16() == 404 {
        return match send_piece(http, url, token, offset, Vec::new()).await {
            // The route checked capacity before rejecting an inactive item.
            Err(ShellError::Message(reason)) if reason == "upload-not-active" => Ok(()),
            result => result,
        };
    }
    let space = reply(response).await?;
    if space["freeBytes"].as_u64().unwrap_or(0) <= space["floorBytes"].as_u64().unwrap_or(0) {
        return Err(ShellError::Guard("no-space"));
    }
    Ok(())
}
async fn head_offset(http: &Client, url: &str, token: &str) -> ShellResult<u64> {
    let head = http.head(url).bearer_auth(token).send().await?;
    if !head.status().is_success() {
        return Err(ShellError::Guard(
            if matches!(head.status().as_u16(), 401 | 403) {
                "signed-out"
            } else {
                "nest-unreachable"
            },
        ));
    }
    head.headers()
        .get("Upload-Offset")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or(ShellError::Guard("invalid-upload-offset"))
}
async fn send_piece(
    http: &Client,
    url: &str,
    token: &str,
    offset: u64,
    content: Vec<u8>,
) -> ShellResult<()> {
    let checksum = format!("{:x}", Sha256::digest(&content));
    send_body(http, url, token, offset, checksum, content.into()).await
}
async fn send_body(
    http: &Client,
    url: &str,
    token: &str,
    offset: u64,
    checksum: String,
    content: reqwest::Body,
) -> ShellResult<()> {
    let response = http
        .patch(url)
        .bearer_auth(token)
        .header("Upload-Offset", offset)
        .header("Upload-Checksum", checksum)
        .header("Content-Type", "application/offset+octet-stream")
        .body(content)
        .send()
        .await?;
    if response.status().as_u16() != 204 {
        let status = response.status().as_u16();
        if status == 507 {
            return Err(ShellError::Guard("no-space"));
        }
        if matches!(status, 401 | 403) {
            return Err(ShellError::Guard("signed-out"));
        }
        let value: Value = response.json().await.unwrap_or(Value::Null);
        return Err(ShellError::Message(
            value["detail"]["reason"]
                .as_str()
                .map(review::server_reason)
                .unwrap_or(if status == 422 {
                    "damaged"
                } else {
                    "fallo-subida"
                })
                .into(),
        ));
    }
    Ok(())
}
#[cfg(test)]
fn read_chunk(source: &Source, offset: u64) -> ShellResult<Vec<u8>> {
    read_chunk_sized(source, offset, CHUNK)
}
fn read_chunk_sized(source: &Source, offset: u64, chunk: usize) -> ShellResult<Vec<u8>> {
    let mut file = fs::File::open(&source.path)?;
    review::unchanged(source, &file.metadata()?)?;
    if offset > source.bytes {
        return Err(ShellError::Guard("changed"));
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut content = vec![0; chunk.min((source.bytes - offset) as usize)];
    if let Err(error) = file.read_exact(&mut content) {
        review::unchanged(source, &file.metadata()?)?;
        return Err(error.into());
    }
    review::unchanged(source, &file.metadata()?)?;
    Ok(content)
}
async fn interruptible<T>(
    mut changed: tokio::sync::watch::Receiver<u64>,
    work: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! { biased; _ = changed.changed() => None, result = work => Some(result) }
}
async fn wait_for_queue(progressed: bool) {
    if !progressed {
        // Poll idle/paused queues without spinning; successful chunks run immediately.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}
fn pause_cause(error: &ShellError) -> &'static str {
    match error.to_string().as_str() {
        "signed-out" => "signed-out",
        "no-network" => "no-network",
        "no-space" | "sin-espacio" => "no-space",
        "drive-missing" => "drive-missing",
        _ => "nest-unreachable",
    }
}
pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut cursors = BTreeMap::new();
        let mut generation = app.state::<UploadLifetime>().cancellation_epoch();
        loop {
            let current_generation = app.state::<UploadLifetime>().cancellation_epoch();
            if generation != current_generation {
                cursors.clear();
            }
            // Snapshot before awaiting: a pause/wake during persistence must
            // invalidate receipts even if the send already completed.
            generation = current_generation;
            let mut progressed = false;
            let state = app.state::<DesktopState>();
            let scope = lifetime::queue_scope(&app);
            if let Some(scope) = scope {
                let batches = app.state::<UploadStore>().all(&scope).unwrap_or_default();
                for batch in batches {
                    let id = batch.id.clone();
                    let lifetime = app.state::<UploadLifetime>();
                    let cursor = cursors.entry(id.clone()).or_insert(None);
                    let before = cursor.as_ref().map(|c: &UploadCursor| c.offset);
                    let result = interruptible(
                        lifetime.changed.subscribe(),
                        step(&app, &state, batch, cursor),
                    )
                    .await;
                    if !matches!(result, Some(Ok(()))) {
                        *cursor = None;
                    } else {
                        progressed |= cursor.as_ref().map(|c| c.offset) != before;
                    }
                    let result = result.unwrap_or(Ok(()));
                    if let Err(error) = result {
                        if let Ok(mut batch) = app.state::<UploadStore>().get(&scope, &id) {
                            let cause = pause_cause(&error);
                            batch.view["paused"] = json!(cause);
                            // Keep errors local and avoid exposing credential-bearing URLs.
                            persist_worker(&app, &batch).ok();
                        }
                    }
                    if let Ok(batch) = app.state::<UploadStore>().get(&scope, &id) {
                        emit(&app, &batch);
                    }
                }
            }
            crate::worker_tray::refresh(&app);
            drain(&app);
            wait_for_queue(progressed).await;
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_worker_cannot_overwrite_stop() {
        let path = std::env::temp_dir().join(format!(
            "krobi-upload-revision-{}.sqlite",
            rand::random::<u64>()
        ));
        let store = UploadStore::open(&path).unwrap();
        let mut intent = Batch {
            id: "one".into(),
            instance: "nest".into(),
            account: "ana".into(),
            sources: vec![],
            view: json!({"phase":"subiendo"}),
            confirmed: true,
            started: true,
            choice: "use-nest".into(),
            stopped: false,
            revision: 0,
            folder: None,
            server_id: None,
            retrying: false,
        };
        store.save(&intent).unwrap();
        let worker = intent.clone();
        intent.stopped = true;
        intent.revision += 1;
        store.save(&intent).unwrap();
        assert!(!store.save_worker(&worker).unwrap());
        assert!(
            store
                .get(&Scope::new("nest", "ana").unwrap(), "one")
                .unwrap()
                .stopped
        );
        drop(store);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn ambiguous_patch_resumes_after_restart_from_server_offset_with_private_token() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/upload", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for request_no in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0u8; 1];
                while !headers.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8(headers).unwrap().to_lowercase();
                assert!(headers.contains("authorization: bearer only-rust-secret"));
                if request_no % 2 == 0 {
                    assert!(headers.starts_with("head "));
                    let offset = if request_no == 0 { 0 } else { 3 };
                    write!(socket,"HTTP/1.1 200 OK\r\nUpload-Offset: {offset}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    assert!(headers.starts_with("patch "));
                    let (offset, expected) = if request_no == 1 {
                        (0, b"0123456789".as_slice())
                    } else {
                        (3, b"3456789".as_slice())
                    };
                    assert!(headers.contains(&format!("upload-offset: {offset}")));
                    assert!(headers
                        .contains(&format!("upload-checksum: {:x}", Sha256::digest(expected))));
                    let mut body = vec![0; expected.len()];
                    socket.read_exact(&mut body).unwrap();
                    assert_eq!(body, expected);
                    // The nest committed three bytes and then the connection died.
                    if request_no == 3 {
                        socket.write_all(b"HTTP/1.1 204 No Content\r\nUpload-Offset: 10\r\nConnection: close\r\n\r\n").unwrap();
                    }
                }
            }
        });
        let dir = std::env::temp_dir().join(format!("krobi-upload-http-{}", rand::random::<u64>()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("source.wav");
        fs::write(&path, b"0123456789").unwrap();
        let source = Source {
            path: path.clone(),
            id: "one".into(),
            name: "source.wav".into(),
            sha256: hash_file(&path).unwrap().0,
            bytes: 10,
            metadata: Value::Null,
            modified: None,
            reason: None,
            selected: true,
        };
        let batch = Batch {
            id: "batch".into(),
            instance: "nest".into(),
            account: "ana".into(),
            sources: vec![source],
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
        let db = dir.join("offline.sqlite");
        UploadStore::open(&db).unwrap().save(&batch).unwrap();
        tauri::async_runtime::block_on(async {
            for attempt in 0..2 {
                let recovered = UploadStore::open(&db)
                    .unwrap()
                    .get(&Scope::new("nest", "ana").unwrap(), "batch")
                    .unwrap();
                let http = Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap();
                let offset = head_offset(&http, &url, "only-rust-secret").await.unwrap();
                assert_eq!(offset, if attempt == 0 { 0 } else { 3 });
                let bytes = read_chunk(&recovered.sources[0], offset).unwrap();
                let result = send_piece(&http, &url, "only-rust-secret", offset, bytes).await;
                assert_eq!(result.is_ok(), attempt == 1);
                let js = serde_json::to_string(&recovered.view).unwrap();
                assert!(
                    !js.contains("secret") && !js.contains("source.wav") && !js.contains("path")
                );
            }
        });
        server.join().unwrap();
        assert_eq!(fs::read(path).unwrap(), b"0123456789");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn hashes_and_streams_without_changing_source() {
        let path = std::env::temp_dir().join(format!("krobi-upload-{}", rand::random::<u64>()));
        fs::write(&path, b"abc").unwrap();
        let (sha, bytes) = hash_file(&path).unwrap();
        assert_eq!(
            sha,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let source = Source {
            path: path.clone(),
            id: "1".into(),
            name: "song".into(),
            sha256: sha,
            bytes,
            metadata: Value::Null,
            modified: None,
            reason: None,
            selected: true,
        };
        assert_eq!(read_chunk(&source, 1).unwrap(), b"bc");
        assert_eq!(fs::read(&path).unwrap(), b"abc");
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn restart_keeps_paths_and_intent_private_and_scope_isolated() {
        let path =
            std::env::temp_dir().join(format!("krobi-upload-{}.sqlite", rand::random::<u64>()));
        let batch = Batch {
            id: "batch".into(),
            instance: "nest".into(),
            account: "ana".into(),
            sources: vec![],
            view: json!({"phase":"subiendo"}),
            confirmed: true,
            started: true,
            choice: "keep-both".into(),
            stopped: false,
            revision: 0,
            folder: None,
            server_id: None,
            retrying: false,
        };
        UploadStore::open(&path).unwrap().save(&batch).unwrap();
        let recovered = UploadStore::open(&path).unwrap();
        let record = recovered
            .get(&Scope::new("nest", "ana").unwrap(), "batch")
            .unwrap();
        assert!(record.confirmed && record.started);
        assert!(recovered
            .all(&Scope::new("nest", "beto").unwrap())
            .unwrap()
            .is_empty());
        assert!(!serde_json::to_string(&record.view)
            .unwrap()
            .contains("token"));
        drop(recovered);
        fs::remove_file(path).unwrap();
    }
}
