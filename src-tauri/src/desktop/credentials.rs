//! Device tokens use the OS vault, session memory, or an explicitly chosen file.
//! credentials.json contains identity metadata only.
use super::{
    prefs::{atomic_json, Credential},
    private_file,
};
use std::{collections::BTreeMap, io, path::Path};

type Credentials = BTreeMap<String, Credential>;
pub(super) trait Vault: Send + Sync {
    fn get(&self, key: &str) -> io::Result<Option<String>>;
    fn set(&self, key: &str, token: &str) -> io::Result<()>;
    fn delete(&self, key: &str) -> io::Result<()>;
}
pub(super) struct OsVault;
pub(super) const SERVICE: &str = "app.flipspin.desktop";
pub(super) const OLD_SERVICE: &str = "app.krobi.desktop";
pub(super) struct LegacyVault;
fn entry(key: &str) -> io::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).map_err(io::Error::other)
}
impl Vault for LegacyVault {
    fn get(&self, key: &str) -> io::Result<Option<String>> {
        match keyring::Entry::new(OLD_SERVICE, key)
            .map_err(io::Error::other)?
            .get_password()
        {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(io::Error::other(error)),
        }
    }
    fn set(&self, _: &str, _: &str) -> io::Result<()> {
        Err(io::Error::other("legacy vault is read only"))
    }
    fn delete(&self, _: &str) -> io::Result<()> {
        Err(io::Error::other("legacy vault is read only"))
    }
}
impl Vault for OsVault {
    fn get(&self, key: &str) -> io::Result<Option<String>> {
        match entry(key)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(io::Error::other(e)),
        }
    }
    fn set(&self, key: &str, token: &str) -> io::Result<()> {
        entry(key)?.set_password(token).map_err(io::Error::other)
    }
    fn delete(&self, key: &str) -> io::Result<()> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(io::Error::other(e)),
        }
    }
}
/// The file's presence records the person's explicit choice, even with no tokens.
const TOKEN_FILE: &str = "device-tokens.json";

#[derive(Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum StoreKind {
    MacosKeychain,
    WindowsCredentialManager,
    SecretService,
    File,
    Memory,
}

fn native_kind() -> StoreKind {
    if cfg!(target_os = "macos") {
        StoreKind::MacosKeychain
    } else if cfg!(target_os = "windows") {
        StoreKind::WindowsCredentialManager
    } else {
        StoreKind::SecretService
    }
}

pub(super) struct Storage {
    pub(super) kind: StoreKind,
    pub(super) reason: Option<&'static str>,
    vault: Box<dyn Vault>,
}

impl Storage {
    fn memory(&mut self) {
        if self.kind != StoreKind::Memory {
            log::warn!("OS credential store unavailable; credentials stay in session memory");
        }
        self.kind = StoreKind::Memory;
        // Never expose an OS error string: a provider could include secret data.
        self.reason = Some("os-keystore-unavailable");
    }

    pub(super) fn save(&mut self, path: &Path, credentials: &Credentials) -> io::Result<()> {
        if self.kind == StoreKind::File {
            write_tokens(path, credentials)?;
        } else if self.kind != StoreKind::Memory {
            for (key, credential) in credentials {
                if !credential.token.is_empty()
                    && store_verified(self.vault.as_ref(), key, &credential.token).is_err()
                {
                    self.memory();
                    break;
                }
            }
        }
        atomic_json(path, credentials, true)
    }

    pub(super) fn remove(&mut self, key: &str) {
        if self.kind != StoreKind::File
            && self.kind != StoreKind::Memory
            && self.vault.delete(key).is_err()
        {
            self.memory();
        }
    }

    pub(super) fn save_to_file(
        &mut self,
        path: &Path,
        credentials: &Credentials,
    ) -> io::Result<()> {
        // Commit the explicit choice only after the private file is durable.
        write_tokens(path, credentials)?;
        self.kind = StoreKind::File;
        self.reason = None;
        atomic_json(path, credentials, true)
    }

    #[cfg(test)]
    pub(super) fn test_memory() -> Self {
        Self {
            kind: StoreKind::Memory,
            reason: Some("os-keystore-unavailable"),
            vault: Box::new(tests::UnavailableVault),
        }
    }
}

fn token_path(path: &Path) -> std::path::PathBuf {
    path.with_file_name(TOKEN_FILE)
}

fn write_tokens(path: &Path, credentials: &Credentials) -> io::Result<()> {
    let tokens: BTreeMap<_, _> = credentials
        .iter()
        .filter(|(_, c)| !c.token.is_empty())
        .map(|(key, c)| (key, &c.token))
        .collect();
    private_file::write_atomic(&token_path(path), &serde_json::to_vec(&tokens)?)
}

