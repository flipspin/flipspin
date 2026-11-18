"""Compatibility alias for :mod:`app.infra.security` (one release)."""
# DeprecationWarning: app.core.security is deprecated; use app.infra.security.
import sys

from app.infra import security as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
