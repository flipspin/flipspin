"""One dial-out API for every helper job kind; feature adapters own the results."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app.dependencies import get_analysis_service, get_lyrics_service, get_stems_service
from app.infra.identity import Principal, require_helper
from app.infra.uploads import bounded_form
from . import legacy
from .mac_worker import AgentIdentity, EngineInventory
from .protocol import STEMS

router = APIRouter(prefix="/api/helpers", tags=["helpers"])
Kind = Literal["align", "transcribe", "stems", "analysis"]


class HelperCapabilities(BaseModel):
    os: Literal["macos", "windows", "linux"] = "macos"
    accel: Literal["mlx", "cuda", "cpu"] = "mlx"
    gpu: str | None = None
    chip: str | None = None
    memoryBytes: int | None = Field(None, ge=0)
    platform: str = ""
    macos: str | None = None
    labels: list[str] = Field(default_factory=list)
    utcOffsetMinutes: int | None = Field(None, ge=-840, le=840)
    engines: dict[str, EngineInventory] | None = None
    onBattery: bool | None = None
    powerReadable: bool = False
    pausedReason: Literal["battery", "hours", "paused", "off", "thermal"] | None = None
    keepAwake: Literal["held", "failed", "none"] = "none"


class HelperClaimRequest(BaseModel):
    kinds: list[Kind]
    capabilities: HelperCapabilities = Field(default_factory=HelperCapabilities)
    workerId: str | None = None
    sessionId: str | None = None
    name: str = "Helper"
    version: str = ""

    def agent(self, helper):
        # workerId is informational; only the credential determines the holder.
        return AgentIdentity(**self.capabilities.model_dump(), id=helper.device_id,
                             name=self.name, version=self.version, sessionId=self.sessionId, jobs=self.kinds)


class HelperJob(BaseModel):
    id: str
    kind: Kind
    input: dict


class HelperClaimResponse(BaseModel):
    job: HelperJob
    lease: str


class HelperHeartbeatRequest(BaseModel):
    lease: str
    phase: str | None = None
    progress: float | None = None
    agent: AgentIdentity | None = None


class HelperResultRequest(BaseModel):
    lease: str
    ok: bool = True
    items: list[dict] | None = Field(None, max_length=25)
    error: str | None = None
    final: bool = True
    lrc: str | None = None
    source: str | None = None
    accel: Literal["mlx", "cuda", "cpu"] | None = None
    fallbackReason: Literal["oom", "driver"] | None = None
    gpu: str | None = None
    lineConfidence: list[float] | None = None
    lowLines: list[int] | None = None


class HelperResultResponse(BaseModel):
    accepted: bool
    stop: bool | None = None
    items: list[dict] | None = None
    reason: Literal["lease-lost"] | None = None
    status: str | None = None
    requeued: bool | None = None


@router.post("/claim", response_model=HelperClaimResponse | legacy.AgentControlResponse,
             response_model_exclude_none=True, responses={204: {"description": "No eligible work"}})
def claim(body: HelperClaimRequest, helper: Principal = Depends(require_helper),
          lyrics=Depends(get_lyrics_service), stems=Depends(get_stems_service), analysis=Depends(get_analysis_service)):
    agent = body.agent(helper)
    # One registry lock spans both adapters; priority and lease exclusivity remain server-side.
    with lyrics.agent_queue.worker.lock:
        adapters = [
            (lyrics.agent_queue.queue.kinds['transcribe'].order, 'lyrics'),
            (stems.queue.queue.kinds['stems'].order, 'stems'),
            (analysis.queue.kinds['analysis'].order, 'analysis'),
        ]
        for _, adapter in sorted(adapters):
            if adapter == 'lyrics':
                got = lyrics.agent_queue.claim(agent.model_dump(), max_jobs=1)
                if got.get('stop'):
                    return {k: got[k] for k in ('stop', 'reason', 'minimum') if k in got}
                if got['jobs']:
                    job = got['jobs'][0]
                    return {'job': {'id': job['id'], 'kind': job['kind'], 'input': job}, 'lease': got['lease']}
            elif adapter == 'stems' and 'stems' in body.kinds:
                job = stems.claim(agent.model_dump())
                if job and job.get('stop'):
                    return job
                if job:
                    return {'job': {'id': job['jobId'], 'kind': 'stems', 'input': job}, 'lease': job['id']}
            elif adapter == 'analysis' and 'analysis' in body.kinds:
                if got := analysis.claim(agent.model_dump()):
                    return got
    return Response(status_code=204)


@router.post("/jobs/{id}/heartbeat", response_model=legacy.AgentControlResponse,
             response_model_exclude_none=True)
def heartbeat(id: str, body: HelperHeartbeatRequest, helper: Principal = Depends(require_helper),
              lyrics=Depends(get_lyrics_service), stems=Depends(get_stems_service), analysis=Depends(get_analysis_service)):
    if body.agent:
        agent = body.agent.model_dump()
        agent['id'] = helper.device_id
        lyrics.agent_queue.worker.seen(agent, enroll=False)
    if lyrics.agent_queue.worker.compute:
        lyrics.agent_queue.worker.compute.defer_blocked()
    row = lyrics.agent_queue.queue.get(id)
    if row and row['kind'] == 'analysis':
        return analysis.heartbeat(id, body.lease, helper.device_id, body.phase, body.progress)
    if row and row["kind"] == "stems":
        return legacy.stems_agent_heartbeat(
            legacy.StemsHeartbeatRequest(id=body.lease, phase=body.phase, progress=body.progress, agent=body.agent),
            stems, helper)
    return legacy.lyrics_agent_heartbeat(
        legacy.AgentHeartbeatRequest(lease=body.lease, jobId=id, phase=body.phase,
                                     percent=body.progress, agent=body.agent), lyrics, helper)


# Both content types are intentional. Parsing multipart through Request avoids
# FastAPI treating the lyrics JSON body as a form, while retaining capped copies.
_RESULT_CONTENT = {
    "application/json": {"schema": HelperResultRequest.model_json_schema()},
    "multipart/form-data": {"schema": {"type": "object", "required": ["lease"], "properties": {
        "lease": {"type": "string"}, "ok": {"type": "boolean", "default": True},
        "error": {"type": "string"}, "final": {"type": "boolean", "default": False},
        **{name: {"type": "string", "format": "binary"} for name in ("song.json", *STEMS)},
    }}},
}


@router.post("/jobs/{id}/result", response_model=HelperResultResponse, response_model_exclude_none=True,
             openapi_extra={"requestBody": {"required": True, "content": _RESULT_CONTENT}},
             responses={413: {"description": "song.json exceeds 4 MB or a stem exceeds 128 MB"},
                        422: {"description": "Invalid result or missing parts"}})
async def result(id: str, request: Request, helper: Principal = Depends(require_helper),
                 lyrics=Depends(get_lyrics_service), stems=Depends(get_stems_service), analysis=Depends(get_analysis_service)):
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    try:
        if content_type == "application/json":
            body = HelperResultRequest.model_validate(await request.json())
            row = lyrics.agent_queue.queue.get(id)
            if body.items is not None or row and row['kind'] == 'analysis':
                if body.items is None:
                    raise HTTPException(422, 'Analysis result requires items')
                return await run_in_threadpool(analysis.result, id, body.lease, body.items, helper.device_id)
            return await run_in_threadpool(legacy.lyrics_agent_result,
                legacy.AgentResultRequest(**body.model_dump(exclude={'items'}), jobId=id), lyrics, helper)
        if content_type != "multipart/form-data":
            raise HTTPException(status_code=415, detail="Use application/json or multipart/form-data")
        async with bounded_form(request, legacy.result_upload_limit(), max_files=5, max_fields=4) as form:
            # Stem failures historically default to retryable, unlike lyric verdicts.
            body = HelperResultRequest.model_validate({"lease": form.get("lease"),
                "ok": form.get("ok", True), "error": form.get("error"), "final": form.get("final", False)})
            for name in ("song.json", *STEMS):
                if form.get(name) is not None and not isinstance(form[name], UploadFile):
                    raise HTTPException(status_code=422, detail=f"{name} must be a file")

            def publish():
                with stems.queue.worker.lock:
                    receipt = stems.queue.result_response(body.lease, helper.device_id, id)
                    if receipt:
                        return receipt
                    row = stems.queue.queue.get(id)
                    if not row or row["kind"] != "stems" or row["lease"] != body.lease:
                        return {"accepted": False, "reason": "lease-lost"}
                return legacy.stems_agent_result(body.lease, body.ok, body.error, body.final,
                    form.get("song.json"), *(form.get(name) for name in STEMS), stems, helper)
            return await run_in_threadpool(publish)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Invalid JSON result") from error


@router.post("/bye", response_model=legacy.AgentControlResponse, response_model_exclude_none=True)
def bye(body: legacy.AgentByeRequest, helper: Principal = Depends(require_helper), lyrics=Depends(get_lyrics_service)):
    return legacy.lyrics_agent_bye(body, lyrics, helper)
