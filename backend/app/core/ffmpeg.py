"""Compatibility alias for :mod:`app.infra.ffmpeg` (one release)."""
# DeprecationWarning: app.core.ffmpeg is deprecated; use app.infra.ffmpeg.
import sys

from app.infra import ffmpeg as _implementation

# Preserve private exports, module state, and plugin monkeypatches as well.
sys.modules[__name__] = _implementation
