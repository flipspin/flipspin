"""Prepare source artist/title candidates for the shared recording matcher.

Strip upload labels only; preserve live, remix and other recording qualifiers.
See docs/DEVELOPER_GUIDE.md#recording-resolution.
"""
import re
from dataclasses import dataclass
from typing import Any
from collections.abc import Sequence

from app.domains.metadata.matching import (
    REVIEW_MAX_DISTANCE,
    Candidate,
    Confidence,
    MatchResult,
    WantedTrack,
    match_track,
    score_candidate,
)
from app.domains.metadata.normalization import (
    fold_accents,
    has_preserved_qualifier,
    normalize_loose,
    qualifier_mismatch,
    string_distance,
)

from .sources.compat import LEGACY_SOURCE_ID

PROVIDER = LEGACY_SOURCE_ID

# Words that describe the *upload*, never the recording. Ordered longest-first so
# "official audio" is consumed as one phrase instead of leaving "audio" behind.
# Spanish spellings are here because the app's own users search in Spanish.
_FURNITURE_WORDS = (
    r"official\s+(?:music\s+)?(?:lyrics?\s+)?(?:video|audio|visuali[sz]er)",
    r"v[ií]deo\s+oficial",
    r"audio\s+oficial",
    r"lyrics?\s+video",
    r"music\s+video",
    r"visuali[sz]er",
    r"con\s+letra",
    r"full\s+hd",
    r"letras?",
    r"lyrics?",
    r"official",
    r"oficial",
    r"audio",
    # Bare "video"/"vid" is safe *because* of where it is applied: a bracket has
    # to be furniture end to end, and outside brackets only the tail is peeled.
    # "Audio Video Disco" and "Video Killed the Radio Star" both survive.
    r"v[ií]deos?",
    r"vids?",
    r"60fps",
    r"1080p?",
    r"720p?",
    r"hd",
    r"hq",
    r"4k",
    r"8k",
)
_FURNITURE_ALT = "|".join(_FURNITURE_WORDS)

_BRACKET_RE = re.compile(r"[\(\[]([^\(\)\[\]]*)[\)\]]")
_ANY_FURNITURE_RE = re.compile(rf"\b(?:{_FURNITURE_ALT})\b", re.IGNORECASE)
# Bare furniture is only removed from the *tail* ("Get Lucky Official Audio 4K").
# Removing it anywhere would eat the first word of "Audio Video Disco".
_TRAILING_FURNITURE_RE = re.compile(
    rf"[\s\-–—_|]*\b(?:{_FURNITURE_ALT})\b[\s\-–—_|]*$", re.IGNORECASE
)

_PIPE_RE = re.compile(r"\s*\|\s*")
# Only a spaced hyphen splits, so hyphenated words ("Wham-Bam") stay whole.
_DASH_RE = re.compile(r"\s*[–—]\s*|\s+-\s+")

_EDGE_JUNK = " -–—_|·,:\"'"

# No real title carries more than a couple of trailing badges; the cap just stops
# the peel loop from being unbounded.
_MAX_TRAILING_BADGES = 6



def _is_only_furniture(text: str) -> bool:
    """True when removing every furniture word leaves nothing but punctuation.

    Written as a substitution rather than one anchored "(furniture)+$" pattern
    on purpose: that shape backtracks catastrophically on a title that *nearly*
    matches, and a video title is attacker-adjacent input that runs on the
    request thread.
    """
    return not re.search(r"[^\W_]", _ANY_FURNITURE_RE.sub(" ", text))


def _strip_trailing_furniture(text: str) -> str:
    """Peel badges off the end one at a time — "Get Lucky Official Audio 4K"."""
    for _ in range(_MAX_TRAILING_BADGES):
        peeled = _TRAILING_FURNITURE_RE.sub("", text)
        if peeled == text:
            break
        text = peeled
    return text


