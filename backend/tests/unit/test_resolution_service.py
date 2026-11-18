"""Check short-circuit matching, duplicate folding, and interrupted resolution.

Duplicate recordings must not compete in the runner-up gap. Real in-memory
registries and stub providers also verify ordering and degraded results.
"""
from unittest.mock import Mock

from app.domains.metadata.matching import Candidate, Confidence
from app.domains.metadata.resolution_service import ResolutionService
from app.domains.playlists.spotify_export import ExportedTrack
from app.exceptions import ExternalAPIError
from app.providers.registry import (
    ProviderDescriptor,
    ProviderKind,
    ProviderRegistry,
)


def _deezer(title, artist, duration=None, isrc=None, track_id="1"):
    return Candidate(
        title=title, provider="deezer", provider_id=track_id, artist=artist,
        album="Random Access Memories", duration_s=duration, isrc=isrc,
    )


def _mb(title, artist, duration=None, mbid="mbid-1", isrc=None):
    return Candidate(
        title=title, provider="musicbrainz", provider_id=mbid, artist=artist,
        album="Random Access Memories", duration_s=duration, isrc=isrc,
        recording_mbid=mbid,
    )


def _stub(results, method="search_candidates"):
    """A provider object whose one search method returns (or raises) ``results``.

    ``method`` mirrors the real adapters: the Deezer adapter exposes only
    ``search_candidates`` (free text), while the MusicBrainz one also exposes
    ``search_wanted`` and the service must prefer it — that preference is what
    keeps MusicBrainz's sharper fielded query in play.
    """
    provider = Mock(spec=[method])
    setattr(provider, method, Mock(
        side_effect=results if callable(results) else None,
        return_value=results if not callable(results) else None,
    ))
    return provider


def _descriptor(provider_id, kind=ProviderKind.METADATA):
    return ProviderDescriptor(
        id=provider_id, kind=kind, name=provider_id.title(), description=""
    )


def _registry(*providers):
    """``providers`` is a sequence of ``(id, instance)`` in escalation order."""
    registry = ProviderRegistry()
    for provider_id, instance in providers:
        registry.register(_descriptor(provider_id), instance)
    return registry


def _service(deezer_result=None, mb_result=None, registry=None, **kwargs):
    """The historical two-provider setup: Deezer first, MusicBrainz second."""
    if registry is None:
        registry = _registry(
            ("deezer", _stub(deezer_result)),
            ("musicbrainz", _stub(mb_result, method="search_wanted")),
        )
    kwargs.setdefault("enable_cache", False)
    service = ResolutionService(
        config=Mock(), logger=Mock(), registry=registry, **kwargs
    )
    # Named handles so the assertions below stay readable.
    service.deezer = registry.instance("deezer")
    service.musicbrainz = registry.instance("musicbrainz")
    return service


TRACK = ExportedTrack(title="Get Lucky", artist="Daft Punk", album="Random Access Memories")


class TestShortCircuit:
    def test_strong_deezer_match_skips_musicbrainz(self):
        service = _service(
            deezer_result=[
                _deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809"),
                _deezer("Lose Yourself to Dance", "Daft Punk", 353.0, track_id="2"),
            ],
            mb_result=[],
        )
        result = service.resolve(TRACK)

        assert result.confidence is Confidence.STRONG
        assert result.best.candidate.isrc == "USQX91300809"
        service.musicbrainz.search_wanted.assert_not_called()
        assert "musicbrainz not queried" in result.explanation

    def test_weak_deezer_match_escalates_to_musicbrainz(self):
        service = _service(
            deezer_result=[_deezer("Lose Yourself to Dance", "Daft Punk", 353.0, isrc="X")],
            mb_result=[_mb("Get Lucky", "Daft Punk", 369.0)],
        )
        result = service.resolve(TRACK)

        service.musicbrainz.search_wanted.assert_called_once()
        assert result.best.candidate.recording_mbid == "mbid-1"
        assert result.confidence is Confidence.STRONG

    def test_a_near_miss_from_the_other_provider_lands_in_review(self):
        """Honest about the cost of two providers: a Deezer typo-level variant
        that does not fold sits 0.05 behind the MusicBrainz hit, which is inside
        REQUIRED_GAP, so the track goes to a human. This is the single biggest
        driver of the review pile and it is the safe direction to fail in."""
        service = _service(
            deezer_result=[_deezer("Gett Luckyy", "Daft Punk", 369.0)],
            mb_result=[_mb("Get Lucky", "Daft Punk", 369.0)],
        )
        result = service.resolve(TRACK)
        assert result.confidence is Confidence.REVIEW
        assert "too close to call" in result.explanation

    def test_deezer_without_an_isrc_can_never_short_circuit(self):
        """An unidentifiable candidate is never STRONG — matching.py's rule."""
        service = _service(
            deezer_result=[_deezer("Get Lucky", "Daft Punk", 369.0, isrc=None)],
            mb_result=[],
        )
        service.resolve(TRACK)
        service.musicbrainz.search_wanted.assert_called_once()


