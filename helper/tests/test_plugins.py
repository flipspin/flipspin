"""Plugin isolation, command discovery and queue priority without model imports."""
import argparse
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from krobi_helper import cli, plugins
from krobi_helper.agent import Agent
from krobi_helper.extensions import KIND_PROTOCOL, KIND_RUNTIMES, manifest_state


@pytest.fixture(autouse=True)
def reset_registry(monkeypatch):
    plugins.load_plugins.cache_clear()
    monkeypatch.setattr(plugins.importlib.metadata, "entry_points", lambda **_: [])
    yield
    plugins.load_plugins.cache_clear()


def test_registration_is_sorted_and_failed_plugin_is_atomic(monkeypatch):
    seen = []

    def register(reg):
        seen.append("ok")
        reg.add_check("optional", lambda: {"installed": True})
        reg.add_command("example", lambda p: p.set_defaults(fn=lambda _: 7))

    def broken(reg):
        reg.add_check("partial", lambda: True)
        raise RuntimeError("broken")

    def ep(name, fn):
        return SimpleNamespace(name=name, load=lambda: SimpleNamespace(register=fn))

    monkeypatch.setattr(plugins.importlib.metadata, "entry_points", lambda **_: [ep("z", register), ep("a", broken)])
    assert list(plugins.load_plugins().checks) == ["optional"]
    assert cli.main(["example"]) == 7
    assert seen == ["ok"]


def test_checks_cannot_override_core_readiness(capsys):
    registry = plugins.load_plugins()
    with pytest.raises(ValueError):
        registry.add_check("ready", lambda: True)
    registry.add_check("optional", lambda: {"installed": False})
    cli.cmd_check(argparse.Namespace())
    status = json.loads(capsys.readouterr().out)
    assert status["optional"] == {"installed": False}
    assert "ready" in status


def test_claim_steps_follow_core_and_first_work_ends_turn(tmp_path, monkeypatch):
    agent = Agent("http://example.test", "token", work_dir=tmp_path, log=lambda _: None)
    calls = []
    monkeypatch.setattr(agent, "_watch_parent", lambda: None)
    monkeypatch.setattr(agent, "_request", lambda *args, **kwargs: calls.append("lyrics") or {"jobs": []})
    monkeypatch.setattr(agent, "_claim_stems", lambda: calls.append("stems"))
    agent._legacy_api = True
    agent.claim_steps = [lambda _: calls.append("one") or True, lambda _: calls.append("two") or True]
    assert agent.run(once=True) == 0
    assert calls == ["lyrics", "stems", "one"]


def test_legacy_group_plugin_imports_old_api_and_runs(monkeypatch, capsys):
    """Ties-style imports and its existing distribution group stay usable."""
    from krobi_lyrics.cli import _module_ok
    from krobi_lyrics.agent import Agent as LegacyAgent, StopRequested
    from krobi_helper.agent import StopRequested as CurrentStopRequested
    from krobi_lyrics.pipeline import ffmpeg_binary
    from krobi_helper.kinds.lyrics.pipeline import ffmpeg_binary as current_ffmpeg

    assert LegacyAgent is Agent
    assert StopRequested is CurrentStopRequested
    assert ffmpeg_binary is current_ffmpeg
    assert _module_ok("json")
    groups = []

    def register(registry):
        registry.add_check("ties", lambda: {"installed": True})
        registry.add_command("embed", lambda p: p.set_defaults(fn=lambda _: 0))

    legacy = SimpleNamespace(name="ties", load=lambda: SimpleNamespace(register=register))

    def entries(*, group):
        groups.append(group)
        return [legacy] if group == "krobi_lyrics.plugins" else []

    monkeypatch.setattr(plugins.importlib.metadata, "entry_points", entries)
    assert cli.main(["embed"]) == 0
    cli.cmd_check(argparse.Namespace())
    assert json.loads(capsys.readouterr().out)["ties"] == {"installed": True}
    assert groups == ["krobi_helper.plugins", "krobi_lyrics.plugins"]


def test_plugin_in_both_groups_registers_once_with_new_group_preferred(monkeypatch):
    seen = []

    def entries(*, group):
        return [SimpleNamespace(name="ties", load=lambda: SimpleNamespace(register=lambda _: seen.append(group)))]

    monkeypatch.setattr(plugins.importlib.metadata, "entry_points", entries)
    plugins.load_plugins()
    assert seen == ["krobi_helper.plugins"]


