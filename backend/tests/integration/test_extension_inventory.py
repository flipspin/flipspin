"""Owner-only extension inventory, including source and plugin observations."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.plugins import load_plugins
from tests.integration.test_wire_snapshots import assert_matches_snapshot
from tests.unit.test_plugins import write_plugin

CASES = json.loads((Path(__file__).resolve().parents[3] / 'contracts/extensions.json').read_text())['cases']


def test_extension_inventory_and_wire(accounts, tmp_path, monkeypatch):
    package = 'test_inventory_plugin'
    root = tmp_path / 'plugins'
    write_plugin(root, package, 'def register(context): pass\n')
    feature = {**CASES[0]['manifest'], 'id': 'example-feature', 'entry': {'module': package + '.krobi_plugin'}}
    (root / package / 'krobi-extension.json').write_text(json.dumps(feature))
    source = {**next(case['manifest'] for case in CASES if case['id'] == 'valid-source'), 'adds': ['source:audio']}
    from app.providers.adapters import SourceStreamingProvider
    from app.providers.registry import ProviderDescriptor, ProviderKind
    port = SimpleNamespace(state='on', reason=None, close=lambda: None)
    registry = app.state.container.get_provider_registry()
    registry.register(ProviderDescriptor(id=source['id'], name=source['name'], kind=ProviderKind.STREAMING, description=''), SourceStreamingProvider(port))
    source_root = app.state.config.playlist_dir.parent / 'sources' / 'example'
    source_root.mkdir(parents=True)
    (source_root / 'krobi-extension.json').write_text(json.dumps(source))
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(root))
    # Built-in sources come and go with packaging; this test covers installed ones only.
    monkeypatch.setattr(app.state, 'plugins', [])
    monkeypatch.setattr(app.state, 'plugin_extensions', [], raising=False)
    monkeypatch.setattr(app.state.container, 'get_lyrics_service', lambda: SimpleNamespace(engine=SimpleNamespace(
        status=lambda: {'addons': {'lyrics': {'ready': True}, 'stems': {'error': 'details'}, 'analysis': {'ready': False}}})))
    # Registration invalidates the schema cache; keep this host mutation local to the test.
    monkeypatch.setattr(app, "openapi_schema", app.openapi_schema)
    load_plugins(app, [])
    _, token = accounts.mint('Owner', 'owner')
    response = TestClient(app).get('/api/extensions', headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 200
    body = response.json()
    assert {row['id'] for row in body['extensions']} == {'lyrics', 'stems', 'analysis', 'example', 'example-feature'}
    states = {row['id']: row['state'] for row in body['extensions']}
    assert states['lyrics'] == 'on' and states['stems'] == 'failed:installation' and states['analysis'] == 'off'
    # Freeze release metadata so helper bumps do not rebaseline the wire shape.
    # Manifest versions are checked separately against the shipped helper.
    for row in body['extensions']:
        if row['kind'] == 'engine':
            row['version'] = '0.15.7'
    try:
        assert_matches_snapshot('extensions', body)
    finally:
        registry.unregister(source['id'])


def test_member_cannot_read_extensions(accounts):
    _, token = accounts.mint('Member', 'member')
    assert TestClient(app).get('/api/extensions', headers={'Authorization': f'Bearer {token}'}).status_code == 403


def test_remote_unauthenticated_cannot_read_extensions(accounts):
    assert TestClient(app, client=('192.0.2.1', 51000)).get('/api/extensions').status_code == 401


@pytest.mark.parametrize('state', ['restart-pending', 'off', 'failed:registration', 'incompatible', 'invalid'])
def test_inventory_preserves_plugin_state(accounts, monkeypatch, state):
    from app.infra.extensions import Extension
    monkeypatch.setattr(app.state, 'plugin_extensions', [Extension(id='observed', kind='feature', name='Observed', state=state, reason='Details')], raising=False)
    monkeypatch.setattr(app.state.container, 'get_lyrics_service', lambda: SimpleNamespace(engine=SimpleNamespace(status=lambda: {})))
    response = TestClient(app).get('/api/extensions')
    assert response.status_code == 200
    observed = next(row for row in response.json()['extensions'] if row['id'] == 'observed')
    assert observed['state'] == state and observed['reason'] == 'Details'


@pytest.mark.parametrize('state', ['incompatible', 'invalid'])
def test_engine_readiness_does_not_mask_refusal(accounts, monkeypatch, state):
    from app.infra.extensions import Extension
    engine = Extension(id='lyrics', kind='engine', name='Lyrics', state=state, reason='Refused')
    monkeypatch.setattr('app.domains.system.routes.builtin_engines', lambda: [engine])
    monkeypatch.setattr(app.state.container, 'get_lyrics_service', lambda: SimpleNamespace(engine=SimpleNamespace(status=lambda: {})))
    row = TestClient(app).get('/api/extensions').json()['extensions'][0]
    assert row['state'] == state and row['reason'] == 'Refused'
