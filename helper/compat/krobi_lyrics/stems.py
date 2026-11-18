"""One-release import bridge to krobi_helper.stems."""
import sys
from krobi_helper import stems as _implementation

sys.modules[__name__] = _implementation
