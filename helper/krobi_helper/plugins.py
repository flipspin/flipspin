"""Lightweight, optional worker extension points. No model imports here."""
from __future__ import annotations

import importlib.metadata
import logging
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from .extensions import entry_manifest, manifest_state


@dataclass
class Registry:
    commands: dict[str, Callable] = field(default_factory=dict)
    checks: dict[str, Callable] = field(default_factory=dict)
    prefetch_hooks: list[Callable] = field(default_factory=list)
    claim_steps: list[Callable] = field(default_factory=list)
    extensions: list[dict] = field(default_factory=list)

    def add_command(self, name: str, configure: Callable) -> None:
        if name in {"check", "prefetch", "run", "align", "stems", "agent"} or name in self.commands:
            raise ValueError(f"Duplicate worker command: {name}")
        self.commands[name] = configure

    def add_check(self, name: str, check: Callable) -> None:
        if name in {"version", "python", "platform", "supported", "packages", "models", "ready", "stems"} or name in self.checks:
            raise ValueError(f"Duplicate worker check: {name}")
        self.checks[name] = check

    def add_prefetch(self, hook: Callable) -> None:
        self.prefetch_hooks.append(hook)

    def add_claim_step(self, step: Callable[[Any], bool]) -> None:
        self.claim_steps.append(step)


@lru_cache(maxsize=1)
def load_plugins() -> Registry:
    registry = Registry()
    # Prefer the new group; a plugin declaring both is registered only once.
    entries = {}
    for group in ("krobi_helper.plugins", "krobi_lyrics.plugins"):
        for entry in sorted(importlib.metadata.entry_points(group=group), key=lambda ep: ep.name):
            entries.setdefault(entry.name, entry)
    candidates = []
    for entry in entries.values():
        observation = {"id": entry.name, "state": "on", "reason": None}
        try:
            manifest = entry_manifest(entry)
            if manifest is None:
                observation["reason"] = "Legacy package without a manifest; supported for one release"
                logging.getLogger(__name__).warning("Worker plugin %s is legacy: no krobi-extension.json; supported for one release", entry.name)
            else:
                state, reason = manifest_state(manifest)
                observation.update(state=state, reason=reason)
                if state == "on" and (manifest["kind"] != "engine" or "helper" not in manifest["runs"]):
                    observation.update(state="invalid", reason="Helper entry points require an engine running in helper")
                if state in {"on", "incompatible"}:
                    observation["id"] = manifest["id"]
        except (OSError, ValueError):
            observation.update(state="invalid", reason="Manifest is unreadable or invalid JSON")
        candidates.append((entry, observation))
    counts = Counter(observation["id"] for _, observation in candidates)
    for entry, observation in candidates:
        if counts[observation["id"]] > 1 or observation["id"] in {"lyrics", "stems", "analysis"}:
            observation.update(state="invalid", reason="Duplicate extension id")
        registry.extensions.append(observation)
        if observation["state"] != "on":
            logging.getLogger(__name__).warning("Worker plugin %s refused: %s", entry.name, observation["reason"])
            continue
        # Stage registration so a broken plugin cannot leave partial hooks behind.
        candidate = Registry(dict(registry.commands), dict(registry.checks),
                             list(registry.prefetch_hooks), list(registry.claim_steps), list(registry.extensions))
        try:
            entry.load().register(candidate)
        except Exception:
            observation.update(state="failed:registration", reason="Plugin registration failed; see helper logs")
            logging.getLogger(__name__).exception("Worker plugin %s failed to register", entry.name)
            continue
        registry = candidate
    return registry
