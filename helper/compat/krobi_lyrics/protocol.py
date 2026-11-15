"""One-release import bridge to krobi_helper.protocol."""
import sys
from krobi_helper import protocol as _implementation

sys.modules[__name__] = _implementation
