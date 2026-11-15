"""Preserve recording distinctions while folding remaster noise.

Live, edit, instrumental, and clean/explicit variants must not merge merely
because their base title matches.
"""
import pytest

from app.domains.metadata.matching import (
    Candidate,
    Confidence,
    WantedTrack,
    fallback_key,
    match_track,
    score_candidate,
)
from app.domains.metadata.normalization import (
    fold_accents,
    has_preserved_qualifier,
    move_leading_article,
    normalize_key,
    qualifier_mismatch,
    string_distance,
    strip_noise,
)


class TestNormalization:
    def test_folds_accents(self):
        assert fold_accents("Blümchen") == "Blumchen"
        assert fold_accents("Café Tacvba") == "Cafe Tacvba"
        assert fold_accents("Maná") == "Mana"

    @pytest.mark.parametrize("raw,expected_absent", [
        ("Get Lucky (feat. Pharrell Williams)", "pharrell"),
        ("Get Lucky feat. Pharrell Williams", "pharrell"),
        ("Tabula Rasa (feat. Lorraine Weiss)", "lorraine"),
        ("Don't Give Up - 2001 Remaster", "remaster"),
        ("Bohemian Rhapsody (2011 Remastered)", "remaster"),
        ("Song Title (Bonus Track)", "bonus"),
        ("Song Title (Album Version)", "album version"),
    ])
    def test_strips_noise_that_does_not_change_identity(self, raw, expected_absent):
        assert expected_absent not in strip_noise(raw).lower()

    @pytest.mark.parametrize("raw,kept", [
        ("Song (Live at Wembley)", "live"),
        ("Song - Radio Edit", "radio edit"),
        ("Song (Acoustic)", "acoustic"),
        ("Song (Instrumental)", "instrumental"),
        ("Song (Clean)", "clean"),
        ("Song (Explicit)", "explicit"),
        ("Song (Nightcore Remix)", "remix"),
        ("Song (Demo)", "demo"),
    ])
    def test_preserves_markers_that_do_change_identity(self, raw, kept):
        assert kept in strip_noise(raw).lower()
        assert has_preserved_qualifier(raw)

    def test_remaster_and_original_produce_the_same_key(self):
        """MusicBrainz style: a remaster is the SAME recording."""
        a = normalize_key("Queen", "Bohemian Rhapsody")
        b = normalize_key("Queen", "Bohemian Rhapsody - 2011 Remaster")
        assert a == b

    def test_live_and_studio_produce_different_keys(self):
        """MusicBrainz style: a live performance is ALWAYS a different recording."""
        a = normalize_key("Queen", "Bohemian Rhapsody")
        b = normalize_key("Queen", "Bohemian Rhapsody (Live at Wembley)")
        assert a != b

    def test_featuring_credit_does_not_split_a_song(self):
        a = normalize_key("Daft Punk", "Get Lucky")
        b = normalize_key("Daft Punk", "Get Lucky (feat. Pharrell Williams)")
        assert a == b

    def test_punctuation_and_case_are_irrelevant(self):
        assert normalize_key("AC/DC", "T.N.T.") == normalize_key("acdc", "tnt")

    def test_moves_trailing_article(self):
        assert move_leading_article("Beatles, The") == "The Beatles"
        assert move_leading_article("Strokes, The") == "The Strokes"
        assert move_leading_article("Daft Punk") == "Daft Punk"

    def test_key_is_empty_for_empty_input(self):
        assert normalize_key(None, "") == ""

    def test_string_distance_bounds(self):
        assert string_distance("Get Lucky", "Get Lucky") == 0.0
        assert string_distance("Get Lucky", "") == 1.0
        assert 0.0 < string_distance("Get Lucky", "Get Luck") < 0.5


class TestQualifierMismatch:
    def test_detects_a_one_sided_edit_marker(self):
        assert qualifier_mismatch("Get Lucky", "Get Lucky (Radio Edit)")

    def test_detects_clean_versus_explicit(self):
        assert qualifier_mismatch("Song (Clean)", "Song (Explicit)")

    def test_matching_markers_are_not_a_mismatch(self):
        assert not qualifier_mismatch("Song (Live)", "Song (Live at Wembley)")

    def test_no_markers_at_all_is_not_a_mismatch(self):
        assert not qualifier_mismatch("Get Lucky", "Get Lucky")