CASES = json.loads((Path(__file__).resolve().parents[2] / 'contracts/extensions.json').read_text())['cases']


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_shared_extension_contract(case):
    state, reason = manifest_state(case['manifest'])
    assert state == case['state']
    if state != 'on':
        assert reason
    if 'runtimes' in case:
        assert KIND_RUNTIMES[case['manifest']['kind']] == set(case['runtimes'])
        assert KIND_PROTOCOL[case['manifest']['kind']] == case['protocol']


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_manifest_gate_precedes_entry_point_load(case, tmp_path, monkeypatch):
    root = tmp_path / 'worker_extension'
    root.mkdir()
    path = root / 'krobi-extension.json'
    path.write_text(json.dumps(case['manifest']))
    distribution = SimpleNamespace(files=[Path('worker_extension/krobi-extension.json')],
                                   locate_file=lambda file: tmp_path / file)
    load = Mock(return_value=SimpleNamespace(register=lambda reg: reg.add_check('manifest_test', lambda: True)))
    entry = SimpleNamespace(name='manifest_test', value='worker_extension.plugin:register', dist=distribution, load=load)
    monkeypatch.setattr(plugins.importlib.metadata, 'entry_points', lambda **_: [entry])
    registry = plugins.load_plugins()
    eligible = case['state'] == 'on' and case['manifest']['kind'] == 'engine'
    assert load.call_count == int(eligible)
    assert ('manifest_test' in registry.checks) == eligible


def test_unreadable_manifest_never_imported(tmp_path, monkeypatch):
    path = tmp_path / 'krobi-extension.json'
    path.write_text('{')
    load = Mock()
    entry = SimpleNamespace(name='invalid', value='invalid:register',
                            dist=SimpleNamespace(files=[Path('krobi-extension.json')], locate_file=lambda _: path), load=load)
    monkeypatch.setattr(plugins.importlib.metadata, 'entry_points', lambda **_: [entry])
    assert plugins.load_plugins().extensions[0]['state'] == 'invalid'
    load.assert_not_called()


def test_legacy_warning(monkeypatch, caplog):
    entry = SimpleNamespace(name='legacy', load=lambda: SimpleNamespace(register=lambda reg: None))
    monkeypatch.setattr(plugins.importlib.metadata, 'entry_points', lambda **_: [entry])
    assert plugins.load_plugins().extensions[0]['state'] == 'on'
    assert 'legacy' in caplog.text and 'one release' in caplog.text


def test_duplicate_manifest_ids_refused_before_any_entry_load(tmp_path, monkeypatch):
    manifest = next(case['manifest'] for case in CASES if case['id'] == 'valid-engine')
    path = tmp_path / 'krobi-extension.json'
    path.write_text(json.dumps(manifest))
    distribution = SimpleNamespace(files=[Path('krobi-extension.json')], locate_file=lambda _: path)
    entries = [SimpleNamespace(name=name, value=name + '.plugin:register', dist=distribution, load=Mock())
               for name in ('first', 'second')]
    monkeypatch.setattr(plugins.importlib.metadata, 'entry_points', lambda **_: entries)
    registry = plugins.load_plugins()
    assert len(registry.extensions) == 2
    assert all(item['state'] == 'invalid' for item in registry.extensions)
    for entry in entries:
        entry.load.assert_not_called()


@pytest.mark.parametrize('location', ['worker_extension', 'worker_extension/nested', 'worker_extension/nested/plugin'])
def test_nested_entry_point_manifest_is_checked_before_import(location, tmp_path, monkeypatch):
    manifest = next(case['manifest'] for case in CASES if case['id'] == 'valid-engine')
    manifest = {**manifest, 'protocol': {'helper': [2]}}
    file = Path(location) / 'krobi-extension.json'
    path = tmp_path / file
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(manifest))
    distribution = SimpleNamespace(files=[file], locate_file=lambda file: tmp_path / file)
    entry = SimpleNamespace(name='nested', value='worker_extension.nested.plugin:register', dist=distribution, load=Mock())
    monkeypatch.setattr(plugins.importlib.metadata, 'entry_points', lambda **_: [entry])
    assert plugins.load_plugins().extensions[0]['state'] == 'incompatible'
    entry.load.assert_not_called()
