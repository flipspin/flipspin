"""owner attention and persisted release skip contract."""
import json
import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.infra.updates import FLOOR, UpdateChecker
from app.dependencies import DependencyContainer
from app.main import app


def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def nest(config, monkeypatch):
    container = DependencyContainer(config)
    monkeypatch.setattr(app.state, "config", config)
    monkeypatch.setattr(app.state, "container", container)
    checker = UpdateChecker(config, transport=Mock(side_effect=AssertionError("no outbound")))
    container._services["update_checker"] = checker
    _, owner = container.get_token_store().mint("Owner", "owner")
    _, member = container.get_token_store().mint("Member", "member")
    worker = Mock()
    worker.snapshot.return_value = None
    worker.helpers.return_value = []
    lyrics = dict(queued=0, leased=0, worker=None)
    stems = dict(jobs=[])
    queue = SimpleNamespace(status=lambda: lyrics, worker=worker)
    monkeypatch.setattr(container, "get_lyrics_service", lambda: SimpleNamespace(agent_queue=queue, pending_count=999))
    monkeypatch.setattr(container, "get_stems_service", lambda: SimpleNamespace(queue=SimpleNamespace(snapshot=lambda: stems)))
    return SimpleNamespace(client=TestClient(app, client=("192.0.2.8", 50000)), config=config,
                           checker=checker, owner=owner, member=member, worker=worker, lyrics=lyrics, stems=stems)


@pytest.mark.parametrize("latest,skipped,state,waiting,flag,tone", [
    ("9.0.0", None, None, 0, "version", "info"),
    ("9.0.0", "9.0.0", None, 0, None, None),
    ("9.0.1", "9.0.0", None, 0, "version", "info"),
    (None, None, "asleep", 1, "helper", "warn"),
    (None, None, "closed", 1, "helper", "warn"),
    (None, None, "outdated", 1, "helper", "warn"),
    (None, None, "offline", 1, "helper", "bad"),
    (None, None, None, 4, None, None),
    (None, None, "idle", 4, None, None),
    (None, None, "working", 4, None, None),
    (None, None, "offline", 0, None, None),
    (None, None, "asleep", 0, None, None),
    ("9.0.0", None, "asleep", 1, "helper", "warn"),
    ("9.0.0", None, "offline", 1, "helper", "bad"),
])
def test_flag_table(nest, latest, skipped, state, waiting, flag, tone):
    nest.config.update_check_file.write_text(json.dumps(dict(latest=latest, skippedVersion=skipped)))
    if state:
        helper = dict(id="h1", name="big_chip", state=state, version="0.10.0", address="secret", token="secret")
        nest.worker.snapshot.return_value = helper
        nest.worker.helpers.return_value = [helper]
        nest.lyrics["worker"] = helper
    nest.lyrics["queued"] = waiting
    response = nest.client.get("/api/me/attention", headers=auth(nest.owner))
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"version", "helper", "helpers", "flag", "flagTone"}
    assert (body["flag"], body["flagTone"]) == (flag, tone)
    if state:
        assert body["helper"]["waiting"] == waiting
        assert "secret" not in response.text
    nest.checker.transport.assert_not_called()


def test_queue_work_only_including_leased_and_stems(nest):
    helper = dict(id="h1", name="big_chip", state="asleep", version="0.10.0")
    nest.worker.snapshot.return_value = helper
    nest.worker.helpers.return_value = [helper, dict(helper, id="h2")]
    nest.lyrics.update(queued=2, leased=3, worker=helper)
    nest.stems["jobs"] = [{"status": state} for state in ("queued", "running", "failed", "ready")]
    body = nest.client.get("/api/me/attention", headers=auth(nest.owner)).json()
    assert body["helper"]["waiting"] == 7
    assert body["helpers"] == 2
    nest.lyrics.update(queued=0, leased=0)
    nest.client.get("/api/me/attention", headers=auth(nest.owner))
    nest.worker.snapshot.assert_called_with("stems")


def test_attention_roles_and_public_status_unchanged(nest):
    before = nest.client.get("/api/status").json()
    assert set(before) == {"restarting", "plugins", "app", "version", "buildId", "instanceId", "name", "pid", "isInit", "authMethods", "setupDone"}
    assert nest.client.get("/api/me/attention", headers=auth(nest.member)).json() == {}
    assert nest.client.get("/api/me/attention").status_code == 401
    # A loopback sentinel is accepted by auth but has no personal attention.
    assert TestClient(app).get("/api/me/attention").json() == {}
    nest.client.get("/api/me/attention", headers=auth(nest.owner))
    assert nest.client.get("/api/status").json().keys() == before.keys()
    assert not {"version", "helper", "helpers", "flag", "flagTone", "skipped"}.intersection(before.keys() - {"version"})


