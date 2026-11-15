//! Process-wide socket admission, shared by every window and scoped to origin.
use super::*;
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(super) const JSON_LIMIT: usize = 16;
// Media has a separate allowance so a stalled JSON queue cannot stop playback.
pub(super) const MEDIA_LIMIT: usize = 4;
// Cover art has its own allowance so a grid of covers never delays the next audio slice.
pub(super) const ART_LIMIT: usize = 6;

#[derive(Default)]
struct Queue {
    waiting: usize,
    reported: bool,
    #[cfg(test)]
    reports: usize,
}

struct Budget {
    slots: Arc<Semaphore>,
    queue: Mutex<Queue>,
}

impl Budget {
    fn new(limit: usize) -> Self {
        Self {
            slots: Arc::new(Semaphore::new(limit)),
            queue: Mutex::new(Queue::default()),
        }
    }

    async fn acquire(&self) -> OwnedSemaphorePermit {
        let pending = self.slots.clone().acquire_owned();
        tokio::pin!(pending);
        // Count only queued callers. Dropping a queued future removes it too.
        let waiting = Waiting(self);
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).waiting += 1;
        let slot = tokio::select! {
            biased;
            slot = &mut pending => slot,
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                {
                let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
                if !queue.reported {
                    queue.reported = true;
                    #[cfg(test)]
                    { queue.reports += 1; }
                    log::warn!("HTTP proxy queue saturated for more than 5 s; requests are waiting");
                }
                }
                pending.await
            }
        };
        drop(waiting);
        slot.expect("proxy semaphore is never closed")
    }
}

struct Waiting<'a>(&'a Budget);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut queue = self.0.queue.lock().unwrap_or_else(|e| e.into_inner());
        queue.waiting -= 1;
        if queue.waiting == 0 {
            queue.reported = false;
        }
    }
}

pub(in crate::desktop) async fn acquire(origin: &str, media: bool) -> OwnedSemaphorePermit {
    acquire_kind(origin, if media { "media" } else { "json" }).await
}

/// Cover and artwork requests: never share slots with audio.
pub(super) async fn acquire_art(origin: &str) -> OwnedSemaphorePermit {
    acquire_kind(origin, "art").await
}

async fn acquire_kind(origin: &str, kind: &'static str) -> OwnedSemaphorePermit {
    type Budgets = Mutex<BTreeMap<(String, &'static str), Arc<Budget>>>;
    static BUDGETS: OnceLock<Budgets> = OnceLock::new();
    let origin = Url::parse(origin)
        .expect("validated backend URL")
        .origin()
        .ascii_serialization();
    let budget = BUDGETS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry((origin, kind))
        .or_insert_with(|| {
            Arc::new(Budget::new(match kind {
                "media" => MEDIA_LIMIT,
                "art" => ART_LIMIT,
                _ => JSON_LIMIT,
            }))
        })
        .clone();
    budget.acquire().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn saturation_is_reported_once_per_episode_and_cancelled_waiters_leave() {
        let budget = Arc::new(Budget::new(1));
        let held = budget.acquire().await;
        let mut tasks = Vec::new();
        for _ in 0..200 {
            let budget = budget.clone();
            tasks.push(tokio::spawn(async move { budget.acquire().await }));
        }
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(4999)).await;
        assert!(!budget.queue.lock().unwrap().reported);
        tokio::time::advance(Duration::from_millis(2)).await;
        tokio::task::yield_now().await;
        assert!(budget.queue.lock().unwrap().reported);
        assert_eq!(budget.queue.lock().unwrap().reports, 1);
        assert_eq!(budget.queue.lock().unwrap().waiting, 200);
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        assert_eq!(budget.queue.lock().unwrap().waiting, 0);
        assert!(!budget.queue.lock().unwrap().reported);
        drop(held);
        assert_eq!(budget.slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn media_allowance_is_separate_from_json_and_shared_across_backend_prefixes() {
        let origin = "http://budget.example";
        let mut media = Vec::new();
        for _ in 0..MEDIA_LIMIT {
            media.push(acquire(origin, true).await);
        }
        let mut blocked = Box::pin(acquire("http://budget.example/prefix", true));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut blocked)
                .await
                .is_err()
        );
        let json = acquire(origin, false).await;
        media.pop();
        let released = tokio::time::timeout(Duration::from_secs(1), blocked)
            .await
            .unwrap();
        drop((json, released, media));
    }
}
