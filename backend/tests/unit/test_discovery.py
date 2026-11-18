"""The nest name store (``app/infra/instance.py``) and the LAN advertiser
(``app/infra/discovery.py``), with zeroconf replaced by a fake.

The advertiser's gates are the point: it must stay silent while the server is
unclaimed (an open claim window is not something to announce), when
``KROBI_ADVERTISE`` is off, and when the server is bound to loopback — and once
it does advertise, a rename must re-register under the new name.
"""
import json
from types import SimpleNamespace

from app.infra.migrations import StoreRefusal

import pytest

from app.infra import discovery, instance
from app.infra.discovery import NestAdvertiser


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    instance._name_cache.clear()
    monkeypatch.delenv("KROBI_BACKEND_HOST", raising=False)
    monkeypatch.setenv("KROBI_BACKEND_PORT", "8123")
    monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20"])
    yield
    instance._name_cache.clear()


# --------------------------------------------------------------------- instance


class TestTheNameStore:
    def test_set_name_keeps_the_instance_id(self, tmp_path):
        path = tmp_path / "instance.json"
        original = instance.read_or_create_instance_id(path)
        instance.set_name(path, "  Nido del salón ")
        raw = json.loads(path.read_text())
        assert raw["instanceId"] == original
        assert raw["name"] == "Nido del salón"
        assert raw["version"] == instance.INSTANCE_FILE_VERSION
        assert instance.read_or_create_instance_id(path) == original

    def test_set_name_on_a_missing_file_creates_the_id_too(self, tmp_path):
        path = tmp_path / "instance.json"
        instance.set_name(path, "Nido")
        raw = json.loads(path.read_text())
        assert raw["instanceId"]
        assert instance.read_or_create_instance_id(path) == raw["instanceId"]

    def test_an_existing_file_without_an_id_refuses(self, tmp_path):
        path = tmp_path / "instance.json"
        path.write_text(json.dumps({"name": "Nido"}))
        before = path.read_bytes()
        with pytest.raises(StoreRefusal):
            instance.read_or_create_instance_id(path)
        assert path.read_bytes() == before

    def test_get_name_defaults_to_server_label(self, tmp_path):
        # Never the hostname (random hex in a container) or an account: the name is public.
        assert instance.get_name(tmp_path / "instance.json") == "Flipspin"

    def test_the_cache_is_invalidated_by_set_name(self, tmp_path):
        path = tmp_path / "instance.json"
        instance.set_name(path, "Uno")
        assert instance.get_name(path) == "Uno"
        instance.set_name(path, "Dos")
        assert instance.get_name(path) == "Dos"

    def test_a_corrupt_stored_name_reads_as_unset(self, tmp_path):
        path = tmp_path / "instance.json"
        path.write_text(json.dumps({"instanceId": "abc", "name": "bad\nname"}))
        assert instance.read_name(path) is None

    @pytest.mark.parametrize("bad", ["", "  ", "x" * 61, "a\x07b", None, 3])
    def test_clean_rejects(self, bad):
        with pytest.raises(instance.InvalidNestNameError):
            instance.clean_nest_name(bad)

    def test_clean_trims(self):
        assert instance.clean_nest_name("  ñandú  ") == "ñandú"


# ------------------------------------------------------------------- advertiser


class FakeZeroconf:
    def __init__(self):
        self.registered = []
        self.unregistered = []
        self.closed = False

    def register_service(self, info, allow_name_change=False):
        self.registered.append(info)

    def unregister_service(self, info):
        self.unregistered.append(info)

    def close(self):
        self.closed = True


def make(tmp_path, *, claimed=True, advertise=True, raises=False):
    config = SimpleNamespace(instance_file=tmp_path / "instance.json", advertise=advertise)
    state = {"claimed": claimed}
    zc = FakeZeroconf()

    def factory():
        if raises:
            raise OSError("no multicast here")
        return zc

    advertiser = NestAdvertiser(
        config,
        is_claimed=lambda: state["claimed"],
        version="9.9.9",
        zeroconf_factory=factory,
        info_factory=lambda **kw: SimpleNamespace(**kw),
        background=False,
    )
    return advertiser, zc, state, config


