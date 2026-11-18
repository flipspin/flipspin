"""The agent queue: leases, heartbeats, results, cancel, stale reaping, restart."""
from __future__ import annotations

import logging
from pathlib import Path

import pytest

from app.infra.progress import ProgressTracker
from app.domains.lyrics.jobs import AgentQueue
from app.infra.jobs.queue import LEASE_STALE_S, MAX_ATTEMPTS

pytestmark = pytest.mark.unit
LOG = logging.getLogger("test.lyrics.queue")
MAC = {"name": "MacBook", "platform": "darwin-arm64", "version": "0.10.0"}


class Clock:
    def __init__(self):
        self.t = 1_000.0

    def __call__(self):
        return self.t


@pytest.fixture
def q(tmp_path):
    clock = Clock()
    saved, failed = [], []
    queue = AgentQueue(
        path=tmp_path / "lyrics-queue.json",
        progress_tracker=ProgressTracker(),
        logger=LOG,
        on_result=lambda row, lrc, source, extra: saved.append((row.rel_path, lrc, source)),
        on_failure=lambda row, reason: failed.append((row.rel_path, reason)),
        now=clock,
    )
    queue.clock, queue.saved, queue.failed = clock, saved, failed  # type: ignore[attr-defined]
    return queue


def _two(q):
    return q.enqueue([
        {"relPath": "A/one.mp3", "item": "One", "text": "hola"},
        {"relPath": "A/two.mp3", "item": "Two"},
    ])


class TestClaimAndResult:
    def test_claim_hands_out_oldest_first_with_media_path_and_a_lease(self, q):
        pid = _two(q)
        got = q.claim(MAC, max_jobs=1)
        assert len(got["jobs"]) == 1 and got["queued"] == 1
        job = got["jobs"][0]
        assert job["relPath"] == "A/one.mp3" and job["mediaPath"] == "/api/media/A/one.mp3"
        assert job["text"] == "hola" and job["isolateVocals"] is True
        assert q.status()["leased"] == 1 and q.status()["online"] is True
        state = q.progress_tracker.get_progress(pid)
        assert state.active["Two"]["phase"] == "en cola"

    def test_result_saves_and_completes_the_batch(self, q):
        pid = _two(q)
        lease = q.claim(MAC, max_jobs=2)["lease"]
        jobs = {r.rel_path: r.id for r in q._rows.values()}
        assert q.result(lease, jobs["A/one.mp3"], ok=True, lrc="[00:01.00] a\n", source="aligned:mms-fa") == {"accepted": True}
        lease = q.claim(MAC)["lease"]
        assert q.result(lease, jobs["A/two.mp3"], ok=False, lrc=None, source=None, error="instrumental") == {"accepted": True}
        assert q.saved == [("A/one.mp3", "[00:01.00] a\n", "aligned:mms-fa")]
        assert q.failed == [("A/two.mp3", "instrumental")]
        state = q.progress_tracker.get_progress(pid)
        assert state.is_terminal and state.succeeded == 1 and state.failed == 1
        assert q.status()["running"] is None and q.status()["queued"] == 0

    def test_a_result_under_a_stale_or_wrong_lease_is_ignored(self, q):
        _two(q)
        q.claim(MAC, max_jobs=1)
        job_id = next(iter(q._rows))
        assert q.result("nope", job_id, ok=True, lrc="x", source="s", error=None) == {"accepted": False, "reason": "lease-lost"}
        assert q.heartbeat("nope", job_id, "separando", None) == {"stop": True, "reason": "lease-lost"}
        assert q.saved == []

    def test_a_refused_save_marks_the_row_failed(self, q):
        _two(q)
        lease = q.claim(MAC, max_jobs=1)["lease"]
        job_id = next(r.id for r in q._rows.values() if r.rel_path == "A/one.mp3")

        def boom(row, lrc, source, extra):
            raise RuntimeError("edited by hand")

        q.on_result = boom
        q.result(lease, job_id, ok=True, lrc="[00:01.00] a", source="s", error=None)
        assert q.failed == [("A/one.mp3", "edited by hand")]

    def test_a_transient_failure_is_requeued_until_max_attempts(self, q):
        q.enqueue([{"relPath": "A/flaky.mp3", "item": "Flaky"}])
        for attempt in range(MAX_ATTEMPTS):
            lease = q.claim(MAC)["lease"]
            job_id = next(iter(q._rows))
            answer = q.result(lease, job_id, ok=False, error="ffmpeg exploded", final=False)
            if attempt < MAX_ATTEMPTS - 1:
                assert answer.get("requeued") is True and q.status()["queued"] == 1
        assert q.failed == [("A/flaky.mp3", "ffmpeg exploded")]
        assert q.status()["queued"] == 0


