"""Listening events preserve the old wire while exporting only the caller's data."""
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, TypeAdapter

from app.infra.idempotency import Receipts, database
from app.main import app

PLAYS = '/api/me/plays'
HISTORY = PLAYS + '/history'
REL = 'Album/song.mp3'
WIRE = {'relPath', 'addedAt', 'liked', 'offline', 'playCount', 'lastPlayedAt'}


@pytest.fixture
def listening(tmp_path, monkeypatch):
    config = app.state.config
    for name, value in dict(jobs_file=tmp_path / 'jobs.sqlite', users_file=tmp_path / 'users.json',
                            user_tracks_file=tmp_path / 'tracks.json', base_music_dir=tmp_path / 'Music',
                            api_token=None, allow_unauthenticated_remote=False).items():
        monkeypatch.setattr(config, name, value)
    services = app.state.container._services
    for key in ('token_store', 'user_track_store'):
        services.pop(key, None)
    tokens = app.state.container.get_token_store()
    tracks = app.state.container.get_user_track_store()
    accounts = []
    for role in ('owner', 'owner', 'member'):
        user, token = tokens.mint('Test account', role)
        tracks.add_many(user.user_id, [REL])
        accounts.append((user.user_id, {'Authorization': f'Bearer {token}'}))
    yield TestClient(app), accounts, tracks, config
    for key in ('token_store', 'user_track_store'):
        services.pop(key, None)


def events(config):
    with database(config.jobs_file) as db:
        return [dict(row) for row in db.execute('SELECT * FROM play_events')]


def test_legacy_single_play_keeps_wire_and_records_every_listen(listening):
    client, accounts, _, config = listening
    account, headers = accounts[0]
    for count in (1, 2):
        response = client.post(PLAYS, json={'relPath': REL}, headers=headers)
        assert response.status_code == 200
        assert set(response.json()) == WIRE
        assert response.json()['playCount'] == count
    recorded = events(config)
    assert len(recorded) == 2
    assert all(row['user_id'] == account and row['track_key'] == REL for row in recorded)
    assert all(row['device_id'] and row['source'] == 'desktop' for row in recorded)
    assert all(row['completed'] == 1 and row['duration_played_s'] is None for row in recorded)


def test_optional_details_device_identity_and_request_retry(listening):
    client, accounts, _, config = listening
    _, headers = accounts[0]
    payload = dict(relPath=REL, startedAt='2001-01-01T01:00:00+01:00', playedSeconds=12.5,
                   completed=False, source='phone', deviceId='spoof', user_id='other')
    for _ in range(2):
        response = client.post(PLAYS, json=payload, headers={**headers, 'Idempotency-Key': 'one-play'})
        assert response.status_code == 200 and response.json()['playCount'] == 1
    row, = events(config)
    assert row['started_at'] == '2001-01-01T00:00:00+00:00'
    assert row['duration_played_s'] == 12.5 and row['completed'] == 0 and row['source'] == 'phone'
    assert row['device_id'] != 'spoof' and row['user_id'] == accounts[0][0]


@pytest.mark.parametrize('body', [
    {'relPath': REL},
    {'plays': [{'trackKey': REL, 'listenedAt': '2001-01-01T00:00:00Z', 'clientPlayId': 'old'}]},
    [{'trackKey': REL, 'listenedAt': '2001-01-01T00:00:00Z', 'clientPlayId': 'old'}],
])
def test_pre_upgrade_idempotency_receipts_still_match_omitted_details(listening, body):
    class LegacyPlay(BaseModel):
        trackKey: str
        listenedAt: datetime
        clientPlayId: str

    class LegacyBatch(BaseModel):
        plays: list[LegacyPlay]

    class LegacySingle(BaseModel):
        relPath: str

    client, accounts, tracks, config = listening
    account, headers = accounts[0]
    if isinstance(body, dict) and 'relPath' in body:
        old_body = LegacySingle.model_validate(body)
        cached = tracks.get(account, REL).public()
    else:
        old_body = LegacyBatch.model_validate(body) if isinstance(body, dict) else TypeAdapter(list[LegacyPlay]).validate_python(body)
        cached = {'accepted': 1}
    receipts = Receipts(config.jobs_file)
    assert receipts.begin('pre-upgrade', account, f'POST {PLAYS}', {'body': old_body}) is None
    receipts.finish('pre-upgrade', account, f'POST {PLAYS}', 200, cached)
    response = client.post(PLAYS, json=body, headers={**headers, 'Idempotency-Key': 'pre-upgrade'})
    assert response.status_code == 200 and response.json() == cached
    assert events(config) == []


