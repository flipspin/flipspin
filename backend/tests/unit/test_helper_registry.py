"""Helper registry migration, state precedence, persistence and capabilities."""
import json
import stat

import pytest

from app.domains.helpers.mac_worker import AGENT_ONLINE_S, MIN_WORKER_VERSION, REVOKED_HISTORY_S, WorkerRecord, outdated
from app.domains.accounts.identity import TokenStore

pytestmark = pytest.mark.unit
CURRENT = {"id": "mac", "sessionId": "run-1", "name": "Mac", "version": "0.10.0"}


def test_migrate_mac_worker_once_without_touching_source(tmp_path):
    legacy = tmp_path / "mac-worker.json"
    old = {**CURRENT, "lastSeenAt": 100, "goodbye": "asleep", "state": "idle", "chip": "M1", "memoryBytes": 16 << 30}
    source = json.dumps({"worker": old, "retired": [json.dumps(["mac", "older"])]})
    legacy.write_text(source)
    path = tmp_path / "helpers.json"
    worker = WorkerRecord(path=path, now=lambda: 101)
    row = worker.snapshot()
    assert row["id"] == "mac" and row["state"] == "asleep" and row["lastSeenAt"] == 100
    assert row["os"] == "macos" and row["accel"] == "mlx"
    assert row["jobs"] == ["align", "transcribe", "stems"] and row["speed"] == {}
    assert row["chip"] == "M1" and row["memoryBytes"] == 16 << 30
    assert json.loads(path.read_text())["retired"] == [["mac", "older"]]
    assert stat.S_IMODE(path.stat().st_mode) == 0o644
    assert legacy.read_text() == source
    worker.seen(CURRENT | {"id": "linux", "os": "linux", "accel": "cpu", "jobs": ["align"]})
    legacy.write_text(json.dumps({"worker": CURRENT | {"id": "ignored"}}))
    assert {r["id"] for r in WorkerRecord(path=path).helpers()} == {"mac", "linux"}


@pytest.mark.parametrize("explicit", [True, False])
def test_only_explicit_helper_flag_survives_read_and_next_write(tmp_path, explicit):
    path = tmp_path / "users.json"
    store = TokenStore(path)
    owner, _ = store.mint("Owner", "owner")
    _, device, token = store.add_device(owner.user_id, "Old Mac · trabajador", helper=True)
    data = json.loads(path.read_text())
    if not explicit:
        for entry in data["users"][0]["devices"]:
            entry.pop("helper")
    path.write_text(json.dumps(data))
    reloaded = TokenStore(path)
    assert reloaded.resolve(token).device_id == device.device_id
    assert reloaded.get_user(owner.user_id).device(device.device_id).helper is explicit
    reloaded.add_device(owner.user_id, "ordinary")
    assert TokenStore(path).get_user(owner.user_id).device(device.device_id).helper is explicit


def test_states_precedence_retired_sessions_and_revoked_pruning(tmp_path):
    clock = [100.0]
    worker = WorkerRecord(path=tmp_path / "helpers.json", now=lambda: clock[0])
    worker.seen(CURRENT)
    worker.working("job", "mac", "Song", "align")
    assert worker.snapshot()["state"] == "working"
    worker.finished("job")
    assert worker.snapshot()["state"] == "idle"
    clock[0] += AGENT_ONLINE_S + 1
    assert worker.snapshot()["state"] == "offline"
    worker.bye("mac", "quit", "run-1")
    assert worker.snapshot()["state"] == "closed"
    worker.revoke("mac")
    assert worker.snapshot()["state"] == "revoked"
    assert worker.wait_reason() == "no-helper"
    assert not worker.seen(CURRENT | {"sessionId": "revive"})
    worker.seen(CURRENT | {"id": "old", "version": "0.6.0"})
    worker.revoke("old")
    assert next(r for r in worker.helpers() if r["id"] == "old")["state"] == "outdated"
    clock[0] += REVOKED_HISTORY_S + 1
    assert worker.helpers() == []
    assert json.loads(worker.path.read_text())["helpers"]  # A read does not prune persistence.
    worker.maintain()
    assert json.loads(worker.path.read_text())["helpers"] == {}


def test_new_session_retires_only_same_device_and_persists(tmp_path):
    worker = WorkerRecord(path=tmp_path / "helpers.json", now=lambda: 100)
    worker.seen(CURRENT)
    worker.seen(CURRENT | {"id": "other"})
    worker.seen(CURRENT | {"sessionId": "run-2"})
    restarted = WorkerRecord(path=worker.path, now=lambda: 100)
    assert not restarted.seen(CURRENT)
    assert restarted.seen(CURRENT | {"id": "other"})
    assert restarted.bye("mac", "quit", "run-1") == {"stop": True, "reason": "replaced"}
    assert json.loads(worker.path.read_text())["retired"] == [["mac", "run-1"]]


def test_capabilities_are_validated_and_speed_cannot_be_reported():
    worker = WorkerRecord()
    worker.seen(CURRENT | {"speed": {"align": {"samples": 99, "medianSecondsPerMinute": 0.01}}})
    assert worker.snapshot()["speed"] == {}
    with pytest.raises(ValueError):
        worker.seen(CURRENT | {"jobs": ["not-a-job"]})


def test_unified_helper_protocol_is_the_minimum_version():
    assert MIN_WORKER_VERSION == "0.10.0"
    assert outdated("0.7.3")
    assert not outdated("0.10.0")


@pytest.mark.parametrize('version,state', [
    ('2.4.5', 'current'), ('2.4.6', 'current'), ('2.4.9', 'current'),
    ('2.3.9', 'update'), ('1.9.9', 'update'), ('3.0.0', 'current'),
    ('0.9.9', 'too-old'), ('0.10.0-rc.1', 'too-old'), ('', 'too-old'), ('unknown', 'too-old'),
])
def test_version_state_separates_protocol_floor_from_release_gap(monkeypatch, version, state):
    from app.domains.helpers import mac_worker
    monkeypatch.setattr(mac_worker, 'SHIPPED_WORKER_VERSION', '2.4.6')
    worker = WorkerRecord()
    worker.seen(CURRENT | {'version': version})
    row = worker.helpers()[0]
    assert row['version'] == version
    assert row['minimumVersion'] == MIN_WORKER_VERSION
    assert row['versionState'] == state


def test_shipped_version_tracks_release_manifest():
    from pathlib import Path
    from app.domains.helpers.mac_worker import SHIPPED_WORKER_VERSION
    manifest = Path(__file__).resolve().parents[3] / 'helper/release.json'
    assert SHIPPED_WORKER_VERSION == json.loads(manifest.read_text())['version']
