"""Run-control HTTP authorization, setting locks and frozen-reader guarantees."""
from unittest.mock import Mock

import pytest

from app.infra import env_sources
from tests.integration.test_analysis import house as house, CLAIM, result_item


def request(h, **changes):
    return h.admin.post('/api/analysis/runs', json={
        'requestId': 'request', 'mode': 'new', 'scope': 'library', **changes})


def test_a9_11_auto_setting_env_lock_atomic_persistence_and_default(house, monkeypatch):
    h = house
    key = 'KROBI_ANALYSIS_AUTO'
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset())
    monkeypatch.setattr(env_sources, 'APP_KEYS', set())

    def setting():
        body = h.admin.get('/api/server/config').json()
        return next(s for g in body['groups'] for s in g['settings'] if s['key'] == key)

    before = setting()
    assert before['default'] is before['value'] is True
    assert before['editable'] and not before['needsRestart']
    changed = h.admin.put('/api/server/config', json={'changes': {key: False}})
    assert changed.status_code == 200 and h.service.config.analysis_auto is False
    assert env_sources.read_values(h.service.config.credentials_dir.parent / '.env')[key] == 'false'
    assert h.service.scan() == 0
    assert h.admin.get('/api/analysis/summary').json()['waiting'] == 1
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset([key]))
    pinned = setting()
    assert pinned['source'] == 'env' and pinned['editable'] is False
    denied = h.admin.put('/api/server/config', json={'changes': {key: True}})
    assert denied.status_code == 409 and denied.json()['detail']['code'] == 'env-locked'
    assert h.service.config.analysis_auto is False
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset())
    monkeypatch.setattr(env_sources, 'write_secret_lines', Mock(side_effect=OSError('disk full')))
    failed = h.admin.put('/api/server/config', json={'changes': {key: True}})
    assert failed.status_code == 500 and not h.service.config.analysis_auto


def test_a9_12_member_cannot_run_preview_or_change_auto(house):
    h = house
    body = {'requestId': 'member', 'mode': 'all', 'scope': 'library'}
    assert h.member.post('/api/analysis/runs', json=body).status_code == 403
    assert h.member.get('/api/analysis/runs/preview').status_code == 403
    assert h.member.put('/api/server/config', json={'changes': {'KROBI_ANALYSIS_AUTO': False}}).status_code == 403



def test_a9_15_listing_and_track_wire_frozen_and_schema_additive(house):
    h = house
    h.service.scan()
    got = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post('/api/helpers/jobs/' + got['job']['id'] + '/result', json={
        'lease': got['lease'], 'items': [result_item(i) for i in got['job']['input']['items']]})
    view = h.admin.get('/api/analysis/Album/song.mp3').json()
    listing = h.admin.get('/api/listar-albums-con-metadata?covers=false').json()
    first = request(h, mode='all')
    assert first.status_code == 200, first.text
    assert request(h, mode='all').json() == first.json()
    summary = h.admin.get('/api/analysis/summary')
    assert summary.status_code == 200
    assert summary.json()['run']['size'] == 1 and summary.json()['run']['done'] == 0
    assert h.admin.get('/api/analysis/summary', headers={'If-None-Match': summary.headers['etag']}).status_code == 304
    got = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    h.helper.post('/api/helpers/jobs/' + got['job']['id'] + '/result', json={
        'lease': got['lease'], 'items': [result_item(i) for i in got['job']['input']['items']]})
    assert h.admin.get('/api/analysis/Album/song.mp3').json() == view
    assert h.admin.get('/api/listar-albums-con-metadata?covers=false').json() == listing
    assert h.admin.get('/api/analysis/summary', headers={'If-None-Match': summary.headers['etag']}).status_code == 200


