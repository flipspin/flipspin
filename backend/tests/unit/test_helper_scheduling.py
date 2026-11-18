"""contract checks: both queues use the same scheduling and fencing."""
from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from app.domains.helpers import helper_ranking as ranking
from app.domains.helpers.mac_worker import WorkerRecord
from app.infra.progress import ProgressTracker
from app.domains.lyrics.jobs import AgentQueue, QueueRow
from app.domains.stems.models import STEMS, StemJob
from app.domains.stems.repositories import StemsRepository
from app.domains.stems.services import StemsService

pytestmark = pytest.mark.unit
LOG = logging.getLogger(__name__)
FAST = {"id": "fast", "name": "GPU", "version": "0.10.0", "accel": "mlx"}
SLOW = {"id": "slow", "name": "CPU", "version": "0.10.0", "os": "linux", "accel": "cpu", "memoryBytes": 8 << 30}
LOST = {"accepted": False, "reason": "lease-lost"}
STOP = {"stop": True, "reason": "lease-lost"}


@pytest.fixture(params=["align", "transcribe", "stems"])
def work(request, config, tmp_path):
    config.lyrics_file = tmp_path / "lyrics.json"
    config.stems_dir = tmp_path / "stems"
    clock = [1000.0]
    now = lambda: clock[0]
    failures = []
    output = tmp_path / "song.lrc"
    q = AgentQueue(path=tmp_path / "lyrics-queue.json", progress_tracker=ProgressTracker(), logger=LOG,
                   on_result=lambda row, lrc, source, extra: output.write_text(lrc),
                   on_failure=lambda row, error: failures.append(error), now=now, duration=lambda rel: 120)
    service = StemsService(repository=StemsRepository(config, LOG), config=config, logger=LOG, worker=q.worker, ledger=q.ledger)
    stems = service.queue
    stems.now = now
    stems.duration = lambda album, file: 120
    kind = request.param

    def enqueue():
        if kind == "stems":
            return stems.request("Album", "song.mp3")
        q.enqueue([{"relPath": "Album/song.mp3", "text": "words" if kind == "align" else None}])
        return list(q._rows.values())[-1]

    row = enqueue()
    queue = stems if kind == "stems" else q

    def claim(agent):
        if kind == "stems":
            got = stems.claim(agent)
            return got.lease if isinstance(got, StemJob) else None
        got = q.claim(agent, max_jobs=100)
        return got["lease"] if got["jobs"] else None

    def result(lease, text="new"):
        if kind != "stems":
            return q.result(lease, row.id, ok=True, lrc=text, extra={"seconds": 99999, "duration": 1})
        files = {}
        for stem in STEMS:
            file = tmp_path / f"{stem}-upload"
            file.write_text(text)
            files[stem] = file
        return service.publish(lease, {"version": 1, "track": {"duration": 1}, "seconds": 99999}, files)

    def beat(lease):
        return stems.heartbeat(lease) if kind == "stems" else q.heartbeat(lease, row.id)

    def content():
        return service.repository.stem_path("Album", "song.mp3", "vocals") if kind == "stems" else output

    return SimpleNamespace(kind=kind, q=q, stems=stems, service=service, queue=queue, worker=q.worker,
                           row=row, enqueue=enqueue, clock=clock, claim=claim, result=result, beat=beat,
                           content=content, failures=failures)


@pytest.mark.parametrize("agent,allowed", [
    (FAST, True), (SLOW, True), (FAST | {"memoryBytes": (8 << 30) - 1}, False),
    (SLOW | {"memoryBytes": None}, False), (FAST | {"jobs": []}, False),
    (SLOW | {"jobs": ["align"]}, "align"),
])
def test_subset_and_memory_for_every_kind(work, agent, allowed):
    assert bool(work.claim(agent)) == (allowed is True or allowed == work.kind)


def test_unknown_need_is_not_silently_ignored(work):
    work.row.needs.append("unavailable-feature")
    work.queue._save()
    assert work.claim(FAST) is None
    assert work.worker.wait_reason(work.kind, work.row.needs) == "no-capable-helper"


def test_slower_waits_exactly_sixty_seconds_with_idle_faster_helper(work):
    work.worker.seen(FAST)
    assert work.claim(SLOW) is None
    work.clock[0] += ranking.SLOW_DELAY_S - 0.01
    work.worker.seen(FAST)
    assert work.claim(SLOW) is None
    work.clock[0] += 0.01
    assert work.claim(SLOW)
    assert work.row.offered_at == 1000


@pytest.mark.parametrize("state", ["busy", "asleep", "offline", "closed"])
def test_faster_non_idle_helper_never_blocks(work, state):
    work.worker.seen(FAST)
    if state == "busy":
        work.worker.working("other", "fast", "Other queue", "running")
    elif state == "offline":
        work.clock[0] += 91
        work.row.offered_at = work.clock[0]  # do not pass by the slow-delay branch
    else:
        work.worker.bye("fast", "sleep" if state == "asleep" else "quit")
    assert work.claim(SLOW)


