"""Compatibility alias for :mod:`app.infra.provider_credentials` (one release)."""
# DeprecationWarning: app.core.provider_credentials is deprecated; use app.infra.provider_credentials.
import sys

from app.infra import provider_credentials as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
