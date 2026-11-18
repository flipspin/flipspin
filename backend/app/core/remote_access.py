"""Compatibility alias for :mod:`app.infra.remote_access` (one release)."""
# DeprecationWarning: app.core.remote_access is deprecated; use app.infra.remote_access.
import sys

from app.infra import remote_access as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