def test_measured_median_beats_accel_and_is_per_kind(work):
    work.worker.seen(FAST)
    work.worker.seen(SLOW)
    # A measured CPU can outrank a measured GPU, independently for each job kind.
    for _ in range(3):
        work.worker.record_result("fast", work.kind, 120, 120)
        work.worker.record_result("slow", work.kind, 20, 120)
    assert work.claim(FAST) is None
    assert work.claim(SLOW)


def test_below_three_samples_uses_accel_order(work):
    work.worker.seen(FAST)
    work.worker.seen(SLOW)
    for _ in range(2):
        work.worker.record_result("fast", work.kind, 120, 120)
        work.worker.record_result("slow", work.kind, 20, 120)
    assert work.claim(SLOW) is None
    assert work.claim(FAST)


def test_one_live_lease_across_queues_and_claims(work):
    assert work.claim(FAST)
    work.enqueue()
    if work.kind == "stems":
        work.q.enqueue([{"relPath": "Album/another.mp3"}])
    else:
        work.stems.request("Album", "another.mp3")
    assert work.claim(FAST) is None
    assert work.q.claim(FAST)["jobs"] == []
    assert work.stems.claim(FAST) is None


def test_old_lease_cannot_write_and_duplicate_cannot_write_twice(work):
    old = work.claim(FAST)
    work.clock[0] += 601
    current = work.claim(FAST)
    assert current and old != current
    work.clock[0] += 30
    accepted = work.result(current)
    assert accepted["accepted"] is True
    path = work.content()
    before = path.read_bytes(), path.stat().st_mtime_ns
    assert work.result(old, "stale") == LOST
    assert work.beat(old) == STOP
    assert work.result(current, "duplicate") == accepted
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    speed = work.worker.helpers()[0]["speed"][work.kind]
    assert speed == {"samples": 1, "medianSecondsPerMinute": 15}
    assert work.row.result == {"worker": "fast", "analyzed_by": "fast", "helperName": "GPU", "accel": "mlx", "version": "0.10.0", "seconds": 30}
    # Completion receipts and their attribution survive a server restart.
    work.queue._loaded = False
    assert work.result(current, "after restart") == accepted
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before


def test_three_lost_leases_fail_with_the_contract_words(work):
    for attempt in range(1, 4):
        assert work.claim(FAST)
        assert work.row.attempts == attempt
        work.clock[0] += 601
    work.queue._reap()
    assert work.row.status == "failed"
    assert work.row.error == "el equipo dejó de responder 3 veces"
    assert not work.claim(FAST)


def test_wait_reason_all_four_and_oldest_at(work):
    def reason():
        snapshot = work.stems.snapshot() if work.kind == "stems" else work.q.status()
        assert snapshot["waitReason"] == work.worker.wait_reason(work.kind, work.row.needs)
        rows = snapshot["jobs"] if work.kind == "stems" else snapshot["rows"]
        return rows[0]["waitReason"]
    assert reason() == "no-helper"
    work.worker.seen(FAST | {"jobs": []})
    assert reason() == "no-capable-helper"
    work.worker.seen(FAST)
    work.worker.bye("fast", "sleep")
    assert reason() == "helpers-offline"
    work.worker.seen(FAST)
    work.worker.working("other", "fast", "Busy", "running")
    assert reason() == "helpers-busy"
    work.worker.finished("other")
    assert reason() is None
    snapshot = work.stems.snapshot() if work.kind == "stems" else work.q.status()
    assert snapshot["oldestAt"] == work.clock[0]


def test_parallel_claims_reserve_only_one_row(work):
    work.enqueue()
    with ThreadPoolExecutor(max_workers=2) as pool:
        leases = list(pool.map(work.claim, [FAST, FAST]))
    assert sum(bool(lease) for lease in leases) == 1


def test_lyrics_priority_applies_to_stems_only_when_helper_can_do_lyrics(work):
    if work.kind == "stems":
        work.q.enqueue([{"relPath": "Album/other.mp3"}])
        assert work.stems.claim(FAST) is None
        assert work.stems.claim(FAST | {"jobs": ["stems"]})


def test_window_median_is_bounded_persistent_and_never_reported(tmp_path):
    path = tmp_path / "helpers.json"
    worker = WorkerRecord(path=path)
    worker.seen(FAST | {"speed": {"align": {"samples": 999, "medianSecondsPerMinute": 0}}})
    assert worker.helpers()[0]["speed"] == {}
    for seconds in range(1, 26):
        worker.record_result("fast", "align", seconds, 120)
    worker.seen(FAST | {"speed": {"align": {"samples": 999}}})
    restarted = WorkerRecord(path=path)
    assert restarted.helpers()[0]["speed"]["align"] == {"samples": 20, "medianSecondsPerMinute": 7.75}
    assert len(json.loads(path.read_text())["helpers"]["fast"]["speedWindows"]["align"]) == 20
    restarted.record_result("fast", "align", 999, None)
    assert restarted.helpers()[0]["speed"] == worker.helpers()[0]["speed"]


