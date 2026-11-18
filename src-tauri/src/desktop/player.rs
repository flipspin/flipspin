//! The detached player window and the state relayed between it and "main".

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use super::*;

#[tauri::command]
pub fn open_player_window(
    app: AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> ShellResult<()> {
    if let Some(window) = app.get_webview_window("player") {
        window.set_focus()?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        &app,
        "player",
        WebviewUrl::App("index.html?window=player".into()),
    )
    .title("Flipspin Player")
    .inner_size(280.0, 405.0)
    .min_inner_size(280.0, 405.0)
    .resizable(false)
    .build()?;
    if let Some(payload) = state.runtime()?.last_player_state.clone() {
        let _ = window.emit("player-state", payload);
    }
    Ok(())
}

/// The main window's snapshot for the player window: the current track, the
/// flags it draws, and the whole queue. Kept as `last_player_state` so a player
/// window opened later starts from it (`open_player_window`), and forwarded
/// only while that window exists — serializing a ~650-song queue towards a
/// window that is not there is work nobody sees.
#[tauri::command]
pub fn send_player_state(app: AppHandle, state: tauri::State<'_, DesktopState>, payload: Value) {
    if app.get_webview_window("player").is_some() {
        let _ = app.emit_to("player", "player-state", payload.clone());
    }
    let scope = super::offline::scope(&state.runtime_or_panic()).ok();
    if let Ok(mut offline) = lock(&state.offline, "offline") {
        if let Some(scope) = scope {
            let track = &payload["selectedTrack"];
            let key = super::offline::player_track_key(track);
            if let Some(key) = key {
                offline.store.set_playing(&scope, &key);
            } else {
                offline.store.stop_playing();
            }
        } else {
            offline.store.stop_playing();
        }
        let _ = offline.store.sweep_pending();
    }
    state.runtime_or_panic().last_player_state = Some(payload);
}

#[tauri::command]
pub fn send_player_action(app: AppHandle, payload: Value) {
    let _ = app.emit_to("main", "player-action-to-main", payload);
}

#[tauri::command]
pub fn send_player_play_toggle(app: AppHandle) {
    let _ = app.emit_to("main", "player-play-toggle", ());
}

#[tauri::command]
pub fn close_player_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("player") {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn request_main_show_queue(app: AppHandle) {
    let _ = app.emit_to("main", "show-queue", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}
