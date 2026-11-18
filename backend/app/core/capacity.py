"""Compatibility alias for :mod:`app.infra.capacity` (one release)."""
# DeprecationWarning: app.core.capacity is deprecated; use app.infra.capacity.
import sys

from app.infra import capacity as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