def test_old_disk_rows_gain_sensible_defaults():
    for text, kind in [(None, "transcribe"), ("words", "align")]:
        row = QueueRow.from_dict({"id": "q", "rel_path": "A/a", "item": "a", "progress_id": "p", "text": text, "created_at": 42})
        assert row.kind == kind and row.needs == ranking.default_needs(kind)
        assert row.offered_at == 42 and row.result is None
    row = StemJob.from_dict({"id": "s", "album": "A", "file": "a", "requested_at": 42})
    assert row.kind == "stems" and row.needs == ranking.default_needs("stems") and row.offered_at == 42


def test_outdated_display_state_cannot_make_offline_helper_block(work):
    work.worker.seen(FAST | {"version": "0.1.0"})
    work.clock[0] += 91
    work.row.offered_at = work.clock[0]
    assert work.claim(SLOW)


def test_equal_accel_tiers_do_not_delay_each_other(work):
    work.worker.seen(FAST)
    assert work.claim(SLOW | {"accel": "cuda"})


def test_successful_result_is_persisted_with_the_queue_receipt(work):
    lease = work.claim(FAST)
    work.clock[0] += 10
    assert work.result(lease)["accepted"] is True
    receipt = work.queue.queue.receipts(work.queue.kinds)[lease]
    assert receipt["row"]["status"] == "done"
    assert receipt["identity"] == "fast"
    assert receipt["row"]["result"] == {"worker": "fast", "analyzed_by": "fast", "helperName": "GPU", "accel": "mlx", "version": "0.10.0", "seconds": 10}
    assert receipt["row"]["offeredAt"] == 1000
    assert receipt["row"]["leasedBy"] == "fast"


def test_every_faster_helper_must_be_non_idle_before_slow_helper_can_claim(work):
    work.worker.seen(FAST)
    work.worker.seen(FAST | {"id": "fast-2", "accel": "cuda", "memoryBytes": 8 << 30})
    work.worker.working("other", "fast", "Busy", "running")
    assert work.claim(SLOW) is None
    work.worker.bye("fast-2", "sleep")
    assert work.claim(SLOW)


def test_heartbeat_cannot_resurrect_an_already_expired_lease(work):
    lease = work.claim(FAST)
    work.clock[0] += 601
    assert work.beat(lease) == STOP
    assert work.row.status == "queued"


def test_three_immediate_releases_also_exhaust_attempts(work):
    for _ in range(3):
        assert work.claim(FAST)
        work.worker.bye("fast", "sleep")
    assert work.row.status == "failed"
    assert work.row.error == "el equipo dejó de responder 3 veces"


def test_wrong_device_heartbeat_cannot_extend_the_current_lease(work):
    lease = work.claim(FAST)
    before = work.row.last_heartbeat
    work.clock[0] += 5
    reply = work.stems.heartbeat(lease, agent=SLOW) if work.kind == "stems" else work.q.heartbeat(lease, work.row.id, agent=SLOW)
    assert reply == STOP
    assert work.row.last_heartbeat == before


def test_provenance_uses_claimed_machine_even_after_heartbeat_changes(work):
    lease = work.claim(FAST)
    work.worker.seen(FAST | {'name': 'Renamed', 'accel': 'cpu', 'version': '0.9.0'})
    work.clock[0] += 10
    assert work.result(lease)['accepted']
    receipt = work.queue.queue.receipts(work.queue.kinds)[lease]
    result = receipt['row']['result']
    assert result['worker'] == result['analyzed_by'] == 'fast'
    assert (result['helperName'], result['accel'], result['version']) == ('GPU', 'mlx', '0.10.0')
    job_id = receipt['row'].get('progress_id') or receipt['row']['jobId']
    assert work.queue.ledger.items(job_id)[0]['detail']['result'] == result


@pytest.mark.parametrize('version,allowed', [('0.9.9', False), ('0.10.0', True), ('0.14.0', True)])
def test_protocol_floor_refuses_claims_but_keeps_presence(work, version, allowed):
    from app.domains.helpers.mac_worker import MIN_WORKER_VERSION
    agent = FAST | {'version': version}
    got = work.queue.claim(agent)
    if allowed:
        assert (got.lease if work.kind == 'stems' else got['jobs'])
    else:
        assert {k: got[k] for k in ('stop', 'reason', 'minimum')} == {
            'stop': True, 'reason': 'too-old', 'minimum': MIN_WORKER_VERSION}
        assert work.row.status == 'queued' and work.row.attempts == 0
        # Repeated claims remain harmless and keep the helper visible.
        assert work.queue.claim(agent) == got
    row = work.worker.helpers()[0]
    assert row['version'] == version
    assert row['versionState'] == ('update' if allowed else 'too-old')


def test_refused_faster_helper_cannot_delay_eligible_helper(work):
    work.worker.seen(FAST | {'version': '0.9.9'})
    assert work.claim(SLOW)
