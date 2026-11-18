//! A native, template menu-bar figure. Its menu and settings use the same switch.
use serde_json::Value;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

#[derive(Default)]
pub(crate) struct TrayState {
    queue: Mutex<TrayQueue>,
}

struct TrayUpdate {
    signature: String,
    status: Value,
    line: String,
    english: bool,
}

/// One main-thread drain owns all mutations; callers only replace its next snapshot.
#[derive(Default)]
struct TrayQueue {
    last: Option<String>,
    pending: Option<TrayUpdate>,
    in_flight: Option<String>,
    scheduled: bool,
}

impl TrayQueue {
    fn enqueue(&mut self, update: TrayUpdate) -> bool {
        let latest = self
            .pending
            .as_ref()
            .map(|pending| &pending.signature)
            .or(self.in_flight.as_ref())
            .or(self.last.as_ref());
        if latest != Some(&update.signature) {
            self.pending = Some(update);
        }
        // A failed dispatch leaves pending intact, so even an identical poll retries.
        if !self.scheduled && self.pending.is_some() {
            self.scheduled = true;
            return true;
        }
        false
    }

    fn next(&mut self) -> Option<TrayUpdate> {
        let update = self.pending.take();
        self.in_flight = update.as_ref().map(|update| update.signature.clone());
        if update.is_none() {
            self.scheduled = false;
        }
        update
    }

    fn finish(&mut self, update: TrayUpdate, succeeded: bool) {
        // An error may follow a partial mutation. Invalidate last so it is retried.
        self.last = succeeded.then_some(update.signature);
        self.in_flight = None;
    }
}

pub(crate) fn state_line(status: &Value, english: bool) -> String {
    let text = |es: &str, en: &str| {
        if english {
            en.to_string()
        } else {
            es.to_string()
        }
    };
    let error = status["workerError"]
        .as_str()
        .or_else(|| status["local"]["lastError"].as_str());
    match error {
        Some("token-rejected") => return text("Credencial rechazada", "Credential rejected"),
        Some("network-denied") => {
            return text("Sin permiso de red", "Local Network permission denied")
        }
        Some("replaced") => {
            return text(
                "Otra Mac trabaja para el nido",
                "Another Mac works for the nest",
            )
        }
        _ => {}
    }
    if status["installing"]["phase"] == "updating" {
        return text("Actualizando el motor…", "Updating the engine…");
    }
    if !status["installing"].is_null() {
        return text("Instalando el motor…", "Installing the engine…");
    }
    if status["agentRunning"] != true {
        return text("Sin conexión", "Offline");
    }
    if status["local"]["connected"] != true {
        return text("Sin conexión", "Offline");
    }
    let worker = &status["worker"];
    if worker["id"] == status["workerId"] {
        match worker["state"].as_str() {
            Some("outdated") => return text("Desactualizado", "Outdated"),
            Some("asleep") => return text("Dormido", "Asleep"),
            Some("closed") => return text("Flipspin cerrado", "Flipspin closed"),
            Some("offline") => return text("Sin conexión", "Offline"),
            _ => {}
        }
    }
    if worker["id"] == status["workerId"] && worker["state"] == "working" {
        let mut line = text("Trabajando", "Working");
        for field in ["title", "phase"] {
            if let Some(value) = worker["job"][field].as_str() {
                line.push_str(" · ");
                line.push_str(if field == "phase" {
                    phase_word(value, english)
                } else {
                    value
                });
            }
        }
        return line;
    }
    text("Libre", "Idle")
}

