"""Check authenticated network discovery, owner-only domains, and public CORS.

Domains persist beside identity without entering the public handshake. Invalid
domains return stable reason codes. Fake interfaces and temporary state keep
the suite independent of host networking.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.infra import discovery, instance, remote_access
from app.domains.accounts.identity import ROLE_MEMBER, ROLE_OWNER
from app.domains.system import routes
from app.main import app

NETWORK = "/api/server/network"
EXTERNAL = "/api/server/external-url"
STATUS = "/api/status"
SHARED = "s3cret-shared-token"


@pytest.fixture
def fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(app.state.config, "users_file", tmp_path / "users.json")
    monkeypatch.setattr(app.state.config, "instance_file", tmp_path / "instance.json")
    monkeypatch.setattr(app.state.config, "api_token", None)
    monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", False)
    monkeypatch.delenv("KROBI_BACKEND_PORT", raising=False)
    monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20", "100.101.1.2"])
    monkeypatch.setattr(remote_access, "_ask_magic_dns_name", lambda: "krobi.tail1234.ts.net")
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    instance._name_cache.clear()
    instance._external_url_cache.clear()
    remote_access.clear_cache()
    yield tmp_path
    app.state.container._services.pop("token_store", None)
    routes._instance_id_cache.clear()
    instance._name_cache.clear()
    instance._external_url_cache.clear()
    remote_access.clear_cache()


def store():
    return app.state.container.get_token_store()


def remote() -> TestClient:
    return TestClient(app, client=("192.0.2.42", 51000))


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestNetwork:
    def test_the_body(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote().get(NETWORK, headers=bearer(token))
        assert response.status_code == 200
        assert response.json() == {
            "lan": ["http://192.168.1.20:8000"],
            "lanNetworks": [],
            "tailscale": {
                "ip": "100.101.1.2",
                "name": "krobi.tail1234.ts.net",
                "url": "http://100.101.1.2:8000",
            },
            "externalUrl": None,
            "route": None,
            "outside": None,
        }

    def test_a_member_may_read_it(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        _, token = store().mint("Ana", ROLE_MEMBER)
        assert remote().get(NETWORK, headers=bearer(token)).status_code == 200

    def test_the_shared_secret_may_read_it(self, fresh, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        assert remote().get(NETWORK, headers=bearer(SHARED)).status_code == 200

    def test_no_credential_is_refused(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        assert remote().get(NETWORK).status_code == 401

    def test_no_tailscale_is_null(self, fresh, monkeypatch):
        monkeypatch.setattr(discovery, "lan_ipv4_addresses", lambda: ["192.168.1.20"])
        _, token = store().mint("Robin", ROLE_OWNER)
        assert remote().get(NETWORK, headers=bearer(token)).json()["tailscale"] is None

    def test_the_name_may_be_null(self, fresh, monkeypatch):
        monkeypatch.setattr(remote_access, "_ask_magic_dns_name", lambda: None)
        _, token = store().mint("Robin", ROLE_OWNER)
        assert remote().get(NETWORK, headers=bearer(token)).json()["tailscale"]["name"] is None


class TestExternalUrl:
    def test_owner_sets_it_and_network_serves_it(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote().put(EXTERNAL, json={"url": " Musica.Ejemplo.com/ "}, headers=bearer(token))
        assert response.status_code == 200
        assert response.json() == {"externalUrl": "https://musica.ejemplo.com"}
        assert remote().get(NETWORK, headers=bearer(token)).json()["externalUrl"] == "https://musica.ejemplo.com"

    @pytest.mark.parametrize("cleared", [None, ""])
    def test_null_or_empty_clears(self, fresh, cleared):
        _, token = store().mint("Robin", ROLE_OWNER)
        remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}, headers=bearer(token))
        response = remote().put(EXTERNAL, json={"url": cleared}, headers=bearer(token))
        assert response.json() == {"externalUrl": None}
        assert remote().get(NETWORK, headers=bearer(token)).json()["externalUrl"] is None

    @pytest.mark.parametrize(
        "bad,code",
        [
            ("http://musica.ejemplo.com", "needs-https"),
            ("https://ejemplo.com/krobi", "has-path"),
            ("https://yo:clave@ejemplo.com", "has-credentials"),
            ("https://", "not-a-url"),
        ],
    )
    def test_422_carries_the_code_and_keeps_the_old_value(self, fresh, bad, code):
        _, token = store().mint("Robin", ROLE_OWNER)
        remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}, headers=bearer(token))
        response = remote().put(EXTERNAL, json={"url": bad}, headers=bearer(token))
        assert response.status_code == 422
        assert response.json()["detail"] == code
        assert remote().get(NETWORK, headers=bearer(token)).json()["externalUrl"] == "https://musica.ejemplo.com"

    def test_a_member_is_refused(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        _, token = store().mint("Ana", ROLE_MEMBER)
        response = remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}, headers=bearer(token))
        assert response.status_code == 403
        assert not (fresh / "instance.json").exists() or "externalUrl" not in json.loads(
            (fresh / "instance.json").read_text()
        )

    def test_no_credential_is_refused(self, fresh):
        store().mint("Robin", ROLE_OWNER)
        assert remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}).status_code == 401

    def test_the_shared_secret_is_an_owner(self, fresh, monkeypatch):
        monkeypatch.setattr(app.state.config, "api_token", SHARED)
        response = remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}, headers=bearer(SHARED))
        assert response.status_code == 200

    def test_keeps_instance_id_and_name(self, fresh):
        before = remote().get(STATUS).json()["instanceId"]
        _, token = store().mint("Robin", ROLE_OWNER)
        remote().put("/api/server/name", json={"name": "Nido del salón"}, headers=bearer(token))
        remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}, headers=bearer(token))
        raw = json.loads((fresh / "instance.json").read_text())
        assert raw["instanceId"] == before
        assert raw["name"] == "Nido del salón"
        assert raw["externalUrl"] == "https://musica.ejemplo.com"
        routes._instance_id_cache.clear()
        instance._name_cache.clear()
        status = remote().get(STATUS).json()
        assert status["instanceId"] == before
        assert status["name"] == "Nido del salón"

    def test_never_on_the_public_handshake(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        remote().put(EXTERNAL, json={"url": "musica.ejemplo.com"}, headers=bearer(token))
        body = remote().get(STATUS).text
        assert "ejemplo" not in body
        assert "ts.net" not in body and "100.101" not in body


class TestStatusCors:
    @pytest.mark.parametrize("method", ["get", "head"])
    @pytest.mark.parametrize("origin", [None, "https://somewhere.example", "http://localhost:5173", "tauri://localhost"])
    def test_status_uses_the_normal_allow_list(self, fresh, method, origin):
        headers = {"Origin": origin} if origin else {}
        response = getattr(remote(), method)(STATUS, headers=headers)
        allowed = origin in ("http://localhost:5173", "tauri://localhost")
        assert response.headers.get_list("access-control-allow-origin") == ([origin] if allowed else [])

    def test_other_routes_keep_the_allow_list(self, fresh):
        stranger = remote().get("/api/health", headers={"Origin": "https://somewhere.example"})
        assert "access-control-allow-origin" not in stranger.headers
        known = remote().get("/api/health", headers={"Origin": "http://localhost:5173"})
        assert known.headers.get("access-control-allow-origin") == "http://localhost:5173"

    def test_the_network_route_is_not_wildcarded(self, fresh):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote().get(NETWORK, headers={**bearer(token), "Origin": "https://somewhere.example"})
        assert "access-control-allow-origin" not in response.headers


class TestRemoteRoute:
    @pytest.mark.parametrize("route", ["wireguard", "tailscale", "domain", "local"])
    def test_owner_saves_and_reads(self, fresh, route):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote().put("/api/server/remote-route", json={"route": route}, headers=bearer(token))
        assert response.status_code == 200
        assert response.json() == {"route": route}
        instance._route_cache.clear()
        assert remote().get(NETWORK, headers=bearer(token)).json()["route"] == route

    @pytest.mark.parametrize("bad", ["unknown", None, 5, [], {}])
    def test_unknown_route(self, fresh, bad):
        _, token = store().mint("Robin", ROLE_OWNER)
        response = remote().put("/api/server/remote-route", json={"route": bad}, headers=bearer(token))
        assert response.status_code == 422
        assert response.json() == {"detail": "unknown-route"}
        assert instance.read_remote_route(fresh / "instance.json") is None

    def test_member_reads_but_cannot_change(self, fresh):
        _, owner = store().mint("Robin", ROLE_OWNER)
        _, member = store().mint("Ana", ROLE_MEMBER)
        remote().put("/api/server/remote-route", json={"route": "wireguard"}, headers=bearer(owner))
        response = remote().put("/api/server/remote-route", json={"route": "local"}, headers=bearer(member))
        assert response.status_code == 403
        assert remote().get(NETWORK, headers=bearer(member)).json()["route"] == "wireguard"


class TestOutsideVisit:
    @pytest.mark.parametrize("client,forwarded,via", [
        ("203.0.113.9", True, "proxy"), ("10.1.0.4", False, "vpn"),
        ("192.168.1.1", False, "vpn"), ("100.101.1.2", False, "tailscale"),
        ("127.0.0.1", False, None), ("192.168.1.114", True, None),
        ("203.0.113.9", False, None),
    ])
    def test_only_authenticated_outside_proof(self, fresh, monkeypatch, client, forwarded, via):
        monkeypatch.setattr(remote_access, "local_topology", lambda: (["192.168.1.0/24"], "192.168.1.1"))
        _, token = store().mint("Robin", ROLE_OWNER)
        headers = bearer(token) | ({"X-Forwarded-For": client} if forwarded else {})
        connection = TestClient(app, client=(client, 51000))
        assert connection.get(NETWORK, headers=headers).status_code == 200
        outside = instance.read_outside(fresh / "instance.json")
        if via:
            assert outside["via"] == via and outside["at"].endswith("Z")
            instance._outside_cache.clear()
            assert instance.read_outside(fresh / "instance.json") == outside
            # A local request exposes the proof without overwriting it.
            assert TestClient(app).get(NETWORK, headers=bearer(token)).json()["outside"] == outside
            assert client not in (fresh / "instance.json").read_text()
        else:
            assert outside is None

    def test_anonymous_and_public_handshake_are_not_proof(self, fresh, monkeypatch):
        monkeypatch.setattr(app.state.config, "allow_unauthenticated_remote", True)
        monkeypatch.setattr(remote_access, "local_topology", lambda: (["192.168.1.0/24"], None))
        connection = TestClient(app, client=("10.1.0.4", 51000))
        connection.get(NETWORK)
        _, token = store().mint("Robin", ROLE_OWNER)
        connection.get(STATUS, headers=bearer(token))
        assert instance.read_outside(fresh / "instance.json") is None
