//! This computer on the LAN: its address for a pairing QR, its name, and the
//! `_krobi._tcp` nests other computers advertise (`server:discover`).

use super::Client;
use serde_json::{json, Value};
use std::{collections::HashSet, net::Ipv4Addr, time::Duration};

use super::handshake::probe;
use super::*;

/// The DNS-SD type a claimed Flipspin server advertises (`backend/app/core/discovery.py`).
pub(super) const NEST_SERVICE_TYPE: &str = "_krobi._tcp.local.";

/// How long `server:discover` listens. mDNS answers on a quiet LAN arrive in
/// well under a second; two leaves room for a sleepy Wi-Fi radio without
/// making the "Where is your nest?" screen feel stuck.
pub(super) const DISCOVERY_WINDOW: Duration = Duration::from_secs(2);

/// One IPv4 interface address, reduced to what `pick_lan_ipv4` judges.
#[derive(Clone, Debug)]
pub(super) struct LanCandidate {
    name: String,
    ip: Ipv4Addr,
    up: bool,
    point_to_point: bool,
}

/// Interface-name prefixes that are never the LAN another device can reach:
/// VPN tunnels (utun, WireGuard, Tailscale, ZeroTier), Apple's peer-to-peer
/// radios (awdl, llw), and hypervisor/container bridges. A QR carrying a
/// Docker bridge address is as useless as one carrying 127.0.0.1.
pub(super) const VIRTUAL_INTERFACE_PREFIXES: &[&str] = &[
    "utun",
    "tun",
    "tap",
    "wg",
    "tailscale",
    "zt",
    "awdl",
    "llw",
    "bridge",
    "vmnet",
    "vboxnet",
    "docker",
    "veth",
    "virbr",
    "br-",
    "ppp",
    "ipsec",
    "gif",
    "stf",
    "anpi",
];

/// The address other devices on the LAN should use to reach this computer.
///
/// Prefers an RFC 1918 address (home routers hand those out) on a physical
/// interface; `en*`/`eth*`/`wl*` beat other names because a Mac lists
/// Thunderbolt bridges and the like beside its Wi-Fi. Loopback, link-local
/// (169.254 — no DHCP answered), down and point-to-point interfaces are never
/// candidates. A public address on a physical interface is the last resort.
pub(super) fn pick_lan_ipv4(candidates: &[LanCandidate]) -> Option<Ipv4Addr> {
    candidates
        .iter()
        .filter(|item| {
            item.up
                && !item.point_to_point
                && !item.ip.is_loopback()
                && !item.ip.is_link_local()
                && !item.ip.is_unspecified()
                && !VIRTUAL_INTERFACE_PREFIXES
                    .iter()
                    .any(|prefix| item.name.starts_with(prefix))
        })
        .min_by_key(|item| {
            let physical = ["en", "eth", "wl"]
                .iter()
                .any(|prefix| item.name.starts_with(prefix));
            (!item.ip.is_private(), !physical, item.name.clone())
        })
        .map(|item| item.ip)
}

pub(super) fn lan_url() -> Option<String> {
    let candidates: Vec<LanCandidate> = if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            std::net::IpAddr::V4(ip) => Some(LanCandidate {
                up: interface.is_oper_up(),
                point_to_point: interface.is_p2p(),
                name: interface.name,
                ip,
            }),
            std::net::IpAddr::V6(_) => None,
        })
        .collect();
    pick_lan_ipv4(&candidates).map(|ip| format!("http://{ip}:{DEFAULT_PORT}"))
}

/// The connection diagnostic requires a private physical LAN, even when the
/// pairing URL's public-address fallback would be usable.
pub(super) fn private_lan_ip() -> Option<String> {
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .find_map(|interface| {
            let std::net::IpAddr::V4(ip) = interface.ip() else {
                return None;
            };
            (ip.is_private()
                && !ip.is_loopback()
                && interface.is_oper_up()
                && !interface.is_p2p()
                && !VIRTUAL_INTERFACE_PREFIXES
                    .iter()
                    .any(|prefix| interface.name.starts_with(prefix)))
            .then(|| format!("{}: {ip}", interface.name))
        })
}

