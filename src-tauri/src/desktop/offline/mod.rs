//! Offline shell authority, store adaptation, commands and background work.
//! Runtime identity fences every scoped read, transfer and sync commit.

use super::*;
use krobi_offline::{
    pools::{cache_budget, Pools},
    resolve::is_offline,
    store::{Scope, Store, DOWNLOADED, MISSING},
    transfer::{Priority, Queue},
};
use serde_json::json;
use std::path::Path;
use tauri::Emitter;
use url::Url;

mod art;
mod authority;
mod commands;
mod diagnostics;
mod events;
mod keys;
mod store;
mod sync;
#[cfg(test)]
mod test_support;
mod transfer;
mod worker;

use art::{refresh_art, sync_art};
use authority::connected_scope;
use keys::{cover_path, media_path, valid_key};
use store::import_legacy;
use sync::{refresh_snapshot, snapshot_path, sync};
#[cfg(test)]
use test_support::{serve, serve_typed, snapshot_replies, state};
use transfer::download;
#[cfg(test)]
use transfer::{download_pinned_with_capacity, download_pool_with_capacity};

pub(super) use authority::{connection_state, offline_now, scope};
#[cfg(test)]
pub(in crate::desktop) use commands::pools_get;
pub(super) use commands::{invoke, offline_request};
pub(in crate::desktop) use diagnostics::lock_store;
pub(in crate::desktop) use events::{changed, Change};
pub(super) use keys::{art_media_path, is_audio_key, key_from_media, player_track_key};
pub(in crate::desktop) use store::enforce_cache_budget;
#[cfg(test)]
pub(super) use store::test_store;
pub(super) use store::{available_capacity, capacity_async};
pub(super) use transfer::content_range;
pub(crate) use worker::start;

pub(super) struct Offline {
    pub store: Store,
    pub queue: Queue,
    pins_changed: bool,
    sync: std::sync::Arc<tokio::sync::Mutex<()>>,
    last_sync: Option<(Scope, std::time::Instant)>,
    wake: std::sync::Arc<tokio::sync::Notify>,
}

impl Offline {
    fn take_change(&mut self) -> Change {
        if std::mem::take(&mut self.pins_changed) {
            Change::PINS
        } else {
            Change::STATE
        }
    }
    pub(in crate::desktop) fn wake_for_cache(&self) {
        self.wake.notify_one();
    }
}

fn storage_error(e: impl std::fmt::Display) -> ShellError {
    ShellError::Message(e.to_string())
}

#[cfg(test)]
pub(super) fn timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
