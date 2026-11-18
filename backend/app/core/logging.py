"""Compatibility alias for :mod:`app.infra.logging` (one release)."""
# DeprecationWarning: app.core.logging is deprecated; use app.infra.logging.
import sys

from app.infra import logging as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
