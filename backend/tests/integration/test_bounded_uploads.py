"""Multipart limits apply to received bytes before parser spooling."""
import asyncio
import tempfile
import threading
from types import SimpleNamespace

import httpx
import pytest
from starlette import formparsers

from app.dependencies import get_lyrics_service, get_stems_service
from app.domains.helpers import legacy
from app.domains.playlists import routes as playlists
from app.main import app
from app.infra.uploads import bounded_form
from starlette.requests import Request


@pytest.mark.asyncio
async def test_bounded_form_rollover_runs_off_the_event_loop(monkeypatch):
    loop_thread = threading.get_ident()
    rollover_threads = []

    class Spool(tempfile.SpooledTemporaryFile):
        def rollover(self):
            rollover_threads.append(threading.get_ident())
            return super().rollover()

    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', Spool)
    monkeypatch.setattr(formparsers.MultiPartParser, 'spool_max_size', 64, raising=False)
    monkeypatch.setattr(formparsers.MultiPartParser, 'max_file_size', 64, raising=False)
    body = (b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="audio.bin"\r\n\r\n'
            + b'x' * 512 + b'\r\n--boundary--\r\n')
    parts = iter(body[offset:offset + 32] for offset in range(0, len(body), 32))

    async def receive():
        chunk = next(parts, b'')
        return {'type': 'http.request', 'body': chunk, 'more_body': bool(chunk)}

    request = Request({'type': 'http', 'headers': [(b'content-type', b'multipart/form-data; boundary=boundary')]}, receive)
    async with bounded_form(request, 2048) as form:
        upload = form['file']
        assert upload.file._rolled
        assert await upload.read() == b'x' * 512
    assert rollover_threads and all(thread != loop_thread for thread in rollover_threads)
    assert upload.file.closed


@pytest.mark.parametrize('declared_length', [None, '1'])
@pytest.mark.parametrize('path', [
    '/api/playlists/spotify-export/parse',
    '/api/helpers/jobs/old/result',
    '/api/stems/agent/result',
    '/rest/getOpenSubsonicExtensions',
])
def test_chunked_multipart_stops_before_spooling_whole_body(accounts, monkeypatch, tmp_path, path, declared_length):
    owner, _ = accounts.mint('Owner', 'owner')
    _, _, token = accounts.add_device(owner.user_id, 'Helper', helper=True)
    monkeypatch.setattr(playlists, 'MAX_EXPORT_UPLOAD_BYTES', 2048)
    monkeypatch.setattr(legacy, 'MAX_MANIFEST_BYTES', 128)
    monkeypatch.setattr(legacy, 'MAX_STEM_BYTES', 128)
    # Force real disk rollover well below the test cap; retain handles to check
    # cleanup even on platforms that unlink temporary files immediately.
    monkeypatch.setattr(formparsers.MultiPartParser, 'spool_max_size', 64)
    spool_dir = tmp_path / 'spool'
    spool_dir.mkdir()
    opened = []

    def spool(*args, **kwargs):
        file = tempfile.SpooledTemporaryFile(*args, **kwargs, dir=spool_dir)
        opened.append(file)
        return file

    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', spool)
    queue = SimpleNamespace(worker=SimpleNamespace(lock=threading.Lock()),
                            result_response=lambda *args: {'accepted': False, 'reason': 'lease-lost'})
    service = SimpleNamespace(queue=queue)
    overrides = {
        get_stems_service: lambda: service,
        get_lyrics_service: lambda: service,
    }
    before = app.dependency_overrides.copy()
    app.dependency_overrides.update(overrides)
    consumed = []
    body = (b'--boundary\r\nContent-Disposition: form-data; name="lease"\r\n\r\nold\r\n'
            b'--boundary\r\nContent-Disposition: form-data; name="id"\r\n\r\nold\r\n'
            b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="export.json"\r\n'
            b'Content-Type: application/json\r\n\r\n' + b'x' * (128 << 10) + b'\r\n--boundary--\r\n')

    async def send():
        async def chunks():
            for offset in range(0, len(body), 512):
                consumed.append(offset)
                yield body[offset:offset + 512]

        headers = {'Content-Type': 'multipart/form-data; boundary=boundary'}
        if '/api/helpers/' in path or '/api/stems/agent/' in path:
            headers['Authorization'] = f'Bearer {token}'
        if declared_length is not None:
            headers['Content-Length'] = declared_length
        transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 50000))
        async with httpx.AsyncClient(transport=transport, base_url='http://localhost') as client:
            return await client.post(path, content=chunks(), headers=headers)

    try:
        response = asyncio.run(send())
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(before)
    assert response.status_code == 413, response.text
    assert len(consumed) * 512 < len(body), 'must stop receiving at the cap'
    assert opened and any(file._rolled for file in opened)
    assert all(file.closed for file in opened)
    assert list(spool_dir.iterdir()) == []
