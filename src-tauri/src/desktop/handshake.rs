//! `/api/status` handshakes: one address, every alternate of one nest
//! (`contracts/remote-access.json`), and a typed address from the chooser.

use super::Client;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use url::Url;

use super::connection::LastError;
use super::prefs::NestNetwork;

#[derive(Clone, Debug)]
pub(super) struct ProbeFailure {
    pub code: Option<LastError>,
    pub text: String,
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.text.fmt(f)
    }
}

impl From<&str> for ProbeFailure {
    fn from(text: &str) -> Self {
        Self {
            code: Some(if text == "not-krobi" {
                LastError::NotKrobi
            } else {
                LastError::BadBody
            }),
            text: text.into(),
        }
    }
}
use super::proxy::normalize_backend;
use super::*;

/// Reuse the async client so periodic probes cannot block media/JSON workers
/// or create a new HTTP runtime for every poll.
pub(super) async fn probe(http: &Client, base: &str) -> Option<ServerIdentity> {
    probe_detailed(http, base).await.ok()
}

/// Preserve probe failures so logs distinguish network readiness, privacy
/// denial, and timeouts instead of reducing every failure to None.
pub(super) async fn probe_detailed(
    http: &Client,
    base: &str,
) -> Result<ServerIdentity, ProbeFailure> {
    let response = http
        .get(format!("{base}/api/status"))
        .timeout(Duration::from_millis(1500))
        .send()
        .await
        .map_err(|error| describe_request_error(&error))?;
    super::http_log::received(&reqwest::Method::GET, "/api/status", &response);
    if !response.status().is_success() {
        return Err("not-krobi".into());
    }
    let body: Value = response.json().await.map_err(|error| {
        let failure = describe_request_error(&error);
        if failure.code.is_some() {
            failure
        } else {
            ProbeFailure::from("unreadable-body")
        }
    })?;
    if body.get("app").and_then(Value::as_str) != Some("krobi") {
        return Err("not-krobi".into());
    }
    Ok(ServerIdentity {
        body: body.clone(),
        instance_id: body
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        pid: body
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        identified: body.get("instanceId").and_then(Value::as_str).is_some(),
        name: body
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        version: body
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// The OS-level cause of a failed request: `timeout`, or the innermost
/// `io::Error` with its errno (`No route to host (os error 65)`), which is
/// what tells a privacy refusal from a network that is not up yet.
pub(super) fn describe_request_error(error: &reqwest::Error) -> ProbeFailure {
    if error.is_timeout() {
        return ProbeFailure {
            code: Some(LastError::Timeout),
            text: super::http_log::error(error),
        };
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    let mut io: Option<&std::io::Error> = None;
    let mut closed = false;
    while let Some(current) = source {
        if let Some(found) = current.downcast_ref::<std::io::Error>() {
            io = Some(found);
        }
        let message = current.to_string().to_ascii_lowercase();
        closed |= [
            "connection closed",
            "connection reset",
            "connection aborted",
            "broken pipe",
            "end of file before message length reached",
        ]
        .iter()
        .any(|text| message.contains(text));
        source = current.source();
    }
    ProbeFailure {
        code: io
            .and_then(classify_io_error)
            .or_else(|| (error.is_connect() || closed).then_some(LastError::ConnectionLost)),
        text: super::http_log::error(error),
    }
}

/// Darwin errno values from the launch failures, plus Linux/Windows socket
/// equivalents. ErrorKind covers synthesized errors and other platforms.
pub(super) fn classify_io_error(error: &std::io::Error) -> Option<LastError> {
    use std::io::ErrorKind;
    match error.raw_os_error() {
        Some(65 | 113 | 10065) => Some(LastError::RefusedRoute),
        Some(51 | 101 | 10051) => Some(LastError::NoNetwork),
        Some(61 | 111 | 10061) => Some(LastError::RefusedPort),
        Some(54 | 32 | 53 | 104 | 103 | 10054 | 10053) => Some(LastError::ConnectionLost),
        Some(60 | 110 | 10060) => Some(LastError::Timeout),
        _ => match error.kind() {
            ErrorKind::HostUnreachable => Some(LastError::RefusedRoute),
            ErrorKind::NetworkUnreachable => Some(LastError::NoNetwork),
            ErrorKind::ConnectionRefused => Some(LastError::RefusedPort),
            ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::UnexpectedEof
            | ErrorKind::BrokenPipe => Some(LastError::ConnectionLost),
            ErrorKind::TimedOut => Some(LastError::Timeout),
            _ => None,
        },
    }
}

/// Classify an optional handshake against the expected server identity.
/// Shared cases live in contracts/remote-access.json.
pub(super) fn probe_verdict(expected_instance_id: &str, answer: Option<&Value>) -> &'static str {
    let Some(body) = answer else {
        return "unreachable";
    };
    if body.get("app").and_then(Value::as_str) != Some("krobi") {
        return "not-krobi";
    }
    if body.get("instanceId").and_then(Value::as_str) == Some(expected_instance_id) {
        "same-nest"
    } else {
        "other-nest"
    }
}

/// Every address one nest may answer on, in contract order: the configured
/// one, every `lan`, `tailscale`, `externalUrl` — normalised, duplicates dropped.
pub(super) fn nest_candidates(primary: &str, network: Option<&NestNetwork>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let url = normalize_backend(raw).unwrap_or_else(|| raw.trim().to_string());
        if !url.is_empty() && !out.contains(&url) {
            out.push(url);
        }
    };
    push(primary);
    if let Some(network) = network {
        network.lan.iter().for_each(|url| push(url));
        network.tailscale.iter().for_each(|url| push(url));
        network.external_url.iter().for_each(|url| push(url));
    }
    out
}

/// Contract `pick`: the first candidate whose `/api/status` carried the
/// nest's `instanceId`. `answers` maps an address to the id it answered with;
/// an address that did not answer is absent. Pure, so every contract case
/// runs as a unit test; the probing that fills `answers` is `probe_all`.
pub(super) fn pick_address(
    primary: &str,
    network: Option<&NestNetwork>,
    expected_instance_id: &str,
    answers: &BTreeMap<String, String>,
) -> Option<String> {
    nest_candidates(primary, network)
        .into_iter()
        .find(|url| answers.get(url).map(String::as_str) == Some(expected_instance_id))
}

/// `GET /api/server/network` → what `pick` needs. `tailscale` is an object on
/// the wire (`{ip, name, url}`); a bare string is accepted too. Anything that
/// is not an http(s) origin is dropped rather than stored and probed forever.
pub(super) fn network_from_body(body: &Value) -> NestNetwork {
    let url = |value: Option<&Value>| value.and_then(Value::as_str).and_then(normalize_backend);
    NestNetwork {
        lan: body
            .get("lan")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| url(Some(item))).collect())
            .unwrap_or_default(),
        tailscale: body.get("tailscale").and_then(|value| match value {
            Value::Object(_) => url(value.get("url")),
            other => url(Some(other)),
        }),
        external_url: url(body.get("externalUrl")),
    }
}

