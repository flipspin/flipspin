//! Exclusive, private creation; no window where a secret has public permissions.
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(super) fn create(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!("{:032x}.tmp", rand::random::<u128>()));
    let result = create(&temp, bytes).and_then(|()| fs::rename(&temp, path));
    let _ = fs::remove_file(temp);
    result
}

/// Owns the transient handoff, including cleanup on spawn failure and shutdown.
pub(super) struct CredentialDirectory(PathBuf);
impl CredentialDirectory {
    pub(super) fn new(key: &str) -> io::Result<Self> {
        let path =
            std::env::temp_dir().join(format!("krobi-credentials-{:032x}", rand::random::<u128>()));
        // Only Unix sets a mode on the builder.
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path)?;
        let directory = Self(path);
        create(&directory.0.join("krobi-key"), key.as_bytes())?;
        Ok(directory)
    }
    pub(super) fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for CredentialDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != io::ErrorKind::NotFound {
                log::warn!("could not remove transient backend credential directory");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handoff_is_private_and_removed_when_released() {
        let directory = CredentialDirectory::new("fixture-nest-secret").unwrap();
        let path = directory.path().to_owned();
        assert_eq!(
            fs::read_to_string(path.join("krobi-key")).unwrap(),
            "fixture-nest-secret"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(path.join("krobi-key"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(directory);
        assert!(!path.exists());
    }

    #[test]
    fn creation_cannot_overwrite_an_existing_file() {
        let directory = CredentialDirectory::new("original").unwrap();
        assert!(create(&directory.path().join("krobi-key"), b"replacement").is_err());
        assert_eq!(
            fs::read_to_string(directory.path().join("krobi-key")).unwrap(),
            "original"
        );
    }
}
