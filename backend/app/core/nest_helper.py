"""Compatibility alias for :mod:`app.domains.helpers.nest_helper` (one release)."""
# DeprecationWarning: app.core.nest_helper is deprecated; use app.domains.helpers.nest_helper.
import sys

from app.domains.helpers import nest_helper as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
