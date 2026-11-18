"""Compatibility alias for typed media requests and outcomes."""
import sys
from app.infra import media_requests as _implementation

sys.modules[__name__] = _implementation
