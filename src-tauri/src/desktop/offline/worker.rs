//! Background synchronization and persistent transfer queue draining.

use super::*;

/// Persistent queued rows are re-enqueued after restart/reconnect; no extra probe.
/// True while a cover backfill runs (see `start`).
static ART_SYNC_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last_sync: Option<(Scope, std::time::Instant)> = None;
        loop {
            let state = app.state::<DesktopState>();
            let wake = match lock_store(&state, "worker::start") {
                Ok(o) => o.wake.clone(),
                Err(_) => return,
            };
            let active = {
                let r = state.runtime();
                r.ok().and_then(|r| {
                    (!offline_now(&r) && connection_state(&r.server) == "connected")
                        .then(|| scope(&r).ok())
                        .flatten()
                })
            };
            if let Some(active) = active {
                let pending = lock_store(&state, "worker::start").is_ok_and(|o| {
                    o.store
                        .outbox(&active)
                        .unwrap_or_default()
                        .iter()
                        .any(|r| !r.failed())
                        || !o.store.plays_batch(&active).unwrap_or_default().is_empty()
                });
                if pending
                    || last_sync.as_ref().map_or(true, |(s, at)| {
                        s != &active || at.elapsed() >= Duration::from_secs(30)
                    })
                {
                    match sync(&state, &active).await {
                        Err(error) => {
                            log::debug!("offline sync: {error}");
                        }
                        Ok(true) => {
                            let _ = app.emit("offline:synced", ());
                            let reason = lock_store(&state, "worker::sync-change")
                                .map(|mut o| o.take_change())
                                .unwrap_or(Change::STATE);
                            changed(&app, reason);
                        }
                        Ok(false) => {}
                    }
                    last_sync = Some((active.clone(), std::time::Instant::now()));
                    // Fetch covers outside sync: startup and snapshot reads wait
                    // on that lock, while artwork backfills can take much longer.
                    // Allow only one backfill at a time.
                    if !ART_SYNC_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        let app = app.clone();
                        let active = active.clone();
                        tauri::async_runtime::spawn(async move {
                            let state = app.state::<DesktopState>();
                            match sync_art(&state, &active).await {
                                Ok(true) => changed(&app, Change::CACHE),
                                Ok(false) => {}
                                Err(error) => log::debug!("offline art sync: {error}"),
                            }
                            ART_SYNC_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
                        });
                    }
                }

                let next = (|| -> ShellResult<_> {
                    let configured = state.runtime()?.configured_origin.clone();
                    if import_legacy(&state, &active, &configured)? {
                        changed(&app, Change::PINS);
                    }
                    let mut o = lock_store(&state, "worker::dispatch")?;
                    o.store.sweep_pending().map_err(storage_error)?;
                    let Offline { store, queue, .. } = &mut *o;
                    store
                        .queue_due_transfers_at(&active, queue, krobi_offline::store::now())
                        .map_err(storage_error)?;
                    Ok(o.queue.pop().filter(|(s, _, _)| s == &active))
                })();
                if let Ok(Some((scope, key, pool))) = next {
                    let before = lock_store(&state, "worker::before-transfer")
                        .map(|o| o.store.revision())
                        .unwrap_or(0);
                    if let Err(error) = download(&state, &scope, &key, &pool).await {
                        log::debug!("offline transfer: {error}");
                    }
                    // A transfer can update availability or its error state.
                    if lock_store(&state, "worker::after-transfer")
                        .is_ok_and(|o| o.store.revision() != before)
                    {
                        changed(&app, Change::CACHE);
                    }
                    // Only due work enters the queue. Drain it, then wait on the
                    // idle tick; a 404 cannot immediately enqueue itself again.
                    continue;
                }
            }
            if state
                .runtime()
                .is_ok_and(|r| connection_state(&r.server) != "connected" || offline_now(&r))
            {
                last_sync = None;
            }
            wait_for_work(&wake).await;
        }
    });
}

async fn wait_for_work(wake: &tokio::sync::Notify) {
    tokio::select! {
        _ = wake.notified() => {},
        _ = tokio::time::sleep(Duration::from_secs(1)) => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_nudge_wakes_an_idle_worker_without_waiting_for_the_next_pass() {
        tauri::async_runtime::block_on(async {
            let offline = test_store();
            offline.wake.notify_one();
            tokio::time::timeout(Duration::from_millis(100), wait_for_work(&offline.wake))
                .await
                .expect("an append nudge must survive until the worker waits");
        });
    }
}