/// Probe every candidate at once, so a startup with three dead addresses costs
/// one 1.5 s timeout, not three. Order is restored by the caller (`pick`).
pub(super) async fn probe_all(
    http: &Client,
    bases: &[String],
) -> Vec<(String, Result<ServerIdentity, ProbeFailure>)> {
    let handles: Vec<_> = bases
        .iter()
        .map(|base| {
            let http = http.clone();
            let base = base.clone();
            tauri::async_runtime::spawn(async move {
                let found = probe_detailed(&http, &base).await;
                (base, found)
            })
        })
        .collect();
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(answer) = handle.await {
            out.push(answer);
        }
    }
    out
}

pub(super) async fn probe_address(state: &DesktopState, raw: &str) -> Value {
    let typed = raw.trim();
    if typed.is_empty() {
        return json!({"ok": false, "reason": "invalid-address"});
    }
    let explicit = typed.contains("://");
    let mut candidates = Vec::new();
    if explicit {
        let Some(url) = normalize_backend(typed) else {
            return json!({"ok": false, "reason": "invalid-address"});
        };
        candidates.push(url);
    } else {
        for scheme in ["https", "http"] {
            let candidate = format!("{scheme}://{typed}");
            let Ok(mut url) = Url::parse(&candidate) else {
                return json!({"ok": false, "reason": "invalid-address"});
            };
            if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
                return json!({"ok": false, "reason": "invalid-address"});
            }
            if url.port().is_none() {
                let _ = url.set_port(Some(DEFAULT_PORT));
            }
            candidates.push(url.as_str().trim_end_matches('/').to_string());
        }
    }
    for (index, base) in candidates.iter().enumerate() {
        let result = state
            .http
            .get(format!("{base}/api/status"))
            .timeout(Duration::from_secs(4))
            .send()
            .await;
        let Ok(response) = result else {
            if !explicit && index == 0 {
                continue;
            }
            return json!({"ok": false, "reason": "unreachable"});
        };
        if !response.status().is_success() {
            return json!({"ok": false, "reason": "not-our-server"});
        }
        let Ok(body) = response.json::<Value>().await else {
            return json!({"ok": false, "reason": "not-our-server"});
        };
        if body.get("app").and_then(Value::as_str) != Some("krobi") {
            return json!({"ok": false, "reason": "not-our-server"});
        }
        return json!({"ok": true, "url": base, "handshake": body});
    }
    json!({"ok": false, "reason": "unreachable"})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_access_contract() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../contracts/remote-access.json");
        serde_json::from_slice(&std::fs::read(&path).expect("contracts/remote-access.json"))
            .expect("contract is JSON")
    }

    #[test]
    fn contract_probe_cases() {
        let contract = remote_access_contract();
        let cases = contract["probe"].as_array().expect("probe cases");
        assert!(!cases.is_empty());
        for case in cases {
            let answer = (!case["answer"].is_null()).then_some(&case["answer"]);
            assert_eq!(
                probe_verdict(case["instanceId"].as_str().unwrap(), answer),
                case["out"].as_str().unwrap(),
                "{}",
                case["case"]
            );
        }
    }

    #[test]
    fn contract_pick_cases() {
        let contract = remote_access_contract();
        let cases = contract["pick"].as_array().expect("pick cases");
        assert!(!cases.is_empty());
        for case in cases {
            let network: Option<NestNetwork> =
                serde_json::from_value(case["network"].clone()).expect("network");
            let answers: BTreeMap<String, String> =
                serde_json::from_value(case["answers"].clone()).expect("answers");
            assert_eq!(
                pick_address(
                    case["primary"].as_str().unwrap(),
                    network.as_ref(),
                    case["instanceId"].as_str().unwrap(),
                    &answers,
                ),
                case["out"].as_str().map(str::to_owned),
                "{}",
                case["case"]
            );
        }
    }

    #[test]
    fn candidates_keep_contract_order_and_drop_duplicates() {
        let network = NestNetwork {
            lan: vec![
                "http://192.168.1.20:8000/".into(),
                "http://10.0.0.5:8000".into(),
            ],
            tailscale: Some("http://100.101.1.2:8000".into()),
            external_url: Some("https://musica.ejemplo.com".into()),
        };
        assert_eq!(
            nest_candidates("http://192.168.1.20:8000", Some(&network)),
            [
                "http://192.168.1.20:8000",
                "http://10.0.0.5:8000",
                "http://100.101.1.2:8000",
                "https://musica.ejemplo.com",
            ]
        );
    }

    #[test]
    fn network_body_is_reduced_to_addresses() {
        let body = json!({
            "lan": ["http://192.168.1.20:8000", "not a url", "ftp://x"],
            "tailscale": {"ip": "100.101.1.2", "name": "krobi.tail.ts.net", "url": "http://100.101.1.2:8000"},
            "externalUrl": "https://musica.ejemplo.com/"
        });
        assert_eq!(
            network_from_body(&body),
            NestNetwork {
                lan: vec!["http://192.168.1.20:8000".into()],
                tailscale: Some("http://100.101.1.2:8000".into()),
                external_url: Some("https://musica.ejemplo.com".into()),
            }
        );
        let bare = network_from_body(&json!({"lan": [], "tailscale": null, "externalUrl": null}));
        assert_eq!(bare, NestNetwork::default());
    }
}
