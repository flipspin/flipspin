"""Compatibility alias for :mod:`app.infra.tasks` (one release)."""
# DeprecationWarning: app.core.tasks is deprecated; use app.infra.tasks.
import sys

from app.infra import tasks as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
