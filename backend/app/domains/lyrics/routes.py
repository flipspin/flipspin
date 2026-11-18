"""Declare fixed lyric paths before album/file paths to prevent route shadowing.

Clients distinguish absent lyrics (404), edited-sidecar conflicts (409),
and invalid content (422). Only explicit force may replace an edited sidecar.
"""
from __future__ import annotations

import logging
from typing import Literal
from urllib.parse import unquote

from fastapi import APIRouter, Depends, HTTPException, Response, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.config import ConfigManager
from app.dependencies import conditional, get_config, get_lyrics_service, get_container, DependencyContainer
from app.domains.lyrics.models import KINDS, LyricsCandidate, lyrics_words
from app.domains.lyrics.engine import EngineBusyError, EngineNotReadyError
from app.domains.lyrics.services import LyricsLockedError, LyricsNotFoundError, LyricsSearchUnavailable, LyricsService
from app.domains.helpers.mac_worker import MacWorker
from app.domains.helpers.legacy import lyrics_agent_router
from app.infra import env_sources
from app.domains.helpers.helper_ranking import WaitReason
from app.infra.identity import require_owner
from app.exceptions import ValidationError as PathSafetyError
from app.domains.user_library.scope import LibraryScope, get_library_scope

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/lyrics", tags=["lyrics"])


# ------------------------------------------------------------------ models


class TrackRef(BaseModel):
    album: str
    file: str


class SearchLyricsRequest(TrackRef):
    source: str | None = Field(None, description="Provider ID; omit to search all enabled sources")
    plainOnly: bool = Field(False, description="Return only plain lyrics to synchronize to the audio")


class RestoreLyricsMetadata(BaseModel):
    """Renderer-held metadata for undo; no history is retained on the server."""

    fetchedAt: float
    title: str | None = None
    artist: str | None = None
    lineConfidence: list[float] | None = None
    lowLines: list[int] | None = None
    result: dict | None = None


class SaveLyricsRequest(BaseModel):
    restore: RestoreLyricsMetadata | None = None
    kind: str = Field(..., description="synced | plain | instrumental")
    text: str = ""
    source: str = Field("manual", description="lrclib | genius | manual | file | stt:…")
    providerRef: str | None = None
    edited: bool = False
    force: bool = False
    expectedRevision: str | None = Field(None, description="Conditional save: last read revision; empty string means no lyric")


class LyricsConfigRequest(BaseModel):
    autoFetch: bool


class LyricsRecordResponse(BaseModel):
    revision: str | None = None
    offsetMs: int = 0
    relPath: str
    kind: str
    source: str
    providerRef: str | None = None
    fetchedAt: float
    edited: bool
    sidecar: str | None = None
    title: str | None = None
    artist: str | None = None
    #: Aligned lyrics only: a 0–1 score per LRC line (file order) and the lines
    #: below the review threshold. Null for anything else.
    lineConfidence: list[float] | None = None
    lowLines: list[int] | None = None
    result: dict | None = None
    text: str


class CandidateResponse(BaseModel):
    provider: str
    providerRef: str | None = None
    url: str | None = None
    title: str
    artist: str
    album: str
    durationSeconds: float | None = None
    durationDeltaSeconds: float | None = None
    overrunSeconds: float | None = None
    withinTolerance: bool
    kind: str
    instrumental: bool
    lineCount: int
    preview: list[str]
    text: str


class SearchResponse(BaseModel):
    query: dict
    providers: list[str]
    candidates: list[CandidateResponse]


class ScanResponse(BaseModel):
    started: bool
    jobId: str | None = None
    progressId: str | None = None
    total: int = 0


class LyricsConfigResponse(BaseModel):
    autoFetch: bool


class PendingTrackResponse(BaseModel):
    relPath: str
    title: str
    artist: str
    album: str
    triedAt: float
    reason: str


class PendingListResponse(BaseModel):
    pendingCount: int
    pending: list[PendingTrackResponse]


class TranscribeTrack(BaseModel):
    album: str
    file: str
    #: Plain lyrics to align instead of transcribing (a catalog's text-only hit).
    text: str | None = None


class TranscribeRequest(BaseModel):
    tracks: list[TranscribeTrack] = Field(default_factory=list)
    isolateVocals: bool = True


class TranscribePendingRequest(BaseModel):
    isolateVocals: bool = True


class EngineJobResponse(BaseModel):
    progressId: str
    total: int
    jobId: str | None = None
    skipped: int = 0


class ScanRequest(BaseModel):
    tracks: list[TrackRef] = Field(default_factory=list)


LyricState = Literal['synced', 'plain', 'instrumental', 'pending', 'queued', 'none']


