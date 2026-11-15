"""Machine facts constrained by affinity and container resource limits."""
import os
import platform
from pathlib import Path


def _read(path: Path) -> str:
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def machine_facts(root: Path = Path("/sys/fs/cgroup")) -> dict:
    cores = os.cpu_count() or 1
    if hasattr(os, "sched_getaffinity"):
        try:
            cores = min(cores, len(os.sched_getaffinity(0)))
        except OSError:
            pass
    try:
        memory = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        memory = 0
    # A process can be in a nested cgroup. Every ancestor can constrain it.
    paths = [root]
    for row in _read(Path("/proc/self/cgroup")).splitlines():
        if row.startswith("0::"):
            child = root / row[3:].lstrip("/")
            if child.is_relative_to(root):
                paths.extend([child, *[p for p in child.parents if p != root and p.is_relative_to(root)]])
    quotas, memories = [], []
    for path in paths:
        cpu = _read(path / "cpu.max").split()
        if len(cpu) == 2 and cpu[0] != "max":
            try:
                quotas.append(int(cpu[0]) / int(cpu[1]))
            except (ValueError, ZeroDivisionError):
                pass
        mem = _read(path / "memory.max")
        if mem.isdigit() and int(mem) > 0:
            memories.append(int(mem))
    # cgroup v1 hosts (v2 is usual on current Docker and LXC).
    try:
        quota = int(_read(root / "cpu/cpu.cfs_quota_us"))
        period = int(_read(root / "cpu/cpu.cfs_period_us"))
        if quota > 0 and period > 0:
            quotas.append(quota / period)
    except ValueError:
        pass
    mem = _read(root / "memory/memory.limit_in_bytes")
    if mem.isdigit() and 0 < int(mem) < (1 << 60):
        memories.append(int(mem))
    cpu_limit = min(quotas) if quotas else None
    memory_limit = min(memories) if memories else None
    if cpu_limit is not None:
        cores = min(cores, max(1, int(cpu_limit)))
    if memory_limit is not None:
        memory = min(memory, memory_limit) if memory else memory_limit
    container = _read(Path("/run/systemd/container")) or os.getenv("container")
    if not container:
        container = "docker" if Path("/.dockerenv").exists() else None
    preset = "light" if cores <= 2 or memory < 2_000_000_000 else (
        "powerful" if cores >= 8 and memory >= 8_000_000_000 else "normal"
    )
    return {
        "cores": cores, "memoryBytes": memory, "arch": platform.machine(), "container": container,
        "cpuLimit": cpu_limit, "memoryLimitBytes": memory_limit, "suggestedPreset": preset,
        "capacityPresets": {
            "light": {"KROBI_MAX_CONCURRENT_DOWNLOADS": 1, "KROBI_MAX_CONCURRENT_JOBS": 1},
            "normal": {"KROBI_MAX_CONCURRENT_DOWNLOADS": 2, "KROBI_MAX_CONCURRENT_JOBS": 2},
        },
        # Positional legacy profiles remain on the wire for older clients.
        "presets": {"light": [1, 1, 1], "normal": [3, 2, 2], "powerful": [6, 3, max(1, cores - 1)]},
    }
