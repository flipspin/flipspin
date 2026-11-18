"""One-release import bridge to krobi_helper.separation."""
import sys
from krobi_helper import separation as _implementation

sys.modules[__name__] = _implementation
