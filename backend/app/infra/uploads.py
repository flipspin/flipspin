"""Bound form bodies before multipart parsing can spool them to disk."""
from collections.abc import Callable
from contextlib import asynccontextmanager, contextmanager
from threading import Lock

from fastapi import HTTPException, Request
from fastapi.routing import APIRoute
from starlette.datastructures import FormData
from starlette.formparsers import FormParser, MultiPartException, MultiPartParser
from starlette.concurrency import run_in_threadpool
from python_multipart.multipart import parse_options_header


class _UploadTooLarge(MultiPartException):
    """Use the parser's error path to close in-progress temporary files."""


# One backend worker owns all form parsers. Unknown lengths reserve the route
# cap; declared lengths reserve that size and grow before extra bytes reach the
# parser. Hold reservations until the form and its temporary files close.
MAX_IN_FLIGHT_UPLOAD_BYTES = 1 << 30
_upload_lock = Lock()
_reserved_bytes = 0


@contextmanager
def _reserve_upload(limit: int):
    global _reserved_bytes
    reserved = limit

    def grow(total: int):
        nonlocal reserved
        global _reserved_bytes
        with _upload_lock:
            extra = max(0, total - reserved)
            if _reserved_bytes + extra > MAX_IN_FLIGHT_UPLOAD_BYTES:
                raise HTTPException(503, 'Upload capacity is busy; retry later.', headers={'Retry-After': '1'})
            _reserved_bytes += extra
            reserved += extra

    with _upload_lock:
        if _reserved_bytes + limit > MAX_IN_FLIGHT_UPLOAD_BYTES:
            raise HTTPException(503, 'Upload capacity is busy; retry later.', headers={'Retry-After': '1'})
        _reserved_bytes += limit
    try:
        yield grow
    finally:
        with _upload_lock:
            _reserved_bytes -= reserved


def _declared_size(request: Request, limit: int) -> int:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            size = int(declared)
            if size < 0:
                raise ValueError
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length header") from None
        if size > limit:
            raise HTTPException(413, f'Upload is too large (limit {limit} bytes)')
        return size
    return limit


@asynccontextmanager
async def _parse_form(request: Request, limit: int, grow, *, max_files: int, max_fields: int):
    detail = f"Upload is too large (limit {limit} bytes)"

    async def stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > limit:
                raise _UploadTooLarge(detail)
            grow(total)
            yield chunk

    content_type, _ = parse_options_header(request.headers.get("content-type"))
    parser = None
    try:
        if content_type == b"multipart/form-data":
            parser = MultiPartParser(request.headers, stream(), max_files=max_files, max_fields=max_fields)
            form = await parser.parse()
        elif content_type == b"application/x-www-form-urlencoded":
            form = await FormParser(request.headers, stream()).parse()
        else:
            form = FormData()
    except BaseException as error:
        # Starlette closes on MultiPartException; also close on disconnect or
        # cancellation, before a FormData context manager can own the files.
        if parser is not None:
            for file in parser._files_to_close_on_error:
                file.close()
        if isinstance(error, _UploadTooLarge):
            raise HTTPException(413, detail) from error
        if isinstance(error, MultiPartException):
            raise HTTPException(400, error.message) from error
        raise
    try:
        yield form
    finally:
        await form.close()


@asynccontextmanager
async def bounded_form(request: Request, limit: int, *, max_files: int = 1, max_fields: int = 4):
    with _reserve_upload(_declared_size(request, limit)) as grow:
        async with _parse_form(request, limit, grow, max_files=max_files, max_fields=max_fields) as form:
            yield form


def bounded_form_route(limit: Callable[[], int], *, authorize: Callable[[Request], None],
                       max_files: int, max_fields: int) -> type[APIRoute]:
    """Bound legacy File/Form dependencies before FastAPI reads their body.

    Keeping those dependencies preserves their validation and OpenAPI schema.
    """
    class BoundedFormRoute(APIRoute):
        def get_route_handler(self):
            handler = super().get_route_handler()

            async def handle(request: Request):
                await run_in_threadpool(authorize, request)
                content_type, _ = parse_options_header(request.headers.get("content-type"))
                if content_type not in (b"multipart/form-data", b"application/x-www-form-urlencoded"):
                    return await handler(request)
                async with bounded_form(request, limit(), max_files=max_files, max_fields=max_fields) as form:
                    # FastAPI's form dependencies read this Request cache.
                    request._form = form
                    return await handler(request)

            return handle

    return BoundedFormRoute
