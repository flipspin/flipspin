"""Model ownership for three add-ons sharing one helper environment.

The manifest records intent; files alone never re-enable a removed add-on.
Legacy caches without a manifest are adopted on the first model operation.
"""
from __future__ import annotations

import json
import os
import tempfile
from importlib import metadata
from pathlib import Path

REQUIRES = {"lyrics": ("aligner", "demucs"), "stems": ("demucs", "beats"), "analysis": ("tempocnn",)}


def analysis_package_size() -> int:
    """Analysis-only runtime files; base/engine dependencies stay on the engine card."""
    try:
        # ONNX Runtime requires packaging; tolerate an incomplete installation.
        from packaging.requirements import Requirement
    except ImportError:
        Requirement = None

    def packages(roots):
        pending = list(roots)
        visited = set()
        found = {}
        while pending:
            name, extras = pending.pop()
            key = (name.lower().replace("_", "-"), frozenset(extras))
            if key in visited:
                continue
            visited.add(key)
            try:
                package = metadata.distribution(key[0])
            except metadata.PackageNotFoundError:
                continue
            found[key[0]] = package
            if Requirement is not None:
                for value in package.requires or ():
                    requirement = Requirement(value)
                    if requirement.marker is None or any(
                        requirement.marker.evaluate({"extra": extra}) for extra in ("", *extras)
                    ):
                        pending.append((requirement.name, requirement.extras))
        return found

    analysis = packages((("onnxruntime", ()), ("krobi-keyfinder", ())))
    if not analysis:
        return 0
    engine = packages((("krobi-helper", ("engine",)), ("numpy", ())))
    # Enumerate only Analysis-exclusive files: walking torch's RECORD can exceed
    # the desktop's check timeout, and none of those files belongs to this size.
    files = {Path(package.locate_file(file)).resolve()
             for name, package in analysis.items() if name not in engine
             for file in package.files or ()}
    return sum(file.stat().st_size for file in files if file.is_file())


def models_home() -> Path:
    explicit = os.environ.get("TORCH_HOME")
    return Path(explicit).parent if explicit else Path(os.environ.get("KROBI_MODELS_DIR") or Path.home() / "Krobi/models")


def model_paths() -> dict[str, Path]:
    from .acceleration import detect

    checkpoints = Path(os.environ.get("TORCH_HOME") or models_home() / "torch") / "hub/checkpoints"
    demucs = (Path.home() / ".cache/demucs-mlx/htdemucs.safetensors"
              if detect(lightweight=True)["accel"] == "mlx" else checkpoints / "955717e8-8726e21a.th")
    return {"aligner": checkpoints / "model.pt", "demucs": demucs,
            "beats": checkpoints / "beat_this-final0.ckpt",
            "tempocnn": models_home() / "tempocnn/deeptemp-k16-3.onnx"}


def selections(paths: dict[str, Path] | None = None) -> dict[str, bool]:
    paths = paths or model_paths()
    manifest = models_home() / "addons.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())
        return {name: data.get(name) is True for name in REQUIRES}
    return {name: all(paths[model].is_file() for model in models) for name, models in REQUIRES.items()}


def save_selections(selected: dict) -> None:
    home = models_home()
    home.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=home, delete=False) as stream:
        path = Path(stream.name)
        existing = home / "addons.json"
        data = json.loads(existing.read_text()) if existing.exists() else selections()
        data.update(selected)
        json.dump(data, stream)
    path.replace(home / "addons.json")


def status() -> dict:
    paths = model_paths()
    selected = selections(paths)
    # Packages can remain after model removal; always exclude them from the engine.
    analysis_bytes = analysis_package_size()
    shared = {model for models in REQUIRES.values() for model in models
              if sum(model in required for required in REQUIRES.values()) > 1}
    sizes = {model: path.stat().st_size if path.is_file() else None for model, path in paths.items()}
    result = {}
    for name, models in REQUIRES.items():
        own_bytes = sum(sizes[model] or 0 for model in models if model not in shared)
        if name == "analysis":
            own_bytes += analysis_bytes
        result[name] = {"installed": selected[name],
                        "ready": selected[name] and all(sizes[model] is not None for model in models),
                        "sizeBytes": own_bytes if selected[name] else None}
        shared_models = shared.intersection(models)
        if shared_models:
            result[name]["sharedBytes"] = (sum(sizes[model] for model in shared_models)
                                           if all(sizes[model] is not None for model in shared_models) else None)
        if name == "analysis":
            result[name]["runtimeBytes"] = analysis_bytes
    return result


def remove(name: str) -> None:
    paths = model_paths()
    selected = selections(paths)
    selected[name] = False
    # Persist intent first: interrupted removal can be retried safely.
    save_selections(selected)
    retained = {model for addon, models in REQUIRES.items() if selected[addon] for model in models}
    for model in REQUIRES[name]:
        if model not in retained:
            paths[model].unlink(missing_ok=True)
            if model == "tempocnn":
                paths[model].with_suffix(".NOTICE.txt").unlink(missing_ok=True)


