"""Check recording ownership lookup and invalidation against temporary libraries.

Incremental updates must not rebuild the full index for every acquired track.
"""
import logging
from types import SimpleNamespace

import pytest

from app.domains.music.ownership import (
    ACQUISITION_SETTLE_S,
    OWNERSHIP_DURATION_TOLERANCE_S,
    OwnershipIndex,
)

LOG = logging.getLogger("test.ownership")


def _track(title, artist="BTS", album="Butter", duration=183.0, path=None, number=1):
    return SimpleNamespace(
        title=title,
        artist=artist,
        album=album,
        duration=duration,
        track_number=number,
        path=path or f"/music/{album}/{title}.mp3",
    )


class FakeRepo:
    """Counts scans so "is the index actually memoized" is observable.

    Mirrors ``MusicRepository.scan_albums``, which returns ``[]`` (with a
    warning) when the music directory does not exist. A fake that kept handing
    back tracks regardless would make the missing-directory test pass for the
    wrong reason.
    """

    def __init__(self, tracks, base_dir):
        self.tracks = tracks
        self.base_dir = base_dir
        self.scans = 0
        self.tag_revision = 0

    def scan_albums(self, *, signature=None):
        self.scans += 1
        if not self.base_dir.exists():
            return []
        return [SimpleNamespace(name="Butter", tracks=self.tracks)]


class FakeClock:
    """Drives the settle window: ``sleep`` advances time instead of blocking."""

    def __init__(self, idx):
        self.now = 1000.0
        self.slept = 0.0
        idx._clock = lambda: self.now
        idx._sleep = self.sleep

    def sleep(self, seconds):
        self.slept += seconds
        self.now += seconds


@pytest.fixture
def index(tmp_path):
    def build(tracks=None):
        (tmp_path / "Butter").mkdir(exist_ok=True)
        repo = FakeRepo(tracks if tracks is not None else [_track("Butter")], tmp_path)
        config = SimpleNamespace(base_music_dir=tmp_path)
        return OwnershipIndex(music_repository=repo, config=config, logger=LOG), repo

    return build


class TestTheButterCase:
    """A remix is not the track. This is the whole reason the module exists."""

    def test_owns_the_studio_track(self, index):
        idx, _repo = index()

        assert idx.lookup("BTS", "Butter", 183.0).owned is True

    @pytest.mark.parametrize(
        "title",
        [
            "Butter (Hotter Remix)",
            "Butter (Sweeter Remix)",
            "Butter (Cooler Remix)",
            "Butter (Instrumental)",
        ],
    )
    def test_does_not_own_the_remixes_or_the_instrumental(self, index, title):
        idx, _repo = index()

        verdict = idx.lookup("BTS", title, 183.0)

        assert verdict.owned is False, (
            f"{title!r} matched the studio track — a parenthetical-stripping "
            "normalizer would report four tracks as owned that are not"
        )

    def test_a_remaster_is_the_same_recording(self, index):
        """The other half of the asymmetry: remaster noise must collapse."""
        idx, _repo = index(tracks=[_track("Butter")])

        assert idx.lookup("BTS", "Butter (Remastered 2021)", 183.0).owned is True


class TestDurationDecidesBetweenRecordings:
    def test_a_wildly_different_length_is_a_different_recording(self, index):
        idx, _repo = index()

        verdict = idx.lookup("BTS", "Butter", 183.0 + 180)

        assert verdict.owned is False
        # Reported rather than silently missed: "you have a 3-minute version of
        # this" is useful, a bare "no" is not.
        assert verdict.near_match is not None
        assert "different recording" in verdict.reason

    def test_a_small_difference_is_the_same_recording(self, index):
        """Encoders disagree by a second or two; that is not a new recording."""
        idx, _repo = index()

        assert idx.lookup("BTS", "Butter", 183.0 + 5).owned is True

    def test_the_tolerance_is_the_matchers_own_constant(self):
        """"Same recording" must mean one thing, on disk and against YouTube."""
        from app.domains.metadata.matching import DURATION_VETO_S

        assert OWNERSHIP_DURATION_TOLERANCE_S == DURATION_VETO_S

    def test_no_duration_supplied_falls_back_to_the_key(self, index):
        idx, _repo = index()

        assert idx.lookup("BTS", "Butter", None).owned is True

    def test_an_untimed_local_file_is_not_refused_on_duration(self, index):
        idx, _repo = index(tracks=[_track("Butter", duration=None)])

        assert idx.lookup("BTS", "Butter", 183.0).owned is True

    def test_picks_the_closest_of_several_same_key_files(self, index):
        idx, _repo = index(
            tracks=[
                _track("Butter", duration=400.0, path="/music/Butter/long.mp3"),
                _track("Butter", duration=184.0, path="/music/Butter/right.mp3"),
            ]
        )

        assert idx.lookup("BTS", "Butter", 183.0).match.path.endswith("right.mp3")


class TestNormalization:
    def test_case_and_accents_are_folded(self, index):
        idx, _repo = index(tracks=[_track("Café", artist="Sébastien")])

        assert idx.lookup("SEBASTIEN", "cafe", 183.0).owned is True

    def test_a_different_artist_is_a_different_track(self, index):
        idx, _repo = index()

        assert idx.lookup("Someone Else", "Butter", 183.0).owned is False

    def test_empty_title_is_refused_with_a_reason(self, index):
        idx, _repo = index()

        verdict = idx.lookup("BTS", "   ", 183.0)

        assert verdict.owned is False
        assert verdict.reason == "no title to match on"

    def test_a_track_with_no_title_is_left_out_of_the_index(self, index):
        idx, _repo = index(tracks=[_track(""), _track("Butter")])

        assert idx.lookup("BTS", "Butter", 183.0).owned is True


