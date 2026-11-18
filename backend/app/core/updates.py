"""Compatibility alias for :mod:`app.infra.updates` (one release)."""
# DeprecationWarning: app.core.updates is deprecated; use app.infra.updates.
import sys

from app.infra import updates as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
