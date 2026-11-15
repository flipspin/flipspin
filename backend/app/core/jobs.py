"""Compatibility alias for :mod:`app.infra.jobs` (one release)."""
# DeprecationWarning: app.core.jobs is deprecated; use app.infra.jobs.
import sys

from app.infra import jobs as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