def clean_video_title(raw: str) -> str:
    """Strip upload furniture, keeping anything that names a different recording."""
    if not raw:
        return ""
    text = raw.strip()

    # "Song (Official Video) | ArtistTV" — a pipe tail is channel branding often
    # enough that keeping it poisons the comparison. It is dropped unless it
    # carries a qualifier ("| Live at Glastonbury"), which the matcher needs.
    parts = _PIPE_RE.split(text)
    if len(parts) > 1:
        text = " ".join([parts[0]] + [p for p in parts[1:] if has_preserved_qualifier(p)])

    def _drop_bracket(match: "re.Match[str]") -> str:
        inner = match.group(1)
        if not inner.strip():
            return " "
        # A bracket group is dropped only when it is furniture *end to end*,
        # which is what keeps "(Live at Wembley)" and "(Nightcore Remix)" whole.
        if has_preserved_qualifier(inner) or not _is_only_furniture(inner):
            return match.group(0)
        return " "

    text = _BRACKET_RE.sub(_drop_bracket, text)
    text = _strip_trailing_furniture(text)
    return re.sub(r"\s+", " ", text).strip(_EDGE_JUNK)


def uploader_artist(uploader: str | None) -> str | None:
    """The artist behind a channel name, when the channel encodes one.

    source's auto-generated "<Artist> - Topic" channels and VEVO channels are
    the two cases where the uploader *is* the artist rather than a random name,
    so they are worth recovering when the title itself carries no artist.
    """
    if not uploader:
        return None
    name = re.sub(r"\s*-\s*topic\s*$", "", uploader, flags=re.IGNORECASE)
    name = re.sub(r"vevo\s*$", "", name, flags=re.IGNORECASE)
    name = name.strip(_EDGE_JUNK)
    return name or None




def split_query(query: str) -> tuple[str | None, str]:
    """Read a free-text query with the same convention video titles use.

    ``Daft Punk - Get Lucky`` typed into a search box is the same "Artist -
    Title" shape uploaders use, so parsing it the same way lets the two sides be
    compared field by field instead of as one long string against a short one.

    Guessing the wrong side is self-correcting rather than harmful: a candidate
    is oriented by comparing it against this artist, so a reversed query flips
    the candidate the same way and the two still line up.
    """
    parts = [p.strip() for p in _DASH_RE.split(query.strip(), maxsplit=1)]
    if len(parts) == 2 and all(parts):
        return parts[0], parts[1]
    return None, query.strip()


def _artist_inside_title(cleaned: str, artist: str) -> tuple[str, str] | None:
    """Split ``Daft Punk Get Lucky`` when the uploader never used a separator.

    Only splits on the supplied artist, so it cannot invent a match:
    the artist's own words had to be literally present in the video title.
    """
    words = normalize_loose(artist).split()
    if not words:
        return None
    pattern = re.compile(r"\b" + r"[\W_]+".join(re.escape(w) for w in words) + r"\b", re.IGNORECASE)

    match = pattern.search(cleaned)
    if not match:
        # Retry accent-folded: normalize_loose folded the artist, so "Mana"
        # would otherwise never find itself inside "Maná".
        cleaned = fold_accents(cleaned)
        match = pattern.search(cleaned)
        if not match:
            return None

    remainder = re.sub(r"\s+", " ", cleaned[: match.start()] + " " + cleaned[match.end():])
    remainder = remainder.strip(_EDGE_JUNK)
    if not remainder:
        return None
    return remainder, match.group(0)


def _split_artist_title(
    cleaned: str, wanted: WantedTrack, uploader: str | None
) -> tuple[str, str | None]:
    """Present the video in the same shape the request is in.

    The matcher scores title and artist as separate weighted fields, so a
    candidate has to be split the same way the wanted track is. When the request
    is only free text with no artist, splitting would compare half a video title
    against a whole query and reject good results, so the video is left whole.
    """
    parts = [p.strip() for p in _DASH_RE.split(cleaned, maxsplit=1)]

    if wanted.artist:
        if len(parts) == 2 and all(parts):
            left, right = parts
            # "Artist - Title" is the convention, but "Title - Artist" is common
            # enough that guessing wrong costs a real match. Ask which side looks
            # like the supplied artist rather than assuming.
            if string_distance(wanted.artist, right) < string_distance(wanted.artist, left):
                return left, right
            return right, left

        split = _artist_inside_title(cleaned, wanted.artist)
        if split:
            return split

        return cleaned, uploader_artist(uploader)

    # No artist on the wanted side: it is unclear whether the query
    # included the artist ("get lucky" vs "daft punk get lucky"), so the video is
    # offered in whichever of its own honest forms the query was written in.
    # This only ever chooses between representations of the *same* video, so it
    # cannot tip the matcher's runner-up gap check from one video to another.
    forms = [cleaned]
    if len(parts) == 2:
        forms += [p for p in parts if p]
    # A form that dropped a "(Live)" would blind the qualifier veto, so only
    # forms carrying the same qualifiers as the whole title are allowed.
    forms = [f for f in forms if not qualifier_mismatch(f, cleaned)] or [cleaned]
    return min(forms, key=lambda f: string_distance(wanted.title, f)), None