/// Same protocol vocabulary as renderer's enginePhase; song titles stay intact.
fn phase_word(phase: &str, english: bool) -> &str {
    let (es, en) = match phase {
        "queued" | "en cola" => ("en cola", "queued"),
        "claimed" => ("preparando…", "preparing…"),
        "decoding" | "decodificando" => ("decodificando", "decoding"),
        "separating" => ("separando pistas", "separating stems"),
        "beats" | "ritmo" => ("detectando el ritmo", "detecting beats"),
        "chops" | "cortando" => ("cortando", "cutting"),
        "encoding" | "codificando" => ("codificando", "encoding"),
        "uploading" | "subiendo" => ("subiendo", "uploading"),
        "separando" => ("separando la voz", "separating vocals"),
        "transcribiendo" => ("transcribiendo", "transcribing"),
        "alineando" => ("alineando", "aligning"),
        "guardando" => ("guardando", "saving"),
        "entorno" => ("creando el entorno", "creating the environment"),
        "paquetes" => ("instalando paquetes", "installing packages"),
        "modelos" => ("descargando modelos", "downloading models"),
        _ => (phase, phase),
    };
    if english {
        en
    } else {
        es
    }
}

pub(crate) fn refresh(app: &AppHandle) {
    let mut status = crate::lyrics::status(app, &app.state::<crate::lyrics::LyricsState>());
    let english = crate::desktop::mac_worker::language(app) == "en";
    let upload = crate::desktop::uploads::summary(app);
    let uploading = upload["active"] == true && upload["keepAwake"] == true;
    let line = if uploading {
        format!("Uploading music · {}%", upload["percent"])
    } else {
        state_line(&status, english)
    };
    status["upload"] = upload;
    let signature = format!(
        "{line}:{english}:{}:{}:{}:{}",
        status["enabled"], status["tray"], status["eligible"], status["upload"]
    );
    let state = app.state::<TrayState>();
    let should_dispatch = {
        let Ok(mut queue) = state.queue.lock() else {
            return;
        };
        queue.enqueue(TrayUpdate {
            signature,
            status,
            line,
            english,
        })
    };
    if should_dispatch {
        let main_app = app.clone();
        // Do not hold the queue lock: Tauri can execute this inline on the main thread.
        if let Err(error) = app.run_on_main_thread(move || drain(&main_app)) {
            if let Ok(mut queue) = state.queue.lock() {
                queue.scheduled = false;
            }
            log::warn!("worker tray dispatch: {error}");
        }
    }
}

/// Called only by refresh's run_on_main_thread closure. No native handles escape.
fn drain(app: &AppHandle) {
    let state = app.state::<TrayState>();
    loop {
        let request = {
            let Ok(mut queue) = state.queue.lock() else {
                return;
            };
            let Some(request) = queue.next() else {
                return;
            };
            request
        };
        // AppKit can reenter while tracking a menu; never hold the queue lock here.
        let result = update(app, &request.status, &request.line, request.english);
        if let Ok(mut queue) = state.queue.lock() {
            queue.finish(request, result.is_ok());
        }
        if let Err(error) = result {
            log::warn!("worker tray: {error}");
        }
    }
}

/// The playback rows: (menu id, the `player:command` the main window gets, Spanish, English).
const PLAYER_ITEMS: [(&str, &str, &str, &str); 3] = [
    (
        "player-toggle",
        "toggle",
        "Reproducir o pausar",
        "Play/Pause",
    ),
    ("player-next", "next", "Siguiente", "Next"),
    ("player-previous", "previous", "Anterior", "Previous"),
];

fn menu_words(line: &str, english: bool) -> [String; 4] {
    [
        line.to_string(),
        if english {
            "Work for the nest"
        } else {
            "Trabajar para el nido"
        }
        .into(),
        if english {
            "Open Flipspin"
        } else {
            "Abrir Flipspin"
        }
        .into(),
        if english { "Quit" } else { "Salir" }.into(),
    ]
}