@pytest.mark.parametrize('field,value', [
    ('startedAt', '2001-01-01T00:00:00'), ('startedAt', 'bad'),
    ('startedAt', (datetime.now(UTC) + timedelta(days=1)).isoformat()),
    ('playedSeconds', -1), ('playedSeconds', 'Infinity'), ('playedSeconds', 'NaN'),
    ('completed', 'bad'), ('source', 'subsonic'),
])
def test_invalid_details_never_write_an_event(listening, field, value):
    client, accounts, _, config = listening
    assert client.post(PLAYS, json={'relPath': REL, field: value}, headers=accounts[0][1]).status_code == 422
    assert events(config) == []


@pytest.mark.parametrize('wrapped', [True, False])
def test_offline_batch_retries_dedupe_events_and_keep_last_played(listening, wrapped):
    client, accounts, _, config = listening
    _, headers = accounts[0]
    plays = [dict(trackKey=REL, listenedAt='2001-01-02T00:00:00Z', clientPlayId='one',
                  startedAt='2001-01-01T00:00:00Z', playedSeconds=9, completed=False),
             dict(trackKey=REL, listenedAt='2001-01-03T00:00:00Z', clientPlayId='two'),
             dict(trackKey='Other/no.mp3', listenedAt='2001-01-03T00:00:00Z', clientPlayId='missing')]
    body = {'plays': plays} if wrapped else plays
    for accepted in (2, 0):
        response = client.post(PLAYS, json=body, headers={**headers, 'User-Agent': 'okhttp'})
        assert response.status_code == 200 and response.json() == {'accepted': accepted}
    rows = events(config)
    assert len(rows) == 2 and all(row['source'] == 'phone' for row in rows)
    row, = client.get('/api/me/library', headers=headers).json()['tracks']
    assert row['playCount'] == 2 and row['lastPlayedAt'] == '2001-01-03T00:00:00+00:00'


def test_export_is_owner_only_and_never_accepts_another_account(listening):
    client, accounts, _, _ = listening
    for _, headers in accounts:
        assert client.post(PLAYS, json={'relPath': REL}, headers=headers).status_code == 200
    assert client.get(HISTORY, headers=accounts[2][1]).status_code == 403
    assert client.get(HISTORY).status_code == 409  # local sentinel, no account
    assert client.get(HISTORY, headers={'Authorization': 'Bearer invalid'}).status_code == 401
    for index in (0, 1):
        response = client.get(HISTORY, params={'accountId': accounts[1 - index][0]}, headers=accounts[index][1])
        assert response.status_code == 200
        exported = response.json()['events']
        assert len(exported) == 1
        assert exported[0]['deviceId'] != client.get(HISTORY, headers=accounts[1 - index][1]).json()['events'][0]['deviceId']


def test_export_pages_ties_and_utc_bounds_without_duplicates(listening):
    client, accounts, _, _ = listening
    _, headers = accounts[0]
    for day in (1, 2, 2, 3):
        assert client.post(PLAYS, json={'relPath': REL, 'startedAt': f'2001-01-0{day}T00:00:00Z'},
                           headers=headers).status_code == 200
    params = {'from': '2001-01-01T01:00:00+01:00', 'to': '2001-01-03T00:00:00Z', 'limit': 1}
    found = []
    while True:
        response = client.get(HISTORY, params=params, headers=headers)
        assert response.status_code == 200, response.text
        page = response.json()
        found.extend(page['events'])
        if page['nextCursor'] is None:
            break
        params['after'] = page['nextCursor']
    assert len({event['id'] for event in found}) == 3
    assert [event['startedAt'][8:10] for event in found] == ['02', '02', '01']
    assert all(set(event) == {'id', 'relPath', 'startedAt', 'playedSeconds', 'completed', 'source', 'deviceId'} for event in found)
    # A cursor is scoped even when supplied by another owner.
    assert client.get(HISTORY, params={'after': found[0]['id']}, headers=accounts[1][1]).status_code == 422


@pytest.mark.parametrize('params', [
    {'from': '2001-01-01'}, {'to': 'bad'}, {'from': '2001-01-02T00:00:00Z', 'to': '2001-01-01T00:00:00Z'},
    {'limit': 0}, {'limit': 501}, {'after': 'missing'},
])
def test_export_rejects_invalid_bounds_and_paging(listening, params):
    client, accounts, _, _ = listening
    assert client.get(HISTORY, params=params, headers=accounts[0][1]).status_code == 422


def test_ghost_and_removed_membership_keep_the_entire_history(listening):
    client, accounts, tracks, config = listening
    account, headers = accounts[0]
    # No file exists: an offline listen to a ghost remains valid.
    assert client.post(PLAYS, json={'relPath': REL}, headers=headers).status_code == 200
    before = client.get(HISTORY, headers=headers).json()
    tracks.remove_many(account, [REL])
    tracks.reload()
    assert client.get(HISTORY, headers=headers).json() == before
    assert client.post(PLAYS, json={'relPath': REL}, headers=headers).status_code == 404
    assert len(events(config)) == 1
