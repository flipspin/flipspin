//! Create the window on the chosen display before showing it to avoid Space switches.
//! Restore its saved frame, or center on a free display near the pointer.
//! Persist logical points: mixed-DPI displays use different physical scale factors.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::desktop::prefs::{atomic_json, read_json};

/// Of a saved frame, at least this much (points) must land on a connected
/// monitor to reuse it — enough to see and grab the title bar.
const MIN_VISIBLE: (f64, f64) = (120.0, 60.0);

#[derive(Serialize, Deserialize, Clone, Copy, Default, PartialEq, Debug)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
    /// Closed in full screen: open in full screen again, on `display`. The
    /// frame above is then the windowed one macOS returns to on exit.
    #[serde(default)]
    pub fullscreen: bool,
    /// The display (full bounds, points) it was full screen on.
    #[serde(default)]
    display: Option<Rect>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("window.json"))
}

/// Choose the saved frame, pointer display, or another free display, in points.
/// Avoid displays occupied by full-screen apps unless restoring this window
/// to its own full-screen Space. None leaves centering to Tauri.
pub fn initial(app: &AppHandle, size: (f64, f64)) -> Option<Frame> {
    let screens = screens(app).unwrap_or_default();
    let free: Vec<Rect> = screens
        .iter()
        .filter(|s| !s.full_screen_app)
        .map(|s| s.work)
        .collect();
    let saved: Option<Frame> = state_path(app)
        .map(|path| read_json(&path))
        .filter(|frame: &Frame| frame.width > 0.0 && frame.height > 0.0);
    if let Some(frame) = saved.filter(|frame| frame.fullscreen) {
        let display = frame
            .display
            .and_then(|display| screens.iter().find(|s| same(s.bounds, display)));
        if let Some(screen) = display {
            let frame = Frame {
                maximized: false,
                ..onto(frame, screen.work)
            };
            log::info!("main window: full screen again on {:?}", screen.bounds);
            return Some(frame);
        }
    }
    let fullscreen = saved.is_some_and(|frame| frame.fullscreen);
    if let Some(frame) = saved.filter(|frame| !frame.fullscreen && fits(frame, &free)) {
        log::info!("main window: last position {frame:?}");
        return Some(frame);
    }
    let pointer = match pointer_screen(app) {
        Ok(found) => found,
        Err(error) => {
            log::warn!("main window: could not find the pointer's screen: {error}");
            None
        }
    };
    let screen = pointer
        .filter(|screen| free.contains(screen))
        .or_else(|| free.first().copied())?;
    // A first launch on a small or highly scaled screen must not run under the
    // taskbar or Dock: fit the default size to the work area, title bar included.
    let (width, height) = fitted(size, screen);
    let (x, y) = centered(screen, width, height);
    log::info!(
        "main window: centered on {screen:?} (pointer on {pointer:?}, {} of {} screens free)",
        free.len(),
        screens.len()
    );
    Some(Frame {
        x,
        y,
        width,
        height,
        fullscreen,
        ..Frame::default()
    })
}

/// Window chrome the inner size does not include (title bar and borders).
const CHROME: f64 = if cfg!(target_os = "macos") { 28.0 } else { 40.0 };

/// The default inner size, shrunk to fit inside `screen` with its chrome.
fn fitted(size: (f64, f64), screen: Rect) -> (f64, f64) {
    (size.0.min(screen.width), size.1.min(screen.height - CHROME).max(1.0))
}

/// `frame` if it already sits on `screen`, else the same size centered there.
fn onto(frame: Frame, screen: Rect) -> Frame {
    if fits(&frame, &[screen]) {
        return frame;
    }
    let width = frame.width.min(screen.width);
    let height = frame.height.min(screen.height);
    let (x, y) = centered(screen, width, height);
    Frame {
        x,
        y,
        width,
        height,
        ..frame
    }
}

