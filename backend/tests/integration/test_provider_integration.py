"""Seams between the provider registry, the dashboard and the container.

Both cases here were found by reading two agents' work against each other
rather than by either one failing its own tests, which is the argument for
pinning them: they are invisible from inside either component.
"""
import logging

import pytest

from app.config import ConfigManager
from app.dependencies import DependencyContainer
from app.domains.dashboard.services import DashboardService
from app.domains.dashboard.models import ROW_ORDER
from app.providers.registry import ProviderKind


class TestOneDeezerClientPerProcess:
    """Share one Deezer limiter across clients using the same per-IP quota.

    Independent limiters can each stay under their budget while exceeding the
    combined quota, whose error arrives inside HTTP 200."""

    def test_registry_and_dashboard_share_one_client(self, tmp_path, monkeypatch):
        monkeypatch.setenv("KROBI_PROVIDERS_FILE", str(tmp_path / "providers.json"))
        monkeypatch.setenv("KROBI_DASHBOARD_CACHE_FILE", str(tmp_path / "dash.json"))
        container = DependencyContainer(ConfigManager.from_env())

        shared = container.get_deezer_repository()
        registry = container.get_provider_registry()
        dashboard = container.get_dashboard_service()

        registered = registry.get("deezer")
        assert registered is not None, "deezer metadata provider should be registered"
        _descriptor, metadata_provider = registered

        # The metadata adapter, the dashboard provider and the container must
        # all be holding the same object, not merely equal ones.
        assert metadata_provider.repository is shared
        assert dashboard.provider.deezer is shared

    def test_browse_shares_the_same_client(self, tmp_path, monkeypatch):
        """Browse multiplies Deezer traffic; it must not multiply the limiter.

        An album page is 2 requests and an artist page is 5, so browsing is by
        far the heaviest Deezer consumer in the process. A browse provider
        holding its own DeezerRepository would pace itself independently of the
        resolver and the dashboard against a single per-IP quota — and the
        breach comes back as HTTP 200 with {"error":{"code":4}}, so the only
        symptom would be pages that are intermittently, silently empty.
        """
        monkeypatch.setenv("KROBI_PROVIDERS_FILE", str(tmp_path / "providers.json"))
        monkeypatch.setenv("KROBI_BROWSE_CACHE_FILE", str(tmp_path / "browse.json"))
        container = DependencyContainer(ConfigManager.from_env())

        shared = container.get_deezer_repository()
        registry = container.get_provider_registry()

        _descriptor, metadata_provider = registry.get("deezer")
        # The browse mapper hangs off the same adapter instance the registry
        # dispatches to, and wraps the same repository object.
        assert metadata_provider.browse.deezer is shared

    def test_browse_service_dispatches_through_the_registry(self, tmp_path, monkeypatch):
        """Not around it: this is what makes the Sources order mean something."""
        monkeypatch.setenv("KROBI_PROVIDERS_FILE", str(tmp_path / "providers.json"))
        monkeypatch.setenv("KROBI_BROWSE_CACHE_FILE", str(tmp_path / "browse.json"))
        container = DependencyContainer(ConfigManager.from_env())

        assert container.get_browse_service().registry is container.get_provider_registry()

    def test_deezer_declares_the_browse_capabilities_it_implements(self, tmp_path, monkeypatch):
        """A declared capability is a promise the instance carries the method.

        Dispatch checks the descriptor rather than hasattr, so a capability
        listed without its method would fail at request time instead of at
        registration time — which is exactly the failure mode capability-gating
        exists to prevent.
        """
        monkeypatch.setenv("KROBI_PROVIDERS_FILE", str(tmp_path / "providers.json"))
        container = DependencyContainer(ConfigManager.from_env())
        registry = container.get_provider_registry()

        descriptor, instance = registry.get("deezer")
        required = {
            "album:details": "fetch_album_page",
            "playlist:details": "fetch_playlist_page",
            "artist:details": "fetch_artist_page",
            "genre:details": "fetch_genre_page",
            "search:albums": "search_catalog",
        }
        for capability, method in required.items():
            assert capability in descriptor.capabilities
            assert callable(getattr(instance, method, None)), f"{capability} promises {method}"

    def test_container_memoizes_the_client(self, tmp_path, monkeypatch):
        monkeypatch.setenv("KROBI_PROVIDERS_FILE", str(tmp_path / "providers.json"))
        container = DependencyContainer(ConfigManager.from_env())
        assert container.get_deezer_repository() is container.get_deezer_repository()


