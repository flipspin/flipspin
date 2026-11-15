"""Compatibility alias for :mod:`app.infra.demo_overrides` (one release)."""
# DeprecationWarning: app.core.demo_overrides is deprecated; use app.infra.demo_overrides.
import sys

from app.infra import demo_overrides as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
