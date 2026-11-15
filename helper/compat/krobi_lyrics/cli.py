"""One-release import bridge to krobi_helper.cli."""
import sys
from krobi_helper import cli as _implementation

if __name__ == "__main__":
    raise SystemExit(_implementation.main())

sys.modules[__name__] = _implementation
