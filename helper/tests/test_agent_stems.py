"""The agent's stems turn: lyrics first, then one stems job, uploaded multipart.

A stub HTTP server stands in for the backend and a tiny script for
`krobi-helper stems`, so no model runs.
"""
import json
import sys
import textwrap
import threading
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer


from krobi_helper import agent as A

FAKE_STEMS = textwrap.dedent("""
    import json, sys
    from pathlib import Path
    args = sys.argv[1:]
    job = json.loads(Path(args[args.index("--job") + 1]).read_text())
    out = Path(args[args.index("--out-dir") + 1]); out.mkdir(parents=True, exist_ok=True)
    assert Path(job["audio"]).read_bytes() == b"AUDIO"
    print(json.dumps({"event": "phase", "job": job["id"], "phase": "separando", "percent": None}), flush=True)
    for stem in ("drums", "bass", "vocals", "other"):
        (out / f"{stem}.ogg").write_bytes(b"OggS" + stem.encode())
    (out / "song.json").write_text(json.dumps({"version": 1, "chops": {}}))
    print(json.dumps({"event": "done", "job": job["id"], "dir": str(out)}), flush=True)
""")


class Stub(BaseHTTPRequestHandler):
    log: list = []
    stems_jobs: list = []

    def log_message(self, *_):
        pass

    def _reply(self, code, body=None):
        raw = json.dumps(body).encode() if body is not None else b""
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.log.append(("GET", self.path, None))
        self.send_response(200)
        self.send_header("Content-Length", "5")
        self.end_headers()
        self.wfile.write(b"AUDIO")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        self.log.append(("POST", self.path, (self.headers.get("Content-Type"), body)))
        if self.path == "/api/lyrics/agent/claim":
            return self._reply(200, {"lease": "x", "jobs": []})
        if self.path == "/api/stems/agent/claim":
            if self.stems_jobs:
                return self._reply(200, self.stems_jobs.pop(0))
            self.send_response(204)
            self.end_headers()
            return None
        if self.path == "/api/stems/agent/heartbeat":
            return self._reply(200, {"stop": False})
        if self.path == "/api/stems/agent/result":
            return self._reply(200, {"accepted": True, "status": "ready"})
        return self._reply(404, {"detail": "nope"})


def _serve():
    server = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _parts(content_type, body):
    msg = BytesParser(policy=default).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body)
    return {p.get_param("name", header="content-disposition"): p.get_payload(decode=True) for p in msg.iter_parts()}


def test_idle_lyrics_then_one_stems_job_is_split_and_uploaded(tmp_path):
    Stub.log = []
    Stub.stems_jobs = [{"id": "lease1", "jobId": "s1", "album": "A", "file": "B.mp3", "mediaPath": "/api/media/A/B.mp3", "model": "htdemucs"}]
    server = _serve()
    try:
        script = tmp_path / "fake_stems.py"
        script.write_text(FAKE_STEMS, encoding="utf-8")
        agent = A.Agent(f"http://127.0.0.1:{server.server_port}", "t", "test", work_dir=tmp_path / "work", log=lambda _m: None)
        agent.stems_command = [sys.executable, str(script)]
        assert agent.run(once=True) == 0
    finally:
        server.shutdown()
    paths = [p for _m, p, _b in Stub.log]
    assert paths.index("/api/lyrics/agent/claim") < paths.index("/api/stems/agent/claim")
    assert "/api/media/A/B.mp3" in paths
    phases = [json.loads(b[1])["phase"] for _m, p, b in Stub.log if p == "/api/stems/agent/heartbeat"]
    assert phases[0] == "decodificando" and "separando" in phases and phases[-1] == "subiendo"
    ctype, body = next(b for _m, p, b in Stub.log if p == "/api/stems/agent/result")
    parts = _parts(ctype, body)
    assert parts["id"] == b"lease1"
    assert json.loads(parts["song.json"])["version"] == 1
    assert parts["drums"] == b"OggSdrums" and set(parts) >= {"bass", "vocals", "other"}
    assert not list((tmp_path / "work").glob("stems-*")), "the work dir is cleaned up"


def test_a_server_without_stems_routes_leaves_the_agent_on_lyrics(tmp_path):
    class NoStems(Stub):
        def do_POST(self):
            if self.path.startswith("/api/stems/"):
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                return self._reply(404, {"detail": "Not Found"})
            return super().do_POST()

    server = HTTPServer(("127.0.0.1", 0), NoStems)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        logs = []
        agent = A.Agent(f"http://127.0.0.1:{server.server_port}", "t", "test", work_dir=tmp_path / "w", log=logs.append)
        assert agent.run(once=True) == 0
        assert agent._claim_stems() is None
    finally:
        server.shutdown()
    assert sum("no stems queue" in m for m in logs) == 1, "logged once, not every poll"


