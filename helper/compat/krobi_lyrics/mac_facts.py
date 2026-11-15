"""One-release import bridge to krobi_helper.mac_facts."""
import sys
from krobi_helper import mac_facts as _implementation

sys.modules[__name__] = _implementation
