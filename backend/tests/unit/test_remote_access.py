"""Run the server-owned externalUrl cases from contracts/remote-access.json.

Client consumers share those cases; probe and address-selection rules run in
their own suites."""
import json
import subprocess
from pathlib import Path

import pytest

from app.infra import discovery, instance, remote_access
from app.infra.remote_access import ExternalUrlError, normalise_external_url

CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "remote-access.json"
CASES = json.loads(CONTRACT.read_text(encoding="utf-8"))["externalUrl"]


@pytest.mark.parametrize("case", CASES, ids=[c["case"] for c in CASES])
def test_external_url_contract(case):
    if "error" in case:
        with pytest.raises(ExternalUrlError) as raised:
            normalise_external_url(case["in"])
        assert raised.value.code == case["error"]
    else:
        assert normalise_external_url(case["in"]) == case["out"]


class TestExternalUrlBeyondTheContract:
    def test_none_clears(self):
        assert normalise_external_url(None) is None

    def test_whitespace_only_clears(self):
        assert normalise_external_url("   ") is None

    def test_not_text(self):
        with pytest.raises(ExternalUrlError) as raised:
            normalise_external_url(42)  # type: ignore[arg-type]
        assert raised.value.code == "not-a-url"

    @pytest.mark.parametrize("bad", ["https://-bad.com", "https://exa_mple.com", "https://a..b"])
    def test_malformed_hosts(self, bad):
        with pytest.raises(ExternalUrlError) as raised:
            normalise_external_url(bad)
        assert raised.value.code == "not-a-url"

    def test_bad_port(self):
        with pytest.raises(ExternalUrlError) as raised:
            normalise_external_url("https://ejemplo.com:abc")
        assert raised.value.code == "not-a-url"

    def test_fragment_is_a_path(self):
        with pytest.raises(ExternalUrlError) as raised:
            normalise_external_url("https://ejemplo.com/#x")
        assert raised.value.code == "has-path"

    def test_uppercase_scheme(self):
        assert normalise_external_url("HTTPS://Ejemplo.com") == "https://ejemplo.com"

    def test_ip_literal(self):
        assert normalise_external_url("203.0.113.9:8443") == "https://203.0.113.9:8443"


class TestStorage:
    @pytest.fixture(autouse=True)
    def clean(self):
        instance._external_url_cache.clear()
        instance._name_cache.clear()
        yield
        instance._external_url_cache.clear()
        instance._name_cache.clear()

    def test_set_keeps_id_and_name(self, tmp_path):
        path = tmp_path / "instance.json"
        instance_id = instance.read_or_create_instance_id(path)
        instance.set_name(path, "Nido del salón")
        assert instance.set_external_url(path, "Musica.Ejemplo.com/") == "https://musica.ejemplo.com"
        raw = json.loads(path.read_text())
        assert raw["instanceId"] == instance_id
        assert raw["name"] == "Nido del salón"
        assert raw["externalUrl"] == "https://musica.ejemplo.com"
        assert instance.read_external_url(path) == "https://musica.ejemplo.com"

    def test_clearing_removes_the_key(self, tmp_path):
        path = tmp_path / "instance.json"
        instance.set_external_url(path, "musica.ejemplo.com")
        assert instance.set_external_url(path, None) is None
        assert "externalUrl" not in json.loads(path.read_text())
        assert instance.read_external_url(path) is None

    def test_a_refused_url_writes_nothing(self, tmp_path):
        path = tmp_path / "instance.json"
        instance.set_external_url(path, "musica.ejemplo.com")
        with pytest.raises(ExternalUrlError):
            instance.set_external_url(path, "http://otro.com")
        assert instance.read_external_url(path) == "https://musica.ejemplo.com"

    def test_a_hand_edited_http_value_is_not_served(self, tmp_path):
        path = tmp_path / "instance.json"
        path.write_text(json.dumps({"instanceId": "abc", "externalUrl": "http://x.com"}))
        assert instance.read_external_url(path) is None

    def test_missing_file_reads_none(self, tmp_path):
        assert instance.read_external_url(tmp_path / "nope.json") is None


