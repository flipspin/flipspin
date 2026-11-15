use super::*;
use crate::{
    pools::Pools,
    resolve::{is_offline, Resolution},
    store::{Scope, Store, DOWNLOADED, STALE},
    transfer::{Priority, Queue},
};
use rusqlite::params;
use std::fs;
fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../../contracts/offline.json")).unwrap()
}
fn setup() -> (tempfile::TempDir, Store, Scope) {
    let dir = tempfile::tempdir().unwrap();
    let pools = Pools::new(dir.path().join("offline"), dir.path().join("cache")).unwrap();
    let store = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
    (dir, store, Scope::new("nido", "a").unwrap())
}
fn complete(store: &Store, scope: &Scope, key: &str, pool: &str, etag: &str, bytes: &[u8]) {
    store
        .begin(scope, key, pool, bytes.len() as u64, Some(etag), 0)
        .unwrap();
    store.append(scope, key, pool, bytes).unwrap();
    store.finish(scope, key, pool).unwrap();
}
#[test]
fn acquiring_pin_waits_on_404_then_downloads_and_only_later_can_be_gone() {
    let (_dir, mut store, scope) = setup();
    let key = "A/landing.mp3";
    store.extend_pin(&scope, "album", "A", &[], true).unwrap();
    let mut queue = Queue::default();
    store.queue_transfers(&scope, &mut queue).unwrap();
    assert!(
        queue.pop().is_none(),
        "intent alone never fetches unlanded songs"
    );
    store
        .extend_pin(&scope, "album", "A", &[key.into()], false)
        .unwrap();
    // A landing receipt can still race media publication at the nest.
    store
        .remote_file_missing_at(&scope, key, "offline", 1000)
        .unwrap();
    let file = store.file(&scope, key, "offline").unwrap().unwrap();
    assert_eq!(file.state, store::QUEUED);
    assert!(file.verified_at.is_none());
    store.queue_transfers_at(&scope, &mut queue, 1029).unwrap();
    assert!(queue.pop().is_none());
    store.queue_transfers_at(&scope, &mut queue, 1030).unwrap();
    assert_eq!(
        queue.pop(),
        Some((scope.clone(), key.into(), "offline".into()))
    );
    complete(&store, &scope, key, "offline", "\"v1\"", b"audio");
    assert_eq!(
        store.file(&scope, key, "offline").unwrap().unwrap().state,
        DOWNLOADED
    );
    store.remote_file_missing(&scope, key, "offline").unwrap();
    let file = store.file(&scope, key, "offline").unwrap().unwrap();
    assert_eq!(file.state, store::MISSING);
    assert_eq!(fs::read(file.path).unwrap(), b"audio");
}

#[test]
fn progressive_collection_pin_queues_each_new_key_once() {
    let (_dir, mut store, scope) = setup();
    assert!(store
        .extend_pin(&scope, "album", "A", &[], true)
        .unwrap()
        .is_empty());
    assert_eq!(store.pins(&scope).unwrap().len(), 1);
    let first = "A/one.mp3".to_string();
    let second = "A/two.mp3".to_string();
    assert_eq!(
        store
            .extend_pin(&scope, "album", "A", &[first.clone(), first.clone()], false)
            .unwrap(),
        vec![first.clone()]
    );
    complete(&store, &scope, &first, "offline", "\"v1\"", b"audio");
    let saved = store.file(&scope, &first, "offline").unwrap().unwrap();
    assert_eq!(
        store
            .extend_pin(
                &scope,
                "album",
                "A",
                &[first.clone(), second.clone()],
                false
            )
            .unwrap(),
        vec![second.clone()]
    );
    store
        .transfer_failed(&scope, &second, "offline", "source refused")
        .unwrap();
    // Neither repeated receipts nor recording intent again retry failed files.
    assert!(store
        .extend_pin(&scope, "album", "A", std::slice::from_ref(&second), false)
        .unwrap()
        .is_empty());
    assert!(store
        .extend_pin(&scope, "album", "A", &[], true)
        .unwrap()
        .is_empty());
    let mut queue = Queue::default();
    store.queue_transfers(&scope, &mut queue).unwrap();
    assert!(queue.pop().is_none());
    assert_eq!(
        store.file(&scope, &first, "offline").unwrap().unwrap().path,
        saved.path
    );
    assert_eq!(fs::read(saved.path).unwrap(), b"audio");
    assert_eq!(store.pins(&scope).unwrap()[0].3, [first, second]);
    // A new receipt queues once, including after durable queue reconstruction.
    let third = "A/three.mp3".to_string();
    assert_eq!(
        store
            .extend_pin(&scope, "album", "A", std::slice::from_ref(&third), false)
            .unwrap(),
        vec![third.clone()]
    );
    store.queue_transfers(&scope, &mut queue).unwrap();
    store.queue_transfers(&scope, &mut queue).unwrap();
    assert_eq!(queue.pop(), Some((scope.clone(), third, "offline".into())));
    assert!(queue.pop().is_none());
}

