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


PLATFORM_ROOTS = [
    ('win32', {'LOCALAPPDATA': 'local'}, 'local/Flipspin'),
    ('darwin', {}, 'Library/Application Support/Flipspin'),
    ('linux', {}, '.local/share/flipspin'),
]


def _env(tmp_path, env):
    return {key: str(tmp_path / value) for key, value in env.items()}


@pytest.mark.parametrize('platform, env, root', PLATFORM_ROOTS, ids=[case[0] for case in PLATFORM_ROOTS])
def test_desktop_root_without_a_library_uses_the_os_music_folder(tmp_path, platform, env, root):
    # The desktop app passes its own data folder explicitly; a fresh one is still a new install.
    from app.infra.paths import music_dir_for
    before = sorted(tmp_path.rglob('*'))
    music = music_dir_for(tmp_path / root, 'FLIPSPIN_DATA_DIR', env=_env(tmp_path, env), home=tmp_path, platform=platform)
    assert music == tmp_path / 'Music' / 'Flipspin'
    assert sorted(tmp_path.rglob('*')) == before


@pytest.mark.parametrize('platform, env, root', PLATFORM_ROOTS, ids=[case[0] for case in PLATFORM_ROOTS])
def test_explicit_root_with_a_library_keeps_it(tmp_path, platform, env, root):
    from app.infra.paths import music_dir_for
    (tmp_path / root / 'Music').mkdir(parents=True)
    music = music_dir_for(tmp_path / root, 'FLIPSPIN_DATA_DIR', env=_env(tmp_path, env), home=tmp_path, platform=platform)
    assert music == tmp_path / root / 'Music'


@pytest.mark.parametrize('source', ['FLIPSPIN_DATA_DIR', 'KROBI_DATA_DIR', '--data-dir', 'legacy data'])
def test_other_explicit_roots_keep_root_music_even_before_it_exists(tmp_path, source):
    from app.infra.paths import music_dir_for
    root = tmp_path / 'data'
    music = music_dir_for(root, source, env={}, home=tmp_path / 'home', platform='linux')
    assert music == root / 'Music'
    assert not music.exists()


def test_saved_music_choice_still_wins_over_the_desktop_default(tmp_path, monkeypatch):
    from app.config import ConfigManager
    from app.infra import paths
    root = tmp_path / 'local' / 'Flipspin'
    root.mkdir(parents=True)
    (root / '.env').write_text(f'KROBI_MUSIC_DIR={tmp_path / "Chosen"}\n')
    monkeypatch.delenv('KROBI_MUSIC_DIR', raising=False)
    monkeypatch.setattr(paths, '_selection', lambda: (root, 'FLIPSPIN_DATA_DIR'))
    monkeypatch.setattr('app.config.resolve_root', lambda: root)
    assert ConfigManager.from_env().base_music_dir == tmp_path / 'Chosen'
