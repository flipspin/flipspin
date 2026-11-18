"""Only the resolved root owns saved settings, independent of credentials."""
from app.infra import env_sources
from app.config import ConfigManager


def test_ignores_source_and_cwd_dotenv(tmp_path, monkeypatch, caplog):
    root, backend, cwd = (tmp_path / name for name in ('data', 'backend', 'cwd'))
    for directory in (root, backend, cwd):
        directory.mkdir()
    (root / '.env').write_text('KROBI_TEST_SETTING=root\nKROBI_TEST_PIN=saved\nFLIPSPIN_DATA_DIR=/wrong\nXDG_DATA_HOME=/wrong-xdg\n')
    (backend / '.env').write_text('KROBI_TEST_SETTING=backend\nKROBI_TEST_BACKEND=bad\n')
    (cwd / '.env').write_text('KROBI_TEST_SETTING=cwd\nKROBI_TEST_CWD=bad\n')
    monkeypatch.setattr(env_sources, '__file__', str(backend / 'app/infra/env_sources.py'))
    monkeypatch.chdir(cwd)
    monkeypatch.setenv('FLIPSPIN_DATA_DIR', str(root))
    monkeypatch.setenv('KROBI_CREDENTIALS_DIR', str(tmp_path / 'credentials-elsewhere'))
    monkeypatch.setenv('KROBI_TEST_PIN', 'operator')
    monkeypatch.delenv('XDG_DATA_HOME', raising=False)
    for key in ('KROBI_TEST_SETTING', 'KROBI_TEST_CWD', 'KROBI_TEST_BACKEND'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(env_sources, "APP_KEYS", set())
    env_sources.load_environment(root)
    import os
    monkeypatch.setenv("KROBI_TEST_SETTING", os.environ.pop("KROBI_TEST_SETTING"))
    import os
    assert os.environ['KROBI_TEST_SETTING'] == 'root'
    assert os.environ['KROBI_TEST_PIN'] == 'operator'
    assert os.environ['FLIPSPIN_DATA_DIR'] == str(root)
    assert 'XDG_DATA_HOME' not in os.environ
    assert 'KROBI_TEST_CWD' not in os.environ
    assert 'KROBI_TEST_BACKEND' not in os.environ
    assert sum(str(backend / '.env') in r.message for r in caplog.records) == 1
    assert sum(str(cwd / '.env') in r.message for r in caplog.records) == 1
    config = ConfigManager.from_env()
    assert config.secrets.env_path == root / '.env'
