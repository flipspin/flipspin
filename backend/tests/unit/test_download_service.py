"""Unit tests for the download service, engine, and request model.

The download stack is a facade (`DownloadService`) over a core `DownloadEngine`
and per-source adapters. Public download modes are tested through the service;
the per-track download flow is tested directly on the engine (where that logic
now lives); filename/validation rules are tested on the request model.
"""
import pytest
from pathlib import Path
from unittest.mock import Mock, AsyncMock

from app.domains.downloads.adapters import _widest_image_url
from app.domains.downloads.services import DownloadService
from app.domains.downloads.models import (
    TrackDownloadRequest,
    TrackMetadata,
    DownloadOptions,
)
from app.config import ConfigManager
from app.infra.capacity import CapacityLimiter
from app.infra.progress import ProgressTracker
from app.exceptions import DownloadError


@pytest.fixture
def mock_config():
    """Create mock configuration."""
    config = Mock(spec=ConfigManager)
    config.base_music_dir = Path("/tmp/music")
    config.max_concurrent_downloads = 3
    config.max_concurrent_jobs = 2
    config.download_limiter = CapacityLimiter(lambda: config.max_concurrent_downloads)
    config.job_limiter = CapacityLimiter(lambda: config.max_concurrent_jobs)
    config.genius_api_key = "test_api_key"
    return config


@pytest.fixture
def mock_logger():
    """Create mock logger."""
    return Mock()


@pytest.fixture
def mock_download_repo():
    """Create mock download repository."""
    repo = Mock()

    # Echo the query back as a plausible upload title. YouTube results are now
    # scored against what was asked for (see downloads/youtube_matching.py), so a
    # fixture returning one fixed unrelated title would be correctly rejected and
    # would only test the refusal path.
    async def _search(query, *args, **kwargs):
        return [{
            "url": "https://youtube.com/watch?v=test123",
            "id": "test123",
            "title": f"{query} (Official Audio)",
            "duration": None,
            "artist": None,
        }]

    repo.search_source = AsyncMock(side_effect=_search)

    # Write a file where the engine asked for it, like yt-dlp does. The engine
    # now stages the download and publishes it with a rename, so a fake that
    # only *returned* a path would fail the publish step: there is nothing on
    # disk to move.
    async def _download(url, output_path, *args, **kwargs):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"")
        return output_path

    repo.download_source_audio = AsyncMock(side_effect=_download)
    repo.normalize_audio = Mock()
    return repo


@pytest.fixture
def mock_metadata_repo():
    """Create mock metadata repository."""
    repo = Mock()
    repo.read_id3_tags = Mock(return_value=Mock(
        title="Test Song",
        artist="Test Artist",
        album="Test Album"
    ))
    repo.write_id3_tags = Mock()
    repo.embed_cover_art = Mock()
    return repo


@pytest.fixture
def mock_progress_tracker():
    """Create mock progress tracker."""
    real = ProgressTracker()
    tracker = Mock(spec=ProgressTracker, wraps=real)
    return tracker


@pytest.fixture
def download_service(mock_download_repo, mock_metadata_repo, mock_progress_tracker, mock_config, mock_logger, monkeypatch):
    """Create download service instance with fake media boundaries."""
    # Stub media work for sentinel-byte orchestration tests only.
    def package(path, **kwargs):
        target = path.with_suffix('.m4a')
        path.rename(target)
        return target
    monkeypatch.setattr('app.domains.acquisition.engine.prepare_m4a', package)
    monkeypatch.setattr('app.domains.acquisition.import_stage.validate', lambda *args, **kwargs: {})
    mock_config.ffmpeg_path = 'ffmpeg'
    mock_config.download_timeout = 30
    return DownloadService(
        download_repo=mock_download_repo,
        metadata_repo=mock_metadata_repo,
        progress_tracker=mock_progress_tracker,
        config=mock_config,
        logger=mock_logger
    )


