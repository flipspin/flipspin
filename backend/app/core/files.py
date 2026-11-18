"""Compatibility alias for :mod:`app.infra.files` (one release)."""
# DeprecationWarning: app.core.files is deprecated; use app.infra.files.
import sys

from app.infra import files as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
