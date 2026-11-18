//! Merge change reasons and keep a trailing notification at most once a second.
use super::*;
use std::{sync::Mutex, time::Instant};

#[derive(Clone, Copy, Default, serde::Serialize)]
pub(in crate::desktop) struct Change {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pins: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cache: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub state: bool,
}
impl Change {
    pub const PINS: Self = Self {
        pins: true,
        cache: false,
        state: false,
    };
    pub const CACHE: Self = Self {
        pins: false,
        cache: true,
        state: false,
    };
    pub const STATE: Self = Self {
        pins: false,
        cache: false,
        state: true,
    };
}
#[derive(Default)]
struct Batch {
    pending: Change,
    scheduled: bool,
    last: Option<Instant>,
}
impl Batch {
    fn add(&mut self, change: Change, now: Instant) -> Option<Duration> {
        self.pending.pins |= change.pins;
        self.pending.cache |= change.cache;
        self.pending.state |= change.state;
        if self.scheduled {
            return None;
        }
        self.scheduled = true;
        Some(self.last.map_or(Duration::ZERO, |last| {
            Duration::from_secs(1).saturating_sub(now.duration_since(last))
        }))
    }
    fn take(&mut self, now: Instant) -> Change {
        self.last = Some(now);
        self.scheduled = false;
        std::mem::take(&mut self.pending)
    }
}
pub(in crate::desktop) fn changed(app: &AppHandle, change: Change) {
    static BATCH: Mutex<Batch> = Mutex::new(Batch {
        pending: Change {
            pins: false,
            cache: false,
            state: false,
        },
        scheduled: false,
        last: None,
    });
    let delay = BATCH
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .add(change, Instant::now());
    if let Some(delay) = delay {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            // Serialize emission with scheduling so a racing change is never lost.
            let mut batch = BATCH.lock().unwrap_or_else(|e| e.into_inner());
            let _ = app.emit("offline:changed", batch.take(Instant::now()));
        });
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bursts_merge_reasons_and_preserve_trailing_pins() {
        let mut batch = Batch::default();
        let now = Instant::now();
        assert_eq!(batch.add(Change::CACHE, now), Some(Duration::ZERO));
        assert!(batch.take(now).cache);
        assert_eq!(
            batch.add(Change::CACHE, now + Duration::from_millis(100)),
            Some(Duration::from_millis(900))
        );
        assert_eq!(
            batch.add(Change::PINS, now + Duration::from_millis(500)),
            None
        );
        let change = batch.take(now + Duration::from_secs(1));
        assert!(change.pins && change.cache);
        assert_eq!(
            batch.add(Change::CACHE, now + Duration::from_secs(1)),
            Some(Duration::from_secs(1))
        );
    }
}
