"""Compatibility alias for shared filename utilities."""
import sys
from app.utils import filenames as _implementation

sys.modules[__name__] = _implementation
