"""One-release import bridge to krobi_helper.agent."""
import sys
from krobi_helper import agent as _implementation

sys.modules[__name__] = _implementation
