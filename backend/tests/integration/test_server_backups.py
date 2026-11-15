"""The complete household state is visible and writable only to owners."""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.infra.backups import BackupManager
from app.infra.data_lock import DataBusy, DataLock
from app.main import app, _start_backups, _stop_backups


@pytest.fixture
def manager(config, monkeypatch):
    manager = BackupManager(config)
    monkeypatch.setitem(app.state.container._services, 'backups', manager)
    return manager


def token_headers(accounts, role):
    _, token = accounts.mint('Account', role)
    return {'Authorization': f'Bearer {token}'}


def test_owner_can_backup_list_and_read_last_backup(accounts, manager):
    headers = token_headers(accounts, 'owner')
    client = TestClient(app)
    assert client.get('/api/server/backups', headers=headers).json() == {'backups': []}
    result = client.post('/api/server/backups', headers=headers)
    assert result.status_code == 201
    entry = result.json()
    assert set(entry) == {'stamp', 'size', 'reason', 'ok'}
    assert entry['ok'] and entry['reason'] == 'manual' and entry['size'] > 0
    assert client.get('/api/server/backups', headers=headers).json() == {'backups': [entry]}
    host = client.get('/api/server/host', headers=headers).json()
    assert host['lastBackupAt'].endswith('Z')
    assert host['lastBackupReason'] == 'manual'


@pytest.mark.parametrize('method', ['get', 'post'])
def test_members_cannot_read_or_trigger_household_backup(accounts, manager, method):
    accounts.mint('Owner', 'owner')
    headers = token_headers(accounts, 'member')
    assert getattr(TestClient(app), method)('/api/server/backups', headers=headers).status_code == 403
    assert manager.list_backups() == []


@pytest.mark.parametrize('method', ['get', 'post'])
def test_unauthenticated_remote_cannot_read_or_trigger(accounts, manager, method):
    accounts.mint('Owner', 'owner')
    client = TestClient(app, client=('testclient', 50000))
    assert getattr(client, method)('/api/server/backups').status_code == 401
    assert manager.list_backups() == []


def test_backup_conflicts_and_failures_are_reported_without_paths(accounts, manager, monkeypatch):
    headers = token_headers(accounts, 'owner')
    client = TestClient(app)
    with DataLock(manager.data / '.backup.lock'):
        result = client.post('/api/server/backups', headers=headers)
        assert result.status_code == 409
        assert result.json() == {'detail': 'backup-in-progress'}
    monkeypatch.setattr(manager, 'backup_now', Mock(side_effect=OSError('private data path')))
    result = client.post('/api/server/backups', headers=headers)
    assert result.status_code == 503
    assert result.json() == {'detail': 'backup-failed'}


def test_host_reports_no_success_when_backup_is_corrupt(accounts, manager):
    headers = token_headers(accounts, 'owner')
    saved = manager.backup_now('manual')
    (manager.directory / saved['stamp'] / 'instance.json').write_text('broken')
    client = TestClient(app)
    assert client.get('/api/server/backups', headers=headers).json()['backups'][0]['ok'] is False
    host = client.get('/api/server/host', headers=headers).json()
    assert host['lastBackupAt'] is None and host['lastBackupReason'] is None


def test_server_lifecycle_holds_restore_lock_and_stops_scheduler(manager, monkeypatch):
    monkeypatch.setattr(app.state.config, 'playlist_dir', manager.config.playlist_dir)
    _start_backups()
    try:
        with pytest.raises(DataBusy), DataLock(manager.data / '.server.lock'):
            pass
        assert manager._thread.is_alive()
    finally:
        _stop_backups()
    with DataLock(manager.data / '.server.lock'):
        pass
    assert manager._thread is None


def test_server_cannot_start_during_offline_restore(manager, monkeypatch):
    monkeypatch.setattr(app.state.config, 'playlist_dir', manager.config.playlist_dir)
    with DataLock(manager.data / '.server.lock'), pytest.raises(DataBusy):
        _start_backups()
    assert manager._thread is None


def test_unreadable_backup_directory_does_not_hide_host_facts(accounts, manager, monkeypatch):
    headers = token_headers(accounts, 'owner')
    monkeypatch.setattr(manager, '_directories', Mock(side_effect=PermissionError('unreadable')))
    result = TestClient(app).get('/api/server/host', headers=headers)
    assert result.status_code == 200
    assert 'lastBackupAt' not in result.json()
    assert result.json()['startedAt'] is not None
