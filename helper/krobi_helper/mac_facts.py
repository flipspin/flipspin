"""Bounded, model-free probes for the worker's stable identity and hardware."""
from __future__ import annotations

import errno
import ipaddress
import os
import socket
import subprocess
import urllib.error
import urllib.parse
import uuid
from pathlib import Path
from .paths import state_path
from typing import Any, Dict


def tools_dir() -> Path:
    root = state_path("KROBI_TOOLS_DIR", "tools")
    helper, legacy = root / "helper", root / "lyrics"
    if legacy.is_dir() and not helper.exists():
        try:
            if os.name == "nt":
                subprocess.run(["cmd", "/c", "mklink", "/J", str(helper), str(legacy.resolve())],
                               check=True, capture_output=True)
            else:
                helper.symlink_to("lyrics", target_is_directory=True)
        except FileExistsError:
            pass
    return helper


def stable_id() -> str:
    if os.environ.get("KROBI_WORKER_ID"):
        return os.environ["KROBI_WORKER_ID"]
    path = tools_dir() / "worker-id"
    path.parent.mkdir(parents=True, exist_ok=True)
    # The agent's single-instance lock serialises creation. Exclusive open also
    # prevents another caller from replacing an existing identity.
    try:
        with path.open("x", encoding="utf-8") as out:
            out.write(str(uuid.uuid4()))
    except FileExistsError:
        pass
    identity = path.read_text(encoding="utf-8").strip()
    uuid.UUID(identity)  # a damaged identity must not silently become another Mac
    return identity


def command(*args: str) -> str:
    try:
        return subprocess.check_output(args, text=True, timeout=2, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def computer_name() -> str:
    return command("scutil", "--get", "ComputerName") or socket.gethostname() or "Mac"


def hardware() -> Dict[str, Any]:
    memory = command("sysctl", "-n", "hw.memsize")
    return {
        "chip": command("sysctl", "-n", "machdep.cpu.brand_string") or None,
        "memoryBytes": int(memory) if memory.isdigit() else None,
        "macos": command("sw_vers", "-productVersion") or None,
    }


def last_error(error: Exception, server: str) -> str:
    if isinstance(error, urllib.error.HTTPError) and error.code in (401, 403):
        return "token-rejected"
    cause = getattr(error, "reason", error)
    no_route = getattr(cause, "errno", None) == errno.EHOSTUNREACH or "no route to host" in str(cause).lower()
    if no_route:
        host = urllib.parse.urlsplit(server).hostname or ""
        try:
            # Resolve names too: a .local nest is as much LAN as its IPv4 address.
            addresses = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
            lan = any(ipaddress.ip_address(a[4][0]).is_private and not ipaddress.ip_address(a[4][0]).is_loopback
                      for a in addresses)
        except (OSError, ValueError):
            lan = host.endswith((".local", ".lan"))
        if lan:
            return "network-denied"
    return "nest-unreachable"