/// Saved when the window closes or the app quits. A minimized window says
/// nothing about where it lives, so the last frame is kept. A maximized one
/// keeps its previous frame and records the flag; a full-screen one keeps its
/// previous windowed frame, moved onto the display it is full screen on, and
/// records that display.
pub fn remember(window: &WebviewWindow) {
    let Some(path) = state_path(window.app_handle()) else {
        return;
    };
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    let previous = Frame {
        fullscreen: false,
        display: None,
        ..read_json::<Frame>(&path)
    };
    let frame = if window.is_fullscreen().unwrap_or(false) {
        let Some(monitor) = window.current_monitor().ok().flatten() else {
            return;
        };
        let previous = if previous.width > 0.0 {
            previous
        } else {
            let size = window
                .app_handle()
                .config()
                .app
                .windows
                .first()
                .map(|w| (w.width, w.height))
                .unwrap_or((1200.0, 800.0));
            Frame {
                width: size.0,
                height: size.1,
                ..previous
            }
        };
        Frame {
            fullscreen: true,
            display: Some(full_bounds(&monitor)),
            ..onto(previous, work_area(&monitor))
        }
    } else if window.is_maximized().unwrap_or(false) {
        Frame {
            maximized: true,
            ..previous
        }
    } else {
        match current_frame(window) {
            Ok(frame) => frame,
            Err(error) => {
                log::warn!("could not read the main window's frame: {error}");
                return;
            }
        }
    };
    if let Err(error) = atomic_json(&path, &frame, false) {
        log::warn!("could not save the main window's frame: {error}");
    }
}

fn current_frame(window: &WebviewWindow) -> tauri::Result<Frame> {
    let scale = window.scale_factor()?;
    let position = window.outer_position()?.to_logical::<f64>(scale);
    let size = window.inner_size()?.to_logical::<f64>(scale);
    Ok(Frame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        ..Frame::default()
    })
}

/// Each connected monitor's work area (menu bar and Dock excluded), in points.
struct Screen {
    work: Rect,
    bounds: Rect,
    full_screen_app: bool,
}

fn screens(app: &AppHandle) -> tauri::Result<Vec<Screen>> {
    let monitors = app.available_monitors()?;
    let bounds: Vec<Rect> = monitors.iter().map(full_bounds).collect();
    let covered = full_screen_displays(&bounds);
    Ok(monitors
        .iter()
        .zip(bounds.iter().zip(covered))
        .map(|(monitor, (bounds, full_screen_app))| Screen {
            work: work_area(monitor),
            bounds: *bounds,
            full_screen_app,
        })
        .collect())
}

fn full_bounds(monitor: &tauri::Monitor) -> Rect {
    let scale = monitor.scale_factor();
    Rect {
        x: monitor.position().x as f64 / scale,
        y: monitor.position().y as f64 / scale,
        width: monitor.size().width as f64 / scale,
        height: monitor.size().height as f64 / scale,
    }
}

/// For each display (full bounds, points), whether another app's window covers
/// it exactly — what a full-screen app looks like from outside. Window bounds
/// and owners need no Screen Recording permission; only titles would.
#[cfg(target_os = "macos")]
fn full_screen_displays(displays: &[Rect]) -> Vec<bool> {
    use core_foundation::{
        base::{CFType, TCFType},
        dictionary::{CFDictionary, CFDictionaryRef},
        number::CFNumber,
        string::CFString,
    };
    use core_graphics::window::{
        copy_window_info, kCGNullWindowID, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
    };

    let mut covered = vec![false; displays.len()];
    let Some(list) = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    ) else {
        return covered;
    };
    let me = i64::from(std::process::id());
    let number = |dict: &CFDictionary<CFString, CFType>, key: &'static str| -> Option<f64> {
        dict.find(CFString::from_static_string(key))?
            .downcast::<CFNumber>()?
            .to_f64()
    };
    for item in list.iter() {
        // SAFETY: every element of CGWindowListCopyWindowInfo is a CFDictionary
        // with CFString keys, alive as long as `list`.
        let window: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*item as CFDictionaryRef) };
        if number(&window, "kCGWindowLayer") != Some(0.0)
            || number(&window, "kCGWindowOwnerPID").map(|pid| pid as i64) == Some(me)
        {
            continue;
        }
        let Some(bounds) = window
            .find(CFString::from_static_string("kCGWindowBounds"))
            .and_then(|value| value.downcast::<CFDictionary>())
        else {
            continue;
        };
        // SAFETY: kCGWindowBounds is a CFDictionary of CFString → CFNumber.
        let bounds: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
        let (Some(x), Some(y), Some(width), Some(height)) = (
            number(&bounds, "X"),
            number(&bounds, "Y"),
            number(&bounds, "Width"),
            number(&bounds, "Height"),
        ) else {
            continue;
        };
        let rect = Rect {
            x,
            y,
            width,
            height,
        };
        for (index, display) in displays.iter().enumerate() {
            if same(rect, *display) {
                covered[index] = true;
            }
        }
    }
    covered
}