@pytest.fixture
def engine(download_service):
    """The core engine the service delegates to (wired with the same mocks)."""
    return download_service.engine


class TestDownloadModes:
    """Tests for the public download modes on the service facade."""

    @pytest.mark.asyncio
    async def test_download_from_url(self, download_service):
        """Test YouTube URL download mode."""
        result = await download_service.download_from_url(
            url="https://youtube.com/watch?v=test123",
            destination=Path("/tmp/music"),
            normalize=True
        )

        assert result.success is True
        assert result.file_path is not None

    @pytest.mark.asyncio
    async def test_download_from_search(self, download_service):
        """Test search term download mode."""
        result = await download_service.download_from_search(
            search_term="Test Artist - Test Song",
            destination=Path("/tmp/music")
        )

        assert result.success is True
        assert result.file_path is not None

    @pytest.mark.asyncio
    async def test_download_from_genius(self, download_service):
        """Test Genius album download mode."""
        results = await download_service.download_from_genius(
            genius_url="https://genius.com/albums/test",
            tracks=["Song 1", "Song 2"],
            destination=Path("/tmp/music"),
            album_name="Test Album",
            artist_name="Test Artist"
        )

        assert len(results) == 2
        assert all(r.success for r in results)

    @pytest.mark.asyncio
    async def test_download_spotify_playlist(self, download_service):
        """Test Spotify playlist download mode."""
        tracks = [
            {"name": "Song 1", "artist": "Artist 1", "album": "Album 1"},
            {"name": "Song 2", "artist": "Artist 2", "album": "Album 2"}
        ]

        results = await download_service.download_spotify_playlist(
            tracks=tracks,
            destination=Path("/tmp/music")
        )

        assert len(results) == 2
        assert all(r.success for r in results)


class TestSpotifyTrackSearch:
    """DownloadService.search_spotify_tracks — delegates to the repo, wraps errors."""

    def test_delegates_to_repo(self, download_service):
        download_service.spotify_repo.search_tracks = Mock(return_value=[{"id": "1", "name": "S"}])

        results = download_service.search_spotify_tracks("hello")

        assert results == [{"id": "1", "name": "S"}]
        download_service.spotify_repo.search_tracks.assert_called_once_with("hello", 10)

    def test_empty_query_raises(self, download_service):
        with pytest.raises(DownloadError):
            download_service.search_spotify_tracks("   ")

    def test_missing_credentials_wrapped_as_download_error(self, download_service):
        download_service.spotify_repo.search_tracks = Mock(
            side_effect=RuntimeError("Spotify credentials not configured")
        )

        with pytest.raises(DownloadError) as exc:
            download_service.search_spotify_tracks("hello")

        assert "credentials" in str(exc.value)


