"""The dev entry point discards install inputs and starts both owned processes."""
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.fixture
def launcher():
    path = Path(__file__).resolve().parents[3] / 'scripts/dev.py'
    spec = importlib.util.spec_from_file_location('flipspin_dev', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_environment_ignores_external_install_inputs(launcher, tmp_path, monkeypatch):
    for key in ('FLIPSPIN_DATA_DIR', 'KROBI_DATA_DIR', 'KROBI_MUSIC_DIR', 'KROBI_USERS_FILE',
                'KROBI_API_TOKEN', 'KROBI_SECRET_KEY_FILE', 'CREDENTIALS_DIRECTORY', 'SPOTIFY_CLIENT_SECRET'):
        monkeypatch.setenv(key, 'planted-production-setting')
    env = launcher.environment(tmp_path)
    assert env['FLIPSPIN_DATA_DIR'] == str(tmp_path)
    assert env['KROBI_DEFAULT_SONGS_PATH'] == str(launcher.REPO / 'resources/default-songs')
    assert 'planted-production-setting' not in env.values()


def test_launch_seeds_once_and_stops_both_children(launcher, tmp_path, monkeypatch):
    control = tmp_path / 'session/control.json'
    monkeypatch.setattr(launcher, 'CONTROL', control)
    server, desktop = Mock(), Mock()
    server.poll.return_value = None
    desktop.poll.return_value = 0
    popen = Mock(side_effect=[server, desktop])
    monkeypatch.setattr(launcher.subprocess, 'Popen', popen)
    monkeypatch.setattr(launcher.shutil, 'which', lambda _: 'npm')
    monkeypatch.setattr(launcher, 'terminate', Mock())
    root = tmp_path / 'data'
    def request(port, path, body=None):
        if path == '/api/health':
            return {'base_music_dir': str(root / 'Music')}
        assert body['username'] == 'dev'
        assert body['password'] == launcher.PASSWORD
        return {'token': 'unused-dev-token'}
    request_mock = Mock(side_effect=request)
    monkeypatch.setattr(launcher, 'request', request_mock)
    launcher.run(root)
    assert len(popen.call_args_list) == 2
    first, second = popen.call_args_list
    assert '--data-dir' in first.args[0]
    assert second.kwargs['env']['FLIPSPIN_DATA_DIR'] == str(root)
    assert (root / '.dev-seeded').exists()
    assert not control.exists()
    assert launcher.terminate.call_args_list[0].args == (desktop,)
    assert launcher.terminate.call_args_list[1].args == (server,)
    # A second run keeps the owner and does not restore deleted starter albums.
    popen.side_effect = [server, desktop]
    request_mock.reset_mock()
    launcher.run(root)
    assert request_mock.call_count == 1
    assert 'KROBI_DEFAULT_SONGS_PATH' not in popen.call_args_list[-2].kwargs['env']


def test_stop_removes_only_a_stale_control_record(launcher, tmp_path, monkeypatch):
    control = tmp_path / 'control.json'
    control.write_text(json.dumps({'port': 1, 'token': 'stale'}))
    monkeypatch.setattr(launcher, 'CONTROL', control)
    monkeypatch.setattr(launcher.socket, 'create_connection', Mock(side_effect=ConnectionRefusedError))
    launcher.stop()
    assert not control.exists()


def test_check_rejects_a_planted_home_write(launcher, tmp_path, monkeypatch):
    home = tmp_path / 'home'
    home.mkdir()
    monkeypatch.setenv('HOME', str(home))
    monkeypatch.setattr(launcher.sys, 'argv', ['dev.py', 'check'])
    def planted_write(root, check=False):
        (home / 'planted-escape').touch()
    monkeypatch.setattr(launcher, 'run', planted_write)
    with pytest.raises(AssertionError, match='wrote outside'):
        launcher.main()
