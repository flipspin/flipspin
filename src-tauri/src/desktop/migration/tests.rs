use super::*;
use std::sync::Mutex;

#[derive(Default)]
struct MockVault {
    values: Mutex<BTreeMap<String, String>>,
    fail: bool,
    ignore_writes: bool,
}
impl Vault for MockVault {
    fn get(&self, key: &str) -> io::Result<Option<String>> {
        if self.fail {
            return Err(io::Error::other("fixture locked vault"));
        }
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> io::Result<()> {
        if !self.ignore_writes {
            self.values.lock().unwrap().insert(key.into(), value.into());
        }
        Ok(())
    }
    fn delete(&self, _: &str) -> io::Result<()> {
        panic!("migration must never delete a vault item")
    }
}
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let home = Self(
            std::env::temp_dir().join(format!("flipspin-home-{:032x}", rand::random::<u128>())),
        );
        fs::create_dir_all(&home.0).unwrap();
        home
    }
    fn roots(&self, directory: &str) -> Vec<(PathBuf, PathBuf)> {
        let base = self.0.join(directory);
        vec![(base.join(OLD_SERVICE), base.join(SERVICE))]
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn seed(roots: &[(PathBuf, PathBuf)]) {
    let old = &roots[0].0;
    fs::create_dir_all(old.join("offline")).unwrap();
    fs::write(
        old.join("preferences.json"),
        br#"{"serverMode":"remote","theme":"dark"}"#,
    )
    .unwrap();
    fs::write(
        old.join("credentials.json"),
        br#"{"local":{},"worker:local":{},"headers:https://nest.example":{}}"#,
    )
    .unwrap();
    fs::write(old.join("offline/audio"), b"fixture audio").unwrap();
}

#[test]
fn temporary_home_copies_all_stores_and_mock_keychain_once_without_deleting_old_data() {
    let home = Home::new();
    let mut roots = home.roots("Library/Application Support");
    roots.extend(home.roots("Library/Caches"));
    roots.extend(home.roots("Library/WebKit"));
    seed(&roots);
    for (old, _) in &roots[1..] {
        fs::create_dir_all(old.join("WebsiteData/LocalStorage")).unwrap();
        fs::write(
            old.join("WebsiteData/LocalStorage/origin.localstorage"),
            b"fixture webkit store",
        )
        .unwrap();
    }
    let old = MockVault::default();
    for key in [
        "local",
        "worker:local",
        "headers:https://nest.example",
        "nest-secret-key:local",
    ] {
        old.set(key, &format!("fixture-{key}")).unwrap();
    }
    let new = MockVault::default();
    assert!(migrate(&roots, &old, &new).unwrap());
    let keys: Vec<_> = old.values.lock().unwrap().keys().cloned().collect();
    for key in &keys {
        assert_eq!(old.get(key).unwrap(), new.get(key).unwrap());
    }
    for (old, new) in &roots {
        let relative = if old == &roots[0].0 {
            "offline/audio"
        } else {
            "WebsiteData/LocalStorage/origin.localstorage"
        };
        assert_eq!(
            fs::read(old.join(relative)).unwrap(),
            fs::read(new.join(relative)).unwrap()
        );
    }
    fs::write(roots[0].1.join("preferences.json"), b"new preferences").unwrap();
    assert!(!migrate(&roots, &old, &new).unwrap()); // false = no second completion log
    assert_eq!(
        fs::read(roots[0].1.join("preferences.json")).unwrap(),
        b"new preferences"
    );
    assert!(!roots[0].1.join(PENDING).exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(roots[0].1.join("credentials.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn windows_linux_paths_and_existing_destination_are_respected() {
    for directory in ["AppData/Roaming", "AppData/Local", ".local/share", ".cache"] {
        let home = Home::new();
        let roots = home.roots(directory);
        seed(&roots);
        fs::create_dir_all(&roots[0].1).unwrap(); // an empty precreated store qualifies
        let vault = MockVault::default();
        assert!(migrate(&roots, &vault, &vault).unwrap());
        assert_eq!(previous(&roots[0].1).unwrap(), roots[0].0);
        assert_eq!(
            previous(&roots[0].1.join("cache")).unwrap(),
            roots[0].0.join("cache")
        );
    }
    let home = Home::new();
    let roots = home.roots("Library/Application Support");
    seed(&roots);
    fs::create_dir_all(&roots[0].1).unwrap();
    fs::write(roots[0].1.join("preferences.json"), b"existing").unwrap();
    let locked = MockVault {
        fail: true,
        ..Default::default()
    };
    assert!(!migrate(&roots, &locked, &locked).unwrap());
    assert_eq!(
        fs::read(roots[0].1.join("preferences.json")).unwrap(),
        b"existing"
    );
    assert!(!roots[0].1.join("credentials.json").exists());
}

#[test]
fn locked_keychain_and_interrupted_copy_retry_and_verify_writes() {
    let home = Home::new();
    let roots = home.roots("Library/Application Support");
    seed(&roots);
    // Simulate an interrupted file copy. Staging is discarded before retry.
    let stage = roots[0].1.with_extension("flipspin-copy");
    fs::create_dir_all(&stage).unwrap();
    fs::write(stage.join("partial"), b"partial").unwrap();
    let old = MockVault::default();
    old.set("local", "fixture-token").unwrap();
    let locked = MockVault {
        fail: true,
        ..Default::default()
    };
    assert!(migrate(&roots, &locked, &locked).is_err());
    assert!(roots[0].1.join(PENDING).exists());
    assert!(!roots[0].1.join(DONE).exists());
    let broken = MockVault {
        ignore_writes: true,
        ..Default::default()
    };
    assert!(migrate(&roots, &old, &broken).is_err());
    let new = MockVault::default();
    assert!(migrate(&roots, &old, &new).unwrap());
    assert_eq!(new.get("local").unwrap().as_deref(), Some("fixture-token"));
    assert_eq!(old.get("local").unwrap().as_deref(), Some("fixture-token"));
}

#[test]
fn conflicts_never_overwrite_a_new_keychain_item() {
    let home = Home::new();
    let roots = home.roots(".local/share");
    seed(&roots);
    let old = MockVault::default();
    old.set("local", "fixture-old").unwrap();
    let new = MockVault::default();
    new.set("local", "fixture-new").unwrap();
    assert!(migrate(&roots, &old, &new).is_err());
    assert_eq!(new.get("local").unwrap().as_deref(), Some("fixture-new"));
}

#[test]
fn managed_offline_paths_rebase_but_imported_files_and_original_database_do_not() {
    let home = Home::new();
    let roots = home.roots(".local/share");
    seed(&roots);
    let path = roots[0].0.join("offline.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE files(id INTEGER PRIMARY KEY,path TEXT,managed INTEGER);")
        .unwrap();
    let managed = roots[0]
        .0
        .join("offline/audio")
        .to_string_lossy()
        .into_owned();
    db.execute("INSERT INTO files VALUES(1,?1,1),(2,?1,0)", [&managed])
        .unwrap();
    db.execute_batch("CREATE TABLE art(id INTEGER PRIMARY KEY,path TEXT); CREATE TABLE pending_deletes(path TEXT PRIMARY KEY,managed INTEGER);").unwrap();
    db.execute("INSERT INTO art VALUES(1,?1)", [&managed])
        .unwrap();
    db.execute("INSERT INTO pending_deletes VALUES(?1,1)", [&managed])
        .unwrap();
    drop(db);
    let vault = MockVault::default();
    assert!(migrate(&roots, &vault, &vault).unwrap());
    let db = rusqlite::Connection::open(roots[0].1.join("offline.sqlite")).unwrap();
    let read = |id| {
        db.query_row("SELECT path FROM files WHERE id=?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap()
    };
    assert_eq!(read(1), roots[0].1.join("offline/audio").to_string_lossy());
    assert_eq!(read(2), managed);
    for table in ["art", "pending_deletes"] {
        let path: String = db
            .query_row(&format!("SELECT path FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(path, roots[0].1.join("offline/audio").to_string_lossy());
    }
    let old = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        old.query_row("SELECT path FROM files WHERE id=1", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        managed
    );
}

#[cfg(unix)]
#[test]
fn symlinks_cannot_copy_files_outside_the_previous_store() {
    let home = Home::new();
    let roots = home.roots(".local/share");
    seed(&roots);
    std::os::unix::fs::symlink(home.0.join("outside"), roots[0].0.join("link")).unwrap();
    let vault = MockVault::default();
    assert!(migrate(&roots, &vault, &vault).is_err());
    assert!(!roots[0].1.exists());
    assert!(roots[0].0.join("preferences.json").exists());
}