class TestEngineSingleTrack:
    """Tests for DownloadEngine.download_single_track (the core per-track flow)."""

    @pytest.mark.asyncio
    async def test_download_with_youtube_url(self, engine, mock_download_repo, tmp_path):
        """A direct YouTube URL downloads without searching."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=test123",
            destination=tmp_path,
            metadata=TrackMetadata(title="Test Song", artist="Test Artist"),
        )

        result = await engine.download_single_track(request)

        assert result.success is True
        assert result.file_path == tmp_path / f"{request.get_filename()}.m4a"
        assert result.file_path.exists()
        mock_download_repo.search_source.assert_not_called()
        mock_download_repo.download_source_audio.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_with_search_query(self, engine, mock_download_repo, tmp_path):
        """A search query is resolved to a URL via the repo before downloading."""
        request = TrackDownloadRequest(
            search_query="Test Artist - Test Song",
            destination=tmp_path,
            metadata=TrackMetadata(title="Test Song", artist="Test Artist"),
        )

        result = await engine.download_single_track(request)

        assert result.success is True
        # max_results is deliberate, not incidental: selection can veto every
        # candidate, so the shortlist has to be wide enough to survive that.
        mock_download_repo.search_source.assert_called_once_with(
            "Test Artist - Test Song", max_results=10, wanted={"title": "Test Song", "artist": "Test Artist"}
        )
        mock_download_repo.download_source_audio.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_applies_metadata(self, engine, mock_metadata_repo, tmp_path):
        """ID3 tags are written when the request carries metadata."""
        mock_metadata_repo.embed_cover_art.return_value = None
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=test123",
            destination=tmp_path,
            metadata=TrackMetadata(
                title="Test Song",
                artist="Test Artist",
                album="Test Album",
                track_number=1,
            ),
        )

        result = await engine.download_single_track(request)

        assert result.success is True
        mock_metadata_repo.write_id3_tags.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_with_normalization(self, engine, mock_download_repo, tmp_path):
        """normalize_audio runs when normalization is requested and enabled."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=test123",
            destination=tmp_path,
            options=DownloadOptions(normalize=True, effect_type="clean", volume_boost=4.0),
        )

        result = await engine.download_single_track(request)

        assert result.success is True
        mock_download_repo.normalize_audio.assert_called_once()

    @pytest.mark.asyncio
    async def test_download_embeds_cover_art(self, engine, mock_metadata_repo, tmp_path):
        """Provided cover_data is embedded into the downloaded file."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=test123",
            destination=tmp_path,
            cover_data=b"fake_cover_data",
        )
        result = await engine.download_single_track(request)

        assert result.success is True
        mock_metadata_repo.embed_cover_art.assert_called_once()
        # Publish the sidecar without leaking the embedding staging directory.
        assert (tmp_path / "cover.jpg").read_bytes() == b"fake_cover_data"
        assert not (tmp_path / "cover").exists()

    @pytest.mark.asyncio
    async def test_download_search_not_found(self, engine, mock_download_repo, tmp_path):
        """Empty search results surface as an unresolved-URL failure."""
        mock_download_repo.search_source.side_effect = None
        mock_download_repo.search_source.return_value = []
        request = TrackDownloadRequest(search_query="Nonexistent Song", destination=tmp_path)

        result = await engine.download_single_track(request)

        assert result.success is False
        assert "Could not resolve source URL" in result.error

    @pytest.mark.asyncio
    async def test_download_invalid_request(self, engine, tmp_path):
        """A request with neither URL nor query fails validation."""
        request = TrackDownloadRequest(destination=tmp_path)

        result = await engine.download_single_track(request)

        assert result.success is False
        assert "Invalid request" in result.error

    @pytest.mark.asyncio
    async def test_download_reports_phases_in_order(self, engine, mock_download_repo, tmp_path):
        """progress_cb fires the pipeline phases in order; the repo gets a percent cb."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=t",
            destination=tmp_path,
            metadata=TrackMetadata(title="Song", artist="Artist"),
            options=DownloadOptions(normalize=True, effect_type="clean", volume_boost=4.0),
        )

        phases = []
        await engine.download_single_track(
            request, progress_cb=lambda phase, percent=None: phases.append(phase)
        )

        assert phases[0] == "searching"
        assert (
            phases.index("downloading")
            < phases.index("normalizing")
            < phases.index("tagging")
            < phases.index("embedding_cover")
        )

        # The repo was handed a percent callback so it can stream live download %.
        _, kwargs = mock_download_repo.download_source_audio.call_args
        assert kwargs.get("progress_cb") is not None

    @pytest.mark.asyncio
    async def test_download_without_callback_passes_none(self, engine, mock_download_repo, tmp_path):
        """No progress_cb → repo receives progress_cb=None (cheap buffered path)."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=t",
            destination=tmp_path,
        )

        await engine.download_single_track(request)

        _, kwargs = mock_download_repo.download_source_audio.call_args
        assert kwargs.get("progress_cb") is None


class TestEngineStaging:
    """Keep growing audio outside the library until publication.

    Otherwise scans and media responses can expose a truncated file that clients cache."""

    @pytest.mark.asyncio
    async def test_album_has_no_audio_until_pipeline_finishes(self, engine, mock_download_repo, mock_metadata_repo, tmp_path):
        album = tmp_path / "Album"
        seen_in_album = {}

        async def _download(url, output_path, *args, **kwargs):
            # Mid-download: the album folder must not show the track.
            seen_in_album["during_download"] = sorted(p.name for p in album.glob("*.m4a")) if album.exists() else []
            assert output_path.parent != album
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"half")
            return output_path

        def _tag(file_path, metadata, **kwargs):
            # Mid-tagging, same rule: the file is still outside the album.
            seen_in_album["during_tagging"] = sorted(p.name for p in album.glob("*.m4a")) if album.exists() else []

        mock_download_repo.download_source_audio.side_effect = _download
        mock_metadata_repo.write_id3_tags.side_effect = _tag
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=t",
            destination=album,
            metadata=TrackMetadata(title="Song", artist="Artist"),
        )

        result = await engine.download_single_track(request)

        assert result.success is True
        assert seen_in_album == {"during_download": [], "during_tagging": []}
        assert result.file_path.parent == album
        assert result.file_path.read_bytes() == b"half"
        # The staging folder is gone, and nothing else leaked into the library.
        assert not any((tmp_path / ".staging").iterdir()) if (tmp_path / ".staging").exists() else True
        assert sorted(p.name for p in album.glob("*.m4a")) == [result.file_path.name]

    @pytest.mark.asyncio
    async def test_failed_download_leaves_no_staging_behind(self, engine, mock_download_repo, tmp_path):
        album = tmp_path / "Album"
        mock_download_repo.download_source_audio.side_effect = Exception("yt-dlp died")
        request = TrackDownloadRequest(youtube_url="https://youtube.com/watch?v=t", destination=album)

        result = await engine.download_single_track(request)

        assert result.success is False
        staging = tmp_path / ".staging"
        assert not staging.exists() or not any(staging.iterdir())
        assert not album.exists() or not any(album.glob("*.m4a"))


class TestEngineSingleTrackSteps:
    """The phases of `download_single_track`, each on its own."""

    def test_valid_request_has_no_failure(self, engine, tmp_path):
        request = TrackDownloadRequest(youtube_url="https://youtube.com/watch?v=t", destination=tmp_path)
        assert engine._invalid_request_result(request) is None

    @pytest.mark.parametrize("reason, kind, error, failure_kind", [
        ("no YouTube results for 'x'", "no-results",
         "Could not resolve source URL: no YouTube results for 'x'", "no-results"),
        ("", "", "Could not resolve source URL", "error"),
    ])
    def test_unresolved_result_carries_reason_and_kind(self, engine, reason, kind, error, failure_kind):
        from app.domains.downloads.core import ResolvedVideo

        result = engine._unresolved_result(ResolvedVideo(None, reason, kind))

        assert result.success is False
        assert result.error == error
        assert result.failure_kind == failure_kind

    @pytest.mark.asyncio
    async def test_a_failed_publish_is_a_failed_result(self, engine, monkeypatch, tmp_path):
        def _refuse(staged, destination, **kwargs):
            raise OSError("read-only file system")

        monkeypatch.setattr(engine, "_publish", _refuse)
        request = TrackDownloadRequest(youtube_url="https://youtube.com/watch?v=t", destination=tmp_path / "Album")

        result = await engine.download_single_track(request)

        assert result.success is False
        assert result.error == "Could not move finished track into the album: read-only file system"
        assert not (tmp_path / ".staging").exists() or not any((tmp_path / ".staging").iterdir())

    @pytest.mark.asyncio
    async def test_finishing_steps_are_best_effort(self, engine, mock_download_repo, mock_metadata_repo, tmp_path):
        """Normalize and tag may each fail; every later phase still runs."""
        mock_download_repo.normalize_audio.side_effect = RuntimeError("ffmpeg")
        mock_metadata_repo.write_id3_tags.side_effect = RuntimeError("mutagen")
        staged = tmp_path / "song.m4a"
        staged.write_bytes(b"")
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=t",
            destination=tmp_path,
            metadata=TrackMetadata(title="Song", artist="Artist"),
            options=DownloadOptions(normalize=True, effect_type="clean", volume_boost=4.0),
        )
        phases = []

        await engine._finish_staged_file(staged, request, lambda name, percent=None: phases.append(name))

        assert phases == ["normalizing", "tagging", "embedding_cover"]

    def test_success_result_titles_from_the_file_tags(self, engine, tmp_path):
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=t",
            destination=tmp_path,
            metadata=TrackMetadata(title="Asked", artist="Asked Artist"),
        )

        result = engine._success_result(tmp_path / "song.m4a", request)

        assert result.success is True
        assert (result.title, result.artist, result.album) == ("Test Song", "Test Artist", "Test Album")

    def test_success_result_falls_back_to_the_request(self, engine, mock_metadata_repo, tmp_path):
        mock_metadata_repo.read_id3_tags.side_effect = RuntimeError("unreadable")
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=t",
            destination=tmp_path,
            metadata=TrackMetadata(title="Asked", artist="Asked Artist", album="Asked Album"),
        )

        result = engine._success_result(tmp_path / "song.m4a", request)

        assert result.success is True
        assert (result.title, result.artist, result.album) == ("Asked", "Asked Artist", "Asked Album")


class TestEngineMultipleTracks:
    """Tests for DownloadEngine.download_multiple_tracks (batch flow)."""

    @pytest.mark.asyncio
    async def test_batch_download_success(self, engine, tmp_path):
        """All tracks succeed in a clean batch."""
        requests = [
            TrackDownloadRequest(
                youtube_url=f"https://youtube.com/watch?v=test{i}",
                destination=tmp_path,
                metadata=TrackMetadata(title=f"Song {i}"),
            )
            for i in range(3)
        ]

        results = await engine.download_multiple_tracks(requests)

        assert len(results) == 3
        assert all(r.success for r in results)

    @pytest.mark.asyncio
    async def test_batch_reports_per_track_phase(self, engine, mock_progress_tracker, tmp_path):
        """Each track's sub-state is reported keyed by its own name (concurrency-safe)."""
        requests = [
            TrackDownloadRequest(
                youtube_url="https://youtube.com/watch?v=t",
                destination=tmp_path,
                metadata=TrackMetadata(title="Song X"),
            )
        ]

        await engine.download_multiple_tracks(requests, progress_id="pid")

        assert mock_progress_tracker.set_track_phase.called
        calls = mock_progress_tracker.set_track_phase.call_args_list
        # report() calls set_track_phase(progress_id, track_name, phase, percent).
        assert all(c.args[0] == "pid" for c in calls)
        assert all(c.args[1] == "Song X" for c in calls)
        assert "searching" in {c.args[2] for c in calls}

    @pytest.mark.asyncio
    async def test_batch_download_partial_failure(self, engine, mock_download_repo, mock_config, tmp_path):
        """A failure on one track does not abort the others."""
        mock_config.max_concurrent_downloads = 1
        calls = []

        async def _flaky(url, output_path, *args, **kwargs):
            calls.append(url)
            if url.endswith("test1"):
                raise Exception("Download failed")
            output_path.write_bytes(b"")
            return output_path

        mock_download_repo.download_source_audio.side_effect = _flaky
        requests = [
            TrackDownloadRequest(
                youtube_url=f"https://youtube.com/watch?v=test{i}",
                destination=tmp_path,
            )
            for i in range(3)
        ]

        results = await engine.download_multiple_tracks(requests)

        assert len(results) == 3
        assert results[0].success is True
        assert results[1].success is False
        assert results[2].success is True

    @pytest.mark.asyncio
    async def test_batch_download_progress_tracking(self, engine, mock_progress_tracker, tmp_path):
        """Progress is created once, updated per track, and completed once."""
        requests = [
            TrackDownloadRequest(
                youtube_url=f"https://youtube.com/watch?v=test{i}",
                destination=tmp_path,
                metadata=TrackMetadata(title=f"Song {i}"),
            )
            for i in range(3)
        ]

        await engine.download_multiple_tracks(requests)

        mock_progress_tracker.create_progress.assert_called_once()
        assert mock_progress_tracker.update_progress.call_count == 3
        mock_progress_tracker.complete_progress.assert_called_once()

    @pytest.mark.asyncio
    async def test_batch_does_not_recreate_existing_progress(self, engine, mock_progress_tracker, tmp_path):
        """If the progress id is already registered, create_progress is NOT called.

        Lets an endpoint pre-create the entry (so the SSE stream can attach) and then
        background the download without the engine clobbering that state.
        """
        mock_progress_tracker.get_progress = Mock(return_value=Mock(completed=0))  # already exists
        requests = [
            TrackDownloadRequest(
                youtube_url="https://youtube.com/watch?v=t",
                destination=tmp_path,
                metadata=TrackMetadata(title="Song"),
            )
        ]

        await engine.download_multiple_tracks(requests, progress_id="pre-made")

        mock_progress_tracker.create_progress.assert_not_called()
        mock_progress_tracker.complete_progress.assert_called_once()


