"""Pin provider payload keys and reject ambiguous or unusable preferences.

Empty metadata kinds and incomplete orders must fail without partial changes.
"""
import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_provider_registry
from app.main import app
from app.providers.registry import ProviderDescriptor, ProviderKind, ProviderRegistry


class _Bare:
    """A provider with nothing to say about its own availability."""


class _NeedsCredentials:
    def __init__(self, reason):
        self._reason = reason

    def unavailable_reason(self):
        return self._reason


def _descriptor(provider_id, kind=ProviderKind.METADATA, **kwargs):
    kwargs.setdefault("name", provider_id.title())
    kwargs.setdefault("description", f"{provider_id} description")
    return ProviderDescriptor(id=provider_id, kind=kind, **kwargs)


@pytest.fixture
def client_and_registry():
    """A TestClient over a small hand-built registry, never the real one.

    Deliberately not ``build_default_registry``: that one constructs live HTTP
    repositories and persists to the developer's own ``~/Krobi/providers.json``.
    """
    registry = ProviderRegistry()
    registry.register(_descriptor("deezer", capabilities=("isrc",)), _Bare())
    registry.register(_descriptor("musicbrainz", capabilities=("mbid",)), _Bare())
    registry.register(
        _descriptor("spotify", requires_credentials=True),
        _NeedsCredentials("Add your Spotify client ID and secret in Settings."),
    )
    registry.register(
        _descriptor("genius", ProviderKind.LYRICS, requires_credentials=True), _Bare()
    )
    app.dependency_overrides[get_provider_registry] = lambda: registry
    try:
        yield TestClient(app), registry
    finally:
        app.dependency_overrides.pop(get_provider_registry, None)


class TestListing:
    def test_every_documented_field_is_present_and_named_exactly(self, client_and_registry):
        client, _ = client_and_registry
        body = client.get("/api/providers").json()

        row = next(p for p in body["providers"] if p["id"] == "deezer")
        assert row == {
            "id": "deezer",
            "kind": "metadata",
            "name": "Deezer",
            "description": "deezer description",
            "enabled": True,
            "position": 0,
            "available": True,
            "requiresCredentials": False,
            "capabilities": ["isrc"],
            "unavailableReason": None,
            "health": {"state": "ok"},
        }

    def test_providers_come_back_in_escalation_order(self, client_and_registry):
        client, _ = client_and_registry
        body = client.get("/api/providers?kind=metadata").json()
        assert [p["id"] for p in body["providers"]] == ["deezer", "musicbrainz", "spotify"]
        assert [p["position"] for p in body["providers"]] == [0, 1, 2]

    def test_a_credential_less_provider_is_unavailable_but_still_listed(
        self, client_and_registry
    ):
        """"Off because you turned it off" and "off because it cannot work" are
        different states, and the UI needs the reason to say which."""
        client, _ = client_and_registry
        row = next(
            p for p in client.get("/api/providers").json()["providers"]
            if p["id"] == "spotify"
        )
        assert row["enabled"] is True
        assert row["available"] is False
        assert row["requiresCredentials"] is True
        assert "Spotify client ID" in row["unavailableReason"]

    def test_disabled_providers_are_still_listed(self, client_and_registry):
        client, registry = client_and_registry
        registry.set_enabled("musicbrainz", False)
        row = next(
            p for p in client.get("/api/providers").json()["providers"]
            if p["id"] == "musicbrainz"
        )
        assert row["enabled"] is False
        assert row["available"] is True

    def test_an_unknown_kind_filter_is_rejected_not_silently_empty(
        self, client_and_registry
    ):
        client, _ = client_and_registry
        assert client.get("/api/providers?kind=podcasts").status_code == 422


class TestToggling:
    def test_disabling_returns_the_updated_row(self, client_and_registry):
        client, registry = client_and_registry
        response = client.put("/api/providers/musicbrainz", json={"enabled": False})
        assert response.status_code == 200
        assert response.json()["enabled"] is False
        assert registry.order(ProviderKind.METADATA) == ["deezer"]

    def test_disabling_the_last_provider_of_a_REQUIRED_kind_is_a_422(
        self, client_and_registry
    ):
        client, registry = client_and_registry
        for pid in ("musicbrainz", "spotify"):
            client.put(f"/api/providers/{pid}", json={"enabled": False})
        assert client.put("/api/providers/deezer", json={"enabled": False}).status_code == 422
        # ...and nothing changed.
        assert registry.order(ProviderKind.METADATA) == ["deezer"]

    def test_the_422_explains_which_provider_and_which_kind(self, client_and_registry):
        client, _ = client_and_registry
        for pid in ("musicbrainz", "spotify"):
            client.put(f"/api/providers/{pid}", json={"enabled": False})
        detail = client.put("/api/providers/deezer", json={"enabled": False}).json()["detail"]
        assert "Deezer" in detail and "metadata" in detail

    def test_disabling_the_last_provider_of_an_OPTIONAL_kind_is_allowed(
        self, client_and_registry
    ):
        """Turning the lyrics or dashboard provider off entirely is a real choice."""
        client, registry = client_and_registry
        assert client.put("/api/providers/genius", json={"enabled": False}).status_code == 200
        assert registry.order(ProviderKind.LYRICS) == []

    def test_an_unknown_provider_is_a_404(self, client_and_registry):
        client, _ = client_and_registry
        assert client.put("/api/providers/tidal", json={"enabled": True}).status_code == 404

    def test_a_missing_enabled_field_is_a_422(self, client_and_registry):
        client, _ = client_and_registry
        assert client.put("/api/providers/deezer", json={}).status_code == 422


