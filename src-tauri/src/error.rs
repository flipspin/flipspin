//! Shared shell failures. IPC deliberately exposes only the legacy Display string.

use serde::{Serialize, Serializer};
use std::{
    fmt, io,
    sync::{Mutex, MutexGuard},
};

pub type ShellResult<T> = Result<T, ShellError>;

#[derive(Debug)]
pub enum ShellError {
    Poisoned(&'static str),
    Io(io::Error),
    IoContext { context: String, source: io::Error },
    Http(reqwest::Error),
    Json(serde_json::Error),
    Url(url::ParseError),
    Tauri(tauri::Error),
    Guard(&'static str),
    Message(String),
}

impl ShellError {
    pub fn io_context(context: impl Into<String>, source: io::Error) -> Self {
        Self::IoContext {
            context: context.into(),
            source,
        }
    }
}

impl fmt::Display for ShellError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Poisoned(what) => write!(f, "{what} state poisoned"),
            Self::Io(error) => error.fmt(f),
            Self::IoContext { context, source } => write!(f, "{context}: {source}"),
            Self::Http(error) => error.fmt(f),
            Self::Json(error) => error.fmt(f),
            Self::Url(error) => error.fmt(f),
            Self::Tauri(error) => error.fmt(f),
            Self::Guard(message) => f.write_str(message),
            Self::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ShellError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) | Self::IoContext { source: error, .. } => Some(error),
            Self::Http(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::Url(error) => Some(error),
            Self::Tauri(error) => Some(error),
            Self::Poisoned(_) | Self::Guard(_) | Self::Message(_) => None,
        }
    }
}

impl Serialize for ShellError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl From<io::Error> for ShellError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<reqwest::Error> for ShellError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl From<serde_json::Error> for ShellError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<url::ParseError> for ShellError {
    fn from(error: url::ParseError) -> Self {
        Self::Url(error)
    }
}

impl From<tauri::Error> for ShellError {
    fn from(error: tauri::Error) -> Self {
        Self::Tauri(error)
    }
}

impl From<String> for ShellError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&str> for ShellError {
    fn from(message: &str) -> Self {
        Self::Message(message.into())
    }
}

/// Name the state, rather than the individual mutex, to preserve IPC messages.
pub fn lock<'a, T>(mutex: &'a Mutex<T>, what: &'static str) -> ShellResult<MutexGuard<'a, T>> {
    mutex.lock().map_err(|_| ShellError::Poisoned(what))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    fn assert_wire(error: ShellError, expected: &str) {
        assert_eq!(error.to_string(), expected);
        assert_eq!(serde_json::to_value(&error).unwrap(), expected);
        assert_eq!(tauri::ipc::InvokeError::from(error).0, expected);
    }

    #[test]
    fn ipc_errors_remain_plain_legacy_strings() {
        assert_wire(ShellError::Poisoned("desktop"), "desktop state poisoned");
        assert_wire(ShellError::Poisoned("lyrics"), "lyrics state poisoned");
        for message in [
            "invalid-address",
            "blocked media path",
            "token-rejected",
            "account-required",
            "invalid-device-response",
            "invalid-worker-id",
            "network-denied",
            "nest-unreachable",
            "no-worker-source",
            "no-uv",
        ] {
            assert_wire(ShellError::Guard(message), message);
        }
        for message in [
            "unknown desktop channel: example",
            "worker-request-500",
            "media server returned 404 Not Found",
            "prefetch: no stdout",
            "uv pip install falló: first | last",
            "La descarga de modelos falló.",
            "arbitrary worker error\nwith \"quotes\"",
        ] {
            assert_wire(ShellError::Message(message.into()), message);
        }
    }

    #[test]
    fn library_conversions_keep_display_and_sources() {
        let io = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        let expected = io.to_string();
        let error = ShellError::from(io);
        assert!(matches!(&error, ShellError::Io(_)));
        assert!(error.source().is_some());
        assert_wire(error, &expected);

        let http = reqwest::Client::new().get("not a URL").build().unwrap_err();
        let expected = http.to_string();
        let error = ShellError::from(http);
        assert!(matches!(&error, ShellError::Http(_)));
        assert!(error.source().is_some());
        assert_wire(error, &expected);

        let json = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        let expected = json.to_string();
        let error = ShellError::from(json);
        assert!(matches!(&error, ShellError::Json(_)));
        assert!(error.source().is_some());
        assert_wire(error, &expected);

        let url = url::Url::parse("not a URL").unwrap_err();
        let expected = url.to_string();
        assert_wire(url.into(), &expected);

        let tauri = tauri::Error::Io(io::Error::other("native failure"));
        let expected = tauri.to_string();
        assert_wire(tauri.into(), &expected);
    }

    #[test]
    fn contextual_io_keeps_legacy_prefixes() {
        for context in [
            "could not migrate app data",
            "uv venv",
            "uv pip install",
            "prefetch",
        ] {
            let source = io::Error::other("original error");
            let expected = format!("{context}: {source}");
            let error = ShellError::io_context(context, source);
            assert!(error.source().is_some());
            assert_wire(error, &expected);
        }
    }

    #[test]
    fn lock_preserves_state_name_after_poisoning() {
        for what in ["desktop", "lyrics"] {
            let mutex = Mutex::new(());
            assert!(lock(&mutex, what).is_ok());
            let _ = std::panic::catch_unwind(|| {
                let _guard = mutex.lock().unwrap();
                panic!("poison the state");
            });
            let error = lock(&mutex, what).unwrap_err();
            assert!(matches!(&error, ShellError::Poisoned(name) if *name == what));
            assert_wire(error, &format!("{what} state poisoned"));
        }
    }
}
