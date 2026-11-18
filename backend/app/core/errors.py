"""Compatibility alias for :mod:`app.infra.errors` (one release)."""
# DeprecationWarning: app.core.errors is deprecated; use app.infra.errors.
import sys

from app.infra import errors as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
