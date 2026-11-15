"""One-release import bridge to krobi_helper.acceleration."""
import sys
from krobi_helper import acceleration as _implementation

sys.modules[__name__] = _implementation
