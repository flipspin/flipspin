"""Compatibility alias for :mod:`app.infra.cors` (one release)."""
# DeprecationWarning: app.core.cors is deprecated; use app.infra.cors.
import sys

from app.infra import cors as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
