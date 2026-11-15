"""Normalize artist/title identity without merging different recordings.

Fold accents, case, and punctuation; preserve live, remix, edit, and instrumental
qualifiers while stripping remaster noise. Filename clean_title is unsuitable
here because it discards recording distinctions. Duration remains a separate
identity check when no recording MBID is available.
"""
import re
import unicodedata
from difflib import SequenceMatcher

# Removed: none of these change which recording a string names.
_STRIP_PATTERNS = (
    # "feat. X", "ft X", "featuring X" — inside brackets or trailing.
    r"[\(\[]\s*(?:feat|ft|featuring|with)\b[^\)\]]*[\)\]]",
    r"\s+-?\s*(?:feat|ft|featuring)\.?\s+.*$",
    # Remaster / reissue markers, with or without a year, bracketed or dashed.
    r"[\(\[][^\)\]]*\b(?:remaster(?:ed)?|re-?issue|re-?master)\b[^\)\]]*[\)\]]",
    r"\s+-\s*\d{0,4}\s*\b(?:remaster(?:ed)?|re-?issue)\b.*$",
    # Packaging noise.
    r"[\(\[][^\)\]]*\b(?:bonus\s*track|album\s*version|original\s*mix|"
    r"deluxe|expanded|anniversary\s*edition)\b[^\)\]]*[\)\]]",
    r"\s+-\s*(?:single|ep)$",
)

# Kept: per MusicBrainz style these mark a DIFFERENT recording. Listed so the
# intent is explicit and testable, not merely implied by absence.
PRESERVED_QUALIFIERS = (
    "live", "acoustic", "remix", "radio edit", "single edit", "edit",
    "instrumental", "demo", "clean", "explicit", "unplugged", "reprise",
    "mono", "stereo", "karaoke", "cover",
)

_ARTICLES = ("the", "a", "an", "el", "la", "los", "las", "un", "una")

_strip_res = tuple(re.compile(p, re.IGNORECASE) for p in _STRIP_PATTERNS)
_preserve_re = re.compile(
    r"\b(" + "|".join(re.escape(q) for q in PRESERVED_QUALIFIERS) + r")\b",
    re.IGNORECASE,
)


def has_remaster_suffix(title: str) -> bool:
    """Use the remaster/reissue rules shared with recording normalization."""
    title = title or ''
    for pattern in _strip_res[:2]:
        title = pattern.sub(' ', title)
    return any(pattern.search(title) for pattern in _strip_res[2:4])


def fold_accents(text: str) -> str:
    """Decompose and drop combining marks: ``Blümchen`` -> ``Blumchen``."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def has_preserved_qualifier(text: str) -> bool:
    """True if the string carries a marker that changes recording identity."""
    return bool(_preserve_re.search(text or ""))


def strip_noise(text: str) -> str:
    """Remove decoration that does not change which recording is named.

    Applied *before* the aggressive normalization in :func:`normalize_key`, so
    the preserved qualifiers still survive into the key and keep a live version
    distinct from a studio one.
    """
    if not text:
        return ""
    out = text
    for pattern in _strip_res:
        out = pattern.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip(" -–—")


def move_leading_article(text: str) -> str:
    """``Beatles, The`` -> ``The Beatles``, so both spellings normalize alike."""
    match = re.match(r"^(.*),\s*(\w+)$", text.strip())
    if match and match.group(2).lower() in _ARTICLES:
        return f"{match.group(2)} {match.group(1)}".strip()
    return text


def normalize_key(artist: str | None, title: str) -> str:
    """Build the fallback identity key for a track.

    Not a display string and not reversible — it exists only to be compared.
    """
    cleaned_title = strip_noise(title or "")
    cleaned_artist = strip_noise(move_leading_article(artist or ""))

    combined = f"{cleaned_artist}{cleaned_title}"
    folded = fold_accents(combined).lower()
    return re.sub(r"[^a-z0-9]", "", folded)


def normalize_loose(text: str) -> str:
    """Fold and lowercase for fuzzy comparison, keeping word boundaries."""
    folded = fold_accents(strip_noise(text or "")).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", folded)).strip()


def string_distance(left: str, right: str) -> float:
    """Distance in ``[0.0, 1.0]``; 0.0 is identical.

    A Levenshtein distance normalized by the longer string is the textbook
    choice; ``difflib`` is stdlib and close enough at this scale. The absolute
    values differ slightly from Levenshtein's, which is why the thresholds in
    `matching.py` were tuned against this function specifically.
    """
    a, b = normalize_loose(left), normalize_loose(right)
    if not a and not b:
        return 0.0
    if not a or not b:
        return 1.0
    if a == b:
        return 0.0
    return 1.0 - SequenceMatcher(None, a, b).ratio()


def qualifier_mismatch(left: str, right: str) -> bool:
    """True when one side carries an identity-changing marker the other lacks.

    ``Get Lucky`` vs ``Get Lucky (Radio Edit)`` is the case this catches, and it
    is the exact failure that swaps an explicit track for the clean one (or
    the reverse) in a naive matcher. Treated as a hard signal rather than a small distance penalty,
    because the strings are otherwise nearly identical.
    """
    found_left = {m.group(1).lower() for m in _preserve_re.finditer(left or "")}
    found_right = {m.group(1).lower() for m in _preserve_re.finditer(right or "")}
    return found_left != found_right
