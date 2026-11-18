//! Device storage policy. No window, HTTP client, credential, or Tauri dependency.
pub mod outbox;
pub mod pins;
pub mod pools;
pub mod resolve;
pub mod snapshot;
pub mod store;
pub mod transfer;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub(crate) fn invalid(message: &str) -> Box<dyn std::error::Error + Send + Sync> {
    std::io::Error::other(message).into()
}

/// Shared policy; a later change implements the durable queue for these intents.
pub fn offline_action(action: &str) -> &'static str {
    match action {
        "library-add" | "library-remove" | "playlist-edit" | "play" => "queue",
        "pin" | "unpin" => "local",
        _ => "refuse",
    }
}
#[cfg(test)]
mod tests;
