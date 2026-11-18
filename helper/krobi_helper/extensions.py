"""Dependency-free manifest gate for installed helper entry points.

The backend owns the inventory; these checks run before EntryPoint.load(),
which can execute arbitrary extension imports. Shared cases pin both hosts.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ACCEPTED_PROTOCOLS = {"helper": [1], "source": [1], "plugin_api": [1]}
KIND_PROTOCOL = {"engine": "helper", "source": "source", "feature": "plugin_api"}
KIND_RUNTIMES = {"engine": {"helper", "nest"}, "source": {"nest"}, "feature": {"nest", "desktop"}}


def manifest_state(data: object) -> tuple[str, str | None]:
    """Validate metadata without importing the entry point or its package."""
    if not isinstance(data, dict):
        return "invalid", "Manifest must be an object"
    required = {"manifest", "id", "kind", "name", "version", "protocol", "runs", "adds", "reaches", "entry", "license", "homepage"}
    if not required <= data.keys():
        return "invalid", "Missing required manifest keys"
    kind = data["kind"]
    if not isinstance(kind, str) or kind not in KIND_PROTOCOL:
        return "invalid", "Unknown extension kind"
    if type(data["manifest"]) is not int or data["manifest"] != 1:
        return "invalid", "Unsupported manifest format"
    if not isinstance(data["id"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", data["id"]):
        return "invalid", "Invalid extension id"
    for key in ("name", "license", "homepage"):
        if not isinstance(data[key], str) or not data[key]:
            return "invalid", f"Invalid {key}"
    semver = r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    if not isinstance(data["version"], str) or not re.fullmatch(semver, data["version"]):
        return "invalid", "Invalid extension version"
    for key in ("runs", "adds", "reaches"):
        if not isinstance(data[key], list) or any(not isinstance(value, str) or not value for value in data[key]):
            return "invalid", f"Invalid {key}"
    if not data["runs"] or not set(data["runs"]) <= KIND_RUNTIMES[kind]:
        return "invalid", "Invalid runtime for extension kind"
    entry = data["entry"]
    if not isinstance(entry, dict):
        return "invalid", "Invalid entry"
    for key in ("module", "extra"):
        if key in entry and entry[key] is not None and (not isinstance(entry[key], str) or not entry[key]):
            return "invalid", f"Invalid entry.{key}"
    command = entry.get("command")
    if command is not None and (not isinstance(command, list) or any(not isinstance(arg, str) or not arg for arg in command)):
        return "invalid", "Invalid entry.command"
    if not entry.get({"engine": "extra", "source": "command", "feature": "module"}[kind]):
        return "invalid", "Missing entry for extension kind"
    protocol = data["protocol"]
    key = KIND_PROTOCOL[kind]
    if not isinstance(protocol, dict) or key not in protocol:
        return "invalid", "Missing protocol for extension kind"
    for versions in protocol.values():
        if not isinstance(versions, list) or any(type(v) is not int or v < 1 for v in versions):
            return "invalid", "Invalid protocol versions"
    if not set(protocol[key]).intersection(ACCEPTED_PROTOCOLS[key]):
        return "incompatible", f"No accepted {key} protocol (host accepts {ACCEPTED_PROTOCOLS[key]})"
    return "on", None


def entry_manifest(entry) -> dict | None:
    """Locate metadata through distribution files, never importlib resources.

    A wheel carries one krobi-extension.json in its entry point's package tree
    or at distribution root. Metadata in another package is never used as fallback.
    """
    distribution = getattr(entry, "dist", None)
    if distribution is None:
        return None
    module = entry.value.split(":", 1)[0].split(".")
    candidates = {Path(*module[:index]) / "krobi-extension.json" for index in range(1, len(module) + 1)}
    candidates.add(Path("krobi-extension.json"))
    paths = [file for file in distribution.files or () if Path(str(file)) in candidates]
    if len(paths) > 1:
        raise ValueError("Ambiguous helper plugin manifest")
    if not paths:
        return None
    return json.loads(Path(distribution.locate_file(paths[0])).read_text(encoding="utf-8"))
