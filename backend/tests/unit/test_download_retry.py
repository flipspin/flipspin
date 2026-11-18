"""A failed song is remembered and offered back to the person, never retried alone.

YouTube's anonymous search answers an empty page for some exact strings
("Gosh Jamie xx") and a full one for nearly the same words ("Gosh Jamie").
The engine must not go hunting on its own — a wrong video is worse than a
missing one — so a failure carries suggested phrasings and the request stays
retrievable for `/api/downloads/retry`.
"""
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

from app.config import ConfigManager
from app.infra.capacity import CapacityLimiter
from app.infra.progress import ProgressTracker
from app.domains.downloads.core import alternative_queries
from app.domains.downloads.models import TrackDownloadRequest, TrackMetadata
from app.domains.downloads.services import DownloadService


def _request(tmp_path: Path, **kw) -> TrackDownloadRequest:
    return TrackDownloadRequest(
        search_query="Gosh Jamie xx",
        metadata=TrackMetadata(title="Gosh", artist="Jamie xx", album="In Colour"),
        duration_s=293,
        destination=tmp_path,
        **kw,
    )


@pytest.fixture
def tracker():
    return ProgressTracker()


@pytest.fixture
def engine(tracker):
    config = Mock(spec=ConfigManager)
    config.base_music_dir = Path("/tmp/music")
    config.max_concurrent_downloads = 2
    config.max_concurrent_jobs = 2
    config.download_limiter = CapacityLimiter(lambda: config.max_concurrent_downloads)
    config.job_limiter = CapacityLimiter(lambda: config.max_concurrent_jobs)
    config.genius_api_key = None
    repo = Mock()
    repo.search_source = AsyncMock(return_value=[])
    metadata = Mock()
    return DownloadService(
        download_repo=repo, metadata_repo=metadata, progress_tracker=tracker,
        config=config, logger=Mock(),
    ).engine


def test_alternative_queries_start_with_the_original_and_never_repeat(tmp_path):
    options = alternative_queries(_request(tmp_path))
    assert options[0] == "Gosh Jamie xx"
    assert options[1:] == ["Gosh Jamie xx lyrics", "Jamie xx Gosh audio", "Gosh Jamie", "Gosh"]
    assert len(options) == len(set(options))


def test_alternative_queries_for_a_bare_search(tmp_path):
    request = TrackDownloadRequest(search_query="some song", destination=tmp_path)
    assert alternative_queries(request) == ["some song"]


@pytest.mark.asyncio
async def test_an_empty_search_is_recorded_not_retried(engine, tracker, tmp_path):
    tracker.create_progress("job", 1)

    results = await engine.download_multiple_tracks([_request(tmp_path)], progress_id="job")

    assert results[0].success is False
    assert results[0].failure_kind == "no-results"
    # Exactly one search: the engine did not try the suggestions on its own.
    assert engine.download_repo.search_source.await_count == 1
    failures = tracker.get_progress("job").to_dict()["failures"]
    assert len(failures) == 1
    failure = failures[0]
    assert failure["index"] == 0
    assert failure["kind"] == "no-results"
    assert failure["title"] == "Gosh"
    assert failure["durationS"] == 293
    assert failure["suggestions"][0] == "Gosh Jamie xx"
    assert failure["retriedAs"] is None


@pytest.mark.asyncio
async def test_retry_request_keeps_everything_but_the_search(engine, tracker, tmp_path):
    tracker.create_progress("job", 1)
    await engine.download_multiple_tracks([_request(tmp_path)], progress_id="job")

    retry = engine.retry_request("job", 0, "https://www.youtube.com/watch?v=WjNssEVlB6M")

    assert retry.search_query is None
    assert retry.youtube_url == "https://www.youtube.com/watch?v=WjNssEVlB6M"
    assert retry.metadata.title == "Gosh"
    assert retry.destination == tmp_path
    assert retry.validate() == (True, None)


def test_retry_request_for_an_unknown_failure_is_none(engine):
    assert engine.retry_request("nope", 0, "https://youtu.be/x") is None


def test_mark_failure_retried(tracker):
    tracker.create_progress("job", 1)
    tracker.add_failure("job", {"index": 0, "retriedAs": None})
    tracker.mark_failure_retried("job", 0, "next")
    assert tracker.get_progress("job").failures[0]["retriedAs"] == "next"
