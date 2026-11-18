"""Advertise claimed servers over LAN mDNS/DNS-SD.

Never advertise an unclaimed server or let discovery errors fail startup or claim.
See docs/DEVELOPER_GUIDE.md#server-discovery-and-addresses.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import socket
import threading
from collections.abc import Callable
from typing import Any

from app.infra import instance

logger = logging.getLogger(__name__)

#: The DNS-SD service type. Clients (the desktop shell's ``mdns-sd`` browser)
#: hard-code the same string.
SERVICE_TYPE = "_krobi._tcp.local."

#: DNS-SD instance names are a single DNS label: at most 63 bytes.
_MAX_LABEL_BYTES = 63

_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _under_pytest() -> bool:
    return "PYTEST_CURRENT_TEST" in os.environ


def backend_port() -> int:
    """The port this server listens on: ``KROBI_BACKEND_PORT`` or 8000."""
    try:
        return int(os.getenv("KROBI_BACKEND_PORT", "8000"))
    except ValueError:
        return 8000


def bind_host() -> str | None:
    """The bind ``__main__`` recorded, or ``None`` when it is unknown."""
    host = (os.getenv("KROBI_BACKEND_HOST") or "").strip()
    return host or None


def _is_loopback(host: str) -> bool:
    if host.lower() in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def instance_label(name: str) -> str:
    """``name`` as one DNS label: no dots (they would split it), ≤ 63 bytes."""
    label = name.replace(".", "·").strip() or "Flipspin"
    encoded = label.encode("utf-8")
    if len(encoded) <= _MAX_LABEL_BYTES:
        return label
    return encoded[:_MAX_LABEL_BYTES].decode("utf-8", errors="ignore").rstrip()


def lan_ipv4_addresses() -> list[str]:
    """Every non-loopback, non-link-local IPv4 address on this machine.

    When the bind is one specific address, only that one — the others would
    advertise a door that is not open.
    """
    host = bind_host()
    if host and host not in ("0.0.0.0", "::") and not _is_loopback(host):
        try:
            return [str(ipaddress.IPv4Address(host))]
        except ValueError:
            pass
    found: list[str] = []
    try:
        import ifaddr  # zeroconf's own dependency

        for adapter in ifaddr.get_adapters():
            for ip in adapter.ips:
                if not isinstance(ip.ip, str):
                    continue  # IPv6 entries are tuples
                addr = ipaddress.IPv4Address(ip.ip)
                if addr.is_loopback or addr.is_link_local:
                    continue
                if str(addr) not in found:
                    found.append(str(addr))
    except Exception as e:  # noqa: BLE001 — fall back to the routing table
        logger.debug("ifaddr enumeration failed: %s", e)
    if not found:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.0.2.1", 9))  # TEST-NET; no packet is sent
                found.append(s.getsockname()[0])
        except OSError:
            pass
    return found


def _default_zeroconf_factory() -> Any:
    from zeroconf import IPVersion, Zeroconf

    return Zeroconf(ip_version=IPVersion.V4Only)


def _build_info(
    *, label: str, port: int, addresses: list[str], properties: dict, server: str
) -> Any:
    from zeroconf import ServiceInfo

    return ServiceInfo(
        SERVICE_TYPE,
        f"{label}.{SERVICE_TYPE}",
        port=port,
        properties=properties,
        server=server,
        parsed_addresses=addresses,
    )


class NestAdvertiser:
    """Keeps the LAN advertisement in step with the server's state.

    Call :meth:`refresh` whenever something it publishes may have changed — at
    startup, after a claim, after a rename — and :meth:`stop` at shutdown. Both
    are idempotent and never raise.

    ``zeroconf_factory`` and ``info_factory`` are injection points for tests; a
    test that injects a factory is the only way the advertiser runs under
    pytest. ``background=False`` makes :meth:`refresh` apply synchronously.
    """

    def __init__(
        self,
        config: Any,
        is_claimed: Callable[[], bool],
        version: str,
        *,
        zeroconf_factory: Callable[[], Any] | None = None,
        info_factory: Callable[..., Any] | None = None,
        background: bool = True,
    ) -> None:
        self._config = config
        self._is_claimed = is_claimed
        self._version = version
        self._injected = zeroconf_factory is not None
        self._zeroconf_factory = zeroconf_factory or _default_zeroconf_factory
        self._info_factory = info_factory or _build_info
        self._background = background
        self._lock = threading.Lock()
        self._zc: Any = None
        self._info: Any = None
        self._published: tuple | None = None

    # -- public ----------------------------------------------------------
    @property
    def advertising(self) -> bool:
        return self._info is not None

    def should_advertise(self) -> bool:
        """Evaluate advertising gates without raising; see docs/DEVELOPER_GUIDE.md#server-discovery-and-addresses."""
        if _under_pytest() and not self._injected:
            return False
        if not getattr(self._config, "advertise", True):
            return False
        host = bind_host()
        if host and _is_loopback(host):
            return False
        try:
            return bool(self._is_claimed())
        except Exception as e:  # noqa: BLE001
            logger.warning("Could not tell whether this server is claimed: %s", e)
            return False

    def refresh(self) -> None:
        """Bring the advertisement in line with the current state."""
        if self._background:
            threading.Thread(target=self._apply, name="krobi-mdns", daemon=True).start()
        else:
            self._apply()

    def stop(self, timeout: float = 3.0) -> None:
        """Withdraw the advertisement and close the responder."""
        if self._zc is None:
            return
        if self._background:
            t = threading.Thread(target=self._stop_now, name="krobi-mdns-stop", daemon=True)
            t.start()
            t.join(timeout)
        else:
            self._stop_now()

    # -- internals -------------------------------------------------------
    def _apply(self) -> None:
        with self._lock:
            try:
                if not self.should_advertise():
                    self._withdraw()
                    return
                self._publish()
            except Exception as e:  # noqa: BLE001 — never fail a boot or a claim
                logger.warning("LAN advertisement failed (the nest stays reachable by address): %s", e)

    def _publish(self) -> None:
        config = self._config
        instance_id = instance.read_or_create_instance_id(config.instance_file, logger)
        name = instance.get_name(config.instance_file)
        port = backend_port()
        addresses = lan_ipv4_addresses()
        if not addresses:
            logger.info("No LAN address to advertise the nest on; skipping for now.")
            self._withdraw()
            return
        label = instance_label(name)
        properties = {"instanceId": instance_id, "version": self._version, "name": name}
        wanted = (label, port, tuple(addresses), tuple(sorted(properties.items())))
        if wanted == self._published:
            return

        info = self._info_factory(
            label=label,
            port=port,
            addresses=addresses,
            properties=properties,
            server=f"krobi-{instance_id[:12]}.local.",
        )
        if self._zc is None:
            self._zc = self._zeroconf_factory()
        if self._info is not None:
            # A changed name is a changed service *name*; update_service cannot
            # rename, so the old record is withdrawn and the new one probed.
            self._zc.unregister_service(self._info)
            self._info = None
        self._zc.register_service(info, allow_name_change=True)
        self._info = info
        self._published = wanted
        logger.info("Advertising the nest %r on the LAN as %s port %s", name, SERVICE_TYPE, port)

    def _withdraw(self) -> None:
        if self._info is not None and self._zc is not None:
            try:
                self._zc.unregister_service(self._info)
            except Exception as e:  # noqa: BLE001
                logger.debug("unregister_service failed: %s", e)
            logger.info("Stopped advertising the nest on the LAN.")
        self._info = None
        self._published = None

    def _stop_now(self) -> None:
        with self._lock:
            try:
                self._withdraw()
                if self._zc is not None:
                    self._zc.close()
            except Exception as e:  # noqa: BLE001
                logger.debug("Closing the mDNS responder failed: %s", e)
            finally:
                self._zc = None


__all__ = [
    "SERVICE_TYPE",
    "NestAdvertiser",
    "backend_port",
    "bind_host",
    "instance_label",
    "lan_ipv4_addresses",
]
