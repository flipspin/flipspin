"""Compatibility alias: machine facts are shared infrastructure."""
import sys

from app.infra import machine as _implementation

# Preserve private probes and monkeypatches at the established import path.
sys.modules[__name__] = _implementation
