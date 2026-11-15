"""Legacy wire aliases. Keep until MIN_WORKER_VERSION exceeds 0.10.0,
which ships /api/helpers/*. Installed older helpers retain their exact shapes.
All routes share these handlers with the unified API; lease policy is unchanged.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from app.dependencies import get_lyrics_service, get_stems_service
from app.infra.identity import Principal, require_helper
from .mac_worker import AgentIdentity
from .protocol import STEMS, StemsManifestError

INCOMING = ".incoming"
lyrics_agent_router = APIRouter()
stems_agent_router = APIRouter()

#: Upload caps on ``/agent/result``. A manifest is tens of KB; a stem at 192 kb/s
#: is ~1.4 MB per minute, so 128 MB covers a 90-minute piece.
MAX_MANIFEST_BYTES = 4 << 20
MAX_STEM_BYTES = 128 << 20


class AgentClaimRequest(BaseModel):
    agent: AgentIdentity
    max: int = Field(1, ge=1, le=5)


class AgentHeartbeatRequest(BaseModel):
    agent: AgentIdentity | None = None
    lease: str = ""
    jobId: str = ""
    phase: str | None = None
    percent: float | None = None


class AgentResultRequest(BaseModel):
    lease: str
    jobId: str
    ok: bool
    lrc: str | None = None
    source: str | None = None
    error: str | None = None
    #: False = an accident worth retrying (crash, lost download); True = a verdict.
    final: bool = True
    #: From the aligner: a score per LRC line and the lines below the threshold.
    accel: Literal["mlx", "cuda", "cpu"] | None = None
    fallbackReason: Literal["oom", "driver"] | None = None
    gpu: str | None = None
    lineConfidence: list[float] | None = None
    lowLines: list[int] | None = None


@lyrics_agent_router.post("/agent/claim", responses={204: {"description": "No eligible work or helper already leased"}})
def lyrics_agent_claim(body: AgentClaimRequest, service=Depends(get_lyrics_service),
                       helper: Principal = Depends(require_helper)):
    result = service.agent_queue.claim(body.agent.model_dump() | {"id": helper.device_id}, max_jobs=body.max)
    return result if result["jobs"] or result.get("stop") else Response(status_code=204)


@lyrics_agent_router.post("/agent/heartbeat")
def lyrics_agent_heartbeat(body: AgentHeartbeatRequest, service=Depends(get_lyrics_service),
                           helper: Principal = Depends(require_helper)):
    if (body.lease or body.jobId) and not service.agent_queue.owns_lease(body.lease, body.jobId, helper.device_id):
        if body.agent and not service.agent_queue.worker.seen(body.agent.model_dump() | {"id": helper.device_id}, enroll=False):
            return {"stop": True, "reason": "replaced"}
        return {"stop": True, "reason": "lease-lost"}
    return service.agent_queue.heartbeat(body.lease, body.jobId, body.phase, body.percent,
                                         body.agent.model_dump() | {"id": helper.device_id} if body.agent else None)


class AgentByeRequest(BaseModel):
    id: str | None = None
    sessionId: str | None = None
    reason: Literal["quit", "sleep"] = "quit"


class AgentControlResponse(BaseModel):
    stop: bool
    reason: Literal["replaced", "lease-lost", "cancelled", "revoked", "too-old"] | None = None
    minimum: str | None = None


@lyrics_agent_router.post("/agent/bye", response_model=AgentControlResponse, response_model_exclude_none=True)
def lyrics_agent_bye(body: AgentByeRequest, service=Depends(get_lyrics_service),
                     helper: Principal = Depends(require_helper)):
    return service.agent_queue.worker.bye(helper.device_id, body.reason, body.sessionId)


@lyrics_agent_router.post("/agent/result")
def lyrics_agent_result(body: AgentResultRequest, service=Depends(get_lyrics_service),
                        helper: Principal = Depends(require_helper)):
    with service.agent_queue.worker.lock:
        receipt = service.agent_queue.result_response(body.lease, body.jobId, helper.device_id)
        if receipt:
            return receipt
        if not service.agent_queue.owns_lease(body.lease, body.jobId, helper.device_id):
            return {"accepted": False, "reason": "lease-lost"}
        return service.agent_queue.result(
            body.lease, body.jobId, ok=body.ok, lrc=body.lrc, source=body.source, error=body.error, final=body.final,
            extra={"lineConfidence": body.lineConfidence, "lowLines": body.lowLines,
                   **{key: value for key, value in body.model_dump().items()
                      if key in {"accel", "fallbackReason", "gpu"} and value is not None}},
        )


class StemsClaimRequest(BaseModel):
    agent: AgentIdentity | None = None


class StemsClaimResponse(BaseModel):
    id: str = Field(..., description="The lease id: what heartbeat and result present")
    jobId: str
    album: str
    file: str
    mediaPath: str
    model: str
    attempt: int


class StemsHeartbeatRequest(BaseModel):
    agent: AgentIdentity | None = None
    id: str
    phase: str | None = Field(None, description="worker phase key; Spanish keys are mapped to the wire's English ones")
    progress: float | None = Field(None, description="0–100")


class StemsHeartbeatResponse(AgentControlResponse):
    pass


class StemsResultResponse(BaseModel):
    accepted: bool
    reason: Literal["lease-lost"] | None = None
    status: str | None = None
    requeued: bool | None = None


@stems_agent_router.post(
    "/agent/claim",
    response_model=StemsClaimResponse | AgentControlResponse,
    response_model_exclude_none=True,
    responses={204: {"description": "Nothing queued"}},
)
def stems_agent_claim(body: StemsClaimRequest | None = None, service=Depends(get_stems_service),
                      helper: Principal = Depends(require_helper)):
    agent = body.agent.model_dump() if body and body.agent else {"name": helper.label}
    job = service.claim(agent | {"id": helper.device_id})
    if job is None:
        return Response(status_code=204)
    return job


@stems_agent_router.post("/agent/heartbeat", response_model=StemsHeartbeatResponse, response_model_exclude_none=True)
def stems_agent_heartbeat(body: StemsHeartbeatRequest, service=Depends(get_stems_service),
                          helper: Principal = Depends(require_helper)):
    agent = body.agent.model_dump() | {"id": helper.device_id} if body.agent else None
    if not service.queue.owns_lease(body.id, helper.device_id):
        if agent and not service.queue.worker.seen(agent, enroll=False):
            return {"stop": True, "reason": "replaced"}
        return {"stop": True, "reason": "lease-lost"}
    return service.heartbeat(body.id, body.phase, body.progress, agent)


@stems_agent_router.post("/agent/result", response_model=StemsResultResponse)
def stems_agent_result(
    id: str = Form(..., description="The lease id from claim"),
    ok: bool = Form(True),
    error: str | None = Form(None),
    final: bool = Form(False, description="A failure that is a verdict about the song, not an accident"),
    song_json: UploadFile | None = File(None, alias="song.json"),
    drums: UploadFile | None = File(None),
    bass: UploadFile | None = File(None),
    vocals: UploadFile | None = File(None),
    other: UploadFile | None = File(None),
    service=Depends(get_stems_service),
    helper: Principal = Depends(require_helper),
):
    """Multipart: ``id``, ``song.json`` and the four stems (``drums``/``bass``/``vocals``/``other``,
    Opus in Ogg) — or ``id``, ``ok=false``, ``error``, ``final`` for a failure."""
    with service.queue.worker.lock:
        receipt = service.queue.result_response(id, helper.device_id)
        if receipt:
            return receipt
        if not service.queue.owns_lease(id, helper.device_id):
            return {"accepted": False, "reason": "lease-lost"}
        if not ok:
            return service.fail(id, error or "", final=final)
        if service.queue.leased(id) is None:
            return {"accepted": False, "reason": "lease-lost"}
    uploads = {"drums": drums, "bass": bass, "vocals": vocals, "other": other}
    missing = [name for name, up in uploads.items() if up is None]
    if song_json is None or missing:
        raise HTTPException(status_code=422, detail=f"missing parts: {', '.join((['song.json'] if song_json is None else []) + missing)}")
    # Staged on the stems volume itself, so publishing is a rename, not a copy.
    incoming = service.repository.root / INCOMING
    incoming.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="upload-", dir=str(incoming)))
    try:
        raw_manifest = song_json.file.read(MAX_MANIFEST_BYTES + 1)
        if len(raw_manifest) > MAX_MANIFEST_BYTES:
            raise HTTPException(status_code=413, detail=f"song.json exceeds {MAX_MANIFEST_BYTES >> 20} MB")
        try:
            manifest = json.loads(raw_manifest.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise HTTPException(status_code=422, detail=f"song.json is not JSON: {e}")
        files: dict[str, Path] = {}
        for name in STEMS:
            target = staging / f"{name}.ogg"
            written = _copy_capped(uploads[name].file, target, MAX_STEM_BYTES)  # type: ignore[union-attr]
            if written is None:
                raise HTTPException(status_code=413, detail=f"{name} exceeds {MAX_STEM_BYTES >> 20} MB")
            if written == 0:
                raise HTTPException(status_code=422, detail=f"{name} is empty")
            files[name] = target
        try:
            return service.publish(id, manifest, files)
        except StemsManifestError as e:
            raise HTTPException(status_code=422, detail=str(e))
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _copy_capped(source, target: Path, limit: int) -> int | None:
    """Copy in 1 MB chunks, counting; ``None`` once ``limit`` is exceeded (the
    partial file is left for the caller's cleanup)."""
    written = 0
    with open(target, "wb") as out:
        while True:
            chunk = source.read(1 << 20)
            if not chunk:
                return written
            written += len(chunk)
            if written > limit:
                return None
            out.write(chunk)


