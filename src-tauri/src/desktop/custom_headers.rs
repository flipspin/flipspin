//! Origin-scoped proxy secrets share the device credential vault/file policy.
//! All shell HTTP transports use Client; redirects never forward these secrets.
use super::*;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    IntoUrl, Method, RequestBuilder,
};
use std::sync::{Arc, RwLock};

const PREFIX: &str = "headers:";
type Secrets = BTreeMap<String, String>;

#[derive(Clone)]
pub(super) struct Client {
    inner: reqwest::Client,
    headers: Arc<RwLock<BTreeMap<String, HeaderMap>>>,
}
pub(super) struct Builder(reqwest::ClientBuilder);
impl Builder {
    pub(super) fn redirect(self, policy: reqwest::redirect::Policy) -> Self {
        Self(self.0.redirect(policy))
    }
    pub(super) fn timeout(self, timeout: Duration) -> Self {
        Self(self.0.timeout(timeout))
    }
    #[cfg(test)]
    pub(super) fn no_proxy(self) -> Self {
        Self(self.0.no_proxy())
    }
    pub(super) fn build(self) -> Result<Client, reqwest::Error> {
        Ok(Client {
            inner: self.0.build()?,
            headers: Arc::default(),
        })
    }
}
impl Client {
    pub(super) fn builder() -> Builder {
        Builder(reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()))
    }
    #[cfg(test)]
    pub(super) fn new() -> Self {
        Self::builder().build().unwrap()
    }
    /// Dedicated SSE pool; share vault headers, never JSON admission or timeouts.
    pub(super) fn event_client(&self) -> Result<Self, reqwest::Error> {
        Ok(Self {
            inner: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(45))
                .build()?,
            headers: self.headers.clone(),
        })
    }
    /// Streaming downloads have an idle deadline, never a total deadline.
    pub(super) fn download_client(&self) -> Result<Self, reqwest::Error> {
        Ok(Self {
            inner: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(30))
                .build()?,
            headers: self.headers.clone(),
        })
    }
    pub(super) fn request(&self, method: Method, url: impl IntoUrl) -> RequestBuilder {
        match url.into_url() {
            Ok(url) => self
                .inner
                .request(method, url.clone())
                .headers(self.headers_for(url.as_str())),
            Err(_) => self.inner.request(method, "invalid URL"),
        }
    }
    pub(super) fn get(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::GET, url)
    }
    pub(super) fn post(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::POST, url)
    }
    pub(super) fn head(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::HEAD, url)
    }
    pub(super) fn patch(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::PATCH, url)
    }
    pub(super) fn headers_for(&self, url: &str) -> HeaderMap {
        let Ok(target) = url::Url::parse(url) else {
            return HeaderMap::new();
        };
        self.headers
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(base, _)| {
                url::Url::parse(base).is_ok_and(|base| super::proxy::is_backend_url(&target, &base))
            })
            .max_by_key(|(base, _)| base.len())
            .map(|(_, headers)| headers.clone())
            .unwrap_or_default()
    }
    pub(super) fn redact(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for headers in self
            .headers
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            for value in headers
                .values()
                .filter_map(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
            {
                text = text.replace(value, "[REDACTED]");
                if let Ok(escaped) = serde_json::to_string(value) {
                    text = text.replace(&escaped[1..escaped.len() - 1], "[REDACTED]");
                }
            }
        }
        text
    }
    pub(super) fn restore(&self, credentials: &BTreeMap<String, Credential>) -> ShellResult<()> {
        let mut next = BTreeMap::new();
        for (key, credential) in credentials {
            if let Some(origin) = key.strip_prefix(PREFIX) {
                if credential.token.is_empty() {
                    continue;
                }
                let values: Secrets = serde_json::from_str(&credential.token)
                    .map_err(|_| ShellError::Guard("invalid-custom-headers"))?;
                next.insert(origin.to_owned(), validate(&values)?);
            }
        }
        *self.headers.write().unwrap_or_else(|e| e.into_inner()) = next;
        Ok(())
    }
}

