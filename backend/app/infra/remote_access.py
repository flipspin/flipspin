"""Enumerate authenticated connection alternatives for the same server identity.

Keep deployment addresses off the public handshake; probes fail to empty results.
See docs/DEVELOPER_GUIDE.md#server-discovery-and-addresses.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from app.infra import discovery

logger = logging.getLogger(__name__)

#: Tailscale hands out addresses from the CGNAT shared space (RFC 6598).
TAILSCALE_NETWORK = ipaddress.IPv4Network("100.64.0.0/10")

#: How long ``tailscale status --json`` may take before the name is given up.
TAILSCALE_TIMEOUT_S = 2.0

#: How long a MagicDNS answer (or the lack of one) is reused.
TAILSCALE_NAME_TTL_S = 60.0

#: Where the CLI lives when it is not on PATH (the macOS app bundle).
_TAILSCALE_FALLBACK_PATHS = ("/Applications/Tailscale.app/Contents/MacOS/Tailscale",)

#: The four reason codes ``PUT /api/server/external-url`` answers 422 with. They
#: are the contract's strings, mapped to words by each client — never prose.
NEEDS_HTTPS = "needs-https"
HAS_PATH = "has-path"
HAS_CREDENTIALS = "has-credentials"
NOT_A_URL = "not-a-url"

# One DNS label: letters, digits and inner hyphens, 1–63 characters.
_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")


class ExternalUrlError(ValueError):
    """A typed domain that cannot be stored; ``code`` is the contract's reason."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _valid_host(host: str) -> bool:
    """A DNS name or an IP literal. Unicode names are checked as their IDNA form."""
    if not host or len(host) > 253:
        return False
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        pass
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    return all(_LABEL.match(label) for label in ascii_host.rstrip(".").split("."))