class TestRequestModel:
    """Tests for filename generation and validation on TrackDownloadRequest."""

    def test_generate_filename_with_track_number(self):
        """A track number is zero-padded and prefixed to the title."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=x",
            metadata=TrackMetadata(title="Test Song", artist="Test Artist", track_number=1),
        )

        filename = request.generate_filename()

        assert "01" in filename
        assert "Test Song" in filename

    def test_get_filename_prefers_custom(self):
        """An explicit filename overrides metadata-based generation (and is cleaned)."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=x",
            filename="My: Custom/Name",
        )

        # Filesystem-invalid characters are stripped.
        assert request.get_filename() == "My CustomName"

    def test_clean_filename_strips_invalid_chars(self):
        """Invalid filesystem characters are removed from generated names."""
        request = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=x",
            metadata=TrackMetadata(title='A<>:"/\\|?*B'),
        )

        assert request.generate_filename() == "AB"

    def test_validate_requires_url_or_query(self):
        """A request with neither a URL nor a query is invalid."""
        is_valid, error = TrackDownloadRequest(destination=Path("/tmp")).validate()

        assert is_valid is False
        assert "search_query or youtube_url" in error

    def test_validate_rejects_both_url_and_query(self):
        """Providing both a URL and a query is invalid."""
        is_valid, error = TrackDownloadRequest(
            youtube_url="https://youtube.com/watch?v=x",
            search_query="something",
            destination=Path("/tmp"),
        ).validate()

        assert is_valid is False
        assert "Cannot provide both" in error


