"""Compatibility import; implementation lives in kinds.stems.pipeline."""
import sys
from .kinds.stems import pipeline as _implementation

sys.modules[__name__] = _implementation