def test_all_sentinels_get_empty_attention(nest):
    from app.domains.accounts.auth import current_principal
    from app.domains.accounts.identity import SENTINEL_PRINCIPALS

    try:
        for principal in SENTINEL_PRINCIPALS:
            app.dependency_overrides[current_principal] = lambda p=principal: p
            assert nest.client.get("/api/me/attention", headers=auth(nest.owner)).json() == {}
    finally:
        app.dependency_overrides.pop(current_principal, None)


def test_attention_composes_real_queues_and_selected_helper(nest, tmp_path):
    from app.infra.progress import ProgressTracker
    from app.domains.accounts.attention import describe_attention
    from app.domains.lyrics.jobs import AgentQueue
    from app.domains.stems.jobs import StemsQueue

    queue = AgentQueue(path=tmp_path / "lyrics-queue.json", progress_tracker=ProgressTracker(),
                       logger=logging.getLogger(__name__), on_result=Mock(), on_failure=Mock(), now=lambda: 1000)
    repository = Mock()
    repository.queue_file = tmp_path / "stems-queue.json"
    stems = StemsQueue(repository, logging.getLogger(__name__), worker=queue.worker, now=lambda: 1000)
    container = SimpleNamespace(get_update_checker=lambda: nest.checker,
                                get_lyrics_service=lambda: SimpleNamespace(agent_queue=queue),
                                get_stems_service=lambda: SimpleNamespace(queue=stems))
    queue.enqueue([dict(relPath="Album/one.flac"), dict(relPath="Album/two.flac")])
    stems.request("Album", "three.flac")
    assert describe_attention(container)["flag"] is None  # queued work, no helper
    agent = dict(id="h1", name="big_chip", version="0.10.0")
    claimed = queue.claim(agent=agent)
    assert claimed["jobs"]
    result = describe_attention(container)
    assert result["helper"]["waiting"] == 3  # live leases also count
    assert result["helper"]["progress"] == dict(done=0, total=2)
    queue.worker.bye("h1", "sleep")
    result = describe_attention(container)
    assert (result["flag"], result["flagTone"]) == ("helper", "warn")
    assert result["helper"]["name"] == "big_chip"
    # An online helper wins over the most recent sleeping helper.
    queue.worker.seen(dict(id="h2", name="Other Mac", version="0.10.0"))
    result = describe_attention(container)
    assert result["helpers"] == 2 and result["helper"]["id"] == "h2"
    assert result["flag"] is None


@pytest.mark.parametrize("version", ["v9.0.0", "09.0.0", "9.0", "9.0.0-rc.1", "9.0.0+build", "8.0.0", "", None, 9])
def test_skip_rejects_invalid_versions(nest, version):
    nest.config.update_check_file.write_text('{"latest":"9.0.0"}')
    response = nest.client.put("/api/server/update/skip", json={"version": version}, headers=auth(nest.owner))
    assert response.status_code == 422
    assert nest.checker.describe()["skipped"] is None


def test_skip_unknown_and_idempotent_undo(nest):
    path = "/api/server/update/skip"
    assert nest.client.put(path, json={"version": "9.0.0"}, headers=auth(nest.owner)).status_code == 422
    nest.config.update_check_file.write_text('{"latest":"9.0.0"}')
    first = nest.client.put(path, json={"version": "9.0.0"}, headers=auth(nest.owner))
    assert first.status_code == 200 and first.json()["skipped"] == "9.0.0"
    assert nest.client.put(path, json={"version": "9.0.0"}, headers=auth(nest.owner)).json() == first.json()
    assert json.loads(nest.config.update_check_file.read_text())["skippedVersion"] == "9.0.0"
    assert nest.client.get("/api/me/attention", headers=auth(nest.owner)).json()["flag"] is None
    for _ in range(2):
        assert nest.client.delete(path, headers=auth(nest.owner)).json()["skipped"] is None
    assert nest.client.get("/api/me/attention", headers=auth(nest.owner)).json()["flag"] == "version"
    for method in ("PUT", "DELETE"):
        for token, status in ((nest.member, 403), ("", 401)):
            assert nest.client.request(method, path, json={"version": "9.0.0"}, headers=auth(token)).status_code == status


def test_new_release_clears_skip_but_same_release_and_errors_keep_it(nest):
    from tests.unit.test_updates import Response

    nest.config.update_check_file.write_text('{"latest":"9.0.0"}')
    nest.checker.skip("9.0.0")
    clock = [1_900_000_000.0]
    nest.checker.clock = lambda: clock[0]
    for response, skipped in [(Response(body={"tag_name": "v9.0.0"}), "9.0.0"), (Response(304), "9.0.0"),
                              (Response(500), "9.0.0"), (Response(body={"tag_name": "v9.0.1"}), None)]:
        nest.checker.transport.side_effect = None
        nest.checker.transport.return_value = response
        assert nest.checker.check()
        assert nest.checker.describe()["skipped"] == skipped
        clock[0] += FLOOR
    body = nest.client.get("/api/me/attention", headers=auth(nest.owner)).json()
    assert body["flag"] == "version" and body["version"]["latest"] == "9.0.1"