class TestFilterSelectedTracks:
    """Tests for DownloadService._filter_selected_tracks (playlist subset import)."""

    def _tracks(self):
        return [{"name": "a"}, {"name": "b"}, {"name": "c"}]

    def test_none_returns_all(self):
        """None means 'download everything' (legacy behavior)."""
        tracks = self._tracks()
        assert DownloadService._filter_selected_tracks(tracks, None) == tracks

    def test_selects_subset_in_order(self):
        """Only the chosen positions are kept, in the order requested."""
        result = DownloadService._filter_selected_tracks(self._tracks(), [2, 0])
        assert result == [{"name": "c"}, {"name": "a"}]

    def test_ignores_out_of_range_and_duplicates(self):
        """Out-of-range and duplicate indices are dropped, not fatal."""
        result = DownloadService._filter_selected_tracks(self._tracks(), [0, 0, 99, -1])
        assert result == [{"name": "a"}]

    def test_empty_selection_returns_nothing(self):
        """An empty selection list downloads nothing."""
        assert DownloadService._filter_selected_tracks(self._tracks(), []) == []


class TestTerminalOutcomeIsMachineReadable:
    """A job at 100% may still have failed. Counts must say so, not prose.

    `completed` counts items *attempted* — a failed download still lands in
    `done` — so a one-track job that failed reports completed == total == 1 at
    100%. Before `succeeded`/`failed` existed, the only evidence was the human
    summary string, and the frontend regex-parsed it.
    """

    def test_complete_progress_records_the_counts(self):
        from app.infra.progress import ProgressTracker

        tracker = ProgressTracker()
        tracker.create_progress("pid", 3)
        tracker.complete_progress("pid", "Downloaded 1/3 tracks (2 failed)", succeeded=1, failed=2)

        snapshot = tracker.get_progress("pid").to_dict()

        assert snapshot["succeeded"] == 1
        assert snapshot["failed"] == 2
        assert snapshot["terminal"] is True

    def test_counts_default_to_none_for_callers_that_do_not_know(self):
        """Optional, so the pre-existing `complete_progress(id, "failed")` calls
        keep working rather than being forced to invent numbers."""
        from app.infra.progress import ProgressTracker

        tracker = ProgressTracker()
        tracker.create_progress("pid", 1)
        tracker.complete_progress("pid", "failed")

        snapshot = tracker.get_progress("pid").to_dict()

        assert snapshot["succeeded"] is None
        assert snapshot["failed"] is None

    def test_a_fully_failed_batch_is_distinguishable_from_a_successful_one(self):
        """The exact case that rendered as silent success in the UI."""
        from app.infra.progress import ProgressTracker

        tracker = ProgressTracker()
        tracker.create_progress("pid", 1)
        # The item was attempted and therefore lands in `done`, whether or not
        # the download actually worked.
        tracker.update_progress("pid", "Nightvision")
        tracker.complete_progress("pid", "Downloaded 0/1 tracks (1 failed)", succeeded=0, failed=1)

        snapshot = tracker.get_progress("pid").to_dict()

        # Attempted, so these look like success...
        assert snapshot["completed"] == snapshot["total"] == 1
        assert snapshot["percentage"] == 100.0
        # ...and only these tell the truth.
        assert snapshot["succeeded"] == 0
        assert snapshot["failed"] == 1


