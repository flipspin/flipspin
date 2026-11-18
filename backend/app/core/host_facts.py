"""Compatibility alias for :mod:`app.infra.host_facts` (one release)."""
# DeprecationWarning: app.core.host_facts is deprecated; use app.infra.host_facts.
import sys

from app.infra import host_facts as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
