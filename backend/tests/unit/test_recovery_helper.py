"""Exercise the shipped helper's argv and stdin forwarding without Docker."""
import os
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize("stdin", [False, True])
def test_helper_runs_as_container_user_and_forwards_recovery(tmp_path, stdin):
    install = tmp_path / "install"
    install.mkdir()
    (install / "compose.yml").write_text("services: {}\n")
    (install / ".env").write_text("# Managed by krobi installer\nKROBI_PORT='8000'\n")
    binary = tmp_path / "bin"
    binary.mkdir()
    (binary / "id").write_text("#!/bin/sh\nprintf '0\\n'\n")
    (binary / "docker").write_text('#!/bin/sh\nprintf "%s\\n" "$@" >"$CAPTURE_ARGS"\ncat >/dev/null\n')
    for command in binary.iterdir():
        command.chmod(0o755)
    script = tmp_path / "krobi"
    script.write_text((Path(__file__).resolve().parents[3] / "deploy/krobi").read_text().replace("/opt/krobi", str(install)))
    args = ["sh", str(script), "reset-password", "ana"] + (["--password-stdin"] if stdin else [])
    capture = tmp_path / "args"
    result = subprocess.run(args, input="private-input-password\n", text=True, capture_output=True,
                            env={**os.environ, "PATH": f"{binary}:{os.environ['PATH']}", "CAPTURE_ARGS": str(capture)},
                            timeout=10)
    assert result.returncode == 0, result.stderr
    forwarded = capture.read_text().splitlines()
    tail = ["exec"] + (["-T"] if stdin else []) + ["--user", "krobi", "krobi", "python", "-m", "app", "reset-password", "ana"]
    if stdin:
        tail.append("--password-stdin")
    assert forwarded[-len(tail):] == tail
    assert "private-input-password" not in result.stdout + result.stderr + capture.read_text()
