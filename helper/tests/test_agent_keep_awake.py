"""Shell hand-off with a fake server, without needing a localhost bind permission."""
import json
import socket
import subprocess
import sys
import threading
from contextlib import contextmanager
from unittest.mock import Mock

import pytest
from krobi_helper import agent as A


@pytest.fixture
def agent(tmp_path, monkeypatch):
    monkeypatch.delenv("KROBI_KEEP_AWAKE_ADDR", raising=False)
    return A.Agent("http://127.0.0.1:9", "t", "test", work_dir=tmp_path, log=lambda _: None)


@contextmanager
def server(monkeypatch, reply=b'{"keepAwake":"held"}\n', disconnect=False):
    """The real socket transport runs against a shell stand-in on a socketpair."""
    client, shell = socket.socketpair()
    closed = threading.Event()
    replied = threading.Event()
    requests = []
    errors = []

    def connect(address, timeout):
        assert address == ("127.0.0.1", 12345)
        assert timeout == 5.0
        client.settimeout(timeout)
        return client

    def serve():
        try:
            shell.settimeout(5)
            raw = bytearray()
            while not raw.endswith(b"\n"):
                chunk = shell.recv(1)
                if not chunk:
                    return
                raw.extend(chunk)
            requests.append(json.loads(raw))
            shell.sendall(reply)
            if disconnect:
                shell.shutdown(socket.SHUT_RDWR)
            replied.set()
            if not disconnect:
                assert shell.recv(1) == b""
            closed.set()
        except (OSError, ValueError, AssertionError) as error:
            errors.append(error)
        finally:
            shell.close()
            replied.set()

    monkeypatch.setenv("KROBI_KEEP_AWAKE_ADDR", "127.0.0.1:12345")
    monkeypatch.setattr(A.socket, "create_connection", connect)
    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield requests, client, replied, closed
    finally:
        client.close()
        thread.join(timeout=6)
        assert not thread.is_alive()
        assert not errors


def heartbeat(agent, path):
    return A.Heartbeat(agent, path, lambda phase, pc: {"phase": phase}, name="test")


@pytest.mark.parametrize("path", ["/api/lyrics/agent/heartbeat", "/api/stems/agent/heartbeat", "/api/plugin/heartbeat"])
def test_held_on_every_heartbeat_and_identity_until_job_finally(agent, monkeypatch, path):
    posts = []
    monkeypatch.setattr(agent, "_request", lambda method, url, body, **kw: posts.append((url, body)) or {})
    monkeypatch.setattr(agent, "_caffeinate", Mock(side_effect=AssertionError("double acquisition")))
    assert agent.identity()["keepAwake"] == "none"
    with server(monkeypatch) as (requests, conn, _, closed):
        with agent._job_awake():
            agent._acquire_keep_awake(321)
            assert conn.get_inheritable() is False
            beat = heartbeat(agent, path)
            beat.report("transcribing", None)
            beat.beat()  # timer beats carry the same value even without output
            assert agent.identity("working")["keepAwake"] == "held"
            assert not closed.is_set()
            # A nested process scope must not release the owning upload's socket.
            with agent._job_awake():
                pass
            assert not closed.is_set()
        assert closed.wait(1)
        assert requests == [{"pid": 321}]
        assert conn.fileno() == -1
    assert posts
    assert all(body["keepAwake"] == body["agent"]["keepAwake"] == "held" for _, body in posts)
    assert agent.identity()["keepAwake"] == "none"
    assert agent.identity("working")["keepAwake"] == "none"


@pytest.mark.parametrize("address", ["", "bad-address", "127.0.0.1:12345"])
def test_configured_but_unreachable_reports_failed_and_does_not_caffeinate(agent, monkeypatch, address):
    monkeypatch.setenv("KROBI_KEEP_AWAKE_ADDR", address)
    monkeypatch.setattr(A.socket, "create_connection", Mock(side_effect=OSError("refused")))
    monkeypatch.setattr(agent, "_caffeinate", Mock(side_effect=AssertionError("legacy fallback")))
    posts = []
    monkeypatch.setattr(agent, "_request", lambda method, url, body, **kw: posts.append(body) or {})
    with agent._job_awake():
        agent._acquire_keep_awake(321)
        heartbeat(agent, "/api/lyrics/agent/heartbeat").beat()
        assert posts[-1]["keepAwake"] == posts[-1]["agent"]["keepAwake"] == "failed"
    assert agent.identity()["keepAwake"] == "none"


@pytest.mark.parametrize("reply", [b'{"keepAwake":"failed"}\n', b'[]\n', b'garbage\n', b'{"keepAwake":"none"}\n', b'\xff\n', b'x' * 1024])
def test_refused_or_invalid_reply_is_failed_and_socket_closes(agent, monkeypatch, reply):
    with server(monkeypatch, reply) as (_, conn, _, closed):
        with agent._job_awake():
            agent._acquire_keep_awake(321)
            assert agent.identity("working")["keepAwake"] == "failed"
        assert closed.wait(1)
        assert conn.fileno() == -1


def test_lost_connection_is_failed_on_next_heartbeat(agent, monkeypatch):
    with server(monkeypatch, disconnect=True) as (_, _, replied, closed), agent._job_awake():
        agent._acquire_keep_awake(321)
        assert replied.wait(1) and closed.wait(1)
        assert agent.identity("working")["keepAwake"] == "failed"


