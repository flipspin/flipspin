"""The agent's process discipline: one agent per Mac, one process per song.

No model is involved — a tiny Python script stands in for `krobi-helper run`,
speaking the same JSON-lines protocol.
"""
import os
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

from krobi_helper import agent as A


def _fake_run(tmp_path: Path, body: str) -> list:
    script = tmp_path / "fake_run.py"
    script.write_text("import json, sys, time\n" + textwrap.dedent(body), encoding="utf-8")
    return [sys.executable, str(script)]


def _agent(tmp_path: Path, command: list) -> A.Agent:
    agent = A.Agent("http://127.0.0.1:9", "t", "test", work_dir=tmp_path / "work", log=lambda _m: None)
    agent.job_command = command
    return agent


def _job_dir(tmp_path: Path) -> Path:
    work = tmp_path / "work" / "j1"
    work.mkdir(parents=True)
    (work / "job.json").write_text("[]", encoding="utf-8")
    return work


def test_a_song_runs_in_its_own_process_and_its_phases_reach_the_heartbeat(tmp_path):
    command = _fake_run(tmp_path, """
        print(json.dumps({"event": "phase", "job": "j1", "phase": "transcribiendo", "percent": None}), flush=True)
        print(json.dumps({"event": "done", "job": "j1", "lrc": "x.lrc", "source": "stt:test"}), flush=True)
    """)
    agent = _agent(tmp_path, command)
    work = _job_dir(tmp_path)
    phases = []
    outcome = agent._run_job_process(work / "job.json", work, lambda p, _pc: phases.append(p), threading.Event())
    assert phases == ["transcribiendo"]
    assert outcome["event"] == "done" and outcome["source"] == "stt:test"


def test_a_verdict_about_the_song_stays_final_and_a_crash_is_retried(tmp_path):
    work = _job_dir(tmp_path)
    verdict = _agent(tmp_path, _fake_run(tmp_path, """
        print(json.dumps({"event": "failed", "job": "j1", "error": "instrumental", "final": True}), flush=True)
    """))._run_job_process(work / "job.json", work, lambda *_: None, threading.Event())
    assert verdict["final"] is True

    crash = _agent(tmp_path, _fake_run(tmp_path, "sys.exit(9)\n"))._run_job_process(
        work / "job.json", work, lambda *_: None, threading.Event()
    )
    assert crash["event"] == "failed" and crash["final"] is False and "9" in crash["error"]


def test_a_cancel_kills_the_song_process_and_reports_nothing(tmp_path):
    agent = _agent(tmp_path, _fake_run(tmp_path, "time.sleep(60)\n"))
    work = _job_dir(tmp_path)
    stop = threading.Event()
    threading.Timer(0.3, stop.set).start()
    started = time.monotonic()
    assert agent._run_job_process(work / "job.json", work, lambda *_: None, stop) is None
    assert time.monotonic() - started < 5


def test_a_new_agent_takes_the_lock_from_an_old_one(tmp_path):
    lock = tmp_path / "agent.lock"
    holder = subprocess.Popen(
        [sys.executable, "-c", textwrap.dedent(f"""
            import signal, sys, time
            from pathlib import Path
            from krobi_helper.agent import acquire_single_instance
            handle = acquire_single_instance(Path({str(lock)!r}))
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            print("held", flush=True)
            time.sleep(60)
        """)],
        stdout=subprocess.PIPE, text=True,
        env={**os.environ, "PYTHONPATH": str(Path(A.__file__).parent.parent)},
    )
    assert holder.stdout.readline().strip() == "held"
    handle = A.acquire_single_instance(lock, log=lambda _m: None)
    try:
        assert handle is not None
        assert holder.wait(timeout=5) == 0
        assert lock.read_text().strip() == str(os.getpid())
    finally:
        if handle:
            handle.close()
        if holder.poll() is None:
            holder.kill()


def test_a_processed_song_leaves_nothing_behind(tmp_path):
    """The source audio, job.json and the song process's own output (the .lrc
    under --out-dir) are all gone once the result is posted."""
    import json
    from http.server import BaseHTTPRequestHandler, HTTPServer

    posted = []

    class Server(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _reply(self, body):
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", "5")
            self.end_headers()
            self.wfile.write(b"AUDIO")

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"null")
            if self.path.startswith("/api/helpers/"):
                self.send_response(404)
                self.end_headers()
                return
            if self.path == "/api/lyrics/agent/claim":
                return self._reply({"lease": "L", "jobs": [{"id": "j1", "file": "B.opus", "mediaPath": "/api/media/A/B.opus"}]})
            if self.path == "/api/lyrics/agent/result":
                posted.append(body)
            return self._reply({"stop": False})

    command = _fake_run(tmp_path, """
        from pathlib import Path
        args = sys.argv[1:]
        job = json.loads(Path(args[args.index("--jobs") + 1]).read_text())[0]
        assert Path(job["audio"]).read_bytes() == b"AUDIO"
        out = Path(args[args.index("--out-dir") + 1]) / job["id"]
        out.mkdir(parents=True, exist_ok=True)
        (out / "lyrics.lrc").write_text("[00:01.00]hola", encoding="utf-8")
        (out / "mix16.wav").write_bytes(b"RIFF")
        print(json.dumps({"event": "done", "job": job["id"], "lrc": str(out / "lyrics.lrc"), "source": "stt:test"}), flush=True)
    """)
    server = HTTPServer(("127.0.0.1", 0), Server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        agent = A.Agent(f"http://127.0.0.1:{server.server_port}", "t", "test", work_dir=tmp_path / "work", log=lambda _m: None)
        agent.job_command = command
        assert agent.run(once=True) == 0
    finally:
        server.shutdown()
    assert posted and posted[0]["ok"] is True and posted[0]["lrc"] == "[00:01.00]hola"
    assert list((tmp_path / "work").iterdir()) == [], "the job's work dir is removed whole"
