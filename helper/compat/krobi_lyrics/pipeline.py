"""One-release import bridge to krobi_helper.pipeline."""
import sys
from krobi_helper import pipeline as _implementation

sys.modules[__name__] = _implementation
