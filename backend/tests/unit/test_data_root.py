"""Shared root contract and compatibility with per-path operator pins."""
import json
from pathlib import Path

import pytest

from app.infra.paths import resolve_data_root

CASES = json.loads((Path(__file__).resolve().parents[3] / 'contracts/data-root.json').read_text())['cases']


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


def test_per_path_overrides_do_not_relocate_siblings(tmp_path, monkeypatch):
    from app.config import ConfigManager, REQUIRED_DIRS, STATE_PATHS
    root = tmp_path / 'root'
    monkeypatch.setenv('FLIPSPIN_DATA_DIR', str(root))
    for _attr, (variable, name) in {**REQUIRED_DIRS, **STATE_PATHS}.items():
        monkeypatch.setenv(variable, str(tmp_path / 'pins' / name))
    config = ConfigManager.from_env()
    assert config.data_root == root
    for attr, (_, name) in {**REQUIRED_DIRS, **STATE_PATHS}.items():
        assert getattr(config, attr) == tmp_path / 'pins' / name
    assert config.cover_cache_dir == root / 'cache/covers'


def test_playlist_pin_only_changes_playlists(tmp_path, monkeypatch):
    from app.config import ConfigManager
    root = tmp_path / 'root'
    monkeypatch.setenv('FLIPSPIN_DATA_DIR', str(root))
    monkeypatch.setenv('KROBI_PLAYLIST_DIR', str(tmp_path / 'elsewhere'))
    config = ConfigManager.from_env()
    assert config.users_file == root / 'users.json'
    assert config.secrets.env_path == root / '.env'


def test_root_does_not_change_when_legacy_playlist_override_is_created(tmp_path, monkeypatch):
    from app.infra.paths import data_root, root_source
    from app.config import ConfigManager
    monkeypatch.delenv('FLIPSPIN_DATA_DIR', raising=False)
    monkeypatch.delenv('KROBI_DATA_DIR', raising=False)
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('KROBI_PLAYLIST_DIR', str(tmp_path / 'Krobi/playlists'))
    selected = data_root()
    config = ConfigManager.from_env()
    assert config.data_root == selected == data_root()
    assert root_source() == 'OS default'


def test_existing_systemd_per_path_environment_keeps_all_paths(tmp_path, monkeypatch):
    from app.config import ConfigManager, REQUIRED_DIRS, STATE_PATHS
    home = tmp_path / 'service'
    legacy = home / 'Krobi'
    legacy.mkdir(parents=True)
    (legacy / 'users.json').write_text('{}')
    monkeypatch.setenv('HOME', str(home))
    monkeypatch.delenv('FLIPSPIN_DATA_DIR', raising=False)
    monkeypatch.delenv('KROBI_DATA_DIR', raising=False)
    for variable, name in REQUIRED_DIRS.values():
        monkeypatch.setenv(variable, str(legacy / name))
    config = ConfigManager.from_env()
    assert config.data_root == legacy
    for attr, (_, name) in {**REQUIRED_DIRS, **STATE_PATHS}.items():
        assert getattr(config, attr) == legacy / name


def test_new_installs_keep_music_in_the_os_music_folder(tmp_path, monkeypatch):
    from app.infra import paths
    monkeypatch.delenv('KROBI_MUSIC_DIR', raising=False)
    monkeypatch.delenv('XDG_MUSIC_DIR', raising=False)
    monkeypatch.setattr(paths.Path, 'home', lambda: tmp_path)
    monkeypatch.setattr(paths, '_selection', lambda: (tmp_path / 'Library/Application Support/Flipspin', 'OS default'))
    assert paths.default_music_dir() == tmp_path / 'Music' / 'Flipspin'
    monkeypatch.setattr(paths, '_selection', lambda: (tmp_path / 'Krobi', 'legacy data'))
    assert paths.default_music_dir() == tmp_path / 'Krobi' / 'Music'
    monkeypatch.setenv('KROBI_MUSIC_DIR', str(tmp_path / 'Chosen'))
    assert paths.default_music_dir() == tmp_path / 'Chosen'