#[test]
fn progressive_receipt_cannot_recreate_an_unpinned_or_other_account_pin() {
    let (_dir, mut store, scope) = setup();
    store.extend_pin(&scope, "album", "A", &[], true).unwrap();
    let other = Scope::new("nido", "other").unwrap();
    assert!(store
        .extend_pin(&other, "album", "A", &["A/one.mp3".into()], false)
        .is_err());
    store.unpin(&scope, Some("album:A")).unwrap();
    assert!(store
        .extend_pin(&scope, "album", "A", &["A/one.mp3".into()], false)
        .is_err());
    assert!(store.pins(&scope).unwrap().is_empty());
    assert!(store.files(&scope).unwrap().is_empty());
}
#[test]
fn check_7_truncated_transfer_never_becomes_downloaded() {
    let (_dir, mut s, a) = setup();
    s.pin(&a, "song", "A/one.mp3", &["A/one.mp3".into()])
        .unwrap();
    s.begin(&a, "A/one.mp3", "offline", 10, Some("\"v1\""), 0)
        .unwrap();
    s.append(&a, "A/one.mp3", "offline", b"short").unwrap();
    assert!(s.finish(&a, "A/one.mp3", "offline").is_err());
    let file = s.file(&a, "A/one.mp3", "offline").unwrap().unwrap();
    assert_ne!(file.state, DOWNLOADED);
    assert!(!file.path.exists());
    assert_eq!(
        s.resolve(&a, "A/one.mp3", true).unwrap(),
        Resolution::Unavailable
    );
}
#[test]
fn check_8_refcounts_and_crash_sweep_read_contract() {
    for case in fixture()["refcounts"].as_array().unwrap() {
        let (dir, mut s, a) = setup();
        let key = "A/one.mp3";
        for id in case["pins"].as_array().unwrap() {
            s.pin(
                &a,
                "playlist",
                id.as_str().unwrap().strip_prefix("playlist:").unwrap(),
                &[key.into()],
            )
            .unwrap();
        }
        complete(&s, &a, key, "offline", "\"v1\"", b"audio");
        assert_eq!(s.files(&a).unwrap().len(), 1);
        let file = s.file(&a, key, "offline").unwrap().unwrap();
        for id in case["remove"].as_array().unwrap() {
            s.unpin(&a, Some(id.as_str().unwrap())).unwrap();
        }
        assert!(file.path.exists()); // crash at exactly the transaction/world seam
        let pools = s.pools.clone();
        drop(s);
        let s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
        assert_eq!(
            s.files(&a).unwrap().len() as u64,
            case["remaining"].as_u64().unwrap()
        );
        assert_eq!(file.path.exists(), case["remaining"] == 1);
    }
}
#[test]
fn check_10_etag_change_keeps_old_copy_until_atomic_promotion() {
    let (_dir, mut s, a) = setup();
    let key = "A/one.mp3";
    s.pin(&a, "song", key, &[key.into()]).unwrap();
    complete(&s, &a, key, "offline", "\"old\"", b"old audio");
    s.observe_etag(&a, key, "offline", "\"new\"").unwrap();
    assert_eq!(s.file(&a, key, "offline").unwrap().unwrap().state, STALE);
    s.begin(&a, key, "offline", 9, Some("\"new\""), 0).unwrap();
    s.append(&a, key, "offline", b"new").unwrap();
    let Resolution::Local(path) = s.resolve(&a, key, true).unwrap() else {
        panic!("old copy unavailable")
    };
    assert_eq!(fs::read(&path).unwrap(), b"old audio");
    s.append(&a, key, "offline", b" audio").unwrap();
    s.finish(&a, key, "offline").unwrap();
    assert_eq!(fs::read(path).unwrap(), b"new audio");
    assert_eq!(
        s.file(&a, key, "offline").unwrap().unwrap().etag.as_deref(),
        Some("\"new\"")
    );
}
#[test]
fn check_11_resolution_contract_never_calls_network_when_unavailable() {
    for case in fixture()["resolve"].as_array().unwrap() {
        let (_dir, mut s, a) = setup();
        let key = "A/one.mp3";
        if case["local"] == true {
            complete(&s, &a, key, "offline", "\"v1\"", b"local");
        }
        if case["cache"] == true {
            complete(&s, &a, key, "cache", "\"v1\"", b"cache");
        }
        let result = s
            .resolve(&a, key, is_offline(case["connection"].as_str().unwrap()))
            .unwrap();
        let mut network_requests = 0;
        let name = match result {
            Resolution::Local(_) => "Local",
            Resolution::Cache(_) => "Cache",
            Resolution::Remote => {
                network_requests += 1;
                "Remote"
            }
            Resolution::Unavailable => "Unavailable",
        };
        assert_eq!(name, case["out"].as_str().unwrap());
        if case["connection"] == "unreachable" {
            assert_eq!(network_requests, 0);
        }
    }
}
#[test]
fn check_14_other_account_and_server_are_invisible_and_downloads_survive_signout() {
    let (dir, mut s, a) = setup();
    let key = "A/one.mp3";
    s.pin(&a, "song", key, &[key.into()]).unwrap();
    complete(&s, &a, key, "offline", "\"v1\"", b"audio");
    s.db.execute(
        "INSERT INTO snapshot VALUES('nido','a','home','private','etag',1)",
        [],
    )
    .unwrap();
    s.db.execute(
        "INSERT INTO outbox VALUES('nido','a','1','key','library-add','private',1,0,NULL)",
        [],
    )
    .unwrap();
    for scope in [
        Scope::new("nido", "b").unwrap(),
        Scope::new("other-nido", "a").unwrap(),
    ] {
        assert!(s.files(&scope).unwrap().is_empty());
        assert_eq!(s.pin_count(&scope).unwrap(), 0);
        assert_eq!(
            s.resolve(&scope, key, true).unwrap(),
            Resolution::Unavailable
        );
        for table in ["snapshot", "outbox", "plays_outbox"] {
            let count: i64 =
                s.db.query_row(
                    &format!("SELECT count(*) FROM {table} WHERE instance_id=?1 AND account_id=?2"),
                    params![scope.instance_id, scope.account_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
        s.unpin(&scope, None).unwrap();
        s.sweep().unwrap();
    }
    let pools = s.pools.clone();
    drop(s);
    let mut s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
    assert!(matches!(
        s.resolve(&a, key, true).unwrap(),
        Resolution::Local(_)
    ));
}
#[test]
fn pin_expansion_idempotency_and_actions_read_contract() {
    for case in fixture()["expansion"].as_array().unwrap() {
        let (_dir, mut s, a) = setup();
        let tracks = case["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().into())
            .collect::<Vec<_>>();
        for _ in 0..2 {
            s.pin(
                &a,
                case["kind"].as_str().unwrap(),
                case["ref"].as_str().unwrap(),
                &tracks,
            )
            .unwrap();
        }
        assert_eq!(s.pin_count(&a).unwrap(), 1);
        assert_eq!(
            s.files(&a).unwrap().len() as u64,
            case["out"].as_u64().unwrap()
        );
    }
    for case in fixture()["offlineActions"].as_array().unwrap() {
        assert_eq!(
            offline_action(case["action"].as_str().unwrap()),
            case["out"].as_str().unwrap()
        );
    }
}
#[test]
fn cache_lru_preserves_pinned_and_playing_files_and_clamps_budget() {
    let (_dir, mut s, a) = setup();
    for key in ["A/pinned", "A/playing", "A/evict"] {
        complete(&s, &a, key, "cache", "\"v1\"", b"audio");
    }
    s.pin(&a, "song", "A/pinned", &["A/pinned".into()]).unwrap();
    s.set_playing(&a, "A/playing");
    s.evict_cache(&a, 0).unwrap();
    assert!(s.file(&a, "A/pinned", "cache").unwrap().is_some());
    assert!(s.file(&a, "A/playing", "cache").unwrap().is_some());
    assert!(s.file(&a, "A/evict", "cache").unwrap().is_none());
    s.stop_playing();
    s.sweep_pending().unwrap();
    s.evict_cache(&a, 0).unwrap();
    assert!(s.file(&a, "A/playing", "cache").unwrap().is_none());
    assert_eq!(pools::cache_budget(1), 50 * 1024 * 1024);
    assert_eq!(pools::cache_budget(u64::MAX), 10 * 1024 * 1024 * 1024);
}
#[test]
fn resume_uses_only_strong_validator_and_preserves_partial_across_restart() {
    let (dir, s, a) = setup();
    let key = "A/one.mp3";
    s.begin(&a, key, "cache", 10, Some("\"strong\""), 0)
        .unwrap();
    s.append(&a, key, "cache", b"12345").unwrap();
    let pools = s.pools.clone();
    drop(s);
    let s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
    let resume = s.resume(&a, key, "cache").unwrap();
    assert_eq!(resume.offset, 5);
    assert_eq!(resume.if_range.as_deref(), Some("\"strong\""));
    assert!(s
        .begin(&a, key, "cache", 10, Some("\"changed\""), 5)
        .is_err());
    s.begin(&a, key, "cache", 10, Some("W/\"weak\""), 0)
        .unwrap();
    s.append(&a, key, "cache", b"123").unwrap();
    assert_eq!(s.resume(&a, key, "cache").unwrap().offset, 0);
}
#[test]
fn missing_files_downgrade_and_scope_blocks_symlink_escapes() {
    let (dir, mut s, a) = setup();
    let key = "A/one.mp3";
    complete(&s, &a, key, "offline", "\"v1\"", b"audio");
    let f = s.file(&a, key, "offline").unwrap().unwrap();
    fs::remove_file(&f.path).unwrap();
    assert_eq!(s.resolve(&a, key, true).unwrap(), Resolution::Unavailable);
    assert_ne!(
        s.file(&a, key, "offline").unwrap().unwrap().state,
        DOWNLOADED
    );
    #[cfg(unix)]
    {
        let external = dir.path().join("outside");
        fs::write(&external, b"audio").unwrap();
        std::os::unix::fs::symlink(external, &f.path).unwrap();
        assert!(!s.allowed(&f));
    }
}
#[test]
fn imported_documents_stay_in_place_unflagged_and_are_never_evicted_or_removed() {
    let (dir, mut s, a) = setup();
    let path = dir.path().join("chosen.mp3");
    fs::write(&path, b"export").unwrap();
    let songs = vec![("A/one.mp3".into(), path.to_string_lossy().into_owned())];
    s.import_songs(&a, "legacy", &songs).unwrap();
    s.import_songs(&a, "legacy", &songs).unwrap();
    assert_eq!(s.pin_count(&a).unwrap(), 1);
    let f = s.file(&a, "A/one.mp3", "offline").unwrap().unwrap();
    assert!(!f.managed);
    assert!(s.allowed(&f));
    assert_eq!(f.path, path.canonicalize().unwrap());
    s.unpin(&a, None).unwrap();
    s.sweep().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"export");
}
#[test]
fn priority_queue_promotes_play_above_prefetch_and_pin() {
    let a = Scope::new("n", "a").unwrap();
    let mut q = Queue::default();
    q.push(Priority::Pin, a.clone(), "pin".into());
    q.push(Priority::Prefetch, a.clone(), "prefetch".into());
    q.push(Priority::Play, a.clone(), "play".into());
    q.push(Priority::Play, a, "pin".into());
    assert_eq!(q.pop().unwrap().1, "play");
    assert_eq!(q.pop().unwrap().1, "pin");
    assert_eq!(q.pop().unwrap().1, "prefetch");
    assert!(q.pop().is_none());
}

#[test]
fn cached_pin_promotes_without_network_and_follows_new_expansion() {
    let (_dir, mut s, a) = setup();
    let key = "A/one.mp3";
    complete(&s, &a, key, "cache", "\"v1\"", b"audio");
    s.pin(&a, "playlist", "list", &[key.into()]).unwrap();
    assert!(s.promote_cached(&a, key).unwrap());
    assert!(s.file(&a, key, "cache").unwrap().is_none());
    assert!(matches!(
        s.resolve(&a, key, true).unwrap(),
        Resolution::Local(_)
    ));
    s.pin(&a, "playlist", "list", &["A/two.mp3".into()])
        .unwrap();
    s.sweep().unwrap();
    assert!(s.file(&a, key, "offline").unwrap().is_none());
    assert!(s.file(&a, "A/two.mp3", "offline").unwrap().is_some());
}
#[test]
fn import_claim_is_atomic_across_accounts_and_revocation_keeps_downloads() {
    let (dir, mut s, a) = setup();
    let b = Scope::new("nido", "b").unwrap();
    let path = dir.path().join("chosen.mp3");
    fs::write(&path, b"audio").unwrap();
    let songs = vec![("A/one.mp3".into(), path.to_string_lossy().into_owned())];
    s.import_songs(&a, "legacy", &songs).unwrap();
    s.import_songs(&b, "legacy", &songs).unwrap();
    assert!(s.files(&b).unwrap().is_empty());
    s.revoke(&a).unwrap();
    assert_eq!(s.files(&a).unwrap().len(), 1);
    s.remove_library_track(&a, "A/one.mp3").unwrap();
    s.sweep().unwrap();
    assert!(s.files(&a).unwrap().is_empty());
    assert!(path.exists());
}

#[test]
fn refreshing_an_import_never_overwrites_the_chosen_document() {
    let (dir, mut s, a) = setup();
    let key = "A/one.mp3";
    let path = dir.path().join("chosen.mp3");
    fs::write(&path, b"original").unwrap();
    s.import_songs(
        &a,
        "legacy",
        &[(key.into(), path.to_string_lossy().into_owned())],
    )
    .unwrap();
    s.begin(&a, key, "offline", 3, Some("\"new\""), 0).unwrap();
    s.append(&a, key, "offline", b"new").unwrap();
    s.sweep().unwrap(); // repair must recognise an imported file's managed staging path
    assert_eq!(
        s.resolve(&a, key, true).unwrap(),
        Resolution::Local(path.canonicalize().unwrap())
    );
    s.finish(&a, key, "offline").unwrap();
    let file = s.file(&a, key, "offline").unwrap().unwrap();
    assert!(file.managed);
    assert!(s.pools.contains(&file.path));
    assert_eq!(fs::read(path).unwrap(), b"original");
    assert_eq!(fs::read(file.path).unwrap(), b"new");
}

#[test]
fn storage_pin_expansions_are_scoped_and_follow_removal() {
    let (_dir, mut store, account) = setup();
    let other = Scope::new("nido", "other").unwrap();
    let nest = Scope::new("another-nido", "a").unwrap();
    store
        .pin(
            &account,
            "library",
            "library",
            &["A/one.mp3".into(), "A/two.mp3".into()],
        )
        .unwrap();
    store
        .pin(&other, "song", "private", &["private.mp3".into()])
        .unwrap();
    store
        .pin(&nest, "song", "another", &["another.mp3".into()])
        .unwrap();
    assert_eq!(
        store.pins(&account).unwrap(),
        vec![(
            "library:library".into(),
            "library".into(),
            "library".into(),
            vec!["A/one.mp3".into(), "A/two.mp3".into()]
        )]
    );
    store.unpin(&account, None).unwrap();
    assert!(store.pins(&account).unwrap().is_empty());
    assert_eq!(store.pins(&other).unwrap().len(), 1);
    assert_eq!(store.pins(&nest).unwrap().len(), 1);
}

#[test]
fn check_14_snapshot_outbox_account_and_nest_isolation_home_roundtrip() {
    for kind in fixture()["snapshotKinds"].as_array().unwrap() {
        assert!(crate::snapshot::valid_kind(kind.as_str().unwrap()));
    }
    assert_eq!(fixture()["outboxRetryCap"], crate::outbox::RETRY_CAP);

    let (_dir, s, a) = setup();
    let b = Scope::new("nido", "b").unwrap();
    let other = Scope::new("other-nido", "a").unwrap();
    let body = r#"{"albums":[],"library":{"tracks":[]},"playlists":[]}"#;
    s.save_snapshot(&a, "home", body, Some("\"v1\"")).unwrap();
    s.enqueue(
        &a,
        "stable-key",
        "library-add",
        r#"{"relPaths":["A/one.mp3"]}"#,
    )
    .unwrap();
    assert_eq!(s.snapshot(&a, "home").unwrap().unwrap().body, body);
    for scope in [b, other] {
        assert!(s.snapshot(&scope, "home").unwrap().is_none());
        assert!(s.outbox(&scope).unwrap().is_empty());
    }
}
#[test]
fn durable_fifo_idempotent_repeats_and_retry_cap() {
    let (dir, s, a) = setup();
    for id in ["z-first", "a-second", "m-third"] {
        s.enqueue(&a, id, "playlist-edit", id).unwrap();
    }
    s.enqueue(&a, "z-first", "playlist-edit", "z-first")
        .unwrap();
    assert!(s
        .enqueue(&a, "z-first", "playlist-edit", "different")
        .is_err());
    assert_eq!(
        s.outbox(&a)
            .unwrap()
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["z-first", "a-second", "m-third"]
    );
    for _ in 0..5 {
        s.attempt(&a, "z-first").unwrap();
        s.reject_intent(&a, "z-first", "503:busy", false).unwrap();
    }
    drop(s);
    let pools = Pools::new(dir.path().join("offline"), dir.path().join("cache")).unwrap();
    let s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
    let first = &s.outbox(&a).unwrap()[0];
    assert!(first.failed());
    assert_eq!(first.last_error.as_deref(), Some("503:busy"));
    s.reject_intent(&a, "a-second", "412:{\"current\":{\"tracks\":[]}}", true)
        .unwrap();
    s.retry_intent(&a, "a-second").unwrap();
    let conflict = &s.outbox(&a).unwrap()[1];
    assert!(conflict.failed());
    assert_eq!(conflict.body, "a-second");
}
#[test]
fn plays_oldest_first_bounded_and_revocation_keeps_downloads() {
    use crate::outbox::Play;
    let (_dir, mut s, a) = setup();
    for n in (0..65).rev() {
        s.queue_play(
            &a,
            &Play {
                client_play_id: n.to_string(),
                track_key: "A/one.mp3".into(),
                listened_at: n,
            },
        )
        .unwrap();
    }
    let batch = s.plays_batch(&a).unwrap();
    assert_eq!(batch.len(), 50);
    assert_eq!(batch[0].listened_at, 0);
    s.acknowledge_plays(&a, &batch).unwrap();
    assert_eq!(s.plays_batch(&a).unwrap().len(), 15);
    complete(&s, &a, "A/one.mp3", "offline", "\"v\"", b"audio");
    s.revoke(&a).unwrap();
    assert!(s.plays_batch(&a).unwrap().is_empty());
    assert_eq!(s.files(&a).unwrap().len(), 1);
}

fn complete_art(s: &Store, scope: &Scope, path: &str, bytes: &[u8]) {
    s.begin_art(scope, "A", path).unwrap();
    s.append_art(scope, path, bytes).unwrap();
    s.finish_art(
        scope,
        path,
        Some(bytes.len() as u64),
        Some("\"art-v1\""),
        Some("image/jpeg"),
    )
    .unwrap();
}
#[test]
fn art_variants_are_scoped_and_never_count_as_audio_or_cache() {
    let (_dir, mut s, a) = setup();
    s.pin(&a, "album", "A", &["A/one.mp3".into()]).unwrap();
    let full = "/api/media/A/cover.jpg";
    let small = "/api/media/A/cover.jpg?size=96";
    complete_art(&s, &a, full, b"large");
    complete_art(&s, &a, small, b"small");
    assert_eq!(s.arts(&a).unwrap().len(), 2);
    assert_ne!(
        s.art(&a, full).unwrap().unwrap().path,
        s.art(&a, small).unwrap().unwrap().path
    );
    assert_eq!(s.pin_count(&a).unwrap(), 1);
    assert_eq!(s.files(&a).unwrap().len(), 1);
    assert!(!s.required(&a, full).unwrap());
    s.enforce_cache_budget(0).unwrap();
    assert!(matches!(
        s.resolve_art(&a, small, true).unwrap(),
        resolve::ArtResolution::Local(_)
    ));
    let other = Scope::new("nido", "other").unwrap();
    assert!(matches!(
        s.resolve_art(&other, full, true).unwrap(),
        resolve::ArtResolution::Unavailable
    ));
    s.revoke(&a).unwrap();
    assert!(s.arts(&a).unwrap().is_empty());
    assert!(fs::read_dir(s.pools.offline.join("art"))
        .unwrap()
        .next()
        .is_none());
}
#[test]
fn art_lives_until_the_last_album_track_in_any_pin_kind_is_released() {
    for kind in ["song", "album", "playlist", "library"] {
        let (_dir, mut s, a) = setup();
        let first = s.pin(&a, kind, "one", &["A/one.mp3".into()]).unwrap();
        let second = s.pin(&a, "song", "two", &["A/two.mp3".into()]).unwrap();
        let full = "/api/media/A/cover.jpg";
        let small = "/api/media/A/cover.jpg?size=96";
        complete_art(&s, &a, full, b"art");
        s.art_missing(&a, "A", small).unwrap();
        let path = s.art(&a, full).unwrap().unwrap().path;
        s.unpin(&a, Some(&first)).unwrap();
        s.sweep_pending().unwrap();
        assert!(path.exists());
        assert_eq!(s.arts(&a).unwrap().len(), 2);
        s.unpin(&a, Some(&second)).unwrap();
        assert!(s.arts(&a).unwrap().is_empty());
        assert!(path.exists(), "unpin queues deletion until the sweep");
        s.sweep_pending().unwrap();
        assert!(!path.exists());
    }
}
#[test]
fn art_reconciliation_library_removal_and_interrupted_transfer_keep_consistent_files() {
    let (dir, mut s, a) = setup();
    s.pin(&a, "playlist", "P", &["A/one.mp3".into()]).unwrap();
    let path = "/api/media/A/cover.jpg";
    complete_art(&s, &a, path, b"old");
    s.begin_art(&a, "A", path).unwrap();
    s.append_art(&a, path, b"short").unwrap();
    assert!(s.finish_art(&a, path, Some(99), None, None).is_err());
    let art = s.art(&a, path).unwrap().unwrap();
    assert_eq!(fs::read(&art.path).unwrap(), b"old");
    s.pin(&a, "playlist", "P", &["B/one.mp3".into()]).unwrap();
    let pools = s.pools.clone();
    drop(s);
    let mut s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
    assert!(!art.path.exists());
    assert!(!art.path.with_extension("part").exists());
    s.pin(&a, "library", "all", &["A/one.mp3".into()]).unwrap();
    complete_art(&s, &a, path, b"new");
    s.remove_library_track(&a, "A/one.mp3").unwrap();
    assert!(s.art(&a, path).unwrap().is_none());
}
#[test]
fn migration_from_v1_keeps_pins_files_snapshots_and_audio_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let pools = Pools::new(dir.path().join("offline"), dir.path().join("cache")).unwrap();
    let db_path = dir.path().join("offline.sqlite");
    let db = rusqlite::Connection::open(&db_path).unwrap();
    // This is the complete v1 schema: v2 only adds the independent art table.
    let v1 = include_str!("schema.sql")
        .split_once("-- migration: 3")
        .unwrap()
        .0
        .lines()
        .filter(|l| !l.starts_with("CREATE TABLE art("))
        .collect::<Vec<_>>()
        .join("\n")
        .replace("user_version=2", "user_version=1");
    db.execute_batch(&v1).unwrap();
    db.execute(
        "INSERT INTO pins VALUES('nido','a','song:A/one.mp3','song','A/one.mp3',123)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO pin_tracks VALUES('nido','a','song:A/one.mp3','A/one.mp3')",
        [],
    )
    .unwrap();
    let audio = pools.path("offline", 42);
    fs::write(&audio, b"audio").unwrap();
    db.execute("INSERT INTO files(id,instance_id,account_id,track_key,pool,path,bytes,etag,state,verified_at) VALUES(42,'nido','a','A/one.mp3','offline',?1,5,'v1',?2,123)",params![audio.to_string_lossy(),DOWNLOADED]).unwrap();
    db.execute(
        "INSERT INTO snapshot VALUES('nido','a','listing','[]','snapshot-v1',123)",
        [],
    )
    .unwrap();
    drop(db);
    let mut s = Store::open(&db_path, pools).unwrap();
    let a = Scope::new("nido", "a").unwrap();
    assert_eq!(
        s.db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(s.pins(&a).unwrap()[0].3, vec!["A/one.mp3"]);
    let file = s.file(&a, "A/one.mp3", "offline").unwrap().unwrap();
    assert_eq!((file.id, file.bytes, file.verified_at), (42, 5, Some(123)));
    assert_eq!(
        s.resolve(&a, "A/one.mp3", true).unwrap(),
        Resolution::Local(audio.clone())
    );
    assert_eq!(fs::read(audio).unwrap(), b"audio");
    let snapshot = s.snapshot(&a, "listing").unwrap().unwrap();
    assert_eq!(snapshot.body, "[]");
    assert_eq!(snapshot.etag.as_deref(), Some("snapshot-v1"));
    assert!(s.arts(&a).unwrap().is_empty());
    complete_art(&s, &a, "/api/media/A/cover.jpg", b"art");
}

#[test]
fn queued_and_interrupted_cache_rows_are_recovered_after_restart() {
    for interrupted in [false, true] {
        let (dir, s, scope) = setup();
        let key = "Collection/Track.mp3";
        s.tee(&scope, key, 0, 10, Some("\"v1\""), b"123").unwrap();
        if interrupted {
            s.set_state(
                &scope,
                key,
                "cache",
                store::DOWNLOADING,
                Some("transfer-paused"),
            )
            .unwrap();
        }
        let pools = s.pools.clone();
        drop(s);
        let s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
        assert_eq!(
            s.file(&scope, key, "cache").unwrap().unwrap().state,
            store::QUEUED
        );
        let mut queue = Queue::default();
        s.queue_transfers(&scope, &mut queue).unwrap();
        let (active, key, pool) = queue.pop().unwrap();
        assert_eq!(pool, "cache");
        let resume = s.resume(&active, &key, &pool).unwrap();
        assert_eq!(resume.offset, 3);
        s.begin(&active, &key, &pool, 10, Some("\"v1\""), resume.offset)
            .unwrap();
        s.append(&active, &key, &pool, b"4567890").unwrap();
        s.finish(&active, &key, &pool).unwrap();
        let file = s.file(&active, &key, &pool).unwrap().unwrap();
        assert_eq!(file.state, DOWNLOADED);
        assert_eq!(fs::read(file.path).unwrap(), b"1234567890");
    }
}

#[test]
fn stale_partial_validator_restarts_from_zero() {
    let (_dir, s, scope) = setup();
    let key = "Collection/Track.mp3";
    s.begin(&scope, key, "cache", 100, Some("\"old\""), 0)
        .unwrap();
    s.append(&scope, key, "cache", b"old header").unwrap();
    assert!(s
        .begin(&scope, key, "cache", 5, Some("\"new\""), 10)
        .is_err());
    s.begin(&scope, key, "cache", 5, Some("\"new\""), 0)
        .unwrap();
    assert_eq!(s.resume(&scope, key, "cache").unwrap().offset, 0);
    s.append(&scope, key, "cache", b"audio").unwrap();
    s.finish(&scope, key, "cache").unwrap();
    let file = s.file(&scope, key, "cache").unwrap().unwrap();
    assert_eq!(fs::read(file.path).unwrap(), b"audio");
    assert_eq!(file.etag.as_deref(), Some("\"new\""));
}

#[test]
fn a_growing_playlist_pin_gets_an_offline_row_despite_an_unverified_cache() {
    let (_dir, mut s, scope) = setup();
    let first = "Collection/First.mp3";
    let new = "Collection∕Artist's Album  Edition/Second.mp3";
    s.pin(&scope, "playlist", "Collection", &[first.into()])
        .unwrap();
    complete(&s, &scope, first, "offline", "\"first\"", b"first");
    s.tee(&scope, new, 0, 10, Some("\"old\""), b"123").unwrap();
    assert!(s
        .refresh_pin(
            &scope,
            "playlist",
            "Collection",
            &[first.into(), new.into()]
        )
        .unwrap());
    assert!(!s.promote_cached(&scope, new).unwrap());
    let offline = s.file(&scope, new, "offline").unwrap().unwrap();
    assert_eq!(offline.state, store::QUEUED);
    assert_eq!(s.pins(&scope).unwrap()[0].3.len(), 2);
    assert_eq!(
        s.files(&scope)
            .unwrap()
            .iter()
            .filter(|f| f.pool == "offline")
            .count(),
        2
    );
    complete(&s, &scope, new, "offline", "\"new\"", b"new audio");
    assert_eq!(
        fs::read(s.file(&scope, new, "offline").unwrap().unwrap().path).unwrap(),
        b"new audio"
    );
    assert!(s
        .file(&scope, &new.replace("  ", " "), "offline")
        .unwrap()
        .is_none());
}

#[test]
fn refreshing_pins_preserves_failures_and_cannot_resurrect_an_unpin() {
    let (_dir, mut s, scope) = setup();
    let key = "Collection/Track.mp3";
    s.pin(&scope, "playlist", "Collection", &[key.into()])
        .unwrap();
    s.transfer_failed(&scope, key, "offline", "no-space")
        .unwrap();
    s.refresh_pin(
        &scope,
        "playlist",
        "Collection",
        &[key.into(), "Collection/New.mp3".into()],
    )
    .unwrap();
    assert_eq!(
        s.file(&scope, key, "offline").unwrap().unwrap().state,
        store::FAILED
    );
    s.unpin(&scope, Some("playlist:Collection")).unwrap();
    assert!(!s
        .refresh_pin(&scope, "playlist", "Collection", &[key.into()])
        .unwrap());
    assert!(s.files(&scope).unwrap().is_empty());
}

#[test]
fn missing_pin_rows_are_repaired_and_media_tee_cannot_corrupt_a_worker_resume() {
    let (_dir, mut s, scope) = setup();
    let key = "Collection/Track.mp3";
    s.pin(&scope, "song", key, &[key.into()]).unwrap();
    s.db.execute("DELETE FROM files WHERE pool='offline'", [])
        .unwrap();
    let mut queue = Queue::default();
    s.queue_transfers(&scope, &mut queue).unwrap();
    assert_eq!(queue.pop().unwrap().2, "offline");
    assert!(s.file(&scope, key, "offline").unwrap().is_some());
    s.begin(&scope, key, "cache", 6, Some("\"v1\""), 0).unwrap();
    s.append(&scope, key, "cache", b"abc").unwrap();
    s.worker_transfer(&scope, key, "cache", true);
    assert!(!s.tee(&scope, key, 0, 6, Some("\"v2\""), b"wrong!").unwrap());
    assert_eq!(s.resume(&scope, key, "cache").unwrap().offset, 3);
    s.append(&scope, key, "cache", b"def").unwrap();
    s.finish(&scope, key, "cache").unwrap();
    s.worker_transfer(&scope, key, "cache", false);
    assert_eq!(
        fs::read(s.file(&scope, key, "cache").unwrap().unwrap().path).unwrap(),
        b"abcdef"
    );
}

#[test]
fn cache_budget_cannot_evict_a_workers_staging_file() {
    let (_dir, mut s, scope) = setup();
    let key = "Collection/Track.mp3";
    s.begin(&scope, key, "cache", 6, Some("\"v1\""), 0).unwrap();
    s.append(&scope, key, "cache", b"abc").unwrap();
    s.worker_transfer(&scope, key, "cache", true);
    s.evict_cache(&scope, 0).unwrap();
    assert_eq!(s.resume(&scope, key, "cache").unwrap().offset, 3);
    s.worker_transfer(&scope, key, "cache", false);
    s.evict_cache(&scope, 0).unwrap();
    assert!(s.file(&scope, key, "cache").unwrap().is_none());
}

#[test]
fn missing_backoff_contract_survives_restart_and_keeps_verified_audio_playable() {
    for pool in ["offline", "cache"] {
        let (dir, mut s, a) = setup();
        let key = "A/verified.mp3";
        s.pin(&a, "song", key, &[key.into()]).unwrap();
        complete(&s, &a, key, pool, "\"v1\"", b"audio");
        let delays = fixture()["missingFiles"]["retrySeconds"]
            .as_array()
            .unwrap()
            .clone();
        let mut at = 1000;
        for index in 0..7 {
            s.remote_file_missing_at(&a, key, pool, at).unwrap();
            let file = s.file(&a, key, pool).unwrap().unwrap();
            assert_eq!(file.state, store::MISSING);
            assert_eq!(file.missing_since, Some(1000));
            assert_eq!(file.missing_attempts, index + 1);
            let delay = delays[index.min(4) as usize].as_i64().unwrap();
            assert!(!s.transfer_due_at(&a, key, pool, at + delay - 1).unwrap());
            assert!(s.transfer_due_at(&a, key, pool, at + delay).unwrap());
            let pools = s.pools.clone();
            drop(s);
            s = Store::open(&dir.path().join("offline.sqlite"), pools).unwrap();
            assert!(!s.transfer_due_at(&a, key, pool, at + delay - 1).unwrap());
            assert!(matches!(
                s.resolve(&a, key, true).unwrap(),
                Resolution::Local(_) | Resolution::Cache(_)
            ));
            assert_eq!(fs::read(file.path).unwrap(), b"audio");
            at += delay;
        }
        complete(&s, &a, key, pool, "\"v2\"", b"new audio");
        let file = s.file(&a, key, pool).unwrap().unwrap();
        assert_eq!(
            (file.missing_since, file.missing_attempts, file.retry_at),
            (None, 0, None)
        );
    }
}

#[test]
fn library_revision_retries_once_without_resetting_attempts_or_other_scopes() {
    let (_dir, mut s, a) = setup();
    let b = Scope::new("other", "b").unwrap();
    let key = "A/landing.mp3";
    for scope in [&a, &b] {
        s.pin(scope, "song", key, &[key.into()]).unwrap();
        s.remote_file_missing_at(scope, key, "offline", 1000)
            .unwrap();
    }
    let catalog = [(key.to_owned(), false)].into_iter().collect();
    s.reconcile_library(&a, &catalog, false).unwrap();
    assert!(!s.transfer_due_at(&a, key, "offline", 1001).unwrap());
    s.reconcile_library(&a, &catalog, true).unwrap();
    assert!(s.transfer_due_at(&a, key, "offline", 1001).unwrap());
    assert!(!s.transfer_due_at(&b, key, "offline", 1001).unwrap());
    s.remote_file_missing_at(&a, key, "offline", 1001).unwrap();
    s.reconcile_library(&a, &catalog, false).unwrap();
    assert!(!s.transfer_due_at(&a, key, "offline", 1120).unwrap());
    assert!(s.transfer_due_at(&a, key, "offline", 1121).unwrap());
    assert_eq!(
        s.file(&a, key, "offline")
            .unwrap()
            .unwrap()
            .missing_attempts,
        2
    );
}

#[test]
fn missing_snapshot_contract_suppresses_all_pin_expansions_and_recovers() {
    for case in fixture()["missingFiles"]["cases"].as_array().unwrap() {
        for kind in ["song", "album", "playlist", "library"] {
            let (_dir, mut s, a) = setup();
            let key = "A/one.mp3";
            let mut catalog = std::collections::BTreeMap::new();
            if case["present"].as_bool().unwrap() {
                catalog.insert(key.into(), case["missingFromNest"].as_bool().unwrap());
            }
            s.reconcile_library(&a, &catalog, true).unwrap();
            s.pin(&a, kind, "collection", &[key.into()]).unwrap();
            s.reconcile_library(&a, &catalog, false).unwrap();
            assert_eq!(
                s.file(&a, key, "offline").unwrap().unwrap().state,
                case["out"].as_str().unwrap()
            );
            if case["missingFromNest"] == true {
                // A later expansion and repeated repair cannot requeue known missing rows.
                s.extend_pin(&a, "album", "A", &[key.into()], true).unwrap();
                s.pin(&a, kind, "collection", &[key.into()]).unwrap();
                assert_eq!(
                    s.file(&a, key, "offline").unwrap().unwrap().state,
                    store::MISSING
                );
            }
            let mut queue = Queue::default();
            s.queue_transfers_at(&a, &mut queue, i64::MAX).unwrap();
            assert_eq!(queue.pop().is_some(), case["out"] == store::QUEUED);
            assert!(!s.pins(&a).unwrap().is_empty());
            catalog.insert(key.into(), false);
            s.reconcile_library(&a, &catalog, true).unwrap();
            s.queue_transfers(&a, &mut queue).unwrap();
            assert_eq!(queue.pop(), Some((a.clone(), key.into(), "offline".into())));
        }
    }
}

#[test]
fn migration_from_v2_preserves_intent_and_initializes_retry_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let pools = Pools::new(dir.path().join("offline"), dir.path().join("cache")).unwrap();
    let path = dir.path().join("offline.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        include_str!("schema.sql")
            .split_once("-- migration: 3")
            .unwrap()
            .0,
    )
    .unwrap();
    db.execute(
        "INSERT INTO pins VALUES('nido','a','song:A/one.mp3','song','A/one.mp3',123)",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO pin_tracks VALUES('nido','a','song:A/one.mp3','A/one.mp3')",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO files(instance_id,account_id,track_key,pool,path,state,error) VALUES('nido','a','A/one.mp3','offline','','en fila','remote-file-missing')",[]).unwrap();
    drop(db);
    let s = Store::open(&path, pools).unwrap();
    let a = Scope::new("nido", "a").unwrap();
    let file = s.file(&a, "A/one.mp3", "offline").unwrap().unwrap();
    assert_eq!(
        (
            file.missing_since,
            file.missing_attempts,
            file.retry_at,
            file.remote_unavailable
        ),
        (None, 0, None, false)
    );
    assert_eq!(s.pins(&a).unwrap()[0].3, vec!["A/one.mp3"]);
    s.remote_file_missing_at(&a, "A/one.mp3", "offline", 1000)
        .unwrap();
    assert!(!s.transfer_due_at(&a, "A/one.mp3", "offline", 1029).unwrap());
}

#[test]
fn pending_delete_batches_do_not_walk_pool_directories() {
    let (_dir, mut store, _) = setup();
    let orphan = store.pools.cache.join("999999.audio");
    fs::write(&orphan, b"orphan").unwrap();
    store.sweep_pending().unwrap();
    assert!(
        orphan.exists(),
        "pending deletion must not run the startup directory walk"
    );
    store.sweep().unwrap();
    assert!(!orphan.exists(), "startup still repairs orphan files");
}

#[test]
fn idle_dispatch_leaves_pin_repair_to_explicit_recovery() {
    let (_dir, mut store, scope) = setup();
    store
        .pin(&scope, "song", "A/one.mp3", &["A/one.mp3".into()])
        .unwrap();
    store.db.execute("DELETE FROM files", []).unwrap();
    let revision = store.revision();
    let mut queue = Queue::default();
    store
        .queue_due_transfers_at(&scope, &mut queue, i64::MAX)
        .unwrap();
    assert!(queue.pop().is_none());
    assert_eq!(
        store.revision(),
        revision,
        "an idle tick must not repair every pin"
    );
    store.queue_transfers(&scope, &mut queue).unwrap();
    assert_eq!(queue.pop().unwrap().1, "A/one.mp3");
}
