"""Delegated cgroup v2 isolation, shared by systemd services and containers.

The launcher joins the limited child *before* execing the engine. No preexec_fn
is used in the multithreaded backend, and a failed join never runs the engine.
"""
from __future__ import annotations

import os
import platform
import signal
import select
import subprocess
from dataclasses import dataclass
from pathlib import Path

from app.infra.machine import machine_facts

CGROUP_ROOT = Path("/sys/fs/cgroup")
SELF_CGROUP = Path("/proc/self/cgroup")
LAUNCHER = """import os, pathlib, sys
try:
    pathlib.Path(sys.argv[1], 'cgroup.procs').write_text(str(os.getpid()))
except OSError:
    sys.exit(78)
os.nice(10)
os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
"""


class CgroupUnavailable(RuntimeError):
    """The child could not enter its limited cgroup; no engine was executed."""


@dataclass
class CgroupScope:
    path: Path

    mode = 'cgroup'

    def set_paused(self, proc, paused: bool) -> None:
        (self.path / 'cgroup.freeze').write_text('1' if paused else '0')

    def launch(self, python: Path, argv: list[str], **kwargs) -> subprocess.Popen:
        return subprocess.Popen([str(python), "-c", LAUNCHER, str(self.path), *argv], **kwargs)

    def kill(self) -> None:
        # Kills descendants even if an engine subprocess has made a new session.
        try:
            (self.path / "cgroup.kill").write_text("1")
        except OSError:
            pass  # The runner also kills/waits for the engine's process group.


def probe_cgroup(cpu_percent: int = 50) -> CgroupScope | None:
    """Apply and read back limits without launching an engine or requiring root.

    Delegation must be provisioned by the administrator. Operations stay below
    the current cgroup (or the dedicated ``krobi-serving`` leaf after the first probe).
    A normal Docker read-only cgroup mount therefore fails closed.
    """
    if platform.system() != "Linux":
        return None
    try:
        relative = next(row[3:] for row in SELF_CGROUP.read_text().splitlines() if row.startswith("0::"))
        current = CGROUP_ROOT / relative.lstrip("/")
        if not current.is_relative_to(CGROUP_ROOT) or ".." in current.parts:
            return None
        root = current.parent if current.name == "krobi-serving" else current
        controllers = (root / "cgroup.controllers").read_text().split()
        if not {"cpu", "memory"} <= set(controllers):
            return None
        # Leave the delegation root empty (cgroup v2's no-internal-process rule).
        # Do not move unrelated processes or try to manage an ancestor's subtree.
        pids = set((root / "cgroup.procs").read_text().split())
        if pids - {str(os.getpid())}:
            return None
        serving = root / "krobi-serving"
        serving.mkdir(exist_ok=True)
        if pids:
            (serving / "cgroup.procs").write_text(str(os.getpid()))
        (root / "cgroup.subtree_control").write_text("+cpu +memory")
        child = root / "krobi-nest-engine"
        child.mkdir(exist_ok=True)
        memory = machine_facts()["memoryBytes"] // 2
        if memory <= 0:
            return None
        (child / "cpu.weight").write_text("1")
        quota = f'{cpu_percent * 1000} 100000'
        (child / 'cpu.max').write_text(quota)
        (child / 'cgroup.freeze').write_text('0')
        if (child / "cpu.idle").exists():
            (child / "cpu.idle").write_text("1")
        (child / "memory.max").write_text(str(memory))
        if (int((child / "cpu.weight").read_text()) != 1
                or (child / 'cpu.max').read_text().strip() != quota
                or int((child / "memory.max").read_text()) != memory):
            return None
        return CgroupScope(child)
    except (OSError, ValueError, StopIteration):
        return None


# The supervisor stays runnable while its engine's entire process group is
# stopped. Duty is divided by the host's logical cores, bounding aggregate CPU
# even for engines that ignore thread-count environment variables. The first
# exec is stopped too: there is no uncapped engine startup interval.
DUTY_LAUNCHER = r'''import os, signal, subprocess, sys, time
child = None
paused = False
parent = os.getppid()
def send(sig):
    try:
        os.killpg(child.pid, sig)
    except (ProcessLookupError, PermissionError):
        # Darwin can report EPERM for an already-exited process group.
        # A permission failure on a live engine must still fail closed.
        if child.poll() is None:
            raise
def kill(*_):
    if child is not None:
        send(signal.SIGKILL)
        child.wait()
    sys.exit(0)
def pause(*_):
    global paused
    paused = True
def resume(*_):
    global paused
    paused = False
signal.signal(signal.SIGTERM, kill)
signal.signal(signal.SIGINT, kill)
signal.signal(signal.SIGUSR1, pause)
signal.signal(signal.SIGUSR2, resume)
code = 'import os,signal,sys; os.nice(10); os.kill(os.getpid(),signal.SIGSTOP); os.execvpe(sys.argv[1],sys.argv[1:],os.environ)'
child = subprocess.Popen([sys.executable, '-c', code, *sys.argv[4:]], start_new_session=True)
_, status = os.waitpid(child.pid, os.WUNTRACED)
if not os.WIFSTOPPED(status):
    sys.exit(78)
send(signal.SIGSTOP)
os.write(int(sys.argv[3]), b'1')
os.close(int(sys.argv[3]))
period = 0.1
duty = min(1., float(sys.argv[1]) / (100 * int(sys.argv[2])))
try:
    while child.poll() is None:
        if os.getppid() != parent:
            kill()
        start = time.monotonic()
        if not paused:
            send(signal.SIGCONT)
            time.sleep(period * duty)
        send(signal.SIGSTOP)
        time.sleep(max(0., period - (time.monotonic() - start)))
    sys.exit(child.returncode)
finally:
    send(signal.SIGKILL)
    if child.poll() is None:
        child.wait()
'''


@dataclass
class DutyCycleScope:
    cpu_percent: int = 50
    process: subprocess.Popen | None = None

    mode = 'duty-cycle'

    def launch(self, python: Path, argv: list[str], **kwargs):
        reader, writer = os.pipe()
        try:
            self.process = subprocess.Popen([str(python), '-c', DUTY_LAUNCHER, str(self.cpu_percent),
                                            str(os.cpu_count() or 1), str(writer), *argv],
                                            pass_fds=(writer,), **kwargs)
            os.close(writer)
            writer = None
            if not select.select([reader], [], [], 5)[0] or os.read(reader, 1) != b'1':
                self.kill()
                raise CgroupUnavailable('duty-cycle supervisor could not stop its engine')
            return self.process
        finally:
            os.close(reader)
            if writer is not None:
                os.close(writer)

    def set_paused(self, proc, paused: bool) -> None:
        if proc.poll() is None:
            proc.send_signal(signal.SIGUSR1 if paused else signal.SIGUSR2)

    def kill(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)


def probe_limits(cpu_percent: int = 50):
    if scope := probe_cgroup(cpu_percent):
        return scope
    return probe_duty_cycle(cpu_percent)


def probe_duty_cycle(cpu_percent: int = 50):
    if os.name != 'posix' or not all(hasattr(signal, name) for name in ('SIGSTOP', 'SIGCONT', 'SIGUSR1', 'SIGUSR2')):
        return None
    try:
        # Check priority permission without changing the server's priority.
        import sys
        check = subprocess.run([sys.executable, '-c', 'import os,signal; os.nice(10); os.kill(os.getpid(),0)'],
                               timeout=5, capture_output=True, check=False)
        return DutyCycleScope(cpu_percent) if check.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None