def test_a_failed_split_is_reported_with_its_verdict(tmp_path):
    Stub.log = []
    Stub.stems_jobs = [{"id": "lease2", "album": "A", "file": "B.mp3", "mediaPath": "/api/media/A/B.mp3"}]
    server = _serve()
    try:
        script = tmp_path / "fail.py"
        script.write_text(
            "import json\nprint(json.dumps({'event': 'failed', 'job': 'lease2', 'error': 'silencio', 'final': True}), flush=True)\n",
            encoding="utf-8",
        )
        agent = A.Agent(f"http://127.0.0.1:{server.server_port}", "t", "test", work_dir=tmp_path / "w", log=lambda _m: None)
        agent.stems_command = [sys.executable, str(script)]
        agent.run(once=True)
    finally:
        server.shutdown()
    ctype, body = next(b for _m, p, b in Stub.log if p == "/api/stems/agent/result")
    parts = _parts(ctype, body)
    assert parts["ok"] == b"false" and parts["final"] == b"true" and parts["error"] == b"silencio"



def test_check_and_stems_agree_on_where_the_beats_checkpoint_lives(tmp_path, monkeypatch):
    from krobi_helper import cli

    monkeypatch.delenv("TORCH_HOME", raising=False)
    monkeypatch.setenv("KROBI_MODELS_DIR", str(tmp_path))
    assert cli.torch_home() == tmp_path / "torch"
    assert cli._beats_present() is False
    ckpt = tmp_path / "torch" / "hub" / "checkpoints" / "beat_this-final0.ckpt"
    ckpt.parent.mkdir(parents=True)
    ckpt.write_bytes(b"x")
    assert cli._beats_present() is True
    monkeypatch.setenv("TORCH_HOME", str(tmp_path / "elsewhere"))
    assert cli._beats_present() is False, "an explicit TORCH_HOME wins, in both"


FAKE_ALIGN = textwrap.dedent("""
    import json, sys
    from pathlib import Path
    args = sys.argv[1:]
    jobs = json.loads(Path(args[args.index("--jobs") + 1]).read_text())
    out = Path(args[args.index("--out-dir") + 1]); out.mkdir(parents=True, exist_ok=True)
    job = jobs[0]
    assert job["text"] == "uno\\ndos" and Path(job["vocals"]).read_bytes() == b"AUDIO"
    (out / "x.lrc").write_text("[00:01.00] uno\\n[00:02.00] dos\\n")
    print(json.dumps({"event": "done", "job": job["id"], "lrc": str(out / "x.lrc"), "source": "aligned:mms-fa",
                      "lineConfidence": [0.8, 0.1], "lowLines": [1]}), flush=True)
""")


def test_a_split_song_aligns_on_its_vocals_stem_and_reports_the_scores(tmp_path):
    class Lyrics(Stub):
        def do_POST(self):
            if self.path.startswith("/api/lyrics/agent/"):
                length = int(self.headers.get("Content-Length") or 0)
                self.log.append(("POST", self.path, self.rfile.read(length)))
                return self._reply(200, {"stop": False, "accepted": True})
            return super().do_POST()

    Stub.log = []
    server = HTTPServer(("127.0.0.1", 0), Lyrics)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        script = tmp_path / "fake_align.py"
        script.write_text(FAKE_ALIGN, encoding="utf-8")
        agent = A.Agent(f"http://127.0.0.1:{server.server_port}", "t", "test", work_dir=tmp_path / "w", log=lambda _m: None)
        agent.job_command = [sys.executable, str(script)]
        agent._process("lease", {
            "id": "q1", "relPath": "A/B.mp3", "file": "B.mp3", "text": "uno\ndos",
            "mediaPath": "/api/media/A/B.mp3", "vocalsPath": "/api/stems/A/B.mp3/vocals",
        })
    finally:
        server.shutdown()
    assert ("GET", "/api/stems/A/B.mp3/vocals", None) in Stub.log
    result = json.loads(next(b for _m, p, b in Stub.log if p == "/api/lyrics/agent/result"))
    assert result["ok"] is True and result["lineConfidence"] == [0.8, 0.1] and result["lowLines"] == [1]
    assert not (tmp_path / "w" / "q1" / "vocals.ogg").exists(), "the stem copy is cleaned up"