class TestLeaseDiscipline:
    def test_claims_throttle_all_reapers_using_the_worker_clock(self, q):
        calls = []
        q.worker.register_reap(lambda: calls.append(q.clock.t))
        q.claim(MAC)
        q.clock.t += 5
        q.claim(MAC)
        assert calls == [1000.0]
        q.clock.t += 61
        q.claim(MAC)
        assert calls == [1000.0, 1066.0]

    def test_maintenance_shares_the_reap_throttle(self, q):
        calls = []
        q.worker.register_reap(lambda: calls.append(q.clock.t))
        q.worker.reap()
        q.clock.t += 5
        q.worker.maintain()
        assert calls == [1000.0]
        q.clock.t += 55
        q.worker.maintain()
        assert calls == [1000.0, 1060.0]

    def test_heartbeat_keeps_the_lease_and_reports_the_phase(self, q):
        pid = _two(q)
        lease = q.claim(MAC)["lease"]
        job_id = next(r.id for r in q._rows.values() if r.rel_path == "A/one.mp3")
        q.clock.t += LEASE_STALE_S - 5
        assert q.heartbeat(lease, job_id, "transcribiendo", 40) == {"stop": False}
        assert q.progress_tracker.get_progress(pid).active["One"] == {"phase": "transcribiendo", "percent": 40}
        q.clock.t += LEASE_STALE_S - 5
        q.claim({"name": "other", "version": "0.10.0"})  # reaper runs; lease is still fresh from the heartbeat
        assert q._rows[job_id].status == "leased"

    def test_a_quiet_lease_goes_back_on_the_queue(self, q):
        _two(q)
        q.claim(MAC, max_jobs=2)
        q.claim({"name": "second", "version": "0.10.0"})
        q.clock.t += LEASE_STALE_S + 1
        got = q.claim({"name": "other", "version": "0.10.0"}, max_jobs=2)
        assert len(got["jobs"]) == 1
        q.claim({"name": "another", "version": "0.10.0"})
        assert all(r.leased_by in ("other", "another") and r.attempts == 2 for r in q._rows.values())

    @pytest.mark.parametrize("reap_with", ["status", "claim"])
    def test_quiet_leases_stop_at_the_limit_and_complete_the_batch(self, q, reap_with):
        pid = _two(q)
        for _ in range(MAX_ATTEMPTS):
            assert len(q.claim(MAC, max_jobs=2)["jobs"]) == 1
            assert len(q.claim({"name": "second", "version": "0.10.0"})["jobs"]) == 1
            q.clock.t += LEASE_STALE_S + 1
        rows = list(q._rows.values())
        getattr(q, reap_with)(*([MAC] if reap_with == "claim" else []))
        reason = f"el equipo dejó de responder {MAX_ATTEMPTS} veces"
        assert q.failed == [("A/one.mp3", reason), ("A/two.mp3", reason)]
        assert all(r.status == "failed" and r.error == reason and r.lease is None for r in rows)
        state = q.progress_tracker.get_progress(pid)
        assert state.is_terminal and state.failed == 2 and state.succeeded == 0
        assert state.completed == state.total == 2 and not state.active
        assert not q._rows
        assert q.queue.rows(q.kinds) == []

    def test_cancel_stops_queued_and_leased_rows(self, q):
        pid = _two(q)
        lease = q.claim(MAC)["lease"]
        leased_id = next(r.id for r in q._rows.values() if r.status == "leased")
        assert q.cancel(pid) is True
        assert q.heartbeat(lease, leased_id, "separando", None) == {"stop": True, "reason": "lease-lost"}
        state = q.progress_tracker.get_progress(pid)
        assert state.is_terminal and state.status == "cancelled"
        assert q.status()["queued"] == 0 and q.status()["leased"] == 0

    def test_an_agent_is_online_for_a_while_after_it_last_claimed(self, q):
        q.claim(MAC)
        assert q.status()["online"] is True and q.status()["agents"][0]["name"] == "MacBook"
        q.clock.t += 200
        assert q.status()["online"] is False


