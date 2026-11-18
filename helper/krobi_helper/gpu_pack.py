"""Explicit CUDA torch layer. Probes and adoption never import ML or download.

ONNX models have no approved GPU providers yet; the only supported ORT build
is onnxruntime. A future GPU model must extend this policy after parity checks.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import platform
import subprocess
import sys
from importlib import metadata
from pathlib import Path

from .addons import models_home, save_selections

TORCH_VERSION = "2.11.0"
PACK_VERSION = "cu130-1"


def runtime_size() -> int:
    """Measure the CUDA runtime once, at adoption or successful installation."""
    files = set()
    for package in metadata.distributions():
        name = (package.metadata.get("Name") or "").lower().replace("_", "-")
        if name in {"torch", "torchaudio", "triton"} or name.startswith("nvidia-"):
            files.update(Path(package.locate_file(file)) for file in package.files or ())
    return sum(file.stat().st_size for file in files if file.is_file())


def torch_build() -> dict:
    try:
        spec = importlib.util.find_spec("torch")
        if not spec or not spec.origin:
            return {}
        root = Path(spec.origin).parent
        version = root / "version.py"
        text = version.read_text()
        import re

        cuda = re.search(r"^cuda\s*(?::[^=]+)?=\s*['\"]([^'\"]+)", text, re.MULTILINE)
        libraries = [*root.glob("lib/*torch_cpu*"), *root.glob("lib/*torch_cuda*")]
        return {"version": metadata.version("torch"), "cuda": cuda[1] if cuda else None,
                "digest": hashlib.sha256(version.read_bytes()).hexdigest(),
                "files": ["torch/version.py", "torch/__init__.py", *[str(file.relative_to(root.parent)) for file in libraries]],
                "present": (root / "__init__.py").is_file() and bool(libraries)}
    except (ImportError, ValueError, OSError, metadata.PackageNotFoundError):
        return {}


def nvidia() -> dict:
    """Driver probe works even with CPU torch. No dependency on CUDA libraries."""
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3, check=True,
        ).stdout
        card, driver, capability = [part.strip() for part in output.splitlines()[0].split(",")]
        reason = ("NVIDIA driver 580 or newer required" if int(driver.split(".")[0]) < 580 else
                  "CUDA 13 requires Turing or newer" if float(capability) < 7.5 else None)
        return {"card": card, "driver": driver, "available": reason is None, "reason": reason}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return {"card": None, "driver": None, "available": False, "reason": "No supported NVIDIA GPU detected"}


def status() -> dict:
    apple = platform.system() == "Darwin" and platform.machine().lower() == "arm64"
    build = torch_build()
    manifest = models_home() / "addons.json"
    data = json.loads(manifest.read_text()) if manifest.exists() else {}
    packs = data.get("packs", {})
    name = "mlx" if apple else "gpu-cuda"
    installed = bool(build.get("present") and (importlib.util.find_spec("mlx") if apple else build.get("cuda")))
    # Adopt a legacy build, preserving its exact version and all model choices.
    if name not in packs and installed:
        packs[name] = {**build, "version": build["version"], "release": PACK_VERSION, "adopted": True}
        if not apple:
            packs[name]["sizeBytes"] = runtime_size()
        save_selections({"packs": packs})
    record = packs.get(name, {})
    installed = installed and record.get("enabled", True)
    facts = {"card": None, "driver": None, "available": apple, "reason": None} if apple else nvidia()
    return {**facts, "installed": bool(installed), "ready": bool(installed and (apple or facts["available"]) and record.get("digest") == build.get("digest")), "included": apple,
            "sizeBytes": record.get("sizeBytes") if installed else None,
            "runtimeBytes": record.get("sizeBytes", 0) if installed and not apple else 0,
            "downloadBytes": 2_000_000_000 if platform.system() == "Windows" else 3_200_000_000,
            "pack": name, "version": record.get("version"), "digest": record.get("digest")}


def torch_backend() -> str:
    """Preserve adopted CUDA builds; a fresh base always resolves CPU wheels."""
    return "cu130" if status()["installed"] and platform.system() != "Darwin" else "cpu"


def change(uv: str, *, remove: bool = False) -> None:
    before = status()
    if before["included"]:
        raise ValueError("MLX is included with Lyrics and Stems")
    if not remove and not before["available"]:
        raise ValueError(before["reason"])
    backend = "cpu" if remove else "cu130"
    # Both distributions write the same files. Remove the unapproved GPU build
    # first, then repair CPU ORT if it existed, including partial old installs.
    try:
        metadata.distribution("onnxruntime-gpu")
    except metadata.PackageNotFoundError:
        pass
    else:
        subprocess.run([uv, "pip", "uninstall", "--python", sys.executable, "onnxruntime-gpu"], check=True, stdout=sys.stderr)
        subprocess.run([uv, "pip", "install", "--python", sys.executable,
                        "--reinstall-package", "onnxruntime", "onnxruntime>=1.18"], check=True, stdout=sys.stderr)
    subprocess.run([uv, "pip", "install", "--python", sys.executable, "--torch-backend", backend,
                    "--reinstall-package", "torch", "--reinstall-package", "torchaudio",
                    f"torch=={TORCH_VERSION}", f"torchaudio=={TORCH_VERSION}"], check=True, stdout=sys.stderr)
    build = torch_build()
    if not build.get("present") or bool(build.get("cuda")) == remove:
        raise RuntimeError("Torch build verification failed")
    if remove:
        # uv pip install leaves orphan dependencies behind. Reclaim this
        # layer's CUDA libraries after CPU torch is verified.
        orphaned = [package.metadata["Name"] for package in metadata.distributions()
                    if (package.metadata.get("Name") or "").lower().startswith("nvidia-")
                    or (package.metadata.get("Name") or "").lower() == "triton"]
        if orphaned:
            subprocess.run([uv, "pip", "uninstall", "--python", sys.executable, *orphaned],
                           check=True, stdout=sys.stderr)
    manifest = models_home() / "addons.json"
    data = json.loads(manifest.read_text()) if manifest.exists() else {}
    packs = data.get("packs", {})
    packs["gpu-cuda"] = {**build, "release": PACK_VERSION, "enabled": not remove, "adopted": False}
    if not remove:
        packs["gpu-cuda"]["sizeBytes"] = runtime_size()
    save_selections({"packs": packs})
