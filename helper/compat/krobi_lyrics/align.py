"""One-release import bridge to krobi_helper.align."""
import sys
from krobi_helper import align as _implementation

sys.modules[__name__] = _implementation
