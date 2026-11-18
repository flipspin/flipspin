"""Check provider ordering, nonempty kinds, and upgrade-tolerant preferences.

Enabled records user choice; available records runtime readiness. Neither may
reset saved choices when providers are added or removed.
"""
import json
from pathlib import Path

import pytest

from app.providers.persistence import ProviderPreferenceStore
from app.providers.registry import (
    InvalidOrderError,
    KindPreference,
    LastEnabledProviderError,
    ProviderDescriptor,
    ProviderError,
    ProviderKind,
    ProviderRegistry,
    UnknownProviderError,
)

METADATA = ProviderKind.METADATA


def _descriptor(provider_id, kind=METADATA, **kwargs):
    kwargs.setdefault("name", provider_id.title())
    kwargs.setdefault("description", "")
    return ProviderDescriptor(id=provider_id, kind=kind, **kwargs)


class _Provider:
    """A minimal registered instance. Optionally reports itself unusable."""

    def __init__(self, reason=None, raises=False):
        self._reason = reason
        self._raises = raises

    def unavailable_reason(self):
        if self._raises:
            raise RuntimeError("credential store on fire")
        return self._reason


class _Bare:
    """A provider that does not implement the availability protocol at all."""


def _registry(*ids, store=None):
    registry = ProviderRegistry(store=store)
    for provider_id in ids:
        registry.register(_descriptor(provider_id), _Bare())
    return registry


