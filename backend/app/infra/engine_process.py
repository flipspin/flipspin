"""JSON-lines and process-group primitives for optional engines."""
import json
import os
import signal
import subprocess
from typing import Any


def _signal_process_tree(proc: subprocess.Popen, *, force: bool) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       capture_output=True, check=False)
    else:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL if force else signal.SIGTERM)


def _parse(line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        data = json.loads(line)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None