def test_typed_refusals_and_jobs_cancel_branch(house, monkeypatch):
    h = house
    denied = request(h, mode='all')
    assert denied.status_code == 409 and denied.json()['detail']['code'] == 'no-helper'
    assert h.service.queue.rows(('analysis',)) == []
    monkeypatch.setattr(h.service, '_migrating', True)
    denied = request(h)
    assert denied.status_code == 409 and denied.json()['detail']['code'] == 'migrating'
    monkeypatch.setattr(h.service, '_migrating', False)
    with h.service._scan_lock:
        denied = request(h)
    assert denied.status_code == 409 and denied.json()['detail']['code'] == 'scan-busy'
    started = request(h).json()
    run = started['run']
    joined = request(h, requestId='again').json()
    assert joined['joined'] and joined['run'] == run
    assert request(h, requestId='different', mode='all').json()['detail']['code'] == 'run-in-progress'
    got = h.helper.post('/api/helpers/claim', json=CLAIM).json()
    assert h.admin.post('/api/jobs/' + run['jobId'] + '/cancel').status_code == 200
    assert h.helper.post('/api/helpers/jobs/' + got['job']['id'] + '/heartbeat',
                         json={'lease': got['lease']}).json()['stop']
    assert h.admin.post('/api/jobs/' + run['jobId'] + '/cancel').status_code == 409
    assert h.service.scan() == h.service.scan() == 0


@pytest.mark.parametrize('changes', [
    {'scope': 'song'}, {'scope': 'library', 'relPaths': ['Album/song.mp3']},
    {'scope': 'selection', 'relPaths': ['Album/song.mp3'] * 501},
    {'scope': 'song', 'relPaths': ['Album/song.mp3', 'Album/song.mp3']},
    {'mode': 'waiting'}, {'scope': 'songs'}, {'requestId': ''},
])
def test_run_request_bounds_and_scope_validation(house, changes):
    assert request(house, **changes).status_code == 422


def test_preview_has_counts_without_any_database_mutation(house):
    from tests.integration.test_wire_snapshots import assert_matches_snapshot
    h = house
    before = h.service.repository.revision, h.container.get_jobs().version
    result = h.admin.get('/api/analysis/runs/preview?mode=all')
    assert result.status_code == 200
    assert result.json() == {'waiting': 1, 'outdated': 0, 'failed': 0, 'correctionsKept': 0,
                             'confirmationsKept': 0, 'size': 1, 'skipped': [], 'estimateSeconds': None}
    assert_matches_snapshot('analysis-run-preview', result.json())
    assert (h.service.repository.revision, h.container.get_jobs().version) == before
    assert h.service.repository.get('Album/song.mp3') is None




@pytest.mark.parametrize('key,value', [
    ('KROBI_ANALYSIS_AUTO_LIBRARY', True), ('KROBI_ANALYSIS_AUTO_UPGRADE', True),
    ('KROBI_NEST_LIBRARY_START_HOUR', 1), ('KROBI_NEST_LIBRARY_END_HOUR', 7),
])
@pytest.mark.parametrize('pinned', [False, True])
def test_retired_settings_keep_fixed_wire_rows_and_reject_writes_as_unknown(house, monkeypatch, key, value, pinned):
    h = house
    monkeypatch.setattr(env_sources, 'ENV_KEYS', frozenset([key]) if pinned else frozenset())
    monkeypatch.setenv(key, str(value))
    before = h.admin.get('/api/server/config').json()
    setting = next(s for g in before['groups'] for s in g['settings'] if s['key'] == key)
    assert setting['value'] == (False if isinstance(value, bool) else 0)
    assert not setting['editable'] and not setting['needsRestart']
    assert setting['source'] == 'default'
    path = h.service.config.credentials_dir.parent / '.env'
    saved = path.read_bytes() if path.exists() else None
    for changes in ({key: value}, {'KROBI_ANALYSIS_AUTO': False, key: value}):
        response = h.admin.put('/api/server/config', json={'changes': changes})
        assert response.status_code == 422
        assert response.json()['detail'] == {'code': 'unknown-key', 'key': key}
    assert h.service.config.analysis_auto
    assert (path.read_bytes() if path.exists() else None) == saved
    assert h.admin.get('/api/server/config').json() == before
    patched = h.admin.patch('/api/server/config', json={'changes': {key: value}})
    unknown = h.admin.patch('/api/server/config', json={'changes': {'unknown': value}})
    assert patched.status_code == unknown.status_code == 405
    assert patched.json() == unknown.json()
