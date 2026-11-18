"""Per-job device policy and one automatic CPU retry after accelerator failure."""
from __future__ import annotations

import gc
import os
from pathlib import Path

# Existing torch pipelines are approved. No ONNX model has passed the gate.
MODEL_ACCELERATORS = {"htdemucs": {"mlx", "cuda"}, "mms": {"mlx", "cuda"},
                      "beat_this": {"mlx", "cuda"}, "tempocnn": set()}


def failure_reason(error: Exception) -> str | None:
    if isinstance(error, NotImplementedError):
        return "driver"
    text = str(error).lower()
    if any(word in text for word in ("out of memory", "cuda_error_out_of_memory", "mps backend out of memory")):
        return "oom"
    if any(word in text for word in ("cuda", "cudnn", "cublas", "driver", "mps", "metal", "not implemented")):
        return "driver"
    return None


def run(operation, *, models: tuple[str, ...], manifest: Path | None = None) -> dict:
    from .acceleration import detect
    from .gpu_pack import torch_build

    previous = os.environ.get("KROBI_ACCEL")
    reason = None
    try:
        try:
            facts = detect()
        except (RuntimeError, OSError) as error:
            reason = failure_reason(error)
            if not reason:
                raise
            facts = {"accel": "cpu", "gpu": None}
        accel = facts["accel"]
        if accel != "cpu" and any(accel not in MODEL_ACCELERATORS.get(model, set()) for model in models):
            accel = "cpu"
        if facts["accel"] == "cpu" and previous != "cpu" and torch_build().get("cuda"):
            reason = reason or "driver"
        os.environ["KROBI_ACCEL"] = accel
        try:
            result = operation()
        except (RuntimeError, OSError, NotImplementedError) as error:
            if accel == "cpu" or not (reason := failure_reason(error)):
                raise
            # Drop cached accelerator models before the CPU attempt. A job's
            # child exits afterwards, releasing all remaining allocator memory.
            from .kinds.lyrics.align import _MODEL

            _MODEL.clear()
            error.__traceback__ = None
            gc.collect()
            import sys

            torch = sys.modules.get("torch")
            if torch is not None and accel == "cuda":
                import contextlib

                with contextlib.suppress(RuntimeError):
                    torch.cuda.empty_cache()
            os.environ["KROBI_ACCEL"] = "cpu"
            accel = "cpu"
            result = operation()
        evidence = {"accel": accel, "gpu": facts.get("gpu") if accel != "cpu" else None}
        if reason:
            evidence["fallbackReason"] = reason
        result.update(evidence)
        if manifest and manifest.is_file():
            import json

            data = json.loads(manifest.read_text())
            data.setdefault("worker", {}).update(evidence)
            manifest.write_text(json.dumps(data, ensure_ascii=False))
        return result
    finally:
        if previous is None:
            os.environ.pop("KROBI_ACCEL", None)
        else:
            os.environ["KROBI_ACCEL"] = previous