fn store_verified(vault: &dyn Vault, key: &str, value: &str) -> io::Result<()> {
    vault.set(key, value)?;
    if vault.get(key)?.as_deref() != Some(value) {
        return Err(io::Error::other("credential-store-verification-failed"));
    }
    Ok(())
}

fn load_with(path: &Path, vault: Box<dyn Vault>) -> io::Result<(Credentials, Storage)> {
    let mut credentials: Credentials = match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::other)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e),
    };
    let mut storage = Storage {
        kind: native_kind(),
        reason: None,
        vault,
    };
    match std::fs::read(token_path(path)) {
        Ok(bytes) => {
            let tokens: BTreeMap<String, String> =
                serde_json::from_slice(&bytes).map_err(io::Error::other)?;
            for (key, credential) in &mut credentials {
                credential.token = tokens.get(key).cloned().unwrap_or_default();
            }
            storage.kind = StoreKind::File;
            return Ok((credentials, storage));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let migrating = credentials.values().any(|c| !c.token.is_empty());
    // A read probes availability without creating any real credential.
    if storage.vault.get("desktop-keystore-probe").is_err() {
        storage.memory();
    }
    for (key, credential) in &mut credentials {
        let result = if !credential.token.is_empty() {
            store_verified(storage.vault.as_ref(), key, &credential.token)
        } else {
            storage
                .vault
                .get(key)
                .map(|token| credential.token = token.unwrap_or_default())
        };
        if result.is_err() {
            storage.memory();
        }
    }
    // Keep legacy recovery copies if the vault could not verify migration.
    if migrating && storage.kind != StoreKind::Memory {
        atomic_json(path, &credentials, true)?;
    }
    Ok((credentials, storage))
}

pub(super) fn load(path: &Path) -> io::Result<(Credentials, Storage)> {
    load_with(path, Box::new(OsVault))
}

/// Resolve the identity to persist when the renderer supplies a token.
pub(super) async fn verified(
    http: &super::Client,
    origin: &str,
    request: &serde_json::Value,
) -> crate::error::ShellResult<Credential> {
    use crate::error::ShellError;

    let token = request["token"].as_str().unwrap_or_default().trim();
    if token.is_empty() {
        return Err(ShellError::Guard("empty-token"));
    }
    let me: serde_json::Value = http
        .get(format!("{}/api/me", origin.trim_end_matches('/')))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let field = |name: &str| {
        me[name]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or(ShellError::Guard("invalid-identity-response"))
    };
    let role = field("role")?;
    if role != "owner" && role != "member" {
        return Err(ShellError::Guard("invalid-identity-response"));
    }
    Ok(Credential {
        token: token.to_string(),
        device_id: None,
        user_id: Some(field("id")?),
        label: Some(field("label")?),
        role: Some(role),
        saved_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn auth_set_uses_server_identity_and_rejects_invalid_tokens() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};

        for (status, body, succeeds) in [
            (
                "200 OK",
                r#"{"id":"member-id","label":"Server label","role":"member","source":"token"}"#,
                true,
            ),
            (
                "401 Unauthorized",
                r#"{"detail":"Invalid API token."}"#,
                false,
            ),
            (
                "200 OK",
                r#"{"id":"member-id","label":"Server label"}"#,
                false,
            ),
            (
                "200 OK",
                r#"{"id":"member-id","label":"Server label","role":"admin"}"#,
                false,
            ),
            ("200 OK", "invalid json", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let server = std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = Vec::new();
                            let mut byte = [0];
                            while !request.ends_with(b"\r\n\r\n") {
                                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                                request.push(byte[0]);
                            }
                            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                            return String::from_utf8(request).unwrap();
                        }
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
                String::new()
            });
            let forged = serde_json::json!({"token":"fixture-token", "userId":"forged-owner", "label":"Forged", "role":"owner"});
            let result = verified(&crate::desktop::Client::new(), &origin, &forged).await;
            let request = server.join().unwrap();
            if succeeds {
                let credential = result.unwrap();
                assert_eq!(credential.user_id.as_deref(), Some("member-id"));
                assert_eq!(credential.label.as_deref(), Some("Server label"));
                assert_eq!(credential.role.as_deref(), Some("member"));
                assert_eq!(credential.token, "fixture-token");
            } else {
                assert!(result.is_err(), "invalid server identity must not be saved");
            }
            assert!(request.starts_with("GET /api/me HTTP/1.1\r\n"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer fixture-token\r\n"));
        }
    }

    pub(super) struct UnavailableVault;
    impl Vault for UnavailableVault {
        fn get(&self, _: &str) -> io::Result<Option<String>> {
            Err(io::Error::other("fixture vault unavailable"))
        }
        fn set(&self, _: &str, _: &str) -> io::Result<()> {
            Err(io::Error::other("fixture vault unavailable"))
        }
        fn delete(&self, _: &str) -> io::Result<()> {
            Err(io::Error::other("fixture vault unavailable"))
        }
    }

    fn test_path() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("krobi-token-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("credentials.json")
    }

    #[test]
    fn unavailable_vault_keeps_session_and_explicit_file_choice_survives_restart() {
        let path = test_path();
        let (mut credentials, mut storage) = load_with(&path, Box::new(UnavailableVault)).unwrap();
        assert!(storage.kind == StoreKind::Memory);
        assert_eq!(storage.reason, Some("os-keystore-unavailable"));
        credentials.insert(
            "local".into(),
            Credential {
                token: "fixture-session-only-token".into(),
                ..Default::default()
            },
        );
        storage.save(&path, &credentials).unwrap();
        assert_eq!(credentials["local"].token, "fixture-session-only-token");
        assert!(!token_path(&path).exists());
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("fixture-session-only-token"));
        storage.save_to_file(&path, &credentials).unwrap();
        assert!(storage.kind == StoreKind::File);
        assert_eq!(storage.reason, None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(token_path(&path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let (mut restored, mut storage) = load_with(&path, Box::new(UnavailableVault)).unwrap();
        assert!(storage.kind == StoreKind::File);
        assert_eq!(restored["local"].token, "fixture-session-only-token");
        restored.clear();
        storage.save(&path, &restored).unwrap();
        let (empty, storage) = load_with(&path, Box::new(UnavailableVault)).unwrap();
        assert!(empty.is_empty());
        assert!(
            storage.kind == StoreKind::File,
            "file choice remains after sign-out"
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn custom_headers_follow_vault_and_explicit_file_policy() {
        let path = test_path();
        let vault = MemoryVault::default();
        let (mut credentials, mut storage) = load_with(&path, Box::new(vault.clone())).unwrap();
        let key = "headers:https://nest.example";
        credentials.insert(
            key.into(),
            Credential {
                token: r#"{"x-secret":"private-header-value"}"#.into(),
                ..Default::default()
            },
        );
        storage.save(&path, &credentials).unwrap();
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("private-header-value"));
        let (restored, _) = load_with(&path, Box::new(vault)).unwrap();
        assert_eq!(restored[key].token, credentials[key].token);
        storage.save_to_file(&path, &credentials).unwrap();
        let (restored, _) = load_with(&path, Box::new(UnavailableVault)).unwrap();
        assert_eq!(restored[key].token, credentials[key].token);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn vault_failure_during_save_preserves_the_new_session() {
        let path = test_path();
        let mut storage = Storage {
            kind: native_kind(),
            reason: None,
            vault: Box::new(UnavailableVault),
        };
        let credentials = BTreeMap::from([(
            "local".into(),
            Credential {
                token: "fixture-new-session".into(),
                ..Default::default()
            },
        )]);
        storage.save(&path, &credentials).unwrap();
        assert!(storage.kind == StoreKind::Memory);
        assert_eq!(credentials["local"].token, "fixture-new-session");
        assert!(!token_path(&path).exists());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[derive(Default, Clone)]
    struct MemoryVault(Arc<Mutex<BTreeMap<String, String>>>);
    impl Vault for MemoryVault {
        fn get(&self, k: &str) -> io::Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(k).cloned())
        }
        fn set(&self, k: &str, v: &str) -> io::Result<()> {
            self.0.lock().unwrap().insert(k.into(), v.into());
            Ok(())
        }
        fn delete(&self, k: &str) -> io::Result<()> {
            self.0.lock().unwrap().remove(k);
            Ok(())
        }
    }
    #[test]
    fn check_15_migration_scrubs_all_app_data_files_and_survives_restart() {
        let dir = std::env::temp_dir().join(format!(
            "krobi-vault-{}-{}",
            std::process::id(),
            super::super::offline::timestamp()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("credentials.json");
        std::fs::write(&path,r#"{"local":{"token":"fixture-secret-149","userId":"a"},"worker:local":{"token":"fixture-helper-149"}}"#).unwrap(); // gitleaks:allow (test fixture)
        let vault = MemoryVault::default();
        let first = load_with(&path, Box::new(vault.clone())).unwrap().0;
        assert_eq!(first["local"].token, "fixture-secret-149"); // gitleaks:allow (test fixture)
        for file in std::fs::read_dir(&dir).unwrap() {
            let bytes = std::fs::read(file.unwrap().path()).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("fixture-secret-149") && !text.contains("fixture-helper-149"));
            assert!(!text.contains("\"token\""));
        }
        let second = load_with(&path, Box::new(vault.clone())).unwrap().0;
        assert_eq!(first["local"].token, second["local"].token);
        assert_eq!(second["worker:local"].token, "fixture-helper-149");
        vault.delete("local").unwrap();
        assert!(
            load_with(&path, Box::new(vault.clone())).unwrap().0["local"]
                .token
                .is_empty()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