class TestFreshness:
    def test_the_library_is_scanned_once_not_per_lookup(self, index):
        idx, repo = index()

        for _ in range(10):
            idx.lookup("BTS", "Butter", 183.0)

        assert repo.scans == 1

    def test_a_batch_pays_the_freshness_check_once(self, index):
        """Per-track freshness stats every album dir; 50 tracks meant 50 walks."""
        idx, repo = index()

        idx.lookup_many([{"title": "Butter", "artist": "BTS", "duration_s": 183.0}] * 50)

        assert repo.scans == 1

    def test_invalidate_forces_a_rebuild(self, index):
        """So a freshly downloaded track is recognised without a new mtime."""
        idx, repo = index()
        clock = FakeClock(idx)
        idx.lookup("BTS", "Butter", 183.0)

        idx.invalidate()
        idx.lookup("BTS", "Butter", 183.0)

        assert repo.scans == 2
        # It waited out the settle window first, rather than rebuilding at once.
        assert clock.slept == pytest.approx(ACQUISITION_SETTLE_S)

    def test_a_new_album_directory_is_noticed(self, index, tmp_path):
        idx, repo = index()
        idx.lookup("BTS", "Butter", 183.0)

        (tmp_path / "Another Album").mkdir()
        idx.lookup("BTS", "Butter", 183.0)

        assert repo.scans == 2

    def test_a_tag_revision_rebuilds_without_a_directory_change(self, index):
        idx, repo = index()
        assert idx.lookup("BTS", "Butter").owned is True
        repo.tracks = [_track("Dynamite")]
        repo.tag_revision += 1

        assert idx.lookup("BTS", "Dynamite").owned is True
        assert idx.lookup("BTS", "Butter").owned is False
        assert repo.scans == 2

    def test_a_missing_music_directory_is_not_an_error(self, index, tmp_path):
        idx, _repo = index()
        for child in tmp_path.iterdir():
            child.rmdir()
        tmp_path.rmdir()

        assert idx.lookup("BTS", "Butter", 183.0).owned is False


class TestAcquisitionBursts:
    """Batch acquisition updates must not rebuild the full ownership index per song."""

    def test_a_burst_of_acquisitions_rebuilds_once(self, index, tmp_path):
        idx, repo = index()
        clock = FakeClock(idx)
        idx.lookup("BTS", "Butter", 183.0)
        assert repo.scans == 1

        # Overlapping jobs: each lands a file (new album dir → new signature)
        # and the page refetches after every one of them.
        for _ in range(17):
            idx.acquisition_started()
        for n in range(17):
            (tmp_path / f"Album {n}").mkdir()
            idx.acquisition_finished()
            idx.lookup("BTS", "Butter", 183.0)
            clock.now += 1.0

        assert repo.scans == 2

    def test_queries_mid_burst_get_the_index_as_it_stands(self, index, tmp_path):
        idx, repo = index()
        clock = FakeClock(idx)
        idx.lookup("BTS", "Butter", 183.0)

        idx.acquisition_started()
        (tmp_path / "New Album").mkdir()
        for _ in range(5):
            idx.lookup("BTS", "Butter", 183.0)

        assert repo.scans == 1
        assert clock.slept == 0.0  # in flight: answered at once, never waits

    def test_the_refetch_after_the_last_download_sees_the_new_song(self, index):
        """The owned marker must still flip on the page's one refetch."""
        idx, repo = index()
        clock = FakeClock(idx)
        assert idx.lookup("BTS", "Dynamite", 199.0).owned is False

        idx.acquisition_started()
        repo.tracks = repo.tracks + [_track("Dynamite", duration=199.0)]
        idx.acquisition_finished()

        assert idx.lookup("BTS", "Dynamite", 199.0).owned is True
        assert repo.scans == 2
        assert clock.slept == pytest.approx(ACQUISITION_SETTLE_S)

    def test_every_finish_restarts_the_settle_window(self, index):
        idx, repo = index()
        clock = FakeClock(idx)
        idx.lookup("BTS", "Butter", 183.0)

        idx.acquisition_started()
        idx.acquisition_finished()
        clock.now += ACQUISITION_SETTLE_S - 1
        idx.acquisition_started()
        idx.acquisition_finished()
        idx.lookup("BTS", "Butter", 183.0)

        assert repo.scans == 2
        assert clock.slept == pytest.approx(ACQUISITION_SETTLE_S)

    def test_a_cold_index_builds_even_mid_burst(self, index):
        """Nothing to serve stale, so the first query must build."""
        idx, repo = index()
        FakeClock(idx)
        idx.acquisition_started()

        assert idx.lookup("BTS", "Butter", 183.0).owned is True
        assert repo.scans == 1

    def test_an_unbalanced_finish_never_holds_forever(self, index):
        idx, repo = index()
        FakeClock(idx)
        idx.lookup("BTS", "Butter", 183.0)

        idx.acquisition_finished()  # no matching start
        idx.lookup("BTS", "Butter", 183.0)

        assert repo.scans == 2


class TestBatch:
    def test_order_is_preserved(self, index):
        idx, _repo = index()

        verdicts = idx.lookup_many(
            [
                {"title": "Butter", "artist": "BTS", "duration_s": 183.0},
                {"title": "Butter (Instrumental)", "artist": "BTS", "duration_s": 183.0},
                {"title": "Nothing", "artist": "Nobody", "duration_s": 100.0},
            ]
        )

        assert [v.owned for v in verdicts] == [True, False, False]

    def test_empty_batch(self, index):
        idx, _repo = index()

        assert idx.lookup_many([]) == []
