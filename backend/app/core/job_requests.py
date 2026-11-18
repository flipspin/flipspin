"""Compatibility alias for :mod:`app.infra.job_requests` (one release)."""
# DeprecationWarning: app.core.job_requests is deprecated; use app.infra.job_requests.
import sys

from app.infra import job_requests as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
