"""Shared fixtures and builders for the acquisition behavior suites."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.domains.acquisition.models import Request
from app.domains.acquisition.services import Pipeline
from app.domains.downloads.core import ResolvedVideo
from app.domains.downloads.models import DownloadResult
from app.domains.user_library.store import UserTrackStore
from app.infra.identity import Principal
from app.infra.jobs import Jobs

ANA = Principal('ana', 'Ana')
BETO = Principal('beto', 'Beto')


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    from app.infra import urls
    monkeypatch.setattr(urls, "_source_hosts", lambda: {"youtube.com", "www.youtube.com", "youtu.be"})
    # These orchestration fixtures contain sentinel bytes; media validation has
    # its own real-file tests in test_acquisition_audio.
    monkeypatch.setattr('app.domains.acquisition.import_stage.validate', lambda *args, **kwargs: {})
    root = tmp_path / 'Music'
    root.mkdir()
    ledger = Jobs(tmp_path / 'jobs.sqlite')
    engine = SimpleNamespace(completion_listeners=[], calls=[])

    async def match(request):
        return ResolvedVideo('https://youtube.com/watch?v=test', 'same recording', decision='STRONG')

    async def download(url, destination, filename, percent_cb=None):
        engine.calls.append(destination)
        destination.mkdir(parents=True, exist_ok=True)
        path = destination / f'{filename}.mp3'
        path.write_bytes(b'complete audio')
        return path

    async def tag(*args):
        pass

    engine._resolve_source_url = match
    engine._download_audio_file = download
    engine._finish_staged_file = tag
    engine._success_result = lambda path, request: DownloadResult(True, path, title=request.metadata.title)
    ownership = Mock()
    ownership.lookup_many.side_effect = lambda tracks: [SimpleNamespace(owned=False) for _ in tracks]
    store = UserTrackStore(tmp_path / 'tracks.json')
    service = Pipeline(ledger=ledger, engine=engine, ownership=ownership, user_tracks=store,
                       root=root, data=tmp_path)
    yield service
    ledger.close()


def body(n=1, **kwargs):
    return Request(kind='album' if n > 1 else 'song', provider='deezer', provider_id='123', title='Album',
                   tracks=[{'title': f'Song {i}', 'artist': 'Artist', 'album': 'Album', 'track_number': i+1} for i in range(n)], **kwargs)


def submit(pipeline, data=None, principal=ANA, **kwargs):
    return pipeline.submit(data or body(), principal, schedule=False, **kwargs)


def legacy_submit(pipeline, data=None, principal=ANA, **kwargs):
    """Construct the request-only registration written before item stages."""
    row = submit(pipeline, data, principal, **kwargs)
    with pipeline.ledger.lock, pipeline.ledger.db:
        pipeline.ledger.db.execute('DELETE FROM jobs WHERE id=?', (row['id'],))
    return row


def configure_capacity(pipeline, limit=3):
    from app.infra.capacity import CapacityLimiter
    pipeline.engine.config = SimpleNamespace(
        job_limiter=CapacityLimiter(lambda: 2),
        download_limiter=CapacityLimiter(lambda: limit),
    )