class TestMerging:
    def test_same_recording_from_both_providers_folds_into_one_candidate(self):
        """The payoff: one row carrying Deezer's ISRC *and* MusicBrainz's MBID."""
        service = _service(
            deezer_result=[_deezer("Get Lucky", "Daft Punk", 369.0)],  # no ISRC
            mb_result=[_mb("Get Lucky", "Daft Punk", 369.1)],
        )
        result = service.resolve(TRACK)

        best = result.best.candidate
        assert best.provider == "deezer"  # Deezer stays primary
        assert best.recording_mbid == "mbid-1"  # MusicBrainz identity folded in
        assert result.confidence is Confidence.STRONG

    def test_two_providers_agreeing_do_not_trip_the_runner_up_gap_check(self):
        """Without folding, agreement would demote the match to REVIEW."""
        service = _service(
            deezer_result=[_deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809")],
            mb_result=[_mb("Get Lucky", "Daft Punk", 369.0)],
        )
        # Force the merge path by making the Deezer-only pass non-strong.
        service.deezer.search_candidates.return_value = [
            _deezer("Get Lucky", "Daft Punk", 369.0),
        ]
        result = service.resolve(TRACK)
        assert result.confidence is Confidence.STRONG
        assert result.runner_up is None

    def test_one_providers_own_repressings_collapse(self):
        """Deezer returns album/single/compilation rows with identical text."""
        service = _service(
            deezer_result=[
                _deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809", track_id="a"),
                _deezer("Get Lucky", "Daft Punk", 369.0, track_id="b"),
                _deezer("Get Lucky", "Daft Punk", 370.0, track_id="c"),
            ],
            mb_result=[],
        )
        result = service.resolve(TRACK)
        assert result.confidence is Confidence.STRONG
        assert result.runner_up is None  # three rows became one

    def test_a_radio_edit_is_not_folded_into_the_album_version(self):
        """Different recording per MusicBrainz style: qualifier AND duration."""
        service = _service(
            deezer_result=[
                _deezer("Get Lucky (Radio Edit)", "Daft Punk", 248.0, track_id="a"),
                _deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809", track_id="b"),
            ],
            mb_result=[],
        )
        result = service.resolve(TRACK)
        assert result.best.candidate.provider_id == "b"
        assert result.runner_up is not None  # the edit survived as its own row


class TestDegradation:
    def test_deezer_failure_degrades_to_musicbrainz(self):
        def boom(*args, **kwargs):
            raise ExternalAPIError("Quota limit exceeded", api_name="deezer")

        service = _service(deezer_result=boom, mb_result=[_mb("Get Lucky", "Daft Punk", 369.0)])
        result = service.resolve(TRACK)

        assert result.confidence is Confidence.STRONG
        assert "deezer unavailable" in result.explanation
        assert "Quota limit exceeded" in result.explanation

    def test_musicbrainz_failure_degrades_to_deezer(self):
        def boom(*args, **kwargs):
            raise ExternalAPIError("403 blocked", api_name="musicbrainz")

        # No ISRC, so the Deezer pass cannot short-circuit and MusicBrainz is
        # actually reached — which is where it blows up.
        service = _service(
            deezer_result=[_deezer("Get Lucky", "Daft Punk", 369.0)],
            mb_result=boom,
        )
        result = service.resolve(TRACK)

        assert result.confidence is Confidence.REVIEW
        assert result.best.candidate.title == "Get Lucky"
        assert "musicbrainz unavailable" in result.explanation

    def test_both_providers_down_rejects_and_says_why(self):
        def boom(*args, **kwargs):
            raise ExternalAPIError("down", api_name="x")

        result = _service(deezer_result=boom, mb_result=boom).resolve(TRACK)
        assert result.confidence is Confidence.REJECTED
        assert "deezer unavailable" in result.explanation
        assert "musicbrainz unavailable" in result.explanation
        assert result.best is None

    def test_an_unexpected_provider_bug_does_not_sink_the_import(self):
        def boom(*args, **kwargs):
            raise KeyError("someone refactored the mapping")

        service = _service(deezer_result=boom, mb_result=[_mb("Get Lucky", "Daft Punk", 369.0)])
        result = service.resolve(TRACK)
        assert result.confidence is Confidence.STRONG
        assert "deezer failed: KeyError" in result.explanation

    def test_no_candidates_anywhere_is_rejected(self):
        result = _service(deezer_result=[], mb_result=[]).resolve(TRACK)
        assert result.confidence is Confidence.REJECTED
        assert "no candidates" in result.explanation


class TestResolveMany:
    def _batch(self):
        return [
            ExportedTrack(title="Get Lucky", artist="Daft Punk"),
            ExportedTrack(title="One More Time", artist="Daft Punk"),
            ExportedTrack(title="Around the World", artist="Daft Punk"),
        ]

    def test_reports_progress_after_each_track(self):
        service = _service(deezer_result=[], mb_result=[])
        seen = []
        results = service.resolve_many(
            self._batch(), progress_callback=lambda done, total, r: seen.append((done, total))
        )
        assert len(results) == 3
        assert seen == [(1, 3), (2, 3), (3, 3)]

    def test_cancellation_stops_early_and_returns_partial_results(self):
        service = _service(deezer_result=[], mb_result=[])
        calls = {"n": 0}

        def should_cancel():
            calls["n"] += 1
            return calls["n"] > 2  # allow two tracks, then cancel

        results = service.resolve_many(self._batch(), should_cancel=should_cancel)
        assert len(results) == 2  # shorter than the input == cancelled

    def test_cancellation_is_checked_before_any_work(self):
        service = _service(deezer_result=[], mb_result=[])
        results = service.resolve_many(self._batch(), should_cancel=lambda: True)
        assert results == []
        service.deezer.search_candidates.assert_not_called()

    def test_a_broken_progress_callback_does_not_abort_the_import(self):
        service = _service(deezer_result=[], mb_result=[])

        def bad_callback(done, total, result):
            raise RuntimeError("the SSE stream went away")

        results = service.resolve_many(self._batch(), progress_callback=bad_callback)
        assert len(results) == 3

    def test_one_exploding_track_does_not_discard_the_rest_of_the_batch(self):
        """A 2000-track run must not lose half an hour of work to one bad row.

        The provider stubs already degrade politely, so this simulates the case
        the degradation cannot catch: something inside resolve() itself raising.
        """
        service = _service(deezer_result=[], mb_result=[])
        calls = {"n": 0}
        real_resolve = service.resolve

        def flaky(track):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("an unanticipated shape")
            return real_resolve(track)

        service.resolve = flaky
        results = service.resolve_many(self._batch())

        assert len(results) == 3  # full length == not cancelled, nothing lost
        assert results[1].confidence is Confidence.REJECTED
        assert "resolution failed" in results[1].explanation
        assert results[1].wanted.title == "One More Time"


class TestCaching:
    def test_the_same_song_in_two_playlists_costs_one_lookup(self):
        service = _service(
            deezer_result=[_deezer("Get Lucky", "Daft Punk", 369.0, isrc="X")],
            mb_result=[],
            enable_cache=True,
        )
        first = service.resolve(ExportedTrack(title="Get Lucky", artist="Daft Punk"))
        second = service.resolve(
            ExportedTrack(title="Get Lucky (feat. Pharrell Williams)", artist="Daft Punk")
        )

        assert service.deezer.search_candidates.call_count == 1
        assert second.confidence is first.confidence
        # The cached result is re-pointed at the track that asked for it.
        assert second.wanted.title == "Get Lucky (feat. Pharrell Williams)"

    def test_clear_cache_forces_a_refetch(self):
        service = _service(
            deezer_result=[_deezer("Get Lucky", "Daft Punk", 369.0, isrc="X")],
            mb_result=[], enable_cache=True,
        )
        service.resolve(TRACK)
        service.clear_cache()
        service.resolve(TRACK)
        assert service.deezer.search_candidates.call_count == 2


class TestQueryHandoff:
    def test_providers_get_the_shapes_they_want(self):
        """Free text to whoever only speaks free text, structure to whoever can.

        Flattening every provider to ``search_candidates(query)`` would have
        been a silent quality regression: MusicBrainz's fielded query scores far
        more sharply than the same words in the general index, and an export
        gives the matcher no duration to corroborate with.
        """
        service = _service(deezer_result=[], mb_result=[], candidate_limit=7)
        service.resolve(TRACK)

        service.deezer.search_candidates.assert_called_once_with("Daft Punk Get Lucky", 7)
        service.musicbrainz.search_wanted.assert_called_once()
        wanted, limit = service.musicbrainz.search_wanted.call_args.args
        assert (wanted.title, wanted.artist, limit) == ("Get Lucky", "Daft Punk", 7)

    def test_a_provider_without_structured_search_gets_the_free_text_query(self):
        registry = _registry(
            ("deezer", _stub([])),
            ("musicbrainz", _stub([])),  # no search_wanted on this stub
        )
        service = _service(registry=registry, candidate_limit=3)
        service.resolve(TRACK)
        service.musicbrainz.search_candidates.assert_called_once_with(
            "Daft Punk Get Lucky", 3
        )

    def test_exports_carry_no_duration_so_none_is_passed_through(self):
        service = _service(deezer_result=[], mb_result=[])
        result = service.resolve(TRACK)
        assert result.wanted.duration_s is None
        assert result.wanted.album == "Random Access Memories"


class TestRegistryDrivesTheEscalation:
    """Honor registry order, skip disabled providers, and stop at the first STRONG match."""

    def test_order_is_honoured_so_the_first_provider_is_asked_first(self):
        first = _stub([_deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809")])
        second = _stub([_mb("Get Lucky", "Daft Punk", 369.0)], method="search_wanted")
        registry = _registry(("musicbrainz", second), ("deezer", first))

        result = ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)

        # MusicBrainz was registered first, so it answers first and its STRONG
        # hit ends the walk before Deezer is touched.
        second.search_wanted.assert_called_once()
        first.search_candidates.assert_not_called()
        assert result.best.candidate.provider == "musicbrainz"

    def test_reordering_the_registry_reorders_the_escalation(self):
        """The same two providers, swapped, produce the opposite short-circuit."""
        deezer = _stub([_deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809")])
        mb = _stub([_mb("Get Lucky", "Daft Punk", 369.0)], method="search_wanted")
        registry = _registry(("deezer", deezer), ("musicbrainz", mb))
        registry.set_order(ProviderKind.METADATA, ["musicbrainz", "deezer"])

        ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)

        mb.search_wanted.assert_called_once()
        deezer.search_candidates.assert_not_called()

    def test_a_disabled_provider_is_never_asked(self):
        deezer = _stub([_deezer("Nothing Like It", "Someone Else", 200.0)])
        mb = _stub([_mb("Get Lucky", "Daft Punk", 369.0)], method="search_wanted")
        registry = _registry(("deezer", deezer), ("musicbrainz", mb))
        registry.set_enabled("deezer", False)

        result = ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)

        deezer.search_candidates.assert_not_called()
        assert result.best.candidate.provider == "musicbrainz"

    def test_the_short_circuit_skips_every_remaining_provider_not_just_one(self):
        """Generalising two branches to N must not degrade into "skip the next".

        With three providers and a strong first answer, both of the others have
        to go unqueried — otherwise the third one silently reintroduces the
        per-track cost the short-circuit exists to avoid.
        """
        first = _stub([_deezer("Get Lucky", "Daft Punk", 369.0, isrc="USQX91300809")])
        second = _stub([_mb("Get Lucky", "Daft Punk", 369.0)], method="search_wanted")
        third = _stub([_deezer("Get Lucky", "Daft Punk", 369.0, track_id="z")])
        registry = _registry(
            ("deezer", first), ("musicbrainz", second), ("spotify", third)
        )

        result = ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)

        second.search_wanted.assert_not_called()
        third.search_candidates.assert_not_called()
        assert "musicbrainz, spotify not queried" in result.explanation

    def test_escalation_walks_past_a_provider_that_found_nothing(self):
        empty = _stub([])
        found = _stub([_mb("Get Lucky", "Daft Punk", 369.0)], method="search_wanted")
        registry = _registry(("deezer", empty), ("musicbrainz", found))

        result = ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)
        assert result.confidence is Confidence.STRONG

    def test_three_providers_agreeing_still_collapse_to_one_candidate(self):
        """Folding matters *more* with N providers, not less.

        Three rows naming the same recording score identically; unfolded, the
        runner-up gap check in `matching.py` would demote a unanimous answer to
        human review — adding providers would make the product worse.
        """
        registry = _registry(
            ("deezer", _stub([_deezer("Get Lucky", "Daft Punk", 369.0)])),
            ("musicbrainz", _stub([_mb("Get Lucky", "Daft Punk", 369.2)],
                                  method="search_wanted")),
            ("spotify", _stub([_deezer("Get Lucky", "Daft Punk", 369.0, track_id="s")])),
        )
        result = ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)

        assert result.runner_up is None
        assert result.best.candidate.recording_mbid == "mbid-1"

    def test_no_enabled_metadata_provider_rejects_and_says_so(self):
        """Reachable when every provider is unavailable (no credentials)."""
        registry = ProviderRegistry()
        result = ResolutionService(
            config=Mock(), logger=Mock(), registry=registry, enable_cache=False
        ).resolve(TRACK)
        assert result.confidence is Confidence.REJECTED
        assert "no metadata providers are enabled" in result.explanation
