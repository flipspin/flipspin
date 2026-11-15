"""Private account attention summaries for signed-in owners.

Members and synthetic principals receive no owner attention details.
Catalog misses must not be reported as helper work.
See docs/security.md#account-routes.
"""
from typing import Literal

from pydantic import BaseModel

from app.domains.helpers.mac_worker import MIN_WORKER_VERSION


class AttentionVersion(BaseModel):
    latest: str
    current: str
    skipped: str | None
    show: bool


class AttentionProgress(BaseModel):
    done: int
    total: int


class AttentionHelper(BaseModel):
    id: str
    name: str
    state: Literal["working", "idle", "asleep", "closed", "offline", "outdated", "revoked"]
    version: str
    waiting: int
    lastSeenAt: float | None = None
    minimumVersion: str | None = None
    progress: AttentionProgress | None = None


class AttentionResponse(BaseModel):
    # Unset fields are excluded by the route for members and sentinels.
    version: AttentionVersion | None = None
    helper: AttentionHelper | None = None
    helpers: int = 0
    flag: Literal["version", "helper"] | None = None
    flagTone: Literal["info", "warn", "bad"] | None = None


def describe_attention(container):
    update = container.get_update_checker().describe()
    version = None
    if update["latest"]:
        version = dict(latest=update["latest"], current=update["current"], skipped=update["skipped"],
                       show=update["updateAvailable"] and update["latest"] != update["skipped"])

    queue = container.get_lyrics_service().agent_queue
    lyrics = queue.status()
    stems = container.get_stems_service().queue.snapshot()
    waiting = lyrics["queued"] + lyrics["leased"] + sum(row["status"] in {"queued", "running"} for row in stems["jobs"])
    # The queue's worker is selected for its oldest queued job's kind. If
    # only stems wait, select for stems instead (CPU/MLX ranking can differ).
    selected = lyrics["worker"] if lyrics["queued"] else queue.worker.snapshot("stems" if any(row["status"] == "queued" for row in stems["jobs"]) else "transcribe")
    helper = None if selected is None else {key: selected[key] for key in ("id", "name", "state", "version")}
    if helper is not None:
        helper["waiting"] = waiting
        helper["lastSeenAt"] = selected.get("lastSeenAt")
        helper["minimumVersion"] = MIN_WORKER_VERSION
        running = lyrics.get("running")
        helper["progress"] = None
        if running and any(row.get("leasedBy") == helper["id"] and row.get("progress_id") == running["progressId"] for row in lyrics.get("rows", [])):
            helper["progress"] = dict(done=running["done"], total=running["total"])
    flag, tone = ("version", "info") if version and version["show"] else (None, None)
    if helper and waiting and helper["state"] in {"asleep", "closed", "offline", "outdated"}:
        flag, tone = "helper", "bad" if helper["state"] == "offline" else "warn"
    return dict(version=version, helper=helper, helpers=len(queue.worker.helpers()), flag=flag, flagTone=tone)