class TestRegistration:
    def test_registration_order_is_the_default_priority_order(self):
        registry = _registry("deezer", "musicbrainz", "spotify")
        assert registry.order(METADATA) == ["deezer", "musicbrainz", "spotify"]

    def test_a_duplicate_id_is_a_programming_error_not_a_merge(self):
        registry = _registry("deezer")
        with pytest.raises(ProviderError):
            registry.register(_descriptor("deezer"), _Bare())

    def test_kinds_are_independent_lists(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(_descriptor("genius", ProviderKind.LYRICS), _Bare())
        assert registry.order(METADATA) == ["deezer"]
        assert registry.order(ProviderKind.LYRICS) == ["genius"]

    def test_an_off_by_default_provider_starts_disabled(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(
            _descriptor("spotify", enabled_by_default=False), _Bare()
        )
        assert registry.order(METADATA) == ["deezer"]
        assert registry.is_enabled("spotify") is False

    def test_unregister_reports_whether_anything_was_there(self):
        registry = _registry("deezer", "musicbrainz")
        assert registry.unregister("deezer") is True
        assert registry.unregister("deezer") is False
        assert registry.order(METADATA) == ["musicbrainz"]

    def test_unknown_ids_raise_rather_than_answering_falsely(self):
        registry = _registry("deezer")
        assert registry.get("nope") is None
        with pytest.raises(UnknownProviderError):
            registry.is_enabled("nope")
        with pytest.raises(UnknownProviderError):
            registry.instance("nope")


class TestEnabling:
    def test_disabling_removes_a_provider_from_the_consumer_order(self):
        registry = _registry("deezer", "musicbrainz")
        registry.set_enabled("deezer", False)
        assert registry.order(METADATA) == ["musicbrainz"]
        assert registry.is_enabled("deezer") is False

    def test_disabling_the_last_provider_of_a_kind_is_refused(self):
        """An empty metadata kind rejects every import with no visible cause."""
        registry = _registry("deezer", "musicbrainz")
        registry.set_enabled("musicbrainz", False)
        with pytest.raises(LastEnabledProviderError):
            registry.set_enabled("deezer", False)
        assert registry.order(METADATA) == ["deezer"]

    def test_a_sole_provider_of_a_REQUIRED_kind_cannot_be_disabled(self):
        """Emptying metadata means every import silently rejects."""
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer", ProviderKind.METADATA), _Bare())
        with pytest.raises(LastEnabledProviderError):
            registry.set_enabled("deezer", False)

    def test_zero_streaming_sources_is_a_persisted_valid_state(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("fake", ProviderKind.STREAMING), _Bare())
        registry.set_enabled("fake", False)
        assert registry.order(ProviderKind.STREAMING) == []
        assert not ProviderKind.STREAMING.is_required
        assert not registry.status_of("fake").enabled

    def test_a_sole_provider_of_an_OPTIONAL_kind_can_be_disabled(self):
        """Allow users to disable browse independently of metadata resolution."""
        registry = ProviderRegistry()
        registry.register(_descriptor("genius", ProviderKind.LYRICS), _Bare())
        registry.set_enabled("genius", False)
        assert registry.order(ProviderKind.LYRICS) == []

    def test_re_enabling_restores_the_original_position(self):
        """A toggle is not a reorder — off and on again must be a no-op."""
        registry = _registry("deezer", "musicbrainz", "spotify")
        registry.set_enabled("musicbrainz", False)
        registry.set_enabled("musicbrainz", True)
        assert registry.order(METADATA) == ["deezer", "musicbrainz", "spotify"]

    def test_setting_the_state_it_already_has_is_a_no_op(self):
        registry = _registry("deezer", "musicbrainz")
        registry.set_enabled("deezer", True)
        assert registry.order(METADATA) == ["deezer", "musicbrainz"]

    def test_the_last_check_counts_enabled_not_available(self):
        """Availability moves with credentials; the rule has to be stable.

        Spotify being credential-less does not make Deezer "the last one", or a
        user would find the toggle refusing at times they cannot explain.
        """
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(_descriptor("spotify"), _Provider(reason="no credentials"))
        registry.set_enabled("deezer", False)  # allowed: spotify is still enabled
        assert registry.is_enabled("deezer") is False


class TestAvailability:
    def test_a_provider_that_cannot_work_is_kept_out_of_the_consumer_order(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(_descriptor("spotify"), _Provider(reason="no credentials"))

        assert registry.order(METADATA) == ["deezer"]
        # ...but it is still enabled, and the settings panel must still see it.
        assert registry.is_enabled("spotify") is True
        assert registry.order(METADATA, include_unavailable=True) == ["deezer", "spotify"]

    def test_the_reason_is_carried_through_verbatim_for_the_ui(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("spotify"), _Provider(reason="Add your key."))
        assert registry.availability("spotify") == (False, "Add your key.")

    def test_a_provider_with_no_self_check_is_assumed_usable(self):
        registry = _registry("deezer")
        assert registry.availability("deezer") == (True, None)

    def test_a_broken_self_check_does_not_take_the_settings_page_down(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("spotify"), _Provider(raises=True))
        available, reason = registry.availability("spotify")
        assert available is False
        assert "RuntimeError" in reason


class TestOrdering:
    def test_set_order_changes_the_escalation(self):
        registry = _registry("deezer", "musicbrainz")
        registry.set_order(METADATA, ["musicbrainz", "deezer"])
        assert registry.order(METADATA) == ["musicbrainz", "deezer"]

    def test_a_partial_order_is_refused_rather_than_guessed(self):
        registry = _registry("deezer", "musicbrainz")
        with pytest.raises(InvalidOrderError):
            registry.set_order(METADATA, ["deezer"])

    def test_an_unknown_id_in_the_order_is_refused(self):
        registry = _registry("deezer", "musicbrainz")
        with pytest.raises(InvalidOrderError):
            registry.set_order(METADATA, ["deezer", "musicbrainz", "tidal"])

    def test_a_duplicated_id_in_the_order_is_refused(self):
        registry = _registry("deezer", "musicbrainz")
        with pytest.raises(InvalidOrderError):
            registry.set_order(METADATA, ["deezer", "deezer"])

    def test_ordering_one_kind_does_not_touch_another(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(_descriptor("musicbrainz"), _Bare())
        registry.register(_descriptor("genius", ProviderKind.LYRICS), _Bare())
        registry.set_order(METADATA, ["musicbrainz", "deezer"])
        assert registry.order(ProviderKind.LYRICS) == ["genius"]


class TestStatusRows:
    def test_position_counts_disabled_providers_too(self):
        """The panel renders what you switched off, so it needs stable slots."""
        registry = _registry("deezer", "musicbrainz", "spotify")
        registry.set_enabled("musicbrainz", False)
        positions = {row.descriptor.id: row.position for row in registry.status(METADATA)}
        assert positions == {"deezer": 0, "musicbrainz": 1, "spotify": 2}

    def test_status_covers_every_kind_when_none_is_given(self):
        registry = ProviderRegistry()
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(_descriptor("genius", ProviderKind.LYRICS), _Bare())
        assert {row.descriptor.id for row in registry.status()} == {"deezer", "genius"}


class _RecordingStore:
    """An in-memory stand-in for the JSON file."""

    def __init__(self, initial=None):
        self.saved = initial or {}

    def load(self):
        return self.saved

    def save(self, preferences):
        self.saved = preferences


class TestPersistenceMerge:
    def test_a_persisted_order_wins_over_registration_order(self):
        store = _RecordingStore({METADATA: KindPreference(order=["musicbrainz", "deezer"])})
        registry = _registry("deezer", "musicbrainz", store=store)
        assert registry.order(METADATA) == ["musicbrainz", "deezer"]

    def test_an_unknown_id_in_the_file_is_ignored_not_an_error(self):
        """A provider that was removed leaves its id behind. Normal, not fatal."""
        store = _RecordingStore(
            {METADATA: KindPreference(order=["tidal", "musicbrainz", "deezer"])}
        )
        registry = _registry("deezer", "musicbrainz", store=store)
        assert registry.order(METADATA) == ["musicbrainz", "deezer"]

    def test_a_new_id_missing_from_the_file_appends_rather_than_resetting(self):
        """A provider that was added is absent from an older file. Also normal.

        The rest of the user's order has to survive it — dropping back to
        registration order because one id is unknown would silently undo their
        settings on every upgrade.
        """
        store = _RecordingStore({METADATA: KindPreference(order=["musicbrainz", "deezer"])})
        registry = ProviderRegistry(store=store)
        for provider_id in ("deezer", "musicbrainz", "spotify"):
            registry.register(_descriptor(provider_id), _Bare())
        assert registry.order(METADATA) == ["musicbrainz", "deezer", "spotify"]

    def test_a_disabled_id_from_the_file_stays_disabled(self):
        store = _RecordingStore({METADATA: KindPreference(disabled=["musicbrainz"])})
        registry = _registry("deezer", "musicbrainz", store=store)
        assert registry.order(METADATA) == ["deezer"]

    def test_the_file_beats_enabled_by_default_for_ids_it_knows(self):
        """Otherwise every restart would overrule a deliberate opt-in."""
        store = _RecordingStore({METADATA: KindPreference(order=["deezer", "spotify"])})
        registry = ProviderRegistry(store=store)
        registry.register(_descriptor("deezer"), _Bare())
        registry.register(_descriptor("spotify", enabled_by_default=False), _Bare())
        assert registry.is_enabled("spotify") is True

    def test_every_mutation_persists_immediately(self):
        store = _RecordingStore()
        registry = _registry("deezer", "musicbrainz", store=store)
        registry.set_order(METADATA, ["musicbrainz", "deezer"])
        registry.set_enabled("deezer", False)
        assert store.saved[METADATA].order == ["musicbrainz", "deezer"]
        assert store.saved[METADATA].disabled == ["deezer"]

    def test_a_store_that_cannot_write_does_not_break_the_toggle(self):
        """A read-only home directory is a degraded setting, not a 500."""

        class _Broken(_RecordingStore):
            def save(self, preferences):
                raise OSError("read-only file system")

        registry = _registry("deezer", "musicbrainz", store=_Broken())
        registry.set_enabled("deezer", False)
        assert registry.order(METADATA) == ["musicbrainz"]


class TestPreferenceStore:
    def test_round_trips_through_the_file(self, tmp_path: Path):
        store = ProviderPreferenceStore(tmp_path / "providers.json")
        store.save({METADATA: KindPreference(order=["deezer"], disabled=["musicbrainz"])})
        loaded = store.load()
        assert loaded[METADATA].order == ["deezer"]
        assert loaded[METADATA].disabled == ["musicbrainz"]

    def test_a_missing_file_is_simply_no_preference(self, tmp_path: Path):
        assert ProviderPreferenceStore(tmp_path / "nope.json").load() == {}

    def test_corrupt_json_falls_back_to_defaults_instead_of_crashing(self, tmp_path: Path):
        """One bad settings file must not stop the backend from starting."""
        path = tmp_path / "providers.json"
        path.write_text("{not json at all", encoding="utf-8")
        assert ProviderPreferenceStore(path).load() == {}

    def test_an_unknown_kind_is_dropped_rather_than_rejected(self, tmp_path: Path):
        """A file written by a newer KROBI must not stop an older one."""
        path = tmp_path / "providers.json"
        path.write_text(
            json.dumps({"metadata": {"order": ["deezer"]}, "podcasts": {"order": ["x"]}}),
            encoding="utf-8",
        )
        loaded = ProviderPreferenceStore(path).load()
        assert list(loaded) == [METADATA]

    def test_junk_entries_inside_a_kind_are_dropped(self, tmp_path: Path):
        path = tmp_path / "providers.json"
        path.write_text(
            json.dumps({"metadata": {"order": ["deezer", 7, None, "deezer"], "disabled": "no"}}),
            encoding="utf-8",
        )
        loaded = ProviderPreferenceStore(path).load()
        assert loaded[METADATA].order == ["deezer"]
        assert loaded[METADATA].disabled == []

    def test_saving_leaves_no_temp_files_behind(self, tmp_path: Path):
        store = ProviderPreferenceStore(tmp_path / "providers.json")
        store.save({METADATA: KindPreference(order=["deezer"])})
        store.save({METADATA: KindPreference(order=["musicbrainz"])})
        assert sorted(p.name for p in tmp_path.iterdir()) == ["providers.json"]


class TestDefaultRegistry:
    """The real wiring, built against a temp ``~/Krobi`` rather than the user's.

    ``config`` (conftest) points every directory at a tmpdir, and
    ``ConfigManager`` derives ``providers_file`` from those rather than from
    ``Path.home()`` — which is the whole reason it is derived: a test that wrote
    the developer's real providers.json would silently reorder their app.
    """

    def _registry(self, config):
        from app.providers.adapters import build_default_registry

        return build_default_registry(config, logger=None)

    def test_the_default_order_is_the_one_the_cost_model_depends_on(self, config):
        """Deezer first is not a preference; it is what makes a 2000-track
        import 10-15 minutes instead of 35."""
        assert self._registry(config).order(METADATA) == ["deezer", "musicbrainz"]

    def test_spotify_is_registered_but_off_until_asked_for(self, config):
        registry = self._registry(config)
        assert registry.get("spotify") is not None
        assert registry.is_enabled("spotify") is False

    def test_every_kind_with_a_consumer_has_a_provider(self, config):
        registry = self._registry(config)
        # LRCLIB first: free, synced, no key. Genius starts off until explicit consent.
        assert registry.order(ProviderKind.LYRICS, include_unavailable=True) == ["lrclib", "lyricsovh"]
        assert registry.order(ProviderKind.STREAMING, include_unavailable=True) == []

    def test_preferences_survive_a_restart(self, config):
        """The point of the file. A toggle that lasts until the next launch is
        a bug report, so there is no explicit save to forget."""
        self._registry(config).set_order(
            METADATA, ["musicbrainz", "spotify", "deezer"]
        )
        assert config.providers_file.exists()
        assert self._registry(config).order(METADATA) == ["musicbrainz", "deezer"]

    def test_disabling_every_streaming_source_survives_restart(self, config):
        registry = self._registry(config)
        registry.register(ProviderDescriptor(id='fake', name='Fake', kind=ProviderKind.STREAMING, description=''), object())
        registry.set_enabled('fake', False)
        restarted = self._registry(config)
        assert restarted.order(ProviderKind.STREAMING) == []
        assert restarted.order(METADATA)

    def test_reordering_does_not_silently_switch_spotify_on(self, config):
        """A reorder is not consent to enable something.

        The order written to disk names every provider, including the ones that
        are off — which is how the file remembers that it *has* heard of them.
        If that were also read as "enabled", dragging one card would turn on a
        credentialled provider the user never asked for.
        """
        self._registry(config).set_order(
            METADATA, ["musicbrainz", "spotify", "deezer"]
        )
        assert self._registry(config).is_enabled("spotify") is False

    def test_enabling_an_off_by_default_provider_survives_a_restart(self, config):
        """The inverse: an explicit opt-in must not be overruled on every start."""
        first = self._registry(config)
        first.set_enabled("spotify", True)
        assert self._registry(config).is_enabled("spotify") is True

    def test_the_preferences_file_lands_beside_the_other_krobi_state(self, config):
        assert config.providers_file.name == "providers.json"
        assert config.providers_file.parent == config.playlist_dir.parent

    def test_the_file_on_disk_matches_the_documented_shape(self, config):
        """``providers.json`` is a documented surface; the settings panel reads it."""
        registry = self._registry(config)
        registry.set_enabled("musicbrainz", False)

        written = json.loads(config.providers_file.read_text(encoding="utf-8"))
        assert written["metadata"] == {
            "order": ["deezer", "musicbrainz", "spotify"],
            "disabled": ["spotify", "musicbrainz"],
        }
        assert written["lyrics"] == {"order": ["lrclib", "genius", "lyricsovh"], "disabled": ["genius"]}
        assert written.get('streaming', {'order': [], 'disabled': []}) == {'order': [], 'disabled': []}
