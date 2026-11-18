//! Observe workspace sleep, not screen sleep. The agent sends its own bounded bye.
#[cfg(target_os = "macos")]
pub(crate) fn observe(app: &tauri::AppHandle) {
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    let wake_app = app.clone();
    let wake = block2::RcBlock::new(move |_| {
        crate::desktop::uploads::sleep(&wake_app, false);
    });
    // SAFETY: same main-thread setup and app-lifetime ownership as below.
    let wake_observer = unsafe {
        NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &wake,
            )
    };
    std::mem::forget(wake_observer);
    let app = app.clone();
    let block = block2::RcBlock::new(move |_| {
        crate::desktop::uploads::sleep(&app, true);
    });
    // SAFETY: setup runs on the main thread; the sendable block only owns an
    // AppHandle. NSWorkspace retains the block. Keep its observer for app life.
    let observer = unsafe {
        NSWorkspace::sharedWorkspace()
            .notificationCenter()
            .addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceWillSleepNotification),
                None,
                None,
                &block,
            )
    };
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn observe(_app: &tauri::AppHandle) {}
