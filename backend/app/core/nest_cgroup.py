"""Compatibility alias for :mod:`app.infra.nest_cgroup` (one release)."""
# DeprecationWarning: app.core.nest_cgroup is deprecated; use app.infra.nest_cgroup.
import sys

from app.infra import nest_cgroup as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
