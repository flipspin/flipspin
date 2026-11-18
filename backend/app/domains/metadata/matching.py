"""Score recording candidates as STRONG, REVIEW or REJECTED.

Automatic acceptance requires a winner margin and a recording identifier.
See docs/DEVELOPER_GUIDE.md#recording-resolution.
"""
import logging
from dataclasses import dataclass, field
from enum import Enum
from collections.abc import Sequence

from app.domains.metadata.normalization import (
    normalize_key,
    qualifier_mismatch,
    string_distance,
)

logger = logging.getLogger(__name__)

# Relative weights. Title and artist carry the match; duration corroborates.
WEIGHT_TITLE = 3.0
WEIGHT_ARTIST = 3.0
WEIGHT_DURATION = 2.0

# Duration handling: a grace band that costs nothing, then a
# linear ramp. NOT a bucket — bucketing splits values 0.2s apart while merging
# values 3s apart.
DURATION_GRACE_S = 10.0
DURATION_MAX_S = 30.0

# Beyond this the candidate is a different recording, whatever the text says:
# a radio edit, an extended mix, or the wrong video entirely.
DURATION_VETO_S = 20.0

STRONG_MAX_DISTANCE = 0.10
REVIEW_MAX_DISTANCE = 0.35
# The winner must beat the runner-up by this much to be auto-accepted.
REQUIRED_GAP = 0.15


class Confidence(str, Enum):
    STRONG = "strong"
    REVIEW = "review"
    REJECTED = "rejected"


@dataclass
class WantedTrack:
    """What someone asked for. Usually from an export, so often duration-less."""

    title: str
    artist: str | None = None
    album: str | None = None
    duration_s: float | None = None


@dataclass
class Candidate:
    """A result from a metadata provider."""

    title: str
    provider: str
    provider_id: str
    artist: str | None = None
    album: str | None = None
    duration_s: float | None = None
    isrc: str | None = None
    recording_mbid: str | None = None
    cover_url: str | None = None

    @property
    def is_identifiable(self) -> bool:
        """Carries something that resolves to a stable recording identity."""
        return bool(self.recording_mbid or self.isrc)


@dataclass
class ScoredCandidate:
    candidate: Candidate
    distance: float
    reasons: list[str] = field(default_factory=list)
    vetoed: bool = False


@dataclass
class MatchResult:
    wanted: WantedTrack
    confidence: Confidence
    best: ScoredCandidate | None = None
    runner_up: ScoredCandidate | None = None
    explanation: str = ""

    @property
    def is_auto_acceptable(self) -> bool:
        return self.confidence is Confidence.STRONG

    def to_dict(self) -> dict:
        best = self.best
        return {
            "wanted": {
                "title": self.wanted.title,
                "artist": self.wanted.artist,
                "album": self.wanted.album,
            },
            "confidence": self.confidence.value,
            "explanation": self.explanation,
            "match": None if not best else {
                "title": best.candidate.title,
                "artist": best.candidate.artist,
                "album": best.candidate.album,
                "durationSeconds": best.candidate.duration_s,
                "provider": best.candidate.provider,
                "providerId": best.candidate.provider_id,
                "isrc": best.candidate.isrc,
                "recordingMbid": best.candidate.recording_mbid,
                "coverUrl": best.candidate.cover_url,
                "distance": round(best.distance, 4),
                "reasons": best.reasons,
            },
        }


def _duration_distance(wanted: float | None, candidate: float | None) -> float | None:
    """Grace band then linear ramp, or None when either side is unknown."""
    if wanted is None or candidate is None:
        return None
    diff = abs(wanted - candidate) - DURATION_GRACE_S
    if diff <= 0:
        return 0.0
    return min(1.0, diff / (DURATION_MAX_S - DURATION_GRACE_S))