class TestPersistence:
    @pytest.mark.parametrize("exhaust_all", [False, True])
    def test_restart_fails_exhausted_leases_and_persists_recovery(self, q, exhaust_all):
        pid = _two(q)
        q.claim(MAC, max_jobs=2)
        q.claim({"name": "second", "version": "0.10.0"})
        rows = list(q._rows.values())
        rows[0].attempts = MAX_ATTEMPTS
        if exhaust_all:
            rows[1].attempts = MAX_ATTEMPTS
        with q.ledger.db:
            for row in rows:
                q.ledger.db.execute('UPDATE items SET attempts=? WHERE queue_id=?', (row.attempts, row.id))
        failed = []
        again = AgentQueue(
            path=q.path, progress_tracker=ProgressTracker(), logger=LOG,
            on_result=lambda *a: None, on_failure=lambda row, reason: failed.append((row.rel_path, reason)), now=q.clock,
        )
        status = again.status()
        assert status["queued"] == (0 if exhaust_all else 1) and status["leased"] == 0
        reason = f"el equipo dejó de responder {MAX_ATTEMPTS} veces"
        assert failed == [(r.rel_path, reason) for r in rows if r.attempts == MAX_ATTEMPTS]
        state = again.progress_tracker.get_progress(pid)
        assert state.is_terminal == exhaust_all
        assert state.completed == (2 if exhaust_all else 1)
        if exhaust_all:
            assert state.failed == 2 and state.succeeded == 0 and not state.active
        persisted = again.queue.rows(again.kinds)
        assert all(r["status"] in ("queued", "failed") and r["lease"] is None for r in persisted)
        # Reading the recovered file never reports the same failure twice.
        again._loaded = False
        again.status()
        assert len(failed) == (2 if exhaust_all else 1)

    def test_rows_survive_a_restart_and_leases_do_not(self, q, tmp_path):
        pid = _two(q)
        q.claim(MAC)
        again = AgentQueue(
            path=q.path, progress_tracker=ProgressTracker(), logger=LOG,
            on_result=lambda *a: None, on_failure=lambda *a: None, now=q.clock,
        )
        status = again.status()
        assert status["queued"] == 2 and status["leased"] == 0
        # The batch's progress entry is rebuilt on the new tracker.
        assert again.progress_tracker.get_progress(pid) is not None
        assert q.ledger.path.exists() and not Path(q.path).exists()


CURRENT = {"id": "device-1", "sessionId": "run-1", "name": "Mac de Ana", "chip": "Apple M1 Pro",
           "memoryBytes": 17179869184, "macos": "26.1", "version": "0.10.0", "state": "idle", "lastError": None}