fn update(app: &AppHandle, status: &Value, line: &str, english: bool) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    debug_assert!(objc2::MainThreadMarker::new().is_some());

    let upload = &status["upload"];
    let uploading = upload["active"] == true && upload["keepAwake"] == true;
    if !uploading && (status["tray"] == false || status["eligible"] != true) {
        // The returned handle (and its NSStatusItem) must also be dropped here.
        app.remove_tray_by_id("mac-worker");
        return Ok(());
    }
    let words = menu_words(line, english);
    let state = MenuItem::with_id(app, "worker-state", &words[0], false, None::<&str>)?;
    let toggle = CheckMenuItem::with_id(
        app,
        "worker-toggle",
        &words[1],
        true,
        status["enabled"] == true,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "worker-open", &words[2], true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "worker-quit", "Quit Flipspin", true, None::<&str>)?;
    let upload_toggle = MenuItem::with_id(
        app,
        "upload-pause",
        if upload["manual"] == true {
            "Resume upload"
        } else {
            "Pause upload"
        },
        uploading,
        None::<&str>,
    )?;
    let awake = MenuItem::with_id(
        app,
        "upload-awake",
        if upload["awake"] == true {
            "Keeping this computer awake"
        } else if upload["awake"] == "unsupported" {
            "Sleep not blocked"
        } else {
            "Upload paused or waiting"
        },
        false,
        None::<&str>,
    )?;
    let drain = MenuItem::with_id(
        app,
        "upload-drain",
        "Quits when the upload is done",
        false,
        None::<&str>,
    )?;
    let player = PLAYER_ITEMS
        .iter()
        .map(|(id, _, es, en)| {
            MenuItem::with_id(app, *id, if english { en } else { es }, true, None::<&str>)
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let menu = Menu::new(app)?;
    menu.append_items(&[&player[0], &player[1], &player[2], &sep_a, &state])?;
    if uploading {
        menu.append_items(&[&awake, &upload_toggle, &drain])?;
    }
    if status["eligible"] == true {
        menu.append(&toggle)?;
    }
    menu.append_items(&[&sep_b, &open, &quit])?;
    let title = uploading.then(|| format!("{}%", upload["percent"]));
    if let Some(tray) = app.tray_by_id("mac-worker") {
        tray.set_menu(Some(menu))?;
        tray.set_tooltip(Some(line))?;
        tray.set_title(title.as_deref())?;
    } else {
        TrayIconBuilder::with_id("mac-worker")
            .icon(tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-template.png"
            ))?)
            .icon_as_template(true)
            .tooltip(line)
            .title(title.as_deref().unwrap_or(""))
            .menu(&menu)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "worker-toggle" => {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        let on = crate::desktop::mac_worker::settings(&app)["enabled"] != true;
                        if let Err(error) = crate::desktop::mac_worker::change(&app, Some(on)) {
                            crate::desktop::mac_worker::set_error(&app, Some(error.to_string()));
                        }
                        refresh(&app);
                    });
                }
                "upload-pause" => {
                    let paused = crate::desktop::uploads::summary(app)["manual"] != true;
                    crate::desktop::uploads::pause(app, paused);
                }
                "worker-open" => {
                    crate::desktop::uploads::opened(app);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "worker-quit" => app.exit(0),
                id => {
                    if let Some((_, command, _, _)) = PLAYER_ITEMS.iter().find(|item| item.0 == id)
                    {
                        let _ = app.emit_to("main", "player:command", *command);
                    }
                }
            })
            .build(app)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(signature: &str) -> TrayUpdate {
        TrayUpdate {
            signature: signature.into(),
            status: Value::Null,
            line: String::new(),
            english: false,
        }
    }

    #[test]
    fn unchanged_polls_dispatch_once_and_pending_changes_coalesce() {
        let mut queue = TrayQueue::default();
        assert!(queue.enqueue(request("visible")));
        for _ in 0..10 {
            assert!(!queue.enqueue(request("visible")));
        }
        // A preference change before the main thread runs supersedes the old snapshot.
        assert!(!queue.enqueue(request("hidden")));
        let update = queue.next().unwrap();
        assert_eq!(update.signature, "hidden");
        assert!(!queue.enqueue(request("hidden")));
        queue.finish(update, true);
        assert!(queue.next().is_none());
        assert!(!queue.enqueue(request("hidden")));
    }

    #[test]
    fn changes_during_update_are_not_lost_even_when_returning_to_last() {
        let mut queue = TrayQueue::default();
        assert!(queue.enqueue(request("visible")));
        let update = queue.next().unwrap();
        queue.finish(update, true);
        assert!(queue.next().is_none());

        assert!(queue.enqueue(request("hidden")));
        let update = queue.next().unwrap();
        assert!(!queue.enqueue(request("visible")));
        queue.finish(update, true);
        let update = queue.next().unwrap();
        assert_eq!(update.signature, "visible");
        queue.finish(update, true);
        assert!(queue.next().is_none());
        assert!(!queue.enqueue(request("visible")));
    }

    #[test]
    fn failed_update_retries_and_invalidates_a_partially_changed_tray() {
        let mut queue = TrayQueue::default();
        assert!(queue.enqueue(request("old tooltip")));
        let update = queue.next().unwrap();
        queue.finish(update, true);
        assert!(queue.next().is_none());

        assert!(queue.enqueue(request("new tooltip")));
        let update = queue.next().unwrap();
        queue.finish(update, false);
        assert!(queue.next().is_none());
        assert!(queue.enqueue(request("new tooltip")));
        let update = queue.next().unwrap();
        queue.finish(update, false);
        assert!(queue.next().is_none());
        // set_menu may have succeeded before set_tooltip failed: old is no longer cached.
        assert!(queue.enqueue(request("old tooltip")));
    }

    #[test]
    fn failed_dispatch_retries_the_latest_snapshot() {
        let mut queue = TrayQueue::default();
        assert!(queue.enqueue(request("visible")));
        // Another caller arrives while the dispatch is in progress.
        assert!(!queue.enqueue(request("hidden")));
        queue.scheduled = false; // run_on_main_thread returned an error.
        assert!(queue.enqueue(request("hidden")));
        let update = queue.next().unwrap();
        assert_eq!(update.signature, "hidden");
        queue.finish(update, true);
        assert!(queue.next().is_none());
        assert!(!queue.enqueue(request("hidden")));
    }

    #[test]
    fn dump_menu_labels_from_the_native_menu_builder() {
        for english in [false, true] {
            let s = json!({"installing": null, "agentRunning": true, "local": {"connected": true}, "workerId": "ours",
                "worker": {"id": "ours", "state": "working", "job": {"title": "Triple Lavada", "phase": "alineando"}}});
            let line = state_line(&s, english);
            let words = menu_words(&line, english);
            println!(
                "Native menu labels, language={}:\n{}",
                if english { "en" } else { "es" },
                words.join("\n")
            );
            assert_eq!(words.len(), 4);
        }
    }

    #[test]
    fn tray_names_local_errors_and_only_our_job() {
        for (error, es, en) in [
            (
                "token-rejected",
                "Credencial rechazada",
                "Credential rejected",
            ),
            (
                "network-denied",
                "Sin permiso de red",
                "Local Network permission denied",
            ),
            (
                "replaced",
                "Otra Mac trabaja para el nido",
                "Another Mac works for the nest",
            ),
        ] {
            let s = json!({"local": {"lastError": error}});
            assert_eq!(state_line(&s, false), es);
            assert_eq!(state_line(&s, true), en);
        }
        let mut s = json!({"installing": null, "agentRunning": true, "local": {"connected": true}, "workerId": "ours",
            "worker": {"id": "ours", "state": "working", "job": {"title": "Song", "phase": "alineando"}}});
        assert_eq!(state_line(&s, false), "Trabajando · Song · alineando");
        assert_eq!(state_line(&s, true), "Working · Song · aligning");
        s["worker"]["id"] = json!("other");
        assert_eq!(state_line(&s, false), "Libre");
    }
}