fn validate(values: &Secrets) -> ShellResult<HeaderMap> {
    if values.len() > 64 {
        return Err(ShellError::Guard("invalid-custom-headers"));
    }
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| ShellError::Guard("invalid-header-name"))?;
        if matches!(
            name.as_str(),
            "host"
                | "authorization"
                | "cookie"
                | "content-length"
                | "connection"
                | "transfer-encoding"
        ) || name.as_str().starts_with("x-krobi-")
        {
            return Err(ShellError::Guard("reserved-header-name"));
        }
        let mut value =
            HeaderValue::from_str(value).map_err(|_| ShellError::Guard("invalid-header-value"))?;
        value.set_sensitive(true);
        if headers.insert(name, value).is_some() {
            return Err(ShellError::Guard("duplicate-header-name"));
        }
    }
    Ok(headers)
}

fn origin(state: &DesktopState, request: Option<&Value>) -> ShellResult<String> {
    let raw = request
        .and_then(|r| r["origin"].as_str())
        .map(str::to_owned)
        .unwrap_or(state.runtime()?.configured_origin.clone());
    normalize_backend(&raw).ok_or(ShellError::Guard("invalid-address"))
}

pub(super) fn describe(state: &DesktopState, request: Option<&Value>) -> ShellResult<Value> {
    let origin = origin(state, request)?;
    Ok(json_names(&state.http.headers_for(&origin)))
}
fn json_names(headers: &HeaderMap) -> Value {
    serde_json::json!(headers
        .keys()
        .map(|name| serde_json::json!({"name": name.as_str(), "set": true}))
        .collect::<Vec<_>>())
}