class TestTheAdvertiserGates:
    def test_not_started_while_unclaimed(self, tmp_path):
        advertiser, zc, _, _ = make(tmp_path, claimed=False)
        advertiser.refresh()
        assert zc.registered == []
        assert not advertiser.advertising

    def test_not_started_when_disabled(self, tmp_path):
        advertiser, zc, _, _ = make(tmp_path, advertise=False)
        advertiser.refresh()
        assert zc.registered == []

    def test_not_started_when_bound_to_loopback(self, tmp_path, monkeypatch):
        monkeypatch.setenv("KROBI_BACKEND_HOST", "127.0.0.1")
        advertiser, zc, _, _ = make(tmp_path)
        advertiser.refresh()
        assert zc.registered == []

    def test_started_after_the_claim(self, tmp_path):
        advertiser, zc, state, _ = make(tmp_path, claimed=False)
        advertiser.refresh()
        state["claimed"] = True
        advertiser.refresh()
        assert len(zc.registered) == 1
        info = zc.registered[0]
        assert info.port == 8123
        assert info.addresses == ["192.168.1.20"]
        assert info.properties["version"] == "9.9.9"
        assert info.properties["instanceId"] == instance.read_or_create_instance_id(
            tmp_path / "instance.json"
        )
        assert info.properties["name"] == info.label == instance.get_name(tmp_path / "instance.json")

    def test_a_refresh_with_nothing_changed_is_a_noop(self, tmp_path):
        advertiser, zc, _, _ = make(tmp_path)
        advertiser.refresh()
        advertiser.refresh()
        assert len(zc.registered) == 1
        assert zc.unregistered == []

    def test_a_rename_re_registers(self, tmp_path):
        advertiser, zc, _, config = make(tmp_path)
        advertiser.refresh()
        instance.set_name(config.instance_file, "Nido del salón")
        advertiser.refresh()
        assert len(zc.registered) == 2
        assert len(zc.unregistered) == 1
        assert zc.registered[-1].label == "Nido del salón"

    def test_losing_the_household_withdraws(self, tmp_path):
        advertiser, zc, state, _ = make(tmp_path)
        advertiser.refresh()
        state["claimed"] = False
        advertiser.refresh()
        assert len(zc.unregistered) == 1
        assert not advertiser.advertising

    def test_errors_never_escape(self, tmp_path):
        advertiser, _, _, _ = make(tmp_path, raises=True)
        advertiser.refresh()  # must not raise
        assert not advertiser.advertising

    def test_stop_unregisters_and_closes(self, tmp_path):
        advertiser, zc, _, _ = make(tmp_path)
        advertiser.refresh()
        advertiser.stop()
        assert len(zc.unregistered) == 1
        assert zc.closed

    def test_inert_under_pytest_without_an_injected_factory(self, tmp_path):
        config = SimpleNamespace(instance_file=tmp_path / "instance.json", advertise=True)
        advertiser = NestAdvertiser(config, is_claimed=lambda: True, version="1", background=False)
        assert advertiser.should_advertise() is False


class TestHelpers:
    def test_instance_label_has_no_dots_and_fits_one_label(self):
        assert "." not in discovery.instance_label("Nido de mac.mini")
        assert len(discovery.instance_label("ñ" * 60).encode()) <= 63

    def test_backend_port_falls_back(self, monkeypatch):
        monkeypatch.setenv("KROBI_BACKEND_PORT", "nope")
        assert discovery.backend_port() == 8000

    def test_a_specific_bind_is_the_only_address(self, monkeypatch):
        monkeypatch.undo()  # the real lan_ipv4_addresses
        monkeypatch.setenv("KROBI_BACKEND_HOST", "10.0.0.7")
        assert discovery.lan_ipv4_addresses() == ["10.0.0.7"]

    def test_the_wildcard_bind_enumerates_something_or_nothing(self, monkeypatch):
        monkeypatch.undo()
        monkeypatch.setenv("KROBI_BACKEND_HOST", "0.0.0.0")
        for addr in discovery.lan_ipv4_addresses():
            assert not addr.startswith("127.")

    def test_the_real_factory_builds_a_service_info(self):
        info = discovery._build_info(
            label="Nido", port=8000, addresses=["192.168.1.2"],
            properties={"instanceId": "x", "version": "1", "name": "Nido"},
            server="krobi-x.local.",
        )
        assert info.name == "Nido._krobi._tcp.local."
        assert info.port == 8000


class TestTheConfigFlag:
    def test_env_false_disables(self, monkeypatch, tmp_path):
        from app.config import ConfigManager

        for var in ("MUSIC_DIR", "PLAYLIST_DIR", "TEMP_DIR", "LOG_DIR", "CREDENTIALS_DIR"):
            monkeypatch.setenv(f"KROBI_{var}", str(tmp_path / var))
        monkeypatch.setenv("KROBI_ADVERTISE", "false")
        assert ConfigManager.from_env().advertise is False
        monkeypatch.setenv("KROBI_ADVERTISE", "true")
        assert ConfigManager.from_env().advertise is True


class TestTheEntryPointHonoursItsBind:
    def test_defaults(self):
        from app.__main__ import _parse_args

        args = _parse_args([])
        assert (args.host, args.port) == ("0.0.0.0", 8000)

    def test_host_and_port_are_honoured_and_unknown_args_ignored(self):
        from app.__main__ import _parse_args

        args = _parse_args(["--host", "127.0.0.1", "--port", "9001", "--future-flag", "x"])
        assert (args.host, args.port) == ("127.0.0.1", 9001)

    def test_main_passes_the_bind_to_uvicorn(self, monkeypatch):
        import uvicorn

        from app import __main__ as entry

        seen = {}
        monkeypatch.setattr(uvicorn, "run", lambda app, host, port: seen.update(host=host, port=port))
        monkeypatch.setenv("KROBI_BACKEND_HOST", "unset")
        entry.main(["--host", "127.0.0.1", "--port", "8765"])
        assert seen == {"host": "127.0.0.1", "port": 8765}
        import os

        assert os.environ["KROBI_BACKEND_PORT"] == "8765"
        assert os.environ["KROBI_BACKEND_HOST"] == "127.0.0.1"
