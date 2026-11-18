//! Guarded JSON forwarding and credential-free media scheme URLs.
//! Requests stay within the configured origin and allowed path namespaces.

use super::*;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    AppHandle, Manager, UriSchemeResponder,
};
use url::Url;

pub(super) mod budget;
pub(super) mod cancel;
mod guards;
mod json;
mod local;
mod media;
mod ranges;
mod upstream;

use guards::media_target;
use local::{serve_art, serve_local};
use media::media_error;
#[cfg(test)]
use ranges::MAX_MEDIA_SLICE;
use ranges::{local_range, media_content_range, media_slice_range};
use upstream::fetch_media_response;

#[cfg(test)]
pub(super) use guards::tests;
pub(super) use guards::{is_backend_url, is_media_url, media_proxy_url, normalize_backend};
// Tauri resolves both generated macros through the registered command path.
pub use json::{__cmd__backend_request, __tauri_command_name_backend_request, backend_request};
pub use media::proxy_media_request;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRequest {
    url: String,
    request_id: Option<String>,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    body: Option<String>,
    #[serde(default)]
    body_bytes: Option<Vec<u8>>,
}

fn default_method() -> String {
    "GET".into()
}

/// The media namespace, relative to the backend path prefix.
pub(super) const MEDIA_ROUTE: &str = "/api/media";
