"""Shared root contract and compatibility with per-path operator pins."""
import json
from pathlib import Path

import pytest

from krobi_helper.paths import resolve_data_root

CASES = json.loads((Path(__file__).resolve().parents[2] / 'contracts/data-root.json').read_text())['cases']


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['id'])
def test_contract(case, tmp_path):
    home = tmp_path / 'home'
    home.mkdir()
    def expand(value):
        return value.replace('$HOME', str(home)).replace('$CASE', str(tmp_path))
    for entry in case['legacy']:
        path = home / 'Krobi' / entry
        path.parent.mkdir(parents=True, exist_ok=True)
        if entry.endswith('/'):
            path.mkdir(exist_ok=True)
        else:
            path.touch()
    before = sorted(str(path) for path in tmp_path.rglob('*'))
    args = dict(env={key: expand(value) for key, value in case['env'].items()},
                home=home, platform=case['platform'])
    flag = expand(case['flag']) if 'flag' in case else None
    if 'error' in case:
        with pytest.raises(ValueError, match=case['error']):
            resolve_data_root(flag, **args)
    else:
        root, source = resolve_data_root(flag, **args)
        assert root == Path(expand(case['expected'])).absolute()
        assert source == case['source']
    assert sorted(str(path) for path in tmp_path.rglob('*')) == before


def test_cli_refuses_conflicting_roots_even_with_per_path_pins(monkeypatch, tmp_path, capsys):
    from krobi_helper.cli import main
    monkeypatch.setenv('FLIPSPIN_DATA_DIR', str(tmp_path / 'first'))
    monkeypatch.setenv('KROBI_DATA_DIR', str(tmp_path / 'second'))
    monkeypatch.setenv('KROBI_MODELS_DIR', str(tmp_path / 'models'))
    monkeypatch.setenv('KROBI_TOOLS_DIR', str(tmp_path / 'tools'))
    with pytest.raises(SystemExit) as error:
        main(['check'])
    assert error.value.code == 2
    assert 'FLIPSPIN_DATA_DIR and KROBI_DATA_DIR' in capsys.readouterr().err
    assert not list(tmp_path.iterdir())
