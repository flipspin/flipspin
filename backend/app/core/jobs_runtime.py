"""Compatibility alias for :mod:`app.infra.jobs_runtime` (one release)."""
# DeprecationWarning: app.core.jobs_runtime is deprecated; use app.infra.jobs_runtime.
import sys

from app.infra import jobs_runtime as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
