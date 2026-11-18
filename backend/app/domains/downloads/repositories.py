"""One-release compatibility alias; acquisition owns this implementation."""
import sys
from app.domains.acquisition import provider as _implementation

sys.modules[__name__] = _implementation
