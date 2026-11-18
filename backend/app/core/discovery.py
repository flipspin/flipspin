"""Compatibility alias for :mod:`app.infra.discovery` (one release)."""
# DeprecationWarning: app.core.discovery is deprecated; use app.infra.discovery.
import sys

from app.infra import discovery as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
