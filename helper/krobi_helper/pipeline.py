"""Compatibility import; implementation lives in kinds.lyrics.pipeline."""
import sys
from .kinds.lyrics import pipeline as _implementation

sys.modules[__name__] = _implementation
