"""Stems: what a split song is, and what a job to split one is.

A track is the library-relative pair ``album`` (directory) + ``file`` — the
same identity ``/api/media/{album}/{file}`` uses. Nothing here is an ORM row;
the manifest (``song.json``) on disk is the truth for a finished split, and a
:class:`StemJob` lives only while a split is wanted and not yet on disk (or
failed, so the client can see why).
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from app.domains.helpers.helper_ranking import default_needs

from app.domains.helpers.protocol import STEMS as STEMS, MANIFEST_NAME as MANIFEST_NAME, STEM_SUFFIX as STEM_SUFFIX
#: Accept only the supported separation model at the request boundary.
MODELS: tuple[str, ...] = ("htdemucs",)
DEFAULT_MODEL = "htdemucs"
MANIFEST_VERSION = 1
StemPriority = Literal["now", "background"]

# Internal row states. ``queued``/``leased`` are live; ``failed`` stays until
# the person asks again or deletes. A finished row is removed — song.json is
# the record.
STATUS_QUEUED = "queued"
STATUS_LEASED = "leased"
STATUS_FAILED = "failed"
STATUS_DONE = "done"

# Wire phases (contract additions), in order: queued · claimed · decoding ·
# separating · beats · chops · encoding · uploading, then ready / failed.
# The worker speaks the lyrics engine's Spanish keys on its JSON lines; the
# server maps them so every client sees one vocabulary. Unknown keys pass through.
PHASE_QUEUED = "queued"
PHASE_CLAIMED = "claimed"
PHASE_FAILED = "failed"
WORKER_PHASES = {
    "decodificando": "decoding",
    "separando": "separating",
    "ritmo": "beats",
    "cortando": "chops",
    "codificando": "encoding",
    "subiendo": "uploading",
}


def wire_phase(phase: str | None) -> str | None:
    if not phase:
        return phase
    return WORKER_PHASES.get(phase, phase)


# Wire states (the contract): queued | running | ready | failed.
WIRE_QUEUED = "queued"
WIRE_RUNNING = "running"
WIRE_READY = "ready"
WIRE_FAILED = "failed"


def iso(ts: float | None) -> str | None:
    """Epoch seconds → ``2026-10-09T12:00:00Z`` (the manifest's own format)."""
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class StemJob:
    id: str
    album: str
    file: str
    job_id: str | None = None
    job_attempt: int = 1
    model: str = DEFAULT_MODEL
    priority: StemPriority = "now"
    requested_by: str | None = None
    status: str = STATUS_QUEUED
    phase: str | None = PHASE_QUEUED
    #: 0–100, or None when the phase has no measurable fraction.
    progress: float | None = None
    error: str | None = None
    #: The current lease id. It is what the agent knows the job by (``id`` in
    #: the claim answer), so a requeued job can never be finished by the
    #: agent that lost it.
    lease: str | None = None
    leased_by: str | None = None
    leased_at: float = 0.0
    last_heartbeat: float = 0.0
    attempts: int = 0
    requested_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    kind: str = "stems"
    needs: list[str] = field(default_factory=lambda: default_needs("stems"))
    offered_at: float | None = None
    result: dict[str, Any] | None = None
    provenance: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        self.job_id = self.job_id or self.id
        if self.offered_at is None:
            self.offered_at = self.requested_at

    @property
    def key(self) -> tuple[str, str]:
        return (self.album, self.file)

    @property
    def wire_status(self) -> str:
        return {
            STATUS_QUEUED: WIRE_QUEUED,
            STATUS_LEASED: WIRE_RUNNING,
            STATUS_FAILED: WIRE_FAILED,
            STATUS_DONE: WIRE_READY,
        }.get(self.status, WIRE_QUEUED)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["requestedBy"] = data.pop("requested_by")
        return {**data, "jobId": self.job_id, "offeredAt": self.offered_at, "leasedBy": self.leased_by}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StemJob:
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data}  # type: ignore[attr-defined]
        if "offeredAt" in data:
            known["offered_at"] = data["offeredAt"]
        if "leasedBy" in data:
            known["leased_by"] = data["leasedBy"]
        if "requestedBy" in data:
            known["requested_by"] = data["requestedBy"]
        return cls(**known)

    def snapshot(self) -> dict[str, Any]:
        """The ``GET /api/stems/jobs`` row."""
        return {
            "kind": self.kind, "needs": self.needs, "offeredAt": self.offered_at,
            "leasedBy": self.leased_by, "result": self.result,
            "album": self.album,
            "file": self.file,
            "status": self.wire_status,
            "phase": self.phase,
            "progress": self.progress,
            "error": self.error,
            "requestedAt": iso(self.requested_at),
            "updatedAt": iso(self.updated_at),
        }

    def pending_body(self) -> dict[str, Any]:
        """The ``202`` body of ``GET /api/stems/{album}/{file}``."""
        return {"status": self.wire_status, "phase": self.phase, "progress": self.progress, "error": self.error}