class LyricsStatesResponse(BaseModel):
    states: dict[str, LyricState]
    counts: dict[LyricState, int]


def _rel(album: str, file: str) -> str:
    return f"{unquote(album)}/{unquote(file)}"


def _not_found(e: Exception) -> HTTPException:
    return HTTPException(status_code=404, detail=str(e))


def _require_library_owner(scope: LibraryScope = Depends(get_library_scope)):
    # Only real members change behavior; every sentinel keeps its historical access.
    if not scope.unrestricted:
        raise HTTPException(status_code=403, detail="Managing lyrics jobs requires an owner token.")


# ------------------------------------------------------------------ fixed


class MacWaitingResponse(BaseModel):
    count: int
    oldestAt: float | None = None


class LyricsEngineResponse(BaseModel):
    # Preserve the engine's older fields while documenting the additive record.
    model_config = {"extra": "allow"}
    worker: MacWorker | None = None
    helpers: list[MacWorker] = Field(default_factory=list)
    waitReason: WaitReason | None = None
    oldestAt: float | None = None
    waiting: MacWaitingResponse | None = None


class LyricsJobsResponse(BaseModel):
    model_config = {"extra": "allow"}
    engine: LyricsEngineResponse
    oldestPendingAt: float | None = None


@router.get("/jobs", response_model=LyricsJobsResponse)
def lyrics_jobs(
    service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
    container: DependencyContainer = Depends(get_container),
):
    """What the lyrics worker is doing, and which songs the catalogs lacked."""
    # A member's panel polls this too: it sees its own songs, never the household's passes.
    result = service.jobs(None if scope.unrestricted else scope.allows)
    nest = container.get_nest_helper().view()
    helpers = result['engine'].get('helpers', [])
    result['engine']['helpers'] = [nest if h.get('nest') else h for h in helpers]
    if not any(h.get('nest') for h in helpers):
        result['engine']['helpers'].append(nest)
    return result


@router.get("/pending", response_model=PendingListResponse)
def lyrics_pending(
    service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """Every song the catalogs lacked, newest first — `/jobs` names only a preview."""
    pending = [p for p in service.repository.pending() if scope.allows(p.rel_path)]
    return {"pendingCount": len(pending), "pending": [p.to_dict() for p in pending]}


@router.get('/states', response_model=LyricsStatesResponse)
@conditional(('lyrics', 'library', 'jobs'), account_scope=True)
def lyrics_states(request: Request, response: Response,
                  service: LyricsService = Depends(get_lyrics_service),
                  scope: LibraryScope = Depends(get_library_scope)):
    return service.states(scope.allows)[0]


@router.post("/scan", response_model=ScanResponse)
def lyrics_scan(body: ScanRequest | None = None,
                service: LyricsService = Depends(get_lyrics_service),
                scope: LibraryScope = Depends(get_library_scope)):
    """Ask the catalogs for every song without a lyric. One pass at a time."""
    tracks = [_rel(t.album, t.file) for t in body.tracks] if body and body.tracks else None
    for rel in tracks or []:
        if not scope.allows(rel):
            raise HTTPException(status_code=404, detail=f'Track not found: {rel}')
    try:
        summary = service.start_scan(tracks, allows=scope.allows)
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    except Exception as e:
        logger.exception("lyrics scan failed to start")
        raise HTTPException(status_code=500, detail=str(e)) from e
    if summary is None:
        raise HTTPException(status_code=409, detail={'reason': 'scan-running', 'jobId': service.scan_job_id})
    return ScanResponse(started=True, jobId=summary.progress_id, progressId=summary.progress_id, total=summary.total)


@router.post("/search", response_model=SearchResponse)
def lyrics_search(ref: SearchLyricsRequest, service: LyricsService = Depends(get_lyrics_service)):
    """Every enabled catalog's answer for one song, ranked; nothing is written."""
    try:
        query, candidates = service.search(_rel(ref.album, ref.file), source=ref.source, plain_only=ref.plainOnly)
    except LyricsSearchUnavailable as e:
        return JSONResponse(status_code=503, content={"detail": str(e), "retryAfter": e.retry_after},
                            headers={"Retry-After": str(e.retry_after)} if e.retry_after else {})
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    return SearchResponse(
        query=query.to_dict(),
        providers=service.provider_ids(),
        candidates=[CandidateResponse(**c.to_dict()) for c in candidates],
    )


@router.get("/config", response_model=LyricsConfigResponse)
def get_lyrics_config(config: ConfigManager = Depends(get_config)):
    return LyricsConfigResponse(autoFetch=bool(getattr(config, "lyrics_auto_fetch", False)))


@router.put("/config", response_model=LyricsConfigResponse, dependencies=[Depends(require_owner)])
@env_sources.settings_write
def put_lyrics_config(
    data: LyricsConfigRequest,
    config: ConfigManager = Depends(get_config),
    service: LyricsService = Depends(get_lyrics_service),
):
    """Persist the auto-fetch switch to <root>/.env and apply it live.

    Same mechanics as the analysis-tags switch. Turning it on also starts a
    pass right away — the person flipped it because they want lyrics now.
    """
    env_sources.persist(config.data_root / ".env", {
        "KROBI_LYRICS_AUTO_FETCH": "true" if data.autoFetch else "false",
    })
    config.lyrics_auto_fetch = bool(data.autoFetch)
    if data.autoFetch:
        try:
            service.start_scan()
        except Exception as e:  # the switch is saved either way
            logger.warning("auto-fetch enabled but the pass did not start: %s", e)
    return LyricsConfigResponse(autoFetch=config.lyrics_auto_fetch)


# --------------------------------------------------------------- engine
#
# The Mac worker. Still fixed paths, still before /{album}/{file}.


@router.get("/engine")
def lyrics_engine_status(service: LyricsService = Depends(get_lyrics_service)):
    """Is the engine installed, ready, installing, busy — and if not, why (a hint code)."""
    return service.engine_status()


class EngineInstallRequest(BaseModel):
    target: Literal["engine", "lyrics", "stems", "analysis", "gpu"] = "engine"


@router.post("/engine/remove", dependencies=[Depends(require_owner)])
def lyrics_engine_remove(body: EngineInstallRequest, service: LyricsService = Depends(get_lyrics_service)):
    try:
        service.engine.remove(body.target)
    except EngineNotReadyError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"ok": True}


