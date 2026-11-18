"""Typed wire fixtures for host health and retry tests."""
from app.domains.acquisition.failures import failure_from_wire


def failure(kind, *, details=None, retry_after=None):
    return failure_from_wire({'kind': kind, 'message': 'opaque plugin message',
                              'details': details or {}, 'retryAfter': retry_after})
