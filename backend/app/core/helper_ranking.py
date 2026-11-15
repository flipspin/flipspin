"""Compatibility alias for :mod:`app.domains.helpers.helper_ranking` (one release)."""
# DeprecationWarning: app.core.helper_ranking is deprecated; use app.domains.helpers.helper_ranking.
import sys

from app.domains.helpers import helper_ranking as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