@router.post("/engine/install", dependencies=[Depends(require_owner)])
def lyrics_engine_install(body: EngineInstallRequest = EngineInstallRequest(), service: LyricsService = Depends(get_lyrics_service)):
    """Install the shared runtime or one add-on's models in the background."""
    try:
        progress_id = service.engine.install(body.target)
    except EngineNotReadyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"progressId": progress_id}


class AlignLyricsRequest(SaveLyricsRequest, TrackRef):
    kind: str = "plain"


@router.post("/align", response_model=EngineJobResponse)
def align_lyrics(body: AlignLyricsRequest, service: LyricsService = Depends(get_lyrics_service),
                 scope: LibraryScope = Depends(get_library_scope)):
    rel = _rel(body.album, body.file)
    if not scope.allows(rel):
        raise HTTPException(status_code=404, detail=f"Track not found: {rel}")
    try:
        progress_id, total = service.align(rel, text=body.text, source=body.source,
                                          provider_ref=body.providerRef, edited=body.edited,
                                          force=body.force, expected_revision=body.expectedRevision)
    except LyricsLockedError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    except (EngineBusyError, EngineNotReadyError) as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return EngineJobResponse(progressId=progress_id, jobId=progress_id, total=total)


@router.post("/transcribe", response_model=EngineJobResponse)
def lyrics_transcribe(
    body: TranscribeRequest, service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    """Process songs on this Mac: align when a text is known, transcribe otherwise."""
    if not body.tracks:
        raise HTTPException(status_code=422, detail="tracks is empty")
    requests = [(_rel(t.album, t.file), t.text) for t in body.tracks]
    for rel, _ in requests:
        if not scope.allows(rel):
            raise HTTPException(status_code=404, detail=f"Track not found: {rel}")
    return _start_engine(service, requests, body.isolateVocals)


@router.post("/transcribe/pending", response_model=EngineJobResponse, dependencies=[Depends(_require_library_owner)])
def lyrics_transcribe_pending(
    body: TranscribePendingRequest, service: LyricsService = Depends(get_lyrics_service)
):
    """Every song the catalogs did not have, through the engine."""
    try:
        progress_id, total = service.transcribe_pending(isolate=body.isolateVocals)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except EngineBusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except EngineNotReadyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return EngineJobResponse(progressId=progress_id, total=total)


@router.post("/transcribe/{progress_id}/cancel", dependencies=[Depends(_require_library_owner)])
def lyrics_transcribe_cancel(progress_id: str, service: LyricsService = Depends(get_lyrics_service)):
    return {"cancelled": service.cancel_processing(progress_id)}


# ---------------------------------------------------------------- agent
#
# The dial-out protocol a Mac uses to process for this server: claim → work
# (heartbeat) → result. Only owner helper devices may process.
# Lease policy lives in infra/jobs/queue.py.


router.include_router(lyrics_agent_router)


def _start_engine(service: LyricsService, requests, isolate: bool) -> EngineJobResponse:
    unique = {}
    for rel, text in requests:
        unique.setdefault(rel, text)
    skipped = 0
    for rel, text in unique.items():
        record = service.repository.get_record(rel)
        if record and record.kind == 'synced' and record.edited:
            original = service.repository.read_sidecar(record)
            same_words = bool(original and text and lyrics_words(original) == lyrics_words(text))
            if not same_words:
                skipped += 1
    if skipped and skipped == len(unique):
        import uuid

        job_id = f'lyrics-{uuid.uuid4()}'
        items = [{'item': service.repository.get_record(rel).title or rel, 'rel_path': rel}
                 for rel in unique]
        tracker = service.progress_tracker
        tracker.create_progress(job_id, skipped, kind='lyrics-helper',
                                label=items[0]['item'] if skipped == 1 else f'{skipped} canciones', items=items)
        if tracker.ledger:
            for idx in range(skipped):
                tracker.ledger.item_transition(job_id, idx, 1, 'skipped', reason='rejected')
        tracker.complete_progress(job_id, 'done', succeeded=0, failed=0)
        return EngineJobResponse(progressId=job_id, jobId=job_id, total=0, skipped=skipped)
    try:
        progress_id, total = service.transcribe(requests, isolate=isolate)
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except EngineBusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except EngineNotReadyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return EngineJobResponse(progressId=progress_id, jobId=progress_id, total=total, skipped=skipped)


# --------------------------------------------------------------- per-track


class SetOffsetRequest(BaseModel):
    offsetMs: int = Field(..., strict=True, ge=-600000, le=600000)
    expectedRevision: str | None = None


@router.put("/{album}/{file}/offset", response_model=LyricsRecordResponse)
def put_lyrics_offset(
    album: str, file: str, body: SetOffsetRequest,
    service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    rel = _rel(album, file)
    if not scope.allows(rel):
        raise HTTPException(status_code=404, detail=f"Track not found: {rel}")
    try:
        document = service.set_offset(rel, body.offsetMs, expected_revision=body.expectedRevision)
    except LyricsLockedError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return LyricsRecordResponse(**document.to_dict())


@router.get("/{album}/{file}", response_model=LyricsRecordResponse)
def get_lyrics(
    album: str, file: str, request: Request, response: Response,
    service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    rel = _rel(album, file)
    if not scope.allows(rel):
        raise HTTPException(status_code=404, detail=f"Track not found: {rel}")
    try:
        document = service.get(rel)
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    body = document.to_dict() if document else None
    etag = f'"{body["revision"]}"' if body else '"none"'
    # GET uses weak comparison, including lists and the wildcard (RFC 9110).
    validators = request.headers.get("if-none-match", "").split(",")
    if any(value.strip().removeprefix("W/") in (etag, "*") for value in validators):
        return Response(status_code=304, headers={"ETag": etag})
    if body is None:
        raise HTTPException(status_code=404, detail=f"No lyrics for {rel}", headers={"ETag": etag})
    response.headers["ETag"] = etag
    return LyricsRecordResponse(**body)


@router.put("/{album}/{file}", response_model=LyricsRecordResponse)
def put_lyrics(
    album: str,
    file: str,
    body: SaveLyricsRequest,
    service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    if body.kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {', '.join(KINDS)}")
    rel = _rel(album, file)
    if not scope.allows(rel):
        raise HTTPException(status_code=404, detail=f"Track not found: {rel}")
    try:
        document = service.save(
            rel,
            kind=body.kind,
            text=body.text,
            source=body.source,
            provider_ref=body.providerRef,
            edited=body.edited,
            force=body.force,
            expected_revision=body.expectedRevision,
            preserve_timing=True,
            restore_metadata=body.restore.model_dump() if body.restore else None,
        )
    except LyricsLockedError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (LyricsNotFoundError, PathSafetyError) as e:
        raise _not_found(e)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return LyricsRecordResponse(**document.to_dict())


@router.delete("/{album}/{file}")
def delete_lyrics(
    album: str, file: str, expectedRevision: str | None = None, service: LyricsService = Depends(get_lyrics_service),
    scope: LibraryScope = Depends(get_library_scope),
):
    rel = _rel(album, file)
    if not scope.allows(rel):
        return {"success": True, "removed": False}
    try:
        removed = service.delete(rel, expected_revision=expectedRevision)
    except LyricsLockedError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except PathSafetyError as e:
        raise _not_found(e)
    return {"success": True, "removed": removed}


__all__ = ["router", "LyricsCandidate"]
