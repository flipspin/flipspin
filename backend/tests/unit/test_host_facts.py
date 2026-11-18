import subprocess

import pytest

from app.infra import host_facts as facts


@pytest.fixture(autouse=True)
def uncached():
    facts.static_facts.cache_clear()
    yield
    facts.static_facts.cache_clear()


def linux(monkeypatch, files):
    monkeypatch.setattr(facts.platform, "system", lambda: "Linux")
    monkeypatch.setattr(facts, "read_text", lambda path: files[path])


def test_linux_facts_and_live_memory(monkeypatch):
    files = {"/etc/os-release": 'NAME="Debian GNU/Linux"\nVERSION_ID="12"',
             "/proc/cpuinfo": 'model name : Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz',
             "/proc/meminfo": 'MemTotal: 4096 kB\nMemAvailable: 1024 kB', "/proc/uptime": "123 321"}
    linux(monkeypatch, files)
    monkeypatch.setattr(facts.platform, "release", lambda: "7.0.14-12-pve")
    monkeypatch.setattr(facts, "command", lambda *_: "lxc")
    clock = [1000.0]
    monkeypatch.setattr(facts.time, "monotonic", lambda: clock[0])
    first = facts.snapshot(lambda: "agent")
    assert first.os.model_dump() == {"name": "Debian GNU/Linux", "version": "12"}
    assert first.hypervisor == "proxmox"
    assert first.isolation == "lxc"
    assert first.memory.model_dump() == {"total": 4096 * 1024, "used": 3072 * 1024}
    files["/proc/meminfo"] = 'MemTotal: 4096 kB\nMemAvailable: 2048 kB'
    monkeypatch.setattr(facts.platform, "release", lambda: "new")
    second = facts.snapshot(lambda: "local")
    assert second.kernel == first.kernel
    assert second.memory.used == 2048 * 1024
    assert second.engine == "local"
    assert second.startedAt == first.startedAt
    clock[0] += 61
    assert facts.snapshot(lambda: "local").kernel == "new"


def test_every_probe_can_fail(monkeypatch):
    def fail(*_):
        raise PermissionError("denied")
    for name in ("os_info", "cpu_model", "booted_at", "memory", "isolation"):
        monkeypatch.setattr(facts, name, fail)
    for module, name in ((facts.platform, "release"), (facts.platform, "machine"),
                         (facts.platform, "python_version"), (facts.socket, "gethostname"), (facts.os, "cpu_count")):
        monkeypatch.setattr(module, name, fail)
    body = facts.snapshot(fail)
    assert body.os is body.memory is body.bootedAt is body.engine is body.kernel is body.hostname is None
    assert body.cpu.model is body.cpu.cores is None


@pytest.mark.parametrize("source,expected", [("docker-file", "docker"), ("env", "lxc"), ("systemd-file", "docker"), ("missing", None)])
def test_isolation_fallbacks(monkeypatch, source, expected):
    files = {"/proc/1/environ": "PATH=/bin\x00container=lxc\x00"} if source == "env" else {}
    if source == "systemd-file":
        files["/run/systemd/container"] = "docker\n"
    linux(monkeypatch, files)
    def timeout(*_):
        raise subprocess.TimeoutExpired("systemd-detect-virt", 2)
    monkeypatch.setattr(facts, "command", timeout)
    monkeypatch.setattr(facts.Path, "exists", lambda _: source == "docker-file")
    assert facts.isolation() == expected


@pytest.mark.parametrize("detected,expected", [("lxc", "lxc"), ("docker", "docker"), ("kvm", "vm"), ("none", "none")])
def test_virtualization_detection(monkeypatch, detected, expected):
    linux(monkeypatch, {})
    def detect(*_):
        if detected == "none":
            raise subprocess.CalledProcessError(1, "systemd-detect-virt", output="none\n")
        return detected
    monkeypatch.setattr(facts, "command", detect)
    assert facts.isolation() == expected


def test_mac_facts(monkeypatch):
    monkeypatch.setattr(facts.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(facts.platform, "mac_ver", lambda: ("26.1", (), ""))
    values = {"hw.memsize": "16384", "machdep.cpu.brand_string": "Apple M1", "kern.hv_vmm_present": "0",
              "kern.boottime": "{ sec = 1700000000, usec = 0 }"}
    monkeypatch.setattr(facts, "sysctl", lambda key: values[key])
    monkeypatch.setattr(facts, "command", lambda *_: 'Mach Virtual Memory Statistics: (page size of 1024 bytes)\nPages free: 2.\nPages inactive: 3.\nPages speculative: 1.')
    assert facts.os_info().name == "macOS"
    assert facts.cpu_model() == "Apple M1"
    assert facts.isolation() == "none"
    assert facts.memory().model_dump() == {"total": 16384, "used": 10240}
    assert facts.booted_at().timestamp() == 1700000000


def test_commands_are_bounded(monkeypatch):
    def output(args, **kwargs):
        assert args == ("sysctl", "-n", "hw.memsize")
        assert kwargs["timeout"] == 2
        return " 123\n"
    monkeypatch.setattr(facts.subprocess, "check_output", output)
    assert facts.sysctl("hw.memsize") == "123"


@pytest.fixture
def container_files():
    return {
        "/sys/fs/cgroup/memory.max": "2147483648\n",
        "/sys/fs/cgroup/memory.current": "536870912\n",
        "/proc/meminfo": "MemTotal: 16777216 kB\nMemAvailable: 8388608 kB",
        "/proc/stat": "cpu 1 2 3\nbtime 1700000000\n",
        "/proc/1/stat": "1 (init (container)) S " + "0 " * 18 + "12345 0 0",
        "/proc/uptime": "86400 0",
    }


def test_container_memory_is_live_and_limited(monkeypatch, container_files):
    linux(monkeypatch, container_files)
    assert facts.memory().model_dump() == {"total": 2147483648, "used": 536870912}
    container_files["/sys/fs/cgroup/memory.current"] = "1073741824"
    assert facts.memory().used == 1073741824


@pytest.mark.parametrize("limit", ["max", "bad", "0"])
def test_unlimited_or_invalid_cgroup_uses_host_memory(monkeypatch, container_files, limit):
    container_files["/sys/fs/cgroup/memory.max"] = limit
    linux(monkeypatch, container_files)
    assert facts.memory().total == 16777216 * 1024


@pytest.mark.parametrize("isolated", ["docker", "lxc", "none", "vm"])
def test_container_boot_is_pid_one_start(monkeypatch, container_files, isolated):
    linux(monkeypatch, container_files)
    monkeypatch.setattr(facts, "isolation", lambda: isolated)
    monkeypatch.setattr(facts.os, "sysconf", lambda key: 100)
    monkeypatch.setattr(facts.time, "time", lambda: 1700086400)
    expected = 1700000123.45 if isolated in ("docker", "lxc") else 1700000000
    assert facts.booted_at().timestamp() == expected


def test_missing_container_memory_usage_is_unknown(monkeypatch, container_files):
    del container_files["/sys/fs/cgroup/memory.current"]
    linux(monkeypatch, container_files)
    assert facts.memory().model_dump() == {"total": 2147483648, "used": None}
