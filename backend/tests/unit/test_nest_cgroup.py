"""Resource isolation is checked without ever touching the host cgroup mount."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.infra import nest_cgroup as cg


@pytest.fixture
def delegated(tmp_path, monkeypatch):
    root = tmp_path / "cgroup"
    unit = root / "system.slice" / "krobi-backend.service"
    unit.mkdir(parents=True)
    membership = tmp_path / "membership"
    membership.write_text("0::/system.slice/krobi-backend.service\n")
    (unit / "cgroup.controllers").write_text("cpu memory pids")
    (unit / "cgroup.procs").write_text(str(os.getpid()))
    (unit / "cgroup.subtree_control").touch()
    monkeypatch.setattr(cg, "CGROUP_ROOT", root)
    monkeypatch.setattr(cg, "SELF_CGROUP", membership)
    monkeypatch.setattr(cg.platform, "system", lambda: "Linux")
    monkeypatch.setattr(cg, "machine_facts", lambda: {"memoryBytes": 16 << 30})
    # Simulate only kernel-created control files, never a real cgroup.
    for name in ("krobi-serving", "krobi-nest-engine"):
        leaf = unit / name
        leaf.mkdir()
        (leaf / "cgroup.procs").touch()
        if name == "krobi-nest-engine":
            for file in ("cpu.weight", "cpu.max", "cpu.idle", "memory.max", "cgroup.kill", "cgroup.freeze"):
                (leaf / file).touch()
    return unit, membership


def test_system_service_delegation_uses_sibling_serving_and_engine_leaves(delegated):
    root, _ = delegated
    scope = cg.probe_cgroup()
    assert scope.path == root / "krobi-nest-engine"
    assert (root / "krobi-serving/cgroup.procs").read_text() == str(os.getpid())
    assert (root / "cgroup.subtree_control").read_text() == "+cpu +memory"
    assert (scope.path / "cpu.weight").read_text() == "1"
    assert (scope.path / "cpu.max").read_text() == "50000 100000"
    assert (scope.path / "cpu.idle").read_text() == "1"
    assert int((scope.path / "memory.max").read_text()) == 8 << 30
    scope.kill()
    assert (scope.path / "cgroup.kill").read_text() == "1"


def test_repeated_probe_from_serving_leaf_uses_original_delegation(delegated):
    root, membership = delegated
    assert cg.probe_cgroup()
    membership.write_text("0::/system.slice/krobi-backend.service/krobi-serving")
    (root / "cgroup.procs").write_text("")
    assert cg.probe_cgroup().path == root / "krobi-nest-engine"


@pytest.mark.parametrize("failure", ["non-linux", "v1", "no-cpu", "unrelated-process", "read-only", "no-memory"])
def test_probe_fails_closed(delegated, monkeypatch, failure):
    root, membership = delegated
    if failure == "non-linux":
        monkeypatch.setattr(cg.platform, "system", lambda: "Darwin")
    elif failure == "v1":
        membership.write_text("1:cpu:/unit")
    elif failure == "no-cpu":
        (root / "cgroup.controllers").write_text("memory")
    elif failure == "unrelated-process":
        (root / "cgroup.procs").write_text(f"{os.getpid()}\n123456")
    elif failure == "read-only":
        write = Path.write_text

        def deny(path, *args, **kwargs):
            if path.name == "cpu.weight":
                raise PermissionError("read-only mount")
            return write(path, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", deny)
    else:
        monkeypatch.setattr(cg, "machine_facts", lambda: {"memoryBytes": 0})
    assert cg.probe_cgroup() is None


def test_container_namespace_root_works_when_delegated(delegated, monkeypatch):
    unit, membership = delegated
    monkeypatch.setattr(cg, "CGROUP_ROOT", unit)
    membership.write_text("0::/")
    assert cg.probe_cgroup().path == unit / "krobi-nest-engine"


def test_launcher_joins_before_exec_and_never_executes_if_join_fails(tmp_path):
    scope = cg.CgroupScope(tmp_path / "limited")
    scope.path.mkdir()
    marker = tmp_path / "executed"
    code = f"from pathlib import Path; Path({str(marker)!r}).write_text('yes')"
    proc = scope.launch(Path(sys.executable), [sys.executable, "-c", code], stdout=subprocess.PIPE)
    assert proc.wait(timeout=5) == 0
    assert (scope.path / "cgroup.procs").read_text() == str(proc.pid)
    assert marker.read_text() == "yes"
    marker.unlink()
    blocked = cg.CgroupScope(tmp_path / "missing")
    proc = blocked.launch(Path(sys.executable), [sys.executable, "-c", code], stderr=subprocess.PIPE)
    assert proc.wait(timeout=5) != 0
    assert not marker.exists()
    proc.stderr.close()


def test_cpu_quota_is_configurable_and_must_read_back(delegated, monkeypatch):
    scope = cg.probe_cgroup(25)
    assert (scope.path / 'cpu.max').read_text() == '25000 100000'
    read = Path.read_text
    monkeypatch.setattr(Path, 'read_text', lambda path, *a, **kw: 'max 100000' if path.name == 'cpu.max' else read(path, *a, **kw))
    assert cg.probe_cgroup() is None


def test_cgroup_pause_freezes_all_descendants(delegated):
    scope = cg.probe_cgroup()
    scope.set_paused(None, True)
    assert (scope.path / 'cgroup.freeze').read_text() == '1'
    scope.set_paused(None, False)
    assert (scope.path / 'cgroup.freeze').read_text() == '0'


def test_limit_probe_uses_duty_cycle_only_when_cgroup_is_unavailable(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock
    monkeypatch.setattr(cg, 'probe_cgroup', lambda cpu: None)
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr(cg.subprocess, 'run', run)
    scope = cg.probe_limits(25)
    assert isinstance(scope, cg.DutyCycleScope) and scope.cpu_percent == 25
    assert 'os.nice(10)' in run.call_args.args[0][2]
    run.return_value.returncode = 1
    assert cg.probe_limits() is None


def test_duty_cycle_supervises_and_kills_even_a_stopped_engine(tmp_path, monkeypatch):
    import time
    monkeypatch.setattr(cg.os, 'cpu_count', lambda: 1)
    marker = tmp_path / 'pid'
    scope = cg.DutyCycleScope(50)
    # No engines: this child just reports its identity and sleeps.
    code = f'import os,time; from pathlib import Path; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(30)'
    proc = scope.launch(Path(sys.executable), [sys.executable, '-c', code],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        deadline, pid = time.monotonic() + 10, None
        while proc.poll() is None and time.monotonic() < deadline:
            try:
                pid = int(marker.read_text())
                break
            except (FileNotFoundError, ValueError):
                # The duty cycle can stop between creating and writing a file.
                pass
            time.sleep(.01)
        assert pid is not None, proc.stderr.read() if proc.poll() is not None else 'engine did not start'
        scope.set_paused(proc, True)
        time.sleep(.15)
        scope.kill()
        assert proc.poll() is not None
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        scope.kill()
        proc.stdout.close(); proc.stderr.close()


def test_duty_cycle_bounds_real_cpu_work_to_half_a_core(monkeypatch):
    import json
    monkeypatch.setattr(cg.os, 'cpu_count', lambda: 1)
    scope = cg.DutyCycleScope(50)
    code = '''import json,time
start, cpu = time.monotonic(), time.process_time()
while time.process_time() - cpu < .2:
    pass
print(json.dumps({'cpu': time.process_time() - cpu, 'wall': time.monotonic() - start}))
'''
    proc = scope.launch(Path(sys.executable), [sys.executable, '-c', code],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=10)
        assert proc.returncode == 0, stderr
        measurement = json.loads(stdout)
        # Allow one 100ms scheduling period at the measurement boundaries.
        assert measurement['wall'] >= measurement['cpu'] * 2 - .1
    finally:
        scope.kill()