class TestScoring:
    def test_identical_track_scores_zero(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        cand = Candidate(title="Get Lucky", artist="Daft Punk", duration_s=369.0,
                         provider="deezer", provider_id="1", isrc="USQX91300809")
        assert score_candidate(wanted, cand).distance == pytest.approx(0.0)

    def test_small_duration_difference_is_free(self):
        """Encoder padding and intro cards routinely cost a few seconds."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        cand = Candidate(title="Get Lucky", artist="Daft Punk", duration_s=375.0,
                         provider="deezer", provider_id="1")
        assert score_candidate(wanted, cand).distance == pytest.approx(0.0)

    def test_missing_duration_is_reported_not_penalised(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = Candidate(title="Get Lucky", artist="Daft Punk", duration_s=369.0,
                         provider="deezer", provider_id="1")
        scored = score_candidate(wanted, cand)
        assert scored.distance == pytest.approx(0.0)
        assert "no duration to compare" in scored.reasons

    def test_large_duration_gap_vetoes(self):
        """The real Deezer result: album 369s vs Radio Edit 248s."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        cand = Candidate(title="Get Lucky", artist="Daft Punk", duration_s=248.0,
                         provider="deezer", provider_id="1")
        assert score_candidate(wanted, cand).vetoed

    def test_qualifier_mismatch_vetoes_even_with_perfect_text(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        cand = Candidate(title="Get Lucky (Radio Edit)", artist="Daft Punk",
                         provider="deezer", provider_id="1")
        assert score_candidate(wanted, cand).vetoed


class TestMatchDecision:
    def _cand(self, title, artist="Daft Punk", **kw):
        kw.setdefault("provider", "deezer")
        kw.setdefault("provider_id", "1")
        return Candidate(title=title, artist=artist, **kw)

    def test_no_candidates_is_rejected(self):
        result = match_track(WantedTrack(title="Get Lucky"), [])
        assert result.confidence is Confidence.REJECTED

    def test_clear_identified_winner_is_strong(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        result = match_track(wanted, [
            self._cand("Get Lucky", isrc="USQX91300809"),
            self._cand("Something Else Entirely", artist="Another Band"),
        ])
        assert result.confidence is Confidence.STRONG
        assert result.best.candidate.isrc == "USQX91300809"

    def test_good_match_without_an_identifier_still_needs_review(self):
        """Nothing to pin it to means nothing to verify against later."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        result = match_track(wanted, [self._cand("Get Lucky")])
        assert result.confidence is Confidence.REVIEW
        assert "no ISRC or MBID" in result.explanation

    def test_two_near_identical_candidates_go_to_review(self):
        """The gap check: a tie must not be resolved silently."""
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        result = match_track(wanted, [
            self._cand("Get Lucky", isrc="AAA", provider_id="1"),
            self._cand("Get Lucky", isrc="BBB", provider_id="2"),
        ])
        assert result.confidence is Confidence.REVIEW
        assert "too close to call" in result.explanation

    def test_radio_edit_candidate_does_not_auto_accept(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk", duration_s=369.0)
        result = match_track(wanted, [
            self._cand("Get Lucky (Radio Edit)", duration_s=248.0, isrc="USQX91300809"),
        ])
        assert result.confidence is not Confidence.STRONG
        assert "vetoed" in result.explanation

    def test_unrelated_candidate_is_rejected(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        result = match_track(wanted, [self._cand("Despacito", artist="Luis Fonsi")])
        assert result.confidence is Confidence.REJECTED

    def test_identifiable_candidate_wins_a_tie(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        result = match_track(wanted, [
            self._cand("Get Lucky", provider_id="plain"),
            self._cand("Get Lucky", provider_id="identified", recording_mbid="abc-123"),
        ])
        assert result.best.candidate.provider_id == "identified"

    def test_to_dict_shape_is_frontend_ready(self):
        wanted = WantedTrack(title="Get Lucky", artist="Daft Punk")
        result = match_track(wanted, [self._cand("Get Lucky", isrc="X")])
        payload = result.to_dict()
        assert payload["confidence"] in {c.value for c in Confidence}
        assert payload["match"]["isrc"] == "X"
        assert "explanation" in payload


class TestFallbackKey:
    def test_same_song_different_decoration_shares_a_key(self):
        a = fallback_key(WantedTrack(title="Get Lucky (feat. Pharrell)", artist="Daft Punk"))
        b = fallback_key(WantedTrack(title="Get Lucky", artist="Daft Punk"))
        assert a == b

    def test_live_version_gets_its_own_key(self):
        a = fallback_key(WantedTrack(title="Get Lucky", artist="Daft Punk"))
        b = fallback_key(WantedTrack(title="Get Lucky (Live)", artist="Daft Punk"))
        assert a != b