def normalise_external_url(value: str | None) -> str | None:
    """Normalize an HTTPS origin, or return None when cleared.

    Reject credentials, paths, queries and fragments with ExternalUrlError codes.
    The ordered cases are in contracts/remote-access.json; see
    docs/features/remote-access.md.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise ExternalUrlError(NOT_A_URL)
    text = value.strip()
    if not text:
        return None
    if any(ch.isspace() for ch in text):
        raise ExternalUrlError(NOT_A_URL)
    if "://" not in text:
        text = f"https://{text}"
    try:
        parts = urlsplit(text)
    except ValueError as e:
        raise ExternalUrlError(NOT_A_URL) from e
    if parts.scheme.lower() != "https":
        raise ExternalUrlError(NEEDS_HTTPS)
    if parts.username is not None or parts.password is not None:
        raise ExternalUrlError(HAS_CREDENTIALS)
    if parts.path not in ("", "/") or parts.query or parts.fragment or text.endswith(("?", "#")):
        raise ExternalUrlError(HAS_PATH)
    host = (parts.hostname or "").lower()
    if not _valid_host(host):
        raise ExternalUrlError(NOT_A_URL)
    try:
        port = parts.port
    except ValueError as e:
        raise ExternalUrlError(NOT_A_URL) from e
    if ":" in host:  # IPv6 literal; urlsplit drops the brackets
        host = f"[{host}]"
    return f"https://{host}" + (f":{port}" if port is not None else "")


# -- Tailscale ---------------------------------------------------------------


def is_tailscale_address(address: str) -> bool:
    try:
        return ipaddress.IPv4Address(address) in TAILSCALE_NETWORK
    except ValueError:
        return False


def _tailscale_binary() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    for candidate in _TAILSCALE_FALLBACK_PATHS:
        if shutil.which(candidate):
            return candidate
    return None


def _ask_magic_dns_name() -> str | None:
    """``Self.DNSName`` from ``tailscale status --json``, trailing dot dropped.

    ``None`` when the binary is absent, slow, failing or says nothing usable.
    Never raises.
    """
    binary = _tailscale_binary()
    if not binary:
        return None
    try:
        done = subprocess.run(
            [binary, "status", "--json"],
            capture_output=True,
            timeout=TAILSCALE_TIMEOUT_S,
            check=False,
        )
        if done.returncode != 0:
            return None
        status = json.loads(done.stdout.decode("utf-8", errors="replace"))
        name = (status.get("Self") or {}).get("DNSName")
    except Exception as e:  # noqa: BLE001 — a timeout, bad JSON, a stopped daemon
        logger.debug("tailscale status failed: %s", e)
        return None
    if not isinstance(name, str):
        return None
    name = name.strip().rstrip(".")
    return name or None


_name_lock = threading.Lock()
_name_cache: dict[str, tuple[float, str | None]] = {}


def magic_dns_name() -> str | None:
    """The cached MagicDNS name (or its absence), refreshed every minute."""
    now = time.monotonic()
    with _name_lock:
        cached = _name_cache.get("name")
        if cached is not None and now - cached[0] < TAILSCALE_NAME_TTL_S:
            return cached[1]
    name = _ask_magic_dns_name()
    with _name_lock:
        _name_cache["name"] = (time.monotonic(), name)
    return name


def clear_cache() -> None:
    global _topology_cache
    _topology_cache = None
    with _name_lock:
        _name_cache.clear()


# -- authenticated visits -----------------------------------------------------

_PRIVATE_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_topology_lock = threading.Lock()
_topology_cache: tuple[float, list[str], str | None] | None = None


def outside_via(client: str, networks: list[str], gateway: str | None, forwarded: bool) -> str:
    """Contract ``outsideVia``. Addresses are transient and never logged or stored."""
    try:
        address = ipaddress.ip_address(client)
    except ValueError:
        return "local"
    if address.is_loopback:
        return "local"
    if str(address) == gateway:
        return "vpn"
    if any(address in ipaddress.ip_network(n, strict=False) for n in networks):
        return "local"
    if is_tailscale_address(client):
        return "tailscale"
    if any(address in n for n in _PRIVATE_NETWORKS):
        return "vpn"
    return "proxy" if forwarded else "open-port"


def _default_gateway() -> str | None:
    """Best effort; never makes authentication depend on a platform command."""
    try:
        if sys.platform.startswith("linux"):
            for line in Path("/proc/net/route").read_text().splitlines()[1:]:
                fields = line.split()
                if fields[1] == "00000000" and int(fields[3], 16) & 2:
                    return str(ipaddress.IPv4Address(int(fields[2], 16).to_bytes(4, "little")))
        elif sys.platform == "darwin":
            done = subprocess.run(["route", "-n", "get", "default"], capture_output=True, timeout=0.5, check=False)
            if done.returncode == 0:
                for line in done.stdout.decode().splitlines():
                    if line.strip().startswith("gateway:"):
                        return str(ipaddress.IPv4Address(line.split(":", 1)[1].strip()))
    except Exception:  # noqa: BLE001 — topology is optional, no addresses in logs
        pass
    return None


def local_topology() -> tuple[list[str], str | None]:
    """Same IPv4 adapter enumeration as discovery, including each prefix; 1 min cache."""
    global _topology_cache
    with _topology_lock:
        now = time.monotonic()
        if _topology_cache is not None and now - _topology_cache[0] < 60:
            return _topology_cache[1:]
        networks = []
        try:
            import ifaddr

            for adapter in ifaddr.get_adapters():
                for ip in adapter.ips:
                    if not isinstance(ip.ip, str):
                        continue
                    address = ipaddress.IPv4Address(ip.ip)
                    if not address.is_loopback and not address.is_link_local:
                        networks.append(str(ipaddress.ip_network(f"{address}/{ip.network_prefix}", strict=False)))
        except Exception:  # noqa: BLE001
            pass
        gateway = _default_gateway()
        _topology_cache = (now, networks, gateway)
        return networks, gateway


def record_outside_visit(path: Path, client: str, forwarded: bool, at: str) -> None:
    """Runs after the response. A bookkeeping failure must never fail a request."""
    try:
        from app.infra import instance

        networks, gateway = local_topology()
        via = outside_via(client, networks, gateway, forwarded)
        if via in ("vpn", "tailscale", "proxy"):
            instance.record_outside(path, {"at": at, "via": via})
    except Exception:  # noqa: BLE001 — intentionally silent, never log a client address
        pass


def visit_time() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


# -- the snapshot ------------------------------------------------------------


@dataclass(frozen=True)
class TailscaleAddress:
    ip: str
    name: str | None
    url: str


@dataclass(frozen=True)
class NetworkSnapshot:
    lan: list[str]
    tailscale: TailscaleAddress | None


def network_snapshot() -> NetworkSnapshot:
    """The interface side of ``GET /api/server/network`` (``externalUrl`` aside).

    Never raises. The MagicDNS name is only asked for when an interface already
    carries a Tailscale address — without one there is nothing to name.
    """
    port = discovery.backend_port()
    try:
        addresses = discovery.lan_ipv4_addresses()
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not enumerate this server's addresses: %s", e)
        addresses = []
    lan = [f"http://{a}:{port}" for a in addresses if not is_tailscale_address(a)]
    tailscale_ip = next((a for a in addresses if is_tailscale_address(a)), None)
    tailscale = None
    if tailscale_ip is not None:
        tailscale = TailscaleAddress(
            ip=tailscale_ip,
            name=magic_dns_name(),
            url=f"http://{tailscale_ip}:{port}",
        )
    return NetworkSnapshot(lan=lan, tailscale=tailscale)


__all__ = [
    "HAS_CREDENTIALS",
    "HAS_PATH",
    "NEEDS_HTTPS",
    "NOT_A_URL",
    "TAILSCALE_NETWORK",
    "ExternalUrlError",
    "NetworkSnapshot",
    "TailscaleAddress",
    "clear_cache",
    "is_tailscale_address",
    "magic_dns_name",
    "network_snapshot",
    "normalise_external_url",
    "outside_via",
    "local_topology",
    "record_outside_visit",
    "visit_time",
]
