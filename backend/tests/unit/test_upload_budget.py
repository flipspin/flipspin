"""A process-wide upload reservation bounds concurrent multipart spooling."""
import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.infra import uploads


def request(body=b'x', *, declared=None):
    calls = []
    headers = [(b'content-type', b'application/x-www-form-urlencoded')]
    if declared is not None:
        headers.append((b'content-length', declared.encode()))

    async def receive():
        calls.append(True)
        return {'type': 'http.request', 'body': body, 'more_body': False}

    return Request({'type': 'http', 'method': 'POST', 'path': '/', 'headers': headers}, receive), calls


def test_concurrent_upload_budget_refuses_before_receiving_and_releases(monkeypatch):
    monkeypatch.setattr(uploads, 'MAX_IN_FLIGHT_UPLOAD_BYTES', 1024, raising=False)

    async def run():
        first, _ = request()
        second, received = request()
        async with uploads.bounded_form(first, 1024):
            with pytest.raises(HTTPException) as caught:
                async with uploads.bounded_form(second, 1024):
                    pass
            assert caught.value.status_code == 503
            assert caught.value.headers['Retry-After'] == '1'
            assert received == []
        third, _ = request()
        async with uploads.bounded_form(third, 1024):
            pass

    asyncio.run(run())


@pytest.mark.parametrize('failure', ['too-large', 'disconnect', 'cancel'])
def test_failed_upload_always_releases_its_reservation(monkeypatch, failure):
    monkeypatch.setattr(uploads, 'MAX_IN_FLIGHT_UPLOAD_BYTES', 1024, raising=False)

    async def run():
        if failure == 'too-large':
            broken, _ = request(b'x' * 1025)
            error = HTTPException
        else:
            async def receive():
                if failure == 'cancel':
                    raise asyncio.CancelledError
                return {'type': 'http.disconnect'}
            broken = Request({'type': 'http', 'method': 'POST', 'path': '/',
                              'headers': [(b'content-type', b'application/x-www-form-urlencoded')]}, receive)
            error = asyncio.CancelledError if failure == 'cancel' else Exception
        with pytest.raises(error):
            async with uploads.bounded_form(broken, 1024):
                pass
        fresh, _ = request()
        async with uploads.bounded_form(fresh, 1024):
            pass

    asyncio.run(run())


def test_small_declared_uploads_share_capacity_and_dishonest_lengths_cannot_overbook(monkeypatch):
    monkeypatch.setattr(uploads, 'MAX_IN_FLIGHT_UPLOAD_BYTES', 16, raising=False)

    async def run():
        first, _ = request(b'x' * 8, declared='8')
        async with uploads.bounded_form(first, 1024):
            small, _ = request(b'y' * 8, declared='1')
            async with uploads.bounded_form(small, 1024):
                extra, received = request(b'z', declared='1')
                with pytest.raises(HTTPException) as caught:
                    async with uploads.bounded_form(extra, 1024):
                        pass
                assert caught.value.status_code == 503
                assert received == []
            oversized, _ = request(b'y' * 9, declared='1')
            with pytest.raises(HTTPException) as caught:
                async with uploads.bounded_form(oversized, 1024):
                    pass
            assert caught.value.status_code == 503
        fresh, _ = request(b'z' * 16, declared='16')
        async with uploads.bounded_form(fresh, 1024):
            pass

    asyncio.run(run())