class _FakeProvider:
    """Counts outbound calls so 'did it actually stop' is observable."""

    provider_id = "deezer-dashboard"
    provider_name = "Deezer"

    def __init__(self):
        self.chart_calls = 0
        self.release_calls = 0

    def fetch_chart_rows(self):
        self.chart_calls += 1
        return {
            "top-playlists": [self._item("p1")],
            "top-artists": [self._item("a1")],
            "top-albums": [self._item("al1")],
        }

    def fetch_new_releases(self):
        self.release_calls += 1
        return [self._item("r1")]

    @staticmethod
    def _item(item_id):
        from app.domains.dashboard.models import DashboardItem

        return DashboardItem(id=item_id, title=f"Title {item_id}")

    def row_ids(self):
        return ["top-playlists", "top-artists", "top-albums", "new-releases"]

    def blank_row(self, row_id, error=None):
        from app.domains.dashboard.models import DashboardRow

        return DashboardRow(id=row_id, title=row_id, kind="album", items=[], error=error)


class _FakeCache:
    def __init__(self, snapshot=None):
        self.snapshot = snapshot

    def load(self):
        return self.snapshot

    def save(self, snapshot):
        self.snapshot = snapshot
        return True


class _Registry:
    """Minimal stand-in: only `order` is consulted."""

    def __init__(self, enabled):
        self._enabled = enabled

    def order(self, kind):
        assert kind is ProviderKind.DASHBOARD
        return ["deezer-dashboard"] if self._enabled else []


@pytest.fixture
def service_factory():
    def build(registry, cache=None):
        provider = _FakeProvider()
        service = DashboardService(
            provider=provider,
            cache_repo=cache or _FakeCache(),
            config=None,
            logger=logging.getLogger("test"),
            registry=registry,
        )
        return service, provider

    return build


class TestDisablingTheDashboardProviderStopsTraffic:
    """Turning a provider off in the UI must stop requests, not just hide rows."""

    def test_disabled_provider_makes_no_outbound_calls(self, service_factory):
        service, provider = service_factory(_Registry(enabled=False))

        service.get_dashboard()

        assert provider.chart_calls == 0
        assert provider.release_calls == 0

    def test_enabled_provider_still_fetches(self, service_factory):
        service, provider = service_factory(_Registry(enabled=True))

        service.get_dashboard()

        assert provider.chart_calls == 1

    def test_disabled_provider_serves_cache_rather_than_blanking(self, service_factory):
        """Disabling a provider preserves its cached content."""
        seeded, seed_provider = service_factory(_Registry(enabled=True))
        seeded.get_dashboard()
        cache = seeded.cache
        assert cache.snapshot is not None
        assert seed_provider.chart_calls == 1

        service, provider = service_factory(_Registry(enabled=False), cache=cache)
        result = service.get_dashboard()

        assert provider.chart_calls == 0
        assert result.rows, "cached rows should still be served"

    def test_disabled_with_no_cache_returns_a_titled_page_not_a_blank_one(
        self, service_factory
    ):
        service, _provider = service_factory(_Registry(enabled=False))

        result = service.get_dashboard()

        assert [r.id for r in result.rows] == list(ROW_ORDER), "every row keeps its heading"
        assert all(r.error for r in result.rows)

    def test_no_registry_means_serve__not_go_dark(self, service_factory):
        """The gate honours an explicit choice; it must not add a failure mode."""
        service, provider = service_factory(None)

        service.get_dashboard()

        assert provider.chart_calls == 1
