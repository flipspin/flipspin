"""Machine capabilities in one place; the status probe never imports ML libraries.

Runtime selection asks torch.cuda.is_available(). The fast probe checks the
same CUDA runtime's device count directly, plus torch's build metadata. This
avoids torch's cold import (and respects CUDA_VISIBLE_DEVICES).
"""
from __future__ import annotations

import ctypes
import ctypes.util
import importlib.util
import os
import platform
import re
from pathlib import Path
from typing import Any

from .mac_facts import hardware


def module_ok(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def supported() -> bool:
    system, machine = platform.system(), platform.machine().lower()
    return ((system == "Darwin" and machine == "arm64")
            or (system == "Linux" and machine in {"x86_64", "aarch64", "arm64"})
            or (system == "Windows" and machine in {"amd64", "x86_64"}))


def _fast_cuda() -> tuple[bool, str | None]:
    """Read build metadata, then call libcudart; no torch/MLX import or model."""
    spec = importlib.util.find_spec("torch") if module_ok("torch") else None
    if not spec or not spec.origin:
        return False, None
    root = Path(spec.origin).parent
    try:
        if not re.search(r"^cuda\s*(?::[^=]+)?=\s*['\"]", (root / "version.py").read_text(), re.MULTILINE):
            return False, None
    except OSError:
        return False, None
    candidates = [*root.glob("lib/*cudart*"), *root.parent.glob("nvidia/cuda_runtime/lib/*cudart*")]
    library = ctypes.util.find_library("cudart")
    if library:
        candidates.append(Path(library))
    for path in candidates:
        try:
            runtime = ctypes.CDLL(str(path))
            count = ctypes.c_int()
            if runtime.cudaGetDeviceCount(ctypes.byref(count)) == 0 and count.value > 0:
                # cudaDeviceProp begins with name[256]. A generously sized,
                # aligned buffer tolerates CUDA's versioned tail fields.
                props = (ctypes.c_longlong * 1024)()
                name = None
                if runtime.cudaGetDeviceProperties(ctypes.byref(props), 0) == 0:
                    name = ctypes.string_at(ctypes.addressof(props), 256).split(b"\0", 1)[0].decode("utf-8", "replace")
                return True, name
        except (OSError, AttributeError):
            continue
    return False, None


def detect(*, lightweight: bool = False) -> dict[str, Any]:
    forced = os.environ.get("KROBI_ACCEL")
    if forced and forced not in {"mlx", "cuda", "cpu"}:
        raise ValueError("KROBI_ACCEL must be mlx, cuda or cpu")
    apple = platform.system() == "Darwin" and platform.machine().lower() == "arm64"
    if forced == "mlx" and not apple:
        raise ValueError("MLX requires Apple Silicon")
    if forced == "cpu":
        return {"accel": "cpu", "gpu": None}
    if apple and forced != "cuda":
        return {"accel": "mlx", "gpu": hardware()["chip"]}
    if lightweight:
        cuda, gpu = _fast_cuda()
    elif module_ok("torch"):
        import torch

        cuda = torch.cuda.is_available()
        gpu = torch.cuda.get_device_name() if cuda else None
    else:
        cuda, gpu = False, None
    if forced == "cuda" and not cuda:
        raise RuntimeError("CUDA requested but unavailable")
    return {"accel": "cuda" if cuda else "cpu", "gpu": gpu}


def torch_device(*, lightweight: bool = False) -> str:
    accel = detect(lightweight=lightweight)["accel"]
    return "mps" if accel == "mlx" else accel


def _memory_bytes() -> int | None:
    if platform.system() == "Windows":
        class Memory(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                        *[(name, ctypes.c_ulonglong) for name in
                          ("total", "avail", "page", "avail_page", "virtual", "avail_virtual", "extended")]]
        status = Memory()
        status.length = ctypes.sizeof(status)
        return int(status.total) if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)) else None
    try:
        return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, AttributeError):
        return None


def machine_facts() -> dict[str, Any]:
    system = platform.system()
    if system == "Darwin":
        facts = hardware()
        facts["chip"] = facts.get("chip") or platform.processor() or platform.machine()
        facts["memoryBytes"] = facts.get("memoryBytes") or _memory_bytes()
    else:
        chip = platform.processor()
        if system == "Linux":
            try:
                match = re.search(r"^(?:model name|Hardware)\s*:\s*(.+)$", Path("/proc/cpuinfo").read_text(), re.MULTILINE)
                chip = match[1] if match else chip
            except OSError:
                pass
        facts = {"chip": chip or platform.machine(), "memoryBytes": _memory_bytes()}
    return {**facts, "os": {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}.get(system, system.lower())}


def capabilities(*, lightweight: bool = False) -> dict[str, Any]:
    facts = {**machine_facts(), **detect(lightweight=lightweight)}
    separator = module_ok("demucs_mlx" if facts["accel"] == "mlx" else "demucs")
    torch = module_ok("torch") and module_ok("torchaudio")
    audio = module_ok("soundfile") and module_ok("numpy")
    # Models are fetched lazily; advertise only jobs whose libraries are installed.
    from shutil import which

    audio = audio and bool(which("ffmpeg") or module_ok("imageio_ffmpeg"))
    jobs = []
    if supported() and audio:
        if torch and separator:
            jobs.append("align")
        if separator and (facts["accel"] == "mlx" or torch) and module_ok("mlx_whisper" if facts["accel"] == "mlx" else "whisper"):
            jobs.append("transcribe")
        if torch and separator and module_ok("beat_this"):
            jobs.append("stems")
    return {**facts, "jobs": jobs}
