"""The loudness boundary rejects measurement libraries anywhere under app."""
from pathlib import Path
import os
import subprocess
import sys

import pytest


@pytest.mark.parametrize('library', ['pyloudnorm', 'ebur128', 'pyebur128'])
def test_loudness_import_contract_rejects_server_measurement(tmp_path, library):
    config = Path(__file__).parents[2] / 'pyproject.toml'
    package = tmp_path / 'app'
    package.mkdir()
    (package / '__init__.py').write_text('')
    nested = package / 'music'
    nested.mkdir()
    (nested / '__init__.py').write_text('')
    module = nested / 'measurement.py'
    module.write_text('')
    helper = tmp_path / 'helper'
    helper.mkdir()
    (helper / '__init__.py').write_text(f'import {library}\n')

    def check():
        return subprocess.run([str(Path(sys.executable).with_name('lint-imports')), '--config', str(config),
                               '--contract', 'helper-loudness', '--no-cache', '--no-logo'],
                              cwd=tmp_path, env={**os.environ, 'PYTHONPATH': str(tmp_path)},
                              capture_output=True, text=True, timeout=30)

    allowed = check()
    assert allowed.returncode == 0, allowed.stdout + allowed.stderr
    module.write_text(f'import {library}\n')
    forbidden = check()
    assert forbidden.returncode == 1, forbidden.stdout + forbidden.stderr
    assert 'Loudness measurement stays in the helper BROKEN' in forbidden.stdout
    assert library in forbidden.stdout
