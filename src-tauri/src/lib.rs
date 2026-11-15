mod addon_cli;
mod desktop;
mod error;
mod keep_awake;
mod login_item;
mod lyrics;
mod placement;
mod playback_activity;
mod sleep;
mod worker_tray;

use desktop::DesktopState;
use tauri::Manager;

fn log_timestamp() -> String {
    let now = tauri_plugin_log::TimezoneStrategy::UseLocal.get_now();
    let offset = now.offset().whole_seconds();
    format!(
        "[{}][{:02}:{:02}:{:02}{}{:02}:{:02}]",
        now.date(),
        now.hour(),
        now.minute(),
        now.second(),
        if offset < 0 { '-' } else { '+' },
        offset.abs() / 3600,
        offset.abs() % 3600 / 60,
    )
}

#[test]
fn app_log_timestamp_has_local_time_and_explicit_offset() {
    let before = tauri_plugin_log::TimezoneStrategy::UseLocal.get_now();
    let timestamp = log_timestamp();
    let after = tauri_plugin_log::TimezoneStrategy::UseLocal.get_now();
    assert_eq!(timestamp.len(), 28);
    let local_times = [before, after].map(|now| {
        format!(
            "[{}][{:02}:{:02}:{:02}",
            now.date(),
            now.hour(),
            now.minute(),
            now.second()
        )
    });
    assert!(local_times.iter().any(|time| timestamp.starts_with(time)));
    let offset = before.offset().whole_seconds();
    assert!(timestamp.ends_with(&format!(
        "{}{:02}:{:02}]",
        if offset < 0 { '-' } else { '+' },
        offset.abs() / 3600,
        offset.abs() % 3600 / 60,
    )));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(code) = addon_cli::launch() {
        std::process::exit(code);
    }
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("krobi-media", |context, request, responder| {
            desktop::proxy::proxy_media_request(context.app_handle().clone(), request, responder);
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if addon_cli::forward(app, &args) {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                desktop::uploads::opened(app);
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(desktop::migration::plugin())
        .plugin(
            tauri_plugin_log::Builder::default()
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "{}[{}][{}] {}",
                        log_timestamp(),
                        record.target(),
                        record.level(),
                        message
                    ));
                })
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(5 * 1024 * 1024)
                // Six archives plus the active file: seven files in total.
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(6))
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("KROBI".into()),
                    }),
                ])
                .build(),
        )
        .setup(|app| {
            desktop::migration::log_completion(app.handle());
            let state = DesktopState::new(app.handle())?;
            state.initialize_backend(app.handle());
            let should_watch = state.should_watch();
            app.manage(desktop::uploads::UploadStore::open(
                &app.path().app_data_dir()?.join("offline.sqlite"),
            )?);
            app.manage(state);
            app.manage(playback_activity::Activity::new()?);
            app.manage(desktop::uploads::UploadLifetime::new()?);
            desktop::offline::start(app.handle().clone());
            app.manage(lyrics::LyricsState::default());
            app.manage(worker_tray::TrayState::default());
            desktop::uploads::start(app.handle().clone());
            install_quit_menu(app.handle())?;
            sleep::observe(app.handle());
            desktop::mac_worker::start_monitor(app.handle().clone());
            if let Some(window) = build_main_window(app.handle()) {
                hide_native_window_buttons(&window);
                // AppKit lays the title bar out again on a resize and on the way
                // in and out of full screen, and can bring the buttons back.
                let again = window.clone();
                window.on_window_event(move |event| {
                    desktop::focus::changed(&again, event);
                    match event {
                        tauri::WindowEvent::Focused(true) => {
                            desktop::uploads::opened(again.app_handle());
                            again
                                .app_handle()
                                .state::<DesktopState>()
                                .retry_connection();
                        }
                        tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                            paths, ..
                        }) => desktop::uploads::drop_paths(again.app_handle(), paths.clone()),
                        tauri::WindowEvent::Resized(_) => hide_native_window_buttons(&again),
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            placement::remember(&again);
                            if desktop::uploads::close(again.app_handle()) {
                                api.prevent_close();
                            }
                        }
                        _ => {}
                    }
                });
            }
            if should_watch {
                desktop::nest::watch_backend(app.handle().clone());
            }
            desktop::events::start(app.handle().clone());
            addon_cli::forward(app.handle(), &std::env::args().collect::<Vec<_>>());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::desktop_bootstrap,
            desktop::bridge::bridge_invoke,
            desktop::proxy::backend_request,
            desktop::downloads::download_to_device,
            desktop::downloads::list_device_downloads,
            desktop::system::select_base_dir,
            desktop::system::open_external,
            desktop::system::open_path,
            desktop::prefs::get_theme,
            desktop::prefs::set_theme,
            desktop::player::open_player_window,
            desktop::player::send_player_state,
            desktop::player::send_player_action,
            desktop::player::send_player_play_toggle,
            desktop::player::close_player_window,
            desktop::player::request_main_show_queue,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Flipspin");

    // 0 = running, 1 = cleanup on a blocking worker, 2 = ready to exit.
    let shutdown = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
    app.run(move |app, event| {
        use std::sync::atomic::Ordering;
        if let tauri::RunEvent::ExitRequested { ref api, code, .. } = event {
            if shutdown.load(Ordering::SeqCst) == 2 {
                return;
            }
            if shutdown.load(Ordering::SeqCst) == 0
                && desktop::uploads::confirm_exit(app, code.is_some())
            {
                api.prevent_exit();
                return;
            }
            api.prevent_exit();
            if shutdown
                .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                let app = app.clone();
                let shutdown = shutdown.clone();
                // Preserve the frame while its window is still alive.
                if let Some(window) = app.get_webview_window("main") {
                    placement::remember(&window);
                }
                tauri::async_runtime::spawn_blocking(move || {
                    app.state::<desktop::uploads::UploadLifetime>().shutdown();
                    app.state::<DesktopState>().begin_shutdown();
                    app.state::<playback_activity::Activity>().shutdown();
                    // Give the helper a chance to say bye before stopping its server.
                    lyrics::agent_stop(&app.state::<lyrics::LyricsState>());
                    app.state::<DesktopState>().stop_child();
                    shutdown.store(2, Ordering::SeqCst);
                    app.exit(code.unwrap_or(0));
                });
            }
        }
    });
}

