"""Both shipped entry points apply the flag before importing configuration."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize('entry', ['module', 'packaged'])
@pytest.mark.parametrize('flag', [False, True])
def test_startup_flag_and_alias_conflict(entry, flag, tmp_path):
    home, primary, alias, chosen = (tmp_path / name for name in ('home', 'primary', 'alias', 'chosen'))
    home.mkdir()
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('KROBI_', 'FLIPSPIN_', 'SPOTIFY_')) and key != 'CREDENTIALS_DIRECTORY'}
    starter = tmp_path / "starter/Dev album"
    starter.mkdir(parents=True)
    (starter / "sample.wav").write_bytes(b"fixture song")
    (starter / "LICENSE").write_text("test fixture")
    env["KROBI_DEFAULT_SONGS_PATH"] = str(starter.parent)
    env.update(HOME=str(home), FLIPSPIN_DATA_DIR=str(primary), KROBI_DATA_DIR=str(alias),
               KROBI_ADVERTISE='false', KROBI_UPDATE_CHECK='false')
    code = '''import runpy, sys, uvicorn
uvicorn.run = lambda app, **kwargs: print('ROOT=' + str(app.state.config.data_root))
sys.argv = ['krobi-backend'] + sys.argv[2:]
'''
    code += ("runpy.run_module('app', run_name='__main__')" if entry == 'module'
             else "runpy.run_path('run_standalone.py', run_name='__main__')")
    result = subprocess.run([sys.executable, '-c', code, entry, *(['--data-dir', str(chosen)] if flag else [])],
                            cwd=BACKEND, env=env, capture_output=True, text=True, timeout=30)
    if flag:
        assert result.returncode == 0, result.stderr
        assert f'ROOT={chosen}' in result.stdout
        logs = result.stdout + result.stderr
        assert logs.count('chosen by --data-dir') == 1
        assert (chosen / 'jobs.sqlite').exists()
        assert (chosen / 'Music/Dev album/sample.wav').read_bytes() == b'fixture song'
        assert (chosen / 'Music/Dev album/LICENSE').read_text() == 'test fixture'
    else:
        assert result.returncode != 0
        assert 'FLIPSPIN_DATA_DIR and KROBI_DATA_DIR' in result.stderr
        assert not chosen.exists()
    assert not primary.exists() and not alias.exists()
    assert not list(home.iterdir())
