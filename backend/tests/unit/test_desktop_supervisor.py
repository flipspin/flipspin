"""Archive identity and the parent-lifetime pipe survive bundle replacement."""
import hashlib
import os
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

from app.infra import build_identity
from app.infra.desktop_supervisor import watch_desktop


def test_build_identity_is_captured_before_replacing_the_bundle(tmp_path, monkeypatch):
    executable = tmp_path / "krobi-backend"
    executable.write_bytes(b"old archive")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))
    running = runpy.run_path(str(Path(build_identity.__file__)))
    executable.write_bytes(b"new archive")
    assert running["BUILD_ID"] == hashlib.sha256(b"old archive").hexdigest()
    assert build_identity.executable_build_id(executable) != running["BUILD_ID"]


def test_closing_the_shell_pipe_requests_graceful_server_shutdown():
    reader, writer = os.pipe()
    server = SimpleNamespace(should_exit=False)
    with os.fdopen(reader) as stream:
        thread = watch_desktop(server, stream)
        assert not server.should_exit
        os.close(writer)
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert server.should_exit


def test_desktop_entrypoint_attaches_supervisor_and_preserves_bind(monkeypatch):
    import uvicorn

    from app import __main__ as entry
    from app.infra import desktop_supervisor

    seen = {}
    server = SimpleNamespace(run=lambda: seen.update(ran=True))

    def make_server(config):
        seen.update(host=config.host, port=config.port)
        return server

    monkeypatch.setenv("KROBI_SUPERVISOR", "desktop")
    monkeypatch.setattr(uvicorn, "Server", make_server)
    monkeypatch.setattr(desktop_supervisor, "watch_desktop", lambda owned, stream: seen.update(
        supervised=owned is server and stream is sys.stdin,
    ))
    entry.main(["--host", "127.0.0.1", "--port", "8765"])
    assert seen == {"host": "127.0.0.1", "port": 8765, "supervised": True, "ran": True}
