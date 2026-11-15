"""Install the independent peer through real venv/pip, jobs and HTTP boundaries."""
import asyncio
import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.dependencies import DependencyContainer
from app.main import app
from app.providers.registry import ProviderKind
from app.domains.acquisition.sources.installer import InstallFailure
from app.domains.acquisition.sources.status import StatusCache

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'contracts/source-plugin.json').read_text())
CASES = {case['name']: case for case in CONTRACT['cases']}


@pytest.fixture
def nest(config, tmp_path):
    config.jobs_file = tmp_path / 'jobs.sqlite'
    config.providers_file = tmp_path / 'providers.json'
    source = tmp_path / 'package'
    shutil.copytree(Path(__file__).resolve().parents[1] / 'fixtures/source_plugin', source)
    container = DependencyContainer(config)
    previous = app.state.container
    previous_config = app.state.config
    app.state.config = config
    app.state.container = container
    try:
        yield TestClient(app), container, source
    finally:
        installer = container.get_source_installer()
        for thread in list(installer.threads.values()):
            thread.join(timeout=30)
        container.stop_sources()
        app.state.container = previous
        app.state.config = previous_config


def wait_job(container, id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = container.get_jobs().get(id)
        if job['state'] not in ('queued', 'running'):
            return job
        time.sleep(0.02)
    pytest.fail('source install did not finish')


def install(nest):
    client, container, path = nest
    response = client.post('/api/sources/install', json={'location': str(path)})
    assert response.status_code == 200, response.text
    id = response.json()['progress_id']
    return wait_job(container, id)


def test_local_install_registers_without_restart(nest):
    client, container, path = nest
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []
    job = install(nest)
    assert job['kind'] == 'source-install' and job['state'] == 'succeeded', container.get_jobs().items(job['id'])
    root = container.get_source_installer().root / 'fake'
    assert all((root / name).exists() for name in ('src', 'venv', 'data', 'install.json', 'krobi-extension.json'))
    record = json.loads((root / 'install.json').read_text())
    assert record['kind'] == 'path' and record['location'] == str(path) and record['version'] == '1.0.0'
    sources = client.get('/api/extensions').json()['extensions']
    assert next(row for row in sources if row['id'] == 'fake')['state'] == 'on'
    assert container.get_acquisition().sources() == ['fake']
    assert container._selected_source('https://example.test/audio').id == 'fake'
    rows = asyncio.run(container._selected_source().search({'title': 'Song', 'artist': ''}))
    assert rows[0]['title'] == 'Song'
    assert next(row for row in client.get('/api/providers').json()['providers'] if row['id'] == 'fake')['status']['facts'][0]['label'] == 'Tool'


@pytest.mark.parametrize('mode,case', [('invalid', 'install-bad-manifest'), ('refuse', 'install-failed-hello')])
def test_failure_keeps_zero_sources_with_reason(nest, mode, case):
    _, container, path = nest
    if mode == 'invalid':
        (path / 'krobi-extension.json').write_text('{}')
    else:
        (path / 'mode.txt').write_text(mode)
    job = install(nest)
    assert job['state'] == 'failed'
    detail = container.get_jobs().items(job['id'])[0]['detail']
    assert detail['kind'] == CASES[case]['kind']
    assert bool(detail['error']) is CASES[case]['reasonRequired']
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []
    assert not list(container.get_source_installer().root.glob('*/krobi-extension.json'))
    assert not list((container.get_source_installer().root / '.staging').iterdir())


def test_update_failure_restores_old_and_remove_deletes_data(nest):
    client, container, path = nest
    assert install(nest)['state'] == 'succeeded'
    root = container.get_source_installer().root / 'fake'
    (root / 'data' / 'kept').write_text('persistent')
    old = container._selected_source()
    (path / 'mode.txt').write_text('refuse')
    response = client.post('/api/sources/fake/update')
    assert wait_job(container, response.json()['progress_id'])['state'] == 'failed'
    assert (container._selected_source() is old) is CASES['install-update-failure']['previousRestored']
    assert old.ready()
    assert (root / 'data' / 'kept').read_text() == 'persistent'
    (path / 'mode.txt').unlink()
    response = client.post('/api/sources/fake/update')
    assert wait_job(container, response.json()['progress_id'])['state'] == 'succeeded'
    assert old.closed and container._selected_source() is not old
    assert (root / 'data' / 'kept').exists() is CASES['source-data']['survivesUpdate']
    assert (root / 'data' / 'kept').read_text() == 'persistent'
    assert client.delete('/api/sources/fake').status_code == 200
    assert (root / 'data').exists() is CASES['install-remove']['dataExists']
    assert not root.exists()
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []
    assert 'fake' in json.loads(container.config.providers_file.read_text())['streaming']['order']


def test_old_status_and_unknown_action_do_not_change_health(nest):
    client, container, path = nest
    (path / 'mode.txt').write_text('old')
    assert install(nest)['state'] == 'succeeded'
    source = container._selected_source()
    before = container.get_source_health().status('fake')
    assert StatusCache().refresh(source).facts == CASES['status-unsupported']['facts']
    assert (container.get_source_health().status('fake') != before) is CASES['status-unsupported']['healthChanged']
    response = client.post('/api/sources/fake/action', json={'id': 'unknown'})
    assert response.status_code == 409 and response.json()['detail']['kind'] == CASES['unknown-action']['kind']
    assert (container.get_source_health().status('fake') != before) is CASES['unknown-action']['healthChanged']
    assert source.ready()


def test_url_hosts_and_environment(nest):
    _, container, _ = nest
    assert install(nest)['state'] == 'succeeded'
    source = container._selected_source()
    assert source.env['KROBI_SOURCE_DATA'] == str(container.get_source_installer().root / 'fake/data')
    assert source.env['KROBI_SOURCE_ID'] == 'fake'
    assert not any('SECRET' in key or 'TOKEN' in key for key in source.env)
    from app.domains.acquisition.models import AcquisitionError
    from app.infra.urls import downloader_url
    with pytest.raises(ValueError):
        downloader_url('https://elsewhere.test/song')
    with pytest.raises(AcquisitionError, match='no-sources'):
        container._selected_source('https://elsewhere.test/song')


def test_revision_change_calls_retry_for_only_that_source(nest):
    _, container, _ = nest
    assert install(nest)['state'] == 'succeeded'
    seen = []
    cache = StatusCache(lambda *args: seen.append(args))
    source = container._selected_source()
    assert cache.refresh(source).revision == 'one'
    assert cache.action(source, 'update').revision == 'two'
    assert len(seen) == 1 and seen[0][0] == 'fake' and seen[0][-1] == 'two'


def test_copy_skips_symlinks_and_build_failure_keeps_sources(nest, tmp_path, monkeypatch):
    _, container, path = nest
    outside = tmp_path / 'outside'
    outside.write_text('private')
    (path / 'escape').symlink_to(outside)
    (path / '.git').mkdir()
    (path / '.git' / 'secret').write_text('private')
    from app.domains.acquisition.sources.installer import copy_source
    copy_source(path, tmp_path / 'copy')
    assert not (tmp_path / 'copy/escape').exists() and not (tmp_path / 'copy/.git').exists()
    monkeypatch.setattr('sys.frozen', True, raising=False)
    monkeypatch.delenv('KROBI_UV', raising=False)
    with pytest.raises(InstallFailure, match="This nest can't build plugins"):
        container.get_source_installer().install(str(path))
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []


def test_missing_legacy_source_is_only_a_prefill(nest, monkeypatch):
    client, container, _ = nest
    from app.domains.acquisition.sources.compat import LEGACY_SOURCES
    id, (name, key) = next(iter(LEGACY_SOURCES.items()))
    monkeypatch.delenv(key, raising=False)
    row = client.get('/api/sources/missing').json()['sources'][0]
    assert row == {'id': id, 'name': name, 'setting': key, 'location': ''}
    monkeypatch.setenv(key, 'https://example.test/source.git')
    assert client.get('/api/sources/missing').json()['sources'][0]['location'] == 'https://example.test/source.git'
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []
    _, token = container.get_token_store().mint('Owner', 'owner')
    client.headers['Authorization'] = f'Bearer {token}'
    for route, body in [('/api/download-youtube-url', {'url': 'https://example.test/audio'}),
                        ('/api/downloads/youtube-search', {'query': 'Song'})]:
        response = client.post(route, json=body)
        assert response.status_code == 409 and response.json() == {'code': 'no-sources'}
    assert client.post('/api/providers/youtube/ytdlp/update').status_code == 404


def test_status_window_survives_same_revision_refresh_and_restart(nest):
    _, container, _ = nest
    now, seen = [100], []
    cache = StatusCache(lambda *args: False, now=lambda: now[0], ledger=container.get_jobs())
    cache.accept('fake', {'revision': 'one'})
    now[0] = 150
    cache.accept('fake', {'revision': 'one'})
    now[0] = 200
    cache.accept('fake', {'revision': 'two'})
    restored = StatusCache(lambda *args: seen.append(args) or True, now=lambda: now[0], ledger=container.get_jobs())
    restored.accept('fake', {'revision': 'two'})
    assert seen == [('fake', 100, 200, 'two')]
    restored.accept('fake', {'revision': 'two'})
    assert len(seen) == 1


def test_publish_failure_restores_previous_tree(nest, monkeypatch):
    _, container, path = nest
    assert install(nest)['state'] == 'succeeded'
    installer = container.get_source_installer()
    root = installer.root / 'fake'
    (root / 'data/kept').write_text('old data')
    from app.domains.acquisition.sources import installer as module
    original = module.register_source
    calls = []
    def fail_once(*args):
        calls.append(None)
        if len(calls) == 1:
            raise RuntimeError('publish failed')
        return original(*args)
    monkeypatch.setattr(module, 'register_source', fail_once)
    with pytest.raises(RuntimeError, match='publish failed'):
        installer.install(str(path))
    assert container._selected_source().ready()
    assert (root / 'data/kept').read_text() == 'old data'
    assert not list((installer.root / '.staging').iterdir())


def test_crash_recovery_restores_data_before_discovery(nest):
    _, container, _ = nest
    assert install(nest)['state'] == 'succeeded'
    installer = container.get_source_installer()
    root = installer.root / 'fake'
    container.stop_sources()
    (root / 'data/kept').write_text('old data')
    work = installer.root / '.staging' / 'interrupted'
    work.mkdir()
    root.rename(work / 'previous')
    root.mkdir()
    (work / 'previous/data').rename(root / 'data')
    (installer.root / '.transaction.json').write_text(json.dumps({'id': 'fake', 'work': work.name, 'hadPrevious': True}))
    from app.domains.acquisition.sources.installed import recover_installation
    recover_installation(installer.root)
    assert (root / 'krobi-extension.json').is_file()
    assert (root / 'data/kept').read_text() == 'old data'


def test_install_registers_progress_before_running_and_cancellation_does_not_publish(nest, monkeypatch):
    import threading
    client, container, path = nest
    installer = container.get_source_installer()
    entered, resume = threading.Event(), threading.Event()
    original = installer.install
    def delayed(location, **kwargs):
        entered.set()
        assert resume.wait(10)
        return original(location, **kwargs)
    monkeypatch.setattr(installer, 'install', delayed)
    response = client.post('/api/sources/install', json={'location': str(path)})
    id = response.json()['progress_id']
    assert entered.wait(2)
    row = container.get_jobs().get(id)
    assert row['kind'] == 'source-install' and row['state'] == 'running'
    assert client.post(f'/api/jobs/{id}/cancel').status_code == 200
    resume.set()
    installer.threads[id].join(15)
    assert container.get_jobs().get(id)['state'] == 'cancelled'
    assert not (installer.root / 'fake').exists()


def test_install_rejects_an_id_reserved_by_an_engine(nest):
    _, container, path = nest
    manifest = json.loads((path / 'krobi-extension.json').read_text())
    manifest['id'] = 'lyrics'
    (path / 'krobi-extension.json').write_text(json.dumps(manifest))
    with pytest.raises(InstallFailure, match='already in use'):
        container.get_source_installer().install(str(path))
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []


def test_git_install_uses_a_shallow_clone_and_records_commit(nest, monkeypatch):
    import subprocess
    _, container, path = nest
    def git(*args):
        return subprocess.run(['git', '-C', str(path), *args], check=True, capture_output=True, text=True).stdout.strip()
    git('init')
    git('add', '.')
    git('-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture')
    commit = git('rev-parse', 'HEAD')
    from app.domains.acquisition.sources import installer as module
    original = module.run
    seen = []
    def transport(command, **kwargs):
        if command[:2] == ['git', 'clone']:
            assert command[2:5] == ['--depth', '1', '--']
            seen.append(command[-2])
            command = [*command[:-2], path.as_uri(), command[-1]]
        return original(command, **kwargs)
    monkeypatch.setattr(module, 'run', transport)
    container.get_source_installer().install('https://example.test/source.git')
    root = container.get_source_installer().root / 'fake'
    record = json.loads((root / 'install.json').read_text())
    assert seen == [record['location']] == ['https://example.test/source.git']
    assert record['kind'] == 'git' and record['commit'] == commit
    assert (root / 'src/.git/shallow').is_file()
    assert container._selected_source().ready()


def test_uv_build_uses_the_bundled_command(nest, monkeypatch):
    import sys
    _, container, path = nest
    from app.domains.acquisition.sources import installer as module
    original, seen = module.run, []
    monkeypatch.setenv('KROBI_UV', 'bundled-uv')
    def uv(command, **kwargs):
        if command[0] == 'bundled-uv':
            seen.append(command[:-1])
            command = [sys.executable, '-m', 'venv', command[-1]]
        return original(command, **kwargs)
    monkeypatch.setattr(module, 'run', uv)
    container.get_source_installer().install(str(path))
    assert seen == [['bundled-uv', 'venv', '--python', '3.12', '--seed']]
    assert container._selected_source().ready()


def test_known_catalog_default_and_overrides(nest, monkeypatch):
    from app.infra import env_sources
    client, container, _ = nest
    key = 'KROBI_SOURCE_LOCATION_YOUTUBE'
    monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(env_sources, 'read_values', lambda _: {})
    row = client.get('/api/sources/known').json()['sources'][0]
    assert row == {'id': 'youtube', 'name': 'YouTube', 'facts': ['Songs', 'AAC', 'm4a', 'official'],
                   'location': 'https://github.com/flipspin/flipspin-source-youtube', 'installed': False}
    monkeypatch.setenv(key, 'https://example.test/override.git')
    assert client.get('/api/sources/known').json()['sources'][0]['location'] == 'https://example.test/override.git'
    monkeypatch.setattr(env_sources, 'read_values', lambda _: {key: '/plugins/saved'})
    monkeypatch.setattr(env_sources, 'ENV_KEYS', {key})
    assert client.get('/api/sources/known').json()['sources'][0]['location'] == 'https://example.test/override.git'
    monkeypatch.setattr(env_sources, 'ENV_KEYS', set())
    assert client.get('/api/sources/known').json()['sources'][0]['location'] == '/plugins/saved'
    assert container.get_provider_registry().order(ProviderKind.STREAMING) == []
    monkeypatch.setattr(container.get_provider_registry(), 'get', lambda _: object())
    assert client.get('/api/sources/known').json()['sources'][0]['installed'] is True


@pytest.mark.parametrize('body', [{'id': 'youtube'}, {'location': 'youtube'}, {'location': '  YoUtUbE  '}])
def test_install_known_source_and_installed_state(nest, monkeypatch, body):
    from app.infra import env_sources
    client, container, path = nest
    manifest = json.loads((path / 'krobi-extension.json').read_text())
    manifest.update(id='youtube', name='YouTube')
    (path / 'krobi-extension.json').write_text(json.dumps(manifest))
    monkeypatch.setenv('KROBI_SOURCE_LOCATION_YOUTUBE', str(path))
    monkeypatch.setattr(env_sources, 'read_values', lambda _: {})
    response = client.post('/api/sources/install', json=body)
    assert response.status_code == 200, response.text
    job = wait_job(container, response.json()['progress_id'])
    assert job['state'] == 'succeeded', container.get_jobs().items(job['id'])
    assert container.get_jobs().items(job['id'])[0]['detail']['location'] == str(path)
    assert client.get('/api/sources/known').json()['sources'][0]['installed'] is True
    assert client.get('/api/sources/missing').json()['sources'] == []


@pytest.mark.parametrize('body', [{}, {'id': 'unknown'}, {'id': 'youtube', 'location': '/plugins/other'}])
def test_install_rejects_unknown_or_ambiguous_selection(nest, body):
    client, container, _ = nest
    assert client.post('/api/sources/install', json=body).status_code == 422
    assert container.get_jobs().list() == []


def test_install_resolves_a_catalog_display_name(nest, monkeypatch):
    from app.domains.acquisition.sources import known
    client, container, _ = nest
    monkeypatch.setattr(known, 'known_sources', lambda _: [known.KnownSource(
        id='sample', name='Sample source', facts=[], location='https://example.test/source.git', installed=False)])
    locations = []
    def submit(location):
        locations.append(location)
        return 'fixture-job'
    monkeypatch.setattr(container.get_source_installer(), 'submit', submit)
    assert client.post('/api/sources/install', json={'location': '  SAMPLE SOURCE  '}).json() == {'progress_id': 'fixture-job'}
    assert locations == ['https://example.test/source.git']