class TestReordering:
    def test_a_full_permutation_is_applied(self, client_and_registry):
        client, registry = client_and_registry
        response = client.put(
            "/api/providers/metadata/order",
            json={"order": ["musicbrainz", "spotify", "deezer"]},
        )
        assert response.status_code == 200
        assert [p["id"] for p in response.json()["providers"]] == [
            "musicbrainz", "spotify", "deezer"
        ]
        assert registry.order(ProviderKind.METADATA) == ["musicbrainz", "deezer"]

    def test_a_partial_order_is_a_422_and_changes_nothing(self, client_and_registry):
        client, registry = client_and_registry
        response = client.put(
            "/api/providers/metadata/order", json={"order": ["musicbrainz"]}
        )
        assert response.status_code == 422
        assert registry.order(ProviderKind.METADATA) == ["deezer", "musicbrainz"]

    def test_an_unknown_id_in_the_order_is_a_422(self, client_and_registry):
        client, _ = client_and_registry
        response = client.put(
            "/api/providers/metadata/order",
            json={"order": ["deezer", "musicbrainz", "spotify", "tidal"]},
        )
        assert response.status_code == 422

    def test_reordering_an_unknown_kind_is_a_422(self, client_and_registry):
        client, _ = client_and_registry
        assert client.put(
            "/api/providers/podcasts/order", json={"order": []}
        ).status_code == 422


class TestAuth:
    def test_the_provider_routes_are_gated_like_every_other_router(
        self, client_and_registry, monkeypatch
    ):
        """A new route must be closed by default, not added to a checklist.

        ``main.py`` attaches ``require_api_token`` per router, so this asserts
        the router was actually included that way rather than trusting it.
        """
        client, _ = client_and_registry
        monkeypatch.setattr(app.state.config, "api_token", "s3cret")
        assert client.get("/api/providers").status_code == 401
        assert client.put(
            "/api/providers/deezer", json={"enabled": True}
        ).status_code == 401
        ok = client.get("/api/providers", headers={"Authorization": "Bearer s3cret"})
        assert ok.status_code == 200


@pytest.mark.parametrize('message,state,kind', [('429', 'busy', 'rate-limited'), ('403', 'broken', 'blocked'),
                                              ('new extractor failure', 'broken', 'broken')])
def test_provider_health_is_durable_and_additive(client_and_registry, message, state, kind):
    from tests.source_plugin_support import failure
    client, registry = client_and_registry
    registry.register(_descriptor("fake", ProviderKind.STREAMING), _Bare())
    health = app.state.container.get_source_health()
    health.ledger.now = lambda: 10000
    health.jitter = lambda: 1
    health.failure('fake', failure(kind))
    row = next(p for p in client.get('/api/providers').json()['providers'] if p['id'] == 'fake')
    assert row['health'] == {'state': state, 'kind': kind, 'level': 1, 'until': 10060, 'since': 10000, 'firstFailureAt': 10000, 'lastFailureAt': 10000}
    registry.set_enabled('fake', False)
    assert client.get('/api/providers?kind=streaming').json()['providers'][0]['enabled'] is False
    assert client.get('/api/providers?kind=streaming').json()['providers'][0]['health'] == row['health']


def test_retry_unknown_source_is_404(client_and_registry):
    client, _ = client_and_registry
    assert client.post('/api/providers/unknown/retry').status_code == 404


def test_retry_returns_new_health_and_keeps_level(client_and_registry):
    from tests.source_plugin_support import failure
    client, registry = client_and_registry
    registry.register(_descriptor('fake', ProviderKind.STREAMING), _Bare())
    health = app.state.container.get_source_health()
    health.failure('fake', failure('rate-limited'))
    before = health.status('fake')
    response = client.post('/api/providers/fake/retry')
    assert response.status_code == 200
    assert response.json() == {**before, 'state': 'ok', 'until': None}
    row = client.get('/api/providers?kind=streaming').json()['providers'][0]
    assert row['health'] == response.json()
    assert row['format'] is None


def test_audio_source_lists_complete_empty_health_and_actual_format(client_and_registry):
    client, registry = client_and_registry
    registry.register(_descriptor('fake', ProviderKind.STREAMING), _Bare())
    row = client.get('/api/providers?kind=streaming').json()['providers'][0]
    assert row['health'] == dict(state='ok', kind=None, level=None, until=None, since=None,
                                 firstFailureAt=None, lastFailureAt=None)
    assert row['format'] is None
    health = app.state.container.get_source_health()
    health.published('fake', dict(codec='aac', bitrate_bps=191600, container='m4a', transcoded=True))
    row = client.get('/api/providers?kind=streaming').json()['providers'][0]
    assert row['format'] == dict(codec='aac', bitrateKbps=191.6, container='m4a', transcoded=True)
