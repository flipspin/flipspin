"""Preserve route-specific HTTP error bodies while logging unexpected failures.

Pass HTTPException through; retain middleware handling where routes depend on it.
See docs/observability.md#route-error-boundaries.
"""
from __future__ import annotations

import functools
import inspect
import logging
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import HTTPException as FastAPIHTTPException
from starlette.exceptions import HTTPException

#: The body every such route has always answered: ``{"detail": INTERNAL_ERROR_DETAIL}``.
INTERNAL_ERROR_DETAIL = "Internal server error"

# A TypeVar rather than PEP 695 `def f[F: ...]` keeps imports compatible
# with Python 3.11 deployments.
F = TypeVar("F", bound=Callable[..., Any])


def unexpected_errors_as_500(endpoint: F) -> F:  # noqa: UP047 — support Python 3.11 deployments
    """Answer any non-HTTP exception from ``endpoint`` with a logged 500."""
    log = logging.getLogger(endpoint.__module__)

    def _as_500(exc: Exception) -> HTTPException:
        log.exception("Unexpected error in %s: %s", endpoint.__name__, exc)
        return FastAPIHTTPException(status_code=500, detail=INTERNAL_ERROR_DETAIL)

    if inspect.iscoroutinefunction(endpoint):
        @functools.wraps(endpoint)
        async def async_wrapper(*args, **kwargs):
            try:
                return await endpoint(*args, **kwargs)
            except HTTPException:
                raise
            except Exception as exc:
                raise _as_500(exc) from exc
        return async_wrapper  # type: ignore[return-value]

    @functools.wraps(endpoint)
    def sync_wrapper(*args, **kwargs):
        try:
            return endpoint(*args, **kwargs)
        except HTTPException:
            raise
        except Exception as exc:
            raise _as_500(exc) from exc
    return sync_wrapper  # type: ignore[return-value]
