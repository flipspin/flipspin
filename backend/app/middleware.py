import logging
import time
import uuid

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.exceptions import (
    KrobiException,
    ConfigurationError,
    MusicNotFoundError,
    DownloadError,
    MetadataError,
    PlaylistError,
    TransferError,
    BurningError,
    ValidationError,
    SpotifyAuthRequiredError,
    SpotifyPlaylistAccessError,
)

logger = logging.getLogger(__name__)

# Match the resolved route, never exception text or a broad URL prefix.
_OPTIONAL_READ_ROUTES = frozenset({
    "/api/lyrics/{album}/{file}",
    "/api/stems/{album}/{file}",
    "/api/media/{album}/cover.jpg",
})


def _expected_absence(request: Request, status_code: int) -> bool:
    route = request.scope.get("route")
    return (
        status_code == 404
        and request.method in {"GET", "HEAD"}
        and getattr(route, "path", None) in _OPTIONAL_READ_ROUTES
    )


def _error_response(status_code: int, content: dict) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=content)


class ErrorHandlingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            return await call_next(request)
        except ValidationError as e:
            logger.warning("Validation error: %s", e)
            return _error_response(400, e.to_dict())
        except SpotifyAuthRequiredError as e:
            logger.info("Spotify auth required: %s", e)
            return _error_response(401, e.to_dict())
        except SpotifyPlaylistAccessError as e:
            logger.info("Spotify playlist access restricted: %s", e)
            return _error_response(422, e.to_dict())
        except MusicNotFoundError as e:
            level = logging.DEBUG if _expected_absence(request, 404) else logging.WARNING
            logger.log(level, "Music not found: %s", e)
            return _error_response(404, e.to_dict())
        except PlaylistError as e:
            logger.error("Playlist error: %s", e)
            return _error_response(404, e.to_dict())
        except DownloadError as e:
            logger.error("Download error: %s", e)
            return _error_response(500, e.to_dict())
        except MetadataError as e:
            logger.error("Metadata error: %s", e)
            return _error_response(500, e.to_dict())
        except TransferError as e:
            logger.error("Transfer error: %s", e)
            return _error_response(500, e.to_dict())
        except BurningError as e:
            logger.error("Burning error: %s", e)
            return _error_response(500, e.to_dict())
        except ConfigurationError as e:
            logger.error("Configuration error: %s", e)
            return _error_response(503, e.to_dict())
        except KrobiException as e:
            logger.error("KROBI error: %s", e)
            return _error_response(500, e.to_dict())
        except Exception as e:
            logger.error("Unexpected error: %s", e, exc_info=True)
            return _error_response(
                500,
                {
                    "error_code": "INTERNAL_SERVER_ERROR",
                    "message": "An unexpected error occurred",
                    "details": {},
                },
            )


# Request details are debug; failures stay visible at the production level.
class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        log_request_id = "".join(char if char.isprintable() else " " for char in request_id)
        request.state.request_id = request_id

        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000.0

        # One line per request: the method, the
        # path, the status and the time. The previous pair ("Request started" /
        # "Request completed") carried those only in `extra`, which the
        # console formatter never printed.
        path = request.url.path
        level = logging.DEBUG
        if response.status_code >= 400 and not _expected_absence(request, response.status_code):
            level = logging.WARNING
        logger.log(
            level,
            "%s %s → %d in %.0f ms [request_id=%s]",
            request.method,
            path,
            response.status_code,
            duration_ms,
            log_request_id,
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": path,
                "status_code": response.status_code,
                "duration_sec": round(duration_ms / 1000.0, 3),
                "client": request.client.host if request.client else None,
            },
        )
        response.headers["X-Request-ID"] = request_id
        return response