class TestNetworkSnapshot:
    @pytest.fixture(autouse=True)
    def clean(self, monkeypatch):
        monkeypatch.delenv("KROBI_BACKEND_PORT", raising=False)
        remote_access.clear_cache()
        yield
        remote_access.clear_cache()

    def test_tailscale_is_split_from_lan(self, monkeypatch):
        monkeypatch.setattr(
            discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20", "100.101.1.2", "100.64.0.9", "10.0.0.5"]
        )
        monkeypatch.setattr(remote_access, "_ask_magic_dns_name", lambda: "krobi.tail1234.ts.net")
        snap = remote_access.network_snapshot()
        assert snap.lan == ["http://192.168.1.20:8000", "http://10.0.0.5:8000"]
        assert snap.tailscale == remote_access.TailscaleAddress(
            ip="100.101.1.2", name="krobi.tail1234.ts.net", url="http://100.101.1.2:8000"
        )

    def test_no_tailscale_means_null_and_no_cli_call(self, monkeypatch):
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20"])

        def boom():
            raise AssertionError("the CLI must not be asked without a tailnet address")

        monkeypatch.setattr(remote_access, "_ask_magic_dns_name", boom)
        assert remote_access.network_snapshot().tailscale is None

    def test_the_port_follows_the_env(self, monkeypatch):
        monkeypatch.setenv("KROBI_BACKEND_PORT", "8123")
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20"])
        assert remote_access.network_snapshot().lan == ["http://192.168.1.20:8123"]

    def test_enumeration_failure_is_empty(self, monkeypatch):
        def boom():
            raise OSError("no interfaces")

        monkeypatch.setattr(discovery, "lan_ipv4_addresses", boom)
        snap = remote_access.network_snapshot()
        assert snap.lan == [] and snap.tailscale is None

    def test_lan_networks_carry_the_real_prefix(self, monkeypatch):
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["10.20.30.40", "100.101.1.2", "172.16.5.9"])
        monkeypatch.setattr(remote_access, "_ask_magic_dns_name", lambda: None)
        monkeypatch.setattr(
            remote_access, "local_topology", lambda: (["10.20.0.0/16", "100.64.0.0/10", "172.16.4.0/23"], None)
        )
        assert remote_access.network_snapshot().lan_networks == ["10.20.0.0/16", "172.16.4.0/23"]

    def test_lan_networks_are_empty_without_topology(self, monkeypatch):
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["10.20.30.40"])
        monkeypatch.setattr(remote_access, "local_topology", lambda: ([], None))
        snap = remote_access.network_snapshot()
        assert snap.lan == ["http://10.20.30.40:8000"] and snap.lan_networks == []

    @pytest.mark.parametrize(
        "address,expected",
        [("100.64.0.0", True), ("100.127.255.255", True), ("100.128.0.1", False), ("192.168.1.1", False), ("x", False)],
    )
    def test_cgnat_range(self, address, expected):
        assert remote_access.is_tailscale_address(address) is expected


