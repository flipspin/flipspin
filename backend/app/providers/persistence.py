"""Persist provider ordering, disabled ids and explicit consent.

Tolerate registry changes and corrupt reads; replace saved preferences atomically.
See docs/DEVELOPER_GUIDE.md#provider-preferences.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from collections.abc import Mapping

from app.infra.files import write_json_atomic
from app.providers.registry import KindPreference, ProviderKind


class ProviderPreferenceStore:
    """Load/save provider preferences as JSON. Never raises on load."""

    def __init__(self, path: Path, logger: logging.Logger | None = None):
        self.path = Path(path)
        self.logger = logger or logging.getLogger(__name__)

    def load(self) -> dict[ProviderKind, KindPreference]:
        """Read the file, or return empty preferences if it is absent or junk."""
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            self.logger.warning(
                "Ignoring unreadable provider preferences at %s: %s", self.path, e
            )
            return {}
        return self._parse(raw)

    def save(self, preferences: Mapping[ProviderKind, KindPreference]) -> None:
        """Write atomically: a torn settings file is worse than an old one."""
        payload = {
            kind.value: {
                "order": list(pref.order), "disabled": list(pref.disabled),
                **({"opted_in": list(pref.opted_in)} if pref.opted_in else {}),
            }
            for kind, pref in preferences.items()
        }
        write_json_atomic(self.path, payload, sort_keys=True)

    # ------------------------------------------------------------------ private

    def _parse(self, raw: object) -> dict[ProviderKind, KindPreference]:
        """Map a parsed document to preferences, skipping anything malformed.

        Unknown kinds are dropped the same way unknown ids are: a file written
        by a newer KROBI must not stop an older one from starting.
        """
        if not isinstance(raw, dict):
            self.logger.warning(
                "Provider preferences at %s are not a JSON object; ignoring", self.path
            )
            return {}
        out: dict[ProviderKind, KindPreference] = {}
        for key, value in raw.items():
            try:
                kind = ProviderKind(key)
            except ValueError:
                self.logger.info("Ignoring unknown provider kind %r in %s", key, self.path)
                continue
            if not isinstance(value, dict):
                continue
            out[kind] = KindPreference(
                order=_string_list(value.get("order")),
                disabled=_string_list(value.get("disabled")),
                opted_in=_string_list(value.get("opted_in")),
            )
        return out


def _string_list(value: object) -> list:
    """Every id, de-duplicated, in order. Non-strings are dropped silently."""
    if not isinstance(value, list):
        return []
    seen = []
    for item in value:
        if isinstance(item, str) and item and item not in seen:
            seen.append(item)
    return seen
