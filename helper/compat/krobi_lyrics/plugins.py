"""One-release import bridge to krobi_helper.plugins."""
import sys
from krobi_helper import plugins as _implementation

sys.modules[__name__] = _implementation