def test_read_timeout_is_failed_and_closes_socket(agent, monkeypatch):
    conn = Mock()
    conn.recv.side_effect = TimeoutError("timed out")
    monkeypatch.setenv("KROBI_KEEP_AWAKE_ADDR", "127.0.0.1:12345")
    monkeypatch.setattr(A.socket, "create_connection", Mock(return_value=conn))
    with agent._job_awake():
        agent._acquire_keep_awake(321)
        assert agent.identity("working")["keepAwake"] == "failed"
    conn.close.assert_called_once()


def test_absent_env_keeps_legacy_caffeinate_path(agent, monkeypatch):
    legacy = Mock()
    legacy.poll.return_value = None
    monkeypatch.setattr(agent, "_caffeinate", Mock(return_value=legacy))
    with agent._job_awake():
        agent._acquire_keep_awake(321)
        agent._caffeinate.assert_called_once_with(321)
        assert agent.identity("working")["keepAwake"] == "held"
    legacy.wait.assert_called_once_with(timeout=2)


def test_legacy_caffeinate_command_is_unchanged(agent, monkeypatch):
    monkeypatch.setattr(A.platform, "system", lambda: "Darwin")
    popen = Mock()
    monkeypatch.setattr(A.subprocess, "Popen", popen)
    agent._caffeinate(321)
    popen.assert_called_once_with(["caffeinate", "-i", "-w", "321"], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("finish", ["done", "failed", "cancel", "shutdown", "exception"])
def test_process_paths_acquire_once_and_release_on_all_exits(agent, monkeypatch, batch, finish):
    script = '''import json, time
print(json.dumps({"event":"phase","job":"j1","phase":"transcribing"}), flush=True)
'''
    if finish in ("cancel", "shutdown", "exception"):
        script += 'time.sleep(30)\n'
    else:
        script += f'print(json.dumps({{"event":{finish!r},"job":"j1"}}), flush=True)\n'
    argv = [sys.executable, "-c", script]
    stop = threading.Event()
    posts = []
    monkeypatch.setattr(agent, "_request", lambda method, url, body, **kw: posts.append(body) or {})
    monkeypatch.setattr(agent, "_caffeinate", Mock(side_effect=AssertionError("double acquisition")))

    def report(*args):
        heartbeat(agent, "/api/stems/agent/heartbeat").beat()
        if finish == "cancel":
            stop.set()
            raise A.StopRequested()
        if finish == "shutdown":
            agent._stopping.set()
        if finish == "exception":
            raise RuntimeError("callback failed")

    with server(monkeypatch) as (requests, _, _, closed):
        run = agent._run_process_many if batch else agent._run_process
        if finish == "exception":
            with pytest.raises(RuntimeError, match="callback failed"):
                run(argv, report, stop)
        else:
            run(argv, report, stop)
        assert closed.wait(1)
        assert len(requests) == 1
        assert 0 < requests[0]["pid"] <= 0xffffffff
    assert posts[0]["keepAwake"] == posts[0]["agent"]["keepAwake"] == "held"
    assert agent.identity()["keepAwake"] == "none"


@pytest.mark.parametrize("stems", [False, True])
def test_full_job_keeps_socket_through_upload_and_next_job_connects_fresh(agent, monkeypatch, stems):
    script = '''import json, sys
from pathlib import Path
args = sys.argv[1:]
out = Path(args[args.index("--out-dir") + 1])
out.mkdir(parents=True, exist_ok=True)
lrc = out / "lyrics.lrc"
lrc.write_text("[00:01.00]hello")
print(json.dumps({"event":"phase","phase":"transcribing"}), flush=True)
print(json.dumps({"event":"done","lrc":str(lrc)}), flush=True)
'''
    agent.job_command = agent.stems_command = [sys.executable, "-c", script]
    posts = []
    uploads = []
    monkeypatch.setattr(agent, "_request", lambda method, url, body, **kw: posts.append(body) or {})
    monkeypatch.setattr(agent, "_download", lambda path, target: target.write_bytes(b"audio"))

    def upload(*args, **kwargs):
        assert agent.identity("working")["keepAwake"] == "held"
        assert agent._awake_socket.fileno() >= 0
        uploads.append(True)

    monkeypatch.setattr(agent, "_post_result", upload)
    monkeypatch.setattr(agent, "_post_stems", upload)
    sockets = []
    for _ in range(2):
        with server(monkeypatch) as (requests, conn, _, closed):
            if stems:
                agent._process_stems({"id": "j1", "file": "song.mp3", "mediaPath": "/audio"})
            else:
                agent._process("lease", {"id": "j1", "file": "song.mp3", "mediaPath": "/audio"})
            assert closed.wait(1)
            assert len(requests) == 1
            sockets.append(conn)
        assert agent.identity()["keepAwake"] == "none"
    assert sockets[0] is not sockets[1]
    assert len(uploads) == 2
    assert all(body["keepAwake"] == body["agent"]["keepAwake"] for body in posts)
    assert {body["keepAwake"] for body in posts} == {"failed", "held"}


def test_eof_before_reply_reports_failed(agent, monkeypatch):
    with server(monkeypatch, reply=b"", disconnect=True) as (_, conn, _, _):
        with agent._job_awake():
            agent._acquire_keep_awake(321)
            assert agent.identity("working")["keepAwake"] == "failed"
        assert conn.fileno() == -1
