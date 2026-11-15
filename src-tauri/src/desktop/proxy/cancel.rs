//! Register before dispatch so even a cancel overtaking backend_request is safe.
use super::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
use tokio::sync::watch;

type Requests = Mutex<BTreeMap<(String, String), Arc<watch::Sender<bool>>>>;
fn requests() -> &'static Requests {
    static REQUESTS: OnceLock<Requests> = OnceLock::new();
    REQUESTS.get_or_init(Mutex::default)
}

pub(in crate::desktop) fn open(window: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed).to_string();
    let (sender, _) = watch::channel(false);
    requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert((window.into(), id.clone()), Arc::new(sender));
    id
}

pub(in crate::desktop) fn cancel(window: &str, id: &str) {
    if let Some(sender) = requests()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&(window.into(), id.into()))
    {
        sender.send_replace(true);
    }
}

pub(super) struct Request {
    key: (String, String),
    cancelled: watch::Receiver<bool>,
}
impl Request {
    pub(super) fn take(window: &str, id: &str) -> ShellResult<Self> {
        let key = (window.into(), id.into());
        let cancelled = requests()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .ok_or(ShellError::Guard("proxy-request-cancelled"))?
            .subscribe();
        Ok(Self { key, cancelled })
    }

    /// select drops both the reqwest future and its admission permit on abort.
    pub(super) async fn run<T>(
        &mut self,
        future: impl std::future::Future<Output = ShellResult<T>>,
    ) -> ShellResult<T> {
        if *self.cancelled.borrow() {
            return Err(ShellError::Guard("proxy-request-cancelled"));
        }
        tokio::select! {
            biased;
            _ = self.cancelled.changed() => Err(ShellError::Guard("proxy-request-cancelled")),
            result = future => result,
        }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        requests()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}
