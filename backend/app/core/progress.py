"""Compatibility alias for :mod:`app.infra.progress` (one release)."""
# DeprecationWarning: app.core.progress is deprecated; use app.infra.progress.
import sys

from app.infra import progress as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
