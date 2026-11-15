"""Compatibility alias for :mod:`app.infra.throttle` (one release)."""
# DeprecationWarning: app.core.throttle is deprecated; use app.infra.throttle.
import sys

from app.infra import throttle as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
