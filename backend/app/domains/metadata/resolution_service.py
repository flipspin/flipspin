"""Resolve requested tracks through ordered metadata providers.

Stop at STRONG; fold duplicate recordings before evaluating the winner margin.
See docs/DEVELOPER_GUIDE.md#recording-resolution.
"""
import logging
from collections.abc import Callable, Sequence
from typing import Protocol

from app.config import ConfigManager
from app.domains.metadata.matching import (
    DURATION_GRACE_S,
    Candidate,
    Confidence,
    MatchResult,
    WantedTrack,
    match_track,
)
from app.domains.metadata.normalization import normalize_key
from app.exceptions import KrobiException
from app.providers.registry import ProviderKind, ProviderRegistry

DEFAULT_CANDIDATE_LIMIT = 5

# progress_callback(completed, total, latest_result)
ProgressCallback = Callable[[int, int, MatchResult], None]
CancelCheck = Callable[[], bool]


class TrackRequest(Protocol):
    """Define resolution input here so metadata need not import a producer's domain."""

    title: str
    artist: str | None
    album: str | None

    @property
    def search_query(self) -> str: ...


class ResolutionService:
    """Resolve exported tracks to scored, identified candidates."""

    def __init__(
        self,
        config: ConfigManager,
        logger: logging.Logger,
        registry: ProviderRegistry | None = None,
        candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
        enable_cache: bool = True,
    ):
        """Compose ordered metadata resolution with optional identity caching.

        Production passes the shared registry so provider settings apply consistently.
        See docs/DEVELOPER_GUIDE.md#provider-preferences.
        """
        self.config = config
        self.logger = logger
        if registry is None:
            # Imported here, not at module scope: the adapters pull in every
            # provider repository, and this module is imported lazily by the
            # playlist routes precisely so a missing piece fails one feature.
            from app.providers.adapters import build_default_registry

            registry = build_default_registry(config, logger)
        self.registry = registry
        self.candidate_limit = max(1, int(candidate_limit))
        self.enable_cache = enable_cache
        self._cache: dict[str, MatchResult] = {}

    # ------------------------------------------------------------------ public

    def resolve(self, track: TrackRequest) -> MatchResult:
        """Resolve one exported track to a :class:`MatchResult`.

        Never raises for provider trouble: a dead provider degrades to the rest
        of the list and is reported in ``MatchResult.explanation``.
        """
        wanted = WantedTrack(
            title=track.title,
            artist=track.artist,
            album=track.album,
            # Exports carry no duration. Stated rather than guessed: it means
            # duration can neither corroborate nor veto, which is the single
            # biggest reason results land in REVIEW instead of STRONG.
            duration_s=None,
        )

        cache_key = normalize_key(track.artist, track.title)
        if self.enable_cache and cache_key in self._cache:
            cached = self._cache[cache_key]
            return MatchResult(
                wanted=wanted,
                confidence=cached.confidence,
                best=cached.best,
                runner_up=cached.runner_up,
                explanation=cached.explanation,
            )

        notes: list[str] = []
        result = self._resolve_uncached(track, wanted, notes)
        if notes:
            result.explanation = "; ".join([result.explanation] + notes) if result.explanation \
                else "; ".join(notes)
        if self.enable_cache:
            self._cache[cache_key] = result
        return result

    def resolve_many(
        self,
        tracks: Sequence[TrackRequest],
        progress_callback: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> list[MatchResult]:
        """Resolve tracks in order, checking cancellation before each item.

        Report (completed, total, result) after each track; callback failures are logged.
        Per-track failures become REJECTED results. Cancellation returns fewer results.
        See docs/DEVELOPER_GUIDE.md#recording-resolution.
        """
        results: list[MatchResult] = []
        total = len(tracks)
        for track in tracks:
            if should_cancel is not None and should_cancel():
                self.logger.info(
                    "Track resolution cancelled after %d/%d tracks", len(results), total
                )
                break
            try:
                result = self.resolve(track)
            except Exception as e:
                self.logger.error(
                    "Resolution of %r raised %s: %s", track.title, type(e).__name__, e
                )
                result = MatchResult(
                    wanted=WantedTrack(
                        title=track.title, artist=track.artist, album=track.album
                    ),
                    confidence=Confidence.REJECTED,
                    explanation=f"resolution failed: {type(e).__name__}",
                )
            results.append(result)
            if progress_callback is not None:
                try:
                    progress_callback(len(results), total, result)
                except Exception as e:
                    self.logger.warning("Resolution progress callback failed: %s", e)
        return results

    def clear_cache(self) -> None:
        self._cache.clear()

    # ----------------------------------------------------------------- private

    def _resolve_uncached(
        self, track: TrackRequest, wanted: WantedTrack, notes: list[str]
    ) -> MatchResult:
        """Stop at the first STRONG match to avoid unnecessary provider requests.

        Fold duplicates within each provider and across the accumulated pool so the
        same recording cannot compete with itself in the runner-up gap check.
        """
        provider_ids = self.registry.order(ProviderKind.METADATA)
        if not provider_ids:
            # Reachable only if every metadata provider is unavailable (no
            # credentials) — the registry refuses to let the last enabled one be
            # switched off. Say which it is rather than implying the song does
            # not exist.
            return MatchResult(
                wanted=wanted,
                confidence=Confidence.REJECTED,
                explanation="no metadata providers are enabled",
            )

        pool: list[Candidate] = []
        result: MatchResult | None = None

        for position, provider_id in enumerate(provider_ids):
            fresh = _fold_duplicates(self._query_provider(provider_id, track, wanted, notes))
            if not fresh:
                continue
            # The pool is primary, so the earlier (higher-ranked) provider keeps
            # its row and later ones only fill in fields it was missing.
            pool = _merge_across_providers(pool, fresh)
            result = match_track(wanted, pool)
            if result.confidence is Confidence.STRONG:
                skipped = provider_ids[position + 1:]
                if skipped:
                    notes.append(
                        f"{', '.join(skipped)} not queried "
                        f"({provider_id} match was already strong)"
                    )
                return result

        if result is None:
            return MatchResult(
                wanted=wanted,
                confidence=Confidence.REJECTED,
                explanation="no candidates from any provider",
            )
        return result

    def _query_provider(
        self,
        provider_id: str,
        track: TrackRequest,
        wanted: WantedTrack,
        notes: list[str],
    ) -> list[Candidate]:
        """Ask one registered provider for candidates, in its best dialect.

        ``search_wanted`` is preferred wherever a provider offers it: MusicBrainz
        scores a fielded ``recording:"..." AND artist:"..."`` query far more
        sharply than the same words as free text, and an export carries no
        duration for the matcher to corroborate with, so that sharpness is what
        keeps escalated tracks out of the review pile. Providers with nothing
        better to offer just get the free-text query.
        """
        instance = self.registry.instance(provider_id)
        structured = getattr(instance, "search_wanted", None)

        if callable(structured):
            def call() -> list[Candidate]:
                return structured(wanted, self.candidate_limit)
        else:
            def call() -> list[Candidate]:
                return instance.search_candidates(track.search_query, self.candidate_limit)

        return self._call_provider(provider_id, call, notes)

    def _call_provider(
        self, name: str, call: Callable[[], list[Candidate]], notes: list[str]
    ) -> list[Candidate]:
        """Run one provider. A failure degrades the resolution, never fails it."""
        try:
            return call()
        except KrobiException as e:
            self.logger.warning("%s lookup failed: %s", name, e.message)
            notes.append(f"{name} unavailable: {e.message}")
        except Exception as e:  # a provider bug must not sink a 2000-track import
            self.logger.warning("%s lookup raised %s: %s", name, type(e).__name__, e)
            notes.append(f"{name} failed: {type(e).__name__}")
        return []


# --------------------------------------------------------------------- merging


def _same_recording(left: Candidate, right: Candidate) -> bool:
    """Two candidates that name the same recording for matching purposes.

    Normalized key equality plus the matcher's grace band on duration. The key
    preserves live/remix/edit qualifiers (see `normalization.py`), so a radio
    edit never folds into its album version — and the duration band catches the
    case where two pressings share a title but are demonstrably different cuts.
    Unknown duration on either side does not block the fold; refusing to fold
    on missing data is what produces the zero-gap review pile-up.
    """
    if normalize_key(left.artist, left.title) != normalize_key(right.artist, right.title):
        return False
    if left.duration_s is not None and right.duration_s is not None:
        return abs(left.duration_s - right.duration_s) <= DURATION_GRACE_S
    return True


def _fold_into(primary: Candidate, other: Candidate) -> None:
    """Absorb the identity/detail fields ``primary`` is missing."""
    if not primary.isrc and other.isrc:
        primary.isrc = other.isrc
    if not primary.recording_mbid and other.recording_mbid:
        primary.recording_mbid = other.recording_mbid
    if not primary.cover_url and other.cover_url:
        primary.cover_url = other.cover_url
    if not primary.album and other.album:
        primary.album = other.album
    if primary.duration_s is None and other.duration_s is not None:
        primary.duration_s = other.duration_s


def _fold_duplicates(candidates: list[Candidate]) -> list[Candidate]:
    """Collapse one provider's own re-pressings of the same recording.

    Deezer returns the album, single and greatest-hits rows of a song with
    identical title and artist; left alone they score identically and the
    runner-up gap check sends a perfectly good match to human review. Every
    provider added to the list is another chance for this to happen, which is
    why folding gets *more* load-bearing as the registry grows, not less.
    """
    kept: list[Candidate] = []
    for candidate in candidates:
        existing = next((k for k in kept if _same_recording(k, candidate)), None)
        if existing is None:
            kept.append(candidate)
        else:
            _fold_into(existing, candidate)
    return kept


def _merge_across_providers(
    primary: list[Candidate], secondary: list[Candidate]
) -> list[Candidate]:
    """Union of two candidate lists with same-recording entries folded.

    ``primary`` is the accumulated pool, so the provider that was asked *first*
    keeps its row and its provider identity; a later provider only contributes
    the fields the earlier one lacked. That is the right way round in both
    directions of the default order: a MusicBrainz ``recording_mbid`` folded
    into a Deezer row is the field that actually matters downstream, while the
    reverse would discard the Deezer track id and the ISRC.
    """
    merged = list(primary)
    for candidate in secondary:
        existing = next((m for m in merged if _same_recording(m, candidate)), None)
        if existing is None:
            merged.append(candidate)
        else:
            _fold_into(existing, candidate)
    return merged