def source_candidate(result: dict[str, Any], wanted: WantedTrack, *, provider=PROVIDER) -> Candidate | None:
    """Build a candidate using only evidence present in the source result.

    These results have no ISRC or MBID, so matching cannot grade them STRONG;
    select_video accepts REVIEW after the other recording checks.
    """
    raw_title = (result.get("title") or "").strip()
    url = result.get("url")
    if not raw_title or not url:
        return None

    cleaned = clean_video_title(raw_title)
    if not cleaned:
        return None

    title, artist = _split_artist_title(cleaned, wanted, result.get("artist"))
    duration = result.get("duration")

    return Candidate(
        title=title,
        artist=artist,
        duration_s=float(duration) if isinstance(duration, (int, float)) else None,
        provider=provider,
        provider_id=result.get("id") or url,
    )


@dataclass
class VideoChoice:
    """The video to download, or nothing plus the reason there is nothing."""

    url: str | None
    reason: str
    match: MatchResult | None = None

    @property
    def accepted(self) -> bool:
        return self.url is not None


def select_video(wanted: WantedTrack, search_results: Sequence[dict[str, Any]], *, provider=PROVIDER) -> VideoChoice:
    """Select a non-vetoed source candidate for the requested recording.

    Videos lack recording ids, so an otherwise valid REVIEW is acceptable.
    Qualifier and duration vetoes still refuse a result.
    See docs/DEVELOPER_GUIDE.md#recording-resolution.
    """
    candidates: list[Candidate] = []
    url_by_id: dict[str, str] = {}
    for raw in search_results:
        candidate = source_candidate(raw, wanted, provider=provider)
        if candidate is None:
            continue
        candidates.append(candidate)
        url_by_id[candidate.provider_id] = raw.get("url")

    if not candidates:
        return VideoChoice(url=None, reason="no usable source results")

    result = match_track(wanted, candidates)
    best = result.best

    if best is None or result.confidence is Confidence.REJECTED or best.vetoed:
        detail = result.explanation or "no candidate was close enough"
        if best is not None:
            detail = f"{detail} (best was '{best.candidate.title}')"
        return VideoChoice(url=None, reason=f"no source result matched: {detail}", match=result)

    url = url_by_id.get(best.candidate.provider_id)
    if not url:
        return VideoChoice(url=None, reason="matched result carried no URL", match=result)

    return VideoChoice(
        url=url,
        reason=f"{result.confidence.value}: {result.explanation}",
        match=result,
    )


#: How many further candidates one fetch attempt may try after the chosen one.
MAX_ALTERNATES = 3


def ranked_alternates(wanted: WantedTrack, search_results: Sequence[dict[str, Any]], *,
                      chosen: str | None, exclude: Sequence[str] = (), provider=PROVIDER,
                      limit: int = MAX_ALTERNATES) -> tuple[str, ...]:
    """Acceptable candidates after ``chosen``, best first, for when a fetch finds the chosen one gone.

    Uses the same scoring and order as `match_track` and the same bar as `select_video`
    (not vetoed, within review distance), so an alternate is never a worse class of
    match than one `select_video` would have accepted on its own.
    """
    scored = []
    for raw in search_results:
        url = raw.get("url")
        candidate = source_candidate(raw, wanted, provider=provider)
        if candidate is None or not url or url == chosen or url in exclude:
            continue
        scored.append((score_candidate(wanted, candidate), url))
    scored.sort(key=lambda pair: (pair[0].vetoed, round(pair[0].distance, 4), not pair[0].candidate.is_identifiable))
    picks: list[str] = []
    for score, url in scored:
        if score.vetoed or score.distance > REVIEW_MAX_DISTANCE or url in picks:
            continue
        picks.append(url)
        if len(picks) == limit:
            break
    return tuple(picks)
