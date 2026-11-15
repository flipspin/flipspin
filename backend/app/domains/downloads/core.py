"""One-release compatibility alias; acquisition owns this implementation."""
import sys
from app.domains.acquisition import engine as _implementation

sys.modules[__name__] = _implementation
