//! Main-window foreground state. The detached player never wakes data checks.
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};

fn foreground(label: &str, focused: bool, visible: bool, minimized: bool) -> bool {
    label == "main" && focused && visible && !minimized
}

pub(crate) fn current(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        foreground(
            window.label(),
            window.is_focused().unwrap_or(false),
            window.is_visible().unwrap_or(false),
            window.is_minimized().unwrap_or(true),
        )
    })
}

pub(crate) fn changed(window: &WebviewWindow, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let focused = match event {
        WindowEvent::Focused(value) => Some(foreground(
            window.label(),
            *value,
            window.is_visible().unwrap_or(false),
            window.is_minimized().unwrap_or(true),
        )),
        WindowEvent::Resized(_) => Some(current(window.app_handle())),
        _ => None,
    };
    if let Some(focused) = focused {
        let _ = window.app_handle().emit("window:focus", focused);
    }
}

#[cfg(test)]
mod tests {
    use super::foreground;

    #[test]
    fn only_the_visible_focused_main_window_is_foreground() {
        assert!(foreground("main", true, true, false));
        assert!(!foreground("main", false, true, false));
        assert!(!foreground("main", true, false, false));
        assert!(!foreground("main", true, true, true));
        assert!(!foreground("player", true, true, false));
    }
}
