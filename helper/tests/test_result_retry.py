"""Finished results survive transport faults without rerunning computation."""
import io
import json
import threading
import urllib.error
from email.utils import formatdate
from itertools import pairwise
from pathlib import Path

import pytest
from krobi_helper import agent as A
from test_agent_stems import _parts


@pytest.fixture(params=["stems", "legacy-stems", "analysis"])
def delivery(request, tmp_path, monkeypatch):
    kind = request.param
    work = tmp_path / "work"
    work.mkdir()
    worker = A.Agent("http://nest", "token", work_dir=work, log=lambda _: None)
    worker._legacy_api = kind == "legacy-stems"
    worker._stems_jobs["lease"] = "job"
    monkeypatch.setattr(worker, "identity", lambda **kw: {"keepAwake": "none"})
    monkeypatch.setattr(worker, "_download", lambda url, target: target.write_bytes(b"audio"))
    state = {"now": 1_000_000.0, "attempts": [], "accepted": [], "beats": [],
             "faults": [], "heartbeat_fault": None, "runs": 0, "artifacts": []}
    monkeypatch.setattr(A.time, "time", lambda: state["now"])
    monkeypatch.setattr(A.time, "monotonic", lambda: state["now"])

    def start(beat):
        state["heartbeat"] = beat
        next_beat = state["now"] + A.HEARTBEAT_S

        def wait(delay):
            nonlocal next_beat
            state["now"] += delay
            if state["now"] >= next_beat:
                next_beat += A.HEARTBEAT_S
                beat.beat()
            return beat.stop_requested.is_set()

        monkeypatch.setattr(beat.stop_requested, "wait", wait)
        return beat

    monkeypatch.setattr(A.Heartbeat, "start", start)

    def run(argv, report, stop):
        state["runs"] += 1
        out = Path(argv[argv.index("--out-dir") + 1])
        out.mkdir()
        if kind == "analysis":
            return {"event": "done", "items": [{"relPath": "Album/Song.mp3", "bpm": 120}]}
        (out / "song.json").write_text('{"version":1,"chops":{}}')
        for stem in ("drums", "bass", "vocals", "other"):
            (out / f"{stem}.ogg").write_bytes(b"OggS" + stem.encode())
        return {"event": "done"}

    monkeypatch.setattr(worker, "_run_process", run)

    def fault(error, url):
        if isinstance(error, int):
            raise urllib.error.HTTPError(url, error, "injected", {}, io.BytesIO())
        if isinstance(error, Exception):
            raise error
        return error

    def urlopen(req, timeout):
        if req.full_url.endswith("/heartbeat"):
            state["beats"].append(state["now"])
            error = state["heartbeat_fault"] if state["attempts"] else None
            result = fault(error, req.full_url) or {"stop": False}
        else:
            assert req.full_url.endswith("/result")
            if kind == "analysis":
                body = json.loads(req.data)
                artifact = next(work.glob("analysis-*/result.json"))
                assert json.loads(artifact.read_text()) == body
            else:
                body = _parts(req.get_header("Content-type"), req.data)
                out = next(work.glob("stems-*/out"))
                assert body["song.json"] == (out / "song.json").read_bytes()
                for stem in ("drums", "bass", "vocals", "other"):
                    assert body[stem] == (out / f"{stem}.ogg").read_bytes()
            snapshot = {str(p.relative_to(work)): p.read_bytes()
                        for p in work.rglob("*") if p.is_file()}
            state["artifacts"].append(snapshot)
            state["attempts"].append((state["now"], body))
            error = state["faults"].pop(0) if state["faults"] else None
            result = fault(error, req.full_url)
            if result is None:
                state["accepted"].append(body)
                result = {"accepted": True}
        return io.BytesIO(json.dumps(result).encode())

    monkeypatch.setattr(worker, "_urlopen", urlopen)

    def deliver():
        job = {"id": "job", "lease": "lease", "items": [
            {"relPath": "Album/Song.mp3", "size": 5, "mtimeNs": 10, "mediaUrl": "/audio"}]}
        if kind == "analysis":
            worker._process_analysis(job)
        else:
            worker._process_stems({"id": "lease", "file": "Song.mp3", "mediaPath": "/audio"})
        assert state["runs"] == 1
        assert not list(work.iterdir()), "job artifacts must be cleaned after delivery or lease loss"
        assert state["heartbeat"]._done.is_set()
        return state

    state["deliver"] = deliver
    return state


def test_502_then_200_delivers_the_same_finished_result_once(delivery):
    delivery["faults"] = [502]
    state = delivery["deliver"]()
    assert len(state["attempts"]) == 2
    assert len(state["accepted"]) == 1
    assert state["attempts"][1][0] - state["attempts"][0][0] == 5
    assert state["attempts"][0][1] == state["accepted"][0]
    assert state["artifacts"][0] == state["artifacts"][1]


