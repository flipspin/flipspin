"""Compatibility exports for the shared request identity gates.

Keep these exports bound to the infra implementation.
Authentication decisions and principal resolution remain in infra.
See docs/security.md#request-authentication.
"""
from app.infra.identity import *  # noqa: F403
from app.infra.identity import _warned as _warned
