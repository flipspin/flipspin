"""Compatibility alias for :mod:`app.infra.env_sources` (one release)."""
# DeprecationWarning: app.core.env_sources is deprecated; use app.infra.env_sources.
import sys

from app.infra import env_sources as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
