//! The local nest's Fernet ring has a separate account from desktop tokens.
use super::credentials::{OsVault, Vault};
use base64::{engine::general_purpose::URL_SAFE, Engine};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const ACCOUNT: &str = "nest-secret-key:local";

fn normalize(value: &str) -> io::Result<String> {
    let keys: Vec<_> = value.split_whitespace().collect();
    if keys.is_empty()
        || keys
            .iter()
            .any(|key| URL_SAFE.decode(key).map_or(true, |bytes| bytes.len() != 32))
    {
        return Err(io::Error::other("invalid-nest-secret-key"));
    }
    Ok(keys.join("\n"))
}

pub(super) fn load(home: &Path, backend_dir: &Path) -> io::Result<String> {
    // Match paths inherited by the child, including relative paths, which the
    // backend resolves from its working directory rather than the shell's.
    let path = |name, default| {
        let configured = std::env::var_os(name).map(PathBuf::from).unwrap_or(default);
        if configured.is_absolute() {
            configured
        } else {
            backend_dir.join(configured)
        }
    };
    load_paths_with(
        &path("KROBI_CREDENTIALS_DIR", home.join("credentials")),
        &path("KROBI_INSTANCE_FILE", home.join("instance.json")),
        &OsVault,
    )
}

#[cfg(test)]
fn load_with(home: &Path, vault: &dyn Vault) -> io::Result<String> {
    load_paths_with(
        &home.join("credentials"),
        &home.join("instance.json"),
        vault,
    )
}

fn load_paths_with(
    directory: &Path,
    instance_file: &Path,
    vault: &dyn Vault,
) -> io::Result<String> {
    let legacy = directory.join(".key");
    let disk = match fs::read_to_string(&legacy) {
        Ok(key) => Some(normalize(&key)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let stored = vault.get(ACCOUNT)?.map(|key| normalize(&key)).transpose()?;
    let key = match (stored, disk.as_ref()) {
        (Some(key), Some(disk)) if &key != disk => {
            return Err(io::Error::other("nest-secret-key-conflict"))
        }
        (Some(key), _) => key,
        (None, Some(key)) => key.clone(),
        (None, None) => {
            // A lost vault must never silently replace the key to existing data.
            let instance: serde_json::Value = super::prefs::read_json(instance_file);
            if directory.join("secrets.json").exists()
                || has_legacy_encrypted(directory)?
                || !instance["secretKey"]["fingerprint"].is_null()
            {
                return Err(io::Error::other("nest-secret-key-missing"));
            }
            URL_SAFE.encode(rand::random::<[u8; 32]>())
        }
    };
    // Verify even an existing entry before deleting any recovery copy.
    vault.set(ACCOUNT, &key)?;
    if vault.get(ACCOUNT)?.as_deref() != Some(&key) {
        return Err(io::Error::other("nest-secret-key-verification-failed"));
    }
    if disk.is_some() && !has_legacy_encrypted(directory)? {
        fs::remove_file(legacy)?;
    }
    // The merged backend still opens credentials/.key to migrate *.enc. In
    // that case it removes the old key itself after committing the migration.
    Ok(key)
}

fn has_legacy_encrypted(directory: &Path) -> io::Result<bool> {
    match fs::read_dir(directory) {
        Ok(entries) => {
            for entry in entries {
                if entry?.path().extension().is_some_and(|ext| ext == "enc") {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeVault {
        value: Mutex<Option<String>>,
        bad_readback: bool,
        unavailable: bool,
    }
    impl Vault for FakeVault {
        fn get(&self, _: &str) -> io::Result<Option<String>> {
            if self.unavailable {
                return Err(io::Error::other("unavailable"));
            }
            if self.bad_readback {
                return Ok(None);
            }
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, account: &str, key: &str) -> io::Result<()> {
            assert_eq!(account, ACCOUNT);
            if self.unavailable {
                return Err(io::Error::other("unavailable"));
            }
            *self.value.lock().unwrap() = Some(key.into());
            Ok(())
        }
        fn delete(&self, _: &str) -> io::Result<()> {
            panic!("unexpected delete")
        }
    }
    fn home() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("krobi-nest-key-{:032x}", rand::random::<u128>()));
        fs::create_dir_all(path.join("credentials")).unwrap();
        path
    }
    #[test]
    fn adopts_then_deletes_only_after_matching_readback() {
        let home = home();
        let key = URL_SAFE.encode([42; 32]);
        let path = home.join("credentials/.key");
        fs::write(&path, format!("{key}\n")).unwrap();
        let bad = FakeVault {
            bad_readback: true,
            ..Default::default()
        };
        assert!(load_with(&home, &bad).is_err());
        assert!(path.exists());
        let vault = FakeVault::default();
        assert_eq!(load_with(&home, &vault).unwrap(), key);
        assert!(!path.exists());
        assert_eq!(load_with(&home, &vault).unwrap(), key);
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn generates_a_fernet_key_without_a_data_directory_key() {
        let home = home();
        let vault = FakeVault::default();
        let key = load_with(&home, &vault).unwrap();
        assert_eq!(URL_SAFE.decode(&key).unwrap().len(), 32);
        assert_eq!(key.len(), 44);
        assert_eq!(load_with(&home, &vault).unwrap(), key);
        assert!(!home.join("credentials/.key").exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn unavailable_or_conflicting_vault_preserves_recovery_key() {
        let home = home();
        let path = home.join("credentials/.key");
        fs::write(&path, URL_SAFE.encode([1; 32])).unwrap();
        let unavailable = FakeVault {
            unavailable: true,
            ..Default::default()
        };
        assert!(load_with(&home, &unavailable).is_err());
        let conflict = FakeVault {
            value: Mutex::new(Some(URL_SAFE.encode([2; 32]))),
            ..Default::default()
        };
        assert!(load_with(&home, &conflict).is_err());
        assert!(path.exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn legacy_encrypted_migration_retains_key_until_backend_can_read_it() {
        let home = home();
        let path = home.join("credentials/.key");
        fs::write(&path, URL_SAFE.encode([1; 32])).unwrap();
        fs::write(home.join("credentials/legacy.enc"), "legacy ciphertext").unwrap();
        load_with(&home, &FakeVault::default()).unwrap();
        assert!(path.exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn adopts_from_the_configured_credentials_directory() {
        let home = home();
        let directory = home.join("relocated-credentials");
        fs::create_dir(&directory).unwrap();
        let key = URL_SAFE.encode([3; 32]);
        fs::write(directory.join(".key"), &key).unwrap();
        let recovered = load_paths_with(
            &directory,
            &home.join("instance.json"),
            &FakeVault::default(),
        )
        .unwrap();
        assert_eq!(recovered, key);
        assert!(!directory.join(".key").exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn never_generates_a_replacement_for_existing_secrets() {
        let home = home();
        fs::write(home.join("credentials/secrets.json"), "{}").unwrap();
        assert!(load_with(&home, &FakeVault::default()).is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