pub(super) fn save(state: &DesktopState, request: Option<&Value>) -> ShellResult<Value> {
    let origin = origin(state, request)?;
    let mut runtime = state.runtime()?;
    let key = format!("{PREFIX}{origin}");
    let previous: Secrets = runtime
        .credentials
        .get(&key)
        .and_then(|c| serde_json::from_str(&c.token).ok())
        .unwrap_or_default();
    let rows = request
        .and_then(|r| r["headers"].as_array())
        .ok_or(ShellError::Guard("invalid-custom-headers"))?;
    let mut values = Secrets::new();
    for row in rows {
        let name = row["name"]
            .as_str()
            .ok_or(ShellError::Guard("invalid-header-name"))?
            .to_ascii_lowercase();
        let value = match row.get("value").and_then(Value::as_str) {
            Some(value) => value.to_owned(),
            None => previous
                .get(&name)
                .cloned()
                .ok_or(ShellError::Guard("header-value-required"))?,
        };
        if values.insert(name, value).is_some() {
            return Err(ShellError::Guard("duplicate-header-name"));
        }
    }
    let headers = validate(&values)?;
    let mut next = runtime.credentials.clone();
    next.insert(
        key,
        Credential {
            token: serde_json::to_string(&values)?,
            ..Default::default()
        },
    );
    runtime
        .credential_storage
        .save(&state.credentials_path(), &next)?;
    state.http.restore(&next)?;
    runtime.credentials = next;
    drop(runtime);
    state.retry_connection();
    Ok(json_names(&headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(origin: &str, value: &str) -> BTreeMap<String, Credential> {
        BTreeMap::from([(
            format!("{PREFIX}{origin}"),
            Credential {
                token: serde_json::json!({"cf-access-client-secret":value}).to_string(),
                ..Default::default()
            },
        )])
    }
    #[test]
    fn validates_names_values_duplicates_and_masks_debug_and_logs() {
        for name in [
            "",
            "bad name",
            "bad:header",
            "bad\r\nx",
            "höst",
            "Host",
            "AUTHORIZATION",
            "Cookie",
            "Content-Length",
            "X-Krobi-Setup-Token",
            "x-krobi-anything",
            "Transfer-Encoding",
        ] {
            assert!(
                validate(&BTreeMap::from([(name.into(), "private-value".into())])).is_err(),
                "{name}"
            );
        }
        assert!(validate(&BTreeMap::from([("x-secret".into(), "a\r\nb".into())])).is_err());
        assert!(validate(&BTreeMap::from([
            ("X-Secret".into(), "one".into()),
            ("x-secret".into(), "two".into())
        ]))
        .is_err());
        let client = Client::new();
        client
            .restore(&fixture("https://nest.example/krobi", "private-value"))
            .unwrap();
        let request = client
            .get("https://nest.example/krobi/api/me")
            .build()
            .unwrap();
        assert_eq!(
            request.headers()["cf-access-client-secret"],
            "private-value"
        );
        assert!(!format!("{request:?}").contains("private-value"));
        assert!(!client
            .redact("secret=private-value")
            .contains("private-value"));
    }
    #[test]
    fn origin_and_path_isolation_and_clones_see_edits_and_removals() {
        let client = Client::new();
        let clone = client.clone();
        let mut credentials = fixture("https://nest.example/krobi", "one");
        credentials.extend(fixture("https://other.example", "two"));
        client.restore(&credentials).unwrap();
        for url in [
            "http://nest.example/krobi/api/status",
            "https://nest.example:444/krobi/api/status",
            "https://nest.example/krobix/api/status",
            "https://nest.example/api/status",
            "https://user@nest.example/krobi/api/status",
            "https://nest.example.evil/krobi/api/status",
        ] {
            assert!(
                !clone
                    .get(url)
                    .build()
                    .unwrap()
                    .headers()
                    .contains_key("cf-access-client-secret"),
                "{url}"
            );
        }
        assert_eq!(
            clone
                .get("https://other.example/api/status")
                .build()
                .unwrap()
                .headers()["cf-access-client-secret"],
            "two"
        );
        client.restore(&BTreeMap::new()).unwrap();
        assert!(clone
            .get("https://other.example/api/status")
            .build()
            .unwrap()
            .headers()
            .is_empty());
    }
    #[test]
    fn editor_preserves_unedited_secrets_removes_rows_and_isolates_origins() {
        let dir = std::env::temp_dir().join(format!("krobi-headers-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = DesktopState {
            app_dir: dir.clone(),
            http: Client::new(),
            runtime: Mutex::new(crate::desktop::tests::remote_runtime(
                "https://nest.example",
                "https://nest.example",
            )),
            preferences_file: Mutex::new(()),
            connection_wake: tokio::sync::Notify::new(),
            events: crate::desktop::events::Control::default(),
            status_changed: Box::new(|_| {}),
            offline: Mutex::new(super::super::offline::test_store()),
        };
        let edit = serde_json::json!({"headers":[{"name":"X-Secret","value":"private-value"}]});
        let view = save(&state, Some(&edit)).unwrap();
        assert_eq!(view, serde_json::json!([{"name":"x-secret","set":true}]));
        assert!(!std::fs::read_to_string(dir.join("credentials.json"))
            .unwrap()
            .contains("private-value"));
        save(
            &state,
            Some(&serde_json::json!({"headers":[{"name":"x-secret"}]})),
        )
        .unwrap();
        assert_eq!(
            state.http.headers_for("https://nest.example/api/status")["x-secret"],
            "private-value"
        );
        assert!(save(
            &state,
            Some(&serde_json::json!({"headers":[{"name":"Authorization","value":"bad"}]}))
        )
        .is_err());
        save(&state, Some(&serde_json::json!({"origin":"https://other.example", "headers":[{"name":"x-secret","value":"other-value"}]}))).unwrap();
        assert_eq!(
            state.http.headers_for("https://nest.example/api/status")["x-secret"],
            "private-value"
        );
        save(&state, Some(&serde_json::json!({"headers":[]}))).unwrap();
        assert!(describe(&state, None)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            state.http.headers_for("https://other.example/api/status")["x-secret"],
            "other-value"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn probe_receives_secret_and_redirect_does_not_forward_it() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let location = format!("http://{}/stolen", other.local_addr().unwrap());
        other.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            for reply in [r#"{"app":"krobi","instanceId":"fixture"}"#, ""] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                while !bytes.ends_with(b"\r\n\r\n") {
                    let mut b = [0];
                    socket.read_exact(&mut b).unwrap();
                    bytes.push(b[0]);
                }
                assert!(String::from_utf8(bytes)
                    .unwrap()
                    .contains("cf-access-client-secret: private-value\r\n"));
                if reply.is_empty() {
                    write!(socket, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                } else {
                    write!(
                        socket,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    )
                    .unwrap();
                }
            }
        });
        let client = Client::builder().no_proxy().build().unwrap();
        client.restore(&fixture(&origin, "private-value")).unwrap();
        assert!(super::super::handshake::probe(&client, &origin)
            .await
            .is_some());
        assert_eq!(
            client
                .get(format!("{origin}/api/me"))
                .send()
                .await
                .unwrap()
                .status(),
            302
        );
        server.join().unwrap();
        assert_eq!(
            other.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
