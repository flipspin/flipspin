"""Acquisition I/O never occupies the API's event loop."""
import asyncio
import logging
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
import requests

from app.domains.acquisition.engine import DownloadEngine
from app.domains.metadata.repositories import GeniusRepository
from app.infra.media_requests import DownloadOptions, TrackDownloadRequest, TrackMetadata
from app.main import app
from tests.unit import test_acquisition as fixtures
from tests.unit.test_acquisition import ANA, submit

pipeline = fixtures.pipeline


async def assert_status_responds():
    transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 50000))
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        started = time.perf_counter()
        # The cover blocks for 2 s; a loop blocked by it could not answer within 1 s.
        # A tighter bound only measured machine load (flaky under parallel test runs).
        response = await asyncio.wait_for(client.get('/api/status'), 1.0)
        elapsed = time.perf_counter() - started
    assert response.status_code == 200
    assert elapsed < 1.0


@pytest.mark.asyncio
async def test_slow_cover_keeps_status_responsive(config, tmp_path, monkeypatch):
    entered = threading.Event()

    class Cover(BaseHTTPRequestHandler):
        def do_GET(self):
            entered.set()
            time.sleep(2)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'cover')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Cover)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # Only this fake server may bypass the public-address policy.
    monkeypatch.setattr('app.domains.metadata.repositories.safe_get',
                        lambda url, **kwargs: requests.get(url, timeout=10))
    log = logging.getLogger(__name__)
    metadata, downloader = Mock(), Mock()
    main_thread = threading.get_ident()
    worker_threads = []
    downloader.normalize_audio.side_effect = lambda *args, **kwargs: worker_threads.append(threading.get_ident()) or True
    metadata.write_id3_tags.side_effect = lambda *args, **kwargs: worker_threads.append(threading.get_ident()) or True
    metadata.embed_cover_art.side_effect = lambda *args, **kwargs: worker_threads.append(threading.get_ident())
    engine = DownloadEngine(downloader, metadata, GeniusRepository(config, log), None, config, log)
    path = tmp_path / 'song.mp3'
    path.write_bytes(b'audio')
    request = TrackDownloadRequest(destination=tmp_path, metadata=TrackMetadata(title='Song'), options=DownloadOptions(normalize=True),
                                   cover_url=f'http://127.0.0.1:{server.server_port}/cover.jpg')
    task = asyncio.create_task(engine._finish_staged_file(path, request, lambda *args: None))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        assert not task.done()
        await assert_status_responds()
        # This also fails if the loop was blocked until the cover finished.
        assert not task.done()
        await asyncio.wait_for(task, 4)
        assert len(worker_threads) == 3
        assert len(set(worker_threads)) == 1
        assert worker_threads[0] != main_thread
    finally:
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        thread.join()


@pytest.mark.asyncio
@pytest.mark.parametrize('operation', ['ledger', 'link'])
async def test_slow_pipeline_io_keeps_status_responsive(pipeline, monkeypatch, operation):
    entered, release = threading.Event(), threading.Event()
    if operation == 'ledger':
        target, name = pipeline.ledger, 'stage_transition'
    else:
        target, name = pipeline.user_tracks, 'add_many'
    original = getattr(target, name)

    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return original(*args, **kwargs)

    monkeypatch.setattr(target, name, slow)
    row = submit(pipeline)
    task = asyncio.create_task(pipeline.run(row['id']))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        await assert_status_responds()
    finally:
        release.set()
        await asyncio.wait_for(task, 3)
    assert pipeline.view(row['id'], ANA)['state'] == 'completo'


def test_acquisition_async_lint_rejects_blocking_http_and_subprocess():
    filename = Path(__file__).resolve().parents[2] / 'app/domains/acquisition/negative_check.py'
    result = subprocess.run([sys.executable, '-m', 'ruff', 'check', '--stdin-filename', str(filename), '-'],
                            input='import requests\nimport subprocess\n\nasync def bad():\n    requests.get("https://example.com")\n    subprocess.run(["tool"])\n',
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 1, result.stdout + result.stderr
    assert 'ASYNC210' in result.stdout
    assert 'ASYNC221' in result.stdout
