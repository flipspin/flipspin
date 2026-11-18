"""Extension metadata and discovery. Reading a manifest never executes its package."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

MANIFEST_NAME = "krobi-extension.json"
ACCEPTED_PROTOCOLS = {"helper": [1], "source": [1], "plugin_api": [1]}
KIND_PROTOCOL = {"engine": "helper", "source": "source", "feature": "plugin_api"}
KIND_RUNTIMES = {"engine": {"helper", "nest"}, "source": {"nest"}, "feature": {"nest", "desktop"}}
BUILTIN_ENGINES = Path(__file__).parent / "engines"

Nonempty = Annotated[str, Field(min_length=1)]
ProtocolVersion = Annotated[int, Field(strict=True, ge=0)]


class Entry(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    command: list[Nonempty] | None = None
    module: Nonempty | None = None
    extra: Nonempty | None = None


class Manifest(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    manifest: Annotated[int, Field(strict=True, ge=1, le=1)]
    id: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9-]{1,40}$")]
    kind: Literal["engine", "source", "feature"]
    name: Nonempty
    version: Annotated[str, Field(pattern=r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")]
    protocol: dict[str, list[ProtocolVersion]]
    runs: Annotated[list[Literal["nest", "helper", "desktop"]], Field(min_length=1)]
    adds: list[Nonempty]
    reaches: list[Nonempty]
    entry: Entry
    license: Nonempty
    homepage: Nonempty

    @model_validator(mode="after")
    def kind_boundary(self) -> Manifest:
        protocol = KIND_PROTOCOL[self.kind]
        if protocol not in self.protocol:
            raise ValueError(f"{self.kind} requires protocol.{protocol}")
        if not set(self.runs) <= KIND_RUNTIMES[self.kind]:
            raise ValueError(f"{self.kind} cannot run in the declared runtime")
        key = {"engine": "extra", "source": "command", "feature": "module"}[self.kind]
        if not getattr(self.entry, key):
            raise ValueError(f"{self.kind} requires entry.{key}")
        return self


class Extension(BaseModel):
    """A host observation, including refused and legacy packages."""
    id: str
    kind: Literal["engine", "source", "feature"] | None
    name: str
    version: str | None = None
    protocol: dict[str, list[int]] = Field(default_factory=dict)
    runs: list[Literal["nest", "helper", "desktop"]] = Field(default_factory=list)
    adds: list[str] = Field(default_factory=list)
    reaches: list[str] = Field(default_factory=list)
    entry: Entry = Field(default_factory=Entry)
    license: str | None = None
    homepage: str | None = None
    state: Annotated[str, Field(pattern=r"^(on|off|restart-pending|failed:[a-z0-9-]+|incompatible|invalid)$")] = "on"
    reason: str | None = None


class ExtensionsResponse(BaseModel):
    extensions: list[Extension]
    accepted: dict[str, list[int]]


def parse_manifest(data: object, *, fallback_id: str = "unknown", expected_kind: str | None = None,
                   accepted: dict[str, list[int]] | None = None) -> Extension:
    try:
        manifest = Manifest.model_validate(data)
    except ValidationError as exc:
        # Report field names, never input values or local paths.
        fields = sorted({".".join(map(str, error["loc"])) or "manifest" for error in exc.errors()})
        kind = expected_kind if expected_kind in KIND_PROTOCOL else None
        return Extension(id=fallback_id, kind=kind, name=fallback_id, state="invalid",
                         reason="Invalid manifest: " + ", ".join(fields))
    extension = Extension(**manifest.model_dump(exclude={"manifest"}))
    if expected_kind and extension.kind != expected_kind:
        return extension.model_copy(update={"state": "invalid", "reason": f"Expected kind {expected_kind}"})
    protocol = KIND_PROTOCOL[manifest.kind]
    accepted = ACCEPTED_PROTOCOLS if accepted is None else accepted
    if not set(manifest.protocol[protocol]).intersection(accepted.get(protocol, [])):
        extension.state = "incompatible"
        extension.reason = f"No accepted {protocol} protocol (host accepts {accepted.get(protocol, [])})"
    return extension


def read_manifest(path: Path, *, expected_kind: str | None = None) -> Extension:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Extension(id=path.parent.name, kind=expected_kind, name=path.parent.name,
                         state="invalid", reason="Manifest is unreadable or invalid JSON")
    return parse_manifest(data, fallback_id=path.parent.name, expected_kind=expected_kind)


def discover_extensions(*roots: Path, kind: Literal["engine", "source", "feature"]) -> list[Extension]:
    found: dict[str, Extension] = {}
    for root in roots:
        if root.is_dir():
            for path in sorted(root.glob(f"*/{MANIFEST_NAME}")):
                extension = read_manifest(path, expected_kind=kind)
                if extension.id in found:
                    # Ambiguous identities must never be eligible for spawning.
                    found[extension.id] = extension.model_copy(update={"state": "invalid", "reason": "Duplicate extension id"})
                else:
                    found[extension.id] = extension
    return list(found.values())


def source_extensions(data_dir: Path, builtin_dir: Path | None = None) -> list[Extension]:
    """Acquisition registry hook; callers may spawn only observations in state on."""
    return discover_extensions(*([builtin_dir] if builtin_dir is not None else []),
                               data_dir / "sources", kind="source")


def builtin_engines() -> list[Extension]:
    return discover_extensions(BUILTIN_ENGINES, kind="engine")
