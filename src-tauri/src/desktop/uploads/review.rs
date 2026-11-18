//! Presentation fields stay local; upload manifests exclude them.
use super::*;
use std::collections::{HashMap, HashSet};

pub(super) fn selected() -> bool {
    true
}

pub(super) fn folder_label(path: &Path, home: Option<&Path>) -> String {
    if let Some(relative) = home.and_then(|home| path.strip_prefix(home).ok()) {
        if relative.components().count() <= 2 {
            return if relative.as_os_str().is_empty() {
                "~".into()
            } else {
                format!("~/{}", relative.to_string_lossy())
            };
        }
    }
    let parts = path.components().rev().take(2).collect::<Vec<_>>();
    parts
        .iter()
        .rev()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

pub(super) fn server_reason(reason: &str) -> &str {
    match reason {
        "no-es-audio" => "not-audio",
        "archivo-danado" => "damaged",
        other => other,
    }
}

pub(super) fn retryable(file: &Value) -> bool {
    file["state"] == "fallida"
        && matches!(
            file["reason"].as_str(),
            Some("changed" | "unreadable" | "sin-espacio" | "fallo-subida")
        )
}

impl Batch {
    pub(super) fn remote_id(&self) -> &str {
        self.server_id.as_deref().unwrap_or(&self.id)
    }

    pub(super) fn display_view(&self) -> Value {
        let mut view = self.view.clone();
        view["id"] = json!(self.id);
        view["folder"] = json!(self.folder);
        let mut files = view["files"].as_array().cloned().unwrap_or_default();
        for file in &mut files {
            if let Some(reason) = file["reason"].as_str() {
                file["reason"] = json!(server_reason(reason));
            }
        }
        let positions = files
            .iter()
            .enumerate()
            .filter_map(|(index, file)| file["id"].as_str().map(|id| (id.to_owned(), index)))
            .collect::<HashMap<_, _>>();
        for source in &self.sources {
            if let Some(reason) = &source.reason {
                let file = json!({"id": source.id, "name": source.name, "sha256": source.sha256,
                    "bytes": source.bytes, "offset": 0, "duplicate": false,
                    "state": if reason == "not-audio" { "no-apta" } else { "fallida" }, "reason": reason});
                if let Some(index) = positions.get(&source.id) {
                    files[*index] = file;
                } else {
                    files.push(file);
                }
            }
        }
        view["files"] = json!(files);
        view
    }

    pub(super) fn update_view(&mut self, mut view: Value) {
        let mut files = view["files"].as_array().cloned().unwrap_or_default();
        // Retry manifests contain only selected items; the local summary preserves
        // successes and permanent failures omitted from the server response.
        let unselected = self
            .sources
            .iter()
            .filter(|s| !s.selected)
            .map(|s| s.id.as_str())
            .collect::<HashSet<_>>();
        if !unselected.is_empty() {
            let existing = files
                .iter()
                .filter_map(|f| f["id"].as_str().map(str::to_owned))
                .collect::<HashSet<_>>();
            if let Some(previous) = self.view["files"].as_array() {
                for file in previous {
                    if file["id"]
                        .as_str()
                        .is_some_and(|id| unselected.contains(id) && !existing.contains(id))
                    {
                        files.push(file.clone());
                    }
                }
            }
        }
        view["files"] = json!(files);
        self.view = view;
        self.view = self.display_view();
    }

    pub(super) fn set_reason(&mut self, id: &str, reason: &str) {
        if let Some(source) = self.sources.iter_mut().find(|s| s.id == id) {
            source.reason = Some(reason.into());
        }
    }
}

pub(super) fn prepare_retry(batch: &mut Batch) -> bool {
    let view = batch.display_view();
    let files = view["files"].as_array().cloned().unwrap_or_default();
    let selected = files
        .iter()
        .filter(|f| retryable(f))
        .filter_map(|f| f["id"].as_str())
        .collect::<HashSet<_>>();
    if selected.is_empty() {
        return false;
    }
    for source in &mut batch.sources {
        source.selected = selected.contains(source.id.as_str());
        if source.selected {
            source.sha256.clear();
            source.modified = None;
            source.reason = None;
        }
    }
    let mut files = files;
    for file in &mut files {
        if retryable(file) {
            file["reason"] = Value::Null;
            file["state"] = json!("por-subir");
            file["offset"] = json!(0);
        }
    }
    batch.view["files"] = json!(files);
    batch.view["phase"] = json!("revisando");
    batch.view["reviewed"] = json!(0);
    batch.view["total"] = json!(batch.sources.len());
    batch.view["paused"] = Value::Null;
    batch.view["error"] = Value::Null;
    batch.stopped = false;
    batch.confirmed = true;
    batch.started = false;
    batch.retrying = true;
    batch.server_id = Some(format!("upload-{:016x}", rand::random::<u64>()));
    true
}

pub(super) fn unchanged(source: &Source, metadata: &fs::Metadata) -> ShellResult<()> {
    if metadata.len() != source.bytes
        || source
            .modified
            .is_some_and(|time| metadata.modified().ok() != Some(time))
    {
        return Err(ShellError::Guard("changed"));
    }
    Ok(())
}

pub(super) fn read_reason(error: &ShellError) -> &'static str {
    if error.to_string() == "changed" {
        "changed"
    } else {
        "unreadable"
    }
}

pub(super) fn inspect(mut source: Source) -> Source {
    let result = (|| -> ShellResult<()> {
        let metadata = fs::metadata(&source.path)?;
        source.bytes = metadata.len();
        source.modified = Some(metadata.modified()?);
        let (sha, bytes) = hash_file(&source.path)?;
        unchanged(&source, &fs::metadata(&source.path)?)?;
        if bytes != source.bytes {
            return Err(ShellError::Guard("changed"));
        }
        source.sha256 = sha;
        // Audio detection uses bytes rather than filenames; recognized files reach
        // the authoritative server decoder even when local decoding fails.
        let mut reader = std::io::BufReader::new(fs::File::open(&source.path)?);
        let mut signature = [0; 16];
        let count = reader.read(&mut signature)?;
        reader.rewind()?;
        // ASF/WMA is accepted by the server, but has no Lofty reader.
        let asf = count == 16
            && signature
                == [
                    0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00,
                    0x62, 0xce, 0x6c,
                ];
        let probe = lofty::probe::Probe::new(reader).guess_file_type()?;
        if probe.file_type().is_none() && !asf {
            return Err(ShellError::Guard("not-audio"));
        }
        source.metadata = lofty::read_from_path(&source.path)
            .ok()
            .map(|audio| {
                let tag = audio.primary_tag().or_else(|| audio.first_tag());
                json!({"title":tag.and_then(|t|t.title()).map(|s|s.into_owned()),
                "artist":tag.and_then(|t|t.artist()).map(|s|s.into_owned()),
                "duration_s":audio.properties().duration().as_secs_f64()})
            })
            .unwrap_or(Value::Null);
        unchanged(&source, &fs::metadata(&source.path)?)
    })();
    source.reason = result.err().map(|error| {
        if error.to_string() == "not-audio" {
            "not-audio"
        } else {
            read_reason(&error)
        }
        .into()
    });
    source
}
