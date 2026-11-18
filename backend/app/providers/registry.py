"""Register provider capabilities and compute their effective preference order.

Keep enabled separate from credential availability; dispatch by declared capability.
See docs/DEVELOPER_GUIDE.md#provider-preferences.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable
from collections.abc import Sequence

from app.domains.metadata.matching import Candidate, WantedTrack
import builtins

if TYPE_CHECKING:  # the lyrics domain imports this module; keep the edge one-way
    from app.domains.lyrics.models import LyricsCandidate, LyricsQuery


class ProviderKind(str, Enum):
    """The question a provider can answer.

    Only kinds that have a consumer: a kind for a surface Flipspin does not have
    (discovery, say) would be invented before its consumer exists, which is how
    enums rot. Adding one later is a single member.
    """

    METADATA = "metadata"      # resolve a track to a real recording
    LYRICS = "lyrics"
    STREAMING = "streaming"    # find + fetch actual audio
    DASHBOARD = "dashboard"    # charts / editorial browsing rows

    @property
    def is_required(self) -> bool:
        """Require an enabled metadata provider.

        Streaming, lyrics and dashboard may be disabled entirely.
        See docs/DEVELOPER_GUIDE.md#provider-preferences.
        """
        return self == ProviderKind.METADATA


class Capability:
    """Declare methods a consumer may dispatch without naming a provider.

    Check the descriptor rather than hasattr: method presence does not establish
    support. See docs/DEVELOPER_GUIDE.md#provider-preferences.
    """

    #: Supplies an ISRC, which is what makes a candidate STRONG-eligible;
    #: `matching.py` will not auto-accept one carrying neither ISRC nor MBID.
    ISRC = "isrc"
    MBID = "mbid"
    FIELDED_SEARCH = "fielded-search"
    LYRICS = "lyrics"
    #: The provider can return timestamped (LRC) lyrics, not only text.
    LYRICS_SYNCED = "lyrics:synced"
    AUDIO = "audio"
    DOWNLOAD = "download"

    #: Typed catalog search, one per result category.
    SEARCH_ARTISTS = "search:artists"
    SEARCH_ALBUMS = "search:albums"
    SEARCH_TRACKS = "search:tracks"
    SEARCH_PLAYLISTS = "search:playlists"

    #: Catalog navigation.
    ARTIST_DETAILS = "artist:details"
    ARTIST_TOP = "artist:top"
    ARTIST_ALBUMS = "artist:albums"
    ARTIST_RELATED = "artist:related"
    ARTIST_PLAYLISTS = "artist:playlists"
    ARTIST_BIO = "artist:bio"
    ALBUM_DETAILS = "album:details"
    PLAYLIST_DETAILS = "playlist:details"
    #: A genre's own chart (top songs, albums, artists, lists).
    GENRE_DETAILS = "genre:details"


#: The artist-page sections, in render order, paired with the capability that
#: gates each. Consumed by the browse service so adding a section is one entry
#: here rather than a new branch in three places.
ARTIST_SECTION_CAPABILITIES = (
    ("top", Capability.ARTIST_TOP),
    ("albums", Capability.ARTIST_ALBUMS),
    ("related", Capability.ARTIST_RELATED),
    ("playlists", Capability.ARTIST_PLAYLISTS),
)

#: Search categories paired with the capability that gates each.
SEARCH_CATEGORY_CAPABILITIES = (
    ("artists", Capability.SEARCH_ARTISTS),
    ("albums", Capability.SEARCH_ALBUMS),
    ("tracks", Capability.SEARCH_TRACKS),
    ("playlists", Capability.SEARCH_PLAYLISTS),
)


@dataclass(frozen=True)
class ProviderDescriptor:
    """Describe stable provider identity and capabilities separately from its client.

    Persisted ids retain saved ordering and toggles across upgrades. Capabilities,
    such as recording identifiers, determine whether a match can be auto-accepted.
    """

    id: str
    kind: ProviderKind
    name: str
    description: str
    enabled_by_default: bool = True
    requires_credentials: bool = False
    capabilities: tuple[str, ...] = ()
    requires_explicit_opt_in: bool = False


# ------------------------------------------------------------------ protocols
#
# Providers are NOT required to subclass any of these. The registry checks for
# the methods it needs, and the existing repositories are wrapped by thin
# adapters in `app.providers.adapters` rather than rewritten — several of them
# encode hard-won behaviour (Deezer's quota backoff, MusicBrainz's mandatory
# User-Agent and 1 req/s limiter) that must not be disturbed.


class MetadataProvider(Protocol):
    """Resolve free text to scoreable candidates."""

    def search_candidates(self, query: str, limit: int) -> list[Candidate]: ...


@runtime_checkable
class StructuredMetadataSearch(Protocol):
    """Preserve structured search when a provider supports it.

    Fielded MusicBrainz queries reduce ambiguity when exports lack duration.
    Other providers fall back to free-text search_candidates.
    """

    def search_wanted(self, wanted: WantedTrack, limit: int) -> list[Candidate]: ...


class LyricsProvider(Protocol):
    """Answer a song's words as *candidates*, never as one string.

    The consumer (``domains/lyrics``) asks every enabled lyrics provider and
    ranks, because the person chooses in a list — so a provider returns what it
    has (synced, plain, or an ``instrumental`` verdict) with the duration it
    knows, and leaves the ±2 s veto and the ordering to the service. The old
    ``fetch_lyrics(artist, title) -> str`` shape hid exactly the information
    the modal needs (which recording, how long, is it timed).
    """

    def search_lyrics(self, query: LyricsQuery) -> list[LyricsCandidate]: ...


class StreamingProvider(Protocol):
    """Find, then resolve to something an acquisition tool can fetch."""

    def search_candidates(self, query: str, limit: int) -> list[Candidate]: ...

    def resolve_stream(self, candidate_id: str) -> str: ...


class DashboardProvider(Protocol):
    """Charts / editorial rows for the browse page.

    The row and item dataclasses deliberately live in
    ``app/domains/dashboard/models.py``, not here. They are a *persistence*
    surface as well as a transport one — the dashboard caches rows to disk and
    reads them back on the next start, so they carry ``stale`` and tolerant
    ``to_dict``/``from_dict`` that mean nothing to a registry. Duplicating a
    thinner copy here would give two definitions that drift; the annotation is
    left loose instead and that module is the authority.
    """

    def get_rows(self) -> list[Any]: ...


@runtime_checkable
class ReportsAvailability(Protocol):
    """Optional. A provider that can be unusable at runtime says why here.

    Returning ``None`` means "usable". The string is shown to the user verbatim,
    so it must name the thing they have to go and do.
    """

    def unavailable_reason(self) -> str | None: ...


# --------------------------------------------------------------------- errors


class ProviderError(Exception):
    """Base for registry misuse. Routes map these to 404/422."""


class UnknownProviderError(ProviderError):
    """No provider with that id is registered."""


class LastEnabledProviderError(ProviderError):
    """Refused: it would leave a kind with nothing enabled.

    An empty metadata kind means every import silently rejects every track. A
    settings toggle must not be able to break resolution invisibly, so the
    registry refuses rather than letting the user discover it two thousand
    rejected rows later.
    """


class InvalidOrderError(ProviderError):
    """A reorder that was not a permutation of the kind's registered ids.

    A partial order is ambiguous — do the omitted ids go first, last, or keep
    their old slots? Guessing is worse than refusing.
    """


# ------------------------------------------------------------------- registry


@dataclass(frozen=True)
class ProviderStatus:
    """A descriptor plus everything runtime knows about it. One REST row."""

    descriptor: ProviderDescriptor
    enabled: bool
    position: int
    available: bool
    unavailable_reason: str | None = None


@dataclass
class KindPreference:
    """The persisted preference for one kind. See :mod:`.persistence`."""

    order: list[str] = field(default_factory=list)
    disabled: list[str] = field(default_factory=list)
    # Consent is separate from an old file's implicit enabled state. Reordering
    # or saving other settings must never silently opt a household into scraping.
    opted_in: list[str] = field(default_factory=list)


class ProviderRegistry:
    """Share provider ordering and enabled state between settings and resolution.

    Persist each mutation immediately so a crash cannot undo the user's choice.
    """

    def __init__(self, store=None, logger=None):
        """
        Args:
            store: a :class:`~app.providers.persistence.ProviderPreferenceStore`
                (or anything with ``load()``/``save(prefs)``). ``None`` keeps the
                registry entirely in memory — the shape tests use.
            logger: optional logger for persistence trouble.
        """
        self._store = store
        self._logger = logger
        self._descriptors: dict[str, ProviderDescriptor] = {}
        self._instances: dict[str, object] = {}
        # Registration order per kind. Only the fallback for ids the preference
        # file has never heard of; see docs/DEVELOPER_GUIDE.md#provider-preferences.
        self._registered: dict[ProviderKind, list[str]] = {}
        self._preferred: dict[ProviderKind, KindPreference] = {}
        self._lock = threading.RLock()
        if store is not None:
            self._preferred = store.load()
        # Which ids the file on disk held at startup. Snapshotted
        # rather than read off ``_preferred`` live, because ``_preferred`` grows
        # as providers register and as the user reorders — and "the file has an
        # opinion about this provider" has to mean the file, not this session.
        self._file_known = {
            provider_id
            for preference in self._preferred.values()
            for provider_id in list(preference.order) + list(preference.disabled)
        }

    # ------------------------------------------------------------ registration

    def register(self, descriptor: ProviderDescriptor, instance: object) -> None:
        """Add a provider. Duplicate ids are a programming error, not a merge."""
        with self._lock:
            if descriptor.id in self._descriptors:
                raise ProviderError(f"Provider {descriptor.id!r} is already registered")
            self._descriptors[descriptor.id] = descriptor
            self._instances[descriptor.id] = instance
            self._registered.setdefault(descriptor.kind, []).append(descriptor.id)
            # A provider whose default is "off" and which the preference file has
            # never seen starts disabled. Once the file knows the id, the file
            # wins — otherwise a user who deliberately enabled an off-by-default
            # provider would be overruled on every restart. That is also why
            # ``_persist`` writes the *complete* id list into ``order``: without
            # it, "the user turned Spotify on" and "the file has never heard of
            # Spotify" are indistinguishable on the next start.
            preference = self._preference(descriptor.kind)
            needs_consent = descriptor.requires_explicit_opt_in and descriptor.id not in preference.opted_in
            if needs_consent or (not descriptor.enabled_by_default and descriptor.id not in self._file_known):
                if descriptor.id not in preference.disabled:
                    preference.disabled.append(descriptor.id)

    def unregister(self, provider_id: str) -> bool:
        """Remove a provider. Returns False when it was not registered.

        The persisted preference is deliberately *not* cleaned up: an id the
        registry no longer knows is ignored on load, and leaving it in place
        means a provider that comes back (a re-enabled feature, a rolled-back
        release) keeps its position and its toggle.
        """
        with self._lock:
            descriptor = self._descriptors.pop(provider_id, None)
            if descriptor is None:
                return False
            self._instances.pop(provider_id, None)
            registered = self._registered.get(descriptor.kind)
            if registered and provider_id in registered:
                registered.remove(provider_id)
            return True

    # -------------------------------------------------------------- inspection

    def list(self, kind: ProviderKind | None = None) -> builtins.list[ProviderDescriptor]:
        """Descriptors in effective order, grouped by kind when ``kind`` is None.

        Includes disabled and unavailable providers — the settings panel has to
        render the things you turned off.
        """
        with self._lock:
            kinds = [kind] if kind is not None else list(ProviderKind)
            out: list[ProviderDescriptor] = []
            for k in kinds:
                out.extend(self._descriptors[pid] for pid in self._effective_order(k))
            return out

    def get(self, provider_id: str) -> tuple[ProviderDescriptor, object] | None:
        with self._lock:
            descriptor = self._descriptors.get(provider_id)
            if descriptor is None:
                return None
            return descriptor, self._instances[provider_id]

    def instance(self, provider_id: str) -> object:
        """The live provider object, or :class:`UnknownProviderError`."""
        found = self.get(provider_id)
        if found is None:
            raise UnknownProviderError(f"Unknown provider {provider_id!r}")
        return found[1]

    def descriptor(self, provider_id: str) -> ProviderDescriptor:
        found = self.get(provider_id)
        if found is None:
            raise UnknownProviderError(f"Unknown provider {provider_id!r}")
        return found[0]

    def is_enabled(self, provider_id: str) -> bool:
        with self._lock:
            descriptor = self._descriptors.get(provider_id)
            if descriptor is None:
                raise UnknownProviderError(f"Unknown provider {provider_id!r}")
            return provider_id not in self._preference(descriptor.kind).disabled

    def availability(self, provider_id: str) -> tuple[bool, str | None]:
        """Ask the provider whether its required credentials are usable now.

        Static requires_credentials cannot answer runtime readiness. Providers without
        a probe are assumed usable; probe errors make only that provider unavailable.
        """
        instance = self.instance(provider_id)
        reporter = getattr(instance, "unavailable_reason", None)
        if not callable(reporter):
            return True, None
        try:
            reason = reporter()
        except Exception as e:  # a broken self-check must not 500 the settings page
            if self._logger:
                self._logger.warning(
                    "Provider %s failed its availability check: %s", provider_id, e
                )
            return False, f"availability check failed: {type(e).__name__}"
        return (reason is None), reason

    def status(self, kind: ProviderKind | None = None) -> builtins.list[ProviderStatus]:
        """Everything ``GET /api/providers`` needs, already in display order."""
        with self._lock:
            kinds = [kind] if kind is not None else list(ProviderKind)
            rows: list[ProviderStatus] = []
            for k in kinds:
                for position, provider_id in enumerate(self._effective_order(k)):
                    available, reason = self.availability(provider_id)
                    rows.append(
                        ProviderStatus(
                            descriptor=self._descriptors[provider_id],
                            enabled=self.is_enabled(provider_id),
                            position=position,
                            available=available,
                            unavailable_reason=reason,
                        )
                    )
            return rows

    def status_of(self, provider_id: str) -> ProviderStatus:
        descriptor = self.descriptor(provider_id)
        for row in self.status(descriptor.kind):
            if row.descriptor.id == provider_id:
                return row
        raise UnknownProviderError(f"Unknown provider {provider_id!r}")

    # ----------------------------------------------------------------- ordering

    def order(
        self, kind: ProviderKind, include_unavailable: bool = False
    ) -> builtins.list[str]:
        """The ids a consumer should walk, best first.

        Excludes disabled providers, and by default excludes ones that cannot
        work right now — a resolver handed a credential-less Spotify would spend
        a slot per track producing the same "not configured" note. Pass
        ``include_unavailable=True`` for the raw preference order.
        """
        with self._lock:
            ids = [pid for pid in self._effective_order(kind) if self.is_enabled(pid)]
            if include_unavailable:
                return ids
            return [pid for pid in ids if self.availability(pid)[0]]

    def set_order(self, kind: ProviderKind, ids: Sequence[str]) -> None:
        """Replace a kind's order. Must be a permutation of its registered ids."""
        with self._lock:
            registered = set(self._registered.get(kind, []))
            requested = list(ids)
            if len(set(requested)) != len(requested):
                raise InvalidOrderError("Order contains duplicate provider ids")
            unknown = [pid for pid in requested if pid not in registered]
            if unknown:
                raise InvalidOrderError(
                    f"Unknown provider ids for kind {kind.value}: {', '.join(sorted(unknown))}"
                )
            missing = sorted(registered - set(requested))
            if missing:
                raise InvalidOrderError(
                    f"Order for kind {kind.value} is missing: {', '.join(missing)}"
                )
            self._preference(kind).order = requested
            self._persist()

    # ----------------------------------------------------------------- toggling

    def set_enabled(self, provider_id: str, enabled: bool) -> None:
        """Turn a provider on or off, refusing to empty a kind.

        Availability is deliberately not consulted: "the last one that would
        work" is a moving target (credentials come and go), while "the last one
        you left switched on" is a stable, explainable rule.
        """
        with self._lock:
            descriptor = self._descriptors.get(provider_id)
            if descriptor is None:
                raise UnknownProviderError(f"Unknown provider {provider_id!r}")
            preference = self._preference(descriptor.kind)
            currently = provider_id not in preference.disabled
            if currently == enabled:
                return
            if not enabled:
                # The guard applies only to kinds whose emptiness breaks
                # something nobody chose to break. See ProviderKind.is_required.
                if descriptor.kind.is_required:
                    still_on = [
                        pid
                        for pid in self._registered.get(descriptor.kind, [])
                        if pid != provider_id and pid not in preference.disabled
                    ]
                    if not still_on:
                        raise LastEnabledProviderError(
                            f"{descriptor.name} is the only enabled "
                            f"{descriptor.kind.value} provider; disabling it would "
                            f"stop {descriptor.kind.value} lookups entirely."
                        )
                preference.disabled.append(provider_id)
            else:
                preference.disabled = [p for p in preference.disabled if p != provider_id]
                if descriptor.requires_explicit_opt_in and provider_id not in preference.opted_in:
                    preference.opted_in.append(provider_id)
            self._persist()

    # ------------------------------------------------------------------ private

    def _preference(self, kind: ProviderKind) -> KindPreference:
        return self._preferred.setdefault(kind, KindPreference())

    def _effective_order(self, kind: ProviderKind) -> builtins.list[str]:
        """Persisted preference first, then anything the file never heard of.

        This is the tolerant merge, computed rather than stored: an id in the
        file that is no longer registered simply does not survive the filter,
        and a newly registered id falls through to the tail. Neither is an
        error, because the file is a preference and the registry is the truth.
        """
        registered = self._registered.get(kind, [])
        preferred = self._preference(kind).order
        ordered = [pid for pid in preferred if pid in registered]
        ordered.extend(pid for pid in registered if pid not in ordered)
        return ordered

    def _persisted_order(self, kind: ProviderKind) -> builtins.list[str]:
        """What to write to ``order``: every id the file or the registry knows.

        Two jobs beyond recording priority. It records existence — an id
        present here is one the file has heard of, which is what stops an
        off-by-default provider the user switched on from being switched off
        again on the next start. And it preserves unrecognized ids,
        in place, so a provider that disappears for a release (a rollback, a
        feature flag) comes back to its old slot instead of the bottom.
        """
        ordered = list(self._preference(kind).order)
        ordered.extend(
            pid for pid in self._registered.get(kind, []) if pid not in ordered
        )
        return ordered

    def _persist(self) -> None:
        if self._store is None:
            return
        snapshot = {
            kind: KindPreference(
                order=self._persisted_order(kind),
                disabled=list(self._preference(kind).disabled),
                opted_in=list(self._preference(kind).opted_in),
            )
            for kind in set(self._preferred) | set(self._registered)
        }
        try:
            self._store.save(snapshot)
        except Exception as e:  # a read-only home dir must not break the toggle
            if self._logger:
                self._logger.warning("Could not persist provider preferences: %s", e)