/// The DNS-SD instance label of a resolved service: `Music._krobi._tcp.local.`
/// → `Music`. Used only when neither `/api/status` nor the TXT record
/// carries a name.
pub(super) fn service_instance_name(fullname: &str, ty_domain: &str) -> String {
    fullname
        .strip_suffix(ty_domain)
        .map(|rest| rest.trim_end_matches('.'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(fullname)
        .to_string()
}

/// A nest heard over mDNS, before its `/api/status` has confirmed it.
pub(super) struct HeardNest {
    /// Candidate base URLs, private addresses first.
    urls: Vec<String>,
    txt_name: Option<String>,
    instance_name: String,
}

/// Listen for `_krobi._tcp` for `DISCOVERY_WINDOW` on a blocking thread.
/// Any failure (no multicast, sandbox, permission) is an empty list: the
/// chooser always has the typed-address fallback, so discovery must never be
/// the reason the screen errors.
pub(super) fn browse_nests() -> Vec<HeardNest> {
    let Ok(daemon) = mdns_sd::ServiceDaemon::new() else {
        return Vec::new();
    };
    let Ok(receiver) = daemon.browse(NEST_SERVICE_TYPE) else {
        let _ = daemon.shutdown();
        return Vec::new();
    };
    let deadline = std::time::Instant::now() + DISCOVERY_WINDOW;
    let mut heard: Vec<HeardNest> = Vec::new();
    let mut seen = HashSet::new();
    while let Ok(event) = receiver.recv_deadline(deadline) {
        let mdns_sd::ServiceEvent::ServiceResolved(service) = event else {
            continue;
        };
        if !seen.insert(service.fullname.clone()) {
            continue;
        }
        let mut addresses: Vec<Ipv4Addr> = service
            .get_addresses_v4()
            .into_iter()
            .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
            .collect();
        addresses.sort_by_key(|ip| (!ip.is_private(), ip.is_link_local(), *ip));
        if addresses.is_empty() {
            continue;
        }
        heard.push(HeardNest {
            urls: addresses
                .iter()
                .map(|ip| format!("http://{ip}:{}", service.port))
                .collect(),
            txt_name: service
                .get_property_val_str("name")
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned),
            instance_name: service_instance_name(&service.fullname, &service.ty_domain),
        });
    }
    let _ = daemon.stop_browse(NEST_SERVICE_TYPE);
    let _ = daemon.shutdown();
    heard
}

/// Confirm mDNS advertisements with a Flipspin handshake before listing servers.
/// Deduplicate instanceId across interfaces; mDNS alone proves no server identity.
pub(super) async fn discover_nests(http: &Client) -> Value {
    let heard = tauri::async_runtime::spawn_blocking(browse_nests)
        .await
        .unwrap_or_default();
    let mut tasks = Vec::new();
    for nest in heard {
        let http = http.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            for url in &nest.urls {
                if let Some(found) = probe(&http, url).await {
                    let name = found
                        .name
                        .clone()
                        .or_else(|| nest.txt_name.clone())
                        .unwrap_or_else(|| nest.instance_name.clone());
                    return Some((url.clone(), name, found));
                }
            }
            None
        }));
    }
    let mut nests = Vec::new();
    let mut seen = HashSet::new();
    for task in tasks {
        let Ok(Some((url, name, found))) = task.await else {
            continue;
        };
        // An older server without an instanceId is deduplicated by address.
        let key = found.instance_id.clone().unwrap_or_else(|| url.clone());
        if !seen.insert(key) {
            continue;
        }
        nests.push(json!({
            "url": url,
            "name": name,
            "instanceId": found.instance_id,
            "version": found.version,
        }));
    }
    json!({"nests": nests})
}

/// Use the chosen macOS Computer Name for device labels; hostnames are
/// DNS-normalized and may lose the person's intended spelling.
pub(crate) fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
    {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if output.status.success() && !name.is_empty() {
            return name;
        }
    }
    let host = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_string();
    let host = host.strip_suffix(".local").unwrap_or(&host).to_string();
    if host.is_empty() {
        "Flipspin".into()
    } else {
        host
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lan(name: &str, ip: [u8; 4]) -> LanCandidate {
        LanCandidate {
            name: name.into(),
            ip: Ipv4Addr::from(ip),
            up: true,
            point_to_point: false,
        }
    }

    #[test]
    fn lan_address_is_a_private_physical_interface() {
        let cases: &[(Vec<LanCandidate>, Option<[u8; 4]>)] = &[
            (
                vec![
                    lan("lo0", [127, 0, 0, 1]),
                    lan("utun3", [10, 8, 0, 2]),
                    lan("bridge100", [192, 168, 64, 1]),
                    lan("en0", [192, 168, 8, 40]),
                ],
                Some([192, 168, 8, 40]),
            ),
            // Link-local means DHCP never answered; a CGNAT VPN address is
            // not RFC 1918 and loses to a real LAN one.
            (
                vec![
                    lan("en7", [169, 254, 3, 3]),
                    lan("en5", [100, 101, 1, 1]),
                    lan("en1", [10, 0, 0, 9]),
                ],
                Some([10, 0, 0, 9]),
            ),
            (
                vec![
                    LanCandidate {
                        up: false,
                        ..lan("en0", [192, 168, 1, 2])
                    },
                    LanCandidate {
                        point_to_point: true,
                        ..lan("en9", [172, 16, 0, 2])
                    },
                ],
                None,
            ),
            // Private beats physical-looking; physical breaks the tie.
            (
                vec![
                    lan("en0", [203, 0, 113, 7]),
                    lan("feth0", [172, 20, 0, 4]),
                    lan("en1", [172, 20, 0, 5]),
                ],
                Some([172, 20, 0, 5]),
            ),
            (vec![lan("lo0", [127, 0, 0, 1])], None),
        ];
        for (candidates, expected) in cases {
            assert_eq!(
                pick_lan_ipv4(candidates),
                expected.map(Ipv4Addr::from),
                "{candidates:?}"
            );
        }
    }

    #[test]
    fn service_name_falls_back_to_the_dns_sd_instance_label() {
        assert_eq!(
            service_instance_name("Nido de Mac._krobi._tcp.local.", "_krobi._tcp.local."),
            "Nido de Mac"
        );
        assert_eq!(
            service_instance_name("odd.example.", "_krobi._tcp.local."),
            "odd.example."
        );
    }
}
