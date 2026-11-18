//! Release diagnostics measure hold time, excluding time spent waiting.
use super::*;
use std::{
    ops::{Deref, DerefMut},
    sync::MutexGuard,
    time::Instant,
};

pub(in crate::desktop) struct StoreGuard<'a> {
    guard: Option<MutexGuard<'a, Offline>>,
    started: Instant,
    operation: &'static str,
}
impl Deref for StoreGuard<'_> {
    type Target = Offline;
    fn deref(&self) -> &Offline {
        self.guard.as_deref().unwrap()
    }
}
impl DerefMut for StoreGuard<'_> {
    fn deref_mut(&mut self) -> &mut Offline {
        self.guard.as_deref_mut().unwrap()
    }
}
impl Drop for StoreGuard<'_> {
    fn drop(&mut self) {
        let held = self.started.elapsed();
        drop(self.guard.take());
        if let Some(message) = hold_warning(self.operation, held) {
            log::warn!("{message}");
        }
    }
}
pub(in crate::desktop) fn lock_store<'a>(
    state: &'a DesktopState,
    operation: &'static str,
) -> ShellResult<StoreGuard<'a>> {
    let guard = lock(&state.offline, "offline")?;
    Ok(StoreGuard {
        guard: Some(guard),
        started: Instant::now(),
        operation,
    })
}

fn hold_warning(operation: &str, held: Duration) -> Option<String> {
    (held > Duration::from_millis(200)).then(|| {
        format!(
            "offline mutex held: operation={operation} held_ms={}",
            held.as_millis()
        )
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_warning_names_operation_only_after_200ms_hold() {
        assert!(hold_warning("test::lock", Duration::from_millis(200)).is_none());
        assert_eq!(
            hold_warning("test::lock", Duration::from_millis(201)).unwrap(),
            "offline mutex held: operation=test::lock held_ms=201"
        );
        let state = state("http://nest");
        let mut guard = lock_store(&state, "test::lock").unwrap();
        guard.started = Instant::now() - Duration::from_millis(201);
        drop(guard);
        assert!(state.offline.try_lock().is_ok());
    }
}
