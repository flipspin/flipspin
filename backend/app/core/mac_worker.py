"""Compatibility alias for :mod:`app.domains.helpers.mac_worker` (one release)."""
# DeprecationWarning: app.core.mac_worker is deprecated; use app.domains.helpers.mac_worker.
import sys

from app.domains.helpers import mac_worker as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