/// The main window is `"create": false` in tauri.conf.json and built here, at
/// the position `placement::initial` chose — see that module for why it cannot
/// be moved there afterwards.
fn build_main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")?
        .clone();
    let frame = placement::initial(app, (config.width, config.height));
    let mut builder = match tauri::WebviewWindowBuilder::from_config(app, &config) {
        Ok(builder) => builder,
        Err(error) => {
            log::error!("could not configure the main window: {error}");
            return None;
        }
    };
    if let Some(frame) = frame {
        builder = builder
            .inner_size(frame.width, frame.height)
            .position(frame.x, frame.y);
    } else {
        builder = builder.center();
    }
    match builder.build() {
        Ok(window) => {
            if frame.is_some_and(|frame| frame.fullscreen) {
                let _ = window.set_fullscreen(true);
            } else if frame.is_some_and(|frame| frame.maximized) {
                let _ = window.maximize();
            }
            Some(window)
        }
        Err(error) => {
            log::error!("could not create the main window: {error}");
            None
        }
    }
}

/// The renderer draws the main window's buttons in the app's own style
/// (`renderer/src/shell/layout/WindowControls.tsx`), so AppKit's are
/// hidden. Hidden, not removed: the window keeps its full style mask, so it
/// still has rounded corners, a shadow, edge resizing, ⌘M and full screen —
/// which is why this is not `decorations: false`.
#[cfg(target_os = "macos")]
fn hide_native_window_buttons(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    // SAFETY: Tauri hands out the live NSWindow behind this webview window, and
    // both call sites (setup, window events) run on the main thread.
    let ns_window: &NSWindow = unsafe { &*pointer.cast() };
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn hide_native_window_buttons(_window: &tauri::WebviewWindow) {}

/// AppKit's predefined Quit calls terminate: directly. A normal menu action
/// funnels both Command-Q and the tray through the cancellable exit handler.
#[cfg(target_os = "macos")]
fn install_quit_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    use tauri::menu::{PredefinedMenuItem, Submenu};
    use tauri::Emitter;
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(application)) = menu.items()?.first() {
        let count = application.items()?.len();
        application.remove_at(count - 1)?;
        application.append(&MenuItem::with_id(
            app,
            "krobi-quit",
            "Quit Flipspin",
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    let sidebar = MenuItem::with_id(
        app,
        "toggle-sidebar",
        "Toggle Sidebar",
        true,
        Some("CmdOrCtrl+\\"),
    )?;
    let side_column = MenuItem::with_id(
        app,
        "toggle-side-column",
        "Toggle Side Column",
        true,
        Some("Alt+CmdOrCtrl+\\"),
    )?;
    let items = menu.items()?;
    let mut view = None;
    let mut after_edit = items.len();
    for (index, item) in items.iter().enumerate() {
        if let MenuItemKind::Submenu(submenu) = item {
            match submenu.text()?.as_str() {
                "View" => view = Some(submenu.clone()),
                "Edit" => after_edit = index + 1,
                _ => {}
            }
        }
    }
    if let Some(view) = view {
        view.prepend_items(&[&sidebar, &side_column, &PredefinedMenuItem::separator(app)?])?;
    } else {
        menu.insert(
            &Submenu::with_items(app, "View", true, &[&sidebar, &side_column])?,
            after_edit,
        )?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id.as_ref() == "krobi-quit" {
            app.exit(0);
        }
        if matches!(event.id.as_ref(), "toggle-sidebar" | "toggle-side-column") {
            let _ = app.emit_to("main", "view:command", event.id.as_ref());
        }
    });
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn install_quit_menu(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
