"""Compatibility import; implementation lives in kinds.lyrics.align."""
import sys
from .kinds.lyrics import align as _implementation

sys.modules[__name__] = _implementation