class TestMagicDnsName:
    @pytest.fixture(autouse=True)
    def clean(self):
        remote_access.clear_cache()
        yield
        remote_access.clear_cache()

    def _fake_run(self, monkeypatch, *, stdout=b"", returncode=0, exc=None):
        calls = []

        def run(args, **kwargs):
            calls.append((args, kwargs))
            if exc is not None:
                raise exc
            return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=b"")

        monkeypatch.setattr(remote_access, "_tailscale_binary", lambda: "/usr/bin/tailscale")
        monkeypatch.setattr(remote_access.subprocess, "run", run)
        return calls

    def test_trailing_dot_dropped_with_a_two_second_timeout(self, monkeypatch):
        calls = self._fake_run(monkeypatch, stdout=json.dumps({"Self": {"DNSName": "krobi.tail1234.ts.net."}}).encode())
        assert remote_access.magic_dns_name() == "krobi.tail1234.ts.net"
        args, kwargs = calls[0]
        assert args == ["/usr/bin/tailscale", "status", "--json"]
        assert kwargs["timeout"] == 2.0

    def test_cached(self, monkeypatch):
        calls = self._fake_run(monkeypatch, stdout=json.dumps({"Self": {"DNSName": "a.ts.net."}}).encode())
        remote_access.magic_dns_name()
        remote_access.magic_dns_name()
        assert len(calls) == 1

    def test_absence_is_cached_too(self, monkeypatch):
        calls = self._fake_run(monkeypatch, returncode=1)
        assert remote_access.magic_dns_name() is None
        assert remote_access.magic_dns_name() is None
        assert len(calls) == 1

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"exc": subprocess.TimeoutExpired(["tailscale"], 2.0)},
            {"exc": OSError("gone")},
            {"stdout": b"not json"},
            {"stdout": b"{}"},
            {"stdout": json.dumps({"Self": {"DNSName": ""}}).encode()},
            {"stdout": json.dumps({"Self": {"DNSName": 7}}).encode()},
            {"returncode": 1},
        ],
    )
    def test_never_raises(self, monkeypatch, kwargs):
        self._fake_run(monkeypatch, **kwargs)
        assert remote_access.magic_dns_name() is None

    def test_no_binary(self, monkeypatch):
        monkeypatch.setattr(remote_access, "_tailscale_binary", lambda: None)
        assert remote_access.magic_dns_name() is None


OUTSIDE_CASES = json.loads(CONTRACT.read_text(encoding="utf-8"))["outsideVia"]


@pytest.mark.parametrize("case", OUTSIDE_CASES, ids=[c["case"] for c in OUTSIDE_CASES])
def test_outside_via_contract(case):
    assert remote_access.outside_via(**case["in"]) == case["out"]


def test_outside_monotonic_throttled_and_persisted(tmp_path, monkeypatch):
    path = tmp_path / "instance.json"
    instance_id = instance.read_or_create_instance_id(path)
    instance.set_name(path, "Nido de prueba")
    instance.set_external_url(path, "music.example.com")
    instance.set_remote_route(path, "wireguard")
    clock = [10.0]
    monkeypatch.setattr(instance.time, "monotonic", lambda: clock[0])
    first = {"at": "2026-10-28T10:00:00Z", "via": "vpn"}
    latest = {"at": "2026-10-28T10:04:00Z", "via": "proxy"}
    instance.record_outside(path, first)
    clock[0] += 240
    instance.record_outside(path, latest)
    assert instance.read_outside(path) == latest
    assert json.loads(path.read_text())["outside"] == first
    instance.record_outside(path, first)
    assert instance.read_outside(path) == latest
    clock[0] += 60
    final = {"at": "2026-10-28T10:05:00Z", "via": "tailscale"}
    instance.record_outside(path, final)
    instance._outside_cache.clear()
    instance._route_cache.clear()
    assert instance.read_outside(path) == final
    assert instance.read_remote_route(path) == "wireguard"
    raw = json.loads(path.read_text())
    assert raw["instanceId"] == instance_id and raw["name"] == "Nido de prueba"
    assert raw["externalUrl"] == "https://music.example.com"
    assert set(raw["outside"]) == {"at", "via"}


def test_topology_caches_adapter_prefix_and_gateway(monkeypatch):
    from types import SimpleNamespace
    import ifaddr

    calls = []
    monkeypatch.setattr(ifaddr, "get_adapters", lambda: [SimpleNamespace(ips=[
        SimpleNamespace(ip="192.168.1.20", network_prefix=24),
        SimpleNamespace(ip="127.0.0.1", network_prefix=8),
        SimpleNamespace(ip=("::1", 0, 0), network_prefix=128),
    ])])
    monkeypatch.setattr(remote_access, "_default_gateway", lambda: calls.append(True) or "192.168.1.1")
    remote_access.clear_cache()
    assert remote_access.local_topology() == (["192.168.1.0/24"], "192.168.1.1")
    assert remote_access.local_topology() == (["192.168.1.0/24"], "192.168.1.1")
    assert len(calls) == 1
    remote_access.clear_cache()