def score_candidate(wanted: WantedTrack, candidate: Candidate) -> ScoredCandidate:
    """Weighted distance between what was asked for and what was found."""
    reasons: list[str] = []
    weighted_sum = 0.0
    total_weight = 0.0

    title_d = string_distance(wanted.title, candidate.title)
    weighted_sum += title_d * WEIGHT_TITLE
    total_weight += WEIGHT_TITLE
    if title_d > 0.3:
        reasons.append(f"title differs ({title_d:.2f})")

    if wanted.artist and candidate.artist:
        artist_d = string_distance(wanted.artist, candidate.artist)
        weighted_sum += artist_d * WEIGHT_ARTIST
        total_weight += WEIGHT_ARTIST
        if artist_d > 0.3:
            reasons.append(f"artist differs ({artist_d:.2f})")

    duration_d = _duration_distance(wanted.duration_s, candidate.duration_s)
    if duration_d is None:
        # Exports carry no duration, so this is the common case. Say so rather
        # than silently scoring on two fields and calling it confident.
        reasons.append("no duration to compare")
    else:
        weighted_sum += duration_d * WEIGHT_DURATION
        total_weight += WEIGHT_DURATION
        if duration_d > 0:
            reasons.append(f"duration differs by {abs((wanted.duration_s or 0) - (candidate.duration_s or 0)):.0f}s")

    distance = weighted_sum / total_weight if total_weight else 1.0
    scored = ScoredCandidate(candidate=candidate, distance=distance, reasons=reasons)

    # Vetoes: hard signals that outrank a good text score.
    if (
        wanted.duration_s is not None
        and candidate.duration_s is not None
        and abs(wanted.duration_s - candidate.duration_s) > DURATION_VETO_S
    ):
        scored.vetoed = True
        reasons.append(
            f"vetoed: duration off by {abs(wanted.duration_s - candidate.duration_s):.0f}s"
        )

    if qualifier_mismatch(wanted.title, candidate.title):
        scored.vetoed = True
        reasons.append("vetoed: one side is a live/remix/edit/instrumental version")

    return scored


def match_track(wanted: WantedTrack, candidates: Sequence[Candidate]) -> MatchResult:
    """Pick the best candidate and say how much to trust it."""
    if not candidates:
        return MatchResult(wanted=wanted, confidence=Confidence.REJECTED,
                           explanation="no candidates returned")

    scored = sorted(
        (score_candidate(wanted, c) for c in candidates),
        # Identifiable candidates win ties: same correctness, more use later.
        key=lambda s: (s.vetoed, round(s.distance, 4), not s.candidate.is_identifiable),
    )
    best = scored[0]
    runner_up = scored[1] if len(scored) > 1 else None

    if best.vetoed:
        return MatchResult(
            wanted=wanted, best=best, runner_up=runner_up,
            confidence=Confidence.REVIEW if best.distance <= REVIEW_MAX_DISTANCE else Confidence.REJECTED,
            explanation="best candidate was vetoed: " + "; ".join(
                r for r in best.reasons if r.startswith("vetoed")
            ),
        )

    if best.distance > REVIEW_MAX_DISTANCE:
        return MatchResult(wanted=wanted, best=best, runner_up=runner_up,
                           confidence=Confidence.REJECTED,
                           explanation=f"best distance {best.distance:.2f} exceeds "
                                       f"{REVIEW_MAX_DISTANCE}")

    if best.distance > STRONG_MAX_DISTANCE:
        return MatchResult(wanted=wanted, best=best, runner_up=runner_up,
                           confidence=Confidence.REVIEW,
                           explanation=f"distance {best.distance:.2f} needs confirmation")

    # Strong enough on its own — but only if it clearly beat the alternative.
    if runner_up and not runner_up.vetoed:
        gap = runner_up.distance - best.distance
        if gap < REQUIRED_GAP:
            return MatchResult(
                wanted=wanted, best=best, runner_up=runner_up,
                confidence=Confidence.REVIEW,
                explanation=f"too close to call: runner-up is only {gap:.2f} behind",
            )

    # An identity-less match cannot be verified later, so it does not get to
    # skip review no matter how well the strings line up.
    if not best.candidate.is_identifiable:
        return MatchResult(wanted=wanted, best=best, runner_up=runner_up,
                           confidence=Confidence.REVIEW,
                           explanation="good text match but no ISRC or MBID to pin it to")

    return MatchResult(wanted=wanted, best=best, runner_up=runner_up,
                       confidence=Confidence.STRONG,
                       explanation=f"distance {best.distance:.2f}, identified by "
                                   f"{'MBID' if best.candidate.recording_mbid else 'ISRC'}")


def fallback_key(track: WantedTrack) -> str:
    """Normalized key used when nothing resolved to an MBID."""
    return normalize_key(track.artist, track.title)