class TestEmbeddedCoverIsTheLargestOffered:
    """Whatever this picks is embedded in the file and kept forever.

    Spotify happens to list its album images widest-first (640/300/64), so the
    old `album_images[0]` was right by accident; picking by width makes it right
    on purpose, and covers a caller that hands over one image with no width at
    all — which is what catalog acquisition does.
    """

    def test_the_widest_image_wins_regardless_of_position(self):
        images = [
            {"url": "https://cdn/300.jpg", "width": 300, "height": 300},
            {"url": "https://cdn/640.jpg", "width": 640, "height": 640},
            {"url": "https://cdn/64.jpg", "width": 64, "height": 64},
        ]

        assert _widest_image_url(images) == "https://cdn/640.jpg"

    def test_an_image_without_a_width_is_still_usable(self):
        """Catalog acquisition sends exactly one URL and no dimensions."""
        images = [{"url": "https://cdn-images.dzcdn.net/x/1000x1000-0.jpg"}]

        assert _widest_image_url(images) == "https://cdn-images.dzcdn.net/x/1000x1000-0.jpg"

    @pytest.mark.parametrize("images", [None, [], [{}], [{"width": 640}], "not a list"])
    def test_nothing_usable_means_no_cover_rather_than_a_crash(self, images):
        """A track with no artwork still has to download."""
        assert _widest_image_url(images) is None
