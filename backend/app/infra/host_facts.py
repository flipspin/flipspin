"""Best-effort host facts: bounded probes, 60 second cache, live memory."""
import os
import platform
import re
import socket
import subprocess
import time
from collections.abc import Callable
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

TTL_SECONDS = 60
STARTED_AT = datetime.now(UTC)


class HostOS(BaseModel):
    name: str | None
    version: str | None


class HostCPU(BaseModel):
    model: str | None
    cores: int | None


class HostMemory(BaseModel):
    total: int | None
    used: int | None


class HostFacts(BaseModel):
    lastBackupAt: datetime | None = None
    lastBackupReason: str | None = None
    hostname: str | None
    os: HostOS | None
    kernel: str | None
    arch: str | None
    isolation: Literal["lxc", "docker", "vm", "none"] | None
    hypervisor: Literal["proxmox"] | None
    cpu: HostCPU | None
    memory: HostMemory | None
    python: str | None
    bootedAt: datetime | None
    startedAt: datetime | None
    engine: Literal["local", "agent"] | None


def attempt[T](read: Callable[[], T]) -> T | None:
    try:
        return read()
    except Exception:
        return None


def read_text(path: str) -> str:
    return Path(path).read_text()


def command(*args: str) -> str:
    return subprocess.check_output(args, timeout=2, text=True, stderr=subprocess.DEVNULL).strip()


def sysctl(key: str) -> str:
    return command("sysctl", "-n", key)


def os_info() -> HostOS:
    system = platform.system()
    if system == "Linux":
        values = dict(line.split("=", 1) for line in read_text("/etc/os-release").splitlines() if "=" in line)
        return HostOS(name=values.get("NAME", "").strip('"') or None,
                      version=values.get("VERSION_ID", "").strip('"') or None)
    return HostOS(name="macOS" if system == "Darwin" else system or None,
                  version=(platform.mac_ver()[0] if system == "Darwin" else platform.release()) or None)


def cpu_model() -> str | None:
    if platform.system() == "Darwin":
        return sysctl("machdep.cpu.brand_string") or None
    if platform.system() == "Linux":
        for line in read_text("/proc/cpuinfo").splitlines():
            key, _, value = line.partition(":")
            if key.strip() in ("model name", "Hardware") and value.strip():
                return value.strip()
        return None
    return platform.processor() or None


def isolation() -> str | None:
    system = platform.system()
    if system == "Darwin":
        return "none" if sysctl("kern.hv_vmm_present") == "0" else "vm"
    if system != "Linux":
        return None
    try:
        detected = command("systemd-detect-virt")
        return detected if detected in ("docker", "lxc", "none") else "vm" if detected else None
    except subprocess.CalledProcessError as error:
        if error.returncode == 1 and (error.output or "").strip() == "none":
            return "none"
    except (OSError, subprocess.TimeoutExpired):
        pass
    if Path("/.dockerenv").exists():
        return "docker"
    env = attempt(lambda: read_text("/proc/1/environ")) or ""
    match = re.search(r"(?:^|\x00)container=([^\x00]+)", env)
    detected = match[1] if match else attempt(lambda: read_text("/run/systemd/container").strip())
    return detected if detected in ("docker", "lxc") else "vm" if detected else None


def booted_at() -> datetime:
    if platform.system() == "Darwin":
        match = re.search(r"sec\s*=\s*(\d+)", sysctl("kern.boottime"))
        if not match:
            raise ValueError("No boot time")
        timestamp = int(match[1])
    elif platform.system() == "Linux" and attempt(isolation) in ("docker", "lxc"):
        # stat's comm may contain spaces and parentheses; fields after its last
        # closing parenthesis begin at field 3. starttime is field 22, in ticks.
        stat = read_text("/proc/1/stat").rsplit(")", 1)[1].split()
        ticks = int(stat[19])
        boot = next(int(line.split()[1]) for line in read_text("/proc/stat").splitlines()
                    if line.startswith("btime "))
        timestamp = boot + ticks / os.sysconf("SC_CLK_TCK")
    else:
        timestamp = time.time() - float(read_text("/proc/uptime").split()[0])
    return datetime.fromtimestamp(timestamp, UTC)


def memory() -> HostMemory:
    if platform.system() == "Darwin":
        total = attempt(lambda: int(sysctl("hw.memsize")))

        def used() -> int:
            stats = command("vm_stat")
            page_size = int(re.search(r"page size of (\d+) bytes", stats)[1])
            pages = {key.strip(): int(value.strip().rstrip("."))
                     for key, value in (line.split(":", 1) for line in stats.splitlines()[1:] if ":" in line)}
            # Free, inactive and speculative pages are reclaimable on macOS.
            available = sum(pages[key] for key in ("Pages free", "Pages inactive", "Pages speculative")) * page_size
            if total is None:
                raise ValueError("No total memory")
            return max(0, min(total, total - available))

        return HostMemory(total=total, used=attempt(used))
    limit = attempt(lambda: read_text("/sys/fs/cgroup/memory.max").strip())
    if limit is not None and limit != "max":
        total = attempt(lambda: int(limit))
        if total is not None and total > 0:
            return HostMemory(total=total, used=attempt(lambda: int(read_text("/sys/fs/cgroup/memory.current"))))
    values = dict(line.split(":", 1) for line in read_text("/proc/meminfo").splitlines() if ":" in line)
    total = attempt(lambda: int(values["MemTotal"].split()[0]) * 1024)
    available = attempt(lambda: int(values["MemAvailable"].split()[0]) * 1024)
    return HostMemory(total=total, used=max(0, total - available) if total is not None and available is not None else None)


@lru_cache(maxsize=1)
def static_facts(_window: int) -> dict:
    kernel = attempt(platform.release)
    return {
        "hostname": attempt(socket.gethostname), "os": attempt(os_info), "kernel": kernel,
        "arch": attempt(platform.machine), "isolation": attempt(isolation),
        "hypervisor": "proxmox" if kernel and kernel.endswith("-pve") else None,
        "cpu": HostCPU(model=attempt(cpu_model), cores=attempt(os.cpu_count)),
        "python": attempt(platform.python_version), "bootedAt": attempt(booted_at), "startedAt": STARTED_AT,
    }


def snapshot(engine: Callable[[], str]) -> HostFacts:
    return HostFacts(**static_facts(int(time.monotonic() // TTL_SECONDS)), memory=attempt(memory), engine=attempt(engine))
