"""The additive manual updater is owner-only, including from the network."""
from unittest.mock import Mock

import pytest

from app.main import app
from app.dependencies import get_provider_registry, get_container
from app.providers.registry import ProviderDescriptor, ProviderKind, ProviderRegistry
from app.domains.acquisition.sources.status import StatusCache
from tests.integration import test_identity_routes as identity

store = identity.store


@pytest.fixture
def updater():
    service = Mock()
    service.call.return_value = {'revision': 'two'}
    registry = ProviderRegistry()
    registry.register(ProviderDescriptor(id='youtube', name='Test', kind=ProviderKind.STREAMING, description=''), Mock(source=service))
    container = Mock()
    container.get_source_status.return_value = StatusCache()
    container.get_source_health.return_value.retry.return_value = {"state": "ok"}
    app.dependency_overrides[get_provider_registry] = lambda: registry
    app.dependency_overrides[get_container] = lambda: container
    yield service
    app.dependency_overrides.pop(get_provider_registry, None)
    app.dependency_overrides.pop(get_container, None)


def test_owner_can_update_with_automatic_switch_off(store, updater):
    _, token = store.mint('Owner device', 'owner')
    response = identity.remote_client().post('/api/providers/youtube/ytdlp/update', headers=identity.bearer(token))
    assert response.status_code == 200
    assert response.json()['version'] == 'two'
    updater.call.assert_called_once_with('action', {'id': 'update'}, 120_000)


def test_member_cannot_update(store, updater):
    _, token = store.mint('Member device', 'member')
    response = identity.remote_client().post('/api/providers/youtube/ytdlp/update', headers=identity.bearer(token))
    assert response.status_code == 403
    updater.call.assert_not_called()


def test_unauthenticated_remote_cannot_update(store, updater):
    assert identity.remote_client().post('/api/providers/youtube/ytdlp/update').status_code == 401
    updater.call.assert_not_called()


@pytest.mark.parametrize('role,status', [('owner', 200), ('member', 403)])
def test_source_retry_is_owner_only(store, updater, role, status):
    _, token = store.mint('Test device', role)
    response = identity.remote_client().post('/api/providers/youtube/retry', headers=identity.bearer(token))
    assert response.status_code == status


def test_unauthenticated_remote_cannot_retry_source(store):
    assert identity.remote_client().post('/api/providers/youtube/retry').status_code == 401


@pytest.mark.parametrize('method,path,body', [
    ('post', '/api/sources/install', {'location': 'https://example.test/plugin.git'}),
    ('post', '/api/sources/fake/update', None),
    ('post', '/api/sources/fake/action', {'id': 'update'}),
    ('delete', '/api/sources/fake', None),
    ('get', '/api/sources/missing', None),
    ('get', '/api/sources/known', None),
])
def test_source_lifecycle_is_owner_only(store, method, path, body):
    _, token = store.mint('Member device', 'member')
    client = identity.remote_client()
    kwargs = {'json': body} if body is not None else {}
    assert client.request(method.upper(), path, headers=identity.bearer(token), **kwargs).status_code == 403
    assert client.request(method.upper(), path, **kwargs).status_code == 401
