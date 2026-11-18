"""Shared extension manifest semantics and pre-import refusal."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.infra.extensions import (
    KIND_PROTOCOL, KIND_RUNTIMES, builtin_engines, parse_manifest, read_manifest, source_extensions,
)
from app.plugins import load_plugins
from tests.unit.test_plugins import host, write_plugin

CASES = json.loads((Path(__file__).resolve().parents[3] / 'contracts/extensions.json').read_text())['cases']


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_shared_manifest_cases(case):
    extension = parse_manifest(case['manifest'])
    assert extension.state == case['state']
    if case['state'] == 'on':
        assert extension.id == case['manifest']['id']
        if 'runtimes' in case:
            assert KIND_RUNTIMES[extension.kind] == set(case['runtimes'])
            assert KIND_PROTOCOL[extension.kind] == case['protocol']
    else:
        assert extension.reason


def test_unknown_keys_are_discarded():
    extension = parse_manifest(next(case['manifest'] for case in CASES if case['id'] == 'future-keys'))
    assert 'future' not in extension.model_dump()


@pytest.mark.parametrize('content', ['{', 'null', '[]', 'true'])
def test_bad_json_is_observable(tmp_path, content):
    path = tmp_path / 'krobi-extension.json'
    path.write_text(content)
    assert read_manifest(path).state == 'invalid'


def test_missing_manifest_is_invalid(tmp_path):
    assert read_manifest(tmp_path / 'krobi-extension.json').state == 'invalid'


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_loader_checks_before_import(config, tmp_path, monkeypatch, case):
    package = 'test_manifest_plugin'
    write_plugin(tmp_path, package, 'raise AssertionError("must not import")\n')
    manifest = {**case['manifest']}
    if manifest.get('kind') == 'feature' and manifest.get('entry', {}).get('module'):
        manifest['entry'] = {'module': package + '.krobi_plugin'}
    (tmp_path / package / 'krobi-extension.json').write_text(json.dumps(manifest))
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    imported = Mock(return_value=Mock(__file__=str(tmp_path / package / 'krobi_plugin.py')))
    monkeypatch.setattr('app.plugins.importlib.import_module', imported)
    app = host(config)
    load_plugins(app, [])
    eligible = case['state'] == 'on' and manifest.get('kind') == 'feature'
    assert imported.call_count == int(eligible)
    if not eligible:
        assert app.state.plugins == []
        assert app.state.plugin_extensions[0].state in {'invalid', 'incompatible'}


def test_legacy_loads_with_warning(config, tmp_path, monkeypatch, caplog):
    write_plugin(tmp_path, 'test_legacy_manifest', 'def register(context): pass\n')
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    app = host(config)
    assert load_plugins(app, []) == ['test_legacy_manifest']
    assert 'legacy' in caplog.text and 'one release' in caplog.text
    assert 'Legacy' in app.state.plugin_extensions[0].reason


def test_discovery_does_not_execute_and_refuses_duplicates(tmp_path):
    data, builtins = tmp_path / 'data', tmp_path / 'builtin'
    manifest = next(case['manifest'] for case in CASES if case['id'] == 'valid-source')
    for root in (data / 'sources', builtins):
        package = root / 'example'
        package.mkdir(parents=True)
        (package / 'krobi-extension.json').write_text(json.dumps(manifest))
        (package / '__init__.py').write_text('raise AssertionError("never import sources")')
    extensions = source_extensions(data, builtins)
    assert len(extensions) == 1
    assert extensions[0].state == 'invalid'
    assert 'Duplicate' in extensions[0].reason
    assert {engine.id: engine.entry.extra for engine in builtin_engines()} == {
        'lyrics': 'engine', 'stems': 'stems', 'analysis': 'analysis'}


def test_failed_registration_is_observed(config, tmp_path, monkeypatch):
    write_plugin(tmp_path, 'test_manifest_failure', 'def register(context): raise RuntimeError("broken")\n')
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    app = host(config)
    assert load_plugins(app, []) == []
    assert app.state.plugin_extensions[0].state == 'failed:registration'


def test_reserved_engine_id_never_imports(config, tmp_path, monkeypatch):
    package = 'test_engine_collision'
    write_plugin(tmp_path, package, 'raise AssertionError("must not import")\n')
    manifest = {**CASES[0]['manifest'], 'id': 'lyrics', 'entry': {'module': package + '.krobi_plugin'}}
    (tmp_path / package / 'krobi-extension.json').write_text(json.dumps(manifest))
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    imported = Mock()
    monkeypatch.setattr('app.plugins.importlib.import_module', imported)
    app = host(config)
    assert load_plugins(app, []) == []
    imported.assert_not_called()
    assert app.state.plugin_extensions[0].state == 'invalid'


def test_duplicate_plugin_ids_refused_before_either_import(config, tmp_path, monkeypatch):
    for package in ('test_duplicate_one', 'test_duplicate_two'):
        write_plugin(tmp_path, package, 'raise AssertionError("must not import")\n')
        manifest = {**CASES[0]['manifest'], 'entry': {'module': package + '.krobi_plugin'}}
        (tmp_path / package / 'krobi-extension.json').write_text(json.dumps(manifest))
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    imported = Mock()
    monkeypatch.setattr('app.plugins.importlib.import_module', imported)
    app = host(config)
    assert load_plugins(app, []) == []
    imported.assert_not_called()
    assert len(app.state.plugin_extensions) == 2
    assert all(extension.state == 'invalid' for extension in app.state.plugin_extensions)
    assert load_plugins(app, []) == []
    assert len(app.state.plugin_extensions) == 2


def test_broken_manifest_link_is_not_legacy(config, tmp_path, monkeypatch):
    write_plugin(tmp_path, 'test_broken_manifest_link', 'raise AssertionError("must not import")\n')
    (tmp_path / 'test_broken_manifest_link' / 'krobi-extension.json').symlink_to(tmp_path / 'missing.json')
    monkeypatch.setenv('KROBI_PLUGINS_DIR', str(tmp_path))
    imported = Mock()
    monkeypatch.setattr('app.plugins.importlib.import_module', imported)
    app = host(config)
    assert load_plugins(app, []) == []
    imported.assert_not_called()
    assert app.state.plugin_extensions[0].state == 'invalid'


def test_builtin_engine_versions_match_shipped_helper():
    from app.domains.helpers.mac_worker import SHIPPED_WORKER_VERSION

    engines = builtin_engines()
    assert {engine.id for engine in engines} == {'lyrics', 'stems', 'analysis'}
    assert all(engine.version == SHIPPED_WORKER_VERSION for engine in engines)
