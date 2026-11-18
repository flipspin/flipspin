"""Compatibility alias for :mod:`app.infra.instance` (one release)."""
# DeprecationWarning: app.core.instance is deprecated; use app.infra.instance.
import sys

from app.infra import instance as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