#[cfg(not(target_os = "macos"))]
fn full_screen_displays(displays: &[Rect]) -> Vec<bool> {
    vec![false; displays.len()]
}

fn same(a: Rect, b: Rect) -> bool {
    (a.x - b.x).abs() < 1.0
        && (a.y - b.y).abs() < 1.0
        && (a.width - b.width).abs() < 1.0
        && (a.height - b.height).abs() < 1.0
}

fn work_area(monitor: &tauri::Monitor) -> Rect {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    Rect {
        x: area.position.x as f64 / scale,
        y: area.position.y as f64 / scale,
        width: area.size.width as f64 / scale,
        height: area.size.height as f64 / scale,
    }
}

fn fits(frame: &Frame, screens: &[Rect]) -> bool {
    screens.iter().any(|screen| {
        let width = (frame.x + frame.width).min(screen.x + screen.width) - frame.x.max(screen.x);
        let height = (frame.y + frame.height).min(screen.y + screen.height) - frame.y.max(screen.y);
        width >= MIN_VISIBLE.0 && height >= MIN_VISIBLE.1
    })
}

fn pointer_screen(app: &AppHandle) -> tauri::Result<Option<Rect>> {
    // The cursor comes back in the primary display's scale, and
    // `monitor_from_point` wants points.
    let primary_scale = app
        .primary_monitor()?
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let cursor = app.cursor_position()?;
    let (x, y) = (cursor.x / primary_scale, cursor.y / primary_scale);
    Ok(app.monitor_from_point(x, y)?.as_ref().map(work_area))
}

fn centered(screen: Rect, width: f64, height: f64) -> (f64, f64) {
    (
        screen.x + ((screen.width - width) / 2.0).max(0.0),
        screen.y + ((screen.height - height) / 2.0).max(0.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_window_fits_a_short_work_area() {
        let laptop = Rect { x: 0.0, y: 0.0, width: 1280.0, height: 680.0 };
        assert_eq!(fitted((1200.0, 800.0), laptop), (1200.0, 680.0 - CHROME));
        let large = Rect { x: 0.0, y: 0.0, width: 2560.0, height: 1400.0 };
        assert_eq!(fitted((1200.0, 800.0), large), (1200.0, 800.0));
    }

    const LAPTOP: Rect = Rect {
        x: 0.0,
        y: 25.0,
        width: 1512.0,
        height: 919.0,
    };
    const EXTERNAL: Rect = Rect {
        x: 1512.0,
        y: -200.0,
        width: 2560.0,
        height: 1415.0,
    };

    fn frame(x: f64, y: f64) -> Frame {
        Frame {
            x,
            y,
            width: 1200.0,
            height: 800.0,
            ..Frame::default()
        }
    }

    #[test]
    fn a_full_screen_window_reopens_on_its_display_even_if_its_frame_was_elsewhere() {
        // Windowed on the laptop, then made full screen on the external one.
        let moved = onto(frame(100.0, 100.0), EXTERNAL);
        assert!(fits(&moved, &[EXTERNAL]) && !fits(&moved, &[LAPTOP]));
        // Already there: left alone.
        assert_eq!(onto(frame(2000.0, 100.0), EXTERNAL), frame(2000.0, 100.0));
    }

    #[test]
    fn a_window_saved_before_full_screen_was_remembered_still_reads() {
        let old: Frame =
            serde_json::from_str(r#"{"x":1,"y":2,"width":3,"height":4,"maximized":false}"#)
                .unwrap();
        assert!(!old.fullscreen && old.display.is_none());
    }

    #[test]
    fn a_frame_on_the_second_monitor_is_reused_while_it_is_connected() {
        assert!(fits(&frame(2000.0, 100.0), &[LAPTOP, EXTERNAL]));
        assert!(
            !fits(&frame(2000.0, 100.0), &[LAPTOP]),
            "unplugged: center on the pointer instead"
        );
    }

    #[test]
    fn a_frame_barely_on_screen_is_not_reused() {
        // Only 50 points of it reach the laptop's right edge.
        assert!(!fits(&frame(1462.0, 100.0), &[LAPTOP]));
    }

    #[test]
    fn centering_stays_inside_the_screen_and_respects_its_origin() {
        assert_eq!(
            centered(EXTERNAL, 1200.0, 800.0),
            (1512.0 + 680.0, -200.0 + 307.5)
        );
        // A window larger than the screen starts at its top-left, never above it.
        assert_eq!(centered(LAPTOP, 2000.0, 1000.0), (0.0, 25.0));
    }
}