@pytest.mark.parametrize("code", [401, 403, 413])
def test_other_4xx_do_not_discard_finished_artifacts(delivery, code):
    delivery["faults"] = [code]
    state = delivery["deliver"]()
    assert len(state["attempts"]) == 2
    assert len(state["accepted"]) == 1
    assert state["artifacts"][0] == state["artifacts"][1]


@pytest.mark.parametrize("code", [400, 409, 410, 422])
def test_definitive_verdict_discards_without_retry(delivery, code):
    delivery["faults"] = [code]
    state = delivery["deliver"]()
    assert len(state["attempts"]) == 1
    assert not state["accepted"]


def test_404_discards_after_legacy_route_fallback(delivery):
    delivery["faults"] = [404, 404]
    state = delivery["deliver"]()
    assert 1 <= len(state["attempts"]) <= 2
    assert len({t for t, _ in state["attempts"]}) == 1, "no retry after the route verdict"
    assert not state["accepted"]


@pytest.mark.parametrize("verdict", [{"stop": True}, 409])
def test_lease_lost_during_backoff_stops_and_cleans_up(delivery, verdict):
    delivery["faults"] = [502, 502, 502]
    delivery["heartbeat_fault"] = verdict
    state = delivery["deliver"]()
    assert [t for t, _ in state["attempts"]] == [1_000_000, 1_000_005]
    assert not state["accepted"]
    assert state["heartbeat"].stop_requested.is_set()


@pytest.mark.parametrize("header", ["seconds", "date"])
def test_429_honours_retry_after_and_keeps_heartbeating(delivery, header):
    value = "70" if header == "seconds" else formatdate(delivery["now"] + 70, usegmt=True)
    delivery["faults"] = [urllib.error.HTTPError("http://nest", 429, "busy", {"Retry-After": value}, io.BytesIO())]
    state = delivery["deliver"]()
    assert state["attempts"][1][0] - state["attempts"][0][0] == 70
    assert len(state["accepted"]) == 1
    assert {1_000_020, 1_000_040, 1_000_060} <= set(state["beats"])
    assert state["artifacts"][0] == state["artifacts"][1]


def test_network_failures_back_off_and_renew_lease_beyond_ten_minutes(delivery):
    delivery["faults"] = [TimeoutError("timeout"), urllib.error.URLError("connection reset"),
                          ConnectionError("offline"), 503, 500, 429]
    state = delivery["deliver"]()
    times = [t for t, _ in state["attempts"]]
    assert [b - a for a, b in pairwise(times)] == [5, 15, 45, 120, 300, 300]
    assert len(state["accepted"]) == 1
    assert all(snapshot == state["artifacts"][0] for snapshot in state["artifacts"])


def test_missed_heartbeats_expire_lease_and_interrupt_retry_after(delivery):
    delivery["faults"] = [urllib.error.HTTPError("http://nest", 429, "busy", {"Retry-After": "900"}, io.BytesIO())]
    delivery["heartbeat_fault"] = TimeoutError("offline")
    state = delivery["deliver"]()
    assert len(state["attempts"]) == 1
    assert state["now"] == 1_000_600
    assert state["heartbeat"].stop_requested.is_set()
    assert not state["accepted"]


@pytest.mark.parametrize("answer", [{"stop": True}, {"accepted": False, "reason": "lease-lost"}])
def test_result_can_report_lease_loss_without_http_error(delivery, answer):
    delivery["faults"] = [answer]
    state = delivery["deliver"]()
    assert len(state["attempts"]) == 1
    assert not state["accepted"]
    assert state["heartbeat"].stop_requested.is_set()


def test_timer_heartbeats_continue_while_upload_is_blocked(tmp_path, monkeypatch):
    worker = A.Agent("http://nest", "token", work_dir=tmp_path, log=lambda _: None)
    monkeypatch.setattr(worker, "identity", lambda **kw: {"keepAwake": "none"})
    monkeypatch.setattr(A, "HEARTBEAT_S", 0.01)
    beat_seen = threading.Event()
    monkeypatch.setattr(worker, "_heartbeat_request", lambda *a: beat_seen.set() or {"stop": False})
    heartbeat = A.Heartbeat(worker, "/api/helpers/jobs/job/heartbeat", lambda *a: {}, name="test").start()
    try:
        def post():
            assert beat_seen.wait(2), "heartbeat must not depend on result POST finishing"
            return {"accepted": True}
        worker._retry_result(post, heartbeat, "test")
    finally:
        heartbeat.stop()


@pytest.mark.parametrize("value", ["invalid", "nan", "inf", "-3"])
def test_invalid_retry_after_uses_normal_backoff(value):
    error = urllib.error.HTTPError("http://nest", 429, "busy", {"Retry-After": value}, io.BytesIO())
    assert A.Agent._retry_after(error) == 0