def test_gateway_linux_and_macos_failure(monkeypatch):
    monkeypatch.setattr(remote_access.sys, "platform", "linux")
    monkeypatch.setattr(Path, "read_text", lambda *a, **k: "Iface Destination Gateway Flags\neth0 00000000 0101A8C0 0003")
    assert remote_access._default_gateway() == "192.168.1.1"
    monkeypatch.setattr(remote_access.sys, "platform", "darwin")
    calls = []

    def run(args, **kwargs):
        calls.append(kwargs)
        return subprocess.CompletedProcess(args, 0, stdout=b"   gateway: 192.168.1.1\n")

    monkeypatch.setattr(remote_access.subprocess, "run", run)
    assert remote_access._default_gateway() == "192.168.1.1"
    assert calls[0]["timeout"] <= 1

    def fail(*a, **k):
        raise subprocess.TimeoutExpired("route", 0.5)

    monkeypatch.setattr(remote_access.subprocess, "run", fail)
    assert remote_access._default_gateway() is None


def test_visit_failure_is_swallowed(tmp_path, monkeypatch):
    monkeypatch.setattr(remote_access, "local_topology", lambda: (["192.168.1.0/24"], None))

    def fail(*a):
        raise OSError("read-only")

    monkeypatch.setattr(instance, "record_outside", fail)
    remote_access.record_outside_visit(tmp_path / "instance.json", "10.1.0.2", False, "2026-10-28T10:00:00Z")


def test_auth_only_schedules_the_visit_after_resolving_a_real_credential(tmp_path, monkeypatch):
    from fastapi import BackgroundTasks
    from starlette.requests import Request
    from app.domains.accounts.auth import require_api_token
    from app.domains.accounts.identity import LEGACY_OWNER
    from types import SimpleNamespace
    from unittest.mock import Mock

    topology = Mock(side_effect=AssertionError("must not enumerate interfaces while authenticating"))
    monkeypatch.setattr(remote_access, "local_topology", topology)
    request = Request({
        "type": "http", "method": "GET", "path": "/api/server/network", "query_string": b"",
        "headers": [(b"host", b"localhost"), (b"authorization", b"Bearer test-secret"),
                    (b"forwarded", b"for=203.0.113.9")],
        "client": ("203.0.113.9", 51000), "server": ("testserver", 80), "scheme": "http",
    })
    tasks = BackgroundTasks()
    config = SimpleNamespace(api_token="test-secret", instance_file=tmp_path / "instance.json")
    require_api_token(request, tasks, config, SimpleNamespace(resolve=lambda _: None))
    assert request.state.principal == LEGACY_OWNER
    topology.assert_not_called()
    assert len(tasks.tasks) == 1
    assert tasks.tasks[0].func == remote_access.record_outside_visit
    assert tasks.tasks[0].args[2] is True


class TestHomeNetwork:
    @pytest.mark.parametrize(
        "address,networks,expected",
        [
            ("10.1.2.3", ["10.1.2.0/24"], "10.1.2.0/24"),
            ("172.16.9.9", ["172.16.8.0/22"], "172.16.8.0/22"),
            ("10.1.2.3", ["10.1.2.0/31"], None),  # no room for a wider route
            ("10.1.2.3", ["10.0.0.0/8"], None),  # one bit wider leaves the private range
            ("192.0.2.10", ["192.0.2.0/24"], None),  # not a private address
            ("169.254.1.1", ["169.254.0.0/16"], None),  # link-local
            ("10.1.2.3", ["10.9.0.0/16"], None),  # not on that network
            ("fe80::1", ["fe80::/64"], None),  # IPv6
            ("x", ["10.1.2.0/24"], None),
            ("10.1.2.3", ["bogus", "10.1.2.0/24"], "10.1.2.0/24"),
        ],
    )
    def test_cases(self, address, networks, expected):
        assert remote_access.home_network(address, networks) == expected
