"""Closed source failure policy. Extractor text belongs to plugins."""
import socket
import subprocess
from dataclasses import dataclass

from app.exceptions import (FailureKind, SourceFailure, SourceAuthRequiredError, ProviderRateLimitedError)


@dataclass(frozen=True)
class FailurePolicy:
    message: str
    reason: str
    retryable: bool = True
    penalize: bool = False
    automatic: bool = False


POLICIES = {
    FailureKind.NOT_FOUND: FailurePolicy('No matching audio was found.', 'no-encontrada'),
    FailureKind.AUTH_REQUIRED: FailurePolicy(str(SourceAuthRequiredError()), 'auth'),
    FailureKind.RATE_LIMITED: FailurePolicy('The source is busy. Waiting before trying again.', 'en-pausa', penalize=True, automatic=True),
    FailureKind.BLOCKED: FailurePolicy('The source has blocked requests. Try again later.', 'fallo-descarga', penalize=True),
    FailureKind.NETWORK: FailurePolicy('Could not connect to the source. Check the server connection and retry.', 'fallo-descarga'),
    FailureKind.BROKEN: FailurePolicy('The source could not fetch this audio. Try again later.', 'fallo-descarga', penalize=True),
    FailureKind.BUG: FailurePolicy('The source encountered an unexpected error.', 'fallo-descarga', retryable=False),
}

def classify_failure(error: Exception, *, details: dict | None = None) -> SourceFailure:
    """Preserve typed source failures and normalize local host errors."""
    if isinstance(error, SourceFailure):
        return error
    failure = SourceFailure('The source could not complete this call.', {'raw': str(error), **(details or {})})
    if isinstance(error, (TimeoutError, ConnectionError, socket.gaierror, OSError, subprocess.TimeoutExpired)):
        failure.kind = FailureKind.NETWORK
    elif isinstance(error, (AssertionError, TypeError, AttributeError)):
        failure.kind = FailureKind.BUG
    elif getattr(error, 'reason', None) == 'no-encontrada':
        failure.kind = FailureKind.NOT_FOUND
    return failure


def failure_from_wire(error):
    """Decode typed protocol errors; never classify their human-readable text."""
    kind = FailureKind(error['kind'])
    cls = {FailureKind.AUTH_REQUIRED: SourceAuthRequiredError,
           FailureKind.RATE_LIMITED: ProviderRateLimitedError}.get(kind, SourceFailure)
    failure = cls(POLICIES[kind].message, error.get('details'))
    failure.kind = kind
    failure.retry_after = error.get('retryAfter')
    return failure