class TestNestMac:
    def test_no_worker_then_idle_with_all_facts(self, q):
        assert q.status()["worker"] is None
        q.claim(CURRENT)
        worker = q.status()["worker"]
        assert worker == {k: v for k, v in CURRENT.items() if k not in ("state",)} | {
            "minimumVersion": "0.10.0", "versionState": "update", "nest": False, "state": "idle", "lastSeenAt": q.clock.t, "job": None, "os": "macos", "accel": "mlx",
            "gpu": None, "jobs": ["align", "transcribe", "stems"], "labels": [], "speed": {}, "keepAwake": "none", "goodbye": None,
            'disabledReason': None, 'disabledMessage': None, 'blockedReasons': [], 'pausedReason': None,
            'temperatureC': None, 'cpuLimitMode': None, 'onBattery': None, 'powerReadable': None, 'utcOffsetMinutes': None, 'engines': None}
        assert q.status()["agents"][0]["name"] == CURRENT["name"]

    def test_working_phase_result_idle_then_offline(self, q):
        q.enqueue([{"relPath": "A/a.mp3", "item": "Canción"}])
        claim = q.claim(CURRENT)
        job = claim["jobs"][0]
        assert q.status()["worker"]["state"] == "working"
        q.clock.t += 80
        facts = CURRENT | {"name": "New ComputerName", "chip": "Apple M4", "lastError": "nest-unreachable"}
        q.heartbeat(claim["lease"], job["id"], "alineando", 10, facts)
        worker = q.status()["worker"]
        assert worker["name"] == "New ComputerName" and worker["chip"] == "Apple M4"
        assert worker["lastError"] == "nest-unreachable"
        assert worker["job"] == {"title": "Canción", "phase": "alineando"}
        assert worker["lastSeenAt"] == q.clock.t
        q.result(claim["lease"], job["id"], ok=True, lrc="[00:01.00]hola")
        assert q.status()["worker"]["state"] == "idle"
        assert q.status()["worker"]["job"] is None
        q.clock.t += 91
        assert q.status()["worker"]["state"] == "offline"
        assert q.status()["online"] is False

    @pytest.mark.parametrize("reason,state", [("sleep", "asleep"), ("quit", "closed")])
    def test_bye_persists_until_next_claim_or_heartbeat(self, q, reason, state):
        q.claim(CURRENT)
        assert q.worker.bye(CURRENT["id"], reason) == {"stop": False}
        q.clock.t += 1000
        assert q.status()["worker"]["state"] == state
        assert q.status()["online"] is False
        from app.domains.helpers.mac_worker import WorkerRecord
        restarted = WorkerRecord(now=q.clock, path=q.worker.path)
        assert restarted.snapshot()["state"] == state
        q.heartbeat(agent=CURRENT)
        assert q.status()["worker"]["state"] == "idle"
        assert q.status()["online"] is True

    @pytest.mark.parametrize("version", ["0.6.0", "0.7.0rc1", "", "broken"])
    def test_outdated(self, q, version):
        q.claim(CURRENT | {"version": version})
        assert q.status()["worker"]["state"] == "outdated"
        q.heartbeat(agent=CURRENT | {"version": "0.10.0"})
        assert q.status()["worker"]["state"] == "idle"

    def test_several_helpers_keep_their_own_leases_and_sessions(self, q):
        _two(q)
        first = q.claim(CURRENT)
        second = CURRENT | {"id": "device-2", "name": "Other Mac"}
        claimed = q.claim(second)
        assert len(q.status()["helpers"]) == len(q.status()["agents"]) == 2
        assert claimed["jobs"][0]["id"] != first["jobs"][0]["id"]
        assert q.heartbeat(first["lease"], first["jobs"][0]["id"], agent=CURRENT) == {"stop": False}
        # Only a fresh launch on the SAME device replaces a session.
        restarted = q.claim(CURRENT | {"sessionId": "run-2"})
        assert restarted["jobs"][0]["id"] == first["jobs"][0]["id"]
        assert q.claim(CURRENT)["reason"] == "replaced"
        assert q.heartbeat(first["lease"], first["jobs"][0]["id"], agent=CURRENT) == {"stop": True, "reason": "replaced"}
        assert q.worker.bye(CURRENT["id"], "quit", "run-1") == {"stop": True, "reason": "replaced"}
        assert q.result(first["lease"], first["jobs"][0]["id"], ok=True, lrc="late") == {"accepted": False, "reason": "lease-lost"}
        assert q.heartbeat(claimed["lease"], claimed["jobs"][0]["id"], agent=second) == {"stop": False}

    def test_oldest_queued_at_is_not_the_preview_order(self, q):
        _two(q)
        assert q.status()["oldestQueuedAt"] == q.clock.t
        q.claim(CURRENT, max_jobs=2)
        q.claim(CURRENT | {"id": "second"})
        assert q.status()["oldestQueuedAt"] is None


    def test_presence_keeps_mac_working_during_a_plugin_job(self, q):
        q.claim(CURRENT)
        q.clock.t += 80
        q.heartbeat(agent=CURRENT | {"state": "working"})
        q.clock.t += 80
        assert q.status()["worker"]["state"] == "working"
        assert q.status()["online"] is True
        q.heartbeat(agent=CURRENT)
        assert q.status()["worker"]["state"] == "idle"
